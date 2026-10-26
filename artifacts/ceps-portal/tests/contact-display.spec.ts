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
  createdAt: '2024-02-01T00:00:00.000Z',
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

const primaryWithoutPortal = {
  ...primary,
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
  await page.route('**/api/clients/contact-client/message-threads*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/clients/contact-client/notes', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/messages/unread-count', (route) => route.fulfill({ json: { count: 0 } }));
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

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

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

test('minor without a flagged primary shows the earliest-created active representative', async ({ page }) => {
  const older = { ...primary, id: 'older-rep', isPrimary: false, createdAt: '2022-01-01T00:00:00.000Z' };
  const newer = { ...secondary, id: 'newer-rep', isPrimary: false, createdAt: '2024-01-01T00:00:00.000Z' };
  const state = await setup(page, true, [newer, older]);
  await expect(page.getByTestId('contact-subheader')).toHaveText('Family Representative');
  await expect(page.getByTestId('contact-name')).toHaveText(older.name);
  await expect(page.getByTestId('contact-phone')).toHaveText(older.phone);
  await expect(page.getByTestId('contact-email')).toHaveText(older.email);
  await expect(page.getByTestId('contact-address')).toHaveText(older.address);
  await expect(page.getByTestId('rep-row-older-rep')).toHaveCount(0);
  await expect(page.getByTestId('rep-row-newer-rep')).toBeVisible();
  await page.getByTestId('card-contact-information').getByTestId('button-edit-rep-older-rep').click();
  await page.getByTestId('input-rep-phone').fill('UPDATED-OLDER-555');
  await page.getByTestId('button-save-rep').click();
  await expect(page.getByTestId('contact-phone')).toHaveText('UPDATED-OLDER-555');
  expect(state.getUpdated()).toMatchObject({ id: older.id, data: { phone: 'UPDATED-OLDER-555' } });
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

test('adult participant invite is inside Contact Information and opens a participant-named dialog', async ({ page }) => {
  await setup(page, false, [primary, secondary]);
  const contactCard = page.getByTestId('card-contact-information');
  await expect(contactCard.getByTestId('button-invite-portal')).toHaveText('Invite participant to portal');
  await expect(page.getByTestId('rep-row-second-rep').getByTestId('button-invite-portal')).toHaveText('Invite to portal');
  await expect(page.getByTestId('button-invite-portal')).toHaveCount(2);

  await contactCard.getByTestId('button-invite-portal').click();
  await expect(page.getByRole('heading', { name: 'Invite to portal' })).toBeVisible();
  await expect(page.getByText(/Send a portal invite for Ari Rivera\./)).toBeVisible();
});

test('minor links to family representatives while retaining secondary representative invite', async ({ page }) => {
  await setup(page, true, [primary, secondary]);
  const contactCard = page.getByTestId('card-contact-information');
  const familyInviteLink = contactCard.getByTestId('link-invite-family-representatives');
  await expect(familyInviteLink).toHaveText('Invite parents or guardians from the Family Representatives section.');
  await expect(contactCard.getByTestId('button-invite-portal')).toHaveCount(0);
  await expect(page.getByTestId('rep-row-second-rep').getByTestId('button-invite-portal')).toBeVisible();
  await familyInviteLink.click();
  await expect(page).toHaveURL(/#family-representatives$/);
  await expect(page.getByTestId('card-family-representatives')).toBeInViewport();
});

test('minor primary without portal access gets an invite at the top of the representatives section, not a duplicate row', async ({ page }) => {
  await setup(page, true, [primaryWithoutPortal, secondary]);
  const section = page.getByTestId('card-family-representatives');
  await expect(page.getByTestId('rep-row-primary-rep')).toHaveCount(0);
  await expect(section.getByTestId('primary-representative-invite')).toBeVisible();
  await expect(section.getByTestId('primary-representative-invite').getByTestId('button-invite-portal')).toBeVisible();
  await expect(page.getByTestId('rep-row-second-rep').getByTestId('button-invite-portal')).toBeVisible();

  await section.getByTestId('primary-representative-invite').getByTestId('button-invite-portal').click();
  await expect(page.getByText(/Send a portal invite for Mara Rivera\./)).toBeVisible();
  await expect(page.getByTestId('input-invite-email')).toHaveValue(primary.email);
});

test('coordinator and family users cannot see participant invite or minor staff-only link', async ({ browser }) => {
  for (const role of ['service_coordinator', 'parent_guardian']) {
    for (const isMinor of [false, true]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await setup(page, isMinor, [primary, secondary], role);
        const contactCard = page.getByTestId('card-contact-information');
        await expect(contactCard.getByTestId('button-invite-portal')).toHaveCount(0);
        await expect(contactCard.getByTestId('link-invite-family-representatives')).toHaveCount(0);
      } finally {
        await page.unrouteAll({ behavior: 'wait' });
        await context.close();
      }
    }
  }
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