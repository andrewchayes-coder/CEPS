import * as z from 'zod';
import { validateServiceDateRange } from './invoice-service-dates';

export const invoiceEditSchema = z.object({
  vendorId: z.string().optional(),
  paymentType: z.string(),
  documentType: z.enum(['invoice', 'receipt']),
  notes: z.string().optional(),
  serviceStartDate: z.string().optional(),
  serviceEndDate: z.string().optional(),
  lineItems: z.array(z.object({
    id: z.string().optional(),
    authorizationId: z.string().min(1, 'Required'),
    serviceMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Must be YYYY-MM format'),
    amount: z.string().min(1, 'Required').regex(/^\d+(\.\d{1,2})?$/, 'Invalid format'),
  })).min(1, 'At least one line item is required'),
}).superRefine((data, ctx) => {
  // Both dates absent is valid for older full invoices, just as on the server.
  if (!data.serviceStartDate && !data.serviceEndDate) return;
  const error = validateServiceDateRange(data.serviceStartDate ?? '', data.serviceEndDate ?? '');
  if (error) {
    for (const path of ['serviceStartDate', 'serviceEndDate']) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: error });
    }
  }
});

export function lineServiceDateWarning(month: string, start?: string, end?: string): string | null {
  if (!start || !end || validateServiceDateRange(start, end) || !/^\d{4}-\d{2}$/.test(month)) return null;
  return month < start.slice(0, 7) || month > end.slice(0, 7)
    ? `Line month ${month} is outside the submitted service dates ${start} – ${end}`
    : null;
}
