import { useState } from 'react';
import { useCreateRemittance, useListAuthorizations, useListClients, type RemittanceInput } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';

const emptyForm = { clientId: '', authorizationId: '', altaReference: '', remittanceDate: '', amount: '', paymentMonth: '' };

export function CreateRemittanceDialog({ onSaved, preselectedClientId }: { onSaved?: () => void; preselectedClientId?: string }) {
  const [open, setOpen] = useState(false);
  const initialForm = () => ({ ...emptyForm, clientId: preselectedClientId ?? '' });
  const [form, setForm] = useState(initialForm);
  const { toast } = useToast();
  const createRemittance = useCreateRemittance();

  const [clientSearch, setClientSearch] = useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const { data: clientsData, isLoading: clientsLoading } = useListClients(
    { search: debouncedClientSearch, limit: 50 },
    { query: { enabled: open, queryKey: ['clients', { search: debouncedClientSearch, limit: 50 }] } },
  );

  const [authSearch, setAuthSearch] = useState('');
  const debouncedAuthSearch = useDebounce(authSearch, 300);
  const { data: authorizationsData, isLoading: authorizationsLoading } = useListAuthorizations(
    { clientId: form.clientId, search: debouncedAuthSearch, limit: 50 },
    { query: { enabled: open && !!form.clientId, queryKey: ['authorizations', { clientId: form.clientId, search: debouncedAuthSearch, limit: 50 }] } }
  );

  const authorizations = authorizationsData?.items ?? [];

  const set = (key: keyof typeof emptyForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const reset = () => setForm(initialForm());

  const handleClientChange = (value: string) => {
    setForm((current) => ({ ...current, clientId: value, authorizationId: '' }));
  };

  const submit = () => {
    if (!form.clientId || !form.authorizationId || !form.altaReference.trim() || !form.remittanceDate || !form.amount || !form.paymentMonth) {
      toast({ variant: 'destructive', title: 'Required fields missing', description: 'Participant, authorization, reference, date, amount, and service month are required.' });
      return;
    }
    const data: RemittanceInput = {
      clientId: form.clientId,
      authorizationId: form.authorizationId,
      altaReference: form.altaReference.trim(),
      remittanceDate: form.remittanceDate,
      amount: form.amount,
      paymentMonth: form.paymentMonth,
    };
    createRemittance.mutate({ data }, {
      onSuccess: () => {
        trackAnalyticsEvent('remittance_created', { source: 'manual' });
        toast({ title: 'Remittance created' });
        setOpen(false);
        reset();
        onSaved?.();
      },
      onError: (error: unknown) => toast({ variant: 'destructive', title: 'Could not create remittance', description: (error as { data?: { error?: string } })?.data?.error ?? 'Please review the remittance details and try again.' }),
    });
  };

  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); reset(); }}>
    <DialogTrigger asChild><Button data-testid="button-create-remittance"><Plus className="mr-2 h-4 w-4" /> Create Remittance</Button></DialogTrigger>
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>Create Remittance</DialogTitle><DialogDescription>Record a remittance manually. This creates a new line and does not change an existing remittance.</DialogDescription></DialogHeader>
      <div className="grid grid-cols-2 gap-4 py-2">
        <div className="col-span-2 space-y-2">
          <Label htmlFor="remittance-client">Participant</Label>
          <SearchableSelect
            id="remittance-client"
            value={form.clientId}
            onValueChange={handleClientChange}
            options={clientsData?.items?.map((client) => ({ value: client.id, label: `${client.firstName} ${client.lastName}` })) ?? []}
            onSearchChange={setClientSearch}
            loading={clientsLoading}
            disabled={!!preselectedClientId}
            placeholder="Select a participant"
            data-testid="select-create-remittance-client"
          />
        </div>
        <div className="col-span-2 space-y-2">
          <Label htmlFor="remittance-authorization">Authorization</Label>
          <SearchableSelect
            id="remittance-authorization"
            value={form.authorizationId}
            onValueChange={(value) => set('authorizationId', value)}
            options={authorizations.map((authorization) => ({ value: authorization.id, label: authorization.authNumber }))}
            onSearchChange={setAuthSearch}
            loading={authorizationsLoading}
            disabled={!form.clientId}
            placeholder={!form.clientId ? "Select a participant first" : "Select an authorization"}
            data-testid="select-create-remittance-authorization"
          />
        </div>
        <div className="space-y-2"><Label htmlFor="remittance-reference">Source / payment reference</Label><Input id="remittance-reference" value={form.altaReference} onChange={(event) => set('altaReference', event.target.value)} data-testid="input-create-remittance-reference" /></div>
        <div className="space-y-2"><Label htmlFor="remittance-date">Date received</Label><Input id="remittance-date" type="date" value={form.remittanceDate} onChange={(event) => set('remittanceDate', event.target.value)} data-testid="input-create-remittance-date" /></div>
        <div className="space-y-2"><Label htmlFor="remittance-amount">Amount</Label><Input id="remittance-amount" type="number" step="0.01" value={form.amount} onChange={(event) => set('amount', event.target.value)} data-testid="input-create-remittance-amount" /></div>
        <div className="space-y-2"><Label htmlFor="remittance-month">Service month</Label><Input id="remittance-month" type="month" value={form.paymentMonth} onChange={(event) => set('paymentMonth', event.target.value)} data-testid="input-create-remittance-month" /></div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={submit} disabled={createRemittance.isPending} data-testid="button-save-created-remittance">{createRemittance.isPending ? 'Creating…' : 'Create Remittance'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
