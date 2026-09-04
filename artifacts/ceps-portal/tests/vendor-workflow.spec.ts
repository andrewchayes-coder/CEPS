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

const vendorUser = {
  ...staffUser,
  id: 'vendor-user-1',
  name: 'Vendor User',
  email: 'vendor@example.test',
  role: 'vendor',
  linkedRecordType: 'vendor',
  linkedRecordId: 'vendor-1',
};

const vendor = {
  id: 'vendor-1',
  name: 'Preferred Provider',
  altaVendorNumber: null,
  ein: null,
  billingAddress: null,
  serviceAddress: null,
  phone: null,
  email: null,
  contactPerson: null,
  w9Status: 'pending',
  w9DocumentUrl: null,
  preferred: true,
  active: true,
  createdAt: '2026-09-04T12:00:00.000Z',
};

async function mockSession(page: Page, user = staffUser) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
}

async function mockVendorList(page: Page) {
  await page.route('**/api/vendors?*', (route) =>
    route.fulfill({ json: { total: 1, items: [vendor] } }),
  );
}

test('staff can open the create form and a successful create navigates to the new record', async ({ page }) => {
  await mockSession(page);
  await mockVendorList(page);
  let createPayload: Record<string, unknown> | undefined;
  await page.route('**/api/vendors', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    createPayload = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { ...vendor, id: 'vendor-new', name: 'New Provider', preferred: false } });
  });
  await page.route('**/api/vendors/vendor-new', (route) =>
    route.fulfill({ json: { ...vendor, id: 'vendor-new', name: 'New Provider', preferred: false } }),
  );

  await page.goto('/vendors');
  await expect(page.getByText('Preferred', { exact: true })).toBeVisible();
  await page.getByTestId('button-add-vendor').click();
  await expect(page).toHaveURL(/\/vendors\/new$/);
  await page.getByTestId('input-vendor-name').fill('New Provider');
  await page.getByTestId('button-create-vendor').click();

  await expect(page).toHaveURL(/\/vendors\/vendor-new$/);
  expect(createPayload).toMatchObject({
    name: 'New Provider',
    w9Status: 'pending',
    preferred: false,
  });
});

test('create failure is actionable and preserves the entered form', async ({ page }) => {
  await mockSession(page);
  await page.route('**/api/vendors', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'A vendor with this business name already exists' }),
    }),
  );

  await page.goto('/vendors/new');
  await page.getByTestId('input-vendor-name').fill('Duplicate Provider');
  await page.getByTestId('button-create-vendor').click();

  await expect(page.getByTestId('error-create-vendor')).toContainText('already exists');
  await expect(page.getByTestId('input-vendor-name')).toHaveValue('Duplicate Provider');
  await expect(page).toHaveURL(/\/vendors\/new$/);
});

test('vendor users cannot see or open the staff create flow', async ({ page }) => {
  await mockSession(page, vendorUser);
  await mockVendorList(page);

  await page.goto('/vendors');
  await expect(page.getByTestId('button-add-vendor')).toHaveCount(0);
  await page.goto('/vendors/new');
  await expect(page).toHaveURL(/\/vendors$/);
  await expect(page.getByTestId('form-create-vendor')).toHaveCount(0);
});

test('staff preferred editing updates the badge from the saved response', async ({ page }) => {
  await mockSession(page);
  let patchPayload: Record<string, unknown> | undefined;
  await page.route('**/api/vendors/vendor-1', async (route) => {
    if (route.request().method() === 'PATCH') {
      patchPayload = route.request().postDataJSON();
      return route.fulfill({ json: { ...vendor, preferred: false } });
    }
    return route.fulfill({ json: vendor });
  });

  await page.goto('/vendors/vendor-1');
  await expect(page.getByTestId('badge-vendor-preferred')).toBeVisible();
  await page.getByTestId('switch-vendor-preferred').click();
  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect.poll(() => patchPayload?.preferred).toBe(false);
  await expect(page.getByTestId('badge-vendor-preferred')).toHaveCount(0);
});