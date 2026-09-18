import React, { useState } from 'react';
import { useUpdateFee, useWaiveFee, useCorrectFeeCollection } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Pencil } from 'lucide-react';

type FeeLike = {
  amount: string;
  status: string;
  notes?: string | null;
};

type Props = {
  id: string;
  fee: FeeLike;
  onSaved?: () => void;
};

export function EditFeeDialog({ id, fee, onSaved }: Props) {
  const { toast } = useToast();
  const updateFee = useUpdateFee();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    amount: fee.amount,
    notes: fee.notes ?? '',
  });
  const [reason, setReason] = useState('');
  const waiveFee = useWaiveFee();
  const correctFeeCollection = useCorrectFeeCollection();

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    // Forms send '' for untouched optional fields; omit empty notes.
    const data: Record<string, string> = { amount: form.amount };
    if (form.notes.trim() !== '') data.notes = form.notes;

    updateFee.mutate(
      { id, data: data as any },
      {
        onSuccess: () => {
          toast({ title: 'Fee updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update fee.' }),
      },
    );
  };

  const handleWaive = () => {
    if (!reason.trim()) {
      toast({ variant: 'destructive', title: 'Reason required', description: 'Enter a reason before waiving this fee.' });
      return;
    }
    waiveFee.mutate({ id, data: { reason: reason.trim() } }, {
      onSuccess: () => { toast({ title: 'Fee waived' }); setOpen(false); onSaved?.(); },
      onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not waive fee.' }),
    });
  };

  const handleCorrection = () => {
    if (!reason.trim()) {
      toast({ variant: 'destructive', title: 'Reason required', description: 'Enter a reason before correcting this collection.' });
      return;
    }
    correctFeeCollection.mutate({ id, data: { reason: reason.trim() } }, {
      onSuccess: () => { toast({ title: 'Collection corrected' }); setOpen(false); onSaved?.(); },
      onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not correct fee collection.' }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-fee">
          <Pencil className="w-4 h-4 mr-2" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Fee</DialogTitle>
          <DialogDescription>Update the fee amount or notes. Status advances from remittance matching.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Amount</Label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
              <Input
                className="pl-7"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                data-testid="input-fee-amount"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} data-testid="input-fee-notes" />
          </div>
          {(fee.status === 'pending' || fee.status === 'collected') && (
            <div className="space-y-2 border-t pt-4">
              <Label>{fee.status === 'collected' ? 'Correction reason' : 'Waiver reason'}</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required reason" data-testid="input-fee-status-reason" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          {fee.status === 'pending' && <Button variant="destructive" onClick={handleWaive} disabled={waiveFee.isPending} data-testid="button-waive-fee">Waive this fee</Button>}
          {fee.status === 'collected' && <Button variant="outline" onClick={handleCorrection} disabled={correctFeeCollection.isPending} data-testid="button-correct-fee-collection">Correct collection</Button>}
          <Button onClick={handleSave} disabled={updateFee.isPending} data-testid="button-save-fee">
            {updateFee.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
