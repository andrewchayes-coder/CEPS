import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetVendor, useUpdateVendor, useUpdateVendorContact, useUploadVendorW9 } from '@workspace/api-client-react';
import { FileUpload } from '@/components/file-upload';
import { useAuth } from '@/components/auth/auth-provider';
import { InvitePortalDialog } from '@/components/invite-portal-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, FileText, ExternalLink } from 'lucide-react';
import { Link } from 'wouter';

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
          {isStaff && (
            <InvitePortalDialog linkedRecordType="vendor" linkedRecordId={id} recordName={vendor.name} />
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Vendor Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isVendorUser && (
            <>
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
            </>
          )}

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
              <Button variant="outline" size="sm" asChild data-testid="link-view-w9">
                <a
                  href={`${import.meta.env.BASE_URL}api/storage${vendor.w9DocumentUrl}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="w-4 h-4 mr-1" /> View / Download
                </a>
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No W-9 uploaded yet.</p>
          )}
          {(user?.role === 'staff' || user?.role === 'vendor') && (
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
