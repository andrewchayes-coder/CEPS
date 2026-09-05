import type { FormEvent } from 'react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePreviewIntakeAgreement, useSendIntake, type Referral, type SignaturePage } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Mail, AlertCircle } from 'lucide-react';
import { Link } from 'wouter';
import { AgreementReview } from '@/components/agreement-review';

function getSendErrorMessage(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'data' in error &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'error' in error.data &&
    typeof error.data.error === 'string'
  ) {
    return error.data.error;
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export function SendIntakeDialog({ referral, onSent }: { referral: Referral, onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState<'participant' | 'family_rep' | ''>('');

  const isFirstSend = !referral.intakeSentAt;

  const [cost, setCost] = useState(referral.cost || '');
  const [serviceFrequency, setServiceFrequency] = useState<'' | 'one_time' | 'monthly'>(referral.serviceFrequency || '');
  const [paymentSchedule, setPaymentSchedule] = useState(referral.paymentSchedule || '');
  const [paymentTypeRequested, setPaymentTypeRequested] = useState<'' | 'service_payment' | 'reimbursement'>(referral.paymentTypeRequested || '');
  const [preview, setPreview] = useState<SignaturePage | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState('');

  const sendIntake = useSendIntake();
  const previewAgreement = usePreviewIntakeAgreement();
  const { toast } = useToast();

  const canSelectParticipant = referral.clientIsMinor === false;
  const noEligibleRecipients = !canSelectParticipant && !referral.familyRepEmail;
  const agreementInput = recipient ? {
    recipient,
    cost: cost || null,
    serviceFrequency: serviceFrequency || null,
    paymentSchedule: paymentSchedule || null,
    paymentTypeRequested: paymentTypeRequested || null,
  } : null;
  const currentFingerprint = agreementInput ? JSON.stringify(agreementInput) : '';
  const previewIsCurrent = !!preview && previewFingerprint === currentFingerprint;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setRecipient('');
      setCost(referral.cost || '');
      setServiceFrequency(referral.serviceFrequency || '');
      setPaymentSchedule(referral.paymentSchedule || '');
      setPaymentTypeRequested(referral.paymentTypeRequested || '');
      setPreview(null);
      setPreviewFingerprint('');
    }
  };

  const handlePreview = () => {
    if (!agreementInput) return;
    const fingerprint = currentFingerprint;
    previewAgreement.mutate(
      { id: referral.id, data: agreementInput },
      {
        onSuccess: (result) => {
          setPreview(result);
          setPreviewFingerprint(fingerprint);
        },
        onError: (err) => {
          setPreview(null);
          setPreviewFingerprint('');
          toast({
            variant: 'destructive',
            title: 'Cannot Preview Agreement',
            description: getSendErrorMessage(err),
          });
        },
      },
    );
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agreementInput || !previewIsCurrent) return;

    sendIntake.mutate({
      id: referral.id,
      data: agreementInput
    }, {
      onSuccess: () => {
        toast({
          title: 'Intake Sent',
          description: `Participant Agreement link sent successfully.`
        });
        setOpen(false);
        onSent();
      },
      onError: (err) => {
        toast({
          variant: 'destructive',
          title: 'Failed to Send',
          description: getSendErrorMessage(err)
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full" data-testid="button-open-send-intake">
          <Mail className="w-4 h-4 mr-2" />
          {isFirstSend ? 'Send Intake' : 'Resend Intake'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isFirstSend ? 'Send Intake Agreement' : 'Resend Intake Agreement'}</DialogTitle>
            <DialogDescription>
              Choose who should receive the Participant Agreement for signature.
            </DialogDescription>
          </DialogHeader>

          <div className="py-6 space-y-6">
            <div className="space-y-3">
              <Label>Recipient</Label>
              <div className="space-y-2">
                <Button
                  type="button"
                  variant={recipient === 'participant' ? 'default' : 'outline'}
                  className="w-full justify-start font-normal h-auto py-3"
                  disabled={!canSelectParticipant}
                  onClick={() => setRecipient('participant')}
                  data-testid="select-recipient-participant"
                >
                  <div className="text-left">
                    <div className="font-medium">Participant</div>
                    <div className="text-xs opacity-80 mt-0.5">
                      {referral.clientIsMinor ? 'Cannot send (Minor)' : (referral.participantEmail || 'No email address')}
                    </div>
                  </div>
                </Button>
                <Button
                  type="button"
                  variant={recipient === 'family_rep' ? 'default' : 'outline'}
                  className="w-full justify-start font-normal h-auto py-3"
                  onClick={() => setRecipient('family_rep')}
                  data-testid="select-recipient-family"
                >
                  <div className="text-left">
                    <div className="font-medium">Family Representative</div>
                    <div className="text-xs opacity-80 mt-0.5">
                      {referral.familyRepEmail || 'No email address'}
                    </div>
                  </div>
                </Button>
              </div>
            </div>

            {noEligibleRecipients && (
              <div className="bg-destructive/10 text-destructive p-4 rounded-md flex items-start gap-3 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Missing Contact Information</p>
                  <p className="mt-1">
                    Neither the participant nor a family representative has an email address on file. 
                    Please <Link href={`/clients/${referral.clientId}`} className="underline font-medium hover:text-destructive/80">update the participant's profile</Link> before sending the intake.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-4 pt-4 border-t">
              <h4 className="font-medium text-sm text-foreground">Confirm Agreement Details</h4>
              <p className="text-xs text-muted-foreground">
                These terms will appear on the agreement sent for signature.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cost">Proposed Cost</Label>
                  <Input id="cost" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" inputMode="decimal" data-testid="input-intake-cost" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="serviceFrequency">Service Frequency</Label>
                  <Select
                    value={serviceFrequency}
                    onValueChange={(value) => {
                      if (value === 'one_time' || value === 'monthly') setServiceFrequency(value);
                    }}
                  >
                    <SelectTrigger id="serviceFrequency" data-testid="select-intake-frequency">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="one_time">One Time</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="paymentSchedule">Payment Schedule</Label>
                  <Input id="paymentSchedule" value={paymentSchedule} onChange={(e) => setPaymentSchedule(e.target.value)} placeholder="e.g. 1st of month" data-testid="input-intake-schedule" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="paymentTypeRequested">Requested Payment Type</Label>
                  <Select
                    value={paymentTypeRequested}
                    onValueChange={(value) => {
                      if (value === 'service_payment' || value === 'reimbursement') {
                        setPaymentTypeRequested(value);
                      }
                    }}
                  >
                    <SelectTrigger id="paymentTypeRequested" data-testid="select-intake-payment-type">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="service_payment">Service Payment</SelectItem>
                      <SelectItem value="reimbursement">Reimbursement</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t">
              <div>
                <h4 className="font-semibold text-base">Full Agreement Preview</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  Load and review the complete document from the same current records used for the signer.
                </p>
              </div>
              {previewIsCurrent ? (
                <AgreementReview data={preview} />
              ) : (
                <div className="rounded-md border border-dashed p-6 text-center space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {recipient
                      ? 'Load the preview after making edits. Any later change requires a refreshed review before sending.'
                      : 'Select a recipient to load their complete agreement.'}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handlePreview}
                    disabled={!recipient || previewAgreement.isPending}
                    data-testid="button-preview-agreement"
                  >
                    {previewAgreement.isPending ? 'Loading Preview...' : preview ? 'Refresh Full Preview' : 'Load Full Preview'}
                  </Button>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!previewIsCurrent || sendIntake.isPending} data-testid="button-submit-send-intake">
              {sendIntake.isPending ? 'Sending...' : 'Send Intake'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
