import React, { useState } from 'react';
import { useUpdatePayment } from '@workspace/api-client-react';
import type { PaymentUpdate } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Pencil } from 'lucide-react';

const PAYMENT_TYPES = ['direct_payment', 'reimbursement', 'fee'];

type PaymentLike = {
  qbCheckNumber: string;
  checkDate: string;
  amount: string;
  paymentMonth?: string | null;
  paymentType: string;
  vendorId?: string | null;
  invoiceId?: string | null;
  authorizationId?: string | null;
};

type Props = {
  id: string;
  payment: PaymentLike;
  onSaved?: () => void;
};

export function EditPaymentDialog({ id, payment, onSaved }: Props) {
  const { toast } = useToast();
  const updatePayment = useUpdatePayment();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    qbCheckNumber: payment.qbCheckNumber,
    checkDate: payment.checkDate?.slice(0, 10) ?? '',
    amount: payment.amount,
    paymentMonth: payment.paymentMonth ?? '',
    paymentType: payment.paymentType,
    vendorId: payment.vendorId ?? '',
    invoiceId: payment.invoiceId ?? '',
    authorizationId: payment.authorizationId ?? '',
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    const data: PaymentUpdate = {
      qbCheckNumber: form.qbCheckNumber,
      checkDate: form.checkDate || undefined,
      amount: form.amount,
      paymentMonth: form.paymentMonth === '' ? null : form.paymentMonth,
      paymentType: form.paymentType as PaymentUpdate['paymentType'],
      vendorId: form.vendorId === '' ? null : form.vendorId,
      invoiceId: form.invoiceId === '' ? null : form.invoiceId,
      authorizationId: form.authorizationId === '' ? null : form.authorizationId,
    };
    updatePayment.mutate(
      { id, data },
      {
        onSuccess: () => {
          toast({ title: 'Payment updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update payment.' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="button-edit-payment">
          <Pencil className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Payment</DialogTitle>
          <DialogDescription>Update the payment details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label>Check #</Label>
            <Input value={form.qbCheckNumber} onChange={(e) => set('qbCheckNumber', e.target.value)} data-testid="input-payment-check-number" />
          </div>
          <div className="space-y-2">
            <Label>Payment Date</Label>
            <Input type="date" value={form.checkDate} onChange={(e) => set('checkDate', e.target.value)} data-testid="input-payment-date" />
          </div>
          <div className="space-y-2">
            <Label>Amount</Label>
            <Input value={form.amount} onChange={(e) => set('amount', e.target.value)} data-testid="input-payment-amount" />
          </div>
          <div className="space-y-2">
            <Label>Payment Month</Label>
            <Input placeholder="YYYY-MM" value={form.paymentMonth} onChange={(e) => set('paymentMonth', e.target.value)} data-testid="input-payment-month" />
          </div>
          <div className="space-y-2">
            <Label>Payment Type</Label>
            <Select value={form.paymentType} onValueChange={(v) => set('paymentType', v)}>
              <SelectTrigger data-testid="select-payment-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">{t.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Vendor ID</Label>
            <Input value={form.vendorId} onChange={(e) => set('vendorId', e.target.value)} placeholder="Optional" data-testid="input-payment-vendor-id" />
          </div>
          <div className="space-y-2">
            <Label>Invoice ID</Label>
            <Input value={form.invoiceId} onChange={(e) => set('invoiceId', e.target.value)} placeholder="Optional" data-testid="input-payment-invoice-id" />
          </div>
          <div className="space-y-2">
            <Label>Authorization ID</Label>
            <Input value={form.authorizationId} onChange={(e) => set('authorizationId', e.target.value)} placeholder="Optional" data-testid="input-payment-authorization-id" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updatePayment.isPending} data-testid="button-save-payment">
            {updatePayment.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
