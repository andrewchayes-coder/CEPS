import { useRef, useState } from 'react';
import { useUpload } from '@workspace/object-storage-web';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { FileUp, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { posReviewApi } from '@/lib/pos-review-api';

type Entry = { id: string; file: File; status: 'ready' | 'uploading' | 'uploaded' | 'failed'; objectPath?: string };
const MAX_FILES = 100;
const MAX_BYTES = 10 * 1024 * 1024;

export function PosBatchUpload() {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [batchId, setBatchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { uploadFile } = useUpload();
  const progress = useQuery({
    queryKey: ['pos-batch', batchId],
    queryFn: () => posReviewApi.batch(batchId),
    enabled: !!batchId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return !data || (data.items ?? []).some(item => item.parseStatus === 'queued') ? 2000 : false;
    },
  });

  function addFiles(incoming: FileList | File[]) {
    setError('');
    const selected = Array.from(incoming);
    if (selected.some(file => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) {
      setError('Only PDF files are accepted. No files were added.');
      return;
    }
    if (selected.some(file => file.size > MAX_BYTES)) {
      setError('Each PDF must be 10 MB or smaller. No files were added.');
      return;
    }
    if (files.length + selected.length > MAX_FILES) {
      setError(`A batch can contain at most ${MAX_FILES} PDFs. No files were added.`);
      return;
    }
    setFiles(previous => [...previous, ...selected.map(file => ({ id: crypto.randomUUID(), file, status: 'ready' as const }))]);
  }

  async function submit() {
    setBusy(true);
    setError('');
    const staged = [...files];
    try {
      for (const entry of staged) {
        if (entry.objectPath) continue;
        entry.status = 'uploading';
        setFiles([...staged]);
        const result = await uploadFile(entry.file);
        if (!result) {
          entry.status = 'failed';
          setFiles([...staged]);
          throw new Error(`Could not upload ${entry.file.name}. Retry to continue.`);
        }
        entry.objectPath = result.objectPath;
        entry.status = 'uploaded';
        setFiles([...staged]);
      }
      const result = await posReviewApi.createBatch(staged.map(entry => ({
        posPdfUrl: entry.objectPath!,
        sourceFileName: entry.file.name,
      })));
      setBatchId(result.batchId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create batch. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const completed = progress.data?.items?.filter(item => item.parseStatus !== 'queued').length ?? 0;
  const total = progress.data?.totalCount ?? files.length;
  return (
    <section className="rounded-lg border bg-card p-5 space-y-4" aria-label="Upload POS batch">
      <div>
        <h2 className="text-lg font-semibold">Upload POS batch</h2>
        <p className="text-sm text-muted-foreground">Up to 100 PDFs, 10 MB each. Every POS goes to staff review, including matched participants.</p>
      </div>
      {!batchId ? (
        <>
          <div role="button" tabIndex={busy ? -1 : 0} aria-label="Choose POS PDFs" aria-disabled={busy}
            onClick={() => !busy && input.current?.click()}
            onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && !busy) { event.preventDefault(); input.current?.click(); } }}
            onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) addFiles(event.dataTransfer.files); }}
            className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-primary/60'}`}
            data-testid="dropzone-pos-batch">
            <FileUp className="mx-auto mb-2 h-6 w-6 text-primary" />
            <span className="text-sm font-medium">Drop PDFs here or browse files</span>
          </div>
          <input ref={input} type="file" accept=".pdf,application/pdf" multiple className="sr-only" disabled={busy}
            data-testid="input-pos-batch" aria-label="POS PDF files"
            onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} />
          {files.length > 0 && <div className="max-h-44 overflow-y-auto rounded-md border divide-y" aria-label="Selected PDFs">
            {files.map(entry => <div key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{entry.file.name} <span className="text-muted-foreground">· {entry.status}</span></span>
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${entry.file.name}`} disabled={busy}
                onClick={() => setFiles(previous => previous.filter(file => file.id !== entry.id))}><Trash2 className="h-4 w-4" /></Button>
            </div>)}
          </div>}
          <Button onClick={submit} disabled={!files.length || busy} data-testid="button-create-pos-batch">
            {busy ? `Uploading ${files.filter(file => file.status === 'uploaded').length} of ${files.length}…` : `Upload ${files.length} PDF${files.length === 1 ? '' : 's'} & create batch`}
          </Button>
        </>
      ) : (
        <div className="space-y-3" aria-live="polite">
          <p className="font-medium">Batch created · {completed} of {total} parsed</p>
          <Progress value={total ? (completed / total) * 100 : 0} />
          <p className="text-sm text-muted-foreground">{progress.data?.failedCount ?? 0} failed to parse; failed PDFs can still be reviewed.</p>
          {progress.isError && <p className="text-sm text-destructive">Could not refresh progress. <Button variant="link" onClick={() => progress.refetch()}>Retry</Button></p>}
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link href={`/authorizations/review?batchId=${encodeURIComponent(batchId)}`}>Review this batch</Link></Button>
            <Button variant="outline" onClick={() => { setBatchId(''); setFiles([]); }}>Start another batch</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</p>}
      {batchId && !progress.isError && completed === total && total > 0 && <p className="flex items-center gap-2 text-sm text-primary"><CheckCircle2 className="h-4 w-4" />Ready for review</p>}
    </section>
  );
}