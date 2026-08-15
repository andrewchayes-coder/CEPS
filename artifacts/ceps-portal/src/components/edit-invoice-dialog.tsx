import React, { useState } from 'react';
import { useUpdateInvoice } from '@workspace/api-client-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Pencil } from 'lucide-react';

type InvoiceLike = {
  serviceMonth: string;
  amountRequested: string;
  paymentType: string;
  status: string;
  notes?: string | null;
};

type Props = {
  id: string;
  invoice: InvoiceLike;
  onSaved?: () => void;
};

export function EditInvoiceDialog({ id, invoice, onSaved }: Props) {
  const { toast } = useToast();
  const updateInvoice = useUpdateInvoice();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    serviceMonth: invoice.serviceMonth,
    amountRequested: invoice.amountRequested,
    paymentType: invoice.paymentType,
    status: invoice.status,
    notes: invoice.notes ?? '',
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    updateInvoice.mutate(
      { id, data: form as any },
      {
        onSuccess: () => {
          toast({ title: 'Invoice updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update invoice.' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-invoice">
          <Pencil className="w-4 h-4 mr-2" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Invoice</DialogTitle>
          <DialogDescription>Update the invoice details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label>Service Month</Label>
            <Input placeholder="YYYY-MM" value={form.serviceMonth} onChange={(e) => set('serviceMonth', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Amount Requested</Label>
            <Input value={form.amountRequested} onChange={(e) => set('amountRequested', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Payment Type</Label>
            <Select value={form.paymentType} onValueChange={(v) => set('paymentType', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="direct_payment">Direct Payment</SelectItem>
                <SelectItem value="reimbursement">Reimbursement</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => set('status', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending_review">Pending Review</SelectItem>
                <SelectItem value="validated">Validated</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="duplicate">Duplicate</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 col-span-2">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateInvoice.isPending} data-testid="button-save-invoice">
            {updateInvoice.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
