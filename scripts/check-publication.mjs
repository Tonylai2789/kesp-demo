import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function words(value) {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .normalize('NFC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function checkPublication(root, manifest) {
  if (manifest.version !== 1 || !Number.isInteger(manifest.windowWords) || manifest.windowWords < 8 ||
      !Array.isArray(manifest.fileHashes) || !Array.isArray(manifest.textHashes) ||
      !manifest.fileHashes.length || !manifest.textHashes.length ||
      [...manifest.fileHashes, ...manifest.textHashes].some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid private fingerprint manifest');
  }
  const fileHashes = new Set(manifest.fileHashes);
  const textHashes = new Set(manifest.textHashes);
  const findings = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      if (entry.isSymbolicLink()) {
        findings.push({ path: relative, reason: 'Unreviewed symbolic link' });
      } else if (entry.isDirectory()) {
        visit(filename);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(filename);
        if (/^promptsubagent.*\.md$/i.test(entry.name)) {
          findings.push({ path: relative, reason: 'Private prompt asset filename' });
        } else if (fileHashes.has(digest(bytes))) {
          findings.push({ path: relative, reason: 'Exact private file fingerprint' });
        } else {
          const tokens = words(bytes.toString('utf8'));
          for (let i = 0; i + manifest.windowWords <= tokens.length; i++) {
            if (textHashes.has(digest(tokens.slice(i, i + manifest.windowWords).join(' ')))) {
              findings.push({ path: relative, reason: 'Private content fingerprint', tokenOffset: i });
              break;
            }
          }
        }
      }
    }
  }
  visit(root);
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fs.realpathSync(process.argv[2] ?? path.join(import.meta.dirname, '..'));
    if (!process.argv[3]) throw new Error('Supply an external private fingerprint manifest; no publication approval without it.');
    const manifestPath = fs.realpathSync(process.argv[3]);
    const relative = path.relative(root, manifestPath);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Keep the private fingerprint manifest outside the publication tree.');
    }
    const findings = checkPublication(root, JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    for (const finding of findings) console.error(JSON.stringify(finding));
    if (findings.length) process.exitCode = 1;
    else console.log('Publication fingerprint check passed. This is not a general secrets or history audit.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
