import React, { useState } from 'react';
import { useListRemittances } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';

export default function RemittancesPage() {
  const { data: remittances, isLoading } = useListRemittances();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Alta Remittances</h1>
        <p className="text-muted-foreground mt-1">Reconciliation of funds received from Alta Regional Center.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date Received</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Auth #</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center"><Skeleton className="h-4 w-full max-w-sm mx-auto" /></TableCell></TableRow>
              ) : remittances?.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No remittances found.</TableCell></TableRow>
              ) : (
                remittances?.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{format(new Date(r.remittanceDate), 'MMM d, yyyy')}</TableCell>
                    <TableCell className="font-mono text-sm">{r.altaReference}</TableCell>
                    <TableCell>{r.clientName}</TableCell>
                    <TableCell className="text-muted-foreground">{r.authNumber}</TableCell>
                    <TableCell className="text-right font-medium">${parseFloat(r.amount).toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={
                        r.status === 'matched' ? 'bg-chart-5/10 text-chart-5 border-chart-5/20' :
                        r.status === 'pending' ? 'bg-chart-2/10 text-chart-2 border-chart-2/20' : ''
                      }>
                        {r.status}
                      </Badge>
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
