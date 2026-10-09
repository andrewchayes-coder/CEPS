import { test, expect, type Page } from '@playwright/test';

async function activity(page: Page) {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    id: 'staff', name: 'Staff', role: 'staff', email: 'staff@test.local', permissions: [],
  } }));
  await page.goto('/referrals/new');
  await page.getByLabel('Coordinator Name').fill('Coordinator');
  await page.getByLabel('Email Address').fill('coordinator@test.local');
  await page.getByLabel('Direct Phone Number').fill('5551234567');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Vendor / Business Name').fill('Vendor');
  await page.getByLabel('Vendor Email').fill('vendor@test.local');
  await page.getByLabel('Vendor Phone').fill('5551234567');
  await page.getByPlaceholder('Street Address').fill('1 Main St');
  await page.getByPlaceholder('City').fill('Sacramento');
  await page.getByPlaceholder('ZIP Code').fill('95814');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Activity Information', { exact: true })).toBeVisible();
  await page.getByLabel('Description of Activity').fill('Art lessons');
}

test('Activity requires amount and end date, rejects reversed dates, and has no TBD option', async ({ page }) => {
  await activity(page);
  await page.getByLabel('Service start date').fill('2026-09-01');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Authorization amount is required')).toBeVisible();
  await expect(page.getByText('Service end date is required')).toBeVisible();
  await expect(page.getByText('Activity Information', { exact: true })).toBeVisible();
  await expect(page.getByText(/\bTBD\b/i)).toHaveCount(0);
  await page.getByLabel('Service end date').fill('2026-08-01');
  await page.getByLabel('Monthly authorization amount').fill('123.45');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Service end date must be on or after service start date')).toBeVisible();
  await page.getByLabel('Service end date').fill('2026-09-01');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Participant Information', { exact: true })).toBeVisible();
});

test('one-time frequency changes the amount label and rejects zero or excess decimals', async ({ page }) => {
  await activity(page);
  await page.getByLabel('Service start date').fill('2026-09-01');
  await page.getByLabel('Service end date').fill('2026-09-30');
  await page.getByLabel('Service Frequency', { exact: true }).click();
  await page.getByRole('option', { name: 'One-time', exact: true }).click();
  for (const value of ['0.00', '1.234']) {
    await page.getByLabel('Total authorization amount').fill(value);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Enter a positive authorization amount with up to two decimal places')).toBeVisible();
  }
  await page.getByLabel('Total authorization amount').fill('42.50');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Participant Information', { exact: true })).toBeVisible();
});

const id = 'service-referral';
async function detail(page: Page, fields: Record<string, unknown>, own: Record<string, unknown> = {}) {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    id: 'staff', name: 'Staff', role: 'staff', email: 'staff@test.local', permissions: [],
  } }));
  await page.route(`**/api/referrals/${id}`, route => route.fulfill({ json: {
    id, clientId: 'participant', clientName: 'Participant', referralDate: '2026-09-01', status: 'intake',
    clientIsMinor: false, participantEmail: 'participant@test.local', coordinatorReviewStatus: 'approved',
    intakeFields: fields, serviceFrequency: null, cost: null, ...own,
  } }));
  await page.goto(`/referrals/${id}`);
}

test('detail displays service dates and amount, and agreement uses editable intake defaults', async ({ page }) => {
  await detail(page, { serviceStartDate: '2026-09-01', serviceEndDate: '2026-12-31', authAmount: '123.45', serviceFrequency: 'monthly' });
  await expect(page.getByText('Dates: 2026-09-01 to 2026-12-31', { exact: true })).toBeVisible();
  await expect(page.getByText('Authorization amount: $123.45 (monthly)', { exact: true })).toBeVisible();
  await page.getByTestId('button-open-send-intake').click();
  await expect(page.getByTestId('input-intake-cost')).toHaveValue('123.45');
  await expect(page.getByTestId('select-intake-frequency')).toContainText('Monthly');
  await page.getByTestId('input-intake-cost').fill('99.00');
  await expect(page.getByTestId('input-intake-cost')).toHaveValue('99.00');
});

test('agreement defaults never overwrite an existing cost or frequency', async ({ page }) => {
  await detail(page, { authAmount: '123.45', serviceFrequency: 'monthly' }, { cost: '88.00', serviceFrequency: 'one_time' });
  await page.getByTestId('button-open-send-intake').click();
  await expect(page.getByTestId('input-intake-cost')).toHaveValue('88.00');
  await expect(page.getByTestId('select-intake-frequency')).toContainText(/one[- ]?time/i);
});

test('legacy referral displays missing fields and can save notes without supplying service fields', async ({ page }) => {
  await detail(page, {});
  await expect(page.getByText('Dates: —', { exact: true })).toBeVisible();
  await expect(page.getByText('Authorization amount: —', { exact: true })).toBeVisible();
  let body: any;
  await page.route(`**/api/referrals/${id}`, route => {
    if (route.request().method() === 'PATCH') {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { id } });
    }
    return route.fallback();
  });
  await page.getByTestId('button-edit-referral').click();
  await page.getByRole('dialog').getByRole('textbox').last().fill('Updated legacy note');
  await page.getByTestId('button-save-referral').click();
  await expect.poll(() => body).toBeTruthy();
  expect(body.notes).toBe('Updated legacy note');
  expect(body.intakeFields).toBeUndefined();
});

test('staff service edits validate dates and preserve the JSON through a narrow PATCH', async ({ page }) => {
  await detail(page, { serviceStartDate: '2026-09-01', serviceEndDate: '2026-12-31', authAmount: '123.45' });
  let body: any;
  await page.route(`**/api/referrals/${id}`, route => {
    if (route.request().method() === 'PATCH') {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { id } });
    }
    return route.fallback();
  });
  await page.getByTestId('button-edit-referral').click();
  await page.getByLabel('Service end date').fill('2026-08-01');
  await page.getByTestId('button-save-referral').click();
  await expect(page.getByRole('alert')).toHaveText('Service end date must be on or after service start date');
  expect(body).toBeUndefined();
  await page.getByLabel('Service end date').fill('2026-10-01');
  await page.getByLabel('Authorization amount', { exact: true }).fill('0012.3');
  await page.getByTestId('button-save-referral').click();
  await expect.poll(() => body?.intakeFields).toEqual({ serviceStartDate: '2026-09-01', serviceEndDate: '2026-10-01', authAmount: '12.30' });
});
