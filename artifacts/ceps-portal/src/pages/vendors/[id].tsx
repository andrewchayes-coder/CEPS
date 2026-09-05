import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useParams, Link } from 'wouter';
import {
  useGetVendor,
  useUpdateVendor,
  useUpdateVendorContact,
  useUploadVendorW9,
  useListPayments,
  useGetVendorPaymentReport,
  useListClients,
  GetVendorPaymentReportParams,
  ListPaymentsParams,
  ListClientsParams
} from '@workspace/api-client-react';
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
import { ArrowLeft, Save, FileText, ExternalLink, Power, CheckCircle2, ChevronLeft, ChevronRight, Search } from 'lucide-react';
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
import { trackAnalyticsEvent } from '@/lib/analytics';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DateRangeFilter } from '@/components/date-range-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead, useTableSort } from '@/components/ui/table';
import { useDebounce } from '@/hooks/use-debounce';
import { format } from 'date-fns';
import { formatMoney } from '@/lib/utils';
import { ClientLink } from '@/components/entity-links';
import { Skeleton } from '@/components/ui/skeleton';

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
  const [isDirty, setIsDirty] = useState(false);
  const initialized = useRef(false);

  const vendorForm = (value: any) => ({
    name: value.name, altaVendorNumber: value.altaVendorNumber || '', ein: value.ein || '',
    w9Status: value.w9Status, contactPerson: value.contactPerson || '', email: value.email || '',
    phone: value.phone || '', billingAddress: value.billingAddress || '', serviceAddress: value.serviceAddress || '',
    preferred: value.preferred, active: value.active,
  });
  const apiError = (error: any, fallback: string) =>
    typeof error?.data?.error === 'string' ? error.data.error :
      typeof error?.data?.message === 'string' ? error.data.message :
        typeof error?.response?.data?.error === 'string' ? error.response.data.error :
          typeof error?.response?.data?.message === 'string' ? error.response.data.message : fallback;

  useEffect(() => {
    if (vendor && (!initialized.current || !isDirty)) {
      setFormData(vendorForm(vendor));
      initialized.current = true;
    }
  }, [vendor]);

  if (isLoading) return <div className="p-8 text-center">Loading vendor...</div>;
  if (!vendor) return <div className="p-8 text-center">Vendor not found.</div>;

  const handleChange = (field: string, value: any) => {
    setIsDirty(true);
    setFormData((prev: any) => ({ ...prev, [field]: value }));
  };

  const saving = updateVendor.isPending || updateVendorContact.isPending;

  const handleToggleActive = (nextActive: boolean) => {
    updateVendor.mutate(
      { id, data: { active: nextActive } as any },
      {
        onSuccess: (updated) => {
          toast({ title: nextActive ? 'Vendor Reactivated' : 'Vendor Deactivated' });
          setFormData(vendorForm(updated));
          setIsDirty(false);
          refetch();
        },
        onError: (error) => {
          toast({
            variant: 'destructive',
            title: 'Error',
            description: apiError(error, `Could not ${nextActive ? 'reactivate' : 'deactivate'} this vendor.`),
          });
        },
      },
    );
  };

  const handleSave = () => {
    const onSuccess = (updated: any) => {
      toast({ title: 'Vendor Updated' });
      setFormData(vendorForm(updated));
      setIsDirty(false);
      refetch();
    };
    const onError = (error: any) => toast({ variant: 'destructive', title: 'Unable to update vendor', description: apiError(error, 'Please try again.') });
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
        { onSuccess, onError },
      );
    } else {
      updateVendor.mutate({ id, data: formData }, { onSuccess, onError });
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/vendors"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Edit Vendor</h1>
        <div className="flex items-center gap-3">
          {formData.preferred && <Badge variant="secondary" className="bg-primary/10 text-primary" data-testid="badge-vendor-preferred">Preferred Vendor</Badge>}
          <Badge
            variant="outline"
            className={formData.active ? 'text-chart-5 border-chart-5/20' : 'bg-muted text-muted-foreground'}
            data-testid="badge-vendor-status"
          >
            {formData.active ? 'Active' : 'Inactive'}
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

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="overview" data-testid="tab-vendor-overview">Overview</TabsTrigger>
          <TabsTrigger value="payments" data-testid="tab-vendor-payments">Payments</TabsTrigger>
          <TabsTrigger value="participants" data-testid="tab-vendor-participants">Participants</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 max-w-2xl">
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
                      <Select value={formData.w9Status || ''} onValueChange={val => handleChange('w9Status', val)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="on_file">On File</SelectItem>
                          <SelectItem value="expired">Expired</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <label htmlFor="switch-vendor-preferred" className="text-sm font-medium">Preferred Vendor</label>
                      <p className="text-sm text-muted-foreground">Show this vendor first in vendor lists.</p>
                    </div>
                    <Switch id="switch-vendor-preferred" checked={!!formData.preferred} onCheckedChange={(value) => handleChange('preferred', value)} disabled={saving} data-testid="switch-vendor-preferred" />
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
                            trackAnalyticsEvent('w9_uploaded', { location: 'vendor_detail' });
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
        </TabsContent>

        <TabsContent value="payments" className="mt-6 focus:outline-none">
          <VendorPaymentsTab vendorId={id} />
        </TabsContent>

        <TabsContent value="participants" className="mt-6 focus:outline-none">
          <VendorParticipantsTab vendorId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VendorPaymentsTab({ vendorId }: { vendorId: string }) {
  const [startDate, setStartDate] = useState<string>();
  const [endDate, setEndDate] = useState<string>();
  const [page, setPage] = useState(0);
  const sort = useTableSort<'checkDate' | 'qbCheckNumber' | 'clientName' | 'amount' | 'remitted'>();

  const onSort = (key: Parameters<typeof sort.toggleSort>[0]) => {
    sort.toggleSort(key);
    setPage(0);
  };

  const PAGE_SIZE = 50;

  const reportParams: GetVendorPaymentReportParams = {
    vendorId,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
  if (!startDate && !endDate) {
    reportParams.allTime = 'true';
  }

  const { data: reportData, isLoading: reportLoading } = useGetVendorPaymentReport(reportParams, {
    query: { queryKey: ['vendorReport', reportParams] }
  });

  const report = reportData?.[0] || { paymentCount: 0, totalPaid: 0 };
  const isRange = !!(startDate || endDate);

  const listParams: ListPaymentsParams = {
    vendorId,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(sort.sortBy ? { sortBy: sort.sortBy as any, sortDirection: sort.sortDirection as any } : {}),
  };

  const { data: paymentsData, isLoading: paymentsLoading } = useListPayments(listParams, {
    query: { queryKey: ['payments', listParams] }
  });

  const payments = paymentsData?.items;
  const total = paymentsData?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center gap-4 flex-wrap">
         <div data-testid="filter-payments-date">
           <DateRangeFilter
              startDate={startDate}
              endDate={endDate}
              onChange={(range) => {
                 setStartDate(range.startDate);
                 setEndDate(range.endDate);
                 setPage(0);
              }}
           />
         </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
         <Card>
           <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                 {isRange ? 'Payment Count (Selected Range)' : 'Payment Count (All Time)'}
              </CardTitle>
           </CardHeader>
           <CardContent>
              {reportLoading ? <Skeleton className="h-8 w-16" /> : (
                 <div className="text-2xl font-bold" data-testid="stat-payment-count">{report.paymentCount}</div>
              )}
           </CardContent>
         </Card>
         <Card>
           <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                 {isRange ? 'Total Paid (Selected Range)' : 'Total Paid (All Time)'}
              </CardTitle>
           </CardHeader>
           <CardContent>
              {reportLoading ? <Skeleton className="h-8 w-24" /> : (
                 <div className="text-2xl font-bold text-primary" data-testid="stat-total-paid">${formatMoney(report.totalPaid)}</div>
              )}
           </CardContent>
         </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Date" sortKey="checkDate" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Check #" sortKey="qbCheckNumber" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Participant" sortKey="clientName" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Amount" sortKey="amount" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} className="text-right" />
                <SortableTableHead label="Remitted" sortKey="remitted" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {paymentsLoading ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center"><Skeleton className="h-4 w-full max-w-sm mx-auto" /></TableCell></TableRow>
              ) : !payments || payments.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No payments found.</TableCell></TableRow>
              ) : (
                payments.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap">{format(new Date(p.checkDate), 'MMM d, yyyy')}</TableCell>
                    <TableCell className="font-mono text-sm">
                      <Link href={`/payments/${p.id}`} className="text-primary hover:underline" data-testid="link-payment">
                        {p.qbCheckNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <ClientLink id={p.clientId} name={p.clientName} className="text-muted-foreground hover:underline" />
                    </TableCell>
                    <TableCell className="text-right font-medium">${parseFloat(p.amount).toFixed(2)}</TableCell>
                    <TableCell>
                      {p.remitted ? <CheckCircle2 className="w-5 h-5 text-chart-5" /> : <span className="text-xs text-muted-foreground">${parseFloat(p.allocatedAmount ?? '0').toFixed(2)} allocated<br />${parseFloat(p.remainingAmount ?? p.amount).toFixed(2)} remaining</span>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-payments-pagination">
              {total === 0
                ? 'No payments'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} payments`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-payments-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-payments-next"
              >
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function VendorParticipantsTab({ vendorId }: { vendorId: string }) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(0);
  const sort = useTableSort<'name' | 'uciNumber' | 'status' | 'assignedCoordinatorName'>();

  const PAGE_SIZE = 50;

  const onSort = (key: Parameters<typeof sort.toggleSort>[0]) => {
    sort.toggleSort(key);
    setPage(0);
  };

  const onSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  const listParams: ListClientsParams = {
    vendorId,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(sort.sortBy ? { sortBy: sort.sortBy as any, sortDirection: sort.sortDirection as any } : {}),
  };

  const { data, isLoading } = useListClients(listParams, {
    query: { queryKey: ['clients', listParams] }
  });

  const clients = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="relative w-full sm:max-w-md">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search participants by name or UCI..."
          className="pl-8"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          data-testid="input-participants-search"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Name" sortKey="name" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="UCI Number" sortKey="uciNumber" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Coordinator" sortKey="assignedCoordinatorName" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Status" sortKey="status" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={4} className="h-24 text-center"><Skeleton className="h-4 w-full max-w-sm mx-auto" /></TableCell></TableRow>
              ) : !clients || clients.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No participants found.</TableCell></TableRow>
              ) : (
                clients.map((client: any) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-medium">
                      <ClientLink id={client.id} name={`${client.firstName} ${client.lastName}`} />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{client.uciNumber}</TableCell>
                    <TableCell className="text-muted-foreground">{client.assignedCoordinatorName || 'Unassigned'}</TableCell>
                    <TableCell>
                      <Badge variant={client.status === 'active' ? 'default' : 'secondary'} className={client.status === 'active' ? 'bg-chart-5 text-white hover:bg-chart-5/90' : ''}>
                        {client.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-participants-pagination">
              {total === 0
                ? 'No participants'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} participants`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-participants-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-participants-next"
              >
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
