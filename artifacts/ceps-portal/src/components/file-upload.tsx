import { useCallback, useRef, useState } from 'react';
import { useUpload } from '@workspace/object-storage-web';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { CheckCircle2, FileUp, Loader2, XCircle } from 'lucide-react';

const DEFAULT_ACCEPT = '.pdf,.png,.jpg,.jpeg';
const ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const MAX_BYTES = 10 * 1024 * 1024;

export interface FileUploadResult {
  /** Object path (e.g. /objects/uploads/uuid). Serve via /api/storage{objectPath}. */
  objectPath: string;
  filename: string;
  contentType: string;
  size: number;
  /** Pass-through identifier from the file selection phase to handle races */
  uploadId?: string;
}

interface FileUploadProps {
  /** Called with the stored object path and metadata after a successful upload. */
  onUploaded: (result: FileUploadResult) => void;
  /** Called if the upload fails. */
  onUploadError?: (error: Error, uploadId?: string) => void;
  /** Called with the raw File as soon as it passes client-side validation (before upload completes). Returns an optional identifier to include in onUploaded. */
  onFileSelected?: (file: File) => string | void;
  /** Accept attribute for the file picker. Defaults to PDF/PNG/JPG. */
  accept?: string;
  /** Label shown in the drop zone. */
  label?: string;
  className?: string;
  disabled?: boolean;
}

export function FileUpload({
  onUploaded,
  onUploadError,
  onFileSelected,
  accept = DEFAULT_ACCEPT,
  label = 'Drag & drop a file here, or click to browse',
  className,
  disabled,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const { uploadFile, isUploading, progress, error: useUploadError } = useUpload();

  const handleFile = useCallback(
    async (file: File) => {
      setLocalError(null);
      setUploadedName(null);
      if (!ALLOWED_TYPES.includes(file.type)) {
        setLocalError('Unsupported file type. Allowed: PDF, PNG, JPG.');
        return;
      }
      if (file.size > MAX_BYTES) {
        setLocalError('File is larger than the 10MB limit.');
        return;
      }

      const uploadId = onFileSelected?.(file) || undefined;
      const response = await uploadFile(file);

      if (response) {
        setUploadedName(file.name);
        onUploaded({
          objectPath: response.objectPath,
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          uploadId,
        });
      } else {
        onUploadError?.(new Error('Upload failed'), uploadId);
      }
    },
    [uploadFile, onFileSelected, onUploaded, onUploadError],
  );

  const displayError = localError ?? (useUploadError ? useUploadError.message : null);

  return (
    <div className={className}>
      <div
        role="button"
        tabIndex={0}
        data-testid="dropzone-file-upload"
        aria-disabled={disabled || isUploading}
        onClick={() => !disabled && !isUploading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled && !isUploading) {
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !isUploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (disabled || isUploading) return;
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center text-sm transition-colors cursor-pointer',
          dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50',
          (disabled || isUploading) && 'opacity-60 cursor-not-allowed',
        )}
      >
        {isUploading ? (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-muted-foreground">Uploading…</p>
            <Progress value={progress} className="w-full max-w-xs" />
          </>
        ) : uploadedName ? (
          <>
            <CheckCircle2 className="h-6 w-6 text-green-600" />
            <p className="font-medium" data-testid="text-upload-success">{uploadedName} uploaded</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                inputRef.current?.click();
              }}
            >
              Replace file
            </Button>
          </>
        ) : (
          <>
            <FileUp className="h-6 w-6 text-muted-foreground" />
            <p className="text-muted-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">PDF, PNG, or JPG — up to 10MB</p>
          </>
        )}
      </div>

      {displayError && (
        <p className="mt-2 flex items-center gap-1 text-sm text-destructive" data-testid="text-upload-error">
          <XCircle className="h-4 w-4 shrink-0" /> {displayError}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        data-testid="input-file-upload"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
