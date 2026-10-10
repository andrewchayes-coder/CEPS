import { expect, test, type Page } from '@playwright/test';

const base = { clientId: 'c1', clientName: 'Pat Participant', vendorId: 'v1', vendorName: 'Pat Provider', serviceCode: '459', paymentType: 'direct_payment', status: 'active', servicePeriodStart: '2026-01-01', servicePeriodEnd: '2026-12-31', maxPeriodAmount: '1200.00', daysUntilExpiry: 200 };
const items = [
  { ...base, id: 'a1', authNumber: 'POS-M1', monthlyAmount: '150.00', oneTimeAmount: null, monthlyAmountChanged: true, previousMonthlyAmount: '100.00', monthlyAmountChangedReceivedDate: '2026-03-01' },
  { ...base, id: 'a2', authNumber: 'POS-O1', monthlyAmount: null, oneTimeAmount: '500.00' },
  { ...base, id: 'a3', authNumber: 'POS-N1', monthlyAmount: null, oneTimeAmount: null },
  { ...base, id: 'a4', authNumber: 'POS-Z1', monthlyAmount: '0.00', oneTimeAmount: null },
  { ...base, id: 'a5', authNumber: 'POS-U1', monthlyAmount: '90.00', oneTimeAmount: null, monthlyAmountChanged: true, previousMonthlyAmount: null, monthlyAmountChangedReceivedDate: null },
];

async function setup(page: Page, role: string, queries: URL[] = []) {
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { id: 'u1', name: 'Tester', email: 't@example.test', role, active: true, permissions: [], staffRole: null } }));
  await page.route('**/api/authorizations?*', (route) => {
    queries.push(new URL(route.request().url()));
    return route.fulfill({ json: { total: items.length, items } });
  });
}

for (const role of ['staff', 'service_coordinator', 'parent_guardian']) {
  test(`${role} sees Monthly column before Max Amount`, async ({ page }) => {
    await setup(page, role);
    await page.goto('/authorizations');
    await expect(page.getByRole('button', { name: /Monthly/ })).toBeVisible();
    const heads = await page.locator('thead th').allInnerTexts();
    const m = heads.findIndex((h) => h.includes('Monthly'));
    expect(m).toBeGreaterThan(-1);
    expect(heads[m + 1]).toContain('Max Amount');
    const rows = page.locator('tbody tr');
    await expect(rows.filter({ hasText: 'POS-M1' })).toContainText('$150.00');
    await expect(rows.filter({ hasText: 'POS-O1' })).toContainText('$500.00 one-time');
    await expect(rows.filter({ hasText: 'POS-Z1' })).toContainText('$0.00');
    await expect(rows.filter({ hasText: 'POS-N1' }).getByTestId('authorization-monthly-amount')).toHaveText('—');
  });
}

test('sorting sends monthlyAmount', async ({ page }) => {
  const q: URL[] = [];
  await setup(page, 'staff', q);
  await page.goto('/authorizations');
  await page.getByRole('button', { name: /Monthly/ }).click();
  await expect.poll(() => q.some((u) => u.searchParams.get('sortBy') === 'monthlyAmount')).toBe(true);
});

test('changed marker tooltips', async ({ page }) => {
  await setup(page, 'staff');
  await page.goto('/authorizations');
  await page.locator('tr', { hasText: 'POS-M1' }).getByTestId('monthly-amount-changed').hover();
  await expect(page.getByRole('tooltip').first()).toContainText('Was $100.00 until 03/01/2026');
  await page.locator('tr', { hasText: 'POS-U1' }).getByTestId('monthly-amount-changed').hover();
  await expect(page.getByRole('tooltip').first()).toContainText('Was — until Received date not recorded');
});

for (const role of ['staff', 'service_coordinator', 'parent_guardian']) {
  test(`${role} sees amounts on participant authorization cards and table`, async ({ page }) => {
    await setup(page, role);
    await page.route('**/api/family-representatives?*', route => route.fulfill({ json: [] }));
    await page.route('**/api/fees?*', route => route.fulfill({ json: [] }));
    await page.route('**/api/clients/c1/case', route => route.fulfill({ json: {
      client: {
        id: 'c1', firstName: 'Demo', lastName: 'Participant', dateOfBirth: '1970-01-01',
        uciNumber: 'TEST-UCI', isMinor: false, status: 'active', assignedCoordinatorId: 'u1',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      authorizations: items, invoices: [], payments: [], remittances: [], referrals: [], documents: [],
    } }));
    await page.goto('/clients/c1');
    const cards = page.getByTestId('authorization-card-amount');
    await expect(cards.filter({ hasText: 'Monthly: $150.00' })).toBeVisible();
    await expect(cards.filter({ hasText: 'One-time: $500.00' })).toBeVisible();
    await expect(cards.filter({ hasText: 'Monthly: $0.00' })).toBeVisible();
    await page.getByRole('tab', { name: /^Authorizations/ }).click();
    const header = page.getByRole('columnheader', { name: /Sort by Monthly/ });
    await expect(header).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'POS-O1' })).toContainText('$500.00 one-time');
  });
}
