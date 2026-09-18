import type { Invoice } from '@workspace/api-client-react';

export function getInvoiceDisplayMonth(invoice: Pick<Invoice, 'serviceMonth' | 'lineItems'>): string {
  if (invoice.lineItems && invoice.lineItems.length > 0) {
    const months = Array.from(new Set(invoice.lineItems.map(li => li.serviceMonth))).filter(Boolean);
    if (months.length > 0) {
      months.sort();
      if (months.length === 1) return months[0];
      return `${months[0]} to ${months[months.length - 1]}`;
    }
  }
  return invoice.serviceMonth || '-';
}
