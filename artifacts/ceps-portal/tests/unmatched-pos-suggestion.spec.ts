import { expect, test } from '@playwright/test';

const staff = { id: 'staff-queue-suggestion', name: 'Queue Staff', email: 'queue-suggestion@test.local', role: 'staff', active: true };
const client = { id: 'suggested-client', firstName: 'Suggested', lastName: 'Participant', uciNumber: 'UCI-SUGGESTED', dateOfBirth: '2000-01-01', status: 'active' };
const other = { id: 'other-client', firstName: 'Other', lastName: 'Participant', uciNumber: 'UCI-OTHER', dateOfBirth: '2000-01-01', status: 'active' };
const row = (id: string, suggestedClientId: string | null) => ({
  id, posPdfUrl: `/objects/${id}.pdf`, sourceFileName: `${id}.pdf`, clientName: 'Printed Name',
  clientAddress: null, clientPhone: null, uciNumber: null, authNumber: id, serviceCode: '459',
  activityDescription: 'Therapy', servicePeriodStart: '2026-01-01', servicePeriodEnd: '2026-12-31',
  units: 1, monthlyAmount: '100.00', maxPeriodAmount: '100.00', caseworkerName: null, posNotes: null,
  createdBy: staff.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  suggestedClientId, suggestionMethod: suggestedClientId ? 'uci' : null,
  suggestedAt: suggestedClientId ? '2026-01-01T00:00:00.000Z' : null,
  suggestedClientName: suggestedClientId ? 'Suggested Participant' : null,
});

test('deep-linked suggestion is selected and requires explicit completion', async ({ page }) => {
  const target = row('pos-target', client.id);
  const second = row('pos-second', null);
  let completeCalls = 0;
  let completeBody: unknown;
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { total: 1, items: [other] } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/unmatched-pos?*', (route) => route.fulfill({ json: { items: [second], total: 2 } }));
  await page.route('**/api/unmatched-pos/pos-target', (route) => route.fulfill({ json: target }));
  await page.route('**/api/unmatched-pos/*/complete', async (route) => {
    completeCalls++;
    completeBody = route.request().postDataJSON();
    expect(route.request().url()).toContain('/api/unmatched-pos/pos-target/complete');
    await route.fulfill({ status: 201, json: { saved: true, warnings: [], authorization: { id: 'new-auth', clientId: client.id } } });
  });
  await page.goto('/authorizations/unmatched?id=pos-target');
  const targetCard = page.getByTestId('card-unmatched-pos-target');
  await expect(targetCard).toHaveAttribute('data-highlighted', 'true');
  await expect(targetCard).toContainText('Suggested match — confirm before completing');
  await expect(page.getByTestId('select-client-pos-target')).toContainText('Suggested Participant');
  expect(completeCalls).toBe(0);
  await page.getByTestId('button-complete-pos-target').click();
  await expect.poll(() => completeCalls).toBe(1);
  expect(completeBody).toMatchObject({ clientId: client.id, paymentType: 'direct_payment', acceptMaxAmountWarning: false });
});