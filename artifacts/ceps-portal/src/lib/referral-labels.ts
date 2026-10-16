const labels: Record<string, string> = {
  direct_pay_459: 'Direct Pay (459)',
  reimbursement_024: 'Reimbursement (024)',
  one_time: 'One Time',
  monthly: 'Monthly',
};

/** Stored legacy values must remain visible, not be relabeled as another value. */
export const referralValueLabel = (value?: string | null) =>
  value ? Object.hasOwn(labels, value) ? labels[value] : value : '—';
