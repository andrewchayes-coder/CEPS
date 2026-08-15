import React from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export const PAGE_SIZE = 50;

export function ReportPagination({
  page,
  pageCount,
  total,
  setPage,
  testid,
}: {
  page: number;
  pageCount: number;
  total: number;
  setPage: (fn: (p: number) => number) => void;
  testid: string;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t">
      <p className="text-sm text-muted-foreground" data-testid={`text-${testid}-pagination`}>
        {total === 0
          ? 'No entries'
          : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          data-testid={`button-${testid}-prev`}
        >
          <ChevronLeft className="w-4 h-4 mr-1" /> Previous
        </Button>
        <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          disabled={page >= pageCount - 1}
          data-testid={`button-${testid}-next`}
        >
          Next <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
