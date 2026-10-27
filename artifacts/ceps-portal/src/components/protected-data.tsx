import React, { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Keep record data exact while the surrounding interface is translated. */
export function ProtectedData({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} translate="no" className={cn('notranslate', className)}>{children}</span>;
}

/** Exact numeric/date/code values in table cells, without hiding status copy from translation. */
export function isExactDataText(value: unknown): value is string | number {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  return /^(?:-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?|\d{2}\/\d{4}(?:\s*[–-]\s*\d{2}\/\d{4})?|\d{2}\/\d{2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AP]M(?:\s*PT)?)?(?:\s*[–-]\s*\d{2}\/\d{2}\/\d{4})?|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:UCI[ :]+)?\d{5,}|[A-Z]{2,}[- ]?\d+(?:[-/][A-Z0-9]+)*|\+?\d[\d(). -]{6,})$/i.test(text);
}
