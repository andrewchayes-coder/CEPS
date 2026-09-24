import { expect, test, type Page } from '@playwright/test';

async function openReferral(page: Page, calls: { count: number }) {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: { id: 'test-staff', name: 'Test Staff', email: 'staff@example.test', role: 'staff', active: true, permissions: [] },
  }));
  await page.route('**/api/referrals', (route) => {
    if (route.request().method() === 'POST') {
      calls.count++;
      return route.fulfill({ status: 201, json: { id: 'new-referral' } });
    }
    return route.continue();
  });
  await page.goto('/referrals/new');
}

async function fillThroughParticipant(page: Page) {
  await page.getByLabel('Coordinator Name').fill('Alex Coordinator');
  await page.getByLabel('Email Address').fill('alex@example.test');
  await page.getByLabel('Direct Phone Number').fill('5551234567');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Vendor Details', { exact: true })).toBeVisible();

  await page.getByLabel('Vendor / Business Name').fill('Example Vendor');
  await page.getByLabel('Vendor Email').fill('vendor@example.test');
  await page.getByLabel('Vendor Phone').fill('5551234567');
  await page.getByPlaceholder('Street Address').fill('123 Market St');
  await page.getByPlaceholder('City').fill('Sacramento');
  await page.getByPlaceholder('ZIP Code').fill('95814');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Activity Information', { exact: true })).toBeVisible();

  await page.getByLabel('Description of Activity').fill('Weekly art lessons');
  await page.getByLabel('Anticipated Start Date').fill('2026-10-01');
  await page.getByLabel('Anticipated End Date').fill('2027-05-01');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Participant Information', { exact: true })).toBeVisible();

  await page.getByLabel('First Name').fill('Pat');
  await page.getByLabel('Last Name').fill('Participant');
  await page.getByLabel('Date of Birth').fill('2005-01-01');
  await page.getByLabel('UCI Number').fill('12345678');
  await page.getByLabel('Email Address').fill('pat@example.test');
  await page.getByLabel('Phone Number').fill('5551234567');
  await page.getByPlaceholder('Street Address').fill('200 Main St');
  await page.getByPlaceholder('City').fill('Sacramento');
  await page.getByPlaceholder('ZIP').fill('95814');
}

test('Documents Next opens Review without creating a referral; only Submit creates once', async ({ page }) => {
  const calls = { count: 0 };
  await openReferral(page, calls);
  await fillThroughParticipant(page);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Supporting Documents', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Review & Submit', { exact: true })).toBeVisible();
  await page.waitForTimeout(2300); // The regression used to submit and redirect after about two seconds.
  expect(calls.count).toBe(0);
  await expect(page.getByRole('button', { name: 'Submit Referral', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Submit Referral', exact: true }).click();
  await expect.poll(() => calls.count).toBe(1);
});

test('Enter in a Participant text input advances to Documents without submitting', async ({ page }) => {
  const calls = { count: 0 };
  await openReferral(page, calls);
  await fillThroughParticipant(page);
  await page.getByLabel('UCI Number').press('Enter');
  await expect(page.getByText('Supporting Documents', { exact: true })).toBeVisible();
  expect(calls.count).toBe(0);
});