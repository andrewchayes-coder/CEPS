import { expect, test, type Page } from '@playwright/test';

const participantId = 'participant-line-test';
const payment = {
  id: 'payment-three-lines',
  clientId: participantId,
  clientName: 'Jordan Rivera',
  vendorId: null,
  vendorName: 'Sunrise Music',
  qbCheckNumber: 'QB-900',
  checkDate: '2026-08-20',
  amount: '900.00',
  paymentMonth: null,
  paymentType: 'direct_payment',
  source: 'manual',
  remitted: false,
  allocatedAmount: '400.00',
  remainingAmount: '500.00',
  allocations: [
    { id: 'line-aug', authorizationId: 'auth-459', authNumber: 'AUTH-459', serviceMonth: '2026-08', amount: '300.00', remittedAmount: '300.00', remitted: 'full', remittanceLinks: [{ id: 'remit-aug', reference: 'ALTA-AUG', date: '2026-09-01', amount: '300.00' }] },
    { id: 'line-sep', authorizationId: 'auth-459', authNumber: 'AUTH-459', serviceMonth: '2026-09', amount: '300.00', remittedAmount: '100.00', remitted: 'partial', remittanceLinks: [{ id: 'remit-sep', reference: 'ALTA-SEP', date: '2026-10-01', amount: '100.00' }] },
    { id: 'line-oct', authorizationId: 'auth-459', authNumber: 'AUTH-459', serviceMonth: '2026-10', amount: '300.00', remittedAmount: '0.00', remitted: 'none', remittanceLinks: [] },
  ],
};

const legacyPayment = {
  ...payment,
  id: 'legacy-check',
  qbCheckNumber: 'QB-LEGACY',
  amount: '150.00',
  paymentMonth: '2026-07',
  allocatedAmount: '0.00',
  remainingAmount: '150.00',
  allocations: [],
};

async function mockStaff(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { id: 'staff-1', name: 'Test Staff', email: 'staff@example.test', role: 'staff', active: true, permissions: [] } }),
  );
}

test('participant payment lines and legacy checks keep separate remittance states', async ({ page }) => {
  await mockStaff(page);
  await page.route(`**/api/clients/${participantId}/case`, (route) =>
    route.fulfill({ json: {
      client: { id: participantId, firstName: 'Jordan', lastName: 'Rivera', dateOfBirth: '2000-01-01', uciNumber: 'UCI-900', status: 'active' },
      authorizations: [], invoices: [], payments: [payment, legacyPayment], remittances: [], referrals: [], documents: [],
    } }),
  );
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [
    { id: 'fee-aug', clientId: participantId, feeMonth: '2026-08', authorizationId: 'auth-490', authNumber: 'FEE-490', feeAuthorizationMissing: false, amount: '160.00', remittedAmount: '160.00', ruleApplied: 'monthly', status: 'collected', createdAt: '2026-09-05T12:00:00Z' },
    { id: 'fee-jul', clientId: participantId, feeMonth: '2026-07', authorizationId: null, authNumber: null, feeAuthorizationMissing: true, amount: '160.00', remittedAmount: '0.00', ruleApplied: 'monthly', status: 'pending', createdAt: '2026-08-05T12:00:00Z' },
  ] }));

  await page.goto(`/clients/${participantId}?tab=payments`);
  const aug = page.getByTestId('participant-payment-row-line-aug');
  const sep = page.getByTestId('participant-payment-row-line-sep');
  const oct = page.getByTestId('participant-payment-row-line-oct');
  const legacy = page.getByTestId('participant-payment-row-legacy-check');
  await expect(aug).toBeVisible();
  await expect(sep).toBeVisible();
  await expect(oct).toBeVisible();
  await expect(legacy).toBeVisible();
  await expect(page.getByTestId('participant-payment-row-line-aug').getByText('Aug 2026')).toBeVisible();
  await expect(aug.getByLabel('Fully remitted')).toBeVisible();
  await expect(sep).toContainText('$100.00 of $300.00');
  await expect(oct.getByRole('cell').last()).toHaveText('-');
  await expect(aug).toContainText('Check total $900.00');
  await expect(sep).not.toContainText('Check total');
  await expect(legacy).toContainText('$150.00');
  await expect(page.getByTestId('participant-remittance-matched-summary')).toBeVisible();
  await page.getByRole('columnheader', { name: 'Sort by Amount' }).click();
  await expect(page.getByTestId('participant-payment-row-line-aug')).toBeVisible();
  await expect(page.getByTestId('participant-payment-row-line-sep')).toBeVisible();

  await page.getByRole('tab', { name: /Fees/ }).click();
  const feeRows = page.locator('[data-testid="content-fees"] tbody tr');
  await expect(feeRows.first()).toContainText('Aug 2026');
  await expect(feeRows.first()).toContainText('Paid');
  await expect(feeRows.first()).toContainText('$160.00 of $160.00');
  await expect(feeRows.first().getByRole('link', { name: 'FEE-490' })).toHaveAttribute('href', '/authorizations/auth-490');
  await expect(feeRows.first().locator('[title^="Created"]')).toHaveAttribute('title', /Sep 5, 2026/);
  await expect(feeRows.nth(1)).toContainText('No fee authorization');
  await expect(page.getByText(/A \$160 fee is generated once per participant/)).toBeVisible();
});

test('payment detail links each line to the remittance that paid it', async ({ page }) => {
  await mockStaff(page);
  await page.route(`**/api/payments/${payment.id}`, (route) => route.fulfill({ json: payment }));
  await page.goto(`/payments/${payment.id}`);
  await expect(page.getByTestId('text-payment-alloc-0')).toContainText('Remitted');
  await expect(page.getByTestId('text-payment-alloc-1')).toContainText('$100.00 of $300.00');
  await expect(page.getByTestId('link-payment-line-remittance-line-aug-remit-aug')).toHaveAttribute('href', '/remittances/remit-aug');
  await expect(page.getByTestId('link-payment-line-remittance-line-sep-remit-sep')).toHaveAttribute('href', '/remittances/remit-sep');
});

test('Payments Log remains one row per check and labels partly completed lines', async ({ page }) => {
  await mockStaff(page);
  await page.route('**/api/payments?*', (route) => route.fulfill({ json: { items: [payment], total: 1 } }));
  await page.goto('/payments');
  await expect(page.getByTestId('link-payment')).toHaveCount(1);
  await expect(page.getByRole('row', { name: /QB-900/ })).toContainText('Partial');
  await expect(page.getByRole('row', { name: /QB-900/ })).toContainText('$400.00 allocated');
});