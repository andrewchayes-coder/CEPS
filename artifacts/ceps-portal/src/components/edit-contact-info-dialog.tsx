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
import { useToast } from '@/hooks/use-toast';
import { Pencil } from 'lucide-react';

type ClientContactLike = {
  firstName: string;
  lastName: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  preferredLanguage?: string | null;
  familyRepName?: string | null;
  familyRepPhone?: string | null;
  familyRepEmail?: string | null;
  familyRepAddress?: string | null;
};

type Props = {
  id: string;
  client: ClientContactLike;
  /** parent_guardian sees "your child"; self sees "your" wording. */
  isGuardian: boolean;
  onSaved?: () => void;
};

/**
 * Family-facing edit dialog: lets a parent/guardian or self-advocate fix
 * name spelling and contact info for the client and for themselves (family
 * representative). Case-management fields are intentionally absent — the API
 * rejects them for these roles.
 */
export function EditContactInfoDialog({ id, client, isGuardian, onSaved }: Props) {
  const { toast } = useToast();
  const updateClient = useUpdateClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    firstName: client.firstName,
    lastName: client.lastName,
    address: client.address ?? '',
    phone: client.phone ?? '',
    email: client.email ?? '',
    preferredLanguage: client.preferredLanguage ?? '',
    familyRepName: client.familyRepName ?? '',
    familyRepPhone: client.familyRepPhone ?? '',
    familyRepEmail: client.familyRepEmail ?? '',
    familyRepAddress: client.familyRepAddress ?? '',
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const initial = {
    firstName: client.firstName,
    lastName: client.lastName,
    address: client.address ?? '',
    phone: client.phone ?? '',
    email: client.email ?? '',
    preferredLanguage: client.preferredLanguage ?? '',
    familyRepName: client.familyRepName ?? '',
    familyRepPhone: client.familyRepPhone ?? '',
    familyRepEmail: client.familyRepEmail ?? '',
    familyRepAddress: client.familyRepAddress ?? '',
  };

  const handleSave = () => {
    // Send only the fields the user actually changed — untouched optional
    // fields must not be written back (null would become '').
    const changed = Object.fromEntries(
      Object.entries(form).filter(([k, v]) => v !== initial[k as keyof typeof initial]),
    );
    if (Object.keys(changed).length === 0) {
      setOpen(false);
      return;
    }
    updateClient.mutate(
      { id, data: changed as any },
      {
        onSuccess: () => {
          toast({ title: 'Contact info updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () =>
          toast({ variant: 'destructive', title: 'Error', description: 'Could not update contact info.' }),
      },
    );
  };

  const clientLabel = isGuardian ? "Your child's information" : 'Your information';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-contact-info">
          <Pencil className="w-4 h-4 mr-2" /> Edit Contact Info
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Contact Info</DialogTitle>
          <DialogDescription>
            Update name spelling and contact details. Other case details are managed by CEPS staff.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <p className="text-sm font-medium mb-3">{clientLabel}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>First Name</Label>
                <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} data-testid="input-first-name" />
              </div>
              <div className="space-y-2">
                <Label>Last Name</Label>
                <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} data-testid="input-last-name" />
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
              <div className="space-y-2 col-span-2">
                <Label>Preferred Language</Label>
                <Input value={form.preferredLanguage} onChange={(e) => set('preferredLanguage', e.target.value)} />
              </div>
            </div>
          </div>
          {isGuardian && (
            <div>
              <p className="text-sm font-medium mb-3">Your information (family representative)</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2 col-span-2">
                  <Label>Your Name</Label>
                  <Input value={form.familyRepName} onChange={(e) => set('familyRepName', e.target.value)} data-testid="input-family-rep-name" />
                </div>
                <div className="space-y-2">
                  <Label>Your Phone</Label>
                  <Input value={form.familyRepPhone} onChange={(e) => set('familyRepPhone', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Your Email</Label>
                  <Input type="email" value={form.familyRepEmail} onChange={(e) => set('familyRepEmail', e.target.value)} />
                </div>
                <div className="space-y-2 col-span-2">
                  <Label>Your Address</Label>
                  <Input value={form.familyRepAddress} onChange={(e) => set('familyRepAddress', e.target.value)} />
                </div>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateClient.isPending} data-testid="button-save-contact-info">
            {updateClient.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
