import React, { useState, useMemo } from 'react';
import { useGetVendorPaymentReport, useGetDashboardSummary, useListClients, useListUsers, useListVendors } from '@workspace/api-client-react';
import { useSearchParams } from 'wouter';
import { useAuth } from '@/components/auth/auth-provider';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { downloadCSV } from '@/lib/csv';
import { formatMoney } from '@/lib/utils';
import { VendorLink } from '@/components/entity-links';
import PendingAuthReport from './reports/pending-auth-report';
import CaseStatusReport from './reports/case-status-report';
import MissingDocumentsReport from './reports/missing-documents-report';
import ExpiringAuthReport from './reports/expiring-auth-report';
import { stableSort, useTableSort } from '@/lib/table-sorting';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';
import { DateRangeFilter } from '@/components/date-range-filter';
import { Label } from '@/components/ui/label';

export interface GlobalReportFilters {
  clientId?: string;
  coordinatorId?: string;
  startDate?: string;
  endDate?: string;
}

const VALID_TABS = ['vendor-payments', 'case-status', 'pending-auth', 'missing-docs', 'expiring-auth'];

export default function ReportsPage() {
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const isCoordinator = user?.role === 'service_coordinator';
  const canFilterParticipants = isStaff || isCoordinator;
  const showPendingAuth = isStaff || isCoordinator;
  const showExpiringAuth = isStaff || isCoordinator;

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') ?? '';
  const activeTab = VALID_TABS.includes(tabParam) ? tabParam : 'vendor-payments';
  const docTypeParam = searchParams.get('docType') ?? undefined;
  const statusParam = searchParams.get('status') ?? undefined;

  const [globalClientId, setGlobalClientId] = useState('__all__');
  const [globalCoordinatorId, setGlobalCoordinatorId] = useState('__all__');
  const [globalDateRange, setGlobalDateRange] = useState<{ startDate?: string; endDate?: string }>({});

  const [clientSearch, setClientSearch] = useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const clientParams = { search: debouncedClientSearch, limit: 50 };
  const { data: clientsData, isLoading: clientsLoading } = useListClients(
    clientParams,
    { query: { enabled: canFilterParticipants, queryKey: ['clients', clientParams] } },
  );

  const [coordSearch, setCoordSearch] = useState('');
  const debouncedCoordSearch = useDebounce(coordSearch, 300);
  const coordinatorParams = {
    role: 'service_coordinator',
    active: true,
    search: debouncedCoordSearch,
    limit: 50,
  };
  const { data: coordsData, isLoading: coordsLoading } = useListUsers(
    coordinatorParams,
    { query: { enabled: isStaff, queryKey: ['users', coordinatorParams] } },
  );

  const clientOptions = [{ value: '__all__', label: 'All Participants' }].concat(
    (clientsData?.items ?? []).map((client) => ({
      value: client.id,
      label: `${client.firstName} ${client.lastName}`,
    })),
  );
  const coordOptions = [{ value: '__all__', label: 'All Coordinators' }].concat(
    (coordsData ?? []).map((u: any) => ({ value: u.id, label: u.name }))
  );

  const globalFilters = useMemo<GlobalReportFilters>(() => ({
    clientId: globalClientId !== '__all__' ? globalClientId : undefined,
    coordinatorId: globalCoordinatorId !== '__all__' ? globalCoordinatorId : undefined,
    startDate: globalDateRange.startDate,
    endDate: globalDateRange.endDate,
  }), [globalClientId, globalCoordinatorId, globalDateRange]);

  const onTabChange = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports &amp; Analytics</h1>
          <p className="text-muted-foreground mt-1">Financial and operational reporting.</p>
        </div>
      </div>

      <Card className="sticky top-0 z-10 shadow-sm border-b">
        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          {canFilterParticipants && (
            <div className="space-y-1">
              <Label className="text-xs">Participant</Label>
              <SearchableSelect
                value={globalClientId}
                onValueChange={setGlobalClientId}
                options={clientOptions}
                onSearchChange={setClientSearch}
                loading={clientsLoading}
                placeholder="Search participant..."
                data-testid="global-filter-participant"
              />
            </div>
          )}
          {isStaff && (
            <div className="space-y-1">
              <Label className="text-xs">Service Coordinator</Label>
              <SearchableSelect
                value={globalCoordinatorId}
                onValueChange={setGlobalCoordinatorId}
                options={coordOptions}
                onSearchChange={setCoordSearch}
                loading={coordsLoading}
                placeholder="Search coordinator..."
                data-testid="global-filter-coordinator"
              />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Date Range</Label>
            <DateRangeFilter
              startDate={globalDateRange.startDate}
              endDate={globalDateRange.endDate}
              onChange={setGlobalDateRange}
              presentation="single-level"
            />
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={onTabChange} className="space-y-4">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="vendor-payments" data-testid="tab-vendor-payments">Vendor Payments</TabsTrigger>
          {isStaff && <TabsTrigger value="case-status" data-testid="tab-case-status">Case Status</TabsTrigger>}
          {showPendingAuth && <TabsTrigger value="pending-auth" data-testid="tab-pending-auth">Pending Authorization</TabsTrigger>}
          {isStaff && <TabsTrigger value="missing-docs" data-testid="tab-missing-docs">Missing Documents</TabsTrigger>}
          {showExpiringAuth && <TabsTrigger value="expiring-auth" data-testid="tab-expiring-auth">Expiring Authorizations</TabsTrigger>}
        </TabsList>

        <TabsContent value="vendor-payments">
          <VendorPaymentsReport filters={globalFilters} />
        </TabsContent>
        {isStaff && (
          <TabsContent value="case-status">
            <CaseStatusReport filters={globalFilters} initialStatus={statusParam} />
          </TabsContent>
        )}
        {showPendingAuth && (
          <TabsContent value="pending-auth">
            <PendingAuthReport filters={globalFilters} />
          </TabsContent>
        )}
        {isStaff && (
          <TabsContent value="missing-docs">
            <MissingDocumentsReport filters={globalFilters} initialDocType={docTypeParam} />
          </TabsContent>
        )}
        {showExpiringAuth && (
          <TabsContent value="expiring-auth">
            <ExpiringAuthReport filters={globalFilters} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function VendorPaymentsReport({ filters }: { filters: GlobalReportFilters }) {
  const currentYear = new Date().getFullYear();
  const { sort, onSort } = useTableSort<string>('vendorName');

  const [vendorId, setVendorId] = useState('__all__');
  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);

  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors({
    search: debouncedVendorSearch,
    limit: 50,
  });

  const vendorOptions = [{ value: '__all__', label: 'All Vendors' }].concat(
    (vendorsData?.items ?? []).map((v: any) => ({ value: v.id, label: v.name }))
  );

  const reportParams: any = {
    ...filters,
    ...(vendorId !== '__all__' ? { vendorId } : {}),
  };
  if (!reportParams.startDate && !reportParams.endDate) {
    reportParams.year = currentYear;
  }

  const { data: report, isLoading } = useGetVendorPaymentReport(reportParams, {
    query: { queryKey: ['vendorReport', reportParams] },
  });
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary({ query: { queryKey: ['dashboardSummary'] } });
  const sortedReport = stableSort(report ?? [], sort, {
    vendorName: (v: any) => v.vendorName,
    einOnFile: (v: any) => v.einOnFile ? 'On File' : 'Pending',
    totalPaid: (v: any) => Number(v.totalPaid),
  });

  const isRange = !!(filters.startDate || filters.endDate);

  const exportVendorPayments = () => {
    if (!report) return;
    const headers = ['Vendor Name', 'W-9 Status', 'Payments', isRange ? 'Total Paid (Selected Range)' : 'Total Paid YTD'];
    const rows = report.map((v: any) => [
      v.vendorName,
      v.einOnFile ? 'On File' : 'Pending',
      v.paymentCount,
      formatMoney(v.totalPaid),
    ]);
    downloadCSV(`vendor_payments_${isRange ? 'range' : `ytd_${currentYear}`}.csv`, headers, rows);
  };

  const exportDashboardSummary = () => {
    if (!summary) return;
    const headers = ['Metric', 'Value'];
    const t = summary.totals;
    const rows: (string | number)[][] = [
      ['Active Participants', t.activeClients],
      ['Active Authorizations', t.activeAuthorizations],
      ['Pending Invoices', t.pendingInvoices],
      ['Vendors Missing W-9', t.vendorsMissingW9],
      ['Payments This Month', t.paymentsThisMonth ?? ''],
      ['Unmatched Remittances', t.unmatchedRemittances ?? ''],
    ];
    for (const s of summary.referralsByStatus) {
      rows.push([`Cases: ${s.status}`, s.count]);
    }
    downloadCSV('dashboard_summary.csv', headers, rows);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4 border-b">
          <div>
            <CardTitle>Dashboard Summary</CardTitle>
            <CardDescription>Program-level totals and case-status counts.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={exportDashboardSummary} disabled={!summary} data-testid="button-export-dashboard-summary">
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent className="pt-6">
          {summaryLoading || !summary ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-8 w-16" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-6" data-testid="dashboard-summary-stats">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                {[
                  { label: 'Active Participants', value: summary.totals.activeClients, testid: 'stat-active-clients' },
                  { label: 'Active Authorizations', value: summary.totals.activeAuthorizations, testid: 'stat-active-authorizations' },
                  { label: 'Pending Invoices', value: summary.totals.pendingInvoices, testid: 'stat-pending-invoices' },
                  { label: 'Vendors Missing W-9', value: summary.totals.vendorsMissingW9, testid: 'stat-vendors-missing-w9' },
                  { label: 'Payments This Month', value: summary.totals.paymentsThisMonth ?? '—', testid: 'stat-payments-this-month' },
                  { label: 'Unmatched Remittances', value: summary.totals.unmatchedRemittances ?? '—', testid: 'stat-unmatched-remittances' },
                ].map((stat) => (
                  <div key={stat.testid}>
                    <div className="text-2xl font-bold" data-testid={stat.testid}>{stat.value}</div>
                    <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                  </div>
                ))}
              </div>
              {summary.referralsByStatus.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-3">Cases by Status</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                    {summary.referralsByStatus.map((s) => (
                      <div key={s.status} data-testid={`stat-case-status-${s.status}`}>
                        <div className="text-2xl font-bold">{s.count}</div>
                        <p className="text-xs text-muted-foreground mt-1 capitalize">{s.status.replace(/_/g, ' ')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-4 pb-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <CardTitle>{isRange ? 'Vendor Payments (Selected Range)' : `Vendor Payments YTD (${currentYear})`}</CardTitle>
            <CardDescription>{isRange ? 'Summary of all payments issued in the selected date range.' : 'Summary of all payments issued to vendors this year.'}</CardDescription>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              <div className="space-y-1">
                <Label className="text-xs">Vendor</Label>
                <SearchableSelect
                  value={vendorId}
                  onValueChange={setVendorId}
                  options={vendorOptions}
                  onSearchChange={setVendorSearch}
                  loading={vendorsLoading}
                  placeholder="All Vendors"
                  data-testid="filter-vendor-payments-vendor"
                />
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={exportVendorPayments} disabled={!report} data-testid="button-export-vendor-payments" className="shrink-0">
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead sortDirection={sort.key === 'vendorName' ? sort.direction : null} onSort={() => onSort('vendorName')}>Vendor Name</SortableTableHead>
                <SortableTableHead sortDirection={sort.key === 'einOnFile' ? sort.direction : null} onSort={() => onSort('einOnFile')}>W-9 Status</SortableTableHead>
                <TableHead className="text-right">Payments</TableHead>
                <SortableTableHead className="text-right" sortDirection={sort.key === 'totalPaid' ? sort.direction : null} onSort={() => onSort('totalPaid')}>{isRange ? 'Total Paid (Selected Range)' : 'Total Paid YTD'}</SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={4} className="h-24"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
              ) : report?.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No data available.</TableCell></TableRow>
              ) : (
                sortedReport.map((v: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium"><VendorLink id={v.vendorId} name={v.vendorName} /></TableCell>
                    <TableCell className="capitalize text-muted-foreground">{v.einOnFile ? 'On File' : 'Pending'}</TableCell>
                    <TableCell className="text-right tabular-nums">{v.paymentCount}</TableCell>
                    <TableCell className="text-right font-bold text-primary">${formatMoney(v.totalPaid)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-vendor-payments-footer">
              {isLoading
                ? 'Loading…'
                : !report || report.length === 0
                  ? 'No vendors'
                  : `Showing all ${report.length} of ${report.length} vendors`}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
