import { expect, test, type Page } from '@playwright/test';

const referralId = 'agreement-referral';
const staff = { id: 'staff-1', name: 'Staff User', email: 'staff@test.local', role: 'staff' };

function referral(overrides: Record<string, unknown> = {}) {
  return {
    id: referralId,
    clientId: 'client-1',
    clientName: 'Jordan Rivera',
    clientIsMinor: false,
    participantEmail: 'jordan@test.local',
    familyRepEmail: 'family@test.local',
    referralDate: '2026-09-05',
    status: 'intake',
    submittedVia: 'staff_manual_entry',
    intakeFields: {
      clientFirstName: 'Jordan',
      clientLastName: 'Rivera',
      clientDob: '2000-01-01',
      clientUci: 'UCI-100',
      regionalCenterName: 'Alta California Regional Center',
      coordinatorName: 'Case Coordinator',
      coordinatorPhone: '916-555-0101',
      familyRepName: 'Pat Rivera',
      contactPhone: '916-555-0102',
      contactStreet: '123 Family Way',
      contactCity: 'Sacramento',
      contactState: 'CA',
      contactZip: '95814',
      vendorName: 'Community Arts Club',
      vendorContactPerson: 'Alex Program',
      vendorPhone: '916-555-0103',
      vendorServiceStreet: '456 Activity Lane',
      vendorServiceCity: 'Sacramento',
      vendorServiceState: 'CA',
      vendorServiceZip: '95814',
      activityDescription: 'Community art class',
      serviceType: 'direct_pay_459',
      serviceStartDate: '2026-10-01',
      serviceEndDate: '2027-03-31',
    },
    intakeSentAt: null,
    intakeSentTo: null,
    parentSignedAt: null,
    serviceFrequency: 'monthly',
    cost: '210.00',
    paymentSchedule: '$210 on the 1st',
    paymentTypeRequested: 'service_payment',
    ...overrides,
  };
}

async function mockStaff(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
}

function canonicalAgreement(overrides: Record<string, unknown> = {}) {
  return {
    referralId,
    clientName: 'Jordan Current Record',
    participantUci: 'CURRENT-UCI',
    participantDob: '2000-02-02',
    clientIsMinor: false,
    intakeSentTo: 'participant',
    regionalCenter: 'Current Regional Center',
    serviceCoordinatorName: 'Current Coordinator',
    serviceCoordinatorPhone: '916-555-0199',
    representativeName: 'Jordan Current Record',
    contactPhone: '916-555-0188',
    contactEmail: 'jordan@test.local',
    mailingAddress: '999 Current Address',
    vendorName: 'Community Arts Club',
    activityDescription: 'Community art class',
    activityContactName: 'Alex Program',
    activityContactPhone: '916-555-0103',
    activityMailingAddress: '456 Activity Lane, Sacramento, CA, 95814',
    serviceType: 'direct_pay_459',
    serviceStartDate: '2026-10-01',
    serviceEndDate: '2027-03-31',
    serviceFrequency: 'monthly',
    cost: '210.00',
    paymentSchedule: '$210 on the 1st',
    paymentTypeRequested: 'service_payment',
    alreadySigned: false,
    ...overrides,
  };
}

test('adult first-send reviews all proposed terms and refreshes the send status', async ({ page }) => {
  await mockStaff(page);
  let current = referral();
  let sentBody: Record<string, unknown> | undefined;
  await page.route(`**/api/referrals/${referralId}/agreement-preview`, async (route) => {
    const draft = route.request().postDataJSON();
    await route.fulfill({ json: canonicalAgreement(draft) });
  });
  await page.route(`**/api/referrals/${referralId}/send-intake`, async (route) => {
    sentBody = route.request().postDataJSON();
    current = referral({
      ...sentBody,
      status: 'pending_signature',
      intakeSentAt: '2026-09-05T12:00:00.000Z',
      intakeSentTo: sentBody?.recipient,
    });
    await route.fulfill({ json: { sent: true, devLink: '/sign/example' } });
  });
  await page.route(`**/api/referrals/${referralId}`, (route) => route.fulfill({ json: current }));

  await page.goto(`/referrals/${referralId}`);
  await page.getByTestId('button-open-send-intake').click();
  await expect(page.getByTestId('input-intake-cost')).toHaveValue('210.00');
  await expect(page.getByTestId('input-intake-schedule')).toHaveValue('$210 on the 1st');
  await page.getByTestId('select-recipient-participant').click();
  await page.getByTestId('input-intake-cost').fill('225.50');
  await page.getByTestId('input-intake-schedule').fill('$225.50 monthly');
  await expect(page.getByTestId('button-submit-send-intake')).toBeDisabled();
  await page.getByTestId('button-preview-agreement').click();
  await expect(page.getByTestId('agreement-review')).toContainText('Participant Information');
  await expect(page.getByTestId('agreement-review')).toContainText('Jordan Current Record');
  await expect(page.getByTestId('agreement-review')).toContainText('Current Regional Center');
  await expect(page.getByTestId('agreement-review')).not.toContainText('Alta California Regional Center');
  await expect(page.getByTestId('agreement-review')).toContainText('Community Arts Club');
  await expect(page.getByTestId('agreement-terms')).toContainText('1. Purpose of RC Funds');
  await expect(page.getByTestId('agreement-cost')).toHaveText('$225.50');
  await expect(page.getByTestId('agreement-payment-schedule')).toHaveText('$225.50 monthly');
  await page.getByTestId('button-submit-send-intake').click();

  await expect.poll(() => sentBody).toMatchObject({
    recipient: 'participant',
    serviceFrequency: 'monthly',
    cost: '225.50',
    paymentSchedule: '$225.50 monthly',
    paymentTypeRequested: 'service_payment',
  });
  await expect(page.getByText('Awaiting Signature')).toBeVisible();
  await expect(page.getByText(/Sent to Participant/)).toBeVisible();
});

