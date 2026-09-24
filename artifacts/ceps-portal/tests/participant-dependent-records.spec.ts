import { expect, test, type Page, type Route } from '@playwright/test';

const staffUser = {
  id: 'staff-1',
  name: 'Test Staff',
  email: 'staff@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const clients = [
  { id: 'client-1', firstName: 'Pat', lastName: 'Participant', uciNumber: 'UCI-1', dateOfBirth: '1990-01-01', status: 'active' },
  { id: 'client-2', firstName: 'Sam', lastName: 'Second', uciNumber: 'UCI-2', dateOfBirth: '1991-01-01', status: 'active' },
];

const authorizations = {
  'client-1': [{ id: 'authorization-1', clientId: 'client-1', vendorId: 'vendor-1', authNumber: 'AUTH-100', status: 'active' }],
  'client-2': [{ id: 'authorization-2', clientId: 'client-2', vendorId: 'vendor-2', authNumber: 'AUTH-200', status: 'active' }],
};

const vendors = {
  'client-1': [{ id: 'vendor-1', name: 'Pat Provider', status: 'active' }],
  'client-2': [{ id: 'vendor-2', name: 'Sam Provider', status: 'active' }],
};

const invoices = {
  'client-1': [{ id: 'invoice-1', clientId: 'client-1', vendorId: 'vendor-1', serviceMonth: '2026-07', amountRequested: '125.00', status: 'approved', lineItems: [] }],
  'client-2': [{ id: 'invoice-2', clientId: 'client-2', vendorId: 'vendor-2', serviceMonth: '2026-08', amountRequested: '225.00', status: 'approved', lineItems: [] }],
};

type ClientId = keyof typeof authorizations;

function filteredItems<T>(url: string, records: Record<ClientId, T[]>) {
  const clientId = new URL(url).searchParams.get('clientId') as ClientId;
  return records[clientId] ?? [];
}

async function mockStaffSession(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) =>
    route.fulfill({ json: { total: clients.length, items: clients } }),
  );
}

async function mockParticipantDependencies(
  page: Page,
  requests: { authorizations: URL[]; vendors: URL[]; invoices: URL[] },
) {
  await page.route('**/api/authorizations?*', (route) => {
    requests.authorizations.push(new URL(route.request().url()));
    const items = filteredItems(route.request().url(), authorizations);
    return route.fulfill({ json: { total: items.length, items } });
  });
  await page.route('**/api/vendors?*', (route) => {
    requests.vendors.push(new URL(route.request().url()));
    const items = filteredItems(route.request().url(), vendors);
    return route.fulfill({ json: { total: items.length, items } });
  });
  await page.route('**/api/invoices?*', (route) => {
    requests.invoices.push(new URL(route.request().url()));
    const items = filteredItems(route.request().url(), invoices);
    return route.fulfill({ json: { total: items.length, items } });
  });
}

function expectLastRequestFor(requests: URL[], clientId: string) {
  return expect.poll(() => requests.at(-1)?.searchParams.get('clientId')).toBe(clientId);
}

async function selectOption(page: Page, selectTestId: string, optionName: string) {
  await page.getByTestId(selectTestId).click();
  await page.getByRole('option', { name: optionName }).click();
}

test('invoice submission keeps authorization and vendor scoped to the selected participant', async ({ page }) => {
  const requests = { authorizations: [] as URL[], vendors: [] as URL[], invoices: [] as URL[] };
  let createPayload: Record<string, unknown> | undefined;

  await mockStaffSession(page);
  await mockParticipantDependencies(page, requests);
  await page.route('**/api/invoices', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    createPayload = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: 'invoice-new', ...createPayload } });
  });

  await page.goto('/invoices/new');

  await expect(page.getByRole('combobox', { name: 'Participant' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Vendor' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Payment Type' })).toBeVisible();
  await expect(page.getByTestId('select-line-0-authorization')).toBeVisible();

  await expect(page.getByTestId('select-line-0-authorization')).toBeDisabled();
  await expect(page.getByTestId('select-invoice-vendor')).toBeDisabled();
  expect(requests.authorizations).toHaveLength(0);
  expect(requests.vendors).toHaveLength(0);

  await selectOption(page, 'select-invoice-client', 'Pat Participant');
  await expectLastRequestFor(requests.authorizations, 'client-1');
  await expectLastRequestFor(requests.vendors, 'client-1');
  await selectOption(page, 'select-line-0-authorization', 'AUTH-100');
  await expect(page.getByTestId('select-invoice-vendor')).toContainText('Pat Provider');

  await selectOption(page, 'select-invoice-client', 'Sam Second');
  await expect(page.getByTestId('select-line-0-authorization')).toContainText('Select authorization');
  await expect(page.getByTestId('select-invoice-vendor')).toContainText('Select vendor');
  await expectLastRequestFor(requests.authorizations, 'client-2');
  await expectLastRequestFor(requests.vendors, 'client-2');

  await selectOption(page, 'select-line-0-authorization', 'AUTH-200');
  await page.getByPlaceholder('0.00').fill('225.00');
  await page.getByRole('button', { name: 'Submit Invoice' }).click();

  await expect.poll(() => createPayload).toMatchObject({
    clientId: 'client-2',
    vendorId: 'vendor-2',
    amountRequested: '225.00',
    lineItems: [{ authorizationId: 'authorization-2', amount: '225.00' }]
  });
});

