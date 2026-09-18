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

const invoices = {
  validated: {
    id: 'invoice-validated',
    clientId: client.id,
    serviceMonth: '2026-07',
    amountRequested: '100.00',
    status: 'validated',
  },
  approved: {
    id: 'invoice-approved',
    clientId: client.id,
    serviceMonth: '2026-08',
    amountRequested: '125.00',
    status: 'approved',
  },
  rejected: {
    id: 'invoice-rejected',
    clientId: client.id,
    serviceMonth: '2026-09',
    amountRequested: '150.00',
    status: 'rejected',
  },
  duplicate: {
    id: 'invoice-duplicate',
    clientId: client.id,
    serviceMonth: '2026-10',
    amountRequested: '175.00',
    status: 'duplicate',
  },
};

async function mockPaymentPage(page: Page, invoiceStatuses: URL[]) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/payments?*', (route) => route.fulfill({
    json: {
      total: 1,
      items: [{
        id: 'payment-1',
        clientId: client.id,
        clientName: `${client.firstName} ${client.lastName}`,
        qbCheckNumber: 'CHECK-100',
        checkDate: '2026-09-02',
        amount: '100.00',
        paymentMonth: '2026-08',
        paymentType: 'direct_payment',
        source: 'manual',
        remitted: false,
        allocatedAmount: '0.00',
        remainingAmount: '100.00',
      }],
    },
  }));
  await page.route('**/api/clients?*', (route) => route.fulfill({
    json: { total: 1, items: [client] },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({
    json: { total: 0, items: [] },
  }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: { total: 0, items: [] },
  }));
  await page.route('**/api/invoices?*', (route) => {
    const url = new URL(route.request().url());
    const status = url.searchParams.get('status');
    if (status) invoiceStatuses.push(url);
    return route.fulfill({
      json: {
        total: status === 'validated' || status === 'approved' ? 1 : 0,
        items: status === 'validated'
          ? [invoices.validated]
          : status === 'approved'
            ? [invoices.approved]
            : [],
      },
    });
  });
  await page.route('**/api/payments/*', (route) => route.fulfill({
    json: {
      id: 'payment-1',
      clientId: client.id,
      clientName: `${client.firstName} ${client.lastName}`,
      qbCheckNumber: 'CHECK-100',
      checkDate: '2026-09-02',
      amount: '100.00',
      paymentMonth: '2026-08',
      paymentType: 'direct_payment',
      source: 'manual',
      remitted: false,
      allocatedAmount: '0.00',
      remainingAmount: '100.00',
      invoiceId: null,
      authorizationId: null,
    },
  }));
}

async function assertNativeMonthControl(page: Page, dialogName: string, id: string) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  const month = dialog.getByLabel('Payment Month');
  await expect(month).toHaveAttribute('type', 'month');
  await expect(month).toHaveAttribute('id', id);
  await expect(month).toHaveAttribute('data-testid', 'input-payment-month');

  await month.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '2026-13';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(month).toHaveValue('');
  await month.fill('2026-08');
  await expect(month).toHaveValue('2026-08');
}

test('payment dialogs use native month controls and log payment only offers eligible invoices', async ({ page }) => {
  const invoiceStatuses: URL[] = [];
  await mockPaymentPage(page, invoiceStatuses);
  await page.goto('/payments');

  await page.getByTestId('button-log-payment').click();
  const logDialog = page.getByRole('dialog', { name: 'Log Payment' });
  await expect(logDialog).toBeVisible();
  await assertNativeMonthControl(page, 'Log Payment', 'payment-month');

  await logDialog.getByTestId('select-payment-client-id').click();
  await page.getByRole('option', { name: 'Pat Participant' }).click();
  await expect.poll(() => invoiceStatuses.map((url) => url.searchParams.get('status')).sort()).toEqual(['approved', 'validated']);

  await logDialog.getByTestId('select-payment-invoice-id').click();
  await expect(page.getByRole('option', { name: /2026-07/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /2026-08/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /2026-09|2026-10/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByTestId('button-edit-payment').click();
  await expect(page.getByRole('dialog', { name: 'Edit Payment' })).toBeVisible();
  await assertNativeMonthControl(page, 'Edit Payment', 'edit-payment-month');
});