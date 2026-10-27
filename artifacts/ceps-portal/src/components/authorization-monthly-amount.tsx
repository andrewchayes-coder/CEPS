import React from 'react';
import type { Authorization } from '@workspace/api-client-react';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ProtectedData } from '@/components/protected-data';

export type MonthlyAmountFields = Pick<Authorization,
  'monthlyAmount' | 'oneTimeAmount' | 'monthlyAmountChanged' |
  'previousMonthlyAmount' | 'monthlyAmountChangedReceivedDate'>;

const present = (v: string | null | undefined): v is string => v !== null && v !== undefined && v !== '';
const money = (v: string) => `$${formatMoney(v)}`;

export function monthlyAmountText(a: MonthlyAmountFields): string {
  if (present(a.monthlyAmount)) return money(a.monthlyAmount);
  if (present(a.oneTimeAmount)) return `${money(a.oneTimeAmount)} one-time`;
  return '—';
}

export function changedTooltipText(a: MonthlyAmountFields): string {
  const was = present(a.previousMonthlyAmount) ? money(a.previousMonthlyAmount) : '—';
  const date = formatDate(a.monthlyAmountChangedReceivedDate);
  return `Was ${was} until ${date !== '—' ? date : 'Received date not recorded'}`;
}

export function MonthlyAmount({ auth }: { auth: MonthlyAmountFields }) {
  return (
    <span className="inline-flex items-center justify-end gap-1.5" data-testid="authorization-monthly-amount">
      {present(auth.monthlyAmount) ? <ProtectedData>{money(auth.monthlyAmount)}</ProtectedData>
        : present(auth.oneTimeAmount) ? <><ProtectedData>{money(auth.oneTimeAmount)}</ProtectedData> one-time</>
        : '—'}
      {auth.monthlyAmountChanged && (
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} data-testid="monthly-amount-changed" className="rounded border border-chart-1/40 bg-chart-1/10 px-1 text-[10px] font-medium uppercase text-chart-1">
                changed
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Was {present(auth.previousMonthlyAmount) ? <ProtectedData>{money(auth.previousMonthlyAmount)}</ProtectedData> : '—'}
              {' '}until {formatDate(auth.monthlyAmountChangedReceivedDate) !== '—'
                ? <ProtectedData>{formatDate(auth.monthlyAmountChangedReceivedDate)}</ProtectedData> : 'Received date not recorded'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
  );
}

export function MonthlyAmountLine({ auth }: { auth: MonthlyAmountFields }) {
  const monthly = present(auth.monthlyAmount);
  if (!monthly && !present(auth.oneTimeAmount)) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="authorization-card-amount">
      {monthly ? 'Monthly: ' : 'One-time: '}
      <ProtectedData>{money(monthly ? auth.monthlyAmount! : auth.oneTimeAmount!)}</ProtectedData>
      {!monthly && ' one-time'}
    </p>
  );
}
