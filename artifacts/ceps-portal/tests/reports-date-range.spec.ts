import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-1',
  name: 'Test Staff',
  email: 'staff@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-18T12:00:00.000Z',
};

async function mockReportsApis(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/users?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/reports/vendor-payments?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/dashboard/summary', (route) =>
    route.fulfill({
      json: {
        totals: {
          activeClients: 0,
          activeAuthorizations: 0,
          pendingInvoices: 0,
          vendorsMissingW9: 0,
          paymentsThisMonth: 0,
          unmatchedRemittances: 0,
        },
        referralsByStatus: [],
      },
    }),
  );
}

test('Reports uses a single-level date range menu for presets, custom dates, and clearing', async ({ page }) => {
  await mockReportsApis(page);
  await page.goto('/reports');

  const dateRange = page.getByText('Date Range', { exact: true }).locator('..');
  const control = dateRange.getByRole('button').first();

  await control.click();
  const presets = page.getByTestId('date-range-presets');
  await expect(presets.getByRole('button')).toHaveText([
    'Today',
    'This Week',
    'This Month',
    'This Quarter',
    'Custom Range',
  ]);
  await expect(page.getByText('Date Range Preset')).toHaveCount(0);
  await expect(presets.locator('..').getByRole('combobox')).toHaveCount(0);

  await presets.getByRole('button', { name: 'Today' }).click();
  await expect(control.getByTestId('date-range-display')).not.toHaveText('Date range');

  await page.getByTestId('date-range-presets').getByRole('button', { name: 'Custom Range' }).click();
  const startDate = page.getByLabel('Start Date');
  const endDate = page.getByLabel('End Date');
  await expect(startDate).toBeVisible();
  await expect(endDate).toBeVisible();

  await startDate.fill('2026-09-01');
  await endDate.fill('2026-09-15');
  await expect(control.getByTestId('date-range-display')).toHaveText('Sep 1, 26 - Sep 15, 26');
  await expect(startDate).toHaveAttribute('max', '2026-09-15');
  await expect(endDate).toHaveAttribute('min', '2026-09-01');

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(control.getByTestId('date-range-display')).toHaveText('Date range');
  await expect(page.getByLabel('Start Date')).toHaveCount(0);
  await expect(page.getByLabel('End Date')).toHaveCount(0);
});