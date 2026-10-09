export function isAuthorizationAmount(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value.trim()) && /[1-9]/.test(value);
}

export function normalizeAuthorizationAmount(value: string): string {
  const [whole, fraction = ''] = value.trim().split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}

export function isServiceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
