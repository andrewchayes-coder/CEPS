import React, { useState } from 'react';
import { useGetDashboardSummary } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle,
  CardFooter
} from '@/components/ui/card';
import {
  FileText,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Users,
  Building2,
  Receipt,
  FileCheck,
  FolderSync
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export default function DashboardPage() {
  const { user } = useAuth();
  const { data: summary, isLoading, error } = useGetDashboardSummary();

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (error || !summary) {
    return (
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Failed to load dashboard</CardTitle>
          <CardDescription>There was an error loading your summary data.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const activeReferrals = summary.referralsByStatus.find(s => s.status === 'active')?.count || 0;
  const pendingReferrals = summary.referralsByStatus.reduce((acc, curr) => 
    curr.status.startsWith('pending') ? acc + curr.count : acc, 0
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Welcome back, {user?.name.split(' ')[0]}</h1>
        <p className="text-muted-foreground mt-1">
          {user?.role === 'staff' ? 'Here is what is happening across all programs today.' : 
           user?.role === 'service_coordinator' ? 'Here is the current status of your caseload.' :
           'Here is your account overview.'}
        </p>
      </div>

      {/* Alerts Section (High Priority) */}
      {summary.alerts && summary.alerts.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {summary.alerts.map((alert, i) => (
            <Card key={i} className={`border-l-4 ${getAlertBorderColor(alert.kind)}`}>
              <CardContent className="p-4 flex gap-4 items-start">
                <div className={`mt-0.5 ${getAlertIconColor(alert.kind)}`}>
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{alert.message}</p>
                </div>
                <Button variant="ghost" size="sm" asChild className="shrink-0 -mr-2 -mt-2">
                  <Link href={getAlertLink(alert.kind)}>View</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {(user?.role === 'staff' || user?.role === 'service_coordinator') && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Active Referrals</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeReferrals}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {pendingReferrals} pending processing
              </p>
              {user?.role === 'staff' && (
                <Link href="/reports?tab=case-status" className="text-xs text-primary hover:underline mt-2 inline-block" data-testid="link-tile-case-status">
                  View case status →
                </Link>
              )}
            </CardContent>
          </Card>
        )}

        {(user?.role === 'staff' || user?.role === 'service_coordinator') && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Total Clients</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totals.activeClients}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Across all programs
              </p>
            </CardContent>
          </Card>
        )}

        {user?.role === 'staff' && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Active Authorizations</CardTitle>
              <FileCheck className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totals.activeAuthorizations}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {summary.totals.vendorsMissingW9} vendors missing W-9
              </p>
              <div className="flex gap-3 mt-2">
                <Link href="/reports?tab=expiring-auth" className="text-xs text-primary hover:underline inline-block" data-testid="link-tile-expiring-auth">
                  Expiring →
                </Link>
                <Link href="/reports?tab=missing-docs&docType=w9" className="text-xs text-primary hover:underline inline-block" data-testid="link-tile-missing-w9">
                  Missing W-9 →
                </Link>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium">Pending Invoices</CardTitle>
            <Receipt className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.totals.pendingInvoices}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Awaiting review and approval
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Recent Activity */}
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest updates across your records</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {summary.recentActivity && summary.recentActivity.length > 0 ? (
                summary.recentActivity.slice(0, 5).map((activity, i) => (
                  <div key={i} className="flex items-start gap-4">
                    <div className="mt-0.5 rounded-full p-1 bg-secondary text-muted-foreground shrink-0">
                      {getActivityIcon(activity.action)}
                    </div>
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-medium leading-none capitalize">{activity.action.replace(/_/g, ' ')}</p>
                      {activity.detail && <p className="text-sm text-muted-foreground">{activity.detail}</p>}
                      <p className="text-xs text-muted-foreground">
                        {new Date(activity.createdAt).toLocaleDateString(undefined, { 
                          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' 
                        })}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No recent activity to show.
                </div>
              )}
            </div>
          </CardContent>
          <CardFooter className="border-t pt-4">
            <Button variant="outline" className="w-full" asChild>
              <Link href="/reports">View All Reports</Link>
            </Button>
          </CardFooter>
        </Card>

        {/* Action Center */}
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common tasks and workflows</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {(user?.role === 'staff' || user?.role === 'service_coordinator') && (
              <Button className="w-full justify-start h-12" asChild>
                <Link href="/referrals/new">
                  <FileText className="mr-2 h-5 w-5" />
                  Submit New Referral
                </Link>
              </Button>
            )}
            
            {user?.role === 'staff' && (
              <>
                <Button variant="secondary" className="w-full justify-start h-12" asChild>
                  <Link href="/authorizations/new">
                    <FileCheck className="mr-2 h-5 w-5" />
                    Enter New Authorization (POS)
                  </Link>
                </Button>
                <Button variant="secondary" className="w-full justify-start h-12" asChild>
                  <Link href="/remittances">
                    <FolderSync className="mr-2 h-5 w-5" />
                    Process Alta Remittance
                  </Link>
                </Button>
              </>
            )}

            <Button variant="outline" className="w-full justify-start h-12" asChild>
              <Link href="/invoices/new">
                <Receipt className="mr-2 h-5 w-5" />
                Submit Invoice
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-9 w-64 mb-2" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map(i => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="col-span-1">
          <CardHeader>
            <Skeleton className="h-6 w-32 mb-2" />
            <Skeleton className="h-4 w-48" />
          </CardHeader>
          <CardContent className="space-y-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex gap-4">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Helpers
function getAlertBorderColor(type: string) {
  switch (type) {
    case 'expiring_authorization': return 'border-chart-1';
    case 'missing_document': return 'border-destructive';
    case 'pending_w9': return 'border-destructive';
    case 'unmatched_remittance': return 'border-chart-2';
    case 'pending_signature': return 'border-chart-4';
    default: return 'border-primary';
  }
}

function getAlertIconColor(type: string) {
  switch (type) {
    case 'expiring_authorization': return 'text-chart-1';
    case 'missing_document': return 'text-destructive';
    case 'pending_w9': return 'text-destructive';
    case 'unmatched_remittance': return 'text-chart-2';
    case 'pending_signature': return 'text-chart-4';
    default: return 'text-primary';
  }
}

function getAlertLink(type: string) {
  switch (type) {
    case 'expiring_authorization': return '/reports?tab=expiring-auth';
    case 'missing_document': return '/reports?tab=missing-docs';
    case 'pending_w9': return '/reports?tab=missing-docs&docType=w9';
    case 'pending_signature': return '/reports?tab=missing-docs&docType=signature';
    case 'unmatched_remittance': return '/remittances';
    default: return '/';
  }
}

function getActivityIcon(type: string) {
  if (type.includes('referral')) return <FileText className="h-4 w-4" />;
  if (type.includes('authorization')) return <FileCheck className="h-4 w-4" />;
  if (type.includes('invoice')) return <Receipt className="h-4 w-4" />;
  if (type.includes('payment')) return <CheckCircle2 className="h-4 w-4" />;
  return <Clock className="h-4 w-4" />;
}
