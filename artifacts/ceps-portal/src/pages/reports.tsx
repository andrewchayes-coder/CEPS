import React from 'react';
import { useGetVendorPaymentReport, useGetDashboardSummary } from '@workspace/api-client-react';
import { useSearchParams } from 'wouter';
import { useAuth } from '@/components/auth/auth-provider';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { downloadCSV } from '@/lib/csv';
import { formatMoney } from '@/lib/utils';
import { ClientLink, VendorLink } from '@/components/entity-links';
import PendingAuthReport from './reports/pending-auth-report';
import CaseStatusReport from './reports/case-status-report';
import MissingDocumentsReport from './reports/missing-documents-report';
import ExpiringAuthReport from './reports/expiring-auth-report';

const VALID_TABS = ['vendor-payments', 'case-status', 'pending-auth', 'missing-docs', 'expiring-auth'];

export default function ReportsPage() {
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const isCoordinator = user?.role === 'service_coordinator';
  // Coordinators get the two caseload-scoped operational reports; staff get all.
  const showPendingAuth = isStaff || isCoordinator;
  const showExpiringAuth = isStaff || isCoordinator;
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') ?? '';
  const activeTab = VALID_TABS.includes(tabParam) ? tabParam : 'vendor-payments';
  const docTypeParam = searchParams.get('docType') ?? undefined;
  const statusParam = searchParams.get('status') ?? undefined;

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

      <Tabs value={activeTab} onValueChange={onTabChange} className="space-y-4">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="vendor-payments" data-testid="tab-vendor-payments">Vendor Payments</TabsTrigger>
          {isStaff && <TabsTrigger value="case-status" data-testid="tab-case-status">Case Status</TabsTrigger>}
          {showPendingAuth && <TabsTrigger value="pending-auth" data-testid="tab-pending-auth">Pending Authorization</TabsTrigger>}
          {isStaff && <TabsTrigger value="missing-docs" data-testid="tab-missing-docs">Missing Documents</TabsTrigger>}
          {showExpiringAuth && <TabsTrigger value="expiring-auth" data-testid="tab-expiring-auth">Expiring Authorizations</TabsTrigger>}
        </TabsList>

        <TabsContent value="vendor-payments">
          <VendorPaymentsReport />
        </TabsContent>
        {isStaff && (
          <TabsContent value="case-status">
            <CaseStatusReport initialStatus={statusParam} />
          </TabsContent>
        )}
        {showPendingAuth && (
          <TabsContent value="pending-auth">
            <PendingAuthReport />
          </TabsContent>
        )}
        {isStaff && (
          <TabsContent value="missing-docs">
            <MissingDocumentsReport initialDocType={docTypeParam} />
          </TabsContent>
        )}
        {showExpiringAuth && (
          <TabsContent value="expiring-auth">
            <ExpiringAuthReport />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function VendorPaymentsReport() {
  const currentYear = new Date().getFullYear();
  const { data: report, isLoading } = useGetVendorPaymentReport({ year: currentYear }, {
    query: { queryKey: ['vendorReport', currentYear] },
  });
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary({ query: { queryKey: ['dashboardSummary'] } });

  const exportVendorPayments = () => {
    if (!report) return;
    const headers = ['Vendor Name', 'W-9 Status', 'Payments', 'YTD Total Paid'];
    const rows = report.map((v: any) => [
      v.vendorName,
      v.einOnFile ? 'On File' : 'Pending',
      v.paymentCount,
      formatMoney(v.totalPaid),
    ]);
    downloadCSV(`vendor_payments_ytd_${currentYear}.csv`, headers, rows);
  };

  const exportDashboardSummary = () => {
    if (!summary) return;
    const headers = ['Metric', 'Value'];
    const t = summary.totals;
    const rows: (string | number)[][] = [
      ['Active Clients', t.activeClients],
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
                  { label: 'Active Clients', value: summary.totals.activeClients, testid: 'stat-active-clients' },
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
        <CardHeader className="flex flex-row items-center justify-between pb-4 border-b">
          <div>
            <CardTitle>Vendor Payments YTD ({currentYear})</CardTitle>
            <CardDescription>Summary of all payments issued to vendors this year.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={exportVendorPayments} disabled={!report} data-testid="button-export-vendor-payments">
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor Name</TableHead>
                <TableHead>W-9 Status</TableHead>
                <TableHead className="text-right">Total Paid YTD</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={3} className="h-24"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
              ) : report?.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="h-24 text-center text-muted-foreground">No data available.</TableCell></TableRow>
              ) : (
                report?.map((v: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium"><VendorLink id={v.vendorId} name={v.vendorName} /></TableCell>
                    <TableCell className="capitalize text-muted-foreground">{v.einOnFile ? 'On File' : 'Pending'}</TableCell>
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
