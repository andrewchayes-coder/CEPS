import { expect, test, type Page } from '@playwright/test';

async function openReferral(page: Page, calls: { count: number; body?: any }, role = 'staff', heldForReview = false) {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: { id: 'test-staff', name: 'Test Staff', email: 'staff@example.test', role, active: true, permissions: [] },
  }));
  await page.route('**/api/referrals', (route) => {
    if (route.request().method() === 'POST') {
      calls.count++;
      calls.body = route.request().postDataJSON();
      return route.fulfill({
        status: heldForReview ? 202 : 201,
        json: heldForReview
          ? { id: 'new-referral', status: 'pending_review', message: 'Referral submitted. CEPS will review it and follow up with you.' }
          : { id: 'new-referral', clientId: 'new-client', serviceCoordinatorId: 'test-staff', status: 'intake' },
      });
    }
    return route.continue();
  });
  await page.goto('/referrals/new');
}

async function submitFilledReferral(page: Page) {
  await fillThroughParticipant(page);
  await chooseLanguage(page, 'Spanish');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Submit Referral', exact: true }).click();
  await expect(page.getByText('Referral submitted', { exact: true })).toBeVisible();
}

test('normal success downloads a receipt and allows a fresh referral without resubmitting', async ({ page }) => {
  const calls = { count: 0 };
  await openReferral(page, calls);
  await page.route('**/api/referrals/new-referral/confirmation.pdf', route =>
    route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\nconfirmation test response' }));
  await submitFilledReferral(page);
  await expect(page.getByRole('link', { name: 'View referral', exact: true })).toHaveAttribute('href', '/referrals/new-referral');
  const download = page.waitForEvent('download');
  await page.getByTestId('button-download-confirmation').click();
  expect((await download).suggestedFilename()).toMatch(/^ceps-referral-confirmation-.*\.pdf$/);
  await page.getByTestId('button-submit-another-referral').click();
  await expect(page.getByLabel('Coordinator Name')).toHaveValue('');
  expect(calls.count).toBe(1);
});

test('held success has download-only access and a failed download can be retried', async ({ page }) => {
  const calls = { count: 0 };
  let downloads = 0;
  await openReferral(page, calls, 'service_coordinator', true);
  await page.route('**/api/referrals/new-referral/confirmation.pdf', route => {
    downloads++;
    return downloads === 1
      ? route.fulfill({ status: 500, json: { error: 'Unable to prepare confirmation' } })
      : route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\nconfirmation test response' });
  });
  await submitFilledReferral(page);
  await expect(page.getByTestId('status-referral-pending-review')).toContainText('CEPS will review');
  await expect(page.getByRole('link', { name: 'View referral', exact: true })).toHaveCount(0);
  await page.getByTestId('button-download-confirmation').click();
  await expect(page.getByTestId('error-download-confirmation')).toContainText('Could not download the confirmation');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await download;
  expect(downloads).toBe(2);
  expect(calls.count).toBe(1);
});

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
  await page.getByLabel('Service start date').fill('2026-10-01');
  await page.getByLabel('Service end date').fill('2027-05-01');
  await page.getByLabel('Monthly authorization amount').fill('123.45');
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

test.describe('download-only submission list', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('shows only receipt fields and preserves the submission calendar date', async ({ page }) => {
    await page.route('**/api/**', route => route.fulfill({ json: [] }));
    await page.route('**/api/auth/me', route => route.fulfill({ json: {
      id: 'coordinator', role: 'service_coordinator', name: 'Coordinator', email: 'coordinator@test.local',
    } }));
    await page.route('**/api/referrals?*', route => {
      const mine = new URL(route.request().url()).searchParams.get('submittedByMe') === 'true';
      return route.fulfill({ json: {
        items: mine ? [{ id: 'receipt-1', referralDate: '2026-10-09', clientName: 'Receipt Participant', status: 'pending_review' }] : [],
        total: mine ? 1 : 0,
      } });
    });
    await page.goto('/referrals');
    await page.getByText('My submissions', { exact: true }).click();
    const row = page.getByTestId('row-submission-receipt-1');
    await expect(row).toContainText('Oct 9, 2026');
    await expect(row).toContainText('Receipt Participant');
    await expect(row).toContainText('Pending CEPS review');
    await expect(row.locator('a')).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Vendor', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await row.getByText('Receipt Participant').click();
    await expect(page).toHaveURL(/\/referrals$/);
  });
});

