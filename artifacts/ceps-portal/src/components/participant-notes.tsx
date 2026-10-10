import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListClientNotes,
  useCreateClientNote,
  useUpdateClientNote,
  useDeleteClientNote,
  getListClientNotesQueryKey,
  type ClientNote,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { StickyNote } from 'lucide-react';

const MAX = 5000;

export function formatPacific(ts: string): string {
  const d = new Date(ts);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(d);
  return date;
}

function errMessage(e: unknown): string {
  const m = (e as { data?: { error?: string }; message?: string } | null);
  return m?.data?.error || m?.message || 'Something went wrong. Your text has been kept; please try again.';
}

function NoteItem({ note, clientId, onDelete }: { note: ClientNote; clientId: string; onDelete: (n: ClientNote) => void }) {
  const qc = useQueryClient();
  const update = useUpdateClientNote();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [error, setError] = useState<string | null>(null);
  const valid = draft.trim().length > 0 && draft.length <= MAX;

  const save = () => {
    setError(null);
    update.mutate({ id: clientId, noteId: note.id, data: { body: draft.trim() } }, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListClientNotesQueryKey(clientId) });
        setEditing(false);
      },
      onError: (e) => setError(errMessage(e)),
    });
  };

  return (
    <li className="rounded-md border p-3 space-y-2" data-testid={`note-${note.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium" data-testid={`note-author-${note.id}`}>{note.authorName}</span>
        <Badge variant="outline" data-testid={`note-role-${note.id}`}>{note.authorRole === 'staff' ? 'CEPS' : note.authorRole === 'service_coordinator' ? 'SC' : note.authorRole.replaceAll('_', ' ')}</Badge>
        <span className="text-xs text-muted-foreground" data-testid={`note-created-${note.id}`}>{formatPacific(note.createdAt)}</span>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} maxLength={MAX} disabled={update.isPending} aria-label="Edit note" data-testid={`input-edit-note-${note.id}`} />
          {error && <p role="alert" className="text-sm text-destructive" data-testid={`error-edit-note-${note.id}`}>{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={!valid || update.isPending} data-testid={`button-save-note-${note.id}`}>{update.isPending ? 'Saving...' : 'Save'}</Button>
            <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => { setEditing(false); setDraft(note.body); setError(null); }} data-testid={`button-cancel-note-${note.id}`}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm" data-testid={`note-body-${note.id}`}>{note.body}</p>
          {note.updatedAt && (
            <p className="text-xs text-muted-foreground" data-testid={`note-edited-${note.id}`}>
              Edited {formatPacific(note.updatedAt)}{note.updatedByName ? ` by ${note.updatedByName}` : ''}
            </p>
          )}
          {(note.canEdit || note.canDelete) && (
            <div className="flex gap-2">
              {note.canEdit && <Button size="sm" variant="ghost" onClick={() => { setDraft(note.body); setEditing(true); }} data-testid={`button-edit-note-${note.id}`}>Edit</Button>}
              {note.canDelete && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onDelete(note)} data-testid={`button-delete-note-${note.id}`}>Delete</Button>}
            </div>
          )}
        </>
      )}
    </li>
  );
}

export function ParticipantNotes({ clientId }: { clientId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const allowed = user?.role === 'staff' || user?.role === 'service_coordinator';
  const { data: notes, isLoading, isError, refetch } = useListClientNotes(clientId, {
    query: {
      enabled: !!clientId && allowed,
      queryKey: [...getListClientNotesQueryKey(clientId), user?.id],
      refetchInterval: 30000,
    },
  });
  const create = useCreateClientNote();
  const del = useDeleteClientNote();
  const [body, setBody] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ClientNote | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  if (!allowed) return null;

  const add = () => {
    setAddError(null);
    create.mutate({ id: clientId, data: { body: body.trim() } }, {
      onSuccess: () => {
        setBody('');
        void qc.invalidateQueries({ queryKey: getListClientNotesQueryKey(clientId) });
      },
      onError: (e) => setAddError(errMessage(e)),
    });
  };

  const confirmDelete = () => {
    if (!toDelete) return;
    setDelError(null);
    del.mutate({ id: clientId, noteId: toDelete.id }, {
      onSuccess: () => {
        setToDelete(null);
        void qc.invalidateQueries({ queryKey: getListClientNotesQueryKey(clientId) });
      },
      onError: (e) => setDelError(errMessage(e)),
    });
  };

  const list = [...(notes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <Card data-testid="card-participant-notes">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <StickyNote className="w-5 h-5 text-primary" /> Notes
          {notes && <span className="text-sm font-normal text-muted-foreground" data-testid="text-note-count">({notes.length})</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={MAX} disabled={create.isPending} placeholder="Write a note about this participant" aria-label="New note" data-testid="input-new-note" />
          {addError && <p role="alert" className="text-sm text-destructive" data-testid="error-add-note">{addError}</p>}
          <Button size="sm" onClick={add} disabled={!body.trim() || create.isPending} data-testid="button-add-note">{create.isPending ? 'Adding...' : 'Add note'}</Button>
        </div>
        {isLoading ? (
          <div className="space-y-2" data-testid="notes-loading"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : isError ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground" data-testid="notes-error">
            <span>Notes could not be loaded.</span>
            <Button variant="outline" size="sm" onClick={() => void refetch()} data-testid="button-retry-notes">Retry</Button>
          </div>
        ) : list.length === 0 ? (
          <div className="text-muted-foreground text-sm p-4 border border-dashed rounded-md text-center" data-testid="notes-empty">No notes yet</div>
        ) : (
          <ul className="space-y-3" data-testid="list-notes">
            {list.map((n) => <NoteItem key={n.id} note={n} clientId={clientId} onDelete={(x) => { setDelError(null); setToDelete(x); }} />)}
          </ul>
        )}
      </CardContent>
      <AlertDialog open={!!toDelete} onOpenChange={(o) => { if (!o && !del.isPending) setToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>The note will be removed from the participant's Notes list. It is soft-deleted and remains in the audit record.</AlertDialogDescription>
          </AlertDialogHeader>
          {delError && <p role="alert" className="text-sm text-destructive" data-testid="error-delete-note">{delError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending} data-testid="button-cancel-delete-note">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmDelete(); }} disabled={del.isPending} data-testid="button-confirm-delete-note">{del.isPending ? 'Deleting...' : 'Delete'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
