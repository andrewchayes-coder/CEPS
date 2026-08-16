import React from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetClientCase, useListFees, useDeleteClient, useDeleteFee } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { InvitePortalDialog } from '@/components/invite-portal-dialog';
import { EditClientDialog } from '@/components/edit-client-dialog';
import { EditContactInfoDialog } from '@/components/edit-contact-info-dialog';
import { EditFeeDialog } from '@/components/edit-fee-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, User, FileText, FileCheck, Receipt, CreditCard, FolderSync, AlertCircle, CheckCircle2, Phone, Mail, MapPin } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const isFamily = user?.role === 'parent_guardian' || user?.role === 'self';
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

  if (isLoading) return <div className="p-8 text-center">Loading case record...</div>;
  if (!caseData) return <div className="p-8 text-center">Client not found.</div>;

  const { client, authorizations, invoices, payments, remittances, referrals } = caseData;
  const feeList = fees ?? [];

  return (
    <div className="space-y-6 pb-10">
      {(user?.role === 'staff' || user?.role === 'service_coordinator') && (
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link href="/clients"><ArrowLeft className="w-4 h-4 mr-2" /> Back to Clients</Link>
        </Button>
      )}

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-6 rounded-lg border shadow-sm">
        <div className="flex items-center gap-4 min-w-0">
          <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center shrink-0">
            <User className="h-8 w-8 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">{client.firstName} {client.lastName}</h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              <span className="font-mono bg-muted px-1.5 py-0.5 rounded">UCI: {client.uciNumber}</span>
              <span>DOB: {client.dateOfBirth}</span>
            </div>
            {isFamily && (
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
                entityLabel="Client"
                testId="button-delete-client"
                onDelete={() => deleteClient.mutateAsync({ id })}
                onDeleted={() => navigate('/clients')}
              />
            </div>
          )}
        </div>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto border-b rounded-none h-12 bg-transparent p-0">
          <TabsTrigger value="overview" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Overview</TabsTrigger>
          <TabsTrigger value="authorizations" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Authorizations ({authorizations.length})</TabsTrigger>
          <TabsTrigger value="invoices" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Invoices ({invoices.length})</TabsTrigger>
          <TabsTrigger value="payments" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Payments ({payments.length})</TabsTrigger>
          <TabsTrigger value="fees" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Fees ({feeList.length})</TabsTrigger>
          <TabsTrigger value="referrals" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-6">Referrals ({referrals.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-6 space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Contact Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="grid grid-cols-3 gap-1">
                  <span className="text-muted-foreground">Phone:</span>
                  <span className="col-span-2">{client.phone || '-'}</span>
                  <span className="text-muted-foreground">Email:</span>
                  <span className="col-span-2">{client.email || '-'}</span>
                  <span className="text-muted-foreground">Address:</span>
                  <span className="col-span-2">{client.address || '-'}</span>
                </div>
                {client.isMinor && (
                  <div className="pt-4 border-t mt-4">
                    <p className="font-medium text-primary mb-2 flex items-center gap-2">
                      <User className="w-4 h-4" /> Family Representative
                    </p>
                    <div className="grid grid-cols-3 gap-1">
                      <span className="text-muted-foreground">Name:</span>
                      <span className="col-span-2">{client.familyRepName}</span>
                      <span className="text-muted-foreground">Email:</span>
                      <span className="col-span-2">{client.familyRepEmail || '-'}</span>
                      <span className="text-muted-foreground">Phone:</span>
                      <span className="col-span-2">{client.familyRepPhone || '-'}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

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
                            <p className="font-semibold text-primary">{auth.authNumber}</p>
                            <p className="text-xs text-muted-foreground line-clamp-1">{auth.vendorName}</p>
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
                    <TableHead>Auth Number</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Max Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {authorizations.map(auth => (
                    <TableRow key={auth.id}>
                      <TableCell className="font-medium text-primary">{auth.authNumber}</TableCell>
                      <TableCell>{auth.vendorName}</TableCell>
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
                    <TableHead>Service Month</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Auth #</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map(inv => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.serviceMonth}</TableCell>
                      <TableCell>{inv.vendorName}</TableCell>
                      <TableCell className="text-muted-foreground">{inv.authNumber}</TableCell>
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
           <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Check #</TableHead>
                    <TableHead>Payee/Vendor</TableHead>
                    <TableHead>Auth #</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Remitted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map(p => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap">{format(new Date(p.checkDate), 'MMM d, yyyy')}</TableCell>
                      <TableCell className="font-mono text-sm">{p.qbCheckNumber}</TableCell>
                      <TableCell>{p.vendorName}</TableCell>
                      <TableCell className="text-muted-foreground">{p.authNumber}</TableCell>
                      <TableCell className="text-right font-medium">${parseFloat(p.amount).toFixed(2)}</TableCell>
                      <TableCell>{p.remitted ? <CheckCircle2 className="w-4 h-4 text-chart-5" /> : '-'}</TableCell>
                    </TableRow>
                  ))}
                  {payments.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No payments found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fees" className="pt-6">
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
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead>Status</TableHead>
                    {isStaff && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feeList.map(fee => (
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
                    <TableHead>Date</TableHead>
                    <TableHead>Coordinator</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {referrals.map(r => (
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

      </Tabs>
    </div>
  );
}
