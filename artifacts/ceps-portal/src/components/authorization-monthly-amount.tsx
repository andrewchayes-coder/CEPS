import React from 'react';
import type { Authorization } from '@workspace/api-client-react';
import { format } from 'date-fns';
import { formatMoney } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export type MonthlyAmountFields = Pick<Authorization,
  'monthlyAmount' | 'oneTimeAmount' | 'monthlyAmountChanged' |
  'previousMonthlyAmount' | 'monthlyAmountChangedReceivedDate'>;

const present = (v: string | null | undefined): v is string => v !== null && v !== undefined && v !== '';
const money = (v: string) => `$${formatMoney(v)}`;

export function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function monthlyAmountText(a: MonthlyAmountFields): string {
  if (present(a.monthlyAmount)) return money(a.monthlyAmount);
  if (present(a.oneTimeAmount)) return `${money(a.oneTimeAmount)} one-time`;
  return '—';
}

export function changedTooltipText(a: MonthlyAmountFields): string {
  const was = present(a.previousMonthlyAmount) ? money(a.previousMonthlyAmount) : '—';
  const d = a.monthlyAmountChangedReceivedDate ? parseDateOnly(a.monthlyAmountChangedReceivedDate) : null;
  return `Was ${was} until ${d ? format(d, 'MM/dd/yyyy') : 'Received date not recorded'}`;
}

export function MonthlyAmount({ auth }: { auth: MonthlyAmountFields }) {
  return (
    <span className="inline-flex items-center justify-end gap-1.5" data-testid="authorization-monthly-amount">
      <span>{monthlyAmountText(auth)}</span>
      {auth.monthlyAmountChanged && (
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} data-testid="monthly-amount-changed" className="rounded border border-chart-1/40 bg-chart-1/10 px-1 text-[10px] font-medium uppercase text-chart-1">
                changed
              </span>
            </TooltipTrigger>
            <TooltipContent>{changedTooltipText(auth)}</TooltipContent>
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
      {monthly ? `Monthly: ${money(auth.monthlyAmount!)}` : `One-time: ${money(auth.oneTimeAmount!)}`}
    </p>
  );
}