test('payment logging clears all participant-owned choices and submits only the new participant records', async ({ page }) => {
  const requests = { authorizations: [] as URL[], vendors: [] as URL[], invoices: [] as URL[] };
  let createPayload: Record<string, unknown> | undefined;

  await mockStaffSession(page);
  await mockParticipantDependencies(page, requests);
  await page.route('**/api/payments?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/payments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    createPayload = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: 'payment-new', ...createPayload } });
  });

  await page.goto('/payments');
  await page.getByTestId('button-log-payment').click();

  const paymentDialog = page.getByRole('dialog', { name: 'Log Payment' });
  await expect(paymentDialog.getByRole('combobox', { name: 'Participant' })).toBeVisible();
  await expect(paymentDialog.getByLabel('Check #')).toBeVisible();
  await expect(paymentDialog.getByLabel('Payment Date')).toBeVisible();
  await expect(paymentDialog.getByRole('combobox', { name: 'Payment Type' })).toBeVisible();
  await expect(paymentDialog.getByRole('combobox', { name: 'Vendor' })).toBeVisible();
  await expect(paymentDialog.getByRole('combobox', { name: 'Invoice' })).toBeVisible();
  await expect(paymentDialog.getByTestId('select-payment-alloc-0-auth')).toBeVisible();

  await expect(page.getByTestId('select-payment-vendor-id')).toBeDisabled();
  await expect(page.getByTestId('select-payment-invoice-id')).toBeDisabled();
  await expect(page.getByTestId('select-payment-alloc-0-auth')).toBeDisabled();
  expect(requests.authorizations).toHaveLength(0);
  expect(requests.vendors).toHaveLength(0);
  expect(requests.invoices).toHaveLength(0);

  await selectOption(page, 'select-payment-client-id', 'Pat Participant');
  await expectLastRequestFor(requests.authorizations, 'client-1');
  await expectLastRequestFor(requests.vendors, 'client-1');
  await expectLastRequestFor(requests.invoices, 'client-1');
  await selectOption(page, 'select-payment-vendor-id', 'Pat Provider');
  await selectOption(page, 'select-payment-invoice-id', '2026-07 – $125.00');

  await selectOption(page, 'select-payment-client-id', 'Sam Second');
  await expect(page.getByTestId('select-payment-vendor-id')).toContainText('Select vendor');
  await expect(page.getByTestId('select-payment-invoice-id')).toContainText('Select invoice');
  await expect(page.getByTestId('select-payment-alloc-0-auth')).toContainText('Select authorization');
  await expectLastRequestFor(requests.authorizations, 'client-2');
  await expectLastRequestFor(requests.vendors, 'client-2');
  await expectLastRequestFor(requests.invoices, 'client-2');

  await selectOption(page, 'select-payment-vendor-id', 'Sam Provider');
  await selectOption(page, 'select-payment-invoice-id', '2026-08 – $225.00');
  await selectOption(page, 'select-payment-alloc-0-auth', 'AUTH-200');
  await page.getByTestId('input-payment-check-number').fill('CHECK-200');
  await page.getByTestId('input-payment-date').fill('2026-09-05');
  await page.getByTestId('input-payment-alloc-0-amount').fill('225.00');
  await page.getByTestId('button-save-payment').click();

  await expect.poll(() => createPayload).toMatchObject({
    clientId: 'client-2',
    vendorId: 'vendor-2',
    invoiceId: 'invoice-2',
    allocations: [{ authorizationId: 'authorization-2', amount: '225.00' }]
  });
});

