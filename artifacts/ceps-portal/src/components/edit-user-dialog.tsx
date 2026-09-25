import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { getListStaffRolesQueryKey, getListUsersQueryKey, getGetCurrentUserQueryKey, useUpdateUser, type StaffRole, type User, type UserUpdateRole } from '@workspace/api-client-react';
import { apiErrorMessage } from '@/lib/api-error';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Props = { id: string; user: User; roles: StaffRole[]; onSaved?: () => void };
type Draft = { name: string; email: string; phone: string; role: 'staff' | 'service_coordinator'; staffRoleId: string };

export function EditUserDialog({ id, user, roles, onSaved }: Props) {
  const initial = (): Draft => ({
    name: user.name, email: user.email, phone: user.phone ?? '',
    role: user.role === 'staff' ? 'staff' : 'service_coordinator',
    staffRoleId: user.staffRole?.id ?? '',
  });
  const { toast } = useToast();
  const update = useUpdateUser();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Draft>(initial);
  const [error, setError] = useState('');
  const changeOpen = (value: boolean) => { setOpen(value); if (value) setForm(initial()); setError(''); };
  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim() || !form.email.trim()) { setError('Name and email are required.'); return; }
    if (form.role === 'staff' && !form.staffRoleId) { setError('Choose a staff role before saving.'); return; }
    setError('');
    update.mutate({ id, data: {
      name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim(),
      role: form.role as UserUpdateRole,
      ...(form.role === 'staff' ? { staffRoleId: form.staffRoleId } : {}),
    } }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListStaffRolesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        toast({ title: 'User updated' }); setOpen(false); onSaved?.();
      },
      onError: (err) => setError(apiErrorMessage(err, 'Could not update user.')),
    });
  };
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button variant="outline" size="sm" data-testid={`button-edit-user-${id}`}><Pencil className="mr-1.5 h-4 w-4" />Edit</Button></DialogTrigger>
    <DialogContent className="max-w-md"><DialogHeader><DialogTitle>Edit user</DialogTitle><DialogDescription>Update account details and staff access.</DialogDescription></DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <div className="space-y-2"><Label htmlFor={`edit-name-${id}`}>Full name</Label><Input id={`edit-name-${id}`} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-edit-user-name" /></div>
        <div className="space-y-2"><Label htmlFor={`edit-email-${id}`}>Email</Label><Input id={`edit-email-${id}`} required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="input-edit-user-email" /></div>
        <div className="space-y-2"><Label htmlFor={`edit-phone-${id}`}>Phone</Label><Input id={`edit-phone-${id}`} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} data-testid="input-edit-user-phone" /></div>
        <div className="space-y-2"><Label>Account type</Label><Select value={form.role} onValueChange={(role: Draft['role']) => setForm({ ...form, role, staffRoleId: role === 'staff' ? form.staffRoleId : '' })}><SelectTrigger data-testid="select-edit-user-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="staff">Staff</SelectItem><SelectItem value="service_coordinator">Service Coordinator</SelectItem></SelectContent></Select></div>
        {form.role === 'staff' && <div className="space-y-2"><Label>Staff role <span className="text-destructive">*</span></Label><Select value={form.staffRoleId} onValueChange={(staffRoleId) => setForm({ ...form, staffRoleId })}><SelectTrigger data-testid="select-edit-user-staff-role"><SelectValue placeholder="Choose a role" /></SelectTrigger><SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Changing this role changes the user's permissions immediately.</p></div>}
        {error && <p role="alert" className="text-sm text-destructive" data-testid="text-edit-user-error">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button><Button type="submit" disabled={update.isPending} data-testid="button-save-user">{update.isPending ? 'Saving…' : 'Save changes'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}