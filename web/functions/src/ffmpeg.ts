/**
 * FFmpeg utilities for audio chunking.
 * Uses child_process.spawn with bundled ffmpeg-static binaries for production.
 *
 * Cloud Run Migration:
 * Set FFMPEG_PATH and FFPROBE_PATH environment variables to use system binaries
 * instead of bundled ones, then remove ffmpeg-static/ffprobe-static dependencies.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';

// Import bundled binary paths
// These packages include pre-compiled binaries for Linux x64 (Firebase runtime)
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// Configurable paths - allows override for Cloud Run or local development
// Priority: Environment variable > Bundled static > System PATH fallback
const FFMPEG_PATH: string = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
const FFPROBE_PATH: string = process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe';

// Log which binaries are being used (helpful for debugging deployment issues)
console.log(`FFmpeg binary: ${FFMPEG_PATH}`);
console.log(`FFprobe binary: ${FFPROBE_PATH}`);

// Constants for audio chunking
export const BITRATE_KBPS = 64;
export const SEGMENT_TIME_SEC = 300; // 5 minutes - smaller chunks transcribe faster
export const OVERLAP_SEC = 10; // Reduced overlap for smaller chunks
export const CHUNK_THRESHOLD_SEC = 600; // 10 minutes - files longer than this get chunked
export const MAX_CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run FFmpeg with the given arguments.
 * Uses spawn for streaming output and proper error handling.
 * @param args FFmpeg arguments (do NOT include 'ffmpeg' itself)
 * @param timeoutMs Timeout in milliseconds (default: 5 minutes)
 */
