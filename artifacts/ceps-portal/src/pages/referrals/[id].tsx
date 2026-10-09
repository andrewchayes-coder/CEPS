import React, { useState } from 'react';
import { formatMoney } from '@/lib/utils';
import { useLocation, useParams } from 'wouter';
import { useGetReferral, useGetReferralHistory, getGetReferralHistoryQueryKey, useDeleteReferral, useGetCoordinatorReview, useReviewCoordinatorReferral, getGetCoordinatorReviewQueryKey } from '@workspace/api-client-react';
import type { ReferralReviewRepresentative, ReferralReviewValue, CoordinatorReviewInput, CoordinatorReviewDetails } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/auth/auth-provider';
import { EditReferralDialog } from '@/components/edit-referral-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { SendIntakeDialog } from '@/components/send-intake-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, AlertTriangle, FileText, ArrowLeft } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Link } from 'wouter';
import { ClientLink } from '@/components/entity-links';
import { AgreementReview } from '@/components/agreement-review';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { apiErrorMessage } from '@/lib/api-error';

const reviewFields = [
  { key: 'applyPhone', label: 'Phone', value: 'phone' },
  { key: 'applyEmail', label: 'Email', value: 'email' },
  { key: 'applyAddress', label: 'Address', value: 'address' },
  { key: 'applyPreferredLanguage', label: 'Preferred language', value: 'preferredLanguage' },
  { key: 'applyMinorStatus', label: 'Minor status', value: 'isMinor' },
  { key: 'applyFamilyRepresentative', label: 'Family representative', value: 'familyRepresentative' },
] as const;
type ApplyKey = typeof reviewFields[number]['key'];
const initialApply = Object.fromEntries(reviewFields.map(({ key }) => [key, false])) as Record<ApplyKey, boolean>;

function displayReviewValue(value: ReferralReviewValue[keyof ReferralReviewValue]) {
  if (value === null || value === undefined || value === '') return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    const rep = value as ReferralReviewRepresentative;
    return [rep.name, rep.relationship, rep.phone, rep.email, rep.address].filter(Boolean).join(' · ') || 'Not provided';
  }
  return value;
}

