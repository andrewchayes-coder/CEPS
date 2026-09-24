import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-payment-dialogs',
  name: 'Payment Test Staff',
  email: 'payment-dialogs@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const client = {
  id: 'client-payment-dialogs',
  firstName: 'Pat',
  lastName: 'Participant',
  uciNumber: 'PAYMENT-DIALOG-UCI',
  dateOfBirth: '1990-01-01',
  status: 'active',
};

const authorizations = [
  { id: 'auth-1', authNumber: 'AUTH-1', clientId: client.id, vendorId: 'vendor-1' },
  { id: 'auth-2', authNumber: 'AUTH-2', clientId: client.id, vendorId: 'vendor-1' }
];

const invoices = {
  approved: {
    id: 'invoice-approved',
    clientId: client.id,
    serviceMonth: '2026-08',
    amountRequested: '125.00',
    status: 'approved',
    lineItems: [
      { authorizationId: 'auth-1', serviceMonth: '2026-08', amount: '100.00' },
      { authorizationId: 'auth-1', serviceMonth: '2026-07', amount: '25.00' },
    ]
  }
};

async function mockPaymentPage(page: Page, invoiceStatuses: URL[]) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/payments?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { total: 1, items: [client] } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({ json: { total: 2, items: authorizations } }));
  await page.route('**/api/invoices?*', (route) => {
    const url = new URL(route.request().url());
    const status = url.searchParams.get('status');
    if (status) invoiceStatuses.push(url);
    return route.fulfill({
      json: {
        total: status === 'approved' ? 1 : 0,
        items: status === 'approved' ? [invoices.approved] : [],
      },
    });
  });
}

test('log payment dialog offers eligible invoices and defaults allocations grouped by auth', async ({ page }) => {
  const invoiceStatuses: URL[] = [];
  await mockPaymentPage(page, invoiceStatuses);
  let createPayload: any = null;
  await page.route('**/api/payments', (route) => {
    if (route.request().method() === 'POST') {
      createPayload = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { id: 'payment-1', ...createPayload } });
    }
    return route.continue();
  });

  await page.goto('/payments');
  await page.getByTestId('button-log-payment').click();
  const logDialog = page.getByRole('dialog', { name: 'Log Payment' });
  await expect(logDialog).toBeVisible();

  await logDialog.getByTestId('select-payment-client-id').click();
  await page.getByRole('option', { name: 'Pat Participant' }).click();

  await logDialog.getByTestId('select-payment-invoice-id').click();
  await expect(page.getByRole('option', { name: /2026-08/ })).toBeVisible();
  await page.getByRole('option', { name: /2026-08/ }).click();

  // It should group the allocations
  await expect(logDialog.getByTestId('input-payment-alloc-0-amount')).toHaveValue('125.00');

  // Submit
  await logDialog.getByTestId('input-payment-check-number').fill('CHK-1');
  await logDialog.getByTestId('input-payment-date').fill('2026-08-01');
  await page.getByTestId('button-save-payment').click();

  await expect.poll(() => createPayload).toMatchObject({
    allocations: [
      { authorizationId: 'auth-1', amount: '125.00' }
    ]
  });
});

test('log payment blocks missing authorization and shows server 403 and 400 messages', async ({ page }) => {
  const invoiceStatuses: URL[] = [];
  await mockPaymentPage(page, invoiceStatuses);
  let postCount = 0;
  await page.route('**/api/payments', (route) => {
    if (route.request().method() === 'POST') {
      postCount++;
      return route.fulfill({
        status: postCount === 1 ? 403 : 400,
        json: { error: postCount === 1 ? 'Missing required permission' : 'Authorization is not active' },
      });
    }
    return route.continue();
  });
  await page.goto('/payments');
  await page.getByTestId('button-log-payment').click();
  const dialog = page.getByRole('dialog', { name: 'Log Payment' });
  await dialog.getByTestId('select-payment-client-id').click();
  await page.getByRole('option', { name: 'Pat Participant' }).click();
  await dialog.getByTestId('input-payment-check-number').fill('CHK-2');
  await dialog.getByTestId('input-payment-date').fill('2026-08-01');
  await dialog.getByTestId('input-payment-alloc-0-amount').fill('25.00');
  await dialog.getByTestId('button-save-payment').click();
  await expect(dialog.getByTestId('error-payment-allocation')).toContainText('Select an authorization');
  expect(postCount).toBe(0);

  await dialog.getByTestId('select-payment-alloc-0-auth').click();
  await page.getByRole('option', { name: 'AUTH-1' }).click();
  await dialog.getByTestId('button-save-payment').click();
  await expect(page.getByText('Missing required permission', { exact: true })).toBeVisible();
  await dialog.getByTestId('button-save-payment').click();
  await expect(page.getByText('Authorization is not active', { exact: true })).toBeVisible();
  expect(postCount).toBe(2);
});

test('3-line invoice editor across 2 auths and 2 months computes totals and submits correctly', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { total: 1, items: [client] } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({ json: { total: 2, items: authorizations } }));

  let createPayload: any = null;
  await page.route('**/api/invoices', (route) => {
    if (route.request().method() === 'POST') {
      createPayload = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { id: 'invoice-1', ...createPayload } });
    }
    return route.continue();
  });

  await page.goto('/invoices/new');
  await page.getByTestId('select-invoice-client').click();
  await page.getByRole('option', { name: 'Pat Participant' }).click();

  // First line
  await page.getByTestId('select-line-0-authorization').click();
  await page.getByRole('option', { name: 'AUTH-1' }).click();
  const line0Month = page.locator('#line-0-month');
  await line0Month.fill('2026-08');
  await page.getByTestId('input-line-0-amount').fill('100.00');

  // Second line
  await page.getByTestId('button-add-line-item').click();
  await page.getByTestId('select-line-1-authorization').click();
  await page.getByRole('option', { name: 'AUTH-1' }).click();
  const line1Month = page.locator('#line-1-month');
  await line1Month.fill('2026-07');
  await page.getByTestId('input-line-1-amount').fill('50.00');

  // Third line
  await page.getByTestId('button-add-line-item').click();
  await page.getByTestId('select-line-2-authorization').click();
  await page.getByRole('option', { name: 'AUTH-2' }).click();
  const line2Month = page.locator('#line-2-month');
  await line2Month.fill('2026-08');
  await page.getByTestId('input-line-2-amount').fill('25.00');

  // Submit
  await page.getByRole('button', { name: 'Submit Invoice' }).click();

  await expect.poll(() => createPayload).toMatchObject({
    clientId: client.id,
    amountRequested: '175.00',
    lineItems: [
      { authorizationId: 'auth-1', serviceMonth: '2026-08', amount: '100.00' },
      { authorizationId: 'auth-1', serviceMonth: '2026-07', amount: '50.00' },
      { authorizationId: 'auth-2', serviceMonth: '2026-08', amount: '25.00' },
    ]
  });
});