import { expect, test, type Page } from '@playwright/test';

const participantId = 'participant-1';
const referralId = 'referral-1';
const participantName = 'Jordan Rivera';

const baseUser = {
  id: 'user-1',
  name: 'Test User',
  email: 'user@example.test',
  phone: null,
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const referral = {
  id: referralId,
  clientId: participantId,
  clientName: participantName,
  coordinatorName: 'Case Coordinator',
  referralDate: '2026-09-01',
  parentEmail: 'parent@example.test',
  status: 'intake',
  intakeFields: {
    clientFirstName: 'Jordan',
    clientLastName: 'Rivera',
    clientDob: '2000-01-01',
    clientUci: 'UCI-100',
    preferredLanguage: 'English',
    serviceType: 'direct_pay_459',
    activityDescription: 'Community activity',
    serviceStartDate: '2026-09-01',
    serviceEndDate: '2026-09-30',
    vendorName: 'Example Vendor',
    vendorEmail: 'vendor@example.test',
  },
};

async function mockSession(page: Page, role: string) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { ...baseUser, role } }),
  );
}

async function mockReferralList(page: Page) {
  await page.route('**/api/referrals?*', (route) =>
    route.fulfill({ json: { items: [referral], total: 1 } }),
  );
}

async function mockReferralDetail(page: Page) {
  await page.route(`**/api/referrals/${referralId}`, (route) =>
    route.fulfill({ json: referral }),
  );
}

test('key staff pages use Participant wording while preserving client record routes', async ({ page }) => {
  await mockSession(page, 'staff');
  await page.route('**/api/clients?*', (route) =>
    route.fulfill({
      json: {
        items: [{
          id: participantId,
          firstName: 'Jordan',
          lastName: 'Rivera',
          uciNumber: 'UCI-100',
          dateOfBirth: '2000-01-01',
          assignedCoordinatorName: 'Case Coordinator',
          status: 'active',
        }],
        total: 1,
      },
    }),
  );

  await page.goto('/clients');

  await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: participantName })).toHaveAttribute(
    'href',
    `/clients/${participantId}`,
  );

  await page.goto('/help');

  await expect(page.getByText('Convert to participant')).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
});

test('referral list and detail participant names link to the existing client record', async ({ page }) => {
  await mockSession(page, 'staff');
  await mockReferralList(page);
  await mockReferralDetail(page);

  await page.goto('/referrals');

  await expect(page.getByRole('columnheader', { name: /Participant/ })).toBeVisible();
  await expect(page.getByPlaceholder('Search participants or coordinators...')).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: participantName })).toHaveAttribute(
    'href',
    `/clients/${participantId}`,
  );

  await page.goto(`/referrals/${referralId}`);

  const participantLinks = page.getByRole('link', { name: participantName });
  await expect(page.getByText('Participant Info')).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
  await expect(participantLinks).toHaveCount(2);
  await expect(participantLinks.first()).toHaveAttribute('href', `/clients/${participantId}`);
  await expect(participantLinks.last()).toHaveAttribute('href', `/clients/${participantId}`);
});

test('referral participant names remain plain text when the role cannot open client records', async ({ page }) => {
  await mockSession(page, 'restricted');
  await mockReferralList(page);
  await mockReferralDetail(page);

  await page.goto('/referrals');

  await expect(page.getByText(participantName)).toBeVisible();
  await expect(page.getByRole('link', { name: participantName })).toHaveCount(0);

  await page.goto(`/referrals/${referralId}`);

  await expect(page.getByText(participantName)).toHaveCount(2);
  await expect(page.getByRole('link', { name: participantName })).toHaveCount(0);
});