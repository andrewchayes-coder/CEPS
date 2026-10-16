import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type DocumentType = 'invoice' | 'receipt';

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = { invoice: 'Invoice', receipt: 'Receipt' };

export function DocumentTypeBadge({ type, testId }: { type?: string | null; testId?: string }) {
  const isReceipt = type === 'receipt';
  return (
    <Badge
      variant="outline"
      className={isReceipt ? 'bg-chart-3/10 text-chart-3 border-chart-3/20' : 'bg-muted text-foreground border-border'}
      data-testid={testId}
    >
      {isReceipt ? 'Receipt' : 'Invoice'}
    </Badge>
  );
}

const CODE_ORDER = ['459', '024'];

/** Stable business display order: 459, 024, then others (lexical); deduped. */
export function getDisplayServiceCodes(invoice: {
  serviceCodes?: string[] | null;
  lineItems?: Array<{ serviceCode?: string | null }> | null;
}): string[] {
  const set = new Set<string>();
  for (const l of invoice.lineItems ?? []) if (l.serviceCode) set.add(l.serviceCode);
  if (set.size === 0) for (const c of invoice.serviceCodes ?? []) if (c) set.add(c);
  const rank = (c: string) => { const i = CODE_ORDER.indexOf(c); return i === -1 ? CODE_ORDER.length : i; };
  return Array.from(set).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
}

export function formatServiceCodes(invoice: Parameters<typeof getDisplayServiceCodes>[0]): string {
  const codes = getDisplayServiceCodes(invoice);
  return codes.length ? codes.join(', ') : '—';
}

export function DocumentTypeSelect({
  id, value, onValueChange, disabled,
}: { id?: string; value: string; onValueChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} data-testid="select-document-type"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="invoice">Invoice</SelectItem>
        <SelectItem value="receipt">Receipt</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function documentTypeMismatchHint(documentType: string, paymentType: string): string | null {
  if (documentType === 'receipt' && paymentType === 'direct_payment') return 'Receipts are usually reimbursements, check the payment type';
  if (documentType === 'invoice' && paymentType === 'reimbursement') return 'Invoices are usually direct payments, check the payment type';
  return null;
}

export function DocumentTypeMismatchHint({ documentType, paymentType }: { documentType: string; paymentType: string }) {
  const msg = documentTypeMismatchHint(documentType, paymentType);
  if (!msg) return null;
  return (
    <p className="sm:col-span-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status" data-testid="hint-document-type-mismatch">
      {msg}
    </p>
  );
}
