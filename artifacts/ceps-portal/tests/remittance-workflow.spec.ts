import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-1',
  name: 'Test Staff',
  email: 'staff@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const remittance = {
  id: 'remittance-1',
  clientId: 'client-1',
  clientName: 'Pat Participant',
  authorizationId: 'authorization-1',
  authNumber: 'AUTH-100',
  altaReference: 'CHECK-100',
  remittanceDate: '2026-09-01',
  amount: '100.00',
  paymentMonth: '2026-08',
  status: 'received',
  source: 'alta_regional',
  matchedPaymentId: null,
  autoMatched: false,
  remittanceBatchId: 'batch-1',
  reportReference: 'REPORT-1',
  reviewReason: 'amount_mismatch',
  expectedAmount: '125.00',
};

async function mockStaffSession(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) =>
    route.fulfill({
      json: {
        total: 2,
        items: [
          { id: 'client-1', firstName: 'Pat', lastName: 'Participant', uciNumber: 'UCI-1', dateOfBirth: '1990-01-01', status: 'active' },
          { id: 'client-2', firstName: 'Sam', lastName: 'Second', uciNumber: 'UCI-2', dateOfBirth: '1991-01-01', status: 'active' },
        ],
      },
    }),
  );
  await page.route('**/api/authorizations?*', (route) =>
    route.fulfill({
      json: {
        total: 2,
        items: [
          { id: 'authorization-1', clientId: 'client-1', authNumber: 'AUTH-100', status: 'active' },
          { id: 'authorization-2', clientId: 'client-2', authNumber: 'AUTH-200', status: 'active' },
        ],
      },
    }),
  );
}

test('staff remittance list, manual create, and eligible-payment picker stay wired together', async ({ page }) => {
  const remittanceRequests: URL[] = [];
  const paymentRequests: URL[] = [];

  await mockStaffSession(page);
  await page.route('**/api/remittances?*', (route) => {
    remittanceRequests.push(new URL(route.request().url()));
    return route.fulfill({ json: { total: 1, items: [remittance] } });
  });
  await page.route('**/api/payments?*', (route) => {
    paymentRequests.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        total: 1,
        items: [{
          id: 'payment-1',
          clientId: 'client-1',
          clientName: 'Pat Participant',
          authorizationId: 'authorization-1',
          authNumber: 'AUTH-100',
          qbCheckNumber: 'PAY-100',
          checkDate: '2026-09-02',
          amount: '100.00',
          paymentMonth: '2026-08',
          paymentType: 'direct_payment',
          source: 'manual',
          remitted: false,
        }],
      },
    });
  });

  await page.goto('/remittances');

  await expect(page.getByRole('heading', { name: 'Remittances' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Participant' })).toHaveCount(0);
  await expect(page.getByTestId('button-view-remittance-remittance-1')).toBeVisible();
  await expect(page.getByTestId('button-edit-remittance')).toBeVisible();
  await expect(page.getByText(/Actual \$100\.00 vs expected \$125\.00/)).toBeVisible();
  await expect(page.getByText('Report: REPORT-1')).toBeVisible();

  await page.getByTestId('button-create-remittance').click();
  await expect(page.getByRole('dialog', { name: 'Create Remittance' })).toBeVisible();
  await page.getByTestId('select-create-remittance-client').click();
  await page.getByRole('option', { name: 'Pat Participant' }).click();
  await page.getByTestId('select-create-remittance-authorization').click();
  await page.getByRole('option', { name: 'AUTH-100' }).click();
  await page.getByTestId('select-create-remittance-client').click();
  await page.getByRole('option', { name: 'Sam Second' }).click();
  await expect(page.getByTestId('select-create-remittance-authorization')).toContainText('Select an authorization');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByTestId('tab-remittances-needs-manual-match').click();
  await expect.poll(() => {
    const request = remittanceRequests.at(-1);
    return {
      status: request?.searchParams.get('status'),
      autoMatched: request?.searchParams.get('autoMatched'),
    };
  }).toEqual({ status: 'received', autoMatched: 'false' });

  await page.getByTestId('button-match-remittance-remittance-1').click();
  const confirm = page.getByTestId('button-confirm-match-remittance');
  await expect(confirm).toBeDisabled();
  await expect.poll(() => {
    const request = paymentRequests.at(-1);
    return {
      clientId: request?.searchParams.get('clientId'),
      authorizationId: request?.searchParams.get('authorizationId'),
      paymentMonth: request?.searchParams.get('paymentMonth'),
      remitted: request?.searchParams.get('remitted'),
    };
  }).toEqual({
    clientId: 'client-1',
    authorizationId: 'authorization-1',
    paymentMonth: '2026-08',
    remitted: 'false',
  });
  await page.getByTestId('match-payment-option-payment-1').click();
  await expect(confirm).toBeEnabled();
});