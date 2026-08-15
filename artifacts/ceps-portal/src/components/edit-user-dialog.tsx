import React, { useState } from 'react';
import { useUpdateUser, UserUpdateRole } from '@workspace/api-client-react';
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

type UserLike = {
  name: string;
  email: string;
  role: string;
};

type Props = {
  id: string;
  user: UserLike;
  onSaved?: () => void;
};

export function EditUserDialog({ id, user, onSaved }: Props) {
  const { toast } = useToast();
  const updateUser = useUpdateUser();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    role: user.role,
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    updateUser.mutate(
      {
        id,
        data: {
          name: form.name,
          email: form.email,
          role: form.role as UserUpdateRole,
        } as any,
      },
      {
        onSuccess: () => {
          toast({ title: 'User updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: (err: any) =>
          toast({
            variant: 'destructive',
            title: 'Error',
            description: err?.data?.message || 'Could not update user.',
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`button-edit-user-${id}`}>
          <Pencil className="w-4 h-4 mr-2" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>Update the user's name, email, and role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Full Name</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} data-testid="input-edit-user-name" />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} data-testid="input-edit-user-email" />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={form.role} onValueChange={(v) => set('role', v)}>
              <SelectTrigger data-testid="select-edit-user-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">Staff (Full Access)</SelectItem>
                <SelectItem value="service_coordinator">Service Coordinator</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateUser.isPending} data-testid="button-save-user">
            {updateUser.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
