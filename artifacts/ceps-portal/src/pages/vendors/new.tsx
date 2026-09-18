import React, { useState } from 'react';
import { useCreateVendor } from '@workspace/api-client-react';
import { Link, Redirect, useLocation } from 'wouter';
import { ArrowLeft, Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/components/auth/auth-provider';
import { useToast } from '@/hooks/use-toast';
import { trackAnalyticsEvent } from '@/lib/analytics';

type VendorForm = {
  name: string; ein: string; contactPerson: string;
  email: string; phone: string; billingAddress: string; serviceAddress: string;
  w9Status: 'pending' | 'on_file' | 'expired'; preferred: boolean;
};
const initialForm: VendorForm = {
  name: '', ein: '', contactPerson: '', email: '', phone: '',
  billingAddress: '', serviceAddress: '', w9Status: 'pending', preferred: false,
};
function errorMessage(error: unknown): string {
  const item = error as {
    data?: { error?: unknown; message?: unknown };
    response?: { data?: { error?: unknown; message?: unknown } };
    message?: unknown;
  };
  const payload = item?.data ?? item?.response?.data;
  if (typeof payload?.error === 'string') return payload.error;
  if (typeof payload?.message === 'string') return payload.message;
  return typeof item?.message === 'string' ? item.message : 'Could not create vendor. Please try again.';
}

export default function VendorNewPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const createVendor = useCreateVendor();
  const [form, setForm] = useState<VendorForm>(initialForm);
  const [error, setError] = useState('');
  if (user?.role !== 'staff') return <Redirect to="/vendors" replace />;
  const set = <K extends keyof VendorForm>(key: K, value: VendorForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      const message = 'Business name is required.';
      setError(message);
      toast({ variant: 'destructive', title: 'Unable to create vendor', description: message });
      return;
    }
    setError('');
    createVendor.mutate({ data: { ...form, name: form.name.trim() } }, {
      onSuccess: (vendor) => {
        trackAnalyticsEvent('vendor_created', { w9_status: form.w9Status, preferred: form.preferred, active: true });
        toast({ title: 'Vendor created' });
        navigate(`/vendors/${vendor.id}`);
      },
      onError: (cause) => {
        const message = errorMessage(cause);
        setError(message);
        toast({ variant: 'destructive', title: 'Unable to create vendor', description: message });
      },
    });
  };
  return <div className="max-w-2xl mx-auto space-y-6">
    <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground"><Link href="/vendors"><ArrowLeft className="w-4 h-4 mr-2" />Back</Link></Button>
    <Card>
      <CardHeader><CardTitle>Add Vendor</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" data-testid="form-create-vendor">
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-create-vendor">{error}</p>}
          <Field label="Business Name" required value={form.name} onChange={(v) => set('name', v)} testId="input-vendor-name" />
          <Field label="EIN" value={form.ein} onChange={(v) => set('ein', v)} />
          <Field label="Contact Person" value={form.contactPerson} onChange={(v) => set('contactPerson', v)} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} />
            <Field label="Phone" type="tel" value={form.phone} onChange={(v) => set('phone', v)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Billing Address" value={form.billingAddress} onChange={(v) => set('billingAddress', v)} />
            <Field label="Service Address" value={form.serviceAddress} onChange={(v) => set('serviceAddress', v)} />
          </div>
          <div className="space-y-2"><Label>W-9 Status</Label><Select value={form.w9Status} onValueChange={(v) => set('w9Status', v as VendorForm['w9Status'])}><SelectTrigger data-testid="select-vendor-w9-status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pending">Pending</SelectItem><SelectItem value="on_file">On File</SelectItem><SelectItem value="expired">Expired</SelectItem></SelectContent></Select></div>
          <div className="flex items-center justify-between rounded-md border p-3"><div><Label htmlFor="switch-vendor-preferred">Preferred Vendor</Label><p className="text-sm text-muted-foreground">Show this vendor first in vendor lists.</p></div><Switch id="switch-vendor-preferred" checked={form.preferred} onCheckedChange={(v) => set('preferred', v)} data-testid="switch-vendor-preferred" /></div>
          <Button type="submit" disabled={createVendor.isPending} data-testid="button-create-vendor"><Save className="w-4 h-4 mr-2" />{createVendor.isPending ? 'Creating…' : 'Create Vendor'}</Button>
        </form>
      </CardContent>
    </Card>
  </div>;
}
function Field({ label, value, onChange, required, type = 'text', testId }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string; testId?: string }) {
  return <div className="space-y-2"><Label>{label}{required ? ' *' : ''}</Label><Input type={type} value={value} required={required} onChange={(e) => onChange(e.target.value)} data-testid={testId} /></div>;
}