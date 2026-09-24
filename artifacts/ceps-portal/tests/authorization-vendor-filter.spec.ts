import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-vendor-filter',
  name: 'Vendor Filter Staff',
  email: 'vendor-filter@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const clients = [
  { id: 'client-1', firstName: 'Pat', lastName: 'Participant', uciNumber: 'UCI-1' },
  { id: 'client-2', firstName: 'Sam', lastName: 'Second', uciNumber: 'UCI-2' },
];

const vendorOne = { id: 'vendor-1', name: 'Pat Provider' };
const vendorTwo = { id: 'vendor-2', name: 'Second Provider' };
const otherVendor = { id: 'vendor-other', name: 'Unlinked Provider' };

async function mockStaffSession(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) =>
    route.fulfill({ json: { total: clients.length, items: clients } }),
  );
}

async function mockVendorLists(page: Page, requests: URL[]) {
  await page.route('**/api/vendors?*', (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const clientId = url.searchParams.get('clientId');
    const items = clientId === 'client-1'
      ? [vendorOne, otherVendor]
      : clientId === 'client-2'
        ? [vendorTwo]
        : [vendorOne, vendorTwo, otherVendor];
    return route.fulfill({ json: { total: items.length, items } });
  });
}

async function selectClient(page: Page, clientId: string) {
  await page.getByTestId('select-auth-client').click();
  await page.getByTestId(`select-auth-client-option-${clientId}`).click();
}

test('manual authorization entry filters, clears, preselects, and can show all vendors', async ({ page }) => {
  const vendorRequests: URL[] = [];
  await mockStaffSession(page);
  await mockVendorLists(page, vendorRequests);
  await page.goto('/authorizations/new');

  const vendorSelect = page.getByTestId('select-auth-vendor');
  await expect(vendorSelect).toBeDisabled();
  await expect(vendorSelect).toContainText('Select a participant first');
  expect(vendorRequests).toHaveLength(0);

  await selectClient(page, 'client-1');
  await expect.poll(() => vendorRequests.some((url) => url.searchParams.get('clientId') === 'client-1')).toBe(true);
  await vendorSelect.click();
  await expect(page.getByTestId('select-auth-vendor-option-vendor-1')).toBeVisible();
  await expect(page.getByTestId('select-auth-vendor-option-vendor-2')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('checkbox-show-all-auth-vendors').click();
  await expect.poll(() => vendorRequests.some((url) => !url.searchParams.has('clientId'))).toBe(true);
  await vendorSelect.click();
  await expect(page.getByTestId('select-auth-vendor-option-vendor-2')).toBeVisible();
  await page.getByTestId('select-auth-vendor-option-vendor-1').click();

  await selectClient(page, 'client-2');
  await expect(page.getByTestId('checkbox-show-all-auth-vendors')).not.toBeChecked();
  await expect.poll(() => vendorRequests.some((url) => url.searchParams.get('clientId') === 'client-2')).toBe(true);
  await expect(vendorSelect).toContainText('Second Provider');
});

test('POS participant auto-match loads that participant’s vendors and preselects a sole match', async ({ page }) => {
  const vendorRequests: URL[] = [];
  await mockStaffSession(page);
  await mockVendorLists(page, vendorRequests);
  await page.route('**/api/storage/uploads/request-url', (route) => route.fulfill({
    json: {
      uploadURL: '/test-upload/pos',
      objectPath: '/objects/uploads/pos.pdf',
    },
  }));
  await page.route('**/test-upload/pos', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/authorizations/parse-pdf', (route) => route.fulfill({
    json: {
      success: true,
      error: null,
      fields: {
        clientName: 'Sam Second',
        uciNumber: 'UCI-2',
        authNumber: 'POS-AUTOMATCH',
      },
    },
  }));
  await page.route('**/api/unmatched-pos/match', (route) => route.fulfill({
    json: { method: 'uci', client: clients[1] },
  }));
  await page.route('**/api/authorizations/lookup?*', (route) =>
    route.fulfill({ json: { exists: false, authorization: null } }),
  );

  await page.goto('/authorizations/new');
  await page.getByTestId('input-file-upload').setInputFiles({
    name: 'matched-pos.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 participant vendor test'),
  });

  await expect(page.getByTestId('select-auth-client')).toContainText('Sam Second');
  await expect.poll(() => vendorRequests.some((url) => url.searchParams.get('clientId') === 'client-2')).toBe(true);
  await expect(page.getByTestId('select-auth-vendor')).toContainText('Second Provider');
});

test('edit dialog filters by participant and preserves the authorization vendor selection', async ({ page }) => {
  const vendorRequests: URL[] = [];
  await mockStaffSession(page);
  await mockVendorLists(page, vendorRequests);
  await page.route('**/api/authorizations/auth-1', (route) => route.fulfill({
    json: {
      id: 'auth-1',
      clientId: 'client-1',
      clientName: 'Pat Participant',
      authNumber: 'POS-1',
      serviceCode: '459',
      paymentType: 'direct_payment',
      activityDescription: null,
      monthlyAmount: null,
      oneTimeAmount: null,
      maxPeriodAmount: '1200.00',
      servicePeriodStart: '2026-01-01T00:00:00.000Z',
      servicePeriodEnd: '2026-12-31T00:00:00.000Z',
      vendorId: 'vendor-1',
      vendorName: 'Pat Provider',
      status: 'active',
      totalPaid: '0',
      remainingAmount: '1200.00',
      daysUntilExpiry: null,
    },
  }));
  await page.route('**/api/authorizations/auth-1/versions', (route) => route.fulfill({ json: [] }));

  await page.goto('/authorizations/auth-1');
  await page.getByTestId('button-edit-authorization').click();
  await expect.poll(() => vendorRequests.some((url) => url.searchParams.get('clientId') === 'client-1')).toBe(true);
  const dialog = page.getByRole('dialog', { name: 'Edit Authorization' });
  const vendorSelect = dialog.getByTestId('select-auth-vendor');
  await expect(vendorSelect).toContainText('Pat Provider');
  await dialog.getByTestId('checkbox-show-all-edit-auth-vendors').click();
  await expect.poll(() => vendorRequests.some((url) => !url.searchParams.has('clientId'))).toBe(true);
  await expect(vendorSelect).toContainText('Pat Provider');
});