test('resend still exposes and submits the full agreement terms', async ({ page }) => {
  await mockStaff(page);
  let sentBody: Record<string, unknown> | undefined;
  await page.route(`**/api/referrals/${referralId}/agreement-preview`, async (route) => {
    const draft = route.request().postDataJSON();
    await route.fulfill({
      json: canonicalAgreement({
        ...draft,
        intakeSentTo: 'family_rep',
        representativeName: 'Pat Current Record',
        contactEmail: 'family@test.local',
      }),
    });
  });
  await page.route(`**/api/referrals/${referralId}/send-intake`, async (route) => {
    sentBody = route.request().postDataJSON();
    await route.fulfill({ json: { sent: true, devLink: '/sign/replacement' } });
  });
  await page.route(`**/api/referrals/${referralId}`, (route) =>
    route.fulfill({
      json: referral({
        status: 'pending_signature',
        intakeSentAt: '2026-09-04T12:00:00.000Z',
        intakeSentTo: 'family_rep',
      }),
    }),
  );

  await page.goto(`/referrals/${referralId}`);
  await page.getByTestId('button-open-send-intake').click();
  await expect(page.getByTestId('input-intake-cost')).toBeVisible();
  await page.getByTestId('select-recipient-family').click();
  await page.getByTestId('input-intake-schedule').fill('Two equal installments');
  await page.getByTestId('button-preview-agreement').click();
  await expect(page.getByTestId('agreement-review')).toContainText('Pat Current Record');
  await expect(page.getByTestId('agreement-review')).toContainText('family@test.local');
  await expect(page.getByTestId('agreement-terms')).toContainText('5. Service Payment and/or Reimbursement Process');
  await expect(page.getByTestId('agreement-payment-schedule')).toHaveText('Two equal installments');
  await page.getByTestId('button-submit-send-intake').click();
  await expect.poll(() => sentBody).toMatchObject({
    recipient: 'family_rep',
    cost: '210.00',
    paymentSchedule: 'Two equal installments',
  });
});

test('minor cannot choose participant and missing family email displays the API action', async ({ page }) => {
  await mockStaff(page);
  await page.route(`**/api/referrals/${referralId}/agreement-preview`, (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'Add an email to the family rep record before sending the intake agreement' },
    }),
  );
  await page.route(`**/api/referrals/${referralId}/send-intake`, (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'Add an email to the family rep record before sending the intake agreement' },
    }),
  );
  await page.route(`**/api/referrals/${referralId}`, (route) =>
    route.fulfill({
      json: referral({ clientIsMinor: true, participantEmail: 'minor@test.local', familyRepEmail: null }),
    }),
  );

  await page.goto(`/referrals/${referralId}`);
  await page.getByTestId('button-open-send-intake').click();
  await expect(page.getByTestId('select-recipient-participant')).toBeDisabled();
  await page.getByTestId('select-recipient-family').click();
  await page.getByTestId('button-preview-agreement').click();
  await expect(
    page.getByText('Add an email to the family rep record before sending the intake agreement', { exact: true }),
  ).toBeVisible();
});

test('public agreement shows proposed terms and submits the selected relationship', async ({ page }) => {
  let submission: Record<string, unknown> | undefined;
  await page.route('**/api/signature/family-token', async (route) => {
    if (route.request().method() === 'POST') {
      submission = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, accountCreated: false, accountCreationError: null } });
      return;
    }
    await route.fulfill({
      json: {
        referralId,
        clientName: 'Jordan Rivera',
        clientIsMinor: true,
        intakeSentTo: 'family_rep',
        activityDescription: 'Community art class',
        serviceFrequency: 'monthly',
        cost: '225.50',
        paymentSchedule: '$225.50 monthly',
        paymentTypeRequested: 'service_payment',
        alreadySigned: false,
      },
    });
  });

  await page.goto('/sign/family-token');
  await expect(page.getByText('$225.50', { exact: true })).toBeVisible();
  await expect(page.getByText('$225.50 monthly', { exact: true })).toBeVisible();
  await page.getByTestId('radio-rel-guardian').click();
  await page.getByTestId('input-signature-name').fill('Pat Rivera');
  await page.getByTestId('checkbox-agreement').click();
  await page.getByTestId('button-submit-signature').click();
  await expect.poll(() => submission).toMatchObject({
    typedName: 'Pat Rivera',
    agreed: true,
    signerRelationship: 'guardian',
  });
  await expect(page.getByText('Agreement Signed')).toBeVisible();
});

test('adult participant agreement fixes the relationship to self', async ({ page }) => {
  await page.route('**/api/signature/adult-token', (route) =>
    route.fulfill({
      json: {
        referralId,
        clientName: 'Jordan Rivera',
        clientIsMinor: false,
        intakeSentTo: 'participant',
        activityDescription: 'Community art class',
        alreadySigned: false,
      },
    }),
  );

  await page.goto('/sign/adult-token');
  await expect(page.getByTestId('badge-relationship-self')).toHaveText('Participant (Self)');
  await expect(page.getByTestId('radio-group-relationship')).toHaveCount(0);
});