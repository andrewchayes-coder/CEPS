import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetVendor, useUpdateVendor } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save } from 'lucide-react';
import { Link } from 'wouter';

export default function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { data: vendor, isLoading, refetch } = useGetVendor(id, { query: { enabled: !!id, queryKey: ['vendor', id] }});
  const updateVendor = useUpdateVendor();
  
  const [formData, setFormData] = useState<any>({});
  const initialized = useRef(false);

  useEffect(() => {
    if (vendor && !initialized.current) {
      setFormData({
        name: vendor.name,
        altaVendorNumber: vendor.altaVendorNumber || '',
        w9Status: vendor.w9Status,
        email: vendor.email || '',
        phone: vendor.phone || '',
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

  const handleSave = () => {
    updateVendor.mutate({
      id,
      data: formData
    }, {
      onSuccess: () => {
        toast({ title: 'Vendor Updated' });
        refetch();
      }
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/vendors"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Edit Vendor</h1>
        {formData.preferred && <Badge variant="secondary" className="bg-primary/10 text-primary">Preferred Vendor</Badge>}
      </div>

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

          <div className="pt-4 flex gap-4">
            <Button onClick={handleSave} disabled={updateVendor.isPending}>
              <Save className="w-4 h-4 mr-2" /> Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
