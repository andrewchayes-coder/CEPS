import React, { useState, useEffect, useRef } from 'react';
import { useGetVendor, useUpdateVendorContact, useUploadVendorW9 } from '@workspace/api-client-react';
import { FileUpload } from '@/components/file-upload';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Save, FileText, ExternalLink } from 'lucide-react';

interface ContactFormData {
  contactPerson: string;
  email: string;
  phone: string;
  billingAddress: string;
  serviceAddress: string;
}

interface VendorBusinessProfileProps {
  /** Vendor id to edit. */
  id: string;
  /** Optional heading for the contact card. Defaults to "Vendor Profile". */
  contactCardTitle?: string;
}

/**
 * Vendor self-editable section: contact fields + W-9 upload/replace.
 * Shared between the staff-facing vendor detail page (vendor-user branch) and
 * the vendor's own account page. Reuses useUpdateVendorContact / useUploadVendorW9.
 */
export function VendorBusinessProfile({ id, contactCardTitle = 'Vendor Profile' }: VendorBusinessProfileProps) {
  const { toast } = useToast();
  const { data: vendor, isLoading, refetch } = useGetVendor(id, { query: { enabled: !!id, queryKey: ['vendor', id] } });
  const updateVendorContact = useUpdateVendorContact();
  const uploadW9 = useUploadVendorW9();

  const [formData, setFormData] = useState<ContactFormData>({
    contactPerson: '',
    email: '',
    phone: '',
    billingAddress: '',
    serviceAddress: '',
  });
  const initialized = useRef(false);

  useEffect(() => {
    if (vendor && !initialized.current) {
      setFormData({
        contactPerson: vendor.contactPerson || '',
        email: vendor.email || '',
        phone: vendor.phone || '',
        billingAddress: vendor.billingAddress || '',
        serviceAddress: vendor.serviceAddress || '',
      });
      initialized.current = true;
    }
  }, [vendor]);

  if (isLoading) return <div className="p-8 text-center" data-testid="vendor-business-profile-loading">Loading business profile...</div>;
  if (!vendor) return <div className="p-8 text-center" data-testid="vendor-business-profile-empty">Vendor not found.</div>;

  const handleChange = (field: keyof ContactFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const saving = updateVendorContact.isPending;

  const handleSave = () => {
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
      {
        onSuccess: () => {
          toast({ title: 'Vendor Updated' });
          refetch();
        },
        onError: () => {
          toast({ variant: 'destructive', title: 'Error', description: 'Could not save your changes.' });
        },
      },
    );
  };

  return (
    <div className="space-y-6" data-testid="vendor-business-profile">
      <Card>
        <CardHeader>
          <CardTitle>{contactCardTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Contact Person</label>
            <Input
              data-testid="input-vendor-contact-person"
              value={formData.contactPerson}
              onChange={e => handleChange('contactPerson', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Email</label>
              <Input
                type="email"
                data-testid="input-vendor-email"
                value={formData.email}
                onChange={e => handleChange('email', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Phone</label>
              <Input
                type="tel"
                data-testid="input-vendor-phone"
                value={formData.phone}
                onChange={e => handleChange('phone', e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Billing Address</label>
              <Input
                data-testid="input-vendor-billing-address"
                value={formData.billingAddress}
                onChange={e => handleChange('billingAddress', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Service Address</label>
              <Input
                data-testid="input-vendor-service-address"
                value={formData.serviceAddress}
                onChange={e => handleChange('serviceAddress', e.target.value)}
              />
            </div>
          </div>

          <div className="pt-4 flex gap-4">
            <Button onClick={handleSave} disabled={saving} data-testid="button-save-vendor-contact">
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
    </div>
  );
}
