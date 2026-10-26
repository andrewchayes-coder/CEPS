import { expect, test, type Page } from '@playwright/test';

const staff = {
  id: 'staff-active-participants',
  name: 'Active Participants Staff',
  email: 'active-participants@test.local',
  role: 'staff',
  active: true,
};

const summary = {
  referralsByStatus: [{ status: 'active', count: 1 }],
  totals: {
    activeClients: 101,
    activeAuthorizations: 0,
    pendingInvoices: 0,
    vendorsMissingW9: 0,
    paymentsThisMonth: '0.00',
    unmatchedRemittances: 0,
    unmatchedPosDocuments: 0,
  },
  alerts: [],
  recentActivity: [],
};

async function setup(page: Page, requests: URL[]) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
  await page.route('**/api/dashboard/summary', (route) => route.fulfill({ json: summary }));
  await page.route('**/api/clients*', (route) => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { items: [], total: 101 } });
  });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('dashboard Active Participants tile navigates to active participants and status navigation filters/reset pagination', async ({ page }) => {
  const requests: URL[] = [];
  await setup(page, requests);
  await page.goto('/');

  const tile = page.getByTestId('card-kpi-clients');
  await expect(tile).toContainText('Active Participants');
  await expect(tile).toContainText('Currently active');
  await tile.click();
  await expect(page).toHaveURL(/\/clients\?status=active$/);
  await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible();
  const status = page.getByTestId('select-participant-status');
  await expect(status).toHaveValue('active');
  await expect.poll(() => requests.some((url) => url.searchParams.get('status') === 'active')).toBe(true);

  // Add an unrelated parameter to ensure status changes preserve existing query state.
  await page.goto('/clients?status=active&source=dashboard-regression');
  await expect(status).toHaveValue('active');
  await expect(page.getByTestId('button-clients-next')).toBeEnabled();
  await page.getByTestId('button-clients-next').click();
  await expect(page.getByTestId('text-clients-pagination')).toContainText('Showing 51–100');
  await expect.poll(() => requests.some((url) => url.searchParams.get('status') === 'active' && url.searchParams.get('offset') === '50')).toBe(true);

  await status.selectOption('inactive');
  await expect(page).toHaveURL(/\/clients\?status=inactive&source=dashboard-regression$/);
  await expect(status).toHaveValue('inactive');
  await expect(page.getByTestId('text-clients-pagination')).toContainText('Showing 1–50');
  await expect.poll(() => requests.some((url) => url.searchParams.get('status') === 'inactive' && url.searchParams.get('offset') === '0')).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL(/\/clients\?status=active&source=dashboard-regression$/);
  await expect(status).toHaveValue('active');
  await expect(page.reload()).resolves.toBeTruthy();
  await expect(status).toHaveValue('active');
  await expect.poll(() => requests.some((url) => url.searchParams.get('status') === 'active' && url.searchParams.get('offset') === '0')).toBe(true);

  await status.selectOption('all');
  await expect(page).toHaveURL(/\/clients\?source=dashboard-regression$/);
  await expect(status).toHaveValue('all');
  await expect.poll(() => requests.some((url) => !url.searchParams.has('status') && url.searchParams.get('offset') === '0')).toBe(true);
  await page.reload();
  await expect(status).toHaveValue('all');
  await expect.poll(() => requests.some((url) => !url.searchParams.has('status'))).toBe(true);
});
