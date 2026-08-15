import React, { useState } from 'react';
import { useUpdateRemittance } from '@workspace/api-client-react';
import type { RemittanceUpdate } from '@workspace/api-client-react';
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

const STATUSES = ['pending', 'received', 'matched'];
const SOURCES = ['alta_regional', 'manual'];

type RemittanceLike = {
  altaReference?: string | null;
  remittanceDate: string;
  amount: string;
  paymentMonth?: string | null;
  status: string;
  source: string;
  authorizationId?: string | null;
};

type Props = {
  id: string;
  remittance: RemittanceLike;
  onSaved?: () => void;
};

export function EditRemittanceDialog({ id, remittance, onSaved }: Props) {
  const { toast } = useToast();
  const updateRemittance = useUpdateRemittance();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    altaReference: remittance.altaReference ?? '',
    remittanceDate: remittance.remittanceDate?.slice(0, 10) ?? '',
    amount: remittance.amount,
    paymentMonth: remittance.paymentMonth ?? '',
    status: remittance.status,
    source: remittance.source,
    authorizationId: remittance.authorizationId ?? '',
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    const data: RemittanceUpdate = {
      altaReference: form.altaReference === '' ? null : form.altaReference,
      remittanceDate: form.remittanceDate || undefined,
      amount: form.amount,
      paymentMonth: form.paymentMonth === '' ? null : form.paymentMonth,
      status: form.status as RemittanceUpdate['status'],
      source: form.source as RemittanceUpdate['source'],
      authorizationId: form.authorizationId === '' ? null : form.authorizationId,
    };
    updateRemittance.mutate(
      { id, data },
      {
        onSuccess: () => {
          toast({ title: 'Remittance updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update remittance.' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="button-edit-remittance">
          <Pencil className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Remittance</DialogTitle>
          <DialogDescription>Update the remittance details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label>Alta Reference</Label>
            <Input value={form.altaReference} onChange={(e) => set('altaReference', e.target.value)} data-testid="input-remittance-reference" />
          </div>
          <div className="space-y-2">
            <Label>Date Received</Label>
            <Input type="date" value={form.remittanceDate} onChange={(e) => set('remittanceDate', e.target.value)} data-testid="input-remittance-date" />
          </div>
          <div className="space-y-2">
            <Label>Amount</Label>
            <Input value={form.amount} onChange={(e) => set('amount', e.target.value)} data-testid="input-remittance-amount" />
          </div>
          <div className="space-y-2">
            <Label>Payment Month</Label>
            <Input placeholder="YYYY-MM" value={form.paymentMonth} onChange={(e) => set('paymentMonth', e.target.value)} data-testid="input-remittance-month" />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => set('status', v)}>
              <SelectTrigger data-testid="select-remittance-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Source</Label>
            <Select value={form.source} onValueChange={(v) => set('source', v)}>
              <SelectTrigger data-testid="select-remittance-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 col-span-2">
            <Label>Authorization ID</Label>
            <Input value={form.authorizationId} onChange={(e) => set('authorizationId', e.target.value)} placeholder="Optional" data-testid="input-remittance-authorization-id" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateRemittance.isPending} data-testid="button-save-remittance">
            {updateRemittance.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
