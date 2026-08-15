import React, { useState } from 'react';
import { useUpdateClient } from '@workspace/api-client-react';
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

type ClientLike = {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  uciNumber: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  status: string;
  regionalCenter?: string | null;
  preferredLanguage?: string | null;
};

type Props = {
  id: string;
  client: ClientLike;
  onSaved?: () => void;
};

export function EditClientDialog({ id, client, onSaved }: Props) {
  const { toast } = useToast();
  const updateClient = useUpdateClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    firstName: client.firstName,
    lastName: client.lastName,
    dateOfBirth: client.dateOfBirth,
    uciNumber: client.uciNumber,
    address: client.address ?? '',
    phone: client.phone ?? '',
    email: client.email ?? '',
    status: client.status,
    regionalCenter: client.regionalCenter ?? '',
    preferredLanguage: client.preferredLanguage ?? '',
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    updateClient.mutate(
      { id, data: form as any },
      {
        onSuccess: () => {
          toast({ title: 'Client updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update client.' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-client">
          <Pencil className="w-4 h-4 mr-2" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Client</DialogTitle>
          <DialogDescription>Update the client's core details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label>First Name</Label>
            <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Last Name</Label>
            <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Date of Birth</Label>
            <Input type="date" value={form.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>UCI Number</Label>
            <Input value={form.uciNumber} onChange={(e) => set('uciNumber', e.target.value)} />
          </div>
          <div className="space-y-2 col-span-2">
            <Label>Address</Label>
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Regional Center</Label>
            <Input value={form.regionalCenter} onChange={(e) => set('regionalCenter', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Preferred Language</Label>
            <Input value={form.preferredLanguage} onChange={(e) => set('preferredLanguage', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => set('status', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateClient.isPending} data-testid="button-save-client">
            {updateClient.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
