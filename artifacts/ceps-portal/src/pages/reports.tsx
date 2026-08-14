import React from 'react';
import { useGetVendorPaymentReport } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ReportsPage() {
  const currentYear = new Date().getFullYear();
  const { data: report, isLoading } = useGetVendorPaymentReport({ year: currentYear }, {
    query: { queryKey: ['vendorReport', currentYear] }
  });

  const downloadCSV = () => {
    if (!report) return;
    
    const headers = ['Vendor Name', 'YTD Total Paid', 'W-9 Status'];
    const rows = report.map((v: any) => [
      v.vendorName,
      v.totalPaid,
      v.einOnFile ? 'On File' : 'Pending'
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map((e: any[]) => e.join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `vendor_payments_ytd_${currentYear}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports & Analytics</h1>
          <p className="text-muted-foreground mt-1">Financial and operational reporting.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4 border-b">
          <div>
            <CardTitle>Vendor Payments YTD ({currentYear})</CardTitle>
            <CardDescription>Summary of all payments issued to vendors this year.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={downloadCSV} disabled={!report}>
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
                    <TableCell className="font-medium">{v.vendorName}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{v.einOnFile ? 'On File' : 'Pending'}</TableCell>
                    <TableCell className="text-right font-bold text-primary">${parseFloat(v.totalPaid).toFixed(2)}</TableCell>
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
