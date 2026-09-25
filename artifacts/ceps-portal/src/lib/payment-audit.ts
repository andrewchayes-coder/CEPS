/** UI boundary for the preflight report. Keep wire-shape adaptation here. */
export type AuditResultKind = 'match' | 'payee_mismatch' | 'amount_mismatch' | 'no_approved_invoice' | 'already_paid' | 'unknown_client' | 'unknown_authorization' | 'duplicate_row';

export interface PaymentAuditRow {
  rowNumber: number;
  checkNumber?: string | null;
  checkDate?: string | null;
  uciNumber?: string | null;
  participantName?: string | null;
  payeeName?: string | null;
  checkAmount?: number | string | null;
  authNumber?: string | null;
  serviceMonth?: string | null;
  result: AuditResultKind;
  reason?: string | null;
  invoiceId?: string | null;
  invoiceVendor?: string | null;
  invoiceVendorId?: string | null;
  approvedAmount?: number | string | null;
  remainingAmount?: number | string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  candidates?: {
    invoiceId: string;
    vendorName: string | null;
    approvedAmount: string | number | null;
    remainingAmount: string | number | null;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
  }[];
}

export interface PaymentAuditReport {
  summary: Record<AuditResultKind, number>;
  rows: PaymentAuditRow[];
  headerError?: string | null;
  parseProblems?: string[];
  ignoredNonCheckRows?: number;
}

export const unacknowledgeableResults: readonly AuditResultKind[] = ['unknown_client', 'unknown_authorization', 'duplicate_row'];
export const needsAcknowledgement = (row: PaymentAuditRow) =>
  row.result !== 'match' && !unacknowledgeableResults.includes(row.result);
/** The server must not infer a target from vendor or amount when several invoices are plausible. */
export const needsInvoiceChoice = (row: PaymentAuditRow) =>
  needsAcknowledgement(row) && !row.invoiceId && (row.candidates?.length ?? 0) > 1;

export const auditLabel = (result: AuditResultKind) => ({
  match: 'Match',
  payee_mismatch: 'Payee mismatch',
  amount_mismatch: 'Amount mismatch',
  no_approved_invoice: 'No approved invoice',
  already_paid: 'Already paid',
  unknown_client: 'Unknown participant',
  unknown_authorization: 'Unknown authorization',
  duplicate_row: 'Already imported',
})[result];

export function downloadPaymentAudit(report: PaymentAuditReport, downloadCSV: (file: string, headers: string[], rows: (string | number)[][]) => void) {
  downloadCSV('alta_fms_payment_preflight_audit.csv',
    ['Source row', 'Check #', 'Date', 'UCI', 'Participant', 'Payee on check', 'Approved vendor', 'Check amount', 'Approved amount', 'Remaining amount', 'Authorization', 'Service month', 'Result', 'Reason', 'Invoice', 'Reviewed by', 'Reviewed at', 'Possible approved invoices'],
    report.rows.map(row => [
      row.rowNumber, row.checkNumber ?? '', row.checkDate ?? '', row.uciNumber ?? '', row.participantName ?? '',
      row.payeeName ?? '', row.invoiceVendor ?? '', row.checkAmount ?? '', row.approvedAmount ?? '',
      row.remainingAmount ?? '', row.authNumber ?? '', row.serviceMonth ?? '', auditLabel(row.result),
      row.reason ?? '', row.invoiceId ? 'Invoice available in portal' : '', row.reviewedBy ?? '', row.reviewedAt ?? '',
      row.candidates?.map(candidate => `${candidate.vendorName ?? 'Unknown vendor'} (approved ${candidate.approvedAmount ?? '—'}, remaining ${candidate.remainingAmount ?? 'uncertain'}${candidate.reviewedBy ? `, reviewed by ${candidate.reviewedBy}` : ''})`).join('; ') ?? '',
    ]),
  );
}