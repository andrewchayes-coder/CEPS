import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertTriangle, Plus, Power, Users } from 'lucide-react';
import {
  getListStaffRolesQueryKey, getListUsersQueryKey, getGetCurrentUserQueryKey,
  useListUsers, useListStaffRoles, useCreateUser, useDeleteUser, useUpdateUser,
  type UserInputRole,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { EditUserDialog } from '@/components/edit-user-dialog';
import { apiErrorMessage } from '@/lib/api-error';
import { useToast } from '@/hooks/use-toast';
import { stableSort, useTableSort } from '@/lib/table-sorting';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead } from '@/components/ui/table';

type Draft = { name: string; email: string; phone: string; role: 'staff' | 'service_coordinator'; staffRoleId: string; password: string };
const emptyDraft: Draft = { name: '', email: '', phone: '', role: 'staff', staffRoleId: '', password: '' };

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const allowed = currentUser?.role === 'staff' && (currentUser.permissions ?? []).includes('manage_users');
  const usersQuery = useListUsers(undefined, { query: { enabled: allowed, queryKey: getListUsersQueryKey() } });
  const rolesQuery = useListStaffRoles({ query: { enabled: allowed, queryKey: getListStaffRolesQueryKey() } });
  const create = useCreateUser();
  const deactivate = useDeleteUser();
  const reactivate = useUpdateUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [deactivateId, setDeactivateId] = useState<string | null>(null);
  const { sort, onSort } = useTableSort<string>('name');
  const users = usersQuery.data ?? [];
  const sortedUsers = stableSort(users, sort, {
    name: (u) => u.name,
    email: (u) => u.email,
    phone: (u) => u.phone,
    role: (u) => u.role === 'staff' ? (u.staffRole?.name ?? '') : 'service coordinator',
    active: (u) => u.active,
    lastLogin: (u) => u.lastLogin ? new Date(u.lastLogin) : null,
  });
  const missingRoles = users.filter((u) => u.active && u.role === 'staff' && !u.staffRole);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListStaffRolesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.email.trim()) { setError('Name and email are required.'); return; }
    if (draft.role === 'staff' && !draft.staffRoleId) { setError('Choose a staff role before creating this user.'); return; }
    if (draft.password && draft.password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setError('');
    create.mutate({ data: {
      name: draft.name.trim(), email: draft.email.trim(), phone: draft.phone.trim() || undefined,
      role: draft.role as UserInputRole, password: draft.password || undefined,
      ...(draft.role === 'staff' ? { staffRoleId: draft.staffRoleId } : {}),
    } }, {
      onSuccess: () => { refresh(); setOpen(false); setDraft(emptyDraft); toast({ title: 'User created' }); },
      onError: (err) => setError(apiErrorMessage(err, 'Could not create user.')),
    });
  };
  const handleDeactivate = (id: string) => {
    setActionError('');
    deactivate.mutate({ id }, {
      onSuccess: () => { refresh(); setDeactivateId(null); toast({ title: 'User deactivated' }); },
      onError: (err) => setActionError(apiErrorMessage(err, 'Could not deactivate this user.')),
    });
  };
  const handleReactivate = (id: string) => {
    setActionError('');
    reactivate.mutate({ id, data: { active: true } }, {
      onSuccess: () => { refresh(); toast({ title: 'User reactivated' }); },
      onError: (err) => setActionError(apiErrorMessage(err, 'Could not reactivate this user.')),
    });
  };

  if (!allowed) return <Card><CardContent className="py-12 text-center text-muted-foreground" data-testid="text-users-forbidden">You don't have permission to manage users and roles. Ask an admin for access.</CardContent></Card>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary"><Users className="h-4 w-4" /> Administration / Access control</div><h1 className="text-3xl font-bold tracking-tight">User Management</h1><p className="mt-1 text-muted-foreground">Manage staff assignments and coordinator access.</p></div>
        <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setError(''); }}>
          <DialogTrigger asChild><Button data-testid="button-add-user"><Plus className="mr-2 h-4 w-4" /> Add user</Button></DialogTrigger>
          <DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Add new user</DialogTitle><DialogDescription>Staff access is determined by the role you assign.</DialogDescription></DialogHeader>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2"><Label htmlFor="new-user-name">Full name</Label><Input id="new-user-name" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="input-create-user-name" /></div>
              <div className="space-y-2"><Label htmlFor="new-user-email">Email</Label><Input id="new-user-email" required type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} data-testid="input-create-user-email" /></div>
              <div className="space-y-2"><Label htmlFor="new-user-phone">Phone <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="new-user-phone" type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} data-testid="input-create-user-phone" /></div>
              <div className="space-y-2"><Label>Account type</Label><Select value={draft.role} onValueChange={(role: Draft['role']) => setDraft({ ...draft, role, staffRoleId: role === 'staff' ? draft.staffRoleId : '' })}><SelectTrigger data-testid="select-create-user-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="staff">Staff</SelectItem><SelectItem value="service_coordinator">Service Coordinator</SelectItem></SelectContent></Select></div>
              {draft.role === 'staff' && <div className="space-y-2"><Label>Staff role <span className="text-destructive">*</span></Label><Select value={draft.staffRoleId} onValueChange={(staffRoleId) => setDraft({ ...draft, staffRoleId })}><SelectTrigger data-testid="select-create-user-staff-role"><SelectValue placeholder={rolesQuery.isLoading ? 'Loading roles…' : 'Choose a role'} /></SelectTrigger><SelectContent>{(rolesQuery.data ?? []).map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Role permissions are configured on the Roles page.</p>{rolesQuery.isError && <p className="text-xs text-destructive">{apiErrorMessage(rolesQuery.error, 'Could not load roles.')} <button type="button" className="underline" onClick={() => void rolesQuery.refetch()}>Retry</button></p>}</div>}
              <div className="space-y-2"><Label htmlFor="new-user-password">Initial password</Label><Input id="new-user-password" type="password" minLength={8} value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} data-testid="input-create-user-password" /></div>
              {error && <p role="alert" className="text-sm text-destructive" data-testid="text-create-user-error">{error}</p>}
              <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={create.isPending || (draft.role === 'staff' && rolesQuery.isLoading)} data-testid="button-submit-user">{create.isPending ? 'Creating…' : 'Create user'}</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {missingRoles.length > 0 && <div className="flex gap-3 rounded-lg border border-chart-2/50 bg-chart-2/10 px-5 py-4 text-sm" role="alert" data-testid="warning-users-without-role"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><strong>{missingRoles.length} active staff {missingRoles.length === 1 ? 'account has' : 'accounts have'} no role.</strong><p className="mt-1 text-muted-foreground">Assign a role to restore access: {missingRoles.map((u) => u.name).join(', ')}.</p></div></div>}
      {actionError && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="text-user-action-error">{actionError}<Button size="sm" variant="ghost" onClick={() => setActionError('')}>Dismiss</Button></div>}
      {usersQuery.isError && <Card><CardContent className="flex items-center justify-between gap-3 py-6"><p role="alert" className="text-destructive">{apiErrorMessage(usersQuery.error, 'Could not load users.')}</p><Button variant="outline" onClick={() => void usersQuery.refetch()} data-testid="button-retry-users">Retry</Button></CardContent></Card>}
      {!usersQuery.isError && <Card className="overflow-hidden"><CardContent className="p-0"><div className="overflow-x-auto"><Table>
        <TableHeader><TableRow>
          <SortableTableHead sortDirection={sort.key === 'name' ? sort.direction : null} onSort={() => onSort('name')}>Name</SortableTableHead>
          <SortableTableHead sortDirection={sort.key === 'email' ? sort.direction : null} onSort={() => onSort('email')}>Email</SortableTableHead>
          <SortableTableHead sortDirection={sort.key === 'phone' ? sort.direction : null} onSort={() => onSort('phone')}>Phone</SortableTableHead>
          <SortableTableHead sortDirection={sort.key === 'role' ? sort.direction : null} onSort={() => onSort('role')}>Role</SortableTableHead>
          <SortableTableHead sortDirection={sort.key === 'active' ? sort.direction : null} onSort={() => onSort('active')}>Status</SortableTableHead>
          <SortableTableHead sortDirection={sort.key === 'lastLogin' ? sort.direction : null} onSort={() => onSort('lastLogin')}>Last login</SortableTableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {usersQuery.isLoading ? [1, 2, 3].map((n) => <TableRow key={n}><TableCell colSpan={7}><Skeleton className="h-8 w-full" /></TableCell></TableRow>) :
            !sortedUsers.length ? <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">No users yet. Add a staff or coordinator account to get started.</TableCell></TableRow> :
            sortedUsers.map((u) => <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
              <TableCell className="font-medium">{u.name}</TableCell><TableCell>{u.email}</TableCell><TableCell className="text-muted-foreground">{u.phone || '—'}</TableCell>
              <TableCell>{u.role === 'staff' ? u.staffRole ? <Badge variant="secondary">{u.staffRole.name}</Badge> : <span className="inline-flex items-center gap-1 text-chart-1"><AlertTriangle className="h-3.5 w-3.5" />Unassigned</span> : <span className="text-sm">Service Coordinator</span>}</TableCell>
              <TableCell><Badge variant="outline" className={u.active ? 'border-chart-5/30 text-chart-5' : 'text-muted-foreground'}>{u.active ? 'Active' : 'Inactive'}</Badge></TableCell>
              <TableCell className="text-sm text-muted-foreground">{u.lastLogin ? format(new Date(u.lastLogin), 'MMM d, yyyy') : 'Never'}</TableCell>
              <TableCell><div className="flex justify-end gap-2">
                <EditUserDialog id={u.id} user={u} roles={rolesQuery.data ?? []} onSaved={refresh} />
                {currentUser?.id !== u.id && (u.active ? <AlertDialog open={deactivateId === u.id} onOpenChange={(value) => { setDeactivateId(value ? u.id : null); setActionError(''); }}><AlertDialogTrigger asChild><Button size="sm" variant="outline" className="text-destructive hover:text-destructive" data-testid={`button-deactivate-user-${u.id}`}><Power className="mr-1.5 h-4 w-4" />Deactivate</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Deactivate {u.name}?</AlertDialogTitle><AlertDialogDescription>This revokes their access. You cannot deactivate the last active user with user-management access.</AlertDialogDescription></AlertDialogHeader>{actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}<AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(e) => { e.preventDefault(); handleDeactivate(u.id); }} disabled={deactivate.isPending} data-testid={`button-confirm-deactivate-user-${u.id}`}>{deactivate.isPending ? 'Deactivating…' : 'Deactivate'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : <Button size="sm" variant="outline" onClick={() => handleReactivate(u.id)} disabled={reactivate.isPending} data-testid={`button-reactivate-user-${u.id}`}><Power className="mr-1.5 h-4 w-4" />Reactivate</Button>)}
              </div></TableCell>
            </TableRow>)
          }
        </TableBody>
      </Table></div></CardContent></Card>}
    </div>
  );
}