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

test('payments list formats service-month ranges and requests sorting by earliest service month', async ({ page }) => {
  let sortUrl: URL | undefined;
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/payments?*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('sortBy') === 'serviceMonth') sortUrl = url;
    return route.fulfill({ json: {
      total: 2,
      items: [{
        id: 'payment-month-range', clientId: client.id, clientName: 'Pat Participant',
        vendorId: null, vendorName: null, qbCheckNumber: 'CHK-MONTHS', checkDate: '2026-04-01',
        amount: '60.00', paymentMonth: '2026-01', paymentType: 'direct_payment', source: 'manual',
        remitted: false, allocatedAmount: '0.00', remainingAmount: '60.00',
        allocations: [
          { id: 'allocation-jan', authorizationId: 'auth-1', serviceMonth: '2026-01', amount: '20.00' },
          { id: 'allocation-feb', authorizationId: 'auth-1', serviceMonth: '2026-02', amount: '20.00' },
          { id: 'allocation-mar', authorizationId: 'auth-1', serviceMonth: '2026-03', amount: '20.00' },
        ],
      }, {
        id: 'payment-month-gap', clientId: client.id, clientName: 'Pat Participant',
        vendorId: null, vendorName: null, qbCheckNumber: 'CHK-GAP', checkDate: '2026-05-01',
        amount: '40.00', paymentMonth: '2026-01', paymentType: 'direct_payment', source: 'manual',
        remitted: false, allocatedAmount: '0.00', remainingAmount: '40.00',
        allocations: [
          { id: 'allocation-gap-jan', authorizationId: 'auth-1', serviceMonth: '2026-01', amount: '20.00' },
          { id: 'allocation-gap-mar', authorizationId: 'auth-1', serviceMonth: '2026-03', amount: '20.00' },
        ],
      }],
    } });
  });

  await page.goto('/payments');
  await expect(page.getByTestId('text-payment-service-month-payment-month-range')).toHaveText('Jan–Mar 2026');
  await expect(page.getByTestId('text-payment-service-month-payment-month-gap')).toHaveText('Jan, Mar 2026');
  await page.getByTestId('button-sort-serviceMonth').click();
  await expect.poll(() => sortUrl?.searchParams.get('sortBy')).toBe('serviceMonth');
});

test('log payment dialog preserves each invoice line service month and defaults new allocations to latest month', async ({ page }) => {
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

  await expect(logDialog.locator('#payment-alloc-0-month')).toHaveValue('2026-08');
  await expect(logDialog.getByTestId('input-payment-alloc-0-amount')).toHaveValue('100.00');
  await expect(logDialog.locator('#payment-alloc-1-month')).toHaveValue('2026-07');
  await expect(logDialog.getByTestId('input-payment-alloc-1-amount')).toHaveValue('25.00');
  await logDialog.getByTestId('button-add-payment-allocation').click();
  await expect(logDialog.locator('#payment-alloc-2-month')).toHaveValue('2026-08');
  await logDialog.getByTestId('button-remove-payment-alloc-2').click();

  // Submit
  await logDialog.getByTestId('input-payment-check-number').fill('CHK-1');
  await logDialog.getByTestId('input-payment-date').fill('2026-08-01');
  await page.getByTestId('button-save-payment').click();

  await expect.poll(() => createPayload).toMatchObject({
    allocations: [
      { authorizationId: 'auth-1', serviceMonth: '2026-08', amount: '100.00' },
      { authorizationId: 'auth-1', serviceMonth: '2026-07', amount: '25.00' }
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

test('edit payment keeps allocation service months and invoice selection repopulates line months', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/payments?*', (route) => route.fulfill({ json: {
    total: 1,
    items: [{
      id: 'payment-edit-1', clientId: client.id, clientName: 'Pat Participant', vendorId: 'vendor-1',
      vendorName: 'Test Vendor', invoiceId: null, qbCheckNumber: 'CHK-EDIT', checkDate: '2026-09-01',
      amount: '125.00', paymentMonth: '2026-07', paymentType: 'direct_payment', source: 'manual',
      remitted: false, allocatedAmount: '0.00', remainingAmount: '125.00',
      allocations: [
        { id: 'allocation-1', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2026-08', amount: '100.00' },
        { id: 'allocation-2', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2026-07', amount: '25.00' },
      ],
    }],
  } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({ json: { total: 2, items: authorizations } }));
  await page.route('**/api/invoices?*', (route) => route.fulfill({ json: { total: 1, items: [invoices.approved] } }));
  let patchPayload: any = null;
  await page.route('**/api/payments/payment-edit-1', (route) => {
    if (route.request().method() === 'PATCH') {
      patchPayload = route.request().postDataJSON();
      return route.fulfill({ status: 200, json: {} });
    }
    return route.continue();
  });

  await page.goto('/payments');
  await page.getByTestId('button-edit-payment').click();
  const dialog = page.getByRole('dialog', { name: 'Edit Payment' });
  await expect(dialog.locator('#edit-payment-alloc-0-month')).toHaveValue('2026-08');
  await expect(dialog.locator('#edit-payment-alloc-1-month')).toHaveValue('2026-07');
  await dialog.getByTestId('select-payment-invoice-id').click();
  await page.getByRole('option', { name: /2026-08/ }).click();
  await expect(dialog.locator('#edit-payment-alloc-0-month')).toHaveValue('2026-08');
  await expect(dialog.locator('#edit-payment-alloc-1-month')).toHaveValue('2026-07');
  await dialog.getByTestId('button-save-payment').click();
  await expect.poll(() => patchPayload).toMatchObject({
    allocations: [
      { authorizationId: 'auth-1', serviceMonth: '2026-08', amount: '100.00' },
      { authorizationId: 'auth-1', serviceMonth: '2026-07', amount: '25.00' },
    ],
  });
});

test('3-line invoice editor across 2 auths and 2 months computes totals and submits correctly', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { total: 1, items: [client] } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({ json: { total: 2, items: authorizations } }));
  await page.route('**/api/storage/uploads/request-url', (route) => route.fulfill({
    json: { uploadURL: '/test-upload/invoice', objectPath: '/objects/uploads/staff/11111111-1111-4111-8111-111111111111' },
  }));
  await page.route('**/test-upload/**', (route) => route.fulfill({ status: 200, body: '' }));

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
  await page.getByTestId('input-file-upload').setInputFiles({
    name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 invoice'),
  });
  await expect(page.getByTestId('text-invoice-document-attached')).toBeVisible();
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