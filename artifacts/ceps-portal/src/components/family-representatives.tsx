import React, { useState } from 'react';
import {
  useCreateFamilyRepresentative,
  useUpdateFamilyRepresentative,
  useDeleteFamilyRepresentative,
  getListFamilyRepresentativesQueryKey,
  type FamilyRepresentative,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { User, Pencil, Plus, Trash2, Mail, Phone, MapPin } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { InvitePortalDialog } from '@/components/invite-portal-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function ManageFamilyRepDialog({
  clientId,
  rep,
  onClose,
}: {
  clientId: string;
  rep?: FamilyRepresentative;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: rep?.name || '',
    relationship: rep?.relationship || 'parent',
    phone: rep?.phone || '',
    email: rep?.email || '',
    address: rep?.address || '',
    isPrimary: rep?.isPrimary || false,
  });

  const set = (k: string, v: any) => setForm((p) => ({ ...p, [k]: v }));
  const createRep = useCreateFamilyRepresentative();
  const updateRep = useUpdateFamilyRepresentative();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleOpenChange = (o: boolean) => {
    if (o && rep) {
      setForm({
        name: rep.name,
        relationship: rep.relationship || 'parent',
        phone: rep.phone || '',
        email: rep.email || '',
        address: rep.address || '',
        isPrimary: rep.isPrimary,
      });
    }
    setOpen(o);
    if (!o) {
      if (onClose) onClose();
      if (!rep) setForm({ name: '', relationship: 'parent', phone: '', email: '', address: '', isPrimary: false });
    }
  };

  const handleSave = () => {
    if (rep) {
      updateRep.mutate(
        { id: rep.id, data: form as any },
        {
          onSuccess: () => {
            toast({ title: 'Family representative updated' });
            queryClient.invalidateQueries({ queryKey: getListFamilyRepresentativesQueryKey({ clientId }) });
            handleOpenChange(false);
          },
          onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update representative.' }),
        }
      );
    } else {
      createRep.mutate(
        { data: { ...form, clientId } as any },
        {
          onSuccess: () => {
            toast({ title: 'Family representative added' });
            queryClient.invalidateQueries({ queryKey: getListFamilyRepresentativesQueryKey({ clientId }) });
            handleOpenChange(false);
          },
          onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not add representative.' }),
        }
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {rep ? (
          <Button variant="ghost" size="sm" className="h-8 px-2" data-testid={`button-edit-rep-${rep.id}`}>
            <Pencil className="w-4 h-4 mr-2" /> Edit
          </Button>
        ) : (
          <Button variant="outline" size="sm" data-testid="button-add-family-rep">
            <Plus className="w-4 h-4 mr-2" /> Add Representative
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rep ? 'Edit Family Representative' : 'Add Family Representative'}</DialogTitle>
          <DialogDescription>
            {rep ? 'Update the details for this family representative.' : 'Add a new family representative to this participant\'s case.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} data-testid="input-rep-name" />
          </div>
          <div className="space-y-2">
            <Label>Relationship</Label>
            <Select value={form.relationship || ''} onValueChange={(v) => set('relationship', v)}>
              <SelectTrigger data-testid="select-rep-relationship">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="parent">Parent</SelectItem>
                <SelectItem value="guardian">Guardian</SelectItem>
                <SelectItem value="conservator">Conservator</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} data-testid="input-rep-phone" />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} data-testid="input-rep-email" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Address</Label>
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} data-testid="input-rep-address" />
          </div>
          <div className="flex items-center space-x-2 pt-2">
            <Checkbox
              id={`primary-${rep?.id || 'new'}`}
              checked={form.isPrimary}
              onCheckedChange={(c) => set('isPrimary', !!c)}
              data-testid="checkbox-rep-primary"
            />
            <Label htmlFor={`primary-${rep?.id || 'new'}`} className="font-normal cursor-pointer">
              Set as primary contact
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createRep.isPending || updateRep.isPending || !form.name.trim()} data-testid="button-save-rep">
            {rep ? (updateRep.isPending ? 'Saving…' : 'Save Changes') : (createRep.isPending ? 'Adding…' : 'Add Representative')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveFamilyRepDialog({ clientId, rep }: { clientId: string; rep: FamilyRepresentative }) {
  const [open, setOpen] = useState(false);
  const deleteRep = useDeleteFamilyRepresentative();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleRemove = () => {
    deleteRep.mutate(
      { id: rep.id },
      {
        onSuccess: () => {
          toast({ title: 'Representative removed' });
          queryClient.invalidateQueries({ queryKey: getListFamilyRepresentativesQueryKey({ clientId }) });
          setOpen(false);
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not remove representative.' }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10" data-testid={`button-remove-rep-${rep.id}`}>
          <Trash2 className="w-4 h-4 mr-2" /> Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove Family Representative?</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove <strong>{rep.name}</strong> from this participant's case?
            If this representative has portal access, it will be revoked immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="destructive" onClick={handleRemove} disabled={deleteRep.isPending} data-testid="button-confirm-remove-rep">
            {deleteRep.isPending ? 'Removing…' : 'Yes, Remove Representative'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditMyFamilyRepInfoDialog({ clientId, rep }: { clientId: string; rep: FamilyRepresentative }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: rep.name,
    phone: rep.phone || '',
    email: rep.email || '',
    address: rep.address || '',
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const updateRep = useUpdateFamilyRepresentative();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setForm({ name: rep.name, phone: rep.phone || '', email: rep.email || '', address: rep.address || '' });
    setOpen(nextOpen);
  };

  const handleSave = () => {
    updateRep.mutate(
      { id: rep.id, data: form as any },
      {
        onSuccess: () => {
          toast({ title: 'Contact info updated' });
          queryClient.invalidateQueries({ queryKey: getListFamilyRepresentativesQueryKey({ clientId }) });
          setOpen(false);
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update contact info.' }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`button-edit-my-info-${rep.id}`}>
          <Pencil className="w-4 h-4 mr-2" /> Edit My Info
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit My Info</DialogTitle>
          <DialogDescription>
            Update your name and contact details for this participant's case.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2 col-span-2">
            <Label>Your Name</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} data-testid="input-my-info-name" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Your Phone</Label>
              <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} data-testid="input-my-info-phone" />
            </div>
            <div className="space-y-2">
              <Label>Your Email</Label>
              <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} data-testid="input-my-info-email" />
            </div>
          </div>
          <div className="space-y-2 col-span-2">
            <Label>Your Address</Label>
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} data-testid="input-my-info-address" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateRep.isPending || !form.name.trim()} data-testid="button-save-my-info">
            {updateRep.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RepresentativeEditAction({ clientId, rep }: { clientId: string; rep: FamilyRepresentative }) {
  const { user } = useAuth();
  if (user?.role === 'staff') return <ManageFamilyRepDialog clientId={clientId} rep={rep} />;
  if ((user?.role === 'parent_guardian' || user?.role === 'self') && rep.userId === user.id) {
    return <EditMyFamilyRepInfoDialog clientId={clientId} rep={rep} />;
  }
  return null;
}

export function FamilyRepresentativesSection({
  clientId,
  representatives,
  isLoading = false,
  isError = false,
  onRetry,
  primaryDisplayed = false,
}: {
  clientId: string;
  representatives: FamilyRepresentative[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  primaryDisplayed?: boolean;
}) {
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const queryClient = useQueryClient();

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-medium text-primary flex items-center gap-2">
          <User className="w-4 h-4" /> Family Representatives
        </p>
        {isStaff && <ManageFamilyRepDialog clientId={clientId} />}
      </div>
      
      {isLoading ? (
        <div className="space-y-2 animate-pulse" aria-label="Loading representatives"><div className="h-4 w-2/3 rounded bg-muted" /><div className="h-4 w-1/2 rounded bg-muted" /></div>
      ) : isError ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>Representatives could not be loaded.</span>
          {onRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="button-retry-representatives">Retry</Button>}
        </div>
      ) : representatives.length === 0 ? (
        <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-md bg-muted/20 text-center">
          {primaryDisplayed ? 'The primary representative is shown in Contact Information.' : 'No family representatives added.'}
        </div>
      ) : (
        <div className="space-y-3">
          {representatives.map((rep) => {
            return (
              <div key={rep.id} className="min-w-0 space-y-3 rounded-md border bg-card p-3 shadow-sm sm:p-4" data-testid={`rep-row-${rep.id}`}>
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words font-semibold text-foreground">{rep.name}</span>
                    <Badge variant="outline" className="capitalize text-xs font-normal">
                      {rep.relationship || 'unknown'}
                    </Badge>
                    {rep.isPrimary && (
                      <Badge variant="secondary" className="text-xs font-normal bg-primary/10 text-primary">
                        Primary
                      </Badge>
                    )}
                    <Badge 
                      variant={rep.portalAccountStatus === 'active' ? 'default' : 'secondary'} 
                       className={`text-[10px] font-medium ${
                        rep.portalAccountStatus === 'active' 
                          ? 'bg-chart-5 text-white hover:bg-chart-5/90' 
                          : rep.portalAccountStatus === 'invited'
                            ? 'bg-chart-4/20 text-chart-4 border-chart-4/30'
                            : 'opacity-70'
                      }`}
                    >
                      {rep.portalAccountStatus === 'active' 
                        ? 'Active' 
                        : rep.portalAccountStatus === 'invited' 
                          ? 'Invite sent' 
                          : 'No portal access'}
                    </Badge>
                  </div>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <div className="flex min-w-0 items-start gap-2" data-testid={`rep-phone-${rep.id}`}><Phone className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-words">Phone: {rep.phone || '-'}</span></div>
                    <div className="flex min-w-0 items-start gap-2" data-testid={`rep-email-${rep.id}`}><Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-all">Email: {rep.email || '-'}</span></div>
                    <div className="flex min-w-0 items-start gap-2" data-testid={`rep-address-${rep.id}`}><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-words">Address: {rep.address || '-'}</span></div>
                  </div>
                </div>
                
                <div className="flex min-w-0 flex-wrap items-center gap-2 border-t pt-2" data-testid={`rep-actions-${rep.id}`}>
                  {isStaff && rep.portalAccountStatus === 'none' && (
                    <InvitePortalDialog 
                      linkedRecordType="client" 
                      linkedRecordId={clientId} 
                      recordName={rep.name} 
                      familyRepresentativeId={rep.id}
                      defaultEmail={rep.email || ''}
                      defaultName={rep.name}
                      onSuccess={() => queryClient.invalidateQueries({ queryKey: getListFamilyRepresentativesQueryKey({ clientId }) })}
                    />
                  )}
                  {isStaff && (
                    <>
                      <RepresentativeEditAction clientId={clientId} rep={rep} />
                      <RemoveFamilyRepDialog clientId={clientId} rep={rep} />
                    </>
                  )}
                  {!isStaff && <RepresentativeEditAction clientId={clientId} rep={rep} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
