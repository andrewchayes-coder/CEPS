import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, FileText, Download, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface DocumentPreviewProps {
  objectPath?: string | null;
  filename?: string;
  className?: string;
}

export function DocumentPreview({ objectPath, filename = 'Document', className }: DocumentPreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!objectPath) {
      setBlobUrl(null);
      setError(null);
      setContentType(null);
      return;
    }

    let isMounted = true;
    let url: string | null = null;
    
    setLoading(true);
    setError(null);
    
    const fetchDoc = async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}api/storage${objectPath}`, { credentials: 'include' });
        if (!res.ok) {
          throw new Error(`Failed to load document (${res.status})`);
        }
        const blob = await res.blob();
        if (!isMounted) return;
        setContentType(blob.type);
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      } catch (err: unknown) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Error loading document');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    
    fetchDoc();
    
    return () => {
      isMounted = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [objectPath, retryKey]);

  if (!objectPath) {
    return (
      <div className={cn("flex flex-col items-center justify-center p-8 border border-dashed rounded-md bg-muted/20 text-muted-foreground", className)} data-testid="document-preview-empty">
        <FileText className="w-8 h-8 mb-2 opacity-50" />
        <p>No document attached</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={cn("flex flex-col items-center justify-center p-8 border rounded-md bg-muted/10", className)} data-testid="document-preview-loading">
        <Loader2 className="w-8 h-8 mb-4 animate-spin text-primary/60" />
        <p className="text-sm text-muted-foreground">Loading document...</p>
      </div>
    );
  }

  if (error || !blobUrl) {
    return (
      <div className={cn("flex flex-col items-center justify-center p-8 border rounded-md bg-destructive/5 text-destructive", className)} data-testid="document-preview-error">
        <AlertCircle className="w-8 h-8 mb-2 opacity-80" />
        <p className="text-sm font-medium">Failed to load preview</p>
        <p className="text-xs opacity-80 mt-1">{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => setRetryKey((key) => key + 1)}
          data-testid="button-retry-document"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Retry
        </Button>
      </div>
    );
  }

  const isImage = contentType?.startsWith('image/') || filename.match(/\.(png|jpe?g|gif|webp)$/i);
  const isPdf = contentType === 'application/pdf' || filename.match(/\.pdf$/i);

  return (
    <div className={cn("relative flex flex-col border rounded-md overflow-hidden bg-muted/10", className)} data-testid="document-preview">
      <div className="flex items-center justify-between p-2 border-b bg-card text-sm">
        <div className="flex items-center gap-2 truncate px-2" title={filename}>
          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="truncate font-medium">{filename}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-8" asChild>
            <a href={blobUrl} target="_blank" rel="noopener noreferrer" data-testid="button-open-document">
              <ExternalLink className="w-4 h-4 mr-1.5" /> Open
            </a>
          </Button>
          <Button variant="ghost" size="sm" className="h-8" asChild>
            <a href={blobUrl} download={filename} data-testid="button-download-document">
              <Download className="w-4 h-4 mr-1.5" /> Download
            </a>
          </Button>
        </div>
      </div>
      <div className="relative flex-1 min-h-[300px] w-full bg-black/5 flex items-center justify-center overflow-auto p-4">
        {isImage ? (
          <img src={blobUrl} alt={filename} className="max-w-full max-h-full object-contain bg-background shadow-sm rounded" data-testid="image-document-preview" />
        ) : isPdf ? (
          <iframe src={`${blobUrl}#toolbar=0`} title={filename} className="w-full h-full min-h-[500px] rounded bg-background shadow-sm" data-testid="frame-document-preview" />
        ) : (
          <div className="text-center p-8 bg-background rounded shadow-sm">
            <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">Preview not available</p>
            <p className="text-sm text-muted-foreground mt-1">This file type cannot be previewed inline.</p>
            <Button variant="default" size="sm" className="mt-4" asChild>
              <a href={blobUrl} download={filename}>Download File</a>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
