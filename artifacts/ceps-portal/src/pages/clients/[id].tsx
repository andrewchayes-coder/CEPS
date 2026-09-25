import React from 'react';
import { useLocation, useParams, useSearch } from 'wouter';
import { useGetClientCase, useListFees, useDeleteClient, useDeleteFee, useListFamilyRepresentatives, getListFamilyRepresentativesQueryKey, type CaseDocument } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { InvitePortalDialog } from '@/components/invite-portal-dialog';
import { EditClientDialog } from '@/components/edit-client-dialog';
import { EditContactInfoDialog } from '@/components/edit-contact-info-dialog';
import { FamilyRepresentativesSection, RepresentativeEditAction } from '@/components/family-representatives';
import { EditFeeDialog } from '@/components/edit-fee-dialog';
import { CreateRemittanceDialog } from '@/components/create-remittance-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { ClientLink, VendorLink } from '@/components/entity-links';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, User, FileText, FileCheck, Receipt, CreditCard, FolderSync, AlertCircle, CheckCircle2, Phone, Mail, MapPin } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead } from '@/components/ui/table';
import { stableSort, useTableSort } from '@/lib/table-sorting';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DocumentPreview } from '@/components/document-preview';
import { getInvoiceDisplayMonth } from '@/lib/invoice-utils';
import { earliestPaymentServiceMonth, formatPaymentServiceMonths } from '@/lib/payment-utils';

