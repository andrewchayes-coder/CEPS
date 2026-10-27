import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  getGetDashboardSummaryQueryKey,
  getListReferralDraftsQueryKey,
  useDeleteReferralDraft,
  useListReferralDrafts,
  type ReferralDraft,
} from '@workspace/api-client-react';
import { ProtectedData } from '@/components/protected-data';
import { formatDateTime } from '@/lib/dates';
import { apiErrorMessage } from '@/lib/api-error';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, FilePlus2, FileText } from 'lucide-react';

export const DRAFT_STEP_COUNT = 6;
export const DUPLICATE_DRAFT_MESSAGE = 'You already have a draft referral for this participant. Open it or delete it to start a new one.';
export const MISSING_DRAFT_DOCUMENT_MESSAGE = "The attached document couldn't be restored; please attach it again.";

export function draftStepLabel(step: number) {
  return `Step ${Math.min(DRAFT_STEP_COUNT, Math.max(0, step) + 1)} of ${DRAFT_STEP_COUNT}`;
}

export function invalidateReferralDrafts(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: getListReferralDraftsQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
}

/** Returns the clashing draft id from a 409 draft response, if any. */
export function duplicateDraftId(err: unknown): string | null {
  const e = err as { status?: number; data?: { existingDraftId?: unknown } } | null;
  return e?.status === 409 && typeof e.data?.existingDraftId === 'string' ? e.data.existingDraftId : null;
}

export function useOwnDrafts(enabled: boolean) {
  return useListReferralDrafts(undefined, { query: { queryKey: getListReferralDraftsQueryKey(), enabled } });
}

export function DraftLabel({ draft }: { draft: ReferralDraft }) {
  return draft.uciNumber ? <ProtectedData>{draft.label}</ProtectedData> : <span>{draft.label}</span>;
}

function useDeleteDraftAction() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const del = useDeleteReferralDraft();
  const run = (id: string, onDone?: () => void) => del.mutate({ id }, {
    onSuccess: () => { invalidateReferralDrafts(queryClient); toast({ title: 'Draft deleted' }); onDone?.(); },
    onError: (err) => toast({ variant: 'destructive', title: 'Could not delete draft', description: apiErrorMessage(err, 'Try again.') }),
  });
  return { run, isPending: del.isPending };
}

export function DeleteDraftDialog({ draft, onClose, onDeleted }: { draft: { id: string; label?: string } | null; onClose: () => void; onDeleted?: () => void }) {
  const del = useDeleteDraftAction();
  return (
    <AlertDialog open={!!draft} onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
          <AlertDialogDescription>The saved answers will be removed. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={del.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => { e.preventDefault(); if (draft) del.run(draft.id, () => { onClose(); onDeleted?.(); }); }}
            data-testid="button-confirm-delete-draft"
          >
            {del.isPending ? 'Deleting…' : 'Delete draft'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function LeaveDraftDialog({ open, saving, onSave, onDiscard, onKeep }: { open: boolean; saving: boolean; onSave: () => void; onDiscard: () => void; onKeep: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !saving) onKeep(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save this referral as a draft?</AlertDialogTitle>
          <AlertDialogDescription>You have unsaved changes. Save them to finish later, or discard them.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel disabled={saving} data-testid="button-leave-keep-editing">Keep editing</AlertDialogCancel>
          <Button variant="outline" disabled={saving} onClick={onDiscard} data-testid="button-leave-discard">Discard</Button>
          <Button disabled={saving} onClick={onSave} data-testid="button-leave-save-draft">{saving ? 'Saving…' : 'Save draft'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DuplicateDraftAlert({ draftId, onOpen, onDeleted }: { draftId: string; onOpen: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Alert variant="destructive" data-testid="alert-duplicate-draft">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Draft already exists</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{DUPLICATE_DRAFT_MESSAGE}</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onOpen} data-testid="button-open-duplicate-draft">Open draft</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirm(true)} data-testid="button-delete-duplicate-draft">Delete draft</Button>
        </div>
      </AlertDescription>
      <DeleteDraftDialog draft={confirm ? { id: draftId } : null} onClose={() => setConfirm(false)} onDeleted={onDeleted} />
    </Alert>
  );
}

export function DraftChooser({ drafts, onResume, onStartNew }: { drafts: ReferralDraft[]; onResume: (id: string) => void; onStartNew: () => void }) {
  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Referral</h1>
        <p className="text-muted-foreground mt-1">You have unfinished referrals. Pick up where you left off, or start fresh.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Continue a draft</CardTitle>
          <CardDescription>Drafts are only visible to you.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {drafts.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-4 px-6 py-4" data-testid={`chooser-draft-${d.id}`}>
              <div className="min-w-0">
                <p className="font-medium truncate"><DraftLabel draft={d} /></p>
                <p className="text-xs text-muted-foreground">{draftStepLabel(d.currentStep)} · Last saved <ProtectedData>{formatDateTime(d.updatedAt)}</ProtectedData></p>
              </div>
              <Button size="sm" onClick={() => onResume(d.id)} data-testid={`button-continue-draft-${d.id}`}>Continue</Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <Button variant="outline" onClick={onStartNew} data-testid="button-start-new-referral"><FilePlus2 className="mr-2 h-4 w-4" />Start a new referral</Button>
    </div>
  );
}

export function MyDraftsTable() {
  const { data, isLoading, isError, refetch } = useOwnDrafts(true);
  const [toDelete, setToDelete] = useState<ReferralDraft | null>(null);
  const drafts = data?.items ?? [];
  return (
    <>
      <Table>
        <TableHeader><TableRow><TableHead>Draft</TableHead><TableHead>Step reached</TableHead><TableHead>Last saved</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
        <TableBody>
          {isLoading ? (
            [1, 2, 3].map((i) => <TableRow key={i}><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>)
          ) : isError ? (
            <TableRow><TableCell colSpan={4} className="h-32 text-center"><div role="alert" className="space-y-2"><p>Could not load your drafts.</p><Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button></div></TableCell></TableRow>
          ) : drafts.length === 0 ? (
            <TableRow><TableCell colSpan={4} className="h-32 text-center text-muted-foreground"><FileText className="mx-auto mb-2 h-5 w-5" />No drafts. Use Save draft on a new referral to finish it later.</TableCell></TableRow>
          ) : drafts.map((d) => (
            <TableRow key={d.id} data-testid={`row-draft-${d.id}`}>
              <TableCell className="font-medium"><DraftLabel draft={d} /></TableCell>
              <TableCell>{draftStepLabel(d.currentStep)}</TableCell>
              <TableCell className="whitespace-nowrap"><ProtectedData>{formatDateTime(d.updatedAt)}</ProtectedData></TableCell>
              <TableCell className="text-right space-x-1">
                <Button size="sm" variant="ghost" asChild><Link href={`/referrals/new?draft=${d.id}`} data-testid={`button-resume-draft-${d.id}`}>Resume</Link></Button>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setToDelete(d)} data-testid={`button-delete-draft-${d.id}`}>Delete</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <DeleteDraftDialog draft={toDelete} onClose={() => setToDelete(null)} />
    </>
  );
}
