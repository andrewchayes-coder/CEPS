import React, { useEffect, useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import { useUpdateAuthorization, useListVendors, getListVendorsQueryKey } from '@workspace/api-client-react';
import type { AuthorizationUpdate } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';
import { Checkbox } from '@/components/ui/checkbox';

const SERVICE_CODES = ['459', '024', '490'];
type AuthorizationLike = {
  clientId: string;
  authNumber: string;
  serviceCode: string;
  activityDescription?: string | null;
  monthlyAmount?: string | null;
  oneTimeAmount?: string | null;
  maxPeriodAmount: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  vendorId?: string | null;
  vendorName?: string | null;
};

type Props = {
  id: string;
  authorization: AuthorizationLike;
  onSaved?: () => void;
};

export function EditAuthorizationDialog({ id, authorization, onSaved }: Props) {
  const { toast } = useToast();
  const updateAuthorization = useUpdateAuthorization();
  const [open, setOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [form, setForm] = useState({
    authNumber: authorization.authNumber,
    serviceCode: authorization.serviceCode,
    activityDescription: authorization.activityDescription ?? '',
    monthlyAmount: authorization.monthlyAmount ?? '',
    oneTimeAmount: authorization.oneTimeAmount ?? '',
    maxPeriodAmount: authorization.maxPeriodAmount,
    servicePeriodStart: authorization.servicePeriodStart?.slice(0, 10) ?? '',
    servicePeriodEnd: authorization.servicePeriodEnd?.slice(0, 10) ?? '',
    vendorId: authorization.vendorId ?? 'none',
  });
  useEffect(() => {
    if (!open) return;
    setForm({
      authNumber: authorization.authNumber,
      serviceCode: authorization.serviceCode,
      activityDescription: authorization.activityDescription ?? '',
      monthlyAmount: authorization.monthlyAmount ?? '',
      oneTimeAmount: authorization.oneTimeAmount ?? '',
      maxPeriodAmount: authorization.maxPeriodAmount,
      servicePeriodStart: authorization.servicePeriodStart?.slice(0, 10) ?? '',
      servicePeriodEnd: authorization.servicePeriodEnd?.slice(0, 10) ?? '',
      vendorId: authorization.vendorId ?? 'none',
    });
  }, [open, authorization]);

  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const [showAllVendors, setShowAllVendors] = useState(false);
  const vendorParams = {
    ...(!showAllVendors ? { clientId: authorization.clientId } : {}),
    search: debouncedVendorSearch,
    limit: 50,
  };
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    vendorParams,
    { query: { enabled: open, queryKey: getListVendorsQueryKey(vendorParams) } }
  );
  const vendors = vendorsData?.items ?? [];

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = (acceptMaxAmountWarning = false) => {
    const data: AuthorizationUpdate = {
      authNumber: form.authNumber,
      serviceCode: form.serviceCode as AuthorizationUpdate['serviceCode'],
      activityDescription: form.activityDescription || undefined,
      monthlyAmount: form.monthlyAmount === '' ? null : form.monthlyAmount,
      oneTimeAmount: form.oneTimeAmount === '' ? null : form.oneTimeAmount,
      servicePeriodStart: form.servicePeriodStart || undefined,
      servicePeriodEnd: form.servicePeriodEnd || undefined,
      maxPeriodAmount: form.maxPeriodAmount,
      acceptMaxAmountWarning,
      vendorId: form.vendorId === 'none' ? null : form.vendorId,
    };
    updateAuthorization.mutate(
      { id, data },
      {
        onSuccess: (result) => {
          if (!result.saved && result.warnings?.length) {
            setWarnings(result.warnings);
            toast({ variant: 'destructive', title: 'Data quality warning', description: 'Review the warning before saving.' });
            return;
          }
          setWarnings([]);
          toast({ title: 'Authorization updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not update authorization.') }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setShowAllVendors(false);
    }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="button-edit-authorization">
          <Pencil className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Authorization</DialogTitle>
          <DialogDescription>Update the authorization (POS) details.</DialogDescription>
        </DialogHeader>
        {warnings.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            <p className="font-medium">Data quality warning</p>
            <ul className="list-disc pl-5 mt-1">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            <div className="flex gap-2 mt-3">
              <Button size="sm" variant="outline" onClick={() => handleSave(true)} disabled={updateAuthorization.isPending}>Save Anyway</Button>
              <Button size="sm" variant="ghost" onClick={() => setWarnings([])}>Cancel</Button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label>Auth #</Label>
            <Input value={form.authNumber} onChange={(e) => set('authNumber', e.target.value)} data-testid="input-auth-number" />
          </div>
          <div className="space-y-2">
            <Label>Service Code</Label>
            <Select value={form.serviceCode} onValueChange={(v) => set('serviceCode', v)}>
              <SelectTrigger data-testid="select-auth-service-code"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SERVICE_CODES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 col-span-2">
            <Label>Service Description</Label>
            <Textarea value={form.activityDescription} onChange={(e) => set('activityDescription', e.target.value)} data-testid="input-auth-description" />
          </div>
          <div className="space-y-2">
            <Label>Monthly Amount</Label>
            <Input value={form.monthlyAmount} onChange={(e) => set('monthlyAmount', e.target.value)} data-testid="input-auth-monthly-amount" />
          </div>
          <div className="space-y-2">
            <Label>One-Time Amount</Label>
            <Input value={form.oneTimeAmount} onChange={(e) => set('oneTimeAmount', e.target.value)} data-testid="input-auth-onetime-amount" />
          </div>
          <div className="space-y-2">
            <Label>Max Period Amount</Label>
            <Input value={form.maxPeriodAmount} required inputMode="decimal" onChange={(e) => set('maxPeriodAmount', e.target.value)} data-testid="input-auth-max-period-amount" />
          </div>
          <div className="space-y-2">
            <Label>Period Start</Label>
            <Input type="date" value={form.servicePeriodStart} onChange={(e) => set('servicePeriodStart', e.target.value)} data-testid="input-auth-start-date" />
          </div>
          <div className="space-y-2">
            <Label>Period End</Label>
            <Input type="date" value={form.servicePeriodEnd} onChange={(e) => set('servicePeriodEnd', e.target.value)} data-testid="input-auth-end-date" />
          </div>
          <div className="space-y-2">
            <Label>Vendor</Label>
            <SearchableSelect
              value={form.vendorId}
              onValueChange={(v) => set('vendorId', v)}
              options={vendors.map(v => ({ value: v.id, label: v.name }))}
              onSearchChange={setVendorSearch}
              loading={vendorsLoading}
              placeholder="Optional"
              selectedLabelFallback={authorization.vendorName ?? undefined}
              allowClear
              clearLabel="None"
              data-testid="select-auth-vendor"
            />
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="show-all-edit-auth-vendors"
                checked={showAllVendors}
                onCheckedChange={(checked) => setShowAllVendors(checked === true)}
                data-testid="checkbox-show-all-edit-auth-vendors"
              />
              <label htmlFor="show-all-edit-auth-vendors" className="text-sm text-muted-foreground">
                Show all vendors
              </label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => handleSave()} disabled={updateAuthorization.isPending} data-testid="button-save-authorization">
            {updateAuthorization.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
