import React, { useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import { useUpdateRemittance, useListAuthorizations } from '@workspace/api-client-react';
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
import { useToast } from '@/hooks/use-toast';
import { Pencil } from 'lucide-react';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';
import { useAuth } from '@/components/auth/auth-provider';

type RemittanceLike = {
  clientId: string;
  altaReference?: string | null;
  remittanceDate: string;
  amount: string;
  paymentMonth?: string | null;
  status: string;
  source: string;
  authorizationId?: string | null;
  authNumber?: string | null;
};

type Props = {
  id: string;
  remittance: RemittanceLike;
  onSaved?: () => void;
};

export function EditRemittanceDialog({ id, remittance, onSaved }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEnterRemittances = user?.role === 'staff' && (user.permissions ?? []).includes('remittance_entry');
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

  const [authSearch, setAuthSearch] = useState('');
  const debouncedAuthSearch = useDebounce(authSearch, 300);
  const { data: authorizationsData, isLoading: authorizationsLoading } = useListAuthorizations(
    { clientId: remittance.clientId, search: debouncedAuthSearch, limit: 50 },
    { query: { enabled: open, queryKey: ['authorizations', { clientId: remittance.clientId, search: debouncedAuthSearch, limit: 50 }] } }
  );
  const authorizations = authorizationsData?.items ?? [];

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    if (!canEnterRemittances) return;
    const data: RemittanceUpdate = {
      altaReference: form.altaReference === '' ? null : form.altaReference,
      remittanceDate: form.remittanceDate || undefined,
      amount: form.amount,
      paymentMonth: form.paymentMonth === '' ? null : form.paymentMonth,
      authorizationId: form.authorizationId === '' || form.authorizationId === 'none' ? null : form.authorizationId,
    };
    updateRemittance.mutate(
      { id, data },
      {
        onSuccess: () => {
          toast({ title: 'Remittance updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not update remittance.') }),
      },
    );
  };

  if (!canEnterRemittances) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="button-edit-remittance">
          <Pencil className="w-4 h-4 mr-1" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Remittance</DialogTitle>
          <DialogDescription>Update the remittance details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="edit-remittance-reference">Source / payment reference</Label>
            <Input id="edit-remittance-reference" value={form.altaReference} onChange={(e) => set('altaReference', e.target.value)} data-testid="input-remittance-reference" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-remittance-date">Date Received</Label>
            <Input id="edit-remittance-date" type="date" value={form.remittanceDate} onChange={(e) => set('remittanceDate', e.target.value)} data-testid="input-remittance-date" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-remittance-amount">Amount</Label>
            <Input id="edit-remittance-amount" value={form.amount} onChange={(e) => set('amount', e.target.value)} disabled={remittance.status === 'matched'} data-testid="input-remittance-amount" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-remittance-month">Payment Month</Label>
            <Input id="edit-remittance-month" type="month" value={form.paymentMonth} onChange={(e) => set('paymentMonth', e.target.value)} disabled={remittance.status === 'matched'} data-testid="input-remittance-month" />
          </div>
          <div className="space-y-2 col-span-2">
            <Label htmlFor="edit-remittance-authorization">Authorization</Label>
            <SearchableSelect
              id="edit-remittance-authorization"
              value={form.authorizationId}
              onValueChange={(v) => set('authorizationId', v)}
              options={authorizations.map(a => ({ value: a.id, label: a.authNumber }))}
              onSearchChange={setAuthSearch}
              loading={authorizationsLoading}
              selectedLabelFallback={remittance.authNumber ?? undefined}
              disabled={remittance.status === 'matched'}
              placeholder="Select authorization"
              allowClear
              clearLabel="None"
              data-testid="select-remittance-authorization-id"
            />
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