test('remittance creation scopes and clears authorization before submission', async ({ page }) => {
  const requests = { authorizations: [] as URL[], vendors: [] as URL[], invoices: [] as URL[] };
  let createPayload: Record<string, unknown> | undefined;

  await mockStaffSession(page);
  await mockParticipantDependencies(page, requests);
  await page.route('**/api/remittances?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/remittances', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    createPayload = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: 'remittance-new', ...createPayload } });
  });

  await page.goto('/remittances');
  await page.getByTestId('button-create-remittance').click();

  const remittanceDialog = page.getByRole('dialog', { name: 'Create Remittance' });
  await expect(remittanceDialog.getByRole('combobox', { name: 'Participant' })).toBeVisible();
  await expect(remittanceDialog.getByRole('combobox', { name: 'Authorization' })).toBeVisible();
  await expect(remittanceDialog.getByLabel('Source / payment reference')).toBeVisible();
  await expect(remittanceDialog.getByLabel('Date received')).toBeVisible();
  await expect(remittanceDialog.getByLabel('Amount')).toBeVisible();
  await expect(remittanceDialog.getByLabel('Service month')).toBeVisible();

  await expect(page.getByTestId('select-create-remittance-authorization')).toBeDisabled();
  expect(requests.authorizations).toHaveLength(0);

  await selectOption(page, 'select-create-remittance-client', 'Pat Participant');
  await expectLastRequestFor(requests.authorizations, 'client-1');
  await selectOption(page, 'select-create-remittance-authorization', 'AUTH-100');

  await selectOption(page, 'select-create-remittance-client', 'Sam Second');
  await expect(page.getByTestId('select-create-remittance-authorization')).toContainText('Select an authorization');
  await expectLastRequestFor(requests.authorizations, 'client-2');

  await selectOption(page, 'select-create-remittance-authorization', 'AUTH-200');
  await page.getByTestId('input-create-remittance-reference').fill('REMIT-200');
  await page.getByTestId('input-create-remittance-date').fill('2026-09-05');
  await page.getByTestId('input-create-remittance-amount').fill('225.00');
  await page.getByTestId('input-create-remittance-month').fill('2026-08');
  await page.getByTestId('button-save-created-remittance').click();

  await expect.poll(() => createPayload).toMatchObject({
    clientId: 'client-2',
    authorizationId: 'authorization-2',
    altaReference: 'REMIT-200',
  });
});

test('invoice edit shows read-only status and never sends status in PATCH', async ({ page }) => {
  await mockStaffSession(page);
  let updatePayload: Record<string, unknown> | null = null;
  await page.route('**/api/invoices/invoice-1', (route) => {
    if (route.request().method() === 'PATCH') {
      updatePayload = route.request().postDataJSON();
      return route.fulfill({ json: { id: 'invoice-1', ...updatePayload } });
    }
    return route.fulfill({
    json: {
      ...invoices['client-1'][0],
      clientName: 'Pat Participant',
      authorizationId: 'authorization-1',
      authNumber: 'AUTH-100',
      vendorId: 'vendor-1',
      vendorName: 'Pat Provider',
      paymentType: 'direct_payment',
      notes: 'Existing note',
      submittedByRole: 'staff',
      lineItems: [{ authorizationId: 'authorization-1', serviceMonth: '2026-07', amount: '125.00' }]
    },
    });
  });
  await page.route('**/api/invoices/invoice-1/validate', (route) => route.fulfill({
    json: { valid: true, checks: [] },
  }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: { total: 1, items: authorizations['client-1'] },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({
    json: { total: 1, items: vendors['client-1'] },
  }));

  await page.goto('/invoices/invoice-1');
  await page.getByTestId('button-edit-invoice').click();

  const dialog = page.getByRole('dialog', { name: 'Edit Invoice' });
  await expect(dialog.getByLabel('Participant')).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Vendor' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Payment Type' })).toBeVisible();
  await expect(dialog.getByText('Use Validate / Approve / Reject on the invoice page to change status.')).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Status' })).toHaveCount(0);
  await expect(dialog.getByLabel('Notes')).toBeVisible();
  await dialog.getByTestId('button-save-invoice').click();
  await expect.poll(() => updatePayload).not.toBeNull();
  expect(updatePayload).not.toHaveProperty('status');
});

test('payment edit fields expose their visible labels as accessible names', async ({ page }) => {
  await mockStaffSession(page);
  await page.route('**/api/payments/payment-1', (route) => route.fulfill({
    json: {
      id: 'payment-1',
      clientId: 'client-1',
      clientName: 'Pat Participant',
      authorizationId: 'authorization-1',
      authNumber: 'AUTH-100',
      vendorId: 'vendor-1',
      vendorName: 'Pat Provider',
      invoiceId: 'invoice-1',
      qbCheckNumber: 'CHECK-100',
      checkDate: '2026-09-05',
      amount: '125.00',
      paymentMonth: '2026-07',
      paymentType: 'direct_payment',
      source: 'manual',
      remitted: false,
      allocations: [{ authorizationId: 'authorization-1', amount: '125.00' }]
    },
  }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: { total: 1, items: authorizations['client-1'] },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({
    json: { total: 1, items: vendors['client-1'] },
  }));
  await page.route('**/api/invoices?*', (route) => route.fulfill({
    json: { total: 1, items: invoices['client-1'] },
  }));

  await page.goto('/payments/payment-1');
  await page.getByTestId('button-edit-payment').click();

  const dialog = page.getByRole('dialog', { name: 'Edit Payment' });
  await expect(dialog.getByLabel('Check #')).toBeVisible();
  await expect(dialog.getByLabel('Payment Date')).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Payment Type' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Vendor' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Invoice' })).toBeVisible();
});