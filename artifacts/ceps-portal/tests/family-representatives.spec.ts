import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-1',
  name: 'Test Staff',
  email: 'staff@example.test',
  role: 'staff',
  active: true,
};

const familyUser = {
  id: 'parent-1',
  name: 'Parent User',
  email: 'parent@example.test',
  role: 'parent_guardian',
  active: true,
};

const clients = [
  { id: 'client-1', firstName: 'Pat', lastName: 'Participant', uciNumber: 'UCI-1', dateOfBirth: '1990-01-01', status: 'active', familyRepEmail: 'parent@example.test' },
];

const familyReps = [
  {
    id: 'rep-1',
    clientId: 'client-1',
    name: 'Parent One',
    relationship: 'parent',
    email: 'parent@example.test',
    phone: '555-0000',
    isPrimary: true,
    userId: 'parent-1',
    hasPortalAccount: true,
    portalAccountStatus: 'active',
  },
  {
    id: 'rep-2',
    clientId: 'client-1',
    name: 'Parent Two No Email',
    relationship: 'parent',
    email: null,
    phone: null,
    isPrimary: false,
    userId: null,
    hasPortalAccount: false,
    portalAccountStatus: 'none',
  }
];

const referral = {
  id: 'referral-1',
  clientId: 'client-1',
  clientName: 'Pat Participant',
  referralDate: '2026-09-01T12:00:00.000Z',
  status: 'pending_signature',
  clientIsMinor: false,
};

async function mockSession(page: Page, user: any) {
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/clients/*/case', (route) => {
    return route.fulfill({ json: { client: clients[0], authorizations: [], invoices: [], payments: [], remittances: [], referrals: [referral], documents: [] } });
  });
  await page.route('**/api/clients', (route) => route.fulfill({ json: { total: 1, items: clients } }));
  await page.route('**/api/clients?*', (route) => {
    if (route.request().url().includes('/case')) return route.fallback();
    return route.fulfill({ json: { total: 1, items: clients } });
  });
  await page.route('**/api/referrals/referral-1', (route) => route.fulfill({ json: referral }));
  
  await page.route('**/api/family-representatives?clientId=client-1*', (route) => {
    return route.fulfill({ json: familyReps });
  });
  await page.route('**/api/fees?clientId=client-1*', (route) => {
    return route.fulfill({ json: [] });
  });
}

test('staff add family representative flow', async ({ page }) => {
  await mockSession(page, staffUser);

  let createdPayload: any = null;
  // Mock the POST route
  await page.route('**/api/family-representatives', async (route) => {
    if (route.request().method() === 'POST') {
      createdPayload = JSON.parse(route.request().postData() || '{}');
      const newRep = {
        id: 'rep-new',
        clientId: 'client-1',
        name: createdPayload.name,
        relationship: createdPayload.relationship,
        email: createdPayload.email,
        phone: createdPayload.phone,
        address: createdPayload.address,
        isPrimary: createdPayload.isPrimary,
        userId: null,
        hasPortalAccount: false,
        portalAccountStatus: 'none',
      };
      
      // We need to return this so the frontend thinks it succeeded
      await route.fulfill({ json: newRep });
      
      // Update the mocked GET route so the refetch gets the new item
      const updatedReps = [...familyReps, newRep];
      await page.route('**/api/family-representatives?clientId=client-1*', (listRoute) => {
        return listRoute.fulfill({ json: updatedReps });
      });
      return;
    }
    return route.fallback();
  });

  await page.goto('/clients/client-1');

  // Staff should see Add Representative button and click it
  await page.getByTestId('button-add-family-rep').click();
  
  // Fill the form
  await page.getByTestId('input-rep-name').fill('Aunt Susan');
  
  // Need to handle Select for relationship
  await page.getByTestId('select-rep-relationship').click();
  await page.getByRole('option', { name: 'Other' }).click();
  
  await page.getByTestId('input-rep-phone').fill('555-9999');
  await page.getByTestId('input-rep-email').fill('susan@example.test');
  await page.getByTestId('input-rep-address').fill('123 Main St');
  
  await page.getByTestId('checkbox-rep-primary').click();
  
  // Submit
  await page.getByTestId('button-save-rep').click();
  
  // Wait for the new rep row to appear
  await expect(page.getByTestId('rep-row-rep-new')).toBeVisible();
  
  // Assert on payload
  expect(createdPayload).toMatchObject({
    name: 'Aunt Susan',
    relationship: 'other',
    phone: '555-9999',
    email: 'susan@example.test',
    address: '123 Main St',
    isPrimary: true,
  });
});

test('self edit affordance isolation', async ({ page }) => {
  await mockSession(page, familyUser);

  await page.goto('/clients/client-1');

  // Family user shouldn't see Add Representative button
  await expect(page.getByTestId('button-add-family-rep')).toBeHidden();

  // Family user shouldn't see staff edit/remove buttons
  await expect(page.getByTestId('button-edit-rep-rep-1')).toBeHidden();
  await expect(page.getByTestId('button-remove-rep-rep-1')).toBeHidden();

  // Family user SHOULD see Edit My Info on their OWN row (rep-1)
  await expect(page.getByTestId('button-edit-my-info-rep-1')).toBeVisible();
  
  // Family user SHOULD NOT see Edit My Info on OTHER row (rep-2)
  await expect(page.getByTestId('button-edit-my-info-rep-2')).toBeHidden();
});

test('intake disabled no-email recipient', async ({ page }) => {
  await mockSession(page, staffUser);

  await page.goto('/referrals/referral-1');

  // Open send intake dialog
  await page.getByTestId('button-open-send-intake').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Select Family Representative recipient
  await page.getByTestId('select-recipient-family').click();

  // Dropdown should appear and be enabled
  await expect(page.getByTestId('select-family-rep')).toBeVisible();

  // Open the dropdown
  await page.getByTestId('select-family-rep').click();

  // Check the items
  const options = page.getByRole('option');
  
  // First rep has email and should be enabled
  const rep1 = options.filter({ hasText: 'Parent One' });
  await expect(rep1).toBeEnabled();

  // Second rep has no email and should be disabled
  const rep2 = options.filter({ hasText: 'Parent Two No Email' });
  await expect(rep2).toBeDisabled();
});