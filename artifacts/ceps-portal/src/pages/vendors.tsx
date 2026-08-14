import React, { useState } from 'react';
import { useListVendors } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { 
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow 
} from '@/components/ui/table';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export default function VendorsPage() {
  const [search, setSearch] = useState('');
  const { data: vendors, isLoading } = useListVendors();

  const filteredVendors = vendors?.filter(v => 
    v.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Vendors</h1>
          <p className="text-muted-foreground mt-1">Manage vendor profiles and W-9 compliance.</p>
        </div>
        <Button asChild>
          <Link href="/vendors/new">
            <Plus className="mr-2 h-4 w-4" />
            Add Vendor
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="relative w-full sm:max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search vendors..."
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
                <TableHead>Vendor Name</TableHead>
                <TableHead>Contact Info</TableHead>
                <TableHead>W-9 Status</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <VendorsTableSkeleton />
              ) : filteredVendors?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No vendors found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredVendors?.map((vendor) => (
                  <TableRow key={vendor.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {vendor.name}
                        {vendor.preferred && <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary/20 border-0">Preferred</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="text-muted-foreground">{vendor.email || '-'}</div>
                      <div className="text-muted-foreground">{vendor.phone || '-'}</div>
                    </TableCell>
                    <TableCell>
                      {vendor.w9Status === 'on_file' ? (
                        <div className="flex items-center gap-1.5 text-chart-5 text-sm font-medium">
                          <CheckCircle2 className="w-4 h-4" /> On File
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-destructive text-sm font-medium">
                          <AlertTriangle className="w-4 h-4" /> Pending W-9
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={vendor.active ? '' : 'bg-muted text-muted-foreground'}>
                        {vendor.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/vendors/${vendor.id}`}>View</Link>
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

function VendorsTableSkeleton() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-48" /></TableCell>
          <TableCell><div className="space-y-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-3 w-24" /></div></TableCell>
          <TableCell><Skeleton className="h-4 w-24 rounded-full" /></TableCell>
          <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
