import { expect, test, type Page } from '@playwright/test';

const client = {
  id: 'contact-client',
  firstName: 'Ari',
  lastName: 'Rivera',
  uciNumber: '8936241',
  dateOfBirth: '2011-03-12',
  status: 'active',
  phone: 'CLIENT-555',
  email: 'client@example.test',
  address: 'Client Lane',
};

const primary = {
  id: 'primary-rep',
  clientId: client.id,
  name: 'Mara Rivera',
  relationship: 'parent',
  isPrimary: true,
  phone: 'REP-555',
  email: 'mara@example.test',
  address: 'Representative Road',
  userId: 'parent-1',
  hasPortalAccount: true,
  portalAccountStatus: 'active',
};

const secondary = {
  ...primary,
  id: 'second-rep',
  name: 'Rene Rivera',
  relationship: 'guardian',
  isPrimary: false,
  phone: 'OTHER-555',
  email: 'rene@example.test',
  address: 'Second Street',
  userId: null,
  hasPortalAccount: false,
  portalAccountStatus: 'none',
};

async function setup(page: Page, isMinor: boolean, reps: typeof primary[], role = 'staff') {
  let current = reps;
  let updated: { id: string; data: Record<string, unknown> } | undefined;
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: { id: role === 'staff' ? 'staff-1' : 'parent-1', name: 'Case User', email: 'case@example.test', role },
  }));
  await page.route('**/api/clients/contact-client/case', (route) => route.fulfill({
    json: {
      client: { ...client, isMinor }, authorizations: [], invoices: [], payments: [],
      remittances: [], referrals: [], documents: [],
    },
  }));
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/family-representatives?*', (route) => route.fulfill({ json: current }));
  await page.route('**/api/family-representatives/*', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const id = route.request().url().split('/').pop()!;
    const data = JSON.parse(route.request().postData() || '{}');
    updated = { id, data };
    current = current.map((rep) => rep.id === id ? { ...rep, ...data } : rep);
    return route.fulfill({ json: current.find((rep) => rep.id === id) });
  });
  await page.goto('/clients/contact-client');
  await expect(page.getByTestId('contact-subheader')).toBeVisible();
  return { getUpdated: () => updated };
}

test('minor primary is the main contact, editable through the representative endpoint, without a duplicate row', async ({ page }) => {
  const state = await setup(page, true, [primary]);
  await expect(page.getByTestId('contact-subheader')).toHaveText('Family Representative');
  await expect(page.getByTestId('contact-name')).toHaveText(primary.name);
  await expect(page.getByTestId('contact-phone')).toHaveText(primary.phone);
  await expect(page.getByTestId('contact-email')).toHaveText(primary.email);
  await expect(page.getByTestId('contact-address')).toHaveText(primary.address);
  await expect(page.getByTestId('rep-row-primary-rep')).toHaveCount(0);
  await expect(page.getByTestId('button-add-family-rep')).toBeVisible();
  await page.getByTestId('card-contact-information').getByTestId('button-edit-rep-primary-rep').click();
  await page.getByTestId('input-rep-phone').fill('NEW-555');
  await page.getByTestId('button-save-rep').click();
  await expect(page.getByTestId('contact-phone')).toHaveText('NEW-555');
  expect(state.getUpdated()).toMatchObject({ id: primary.id, data: { phone: 'NEW-555' } });
});

test('adult uses client contact, with representatives in a separate card only when present', async ({ page }) => {
  await setup(page, false, []);
  await expect(page.getByTestId('contact-subheader')).toHaveText('Client');
  await expect(page.getByTestId('contact-phone')).toHaveText(client.phone);
  await expect(page.getByTestId('contact-email')).toHaveText(client.email);
  await expect(page.getByTestId('contact-address')).toHaveText(client.address);
  await expect(page.getByTestId('rep-row-primary-rep')).toHaveCount(0);
  await expect(page.getByTestId('button-add-family-rep')).toBeVisible();
});

test('adult with reps shows own contact above a vertical representative card', async ({ page }) => {
  await setup(page, false, [primary]);
  await expect(page.getByTestId('contact-subheader')).toHaveText('Client');
  await expect(page.getByTestId('contact-phone')).toHaveText(client.phone);
  await expect(page.getByTestId('rep-row-primary-rep')).toContainText(primary.name);
  await expect(page.getByTestId('rep-address-primary-rep')).toContainText(primary.address);
});

test('minor with multiple reps shows only remaining reps below, with wrapped actions and no overflow', async ({ page }) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await setup(page, true, [primary, secondary]);
    await expect(page.getByTestId('contact-name')).toHaveText(primary.name);
    await expect(page.getByTestId('rep-row-primary-rep')).toHaveCount(0);
    const row = page.getByTestId('rep-row-second-rep');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('rep-phone-second-rep')).toContainText(secondary.phone);
    await expect(row.getByTestId('rep-email-second-rep')).toContainText(secondary.email);
    await expect(row.getByTestId('rep-address-second-rep')).toContainText(secondary.address);
    await expect(row.getByTestId('rep-actions-second-rep')).toBeVisible();
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
});

test('family member may edit their own primary contact but cannot edit another representative', async ({ page }) => {
  const state = await setup(page, true, [primary, secondary], 'parent_guardian');
  await expect(page.getByTestId('card-contact-information').getByTestId('button-edit-my-info-primary-rep')).toBeVisible();
  await expect(page.getByTestId('button-edit-rep-primary-rep')).toHaveCount(0);
  await expect(page.getByTestId('button-edit-my-info-second-rep')).toHaveCount(0);
  await expect(page.getByTestId('button-add-family-rep')).toHaveCount(0);
  await page.getByTestId('button-edit-my-info-primary-rep').click();
  await page.getByTestId('input-my-info-phone').fill('FAMILY-555');
  await page.getByTestId('button-save-my-info').click();
  await expect(page.getByTestId('contact-phone')).toHaveText('FAMILY-555');
  expect(state.getUpdated()).toMatchObject({ id: primary.id, data: { phone: 'FAMILY-555' } });
  expect(state.getUpdated()?.data).not.toHaveProperty('isPrimary');
});