const documentStatusPresentation: Record<string, { label: string; className: string }> = {
  pending: {
    label: 'Pending',
    className: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  sent: {
    label: 'Sent',
    className: 'border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  },
  received: {
    label: 'Received',
    className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
};

const signatureStatusPresentation: Record<string, { label: string; className: string }> = {
  signed: {
    label: 'Signed',
    className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  unsigned: {
    label: 'Unsigned',
    className: 'border-slate-400/60 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  },
  pending: {
    label: 'Pending',
    className: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  sent: {
    label: 'Sent',
    className: 'border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  },
};

function humanizeStatus(status: string) {
  return status
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getStatusPresentation(
  status: string,
  presentations: Record<string, { label: string; className: string }>,
) {
  return presentations[status.toLowerCase()] ?? {
    label: humanizeStatus(status),
    className: 'border-border bg-muted/50 text-muted-foreground',
  };
}

function DocumentStatusGroup({ document }: { document: CaseDocument }) {
  const documentStatus = getStatusPresentation(document.status, documentStatusPresentation);
  const signatureStatus = document.signatureStatus
    ? getStatusPresentation(document.signatureStatus, signatureStatusPresentation)
    : null;

  return (
    <div className="flex min-w-[116px] flex-col items-start gap-1.5" data-testid={`status-group-document-${document.id}`}>
      <Badge
        variant="outline"
        className={`min-w-[78px] justify-center ${documentStatus.className}`}
        data-status-kind="document"
        data-testid={`status-document-${document.id}`}
      >
        {documentStatus.label}
      </Badge>
      {signatureStatus && (
        <div className="flex items-center gap-1.5" data-testid={`signature-group-document-${document.id}`}>
          <span className="text-[11px] font-medium leading-none text-muted-foreground">Signature</span>
          <Badge
            variant="outline"
            className={`min-w-[68px] justify-center px-2 py-0 text-[11px] ${signatureStatus.className}`}
            data-status-kind="signature"
            data-testid={`status-signature-${document.id}`}
          >
            {signatureStatus.label}
          </Badge>
        </div>
      )}
    </div>
  );
}

function ViewDocumentDialog({ document }: { document: CaseDocument }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid={`button-view-doc-${document.id}`}>View</Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-4 w-full h-[85vh]">
        <DialogHeader className="mb-2 shrink-0">
          <DialogTitle className="truncate pr-8">{document.name}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-hidden">
          <DocumentPreview objectPath={document.objectPath} filename={document.name} className="h-full border-0 rounded-none bg-transparent" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const search = useSearch();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const isFamily = user?.role === 'parent_guardian' || user?.role === 'self';
  const requestedTab = new URLSearchParams(search).get('tab');
  const activeTab = ['overview', 'authorizations', 'invoices', 'payments', 'fees', 'referrals', 'documents'].includes(requestedTab ?? '')
    ? requestedTab!
    : 'overview';
  const deleteClient = useDeleteClient();
  const deleteFee = useDeleteFee();
  const { data: caseData, isLoading, refetch } = useGetClientCase(id, {
    query: {
      enabled: !!id,
      queryKey: ['clientCase', id]
    }
  });

  const { data: fees, refetch: refetchFees } = useListFees(
    { clientId: id },
    { query: { enabled: !!id, queryKey: ['fees', id] } },
  );
  const { data: representatives = [], isLoading: repsLoading, isError: repsError, refetch: refetchReps } = useListFamilyRepresentatives(
    { clientId: id },
    { query: { enabled: !!id, queryKey: getListFamilyRepresentativesQueryKey({ clientId: id }) } },
  );
  const authorizationsSort = useTableSort<string>('authNumber');
  const invoicesSort = useTableSort<string>('serviceMonth');
  const paymentsSort = useTableSort<string>('checkDate', 'desc');
  const feesSort = useTableSort<string>('createdAt', 'desc');
  const referralsSort = useTableSort<string>('referralDate', 'desc');

  if (isLoading) return <div className="p-8 text-center">Loading case record...</div>;
  if (!caseData) return <div className="p-8 text-center">Participant not found.</div>;

  const { client, authorizations, invoices, payments, remittances, referrals } = caseData;
  // The API only returns non-deleted representatives. If none is flagged
  // primary, show the oldest one rather than falling back to client contact.
  const primaryRepresentative = client.isMinor
    ? representatives.find((rep) => rep.isPrimary)
      ?? [...representatives].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
    : undefined;
  const remainingRepresentatives = primaryRepresentative
    ? representatives.filter((rep) => rep.id !== primaryRepresentative.id)
    : representatives;
  const showRepresentativesCard = !repsLoading && !repsError
    ? remainingRepresentatives.length > 0 || isStaff
    : true;
  const feeList = fees ?? [];
  const sortedAuthorizations = stableSort(authorizations, authorizationsSort.sort, {
    authNumber: (auth) => auth.authNumber,
    vendorName: (auth) => auth.vendorName,
    serviceCode: (auth) => auth.serviceCode,
    servicePeriodStart: (auth) => new Date(auth.servicePeriodStart),
    maxPeriodAmount: (auth) => Number(auth.maxPeriodAmount),
    status: (auth) => auth.status,
  });
  const sortedInvoices = stableSort(invoices, invoicesSort.sort, {
    serviceMonth: (invoice) => getInvoiceDisplayMonth(invoice),
    vendorName: (invoice) => invoice.vendorName,
    authNumber: (invoice) => invoice.authNumber,
    amountRequested: (invoice) => Number(invoice.amountRequested),
    status: (invoice) => invoice.status,
  });
  const sortedPayments = stableSort(payments, paymentsSort.sort, {
    checkDate: (payment) => new Date(payment.checkDate),
    qbCheckNumber: (payment) => payment.qbCheckNumber,
    vendorName: (payment) => payment.vendorName,
    authNumber: (payment) => payment.authNumber,
    serviceMonth: (payment) => earliestPaymentServiceMonth(payment),
    amount: (payment) => Number(payment.amount),
    remitted: (payment) => payment.remitted,
  });
  const sortedFees = stableSort(feeList, feesSort.sort, {
    createdAt: (fee) => fee.createdAt ? new Date(fee.createdAt) : null,
    amount: (fee) => Number(fee.amount),
    ruleApplied: (fee) => fee.ruleApplied,
    status: (fee) => fee.status,
  });
  const sortedReferrals = stableSort(referrals, referralsSort.sort, {
    referralDate: (referral) => new Date(referral.referralDate),
    coordinatorName: (referral) => referral.coordinatorName,
    status: (referral) => referral.status,
  });
  const matchedRemittances = remittances.filter((remittance) => remittance.status === 'matched');
  const outstandingRemittances = remittances.filter((remittance) => Number(remittance.remainingAmount ?? remittance.amount) > 0);
  const matchedRemittanceAmount = matchedRemittances.reduce((sum, remittance) => sum + Number(remittance.allocatedAmount ?? remittance.amount), 0);
  const outstandingRemittanceAmount = outstandingRemittances.reduce((sum, remittance) => sum + Number(remittance.remainingAmount ?? remittance.amount), 0);

  return (
    <div className="space-y-6 pb-10">
      {(user?.role === 'staff' || user?.role === 'service_coordinator') && (
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link href="/clients"><ArrowLeft className="w-4 h-4 mr-2" /> Back to Participants</Link>
        </Button>
      )}

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-6 rounded-lg border shadow-sm">
        <div className="flex items-center gap-4 min-w-0">
          <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center shrink-0">
            <User className="h-8 w-8 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">
              <ClientLink id={client.id} name={`${client.firstName} ${client.lastName}`} />
            </h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              <span className="font-mono bg-muted px-1.5 py-0.5 rounded">UCI: {client.uciNumber}</span>
              <span>DOB: {client.dateOfBirth}</span>
            </div>
            {isFamily && !primaryRepresentative && (
              <div className="mt-2 text-sm text-muted-foreground space-y-0.5" data-testid="header-contact-info">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                  {client.phone && <span className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> {client.phone}</span>}
                  {client.email && <span className="flex items-center gap-1.5 break-all"><Mail className="w-3.5 h-3.5 shrink-0" /> {client.email}</span>}
                </div>
                {client.address && (
                  <div className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> {client.address}</div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge variant={client.status === 'active' ? 'default' : 'secondary'} className={client.status === 'active' ? 'bg-chart-5 text-white hover:bg-chart-5/90' : ''}>
            {client.status.toUpperCase()}
          </Badge>
          <div className="text-sm text-muted-foreground text-right">
            Coordinator: <span className="font-medium text-foreground">{client.assignedCoordinatorName || 'Unassigned'}</span>
            {isFamily && (client.assignedCoordinatorEmail || client.assignedCoordinatorPhone) && (
              <div className="mt-0.5 space-y-0.5" data-testid="coordinator-contact-info">
                {client.assignedCoordinatorPhone && (
                  <div className="flex items-center justify-end gap-1.5"><Phone className="w-3.5 h-3.5 shrink-0" /> {client.assignedCoordinatorPhone}</div>
                )}
                {client.assignedCoordinatorEmail && (
                  <div className="flex items-center justify-end gap-1.5 break-all"><Mail className="w-3.5 h-3.5 shrink-0" /> {client.assignedCoordinatorEmail}</div>
                )}
              </div>
            )}
          </div>
          {user?.role === 'staff' && (
            <InvitePortalDialog
              linkedRecordType="client"
              linkedRecordId={id}
              recordName={`${client.firstName} ${client.lastName}`}
            />
          )}
          {(user?.role === 'parent_guardian' || user?.role === 'self') && (
            <EditContactInfoDialog
              id={id}
              client={client}
              isGuardian={user.role === 'parent_guardian'}
              onSaved={() => refetch()}
            />
          )}
          {isStaff && (
            <div className="flex items-center gap-2">
              <EditClientDialog id={id} client={client} onSaved={() => refetch()} />
              <DeleteEntityButton
                entityLabel="Participant"
                testId="button-delete-client"
                onDelete={() => deleteClient.mutateAsync({ id })}
                onDeleted={() => navigate('/clients')}
              />
            </div>
          )}
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(tab) => navigate(`/clients/${id}?tab=${tab}`, { replace: true })}
        className="w-full"
      >
        <TabsList className="w-full justify-start overflow-x-auto border-b rounded-none h-12 bg-transparent p-0">
          <TabsTrigger value="overview" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Overview</TabsTrigger>
          <TabsTrigger value="authorizations" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Authorizations ({authorizations.length})</TabsTrigger>
          <TabsTrigger value="invoices" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Invoices ({invoices.length})</TabsTrigger>
          <TabsTrigger value="payments" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Payments ({payments.length})</TabsTrigger>
          <TabsTrigger value="fees" data-testid="tab-fees" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Fees ({feeList.length})</TabsTrigger>
          <TabsTrigger value="referrals" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Referrals ({referrals.length})</TabsTrigger>
          {isStaff && <TabsTrigger value="documents" data-testid="tab-documents" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Documents ({caseData.documents.length})</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="pt-6 space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <div className="min-w-0 space-y-4">
              <Card data-testid="card-contact-information">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Contact Information</CardTitle>
                  <CardDescription data-testid="contact-subheader">
                    {primaryRepresentative ? 'Family Representative' : 'Client'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  {client.isMinor && repsLoading ? (
                    <div className="space-y-3 animate-pulse" aria-label="Loading contact information">
                      <div className="h-4 w-2/3 rounded bg-muted" />
                      <div className="h-4 w-1/2 rounded bg-muted" />
                      <div className="h-4 w-3/4 rounded bg-muted" />
                    </div>
                  ) : client.isMinor && repsError ? (
                    <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                      <span>Contact information could not be loaded.</span>
                      <Button variant="outline" size="sm" onClick={() => refetchReps()} data-testid="button-retry-contact">Retry</Button>
                    </div>
                  ) : (
                    <>
                      <dl className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2">
                        {primaryRepresentative && (
                          <>
                            <dt className="text-muted-foreground">Name:</dt>
                            <dd className="min-w-0 break-words font-medium" data-testid="contact-name">{primaryRepresentative.name}</dd>
                          </>
                        )}
                        <dt className="text-muted-foreground">Phone:</dt>
                        <dd className="min-w-0 break-words" data-testid="contact-phone">{primaryRepresentative ? primaryRepresentative.phone || '-' : client.phone || '-'}</dd>
                        <dt className="text-muted-foreground">Email:</dt>
                        <dd className="min-w-0 break-all" data-testid="contact-email">{primaryRepresentative ? primaryRepresentative.email || '-' : client.email || '-'}</dd>
                        <dt className="text-muted-foreground">Address:</dt>
                        <dd className="min-w-0 break-words" data-testid="contact-address">{primaryRepresentative ? primaryRepresentative.address || '-' : client.address || '-'}</dd>
                        <dt className="text-muted-foreground">Preferred Language:</dt>
                        <dd className={`min-w-0 break-words ${!client.preferredLanguage?.trim() ? 'text-muted-foreground' : ''}`} data-testid="client-preferred-language">{client.preferredLanguage?.trim() || 'Not set'}</dd>
                      </dl>
                      {primaryRepresentative && (
                        <div className="flex flex-wrap gap-2 border-t pt-3" data-testid="contact-actions">
                          <RepresentativeEditAction clientId={client.id} rep={primaryRepresentative} />
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
              {showRepresentativesCard && (
                <Card data-testid="card-family-representatives">
                  <CardContent className="p-4 sm:p-6">
                    <FamilyRepresentativesSection
                      clientId={client.id}
                      representatives={remainingRepresentatives}
                      isLoading={repsLoading}
                      isError={repsError}
                      onRetry={() => refetchReps()}
                      primaryDisplayed={!!primaryRepresentative}
                    />
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="space-y-6">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-primary" /> Active Authorizations
              </h3>
              {authorizations.filter(a => a.status === 'active').length === 0 ? (
                <div className="text-muted-foreground text-sm p-4 border border-dashed rounded-md text-center">
                  No active authorizations
                </div>
              ) : (
                authorizations.filter(a => a.status === 'active').map(auth => {
                  const max = parseFloat(auth.maxPeriodAmount);
                  const paid = parseFloat(auth.totalPaid || '0');
                  const percent = max > 0 ? Math.min(100, (paid / max) * 100) : 0;
                  const isLow = auth.daysUntilExpiry != null && auth.daysUntilExpiry < 30;

                  return (
                    <Card key={auth.id} className={isLow ? 'border-chart-1/50' : ''}>
                      <CardContent className="p-4">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <p className="font-semibold">
                              <Link href={`/authorizations/${auth.id}`} className="text-primary hover:underline" data-testid="link-overview-authorization">
                                {auth.authNumber}
                              </Link>
                            </p>
                            <p className="text-xs text-muted-foreground line-clamp-1">
                              <VendorLink id={auth.vendorId} name={auth.vendorName} className="text-xs text-muted-foreground hover:underline" />
                            </p>
                          </div>
                          <Badge variant="outline">{auth.serviceCode}</Badge>
                        </div>
                        <div className="space-y-2 mt-4">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>Utilized: ${(paid).toFixed(2)}</span>
                            <span>Max: ${(max).toFixed(2)}</span>
                          </div>
                          <Progress value={percent} className="h-2" />
                          {isLow && (
                            <p className="text-xs text-chart-1 font-medium flex items-center gap-1 mt-2">
                              <AlertCircle className="w-3 h-3" /> Expires in {auth.daysUntilExpiry} days
                            </p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="authorizations" className="pt-6">
           <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortDirection={authorizationsSort.sort.key === 'authNumber' ? authorizationsSort.sort.direction : null} onSort={() => authorizationsSort.onSort('authNumber')}>Auth Number</SortableTableHead>
                    <SortableTableHead sortDirection={authorizationsSort.sort.key === 'vendorName' ? authorizationsSort.sort.direction : null} onSort={() => authorizationsSort.onSort('vendorName')}>Vendor</SortableTableHead>
                    <SortableTableHead sortDirection={authorizationsSort.sort.key === 'serviceCode' ? authorizationsSort.sort.direction : null} onSort={() => authorizationsSort.onSort('serviceCode')}>Code</SortableTableHead>
                    <SortableTableHead sortDirection={authorizationsSort.sort.key === 'servicePeriodStart' ? authorizationsSort.sort.direction : null} onSort={() => authorizationsSort.onSort('servicePeriodStart')}>Period</SortableTableHead>
                    <SortableTableHead className="text-right" sortDirection={authorizationsSort.sort.key === 'maxPeriodAmount' ? authorizationsSort.sort.direction : null} onSort={() => authorizationsSort.onSort('maxPeriodAmount')}>Max Amount</SortableTableHead>
                    <SortableTableHead sortDirection={authorizationsSort.sort.key === 'status' ? authorizationsSort.sort.direction : null} onSort={() => authorizationsSort.onSort('status')}>Status</SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedAuthorizations.map(auth => (
                    <TableRow key={auth.id}>
                      <TableCell className="font-medium">
                        <Link href={`/authorizations/${auth.id}`} className="text-primary hover:underline" data-testid="link-client-authorization">
                          {auth.authNumber}
                        </Link>
                      </TableCell>
                      <TableCell><VendorLink id={auth.vendorId} name={auth.vendorName} /></TableCell>
                      <TableCell>{auth.serviceCode}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {format(new Date(auth.servicePeriodStart), 'MM/dd/yy')} - {format(new Date(auth.servicePeriodEnd), 'MM/dd/yy')}
                      </TableCell>
                      <TableCell className="text-right">${parseFloat(auth.maxPeriodAmount).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={auth.status === 'active' ? 'border-chart-5 text-chart-5' : ''}>{auth.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  {authorizations.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No authorizations found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="invoices" className="pt-6">
           <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortDirection={invoicesSort.sort.key === 'serviceMonth' ? invoicesSort.sort.direction : null} onSort={() => invoicesSort.onSort('serviceMonth')}>Service Month</SortableTableHead>
                    <SortableTableHead sortDirection={invoicesSort.sort.key === 'vendorName' ? invoicesSort.sort.direction : null} onSort={() => invoicesSort.onSort('vendorName')}>Vendor</SortableTableHead>
                    <SortableTableHead sortDirection={invoicesSort.sort.key === 'authNumber' ? invoicesSort.sort.direction : null} onSort={() => invoicesSort.onSort('authNumber')}>Auth #</SortableTableHead>
                    <SortableTableHead className="text-right" sortDirection={invoicesSort.sort.key === 'amountRequested' ? invoicesSort.sort.direction : null} onSort={() => invoicesSort.onSort('amountRequested')}>Amount</SortableTableHead>
                    <SortableTableHead sortDirection={invoicesSort.sort.key === 'status' ? invoicesSort.sort.direction : null} onSort={() => invoicesSort.onSort('status')}>Status</SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedInvoices.map(inv => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">
                        <Link href={`/invoices/${inv.id}`} className="text-primary hover:underline" data-testid="link-client-invoice">
                          {getInvoiceDisplayMonth(inv)}
                        </Link>
                      </TableCell>
                      <TableCell><VendorLink id={inv.vendorId} name={inv.vendorName} /></TableCell>
                      <TableCell className="text-muted-foreground text-xs space-y-1">
                        {inv.lineItems && inv.lineItems.length > 0 ? (
                          Array.from(new Set(inv.lineItems.filter(l => l.authorizationId).map(l =>
                            JSON.stringify({ id: l.authorizationId, num: l.authNumber })
                          ))).map(str => JSON.parse(str)).map((auth: any, idx: number) => (
                            <div key={`${auth.id}-${idx}`}>
                              <Link href={`/authorizations/${auth.id}`} className="text-primary hover:underline">{auth.num}</Link>
                            </div>
                          ))
                        ) : (
                          inv.authorizationId ? (
                            <Link href={`/authorizations/${inv.authorizationId}`} className="text-primary hover:underline">{inv.authNumber}</Link>
                          ) : inv.authNumber || '-'
                        )}
                      </TableCell>
                      <TableCell className="text-right">${parseFloat(inv.amountRequested).toFixed(2)}</TableCell>
                      <TableCell><Badge variant="outline">{inv.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {invoices.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No invoices found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payments" className="pt-6">
          <div className="space-y-6">
           <div className="grid gap-4 sm:grid-cols-2">
             <Card data-testid="participant-remittance-matched-summary">
               <CardHeader className="pb-2"><CardDescription>Matched remittances</CardDescription><CardTitle>{matchedRemittances.length} · ${matchedRemittanceAmount.toFixed(2)}</CardTitle></CardHeader>
             </Card>
             <Card data-testid="participant-remittance-outstanding-summary">
               <CardHeader className="pb-2"><CardDescription>Outstanding remittances</CardDescription><CardTitle>{outstandingRemittances.length} · ${outstandingRemittanceAmount.toFixed(2)}</CardTitle></CardHeader>
             </Card>
           </div>
           <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortDirection={paymentsSort.sort.key === 'checkDate' ? paymentsSort.sort.direction : null} onSort={() => paymentsSort.onSort('checkDate')}>Date</SortableTableHead>
                    <SortableTableHead sortDirection={paymentsSort.sort.key === 'qbCheckNumber' ? paymentsSort.sort.direction : null} onSort={() => paymentsSort.onSort('qbCheckNumber')}>Check #</SortableTableHead>
                    <SortableTableHead sortDirection={paymentsSort.sort.key === 'vendorName' ? paymentsSort.sort.direction : null} onSort={() => paymentsSort.onSort('vendorName')}>Payee/Vendor</SortableTableHead>
                    <SortableTableHead sortDirection={paymentsSort.sort.key === 'authNumber' ? paymentsSort.sort.direction : null} onSort={() => paymentsSort.onSort('authNumber')}>Auth #</SortableTableHead>
                    <SortableTableHead sortDirection={paymentsSort.sort.key === 'serviceMonth' ? paymentsSort.sort.direction : null} onSort={() => paymentsSort.onSort('serviceMonth')}>Service Month</SortableTableHead>
                    <SortableTableHead className="text-right" sortDirection={paymentsSort.sort.key === 'amount' ? paymentsSort.sort.direction : null} onSort={() => paymentsSort.onSort('amount')}>Amount</SortableTableHead>
                    <SortableTableHead sortDirection={paymentsSort.sort.key === 'remitted' ? paymentsSort.sort.direction : null} onSort={() => paymentsSort.onSort('remitted')}>Remitted</SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedPayments.map(p => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap">{format(new Date(p.checkDate), 'MMM d, yyyy')}</TableCell>
                      <TableCell className="font-mono text-sm">
                        <Link href={`/payments/${p.id}`} className="text-primary hover:underline" data-testid="link-client-payment">
                          {p.qbCheckNumber}
                        </Link>
                      </TableCell>
                      <TableCell><VendorLink id={p.vendorId} name={p.vendorName} /></TableCell>
                      <TableCell className="text-muted-foreground text-xs space-y-1">
                        {p.allocations && p.allocations.length > 0 ? (
                          Array.from(new Set(p.allocations.filter(a => a.authorizationId).map(a =>
                            JSON.stringify({ id: a.authorizationId, num: a.authNumber })
                          ))).map(str => JSON.parse(str)).map((auth: any, idx: number) => (
                            <div key={`${auth.id}-${idx}`}>
                              <Link href={`/authorizations/${auth.id}`} className="text-primary hover:underline">{auth.num}</Link>
                            </div>
                          ))
                        ) : (
                          p.authorizationId ? (
                            <Link href={`/authorizations/${p.authorizationId}`} className="text-primary hover:underline">{p.authNumber}</Link>
                          ) : p.authNumber || '-'
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap" data-testid={`text-client-payment-service-month-${p.id}`}>{formatPaymentServiceMonths(p)}</TableCell>
                      <TableCell className="text-right font-medium">${parseFloat(p.amount).toFixed(2)}</TableCell>
                      <TableCell>{p.remitted ? <CheckCircle2 className="w-4 h-4 text-chart-5" /> : '-'}</TableCell>
                    </TableRow>
                  ))}
                  {payments.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No payments found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
           <Card>
             <CardHeader className="flex flex-row items-center justify-between gap-4">
               <div>
                 <CardTitle className="text-lg">Remittances</CardTitle>
                 <CardDescription>Participant reimbursements and their current matching status.</CardDescription>
               </div>
               {isStaff && <CreateRemittanceDialog preselectedClientId={id} onSaved={() => refetch()} />}
             </CardHeader>
             <CardContent className="p-0">
               <Table>
                 <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Reference</TableHead><TableHead>Auth #</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                 <TableBody>
                   {remittances.map((remittance) => (
                     <TableRow key={remittance.id}>
                       <TableCell className="whitespace-nowrap">{format(new Date(remittance.remittanceDate), 'MMM d, yyyy')}</TableCell>
                       <TableCell className="font-mono text-sm">{remittance.altaReference || '—'}</TableCell>
                       <TableCell>{remittance.authorizationId ? <Link href={`/authorizations/${remittance.authorizationId}`} className="text-primary hover:underline">{remittance.authNumber}</Link> : (remittance.authNumber || '—')}</TableCell>
                       <TableCell className="text-right font-medium">
                         ${Number(remittance.amount).toFixed(2)}
                         <div className="text-xs font-normal text-muted-foreground">${Number(remittance.remainingAmount ?? remittance.amount).toFixed(2)} remaining</div>
                       </TableCell>
                       <TableCell><Badge variant="outline" className={remittance.status === 'matched' ? 'bg-chart-5/10 text-chart-5 border-chart-5/20' : remittance.status === 'pending' ? 'bg-chart-2/10 text-chart-2 border-chart-2/20' : ''}>{remittance.status}</Badge></TableCell>
                       <TableCell className="text-right"><Button variant="ghost" size="sm" asChild><Link href={`/remittances/${remittance.id}`}>View</Link></Button></TableCell>
                     </TableRow>
                   ))}
                   {remittances.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No remittances found for this participant.</TableCell></TableRow>}
                 </TableBody>
               </Table>
             </CardContent>
           </Card>
          </div>
        </TabsContent>

        <TabsContent value="fees" className="pt-6" data-testid="content-fees">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Fees</CardTitle>
              <CardDescription>
                Fees auto-generated when payments are logged. The current 5% rule is an interim
                placeholder pending CEPS confirmation.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortDirection={feesSort.sort.key === 'createdAt' ? feesSort.sort.direction : null} onSort={() => feesSort.onSort('createdAt')}>Date</SortableTableHead>
                    <SortableTableHead className="text-right" sortDirection={feesSort.sort.key === 'amount' ? feesSort.sort.direction : null} onSort={() => feesSort.onSort('amount')}>Amount</SortableTableHead>
                    <SortableTableHead sortDirection={feesSort.sort.key === 'ruleApplied' ? feesSort.sort.direction : null} onSort={() => feesSort.onSort('ruleApplied')}>Rule</SortableTableHead>
                    <SortableTableHead sortDirection={feesSort.sort.key === 'status' ? feesSort.sort.direction : null} onSort={() => feesSort.onSort('status')}>Status</SortableTableHead>
                    {isStaff && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedFees.map(fee => (
                    <TableRow key={fee.id}>
                      <TableCell className="whitespace-nowrap">
                        {fee.createdAt ? format(new Date(fee.createdAt), 'MMM d, yyyy') : '-'}
                      </TableCell>
                      <TableCell className="text-right font-medium">${parseFloat(fee.amount).toFixed(2)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">{fee.ruleApplied || '-'}</TableCell>
                      <TableCell><Badge variant="outline">{fee.status}</Badge></TableCell>
                      {isStaff && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <EditFeeDialog id={fee.id} fee={fee} onSaved={() => refetchFees()} />
                            <DeleteEntityButton
                              entityLabel="Fee"
                              testId={`button-delete-fee-${fee.id}`}
                              onDelete={() => deleteFee.mutateAsync({ id: fee.id })}
                              onDeleted={() => refetchFees()}
                            />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  {feeList.length === 0 && (
                    <TableRow><TableCell colSpan={isStaff ? 5 : 4} className="text-center py-8 text-muted-foreground">No fees found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="referrals" className="pt-6">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortDirection={referralsSort.sort.key === 'referralDate' ? referralsSort.sort.direction : null} onSort={() => referralsSort.onSort('referralDate')}>Date</SortableTableHead>
                    <SortableTableHead sortDirection={referralsSort.sort.key === 'coordinatorName' ? referralsSort.sort.direction : null} onSort={() => referralsSort.onSort('coordinatorName')}>Coordinator</SortableTableHead>
                    <SortableTableHead sortDirection={referralsSort.sort.key === 'status' ? referralsSort.sort.direction : null} onSort={() => referralsSort.onSort('status')}>Status</SortableTableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedReferrals.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium whitespace-nowrap">{format(new Date(r.referralDate), 'MMM d, yyyy')}</TableCell>
                      <TableCell>{r.coordinatorName}</TableCell>
                      <TableCell><Badge variant="outline">{r.status}</Badge></TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/referrals/${r.id}`}>View</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {referrals.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No referrals found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {isStaff && (
          <TabsContent value="documents" className="pt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Case Documents</CardTitle>
                <CardDescription>Documents and tracked requirements associated with this participant's referrals, authorizations, invoices, and vendors.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Record</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {caseData.documents.map((doc) => (
                      <TableRow key={doc.id} data-testid={`row-document-${doc.id}`}>
                        <TableCell className="font-medium max-w-[200px] truncate" title={doc.name} data-testid={`text-document-name-${doc.id}`}>{doc.name}</TableCell>
                        <TableCell className="capitalize">{doc.category.replace(/_/g, ' ')}</TableCell>
                        <TableCell>
                          {doc.recordType === 'authorization' && <Link href={`/authorizations/${doc.recordId}`} className="text-primary hover:underline">{doc.recordLabel}</Link>}
                          {doc.recordType === 'invoice' && <Link href={`/invoices/${doc.recordId}`} className="text-primary hover:underline">{doc.recordLabel}</Link>}
                          {doc.recordType === 'referral' && <Link href={`/referrals/${doc.recordId}`} className="text-primary hover:underline">{doc.recordLabel}</Link>}
                          {doc.recordType === 'vendor' && <VendorLink id={doc.recordId} name={doc.recordLabel} />}
                        </TableCell>
                        <TableCell className="align-middle">
                          <DocumentStatusGroup document={doc} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {doc.statusDate ? format(new Date(doc.statusDate), 'MMM d, yyyy') : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {doc.objectPath ? (
                            <ViewDocumentDialog document={doc} />
                          ) : (
                            <span className="text-xs text-muted-foreground">No file</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {caseData.documents.length === 0 && (
                      <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No documents found.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}

      </Tabs>
    </div>
  );
}
