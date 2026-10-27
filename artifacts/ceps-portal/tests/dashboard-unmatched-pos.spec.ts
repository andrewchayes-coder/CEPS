import { expect, test } from '@playwright/test';
import { simulateBrowserTranslation } from './translation-helper';

const staff = { id: 'staff-dashboard-pos', name: 'POS Dashboard Staff', email: 'pos-dashboard@test.local', role: 'staff', active: true };
const summary = {
  referralsByStatus: [{ status: 'active', count: 0 }],
  totals: { activeClients: 1, activeAuthorizations: 1, pendingInvoices: 0, vendorsMissingW9: 0, paymentsThisMonth: '0.00', unmatchedRemittances: 0, unmatchedPosDocuments: 2 },
  alerts: [
    { kind: 'unmatched_pos', message: '2 unmatched POS documents awaiting participant matching.', entityType: 'unmatched_pos_document', entityId: null },
    { kind: 'unmatched_pos_possible_match', message: 'POS one may match Alpha One.', entityType: 'unmatched_pos_document', entityId: 'pos-one' },
    { kind: 'unmatched_pos_possible_match', message: 'POS two may match Beta Two.', entityType: 'unmatched_pos_document', entityId: 'pos-two' },
  ],
  recentActivity: [],
};

test('POS review tile and suggestions survive browser translation', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
  await page.route('**/api/dashboard/summary', (route) => route.fulfill({ json: summary }));
  await page.goto('/');
  await expect(page.getByTestId('card-kpi-authorizations-review')).toBeVisible();
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await simulateBrowserTranslation(page)).toBeGreaterThan(10);
  await expect(page.getByTestId('link-tile-pos-review')).toHaveAttribute('href', '/authorizations/review');
  const links = page.locator('[data-testid^="link-alert-unmatched_pos_possible_match-"]');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('href', '/authorizations/review?id=pos-one');
  await expect(links.nth(1)).toHaveAttribute('href', '/authorizations/review?id=pos-two');
  expect(errors).toEqual([]);
});