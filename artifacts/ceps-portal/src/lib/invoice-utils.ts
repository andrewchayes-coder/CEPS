import type { Invoice } from '@workspace/api-client-react';
import { formatMonth, formatMonthRange } from './dates';

/** Sorting uses the canonical month, never MM/YYYY display text. */
export function getInvoiceSortMonth(invoice: Pick<Invoice, 'serviceMonth' | 'lineItems'>): string {
  return invoice.lineItems?.map(line => line.serviceMonth).filter(Boolean).sort()[0]
    ?? invoice.serviceMonth ?? '';
}

export function getInvoiceDisplayMonth(invoice: Pick<Invoice, 'serviceMonth' | 'lineItems'>): string {
  if (invoice.lineItems && invoice.lineItems.length > 0) {
    const months = Array.from(new Set(invoice.lineItems.map(li => li.serviceMonth))).filter(Boolean);
    if (months.length > 0) {
      months.sort();
      if (months.length === 1) return formatMonth(months[0]);
      return formatMonthRange(months[0], months[months.length - 1]);
    }
  }
  return formatMonth(invoice.serviceMonth);
}
