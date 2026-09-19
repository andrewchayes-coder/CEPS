import React, { useState } from 'react';
import { useListClients } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead, useTableSort } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ClientLink } from '@/components/entity-links';
import { DateRangeFilter } from '@/components/date-range-filter';
import { useDebounce } from '@/hooks/use-debounce';

const PAGE_SIZE = 50;

export default function ClientsPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [startDate, setStartDate] = useState<string>();
  const [endDate, setEndDate] = useState<string>();
  const [page, setPage] = useState(0);
  const sort = useTableSort<'name' | 'uciNumber' | 'dateOfBirth' | 'assignedCoordinatorName' | 'status'>();
  const onSort = (key: Parameters<typeof sort.toggleSort>[0]) => {
    sort.toggleSort(key);
    setPage(0);
  };

  // Server-driven search (name + UCI) + pagination — mirrors the audit-log page.
  const params = {
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(sort.sortBy ? { sortBy: sort.sortBy, sortDirection: sort.sortDirection } : {}),
  };
  const { data, isLoading } = useListClients(params, {
    query: { queryKey: ['clients', params] },
  });
  const clients = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const onSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Participants</h1>
          <p className="text-muted-foreground mt-1">Manage participant records and service history.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search by name or UCI..."
                className="pl-8"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-auto">
              <DateRangeFilter
                label="Created date"
                startDate={startDate}
                endDate={endDate}
                onChange={(range) => {
                  setStartDate(range.startDate);
                  setEndDate(range.endDate);
                  setPage(0);
                }}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Name" sortKey="name" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="UCI Number" sortKey="uciNumber" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="DOB" sortKey="dateOfBirth" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Coordinator" sortKey="assignedCoordinatorName" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Status" sortKey="status" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <ClientsTableSkeleton />
              ) : !clients || clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No participants found.
                  </TableCell>
                </TableRow>
              ) : (
                clients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-medium">
                      <ClientLink id={client.id} name={`${client.firstName} ${client.lastName}`} />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{client.uciNumber}</TableCell>
                    <TableCell>{client.dateOfBirth}</TableCell>
                    <TableCell className="text-muted-foreground">{client.assignedCoordinatorName || 'Unassigned'}</TableCell>
                    <TableCell>
                      <Badge variant={client.status === 'active' ? 'default' : 'secondary'} className={client.status === 'active' ? 'bg-chart-5 text-white hover:bg-chart-5/90' : ''}>
                        {client.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/clients/${client.id}`}>View Case</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-clients-pagination">
              {total === 0
                ? 'No participants'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} participants`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-clients-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-clients-next"
              >
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ClientsTableSkeleton() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