export async function runFFmpeg(
  args: string[],
  timeoutMs: number = 300000
): Promise<CommandResult> {
  return new Promise(/** Handles the callback for this operation. */(resolve, reject) => {
    const proc: ChildProcess = spawn(FFMPEG_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // CRITICAL: prevents shell injection
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', /** Handles the callback for this operation. */(chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', /** Handles the callback for this operation. */(chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(/** Handles the callback for this operation. */() => {
      proc.kill('SIGKILL');
      reject(new Error(`FFmpeg timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', /** Handles the callback for this operation. */(err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('close', /** Handles the callback for this operation. */(code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Run FFprobe with the given arguments.
 * @param args FFprobe arguments (do NOT include 'ffprobe' itself)
 * @param timeoutMs Timeout in milliseconds (default: 30 seconds)
 */
export async function runFFprobe(
  args: string[],
  timeoutMs: number = 30000
): Promise<CommandResult> {
  return new Promise(/** Handles the callback for this operation. */(resolve, reject) => {
    const proc: ChildProcess = spawn(FFPROBE_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', /** Handles the callback for this operation. */(chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', /** Handles the callback for this operation. */(chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(/** Handles the callback for this operation. */() => {
      proc.kill('SIGKILL');
      reject(new Error(`FFprobe timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', /** Handles the callback for this operation. */(err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('close', /** Handles the callback for this operation. */(code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Get the duration of an audio file in seconds.
 * @param inputPath Path to the audio file
 */
export async function getAudioDuration(inputPath: string): Promise<number> {
  const result = await runFFprobe(
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath],
    30000
  );

  if (result.exitCode !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr.slice(-500)}`);
  }

  const duration = parseFloat(result.stdout.trim());
  if (isNaN(duration)) {
    throw new Error(`Invalid duration from ffprobe: ${result.stdout}`);
  }

  return duration;
}

/**
 * Normalize audio to a consistent format for predictable chunk sizes.
 * Converts to: mono, 16kHz, AAC @ 64kbps
 * @param inputPath Input audio file
 * @param outputPath Output normalized file (should be .m4a)
 */
export async function normalizeAudio(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const args = [
    '-y', // Overwrite output
    '-i', inputPath,
    '-vn', // No video
    '-ac', '1', // Mono
    '-ar', '16000', // 16kHz sample rate
    '-c:a', 'aac', // AAC codec
    '-b:a', `${BITRATE_KBPS}k`, // Bitrate
    outputPath,
  ];

  console.log(`Normalizing audio: ${inputPath} -> ${outputPath}`);
  const result = await runFFmpeg(args, 180000); // 3 minute timeout

  if (result.exitCode !== 0) {
    throw new Error(`Normalize failed: ${result.stderr.slice(-500)}`);
  }

  // Verify output exists
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Normalized file not created: ${outputPath}`);
  }

  console.log(`Normalization complete: ${outputPath}`);
}

/**
 * Segment an audio file into chunks of a specified duration.
 * @param inputPath Normalized input audio file
 * @param outputDir Directory to write chunks to
 * @param segmentTimeSec Duration of each segment in seconds (default: 15 min)
 * @returns Array of paths to the generated chunk files
 */
export async function segmentAudio(
  inputPath: string,
  outputDir: string,
  segmentTimeSec: number = SEGMENT_TIME_SEC
): Promise<string[]> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPattern = path.join(outputDir, 'chunk_%03d.m4a');

  const args = [
    '-y',
    '-i', inputPath,
    '-f', 'segment',
    '-segment_time', segmentTimeSec.toString(),
    '-reset_timestamps', '1', // Each chunk starts at 0:00
    '-c', 'copy', // No re-encoding (already normalized)
    outputPattern,
  ];

  console.log(`Segmenting audio: ${inputPath} into ${segmentTimeSec}s chunks`);
  const result = await runFFmpeg(args, 60000); // 1 minute timeout

  if (result.exitCode !== 0) {
    throw new Error(`Segment failed: ${result.stderr.slice(-500)}`);
  }

  // Find generated chunk files
  const files = fs
    .readdirSync(outputDir)
    .filter(/** Handles the callback for this operation. */(f) => f.startsWith('chunk_') && f.endsWith('.m4a'))
    .sort()
    .map(/** Handles the callback for this operation. */(f) => path.join(outputDir, f));

  if (files.length === 0) {
    throw new Error('No chunk files generated');
  }

  console.log(`Segmentation complete: ${files.length} chunks created`);
  return files;
}

/**
 * Download a file from Cloud Storage to a local path.
 * @param bucket Firebase Storage bucket
 * @param storagePath Path in Cloud Storage
 * @param localPath Local file path to write to
 */
export async function downloadToTmp(
  bucket: admin.storage.Storage['bucket'] extends (name?: string) => infer R ? R : never,
  storagePath: string,
  localPath: string
): Promise<void> {
  // Ensure parent directory exists
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const file = bucket.file(storagePath);
  await file.download({ destination: localPath });

  console.log(`Downloaded ${storagePath} to ${localPath}`);
}

/**
 * Clean up a temporary directory and all its contents.
 * @param tmpDir Directory to remove
 */
export function cleanupTmpDir(tmpDir: string): void {
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log(`Cleaned up temp directory: ${tmpDir}`);
    }
  } catch (error) {
    // Log but don't throw - cleanup failure shouldn't fail the main operation
    console.error(`Failed to cleanup ${tmpDir}:`, error);
  }
}

/**
 * Verify that all chunk files are under the size limit.
 * @param chunkPaths Array of chunk file paths
 * @param maxSizeBytes Maximum allowed size in bytes (default: 8MB)
 * @returns true if all chunks are valid, throws if any exceed limit
 */
export function verifyChunkSizes(
  chunkPaths: string[],
  maxSizeBytes: number = MAX_CHUNK_SIZE_BYTES
): boolean {
  for (const chunkPath of chunkPaths) {
    const stats = fs.statSync(chunkPath);
    if (stats.size > maxSizeBytes) {
      throw new Error(
        `Chunk ${path.basename(chunkPath)} exceeds size limit: ${stats.size} bytes > ${maxSizeBytes} bytes`
      );
    }
    console.log(`Chunk ${path.basename(chunkPath)}: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }
  return true;
}
