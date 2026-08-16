import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetVendor, useUpdateVendor, useUpdateVendorContact, useUploadVendorW9 } from '@workspace/api-client-react';
import { FileUpload } from '@/components/file-upload';
import { VendorBusinessProfile } from '@/components/vendor-business-profile';
import { useAuth } from '@/components/auth/auth-provider';
import { InvitePortalDialog } from '@/components/invite-portal-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, FileText, ExternalLink, Power } from 'lucide-react';
import { Link } from 'wouter';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export default function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { data: vendor, isLoading, refetch } = useGetVendor(id, { query: { enabled: !!id, queryKey: ['vendor', id] }});
  const updateVendor = useUpdateVendor();
  const updateVendorContact = useUpdateVendorContact();
  const uploadW9 = useUploadVendorW9();
  const { user } = useAuth();

  // Vendor users can only edit their own contact details; staff-only fields
  // (name, altaVendorNumber, w9Status) are hidden and never sent.
  const isVendorUser = user?.role === 'vendor';
  const isStaff = user?.role === 'staff';

  const [formData, setFormData] = useState<any>({});
  const initialized = useRef(false);

  useEffect(() => {
    if (vendor && !initialized.current) {
      setFormData({
        name: vendor.name,
        altaVendorNumber: vendor.altaVendorNumber || '',
        w9Status: vendor.w9Status,
        contactPerson: vendor.contactPerson || '',
        email: vendor.email || '',
        phone: vendor.phone || '',
        billingAddress: vendor.billingAddress || '',
        serviceAddress: vendor.serviceAddress || '',
        preferred: vendor.preferred,
        active: vendor.active,
      });
      initialized.current = true;
    }
  }, [vendor]);

  if (isLoading) return <div className="p-8 text-center">Loading vendor...</div>;
  if (!vendor) return <div className="p-8 text-center">Vendor not found.</div>;

  const handleChange = (field: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [field]: value }));
  };

  const saving = updateVendor.isPending || updateVendorContact.isPending;

  const handleToggleActive = (nextActive: boolean) => {
    updateVendor.mutate(
      { id, data: { active: nextActive } as any },
      {
        onSuccess: () => {
          toast({ title: nextActive ? 'Vendor Reactivated' : 'Vendor Deactivated' });
          setFormData((prev: any) => ({ ...prev, active: nextActive }));
          refetch();
        },
        onError: () => {
          toast({
            variant: 'destructive',
            title: 'Error',
            description: `Could not ${nextActive ? 'reactivate' : 'deactivate'} this vendor.`,
          });
        },
      },
    );
  };

  const handleSave = () => {
    const onSuccess = () => {
      toast({ title: 'Vendor Updated' });
      refetch();
    };
    if (isVendorUser) {
      updateVendorContact.mutate(
        {
          id,
          data: {
            email: formData.email,
            phone: formData.phone,
            contactPerson: formData.contactPerson,
            billingAddress: formData.billingAddress,
            serviceAddress: formData.serviceAddress,
          },
        },
        { onSuccess },
      );
    } else {
      updateVendor.mutate({ id, data: formData }, { onSuccess });
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/vendors"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Edit Vendor</h1>
        <div className="flex items-center gap-3">
          {formData.preferred && <Badge variant="secondary" className="bg-primary/10 text-primary">Preferred Vendor</Badge>}
          <Badge
            variant="outline"
            className={vendor.active ? 'text-chart-5 border-chart-5/20' : 'bg-muted text-muted-foreground'}
            data-testid="badge-vendor-status"
          >
            {vendor.active ? 'Active' : 'Inactive'}
          </Badge>
          {isStaff && (
            <InvitePortalDialog linkedRecordType="vendor" linkedRecordId={id} recordName={vendor.name} />
          )}
          {isStaff && (
            vendor.active ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" data-testid="button-deactivate-vendor">
                    <Power className="w-4 h-4 mr-2" /> Deactivate
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Deactivate Vendor?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will mark the vendor as inactive and hide it from active vendor lists. You can reactivate it later. Continue?
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.preventDefault();
                        handleToggleActive(false);
                      }}
                      disabled={saving}
                      data-testid="button-confirm-deactivate-vendor"
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {saving ? 'Deactivating…' : 'Deactivate'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleToggleActive(true)}
                disabled={saving}
                data-testid="button-reactivate-vendor"
              >
                <Power className="w-4 h-4 mr-2" /> {saving ? 'Reactivating…' : 'Reactivate'}
              </Button>
            )
          )}
        </div>
      </div>

      {isVendorUser ? (
        <VendorBusinessProfile id={id} contactCardTitle="Vendor Profile" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Vendor Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Business Name</label>
                <Input value={formData.name || ''} onChange={e => handleChange('name', e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Alta Vendor Number</label>
                  <Input value={formData.altaVendorNumber || ''} onChange={e => handleChange('altaVendorNumber', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">W-9 Status</label>
                  <Select value={formData.w9Status} onValueChange={val => handleChange('w9Status', val)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="on_file">On File</SelectItem>
                      <SelectItem value="expired">Expired</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Contact Person</label>
                <Input value={formData.contactPerson || ''} onChange={e => handleChange('contactPerson', e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Email</label>
                  <Input type="email" value={formData.email || ''} onChange={e => handleChange('email', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Phone</label>
                  <Input type="tel" value={formData.phone || ''} onChange={e => handleChange('phone', e.target.value)} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Billing Address</label>
                  <Input value={formData.billingAddress || ''} onChange={e => handleChange('billingAddress', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Service Address</label>
                  <Input value={formData.serviceAddress || ''} onChange={e => handleChange('serviceAddress', e.target.value)} />
                </div>
              </div>

              <div className="pt-4 flex gap-4">
                <Button onClick={handleSave} disabled={saving}>
                  <Save className="w-4 h-4 mr-2" /> Save Changes
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>W-9 Document</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {vendor.w9DocumentUrl ? (
                <div className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <span className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    W-9 on file
                    <Badge variant="secondary" className="capitalize">{vendor.w9Status.replace('_', ' ')}</Badge>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="link-view-w9"
                    onClick={async () => {
                      // Fetch with credentials and open a blob URL: a plain href in
                      // a new top-level tab doesn't carry the partitioned session
                      // cookie, so the request would 401.
                      const res = await fetch(`${import.meta.env.BASE_URL}api/storage${vendor.w9DocumentUrl}`, { credentials: 'include' });
                      if (!res.ok) return;
                      const blobUrl = URL.createObjectURL(await res.blob());
                      window.open(blobUrl, '_blank', 'noopener');
                      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
                    }}
                  >
                    <ExternalLink className="w-4 h-4 mr-1" /> View / Download
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No W-9 uploaded yet.</p>
              )}
              <FileUpload
                accept=".pdf"
                label="Drag & drop the signed W-9 PDF here, or click to browse"
                onUploaded={(r) => {
                  uploadW9.mutate(
                    { id, data: { w9DocumentUrl: r.objectPath } },
                    {
                      onSuccess: () => {
                        toast({ title: 'W-9 Uploaded', description: 'The W-9 is now on file.' });
                        refetch();
                      },
                      onError: () => {
                        toast({ variant: 'destructive', title: 'Error', description: 'Could not attach the W-9.' });
                      },
                    },
                  );
                }}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
