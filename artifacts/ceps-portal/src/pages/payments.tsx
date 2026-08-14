import React, { useState } from 'react';
import { useListPayments } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { Search, CheckCircle2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export default function PaymentsPage() {
  const [search, setSearch] = useState('');
  const { data: payments, isLoading } = useListPayments();

  const filtered = payments?.filter(p => 
    p.vendorName?.toLowerCase().includes(search.toLowerCase()) ||
    p.clientName?.toLowerCase().includes(search.toLowerCase()) ||
    p.qbCheckNumber.includes(search)
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Payments Log</h1>
        <p className="text-muted-foreground mt-1">Record of checks issued from QuickBooks.</p>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="relative w-full sm:max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search by vendor, client, or check #..."
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Check #</TableHead>
                <TableHead>Payee (Vendor)</TableHead>
                <TableHead>Client</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Remitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center"><Skeleton className="h-4 w-full max-w-sm mx-auto" /></TableCell></TableRow>
              ) : filtered?.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No payments found.</TableCell></TableRow>
              ) : (
                filtered?.map(p => (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap">{format(new Date(p.checkDate), 'MMM d, yyyy')}</TableCell>
                    <TableCell className="font-mono text-sm">{p.qbCheckNumber}</TableCell>
                    <TableCell>{p.vendorName}</TableCell>
                    <TableCell className="text-muted-foreground">{p.clientName}</TableCell>
                    <TableCell className="text-right font-medium">${parseFloat(p.amount).toFixed(2)}</TableCell>
                    <TableCell>
                      {p.remitted ? <CheckCircle2 className="w-5 h-5 text-chart-5" /> : <span className="text-muted-foreground">-</span>}
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
