import { useState } from 'react';
import { useCreateRemittance, useListAuthorizations, useListClients, type RemittanceInput } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';

const emptyForm = { clientId: '', authorizationId: '', altaReference: '', remittanceDate: '', amount: '', paymentMonth: '' };

export function CreateRemittanceDialog({ onSaved }: { onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const { toast } = useToast();
  const createRemittance = useCreateRemittance();
  const { data: clientsData } = useListClients({ limit: 1000 });
  const { data: authorizationsData } = useListAuthorizations({ limit: 1000 });
  const authorizations = authorizationsData?.items?.filter((authorization) => authorization.clientId === form.clientId) ?? [];
  const set = (key: keyof typeof emptyForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const reset = () => setForm(emptyForm);

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
        toast({ title: 'Remittance created' });
        setOpen(false);
        reset();
        onSaved?.();
      },
      onError: (error: unknown) => toast({ variant: 'destructive', title: 'Could not create remittance', description: (error as { data?: { error?: string } })?.data?.error ?? 'Please review the remittance details and try again.' }),
    });
  };

  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
    <DialogTrigger asChild><Button data-testid="button-create-remittance"><Plus className="mr-2 h-4 w-4" /> Create Remittance</Button></DialogTrigger>
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>Create Remittance</DialogTitle><DialogDescription>Record a remittance manually. This creates a new line and does not change an existing remittance.</DialogDescription></DialogHeader>
      <div className="grid grid-cols-2 gap-4 py-2">
        <div className="col-span-2 space-y-2"><Label>Participant</Label><Select value={form.clientId} onValueChange={(value) => setForm((current) => ({ ...current, clientId: value, authorizationId: '' }))}><SelectTrigger data-testid="select-create-remittance-client"><SelectValue placeholder="Select a participant" /></SelectTrigger><SelectContent>{clientsData?.items?.map((client) => <SelectItem key={client.id} value={client.id}>{client.firstName} {client.lastName}</SelectItem>)}</SelectContent></Select></div>
        <div className="col-span-2 space-y-2"><Label>Authorization</Label><Select value={form.authorizationId} onValueChange={(value) => set('authorizationId', value)} disabled={!form.clientId}><SelectTrigger data-testid="select-create-remittance-authorization"><SelectValue placeholder="Select an authorization" /></SelectTrigger><SelectContent>{authorizations.map((authorization) => <SelectItem key={authorization.id} value={authorization.id}>{authorization.authNumber}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>Source / payment reference</Label><Input value={form.altaReference} onChange={(event) => set('altaReference', event.target.value)} data-testid="input-create-remittance-reference" /></div>
        <div className="space-y-2"><Label>Date received</Label><Input type="date" value={form.remittanceDate} onChange={(event) => set('remittanceDate', event.target.value)} data-testid="input-create-remittance-date" /></div>
        <div className="space-y-2"><Label>Amount</Label><Input type="number" step="0.01" value={form.amount} onChange={(event) => set('amount', event.target.value)} data-testid="input-create-remittance-amount" /></div>
        <div className="space-y-2"><Label>Service month</Label><Input type="month" value={form.paymentMonth} onChange={(event) => set('paymentMonth', event.target.value)} data-testid="input-create-remittance-month" /></div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={submit} disabled={createRemittance.isPending} data-testid="button-save-created-remittance">{createRemittance.isPending ? 'Creating…' : 'Create Remittance'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}