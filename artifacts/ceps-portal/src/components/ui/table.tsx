import * as React from 'react';
import { cn } from '@/lib/utils';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

type SortDirection = 'asc' | 'desc';

type TableSort<Key extends string> = {
  sortBy?: Key;
  sortDirection?: SortDirection;
};

function useTableSort<Key extends string>(initial?: TableSort<Key>) {
  const [sort, setSort] = React.useState<TableSort<Key>>(initial ?? {});

  const toggleSort = React.useCallback((key: Key) => {
    setSort((current) => {
      if (current.sortBy !== key) return { sortBy: key, sortDirection: 'asc' };
      if (current.sortDirection === 'asc') return { sortBy: key, sortDirection: 'desc' };
      return {};
    });
  }, []);

  return { ...sort, toggleSort };
}

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table
      ref={ref}
      className={cn('w-full caption-bottom text-sm', className)}
      {...props}
    />
  </div>
));
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      'border-t bg-muted/50 font-medium [&>tr]:last:border-b-0',
      className,
    )}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

type SortableTableHeadProps<Key extends string> =
  React.ThHTMLAttributes<HTMLTableCellElement> & {
    label?: string;
    sortKey?: Key;
    activeSortBy?: Key;
    sortDirection?: SortDirection | null;
    onSort: (key: Key) => void;
  };

function SortableTableHead<Key extends string>({
  label,
  sortKey,
  activeSortBy,
  sortDirection,
  onSort,
  className,
  children,
  ...props
}: SortableTableHeadProps<Key>) {
  const active = sortKey ? activeSortBy === sortKey : sortDirection != null;
  const ariaSort = active
    ? sortDirection === 'desc' ? 'descending' : 'ascending'
    : undefined;
  const Icon = !active ? ChevronsUpDown : sortDirection === 'desc' ? ArrowDown : ArrowUp;
  const accessibleLabel = label ?? (typeof children === 'string' ? children : 'column');

  return (
    <TableHead aria-sort={ariaSort} className={className} {...props}>
      <button
        type="button"
        className={cn(
          'inline-flex w-full items-center gap-1 rounded-sm py-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          className?.includes('text-right') && 'justify-end',
        )}
        onClick={() => sortKey ? onSort(sortKey) : (onSort as () => void)()}
        data-testid={sortKey ? `button-sort-${sortKey}` : undefined}
        aria-label={`Sort by ${accessibleLabel}${active ? `, currently ${ariaSort}` : ''}`}
      >
        <span>{label ?? children}</span>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>
    </TableHead>
  );
}

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      'p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
      className,
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('mt-4 text-sm text-muted-foreground', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  SortableTableHead,
  useTableSort,
};
export type { SortDirection, TableSort };
