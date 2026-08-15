import { twMerge } from 'tailwind-merge';

import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a monetary value that arrives as an exact decimal STRING (e.g. from
 * numeric DB columns) without coercing through a binary float. Produces a
 * "1,234.56" style string with grouped thousands and exactly two decimals.
 * Falls back to the raw input when it is not a parseable decimal.
 */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0.00';
  const str = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(str);
  if (!match) return str;
  const [, sign, whole, frac = ''] = match;
  const cents = (frac + '00').slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}.${cents}`;
}