async function chooseLanguage(page: Page, language: string) {
  await page.getByTestId('select-preferred-language').click();
  if (language === 'Other') {
    await page.getByRole('listbox').press('End');
    await expect(page.getByRole('option', { name: 'Other', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    return;
  }
  await page.getByRole('option', { name: language, exact: true }).click();
}

test('Participant cannot advance without a language for either adult or minor', async ({ page }) => {
  const calls = { count: 0 };
  await openReferral(page, calls);
  await fillThroughParticipant(page);
  await expect(page.getByTestId('select-preferred-language')).toContainText('Select a language');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Preferred language is required')).toBeVisible();
  await expect(page.getByText('Supporting Documents', { exact: true })).not.toBeVisible();
  await page.getByRole('radio', { name: 'Yes' }).click();
  await page.getByLabel('Parent/Guardian Name').fill('Morgan Rivera');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Preferred language is required')).toBeVisible();
  expect(calls.count).toBe(0);
});

test('Other requires text and saves trimmed effective language for coordinator intake', async ({ page }) => {
  const calls: { count: number; body?: any } = { count: 0 };
  await openReferral(page, calls, 'service_coordinator');
  await fillThroughParticipant(page);
  await chooseLanguage(page, 'Other');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Preferred language is required')).toBeVisible();
  await page.getByTestId('input-preferred-language-other').fill('  Somali  ');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Supporting Documents', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('review-preferred-language')).toHaveText('Somali');
  await page.getByRole('button', { name: 'Submit Referral' }).click();
  await expect.poll(() => calls.count).toBe(1);
  expect(calls.body.intakeFields.preferredLanguage).toBe('Somali');
});

test('Documents Next opens Review without creating a referral; only Submit creates once', async ({ page }) => {
  const calls = { count: 0 };
  await openReferral(page, calls);
  await fillThroughParticipant(page);
  await chooseLanguage(page, 'Spanish');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Supporting Documents', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Review & Submit', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-01', { exact: true })).toBeVisible();
  await expect(page.getByText('2027-05-01', { exact: true })).toBeVisible();
  await expect(page.getByText('Monthly authorization amount:', { exact: true })).toBeVisible();
  await expect(page.getByText('$123.45', { exact: true })).toBeVisible();
  await expect(page.getByTestId('review-preferred-language')).toHaveText('Spanish');
  await page.waitForTimeout(2300); // The regression used to submit and redirect after about two seconds.
  expect(calls.count).toBe(0);
  await expect(page.getByRole('button', { name: 'Submit Referral', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Submit Referral', exact: true }).click();
  await expect.poll(() => calls.count).toBe(1);
  expect(calls.body.intakeFields.contactEmail).toBe('pat@example.test');
  expect(calls.body.intakeFields.authAmount).toBe('123.45');
  expect(calls.body.intakeFields.serviceFrequency).toBe('monthly');
  expect(calls.body.intakeFields.preferredLanguage).toBe('Spanish');
  expect(calls.body.intakeFields.familyRepName).toBeUndefined();
  expect(calls.body.intakeFields.familyRepRelationship).toBeUndefined();
  expect(calls.body.intakeFields.familyRepPhone).toBeUndefined();
  expect(calls.body.intakeFields.familyRepEmail).toBeUndefined();
  expect(calls.body.intakeFields.familyRepAddress).toBeUndefined();
});

test('Enter in a Participant text input advances to Documents without submitting', async ({ page }) => {
  const calls = { count: 0 };
  await openReferral(page, calls);
  await fillThroughParticipant(page);
  await chooseLanguage(page, 'English');
  await page.getByLabel('UCI Number').press('Enter');
  await expect(page.getByText('Supporting Documents', { exact: true })).toBeVisible();
  expect(calls.count).toBe(0);
});

test('adult intake can add a family representative without replacing participant contact details', async ({ page }) => {
  const calls: { count: number; body?: any } = { count: 0 };
  await openReferral(page, calls);
  await fillThroughParticipant(page);
  await chooseLanguage(page, 'Ukrainian');
  await page.getByTestId('toggle-optional-family-representative').click();
  await expect(page.getByTestId('optional-family-representative')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Morgan Rivera');
  await page.getByRole('combobox', { name: 'Relationship' }).click();
  await page.getByRole('option', { name: 'Guardian' }).click();
  await page.getByLabel('Phone', { exact: true }).fill('5559876543');
  await page.getByLabel('Email', { exact: true }).fill('morgan@example.test');
  await page.getByLabel('Address', { exact: true }).fill('12 Oak Street');

  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Submit Referral', exact: true }).click();
  await expect.poll(() => calls.count).toBe(1);

  expect(calls.body.intakeFields.clientIsMinor).toBe(false);
  expect(calls.body.intakeFields.contactEmail).toBe('pat@example.test');
  expect(calls.body.intakeFields.contactPhone).toBe('5551234567');
  expect(calls.body.intakeFields.contactStreet).toBe('200 Main St');
  expect(calls.body.intakeFields.familyRepName).toBe('Morgan Rivera');
  expect(calls.body.intakeFields.familyRepRelationship).toBe('guardian');
  expect(calls.body.intakeFields.familyRepPhone).toBe('5559876543');
  expect(calls.body.intakeFields.familyRepEmail).toBe('morgan@example.test');
  expect(calls.body.intakeFields.familyRepAddress).toBe('12 Oak Street');
});

test('adult family representative details require a name and valid optional email', async ({ page }) => {
  const calls = { count: 0 };
  await openReferral(page, calls);
  await fillThroughParticipant(page);
  await chooseLanguage(page, 'English');
  await page.getByTestId('toggle-optional-family-representative').click();
  await page.getByLabel('Phone', { exact: true }).fill('5559876543');
  await page.getByLabel('Email', { exact: true }).fill('not-an-email');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Name is required when adding a family representative')).toBeVisible();
  await expect(page.getByText('Enter a valid family representative email')).toBeVisible();
  await expect(page.getByText('Supporting Documents', { exact: true })).not.toBeVisible();
  expect(calls.count).toBe(0);
});