import { formatMonth, formatMonthRange } from './dates';
type MonthAllocation = { serviceMonth?: string | null };

type PaymentWithServiceMonths = {
  allocations?: MonthAllocation[] | null;
  paymentMonth?: string | null;
};

const SERVICE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function getCurrentServiceMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function getLatestServiceMonth(months: Array<string | null | undefined>, fallback = getCurrentServiceMonth()): string {
  return months.filter((month): month is string => !!month && SERVICE_MONTH_PATTERN.test(month))
    .sort()
    .at(-1) ?? fallback;
}

function serviceMonthsForPayment(payment: PaymentWithServiceMonths): string[] {
  const months = Array.from(new Set((payment.allocations ?? [])
    .map((allocation) => allocation.serviceMonth)
    .filter((month): month is string => !!month && SERVICE_MONTH_PATTERN.test(month))))
    .sort();
  if (months.length > 0) return months;
  return payment.paymentMonth && SERVICE_MONTH_PATTERN.test(payment.paymentMonth) ? [payment.paymentMonth] : [];
}

export function formatPaymentServiceMonths(payment: PaymentWithServiceMonths): string {
  const months = serviceMonthsForPayment(payment);
  if (months.length === 0) return '—';
  if (months.length === 1) return formatMonth(months[0]);

  const timestamps = months.map((month) => {
    const [year, monthNumber] = month.split('-').map(Number);
    return year * 12 + monthNumber;
  });
  const contiguous = timestamps[timestamps.length - 1] - timestamps[0] === months.length - 1;
  if (contiguous) {
    return formatMonthRange(months[0], months[months.length - 1]);
  }

  return months.map(formatMonth).join(', ');
}

export function earliestPaymentServiceMonth(payment: PaymentWithServiceMonths): string {
  return serviceMonthsForPayment(payment)[0] ?? '';
}