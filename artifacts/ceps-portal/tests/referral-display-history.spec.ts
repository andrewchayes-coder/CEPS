import { test, expect, type Page } from '@playwright/test';

const id = 'referral-display';
const referral = {
  id, clientId: 'display-participant', clientName: 'Display Participant', clientIsMinor: false,
  referralDate: '2026-09-01', status: 'intake', serviceCoordinatorId: 'current-coordinator',
  coordinatorName: 'Current Coordinator', coordinatorReviewStatus: 'approved', vendorName: 'Stored Vendor',
  submittedByUserId: 'original-submitter', submittedByName: 'Original Submitter', submittedByRole: 'staff',
  intakeFields: { coordinatorName: 'Form Contact', coordinatorEmail: 'form@test.local', vendorName: 'Entered Vendor' },
  intakeSentAt: null, parentSignedAt: null,
};
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
});
async function session(page: Page, role: string) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    id: role === 'staff' ? 'display-staff' : 'current-coordinator', name: 'Display User', email: 'display@test.local', role,
  } }));
}

for (const role of ['staff', 'service_coordinator']) {
  test(`${role} sees the sortable Vendor column and the unchanged Intake badge`, async ({ page }) => {
    await session(page, role);
    let sorting = '';
    await page.route('**/api/referrals?*', route => {
      sorting = new URL(route.request().url()).searchParams.get('sortBy') || '';
      return route.fulfill({ json: { items: [referral], total: 1 } });
    });
    await page.goto('/referrals');
    await expect(page.getByRole('columnheader', { name: /Vendor/ })).toBeVisible();
    await expect(page.getByText('Stored Vendor', { exact: true })).toBeVisible();
    await expect(page.getByText('Intake', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sort by Vendor', exact: true }).click();
    await expect.poll(() => sorting).toBe('vendorName');
  });
}

for (const submitterRole of ['staff', 'service_coordinator']) {
  test(`detail shows an original ${submitterRole} submitter, referral wording and staff-only history`, async ({ page }) => {
    await session(page, 'staff');
    await page.route(`**/api/referrals/${id}`, route => route.fulfill({ json: { ...referral, submittedByRole: submitterRole } }));
    await page.route(`**/api/referrals/${id}/history`, route => route.fulfill({ json: [
      { id: 'newest-history', userName: 'Staff Actor', action: 'update_referral', createdAt: '2026-09-02T12:00:00Z',
        detail: 'Coordinator reassigned: Previous Coordinator → Current Coordinator' },
      { id: 'older-history', userName: 'Original Submitter', action: 'create_referral', createdAt: '2026-09-01T12:00:00Z', detail: 'Original submission' },
    ] }));
    await page.goto(`/referrals/${id}`);
    await expect(page.getByText('Referral Status', { exact: true })).toBeVisible();
    const status = page.getByText(/^intake$/i);
    await expect(status).toBeVisible();
    await expect(status).toHaveCSS('text-transform', 'capitalize');
    const label = submitterRole === 'staff' ? 'Staff' : 'Service Coordinator';
    await expect(page.getByTestId('text-referral-original-submitter')).toHaveText(`Submitted by: Original Submitter (${label}) on Sep 1, 2026`);
    await expect(page.getByText('Referral contact (as entered on the form): Form Contact · form@test.local')).toBeVisible();
    const history = page.getByTestId('referral-history');
    await expect(history.locator('li')).toHaveCount(2);
    await expect(history.locator('li').first()).toContainText('Coordinator reassigned: Previous Coordinator → Current Coordinator');
    await expect(history.locator('li').first()).toContainText('Staff Actor');
    await expect(page.getByRole('button', { name: 'Send Referral Agreement', exact: true })).toBeVisible();
    await page.getByTestId('button-open-send-intake').click();
    await expect(page.getByRole('heading', { name: 'Send Referral Agreement', exact: true })).toBeVisible();
  });
}

test('coordinator sees original submitter but never requests or sees staff history', async ({ page }) => {
  await session(page, 'service_coordinator');
  let historyRequests = 0;
  await page.route(`**/api/referrals/${id}`, route => route.fulfill({ json: referral }));
  await page.route(`**/api/referrals/${id}/history`, route => {
    historyRequests++;
    return route.fulfill({ status: 403, json: { error: 'Forbidden' } });
  });
  await page.goto(`/referrals/${id}`);
  await expect(page.getByTestId('text-referral-original-submitter')).toContainText('Original Submitter (Staff)');
  await expect(page.getByTestId('referral-history')).toHaveCount(0);
  expect(historyRequests).toBe(0);
});

test('family signing page uses Referral Packet and has no intake text', async ({ page }) => {
  await page.route('**/api/sign/display-token', route => route.fulfill({ json: {
    referralId: id, clientName: 'Display Participant', clientIsMinor: false, intakeSentTo: 'participant',
    regionalCenter: 'Display Center', serviceCoordinatorName: 'Current Coordinator', agreementText: 'Referral Agreement\nTerms for review.',
    serviceFrequency: 'monthly', cost: '160.00', paymentSchedule: 'Monthly', paymentTypeRequested: 'service_payment',
    alreadySigned: false,
  } }));
  await page.goto('/sign/display-token');
  await expect(page.getByText('Community Engaged Payee Support (CEPS) Referral Packet', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/intake/i);
});
