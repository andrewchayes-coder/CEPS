import type { FormEvent } from 'react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSendIntake, type Referral } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Mail, AlertCircle } from 'lucide-react';
import { Link } from 'wouter';

export function SendIntakeDialog({ referral, onSent }: { referral: Referral, onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState<'participant' | 'family_rep' | ''>('');

  const isFirstSend = !referral.intakeSentAt;

  const [cost, setCost] = useState(referral.cost || '');
  const [serviceFrequency, setServiceFrequency] = useState<'' | 'one_time' | 'monthly'>(referral.serviceFrequency || '');
  const [paymentSchedule, setPaymentSchedule] = useState(referral.paymentSchedule || '');
  const [paymentTypeRequested, setPaymentTypeRequested] = useState<'' | 'service_payment' | 'reimbursement'>(referral.paymentTypeRequested || '');

  const sendIntake = useSendIntake();
  const { toast } = useToast();

  const canSendParticipant = referral.clientIsMinor === false && !!referral.participantEmail;
  const canSendFamily = !!referral.familyRepEmail;

  const noContacts = !canSendParticipant && !canSendFamily;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setRecipient('');
      setCost(referral.cost || '');
      setServiceFrequency(referral.serviceFrequency || '');
      setPaymentSchedule(referral.paymentSchedule || '');
      setPaymentTypeRequested(referral.paymentTypeRequested || '');
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!recipient) return;

    sendIntake.mutate({
      id: referral.id,
      data: {
        recipient,
        ...(isFirstSend ? {
          cost: cost || null,
          serviceFrequency: serviceFrequency || null,
          paymentSchedule: paymentSchedule || null,
          paymentTypeRequested: paymentTypeRequested || null
        } : {})
      }
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
          description: err instanceof Error ? err.message : 'An unexpected error occurred.'
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
      <DialogContent className="max-w-md">
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
                  disabled={!canSendParticipant}
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
                  disabled={!canSendFamily}
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

            {noContacts && (
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

            {isFirstSend && !noContacts && (
              <div className="space-y-4 pt-4 border-t">
                <h4 className="font-medium text-sm text-foreground">Confirm Service Details</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="cost">Cost</Label>
                    <Input id="cost" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" data-testid="input-intake-cost" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="serviceFrequency">Frequency</Label>
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
                    <Label htmlFor="paymentTypeRequested">Payment Type Requested</Label>
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
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!recipient || sendIntake.isPending || noContacts} data-testid="button-submit-send-intake">
              {sendIntake.isPending ? 'Sending...' : 'Send Intake'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
