import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, X, FileAudio, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  uploadAudioFile,
  validateAudioFile,
  type UploadProgress,
} from '@/services/storage';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/useAuth';

interface CallUploadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadComplete?: () => void;
}

/** Renders the CallUpload component. */
export function CallUpload({ open, onOpenChange, onUploadComplete }: CallUploadProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleDrag = useCallback(/** Handles the callback for this operation. */(e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(/** Handles the callback for this operation. */(e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, []);

  const handleFile = /** Handles the handleFile interaction. */ (selectedFile: File) => {
    const validation = validateAudioFile(selectedFile);
    if (!validation.valid) {
      toast.error(validation.error);
      return;
    }
    setFile(selectedFile);
  };

  const handleFileInput = /** Handles the handleFileInput interaction. */ (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  const handleUpload = /** Handles the handleUpload interaction. */ async () => {
    if (!file) return;

    setUploading(true);
    setProgress(null);

    try {
      // Upload to Firebase Storage
      // Backend trigger (onAudioUpload) will create Firestore document
      // and onCallCreated trigger will start transcription automatically
      await uploadAudioFile({
        file,
        onProgress: /** Handles the onProgress interaction. */ (p) => {
          setProgress(p);
        },
        userId: user!.uid,
      });

      toast.success(t('upload.success'));
      onOpenChange(false);
      onUploadComplete?.();

      // Reset state
      setFile(null);
      setProgress(null);
    } catch (error) {
      console.error('Upload failed:', error);
      toast.error(t('upload.error'));
    } finally {
      setUploading(false);
    }
  };

  const handleClose = /** Handles the handleClose interaction. */ () => {
    if (!uploading) {
      setFile(null);
      setProgress(null);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('upload.title')}</DialogTitle>
          <DialogDescription>{t('upload.description')}</DialogDescription>
          <p className="text-xs text-muted-foreground">
            {t('upload.quickUploadNote')}{' '}
            <a href="/upload" className="underline hover:text-foreground">{t('upload.uploadPageLink')}</a>.
          </p>
        </DialogHeader>

        <div className="space-y-4">
          {/* Dropzone */}
          <div
            className={cn(
              'border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer',
              dragActive
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/25 hover:border-primary/50',
              file && 'border-green-500 bg-green-50 dark:border-green-400 dark:bg-green-950'
            )}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={/** Handles the onClick interaction. */ () => document.getElementById('file-input')?.click()}
          >
            <input
              id="file-input"
              type="file"
              accept="audio/wav,audio/mpeg,audio/mp3,.wav,.mp3"
              className="hidden"
              onChange={handleFileInput}
              disabled={uploading}
            />

            {file ? (
              <div className="flex flex-col items-center">
                <FileAudio className="h-12 w-12 text-green-600 dark:text-green-400 mb-2" />
                <p className="font-medium">{file.name}</p>
                <p className="text-sm text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
                {!uploading && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={/** Handles the onClick interaction. */ (e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                  >
                    <X className="h-4 w-4 mr-1" />
                    {t('upload.removeFile')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <Upload className="h-12 w-12 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {t('upload.dropzone')}
                </p>
              </div>
            )}
          </div>
          {/* Progress Bar */}
          {progress && (
            <div className="space-y-2">
              <Progress value={progress.progress} />
              <p className="text-sm text-muted-foreground text-center">
                {Math.round(progress.progress)}%
              </p>
            </div>
          )}

          {/* Upload Button */}
          <Button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="w-full"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('upload.uploading')}
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                {t('upload.uploadButton')}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
