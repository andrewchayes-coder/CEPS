import { test, expect, type Page } from '@playwright/test';

const staff = { id: 'feedback-staff', name: 'Feedback Staff', email: 'feedback@test.local', role: 'staff', active: true };
const participant = { id: 'feedback-client', firstName: 'Feedback', lastName: 'Participant', uciNumber: 'FEEDBACK-UCI', dateOfBirth: '2000-01-01', status: 'active' };
const payment = {
  id: 'feedback-payment', clientId: participant.id, clientName: 'Feedback Participant',
  vendorName: 'Feedback Vendor', qbCheckNumber: 'FEEDBACK-CHECK', checkDate: '2026-09-10',
  amount: '160.00', allocatedAmount: '40.00', remainingAmount: '120.00', remitted: false, allocations: [],
};
const remittance = {
  id: 'feedback-remittance', clientId: participant.id, clientName: 'Feedback Participant',
  remittanceDate: '2026-09-10', altaReference: 'FEEDBACK-REMIT', amount: '160.00',
  allocatedAmount: '40.00', remainingAmount: '120.00', status: 'received', source: 'alta_regional',
};

test.beforeEach(async ({ page }) => {
  // Every test is browser-only: unhandled API requests must not write real data.
  await page.route('**/api/**', route => route.fulfill({ json: { items: [], total: 0 } }));
});

async function session(page: Page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: staff }));
  await page.route('**/api/clients?*', route => route.fulfill({ json: { items: [participant], total: 1 } }));
  await page.route('**/api/vendors?*', route => route.fulfill({ json: { items: [], total: 0 } }));
}

test('mutation toast displays the server error on password, demo and magic-link requests', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Not signed in' } }));
  await page.route('**/api/auth/login', route => route.fulfill({ status: 400, json: {
    error: route.request().postDataJSON().email === 'feedback@test.local'
      ? 'Server password explanation' : 'Server demo explanation',
  } }));
  await page.route('**/api/auth/magic-link/request', route => route.fulfill({ status: 400, json: { error: 'Server magic-link explanation' } }));
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('feedback@test.local');
  await page.locator('input[name="password"]').fill('not-a-real-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByText('Server password explanation').first()).toBeVisible();
  await page.getByRole('button', { name: 'CEPS Admin', exact: true }).click();
  await expect(page.getByText('Server demo explanation').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Magic Link', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('feedback@test.local');
  await page.getByRole('button', { name: /send.*link/i }).click();
  await expect(page.getByText('Server magic-link explanation').first()).toBeVisible();
});

test('vendor inline mutation error displays the server explanation', async ({ page }) => {
  await session(page);
  await page.route('**/api/vendors', route => route.fulfill({ status: 409, json: { error: 'Server duplicate vendor explanation' } }));
  await page.goto('/vendors/new');
  await page.locator('form[data-testid="form-create-vendor"] input').first().fill('Feedback Vendor');
  await page.getByRole('button', { name: /create vendor/i }).click();
  await expect(page.getByTestId('error-create-vendor')).toHaveText('Server duplicate vendor explanation');
});

test('unmatched queue inline fetch error displays the server explanation', async ({ page }) => {
  await session(page);
  await page.route('**/api/unmatched-pos?*', route => route.fulfill({ status: 400, json: { error: 'Server queue explanation' } }));
  await page.goto('/authorizations/unmatched');
  await expect(page.getByText('Server queue explanation')).toBeVisible({ timeout: 20000 });
});

for (const screen of ['/payments', '/remittances', `/clients/${participant.id}`]) {
  test(`${screen} renders matching metric help and opens both tooltips`, async ({ page }) => {
    await session(page);
    await page.route('**/api/payments?*', route => route.fulfill({ json: { items: [payment], total: 1 } }));
    await page.route('**/api/remittances?*', route => route.fulfill({ json: { items: [remittance], total: 1 } }));
    await page.route('**/api/fees?*', route => route.fulfill({ json: [] }));
    await page.route('**/api/family-representatives?*', route => route.fulfill({ json: [] }));
    await page.route(`**/api/clients/${participant.id}/case`, route => route.fulfill({ json: {
      client: participant, authorizations: [], invoices: [], payments: [], referrals: [], documents: [], remittances: [remittance],
    } }));
    await page.goto(screen);
    if (screen.startsWith('/clients/')) await page.getByRole('tab', { name: /^Payments/ }).click();
    const allocated = screen === '/payments' ? 'Amount matched to remittances.' : 'Amount matched to payments.';
    const remaining = screen === '/payments' ? 'Amount not yet matched to a remittance.' : 'Amount not yet matched to a payment.';
    for (const [label, explanation] of [['Allocated', allocated], ['Remaining', remaining]]) {
      const button = page.getByRole('button', { name: `${label}: ${explanation}`, exact: true }).first();
      await expect(button).toBeVisible();
      await button.focus();
      await expect(page.getByRole('tooltip').first()).toContainText(explanation);
      await button.blur();
    }
  });
}
