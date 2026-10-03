import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Upload, FileAudio, X, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  uploadAudioFile,
  validateAudioFile,
  type UploadProgress,
} from '@/services/storage';
import { getAvailablePrompts, type AvailablePromptsResponse } from '@/services/functions';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/useAuth';

/** Renders the UploadPage component. */
export function UploadPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ [key: string]: UploadProgress }>({});
  const [dragActive, setDragActive] = useState(false);
  const [agentRoutingMode, setAgentRoutingMode] = useState<'none' | 'general'>('none');

  // Prompt version state
  const [showPromptVersions, setShowPromptVersions] = useState(false);
  const [promptVersions, setPromptVersions] = useState<Record<string, string>>({});
  const [analyzerModel, setAnalyzerModel] = useState('');
  const [availablePrompts, setAvailablePrompts] = useState<AvailablePromptsResponse | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);

  // Fetch available prompt versions on mount
  useEffect(/** Handles the callback for this operation. */() => {
    let cancelled = false;

    /** Documents the fetchPrompts behavior. */
    async function fetchPrompts() {
      setPromptsLoading(true);
      try {
        const data = await getAvailablePrompts();
        if (!cancelled) {
          setAvailablePrompts(data);
          setPromptVersions(data.defaults);
          setAnalyzerModel(data.analyzerModels?.default ?? '');
        }
      } catch (error) {
        console.error('Failed to fetch available prompts:', error);
        if (!cancelled) {
          setAvailablePrompts(null);
        }
      } finally {
        if (!cancelled) {
          setPromptsLoading(false);
        }
      }
    }

    fetchPrompts();
    return /** Handles the callback for this operation. */ () => { cancelled = true; };
  }, []);

  const handleDrag = /** Handles the handleDrag interaction. */ (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = /** Handles the handleDrop interaction. */ (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    handleFiles(droppedFiles);
  };

  const handleFiles = /** Handles the handleFiles interaction. */ (newFiles: File[]) => {
    const validFiles: File[] = [];

    for (const file of newFiles) {
      const validation = validateAudioFile(file);
      if (validation.valid) {
        validFiles.push(file);
      } else {
        toast.error(`${file.name}: ${validation.error}`);
      }
    }

    setFiles(/** Handles the callback for this operation. */(prev) => [...prev, ...validFiles]);
  };

  const handleFileInput = /** Handles the handleFileInput interaction. */ (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(Array.from(e.target.files));
    }
  };

  const removeFile = /** Documents the removeFile behavior. */ (index: number) => {
    setFiles(/** Handles the callback for this operation. */(prev) => prev.filter(/** Handles the callback for this operation. */(_, i) => i !== index));
  };

  const handleUpload = /** Handles the handleUpload interaction. */ async () => {
    if (files.length === 0) return;

    setUploading(true);
    setProgress({});

    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        const effectiveAnalyzerModel = analyzerModel || availablePrompts?.analyzerModels?.default;
        // Upload to Firebase Storage
        // Backend trigger (onAudioUpload) will create Firestore document
        // and onCallCreated trigger will start transcription automatically
        await uploadAudioFile({
          file,
          onProgress: /** Handles the onProgress interaction. */ (p) => {
            setProgress(/** Handles the callback for this operation. */(prev) => ({ ...prev, [file.name]: p }));
          },
          promptVersions,
          analyzerModel: effectiveAnalyzerModel,
          userId: user!.uid,
          agentRoutingMode,
        });

        successCount++;
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error);
        errorCount++;
      }
    }

    setUploading(false);

    if (successCount > 0) {
      toast.success(`Successfully uploaded ${successCount} file(s)`);
    }
    if (errorCount > 0) {
      toast.error(`Failed to upload ${errorCount} file(s)`);
    }

    if (successCount > 0) {
      setFiles([]);
      setProgress({});
      navigate('/calls');
    }
  };

  const totalProgress =
    files.length > 0
      ? Object.values(progress).reduce(/** Handles the callback for this operation. */(sum, p) => sum + p.progress, 0) / files.length
      : 0;
  const analyzerModelOptions = availablePrompts?.analyzerModels;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('upload.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('upload.description')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('upload.analyzerModel.title')}</CardTitle>
          <CardDescription>
            {t('upload.analyzerModel.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {promptsLoading ? (
            <div className="flex items-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {t('upload.analyzerModel.loading')}
              </span>
            </div>
          ) : analyzerModelOptions?.available?.length ? (
            <>
              <label className="text-sm font-medium">
                {t('upload.analyzerModel.label')}
              </label>
              <Select
                value={analyzerModel || analyzerModelOptions.default}
                onValueChange={setAnalyzerModel}
                disabled={uploading || analyzerModelOptions.available.length <= 1}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {analyzerModelOptions.available.map(/** Handles the callback for this operation. */(model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                      {model === analyzerModelOptions.default
                        ? ` ${t('upload.promptVersions.default')}`
                        : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('upload.analyzerModel.help')}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('upload.analyzerModel.fallback')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Asignación de agente</CardTitle>
          <CardDescription>
            Decide si esta carga debe intentar detectar automáticamente al agente activo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Select
            value={agentRoutingMode}
            onValueChange={/** Handles the onValueChange interaction. */ (value) => setAgentRoutingMode(value as 'none' | 'general')}
            disabled={uploading}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sin agente asignado</SelectItem>
              <SelectItem value="general">Detectar agente automáticamente</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Si la detección no alcanza confianza suficiente, la llamada quedará pendiente para
            asignación manual.
          </p>
        </CardContent>
      </Card>

      {/* Prompt Versions */}
      <Card>
        <CardHeader
          className="cursor-pointer select-none"
          onClick={/** Handles the onClick interaction. */ () => setShowPromptVersions(/** Handles the callback for this operation. */(prev) => !prev)}
        >
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t('upload.promptVersions.title')}</CardTitle>
              <CardDescription>
                {t('upload.promptVersions.description')}
              </CardDescription>
            </div>
            {showPromptVersions ? (
              <ChevronUp className="h-5 w-5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
        </CardHeader>
        {showPromptVersions && (
          <CardContent className="space-y-4">
            {promptsLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">{t('upload.promptVersions.loading')}</span>
              </div>
            ) : availablePrompts ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Object.entries(availablePrompts.availableVersions).map(/** Handles the callback for this operation. */([taskId, versions]) => (
                  <div key={taskId} className="space-y-1.5">
                    <label className="text-sm font-medium">
                      {t(`upload.promptVersions.${taskId}`, taskId)}
                    </label>
                    <Select
                      value={promptVersions[taskId] ?? availablePrompts.defaults[taskId]}
                      onValueChange={/** Handles the onValueChange interaction. */ (v) =>
                        setPromptVersions(/** Handles the callback for this operation. */(prev) => ({ ...prev, [taskId]: v }))
                      }
                      disabled={uploading || versions.length <= 1}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {versions.map(/** Handles the callback for this operation. */(version) => (
                          <SelectItem key={version} value={version}>
                            v{version}
                            {version === availablePrompts.defaults[taskId] ? ` ${t('upload.promptVersions.default')}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('upload.promptVersions.error')}
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* Dropzone */}
      <Card>
        <CardContent className="pt-6">
          <div
            className={cn(
              'border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer',
              dragActive
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/25 hover:border-primary/50'
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
              multiple
              className="hidden"
              onChange={handleFileInput}
              disabled={uploading}
            />
            <Upload className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">{t('upload.dropzone')}</p>
            <p className="text-sm text-muted-foreground mt-2">
              WAV, MP3 - Max 25 MB / 5 min
            </p>
          </div>
        </CardContent>
      </Card>

      {/* File List */}
      {files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Selected Files ({files.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {files.map(/** Handles the callback for this operation. */(file, index) => {
              const fileProgress = progress[file.name];

              return (
                <div
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between p-3 bg-muted rounded-lg"
                >
                  <div className="flex items-center space-x-3 flex-1 min-w-0">
                    <FileAudio className="h-8 w-8 text-primary flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{file.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                  </div>

                  {fileProgress ? (
                    <div className="w-24 mr-4">
                      <Progress value={fileProgress.progress} className="h-2" />
                      <p className="text-xs text-center mt-1">
                        {Math.round(fileProgress.progress)}%
                      </p>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={/** Handles the onClick interaction. */ (e) => {
                        e.stopPropagation();
                        removeFile(index);
                      }}
                      disabled={uploading}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Overall Progress */}
      {uploading && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>Overall Progress</span>
                <span>{Math.round(totalProgress)}%</span>
              </div>
              <Progress value={totalProgress} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload Button */}
      <Button
        onClick={handleUpload}
        disabled={files.length === 0 || uploading}
        className="w-full"
        size="lg"
      >
        {uploading ? (
          <>
            <Loader2 className="h-5 w-5 mr-2 animate-spin" />
            {t('upload.uploading')}
          </>
        ) : (
          <>
            <Upload className="h-5 w-5 mr-2" />
            {t('upload.uploadButton')} ({files.length} file{files.length !== 1 ? 's' : ''})
          </>
        )}
      </Button>
    </div>
  );
}
