export function referralServiceError(fields: Record<string, unknown>): string | null {
  for (const [key, label] of [['serviceStartDate', 'Service start date'], ['serviceEndDate', 'Service end date']]) {
    const value = fields[key];
    if (typeof value !== 'string' || !value.trim()) return `${label} is required`;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return `${label} must be a valid date`;
  }
  if (String(fields.serviceEndDate) < String(fields.serviceStartDate)) return 'Service end date must be on or after service start date';
  const amount = fields.authAmount;
  if (typeof amount !== 'string' || !amount.trim()) return 'Authorization amount is required';
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim()) || !/[1-9]/.test(amount)) {
    return 'Enter a positive authorization amount with up to two decimal places';
  }
  return null;
}

export function normalizeAuthorizationAmount(value: string): string {
  const [whole, fraction = ''] = value.trim().split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}
