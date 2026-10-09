import React, { useState } from 'react';
import { useCreateUser, useListUserDirectory, useUpdateReferral } from '@workspace/api-client-react';
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
import { apiErrorMessage } from '@/lib/api-error';
import { useAuth } from '@/components/auth/auth-provider';
import { isAuthorizationAmount, isServiceDate, normalizeAuthorizationAmount } from '@/lib/referral-service';

const STATUSES = [
  'intake',
  'pending_signature',
  'pending_auth',
  'pending_w9',
  'pending_invoice',
  'active',
  'closed',
];

type ReferralLike = {
  status: string;
  notes?: string | null;
  serviceCoordinatorId?: string | null;
  intakeFields?: { serviceStartDate?: string; serviceEndDate?: string; authAmount?: string } | null;
};

type Props = {
  id: string;
  referral: ReferralLike;
  onSaved?: () => void;
};

export function EditReferralDialog({ id, referral, onSaved }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const canManageUsers = user?.role === 'staff' && (user.permissions ?? []).includes('manage_users');
  const updateReferral = useUpdateReferral();
  const createUser = useCreateUser();
  const [open, setOpen] = useState(false);
  const { data: coordinators, refetch: refetchCoordinators } = useListUserDirectory(
    { role: 'service_coordinator', active: true },
    { query: { enabled: open, queryKey: ['userDirectory', 'active-service-coordinators'] } },
  );
  const [form, setForm] = useState({
    status: referral.status,
    notes: referral.notes ?? '',
    serviceCoordinatorId: referral.serviceCoordinatorId ?? '',
    serviceStartDate: referral.intakeFields?.serviceStartDate ?? '',
    serviceEndDate: referral.intakeFields?.serviceEndDate ?? '',
    authAmount: referral.intakeFields?.authAmount ?? '',
  });
  const [serviceError, setServiceError] = useState('');
  const [addingCoordinator, setAddingCoordinator] = useState(false);
  const [coordinatorForm, setCoordinatorForm] = useState({ name: '', email: '' });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setForm({
        status: referral.status,
        notes: referral.notes ?? '',
        serviceCoordinatorId: referral.serviceCoordinatorId ?? '',
        serviceStartDate: referral.intakeFields?.serviceStartDate ?? '',
        serviceEndDate: referral.intakeFields?.serviceEndDate ?? '',
        authAmount: referral.intakeFields?.authAmount ?? '',
      });
      setServiceError('');
      setAddingCoordinator(false);
      setCoordinatorForm({ name: '', email: '' });
    }
  };

  const handleCreateCoordinator = () => {
    if (!canManageUsers) return;
    const name = coordinatorForm.name.trim();
    const email = coordinatorForm.email.trim();
    if (!name || !email) {
      toast({ variant: 'destructive', title: 'Name and email are required' });
      return;
    }
    createUser.mutate(
      { data: { name, email, role: 'service_coordinator' } },
      {
        onSuccess: async (user) => {
          set('serviceCoordinatorId', user.id);
          setAddingCoordinator(false);
          setCoordinatorForm({ name: '', email: '' });
          await refetchCoordinators();
          toast({ title: 'Coordinator created and selected' });
        },
        onError: (error: unknown) => toast({
          variant: 'destructive',
          title: 'Could not create coordinator',
          description: (error as { data?: { error?: string } })?.data?.error ?? 'Check the name and email and try again.',
        }),
      },
    );
  };

  const handleSave = () => {
    const serviceChanged = ['serviceStartDate', 'serviceEndDate', 'authAmount'].some(key =>
      form[key as 'serviceStartDate' | 'serviceEndDate' | 'authAmount'] !== (referral.intakeFields?.[key as 'serviceStartDate' | 'serviceEndDate' | 'authAmount'] ?? ''));
    if (serviceChanged) {
      const error = !isServiceDate(form.serviceStartDate) ? 'Service start date is required and must be valid'
        : !isServiceDate(form.serviceEndDate) ? 'Service end date is required and must be valid'
        : form.serviceEndDate < form.serviceStartDate ? 'Service end date must be on or after service start date'
        : !isAuthorizationAmount(form.authAmount) ? 'Enter a positive authorization amount with up to two decimal places' : '';
      setServiceError(error);
      if (error) return;
    }
    updateReferral.mutate(
      {
        id,
        data: {
          status: form.status as any,
          notes: form.notes,
          serviceCoordinatorId: form.serviceCoordinatorId || null,
          ...(serviceChanged ? { intakeFields: {
            serviceStartDate: form.serviceStartDate, serviceEndDate: form.serviceEndDate,
            authAmount: normalizeAuthorizationAmount(form.authAmount),
          } } : {}),
        },
      },
      {
        onSuccess: () => {
          toast({ title: 'Referral updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not update referral.') }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-referral">
          <Pencil className="w-4 h-4 mr-2" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Referral</DialogTitle>
          <DialogDescription>Update the referral status, coordinator, and notes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => set('status', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Service Coordinator</Label>
            <Select value={form.serviceCoordinatorId || 'unassigned'} onValueChange={(v) => set('serviceCoordinatorId', v === 'unassigned' ? '' : v)}>
              <SelectTrigger data-testid="select-referral-coordinator"><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {coordinators?.map((coordinator) => (
                  <SelectItem key={coordinator.id} value={coordinator.id}>{coordinator.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManageUsers && (!addingCoordinator ? (
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => setAddingCoordinator(true)} data-testid="button-add-referral-coordinator">
                Add new coordinator
              </Button>
            ) : (
              <div className="space-y-2 rounded-md border p-3">
                <Input
                  placeholder="Coordinator name"
                  value={coordinatorForm.name}
                  onChange={(event) => setCoordinatorForm((current) => ({ ...current, name: event.target.value }))}
                  data-testid="input-new-coordinator-name"
                />
                <Input
                  type="email"
                  placeholder="Coordinator email"
                  value={coordinatorForm.email}
                  onChange={(event) => setCoordinatorForm((current) => ({ ...current, email: event.target.value }))}
                  data-testid="input-new-coordinator-email"
                />
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={handleCreateCoordinator} disabled={createUser.isPending} data-testid="button-create-referral-coordinator">
                    {createUser.isPending ? 'Creating…' : 'Create coordinator'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAddingCoordinator(false)}>Cancel</Button>
                </div>
              </div>
            ))}
          </div>
          {user?.role === 'staff' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="edit-service-start">Service start date</Label>
                <Input id="edit-service-start" type="date" value={form.serviceStartDate} onChange={e => set('serviceStartDate', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-service-end">Service end date</Label>
                <Input id="edit-service-end" type="date" value={form.serviceEndDate} onChange={e => set('serviceEndDate', e.target.value)} />
                <p className="text-xs text-muted-foreground">Use the authorization's end date (end of service or IPP renewal).</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-auth-amount">Authorization amount</Label>
                <Input id="edit-auth-amount" inputMode="decimal" placeholder="0.00" value={form.authAmount} onChange={e => set('authAmount', e.target.value)} />
              </div>
              {serviceError && <p role="alert" className="text-sm text-destructive">{serviceError}</p>}
            </div>
          )}
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateReferral.isPending} data-testid="button-save-referral">
            {updateReferral.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
