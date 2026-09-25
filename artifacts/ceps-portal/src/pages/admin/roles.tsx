import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  getListStaffRolesQueryKey, getListUsersQueryKey, getGetStaffPermissionsQueryKey, getGetCurrentUserQueryKey,
  useListStaffRoles, useCreateStaffRole, useUpdateStaffRole, useDeleteStaffRole,
  useGetStaffPermissions, type StaffRole, type StaffRoleInputPermissionsItem,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, LockKeyhole, Pencil, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';

type Draft = { name: string; description: string; permissions: StaffRoleInputPermissionsItem[] };
const blank: Draft = { name: '', description: '', permissions: [] };

export default function RolesPage() {
  const { user } = useAuth();
  const allowed = user?.role === 'staff' && (user.permissions ?? []).includes('manage_users');
  const rolesQuery = useListStaffRoles({ query: { enabled: allowed, queryKey: getListStaffRolesQueryKey() } });
  const catalogQuery = useGetStaffPermissions({ query: { enabled: allowed, queryKey: getGetStaffPermissionsQueryKey() } });
  const create = useCreateStaffRole();
  const update = useUpdateStaffRole();
  const remove = useDeleteStaffRole();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<StaffRole | 'new' | null>(null);
  const [deleting, setDeleting] = useState<StaffRole | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState('');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getListStaffRolesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
  };
  const openEditor = (role: StaffRole | 'new') => {
    setEditing(role);
    setDraft(role === 'new' ? { ...blank } : { name: role.name, description: role.description ?? '', permissions: [...role.permissions] });
    setError('');
  };
  const save = () => {
    if (!editing) return;
    const name = draft.name.trim();
    if (!name) { setError('A role name is required.'); return; }
    setError('');
    const data = { name, description: draft.description.trim() || null, permissions: draft.permissions };
    const options = {
      onSuccess: () => { refresh(); setEditing(null); toast({ title: editing === 'new' ? 'Role created' : 'Role updated' }); },
      onError: (err: unknown) => setError(apiErrorMessage(err, 'Could not save this role.')),
    };
    if (editing === 'new') create.mutate({ data }, options);
    else update.mutate({ id: editing.id, data: editing.isSystem ? { description: data.description } : data }, options);
  };
  const deleteRole = () => {
    if (!deleting || deleting.isSystem || deleting.activeUserCount > 0) return;
    remove.mutate({ id: deleting.id }, {
      onSuccess: () => { refresh(); setDeleting(null); toast({ title: 'Role deleted' }); },
      onError: (err) => setError(apiErrorMessage(err, 'Could not delete this role.')),
    });
  };

  if (!allowed) return <Card><CardContent className="py-12 text-center text-muted-foreground" data-testid="text-roles-forbidden">You don't have permission to manage users and roles. Ask an admin for access.</CardContent></Card>;

  const catalog = catalogQuery.data ?? [];
  const pending = create.isPending || update.isPending;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary"><ShieldCheck className="h-4 w-4" /> Administration / Access control</div>
          <h1 className="text-3xl font-bold tracking-tight">Staff Roles</h1>
          <p className="mt-1 text-muted-foreground">Define what staff can do, then assign a role to each person.</p>
        </div>
        <Button onClick={() => openEditor('new')} data-testid="button-add-role"><Plus className="mr-2 h-4 w-4" /> New role</Button>
      </div>

      <div className="flex flex-wrap gap-3 rounded-lg border border-primary/20 bg-primary/5 px-5 py-4 text-sm">
        <LockKeyhole className="h-4 w-4 shrink-0 text-primary" />
        <span><strong>Access follows the role.</strong> Changes to a role's permissions affect everyone assigned to it. The system Admin role retains full access.</span>
      </div>

      {(rolesQuery.isError || catalogQuery.isError) && (
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 py-6">
          <p className="text-destructive" data-testid="text-roles-error">{apiErrorMessage(rolesQuery.error ?? catalogQuery.error, 'Could not load roles and permissions.')}</p>
          <Button variant="outline" onClick={() => { void rolesQuery.refetch(); void catalogQuery.refetch(); }} data-testid="button-retry-roles">Retry</Button>
        </CardContent></Card>
      )}
      {!rolesQuery.isError && !catalogQuery.isError && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div><h2 className="font-semibold">Role directory</h2><p className="text-xs text-muted-foreground">Active staff assignments are shown for each role.</p></div>
              <Badge variant="secondary" data-testid="text-role-count">{rolesQuery.data?.length ?? 0} roles</Badge>
            </div>
            {rolesQuery.isLoading || catalogQuery.isLoading ? (
              <div className="space-y-3 p-5" data-testid="loading-roles">{[1, 2, 3].map((n) => <Skeleton key={n} className="h-16 w-full" />)}</div>
            ) : !rolesQuery.data?.length ? (
              <div className="py-16 text-center"><ShieldCheck className="mx-auto mb-3 h-9 w-9 text-primary/50" /><p className="font-medium">No roles yet</p><p className="mt-1 text-sm text-muted-foreground">Create a role to organize staff access.</p><Button variant="outline" className="mt-4" onClick={() => openEditor('new')}>Create a role</Button></div>
            ) : (
              <div className="overflow-x-auto"><Table>
                <TableHeader><TableRow><TableHead className="min-w-36">Role</TableHead><TableHead className="min-w-48">Description</TableHead><TableHead className="min-w-64">Permissions</TableHead><TableHead className="whitespace-nowrap">Active users</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                <TableBody>{rolesQuery.data.map((role) => (
                  <TableRow key={role.id} data-testid={`row-role-${role.id}`}>
                    <TableCell className="font-semibold"><div className="flex flex-wrap items-center gap-2">{role.name}{role.isSystem && <Badge variant="outline" className="gap-1 text-primary"><LockKeyhole className="h-3 w-3" />System</Badge>}</div></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{role.description || '—'}</TableCell>
                    <TableCell><div className="flex flex-wrap gap-1.5">{role.permissions.length ? role.permissions.map((permission) => <Badge key={permission} variant="secondary" className="whitespace-nowrap font-normal">{catalog.find((item) => item.permission === permission)?.label ?? permission}</Badge>) : <span className="text-sm text-muted-foreground">No permissions</span>}</div></TableCell>
                    <TableCell><span className="inline-flex items-center gap-1.5 tabular-nums"><Users className="h-4 w-4 text-muted-foreground" />{role.activeUserCount}</span></TableCell>
                    <TableCell><div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEditor(role)} data-testid={`button-edit-role-${role.id}`}><Pencil className="mr-1.5 h-3.5 w-3.5" />Edit</Button>
                      {!role.isSystem && <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => { setError(''); setDeleting(role); }} data-testid={`button-delete-role-${role.id}`}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete</Button>}
                    </div></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table></div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{editing === 'new' ? 'Create a staff role' : `Edit ${editing?.name ?? 'role'}`}</DialogTitle><DialogDescription>Choose a clear name and the access this role grants to staff.</DialogDescription></DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); save(); }} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="role-name">Role name</Label><Input id="role-name" value={draft.name} maxLength={100} disabled={editing !== 'new' && !!editing?.isSystem} onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))} data-testid="input-role-name" /></div>
              <div className="space-y-2"><Label htmlFor="role-description">Description</Label><Input id="role-description" value={draft.description} onChange={(event) => setDraft((d) => ({ ...d, description: event.target.value }))} placeholder="What is this role for?" data-testid="input-role-description" /></div>
            </div>
            <div><div className="mb-3 flex items-center justify-between"><div><Label>Permissions</Label><p className="mt-0.5 text-xs text-muted-foreground">Access granted to every person with this role.</p></div><Badge variant="outline">{draft.permissions.length} selected</Badge></div>
              {editing !== 'new' && editing?.isSystem && <p className="mb-3 flex gap-2 rounded-md bg-primary/5 p-3 text-sm text-muted-foreground"><LockKeyhole className="h-4 w-4 shrink-0 text-primary" />Admin permissions are protected and cannot be changed.</p>}
              <div className="grid gap-2 sm:grid-cols-2">{catalog.map((item) => (
                <label key={item.permission} className={`flex items-start gap-3 rounded-lg border p-3.5 transition-colors ${draft.permissions.includes(item.permission) ? 'border-primary/40 bg-primary/5' : 'border-border'} ${editing !== 'new' && editing?.isSystem ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary/40'}`}>
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={draft.permissions.includes(item.permission)} disabled={editing !== 'new' && !!editing?.isSystem} onChange={(event) => setDraft((d) => ({ ...d, permissions: event.target.checked ? [...d.permissions, item.permission] : d.permissions.filter((p) => p !== item.permission) }))} data-testid={`checkbox-role-permission-${item.permission}`} />
                  <span><span className="block text-sm font-medium">{item.label}</span><span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{item.description}</span></span>
                </label>
              ))}</div>
              {!catalog.length && <p className="mt-2 text-sm text-destructive">Permission catalog unavailable. Retry loading before saving.</p>}
            </div>
            {error && <p role="alert" className="text-sm text-destructive" data-testid="text-role-save-error">{error}</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" disabled={pending || !catalog.length} data-testid="button-save-role">{pending ? 'Saving…' : editing === 'new' ? 'Create role' : 'Save changes'}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {deleting && <AlertDialog open onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle><AlertDialogDescription>{deleting?.activeUserCount ? `${deleting.activeUserCount} active ${deleting.activeUserCount === 1 ? 'user is' : 'users are'} assigned to this role. Reassign them in Users before deleting it.` : 'This role will no longer be available for staff assignment. This cannot be undone.'}</AlertDialogDescription></AlertDialogHeader>
          {deleting?.activeUserCount ? <div className="flex items-start gap-2 rounded-md border border-chart-2/40 bg-chart-2/10 p-3 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>Reassign all active users before deleting this role. <Link href="/admin/users" className="font-semibold text-primary underline" data-testid="link-reassign-users">Go to Users</Link></span></div> : null}
          {error && <p role="alert" className="text-sm text-destructive" data-testid="text-role-delete-error">{error}</p>}
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={(event) => { event.preventDefault(); deleteRole(); }} disabled={remove.isPending || !!deleting?.activeUserCount} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete-role">{remove.isPending ? 'Deleting…' : 'Delete role'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
    </div>
  );
}