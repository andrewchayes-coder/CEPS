import React, { useState } from 'react';
import { useListReferrals } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, Plus, Search, Filter } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export default function ReferralsPage() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const { data: referrals, isLoading } = useListReferrals(undefined, {
    query: {
      queryKey: ['referrals', statusFilter]
    }
  });

  // Client-side search filtering (since API doesn't have a search param yet)
  const filteredReferrals = referrals?.filter(r => {
    const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
    const matchesSearch = search === '' || 
      r.clientName?.toLowerCase().includes(search.toLowerCase()) ||
      r.coordinatorName?.toLowerCase().includes(search.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Referrals</h1>
          <p className="text-muted-foreground mt-1">Manage and track service referrals.</p>
        </div>
        {(user?.role === 'staff' || user?.role === 'service_coordinator') && (
          <Button asChild>
            <Link href="/referrals/new">
              <Plus className="mr-2 h-4 w-4" />
              New Referral
            </Link>
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative w-full sm:max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search clients or coordinators..."
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="intake">Intake</SelectItem>
                  <SelectItem value="pending_signature">Pending Signature</SelectItem>
                  <SelectItem value="pending_auth">Pending POS</SelectItem>
                  <SelectItem value="pending_w9">Pending W-9</SelectItem>
                  <SelectItem value="pending_invoice">Pending Invoice</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Coordinator</TableHead>
                <TableHead>Service Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <ReferralsTableSkeleton />
              ) : filteredReferrals?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No referrals found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredReferrals?.map((referral) => (
                  <TableRow key={referral.id}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {format(new Date(referral.referralDate), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell>
                      {referral.clientName || 'Unknown Client'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {referral.coordinatorName || 'Unassigned'}
                    </TableCell>
                    <TableCell>
                      {referral.intakeFields?.serviceType === 'direct_pay_459' 
                        ? 'Direct Pay (459)' 
                        : referral.intakeFields?.serviceType === 'reimbursement_024'
                          ? 'Reimbursement (024)'
                          : 'Unknown'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={referral.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/referrals/${referral.id}`}>View</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'intake':
      return <Badge variant="outline" className="bg-slate-100 text-slate-700 hover:bg-slate-100">Intake</Badge>;
    case 'pending_signature':
      return <Badge variant="outline" className="bg-chart-2/10 text-chart-2 hover:bg-chart-2/10 border-chart-2/20">Pending Signature</Badge>;
    case 'pending_auth':
      return <Badge variant="outline" className="bg-chart-3/10 text-chart-3 hover:bg-chart-3/10 border-chart-3/20">Pending POS</Badge>;
    case 'pending_w9':
      return <Badge variant="outline" className="bg-destructive/10 text-destructive hover:bg-destructive/10 border-destructive/20">Pending W-9</Badge>;
    case 'pending_invoice':
      return <Badge variant="outline" className="bg-chart-4/10 text-chart-4 hover:bg-chart-4/10 border-chart-4/20">Pending Invoice</Badge>;
    case 'active':
      return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 hover:bg-chart-5/10 border-chart-5/20">Active</Badge>;
    case 'closed':
      return <Badge variant="secondary">Closed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function ReferralsTableSkeleton() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-28" /></TableCell>
          <TableCell><Skeleton className="h-5 w-24 rounded-full" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