function CoordinatorReview({ id, review, onReviewed }: { id: string; review: CoordinatorReviewDetails; onReviewed: () => void }) {
  const mutation = useReviewCoordinatorReferral();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [apply, setApply] = useState(initialApply);
  const [assignCoordinator, setAssignCoordinator] = useState(false);
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [message, setMessage] = useState('');

  const submit = async (choice: 'approve' | 'reject') => {
    if (choice === 'reject' && !note.trim()) {
      setMessage('Add a review note before rejecting this referral.');
      return;
    }
    setMessage('');
    const data: CoordinatorReviewInput = {
      decision: choice,
      ...apply,
      reassignAsAssignedCoordinator: choice === 'approve' && assignCoordinator,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      await mutation.mutateAsync({ id, data });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['/api/referrals'] }),
        queryClient.invalidateQueries({ queryKey: ['/api/referrals', id] }),
        queryClient.invalidateQueries({ queryKey: ['/api/dashboard'] }),
      ]);
      toast({ title: choice === 'approve' ? 'Referral approved' : 'Referral rejected' });
      onReviewed();
    } catch (err) {
      setMessage(apiErrorMessage(err, 'Could not save this review. Please try again.'));
    }
  };

  return (
    <Card className="border-primary/40" data-testid="card-coordinator-review">
      <CardHeader className="bg-primary/5 border-b">
        <CardTitle>Coordinator referral review</CardTitle>
        <CardDescription>Review each proposed change before updating the participant record. Nothing is applied unless selected.</CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-5">
        <>
            <p className="text-sm">Submitted by <strong data-testid="text-referral-submitter">{review.submittedByName}</strong></p>
            <div className="space-y-3">
              <div className="hidden sm:grid grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_minmax(0,2fr)] gap-4 px-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><span>Field</span><span>Referral details</span><span>Current participant record</span></div>
              {reviewFields.map(({ key, label, value }) => (
                <div key={key} className="rounded-lg border p-4 space-y-3" data-testid={`row-review-${value}`}>
                  <div className="grid sm:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_minmax(0,2fr)] gap-3 text-sm">
                    <strong>{label}</strong>
                    <div className="min-w-0 break-words"><span className="sm:hidden block text-xs text-muted-foreground">Referral details</span>{displayReviewValue(review.intake[value])}</div>
                    <div className="min-w-0 break-words text-muted-foreground"><span className="sm:hidden block text-xs">Current record</span>{value === 'familyRepresentative' && review.currentFamilyRepresentatives.length > 0
                      ? review.currentFamilyRepresentatives.map((rep, index) => <p key={`${rep.name}-${index}`} className="mb-1">{displayReviewValue(rep)}</p>)
                      : displayReviewValue(review.current[value])}</div>
                  </div>
                  <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
                    <Checkbox checked={apply[key]} onCheckedChange={(checked) => setApply(previous => ({ ...previous, [key]: checked === true }))} disabled={mutation.isPending} data-testid={`checkbox-apply-${value}`} />
                    Apply referral {label.toLowerCase()} to participant
                  </label>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={assignCoordinator} onCheckedChange={(checked) => setAssignCoordinator(checked === true)} disabled={mutation.isPending} data-testid="checkbox-assign-submitting-coordinator" />
              Assign the submitting coordinator to this participant on approval
            </label>
            <div className="space-y-2">
              <label htmlFor="review-note" className="text-sm font-medium">Review note <span className="text-muted-foreground font-normal">(required when rejecting)</span></label>
              <Textarea id="review-note" value={note} onChange={event => { setNote(event.target.value); setMessage(''); }} disabled={mutation.isPending} placeholder="Add context for this decision" data-testid="input-review-note" />
            </div>
            {message && <p role="alert" className="text-sm text-destructive" data-testid="error-review">{message}</p>}
            <div className="flex flex-col sm:flex-row gap-2">
              <Button onClick={() => { setDecision('approve'); void submit('approve'); }} disabled={mutation.isPending} data-testid="button-approve-referral">{mutation.isPending && decision === 'approve' ? 'Approving…' : 'Approve referral'}</Button>
              <Button variant="destructive" onClick={() => { setDecision('reject'); void submit('reject'); }} disabled={mutation.isPending} data-testid="button-reject-referral">{mutation.isPending && decision === 'reject' ? 'Rejecting…' : 'Reject referral'}</Button>
            </div>
          </>
      </CardContent>
    </Card>
  );
}

export default function ReferralDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const canSendIntake = isStaff || user?.role === 'service_coordinator';
  const { toast } = useToast();
  const deleteReferral = useDeleteReferral();
  const queryClient = useQueryClient();

  const { data: referral, isLoading, refetch } = useGetReferral(id, {
    query: {
      enabled: !!id,
      queryKey: ['referrals', id]
    }
  });
  // Fetch participant comparisons only for pending referrals and staff.
  const { data: review, isLoading: isReviewLoading, isError: reviewError, error: reviewFailure, refetch: refetchReview } = useGetCoordinatorReview(id, {
    query: { enabled: !!id && referral?.coordinatorReviewStatus === 'pending' && isStaff, queryKey: getGetCoordinatorReviewQueryKey(id), retry: false },
  });

  const refreshReferral = () => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: getGetReferralHistoryQueryKey(id) });
  };
  if (isLoading) return <div className="max-w-4xl mx-auto space-y-5"><Skeleton className="h-10 w-64" /><Skeleton className="h-60 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (!referral) return <div role="alert" className="p-8 text-center">Referral not found. <Button variant="outline" onClick={() => void refetch()}>Retry</Button></div>;
  if (isStaff && referral.coordinatorReviewStatus === 'pending' && isReviewLoading) return <div className="max-w-4xl mx-auto space-y-5"><Skeleton className="h-10 w-64" /><Skeleton className="h-60 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (isStaff && referral.coordinatorReviewStatus === 'pending' && reviewError) {
    return <div role="alert" className="p-8 text-center space-y-3">Could not verify this referral’s review status. <Button variant="outline" onClick={() => void refetchReview()}>Retry</Button></div>;
  }

  const intake = referral.intakeFields;
  const isPendingReview = referral.coordinatorReviewStatus === 'pending';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/referrals"><ArrowLeft className="w-4 h-4 mr-2" /> Back to Referrals</Link>
      </Button>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Referral: <ClientLink id={referral.clientId} name={referral.clientName || 'Unknown Participant'} />
          </h1>
          <p className="text-muted-foreground mt-1">Submitted on {format(new Date(referral.referralDate), 'MMMM d, yyyy')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-sm px-3 py-1">
            Status: <span className="font-semibold ml-1 capitalize">{referral.status.replace('_', ' ')}</span>
          </Badge>
          {isStaff && !isPendingReview && (
            <>
              <EditReferralDialog id={id} referral={referral} onSaved={refreshReferral} />
              <DeleteEntityButton
                entityLabel="Referral"
                testId="button-delete-referral"
                suppressErrorToast
                onDelete={async () => {
                  try {
                    return await deleteReferral.mutateAsync({ id });
                  } catch (err) {
                    toast({
                      variant: 'destructive',
                      title: 'Cannot delete referral',
                      description:
                        'This referral has been converted to an active participant case and cannot be deleted.',
                    });
                    throw err;
                  }
                }}
                onDeleted={() => setLocation('/referrals')}
              />
            </>
          )}
        </div>
      </div>

      {isPendingReview && (
        <div role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          <p className="font-semibold">Pending CEPS review</p>
          <p className="text-muted-foreground mt-1">Submitted by {review?.submittedByName ?? 'a service coordinator'} — they are not currently linked to this participant. Referral agreements and status changes are unavailable until staff make a decision.</p>
        </div>
      )}
      {isStaff && isPendingReview && review && <CoordinatorReview id={id} review={review} onReviewed={refreshReferral} />}

      <div className="grid md:grid-cols-3 gap-6">
        {/* Main Info */}
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="w-5 h-5 text-primary" />
                Referral Details
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 grid sm:grid-cols-2 gap-y-6 gap-x-8 text-sm">
              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Participant Info</p>
                <p className="font-semibold">
                  <ClientLink
                    id={referral.clientId}
                    name={
                      intake?.clientFirstName && intake?.clientLastName
                        ? `${intake.clientFirstName} ${intake.clientLastName}`
                        : referral.clientName || 'Unknown Participant'
                    }
                  />
                </p>
                <p>DOB: {intake?.clientDob}</p>
                <p>UCI: {intake?.clientUci}</p>
                <p>Language: {intake?.preferredLanguage}</p>
              </div>

              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Service Activity</p>
                <p className="font-semibold">
                  {intake?.serviceType === 'direct_pay_459' ? 'Direct Pay (459)' : 'Reimbursement (024)'}
                </p>
                <p className="line-clamp-2" title={intake?.activityDescription}>{intake?.activityDescription}</p>
                <p>Dates: {intake?.serviceStartDate || intake?.serviceEndDate ? `${intake?.serviceStartDate || '—'} to ${intake?.serviceEndDate || '—'}` : '—'}</p>
                <p>Authorization amount: {intake?.authAmount ? `$${formatMoney(intake.authAmount)} (${(referral.serviceFrequency || intake.serviceFrequency) === 'monthly' ? 'monthly' : 'total'})` : '—'}</p>
              </div>

              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Vendor</p>
                <p className="font-semibold">{intake?.vendorName}</p>
                <p>{intake?.vendorEmail}</p>
                <p>{intake?.vendorPhone}</p>
              </div>

              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Service Coordinator</p>
                <p className="font-semibold" data-testid="text-referral-assigned-coordinator">{referral.coordinatorName || 'Unassigned'}</p>
                <p className="text-xs text-muted-foreground" data-testid="text-referral-original-submitter">
                  Submitted by: {referral.submittedByName || 'Not recorded'}
                  {referral.submittedByRole === 'staff' ? ' (Staff)' : referral.submittedByRole === 'service_coordinator' ? ' (Service Coordinator)' : ''}
                  {' '}on {format(parseISO(referral.referralDate), 'MMM d, yyyy')}
                </p>
                <p>{intake?.regionalCenterName}</p>
                {intake?.coordinatorName && <p className="text-xs text-muted-foreground">Referral contact (as entered on the form): {intake.coordinatorName} · {intake.coordinatorEmail}</p>}
              </div>
            </CardContent>
          </Card>
          {referral.agreementSnapshot && (
            <Card data-testid="signed-agreement-snapshot">
              <CardHeader className="border-b">
                <CardTitle className="text-lg">Accepted Agreement</CardTitle>
                <CardDescription>
                  Immutable copy accepted by {referral.agreementSnapshot.signedByName} on{' '}
                  {format(new Date(referral.agreementSnapshot.signedAt), 'MMMM d, yyyy \'at\' h:mm a')}
                  {' · '}{referral.agreementSnapshot.signerRelationship.replace('_', ' ')}
                  {' · '}{referral.agreementSnapshot.recipientEmail}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <AgreementReview data={referral.agreementSnapshot} />
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar Actions */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Referral Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {referral.parentSignedAt ? (
                <div className="bg-chart-5/10 text-chart-5 border border-chart-5/20 rounded-md p-4 flex gap-3">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-semibold">
                      Signed on {format(new Date(referral.parentSignedAt), 'MMM d, yyyy')}
                    </p>
                    <p className="opacity-90">
                      By {referral.signedByName}
                      {referral.signerRelationship ? ` (${referral.signerRelationship})` : ''}
                    </p>
                  </div>
                </div>
              ) : referral.intakeSentAt ? (
                <div className="bg-chart-4/10 text-chart-4 border border-chart-4/20 rounded-md p-4 flex gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0 text-chart-4" />
                  <div className="text-sm space-y-1">
                    <p className="font-semibold">Awaiting Signature</p>
                    <p className="opacity-90">
                      Sent to {referral.intakeSentTo === 'participant' ? 'Participant' : 'Family Rep'} on {format(new Date(referral.intakeSentAt), 'MMM d, yyyy')}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="bg-muted text-muted-foreground border rounded-md p-4 flex gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <div className="text-sm space-y-1">
                    <p className="font-semibold">Not Started</p>
                    <p className="opacity-90">Referral agreement has not been sent.</p>
                  </div>
                </div>
              )}
              {canSendIntake && !isPendingReview && referral.coordinatorReviewStatus !== 'rejected' && (
                <div className="pt-2">
                  <SendIntakeDialog referral={referral} onSent={refreshReferral} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Alta POS Auth</CardTitle>
            </CardHeader>
            <CardContent>
               {referral.altaAuthReceivedAt ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-chart-5" />
                    Received {format(new Date(referral.altaAuthReceivedAt), 'MMM d, yyyy')}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Waiting for official POS authorization from Regional Center.</p>
                )}
            </CardContent>
          </Card>
        </div>
      </div>
      {isStaff && <ReferralHistory id={id} />}
    </div>
  );
}

function ReferralHistory({ id }: { id: string }) {
  const { data: entries, isLoading, error, refetch } = useGetReferralHistory(id, {
    query: { queryKey: getGetReferralHistoryQueryKey(id), staleTime: 0, refetchInterval: 30000 },
  });
  return (
    <Card data-testid="referral-history">
      <CardHeader><CardTitle className="text-lg">History</CardTitle></CardHeader>
      <CardContent>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading history…</p>
          : error ? <div role="alert" className="text-sm text-destructive">{apiErrorMessage(error, 'Could not load referral history.')} <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button></div>
          : !entries?.length ? <p className="text-sm text-muted-foreground">No history recorded.</p>
          : <ol className="space-y-3 max-h-80 overflow-y-auto">
            {entries.map(entry => <li key={entry.id} className="border-b pb-3 last:border-b-0 text-sm">
              <p className="text-xs text-muted-foreground">{format(new Date(entry.createdAt), 'MMM d, yyyy h:mm a')} · {entry.userName || 'Unknown user'}</p>
              <p className="font-medium">{entry.action.replaceAll('_', ' ')}</p>
              {entry.detail && <p className="text-muted-foreground break-words">{entry.detail}</p>}
            </li>)}
          </ol>}
      </CardContent>
    </Card>
  );
}
