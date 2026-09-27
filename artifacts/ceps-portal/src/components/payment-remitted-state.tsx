import { CheckCircle2 } from 'lucide-react';
import type { PaymentAllocation } from '@workspace/api-client-react';

export function PaymentRemittedState({
  line,
  legacyRemitted = false,
}: {
  line: Pick<PaymentAllocation, 'amount' | 'remitted' | 'remittedAmount'> | null;
  legacyRemitted?: boolean;
}) {
  if (line?.remitted === 'full' || (!line && legacyRemitted)) {
    return <span className="inline-flex items-center gap-1 text-chart-5" aria-label="Fully remitted"><CheckCircle2 className="h-4 w-4" /> <span className="sr-only">Fully remitted</span></span>;
  }
  if (line?.remitted === 'partial') {
    return <span className="whitespace-nowrap">${Number(line.remittedAmount).toFixed(2)} of ${Number(line.amount).toFixed(2)}</span>;
  }
  return <span className="text-muted-foreground">-</span>;
}