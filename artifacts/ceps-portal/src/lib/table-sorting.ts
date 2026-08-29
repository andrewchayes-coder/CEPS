import { useState } from 'react';

export type SortDirection = 'asc' | 'desc';
export type SortValue = string | number | boolean | Date | null | undefined;

export interface TableSort<Key extends string> {
  key: Key;
  direction: SortDirection;
}

export function useTableSort<Key extends string>(
  initialKey: Key,
  initialDirection: SortDirection = 'asc',
) {
  const [sort, setSort] = useState<TableSort<Key>>({
    key: initialKey,
    direction: initialDirection,
  });

  const onSort = (key: Key) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  return { sort, onSort };
}

function compareValues(a: SortValue, b: SortValue): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function stableSort<T, Key extends string>(
  rows: readonly T[],
  sort: TableSort<Key>,
  values: Record<Key, (row: T) => SortValue>,
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = values[sort.key](a.row);
      const right = values[sort.key](b.row);
      const leftNull = left == null || (typeof left === 'number' && Number.isNaN(left));
      const rightNull = right == null || (typeof right === 'number' && Number.isNaN(right));
      if (leftNull || rightNull) {
        return (leftNull === rightNull ? 0 : leftNull ? 1 : -1) || a.index - b.index;
      }
      const result = compareValues(left, right);
      return (sort.direction === 'asc' ? result : -result) || a.index - b.index;
    })
    .map(({ row }) => row);
}