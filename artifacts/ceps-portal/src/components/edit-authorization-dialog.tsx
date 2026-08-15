import React, { useState } from 'react';
import { useUpdateAuthorization } from '@workspace/api-client-react';
import type { AuthorizationUpdate } from '@workspace/api-client-react';
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

const SERVICE_CODES = ['459', '024', '490'];
const STATUSES = ['active', 'expired', 'pending', 'exhausted'];

type AuthorizationLike = {
  authNumber: string;
  serviceCode: string;
  activityDescription?: string | null;
  monthlyAmount?: string | null;
  oneTimeAmount?: string | null;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  status: string;
  vendorId?: string | null;
};

type Props = {
  id: string;
  authorization: AuthorizationLike;
  onSaved?: () => void;
};

export function EditAuthorizationDialog({ id, authorization, onSaved }: Props) {
  const { toast } = useToast();
  const updateAuthorization = useUpdateAuthorization();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    authNumber: authorization.authNumber,
    serviceCode: authorization.serviceCode,
    activityDescription: authorization.activityDescription ?? '',
    monthlyAmount: authorization.monthlyAmount ?? '',
    oneTimeAmount: authorization.oneTimeAmount ?? '',
    servicePeriodStart: authorization.servicePeriodStart?.slice(0, 10) ?? '',
    servicePeriodEnd: authorization.servicePeriodEnd?.slice(0, 10) ?? '',
    status: authorization.status,
    vendorId: authorization.vendorId ?? '',
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    const data: AuthorizationUpdate = {
      authNumber: form.authNumber,
      serviceCode: form.serviceCode as AuthorizationUpdate['serviceCode'],
      activityDescription: form.activityDescription || undefined,
      monthlyAmount: form.monthlyAmount === '' ? null : form.monthlyAmount,
      oneTimeAmount: form.oneTimeAmount === '' ? null : form.oneTimeAmount,
      servicePeriodStart: form.servicePeriodStart || undefined,
      servicePeriodEnd: form.servicePeriodEnd || undefined,
      status: form.status as AuthorizationUpdate['status'],
      vendorId: form.vendorId === '' ? null : form.vendorId,
    };
    updateAuthorization.mutate(
      { id, data },
      {
        onSuccess: () => {
          toast({ title: 'Authorization updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update authorization.' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="button-edit-authorization">
          <Pencil className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Authorization</DialogTitle>
          <DialogDescription>Update the authorization (POS) details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label>Auth #</Label>
            <Input value={form.authNumber} onChange={(e) => set('authNumber', e.target.value)} data-testid="input-auth-number" />
          </div>
          <div className="space-y-2">
            <Label>Service Code</Label>
            <Select value={form.serviceCode} onValueChange={(v) => set('serviceCode', v)}>
              <SelectTrigger data-testid="select-auth-service-code"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SERVICE_CODES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 col-span-2">
            <Label>Service Description</Label>
            <Textarea value={form.activityDescription} onChange={(e) => set('activityDescription', e.target.value)} data-testid="input-auth-description" />
          </div>
          <div className="space-y-2">
            <Label>Monthly Amount</Label>
            <Input value={form.monthlyAmount} onChange={(e) => set('monthlyAmount', e.target.value)} data-testid="input-auth-monthly-amount" />
          </div>
          <div className="space-y-2">
            <Label>One-Time Amount</Label>
            <Input value={form.oneTimeAmount} onChange={(e) => set('oneTimeAmount', e.target.value)} data-testid="input-auth-onetime-amount" />
          </div>
          <div className="space-y-2">
            <Label>Period Start</Label>
            <Input type="date" value={form.servicePeriodStart} onChange={(e) => set('servicePeriodStart', e.target.value)} data-testid="input-auth-start-date" />
          </div>
          <div className="space-y-2">
            <Label>Period End</Label>
            <Input type="date" value={form.servicePeriodEnd} onChange={(e) => set('servicePeriodEnd', e.target.value)} data-testid="input-auth-end-date" />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => set('status', v)}>
              <SelectTrigger data-testid="select-auth-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Vendor ID</Label>
            <Input value={form.vendorId} onChange={(e) => set('vendorId', e.target.value)} placeholder="Optional" data-testid="input-auth-vendor-id" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateAuthorization.isPending} data-testid="button-save-authorization">
            {updateAuthorization.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
