import { expect, test, type Page } from '@playwright/test';

const referralId = 'analytics-referral';
const staff = { id: 'staff-1', name: 'Staff User', email: 'staff@test.local', role: 'staff' };

type AnalyticsEvent = {
  name: string;
  data?: Record<string, string | number | boolean>;
};

function referral(overrides: Record<string, unknown> = {}) {
  return {
    id: referralId,
    clientId: 'client-1',
    clientName: 'Jordan Rivera',
    clientIsMinor: false,
    participantEmail: 'private-participant@example.com',
    familyRepEmail: 'private-family@example.com',
    referralDate: '2026-09-05',
    status: 'intake',
    submittedVia: 'staff_manual_entry',
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

function agreement(recipient: 'participant' | 'family_rep') {
  return {
    referralId,
    clientName: 'Jordan Rivera',
    clientIsMinor: false,
    intakeSentTo: recipient,
    representativeName: recipient === 'participant' ? 'Jordan Rivera' : 'Pat Rivera',
    contactEmail: recipient === 'participant'
      ? 'private-participant@example.com'
      : 'private-family@example.com',
    vendorName: 'Community Arts Club',
    activityDescription: 'Community art class',
    serviceFrequency: 'monthly',
    cost: '210.00',
    paymentSchedule: '$210 on the 1st',
    paymentTypeRequested: 'service_payment',
    agreementText: 'Bounded analytics regression test agreement.',
    alreadySigned: false,
  };
}

async function setup(
  page: Page,
  options: {
    referralOverrides?: Record<string, unknown>;
    previewError?: { status: number; message: string };
    sendError?: { status: number; message: string };
  } = {},
) {
  await page.addInitScript(() => {
    const events: AnalyticsEvent[] = [];
    Object.defineProperty(window, '__analyticsEvents', { value: events });
    Object.defineProperty(window, 'umami', {
      value: {
        track: (name: string, data?: AnalyticsEvent['data']) => events.push({ name, data }),
      },
    });
  });
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
  await page.route(`**/api/referrals/${referralId}`, (route) =>
    route.fulfill({ json: referral(options.referralOverrides) }),
  );
  await page.route(`**/api/referrals/${referralId}/agreement-preview`, async (route) => {
    if (options.previewError) {
      await route.fulfill({
        status: options.previewError.status,
        json: { error: options.previewError.message },
      });
      return;
    }
    const body = route.request().postDataJSON() as { recipient: 'participant' | 'family_rep' };
    await route.fulfill({ json: agreement(body.recipient) });
  });
  await page.route(`**/api/referrals/${referralId}/send-intake`, (route) => {
    if (options.sendError) {
      return route.fulfill({
        status: options.sendError.status,
        json: { error: options.sendError.message },
      });
    }
    return route.fulfill({ json: { sent: true, devLink: '/sign/example' } });
  });
}

async function openAndChoose(page: Page, recipient: 'participant' | 'family_rep') {
  await page.goto(`/referrals/${referralId}`);
  await page.getByTestId('button-open-send-intake').click();
  await page.getByTestId(
    recipient === 'participant' ? 'select-recipient-participant' : 'select-recipient-family',
  ).click();
}

async function analyticsEvents(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __analyticsEvents: AnalyticsEvent[] }
  ).__analyticsEvents);
}

async function expectNoSensitiveAnalytics(page: Page, rawError?: string) {
  const serialized = JSON.stringify(await analyticsEvents(page));
  expect(serialized).not.toContain('private-participant@example.com');
  expect(serialized).not.toContain('private-family@example.com');
  if (rawError) expect(serialized).not.toContain(rawError);
}

for (const scenario of [
  {
    label: 'first send to participant',
    recipient: 'participant' as const,
    referralOverrides: {},
    sendType: 'first_send',
  },
  {
    label: 'resend to family representative',
    recipient: 'family_rep' as const,
    referralOverrides: { intakeSentAt: '2026-09-04T12:00:00.000Z' },
    sendType: 'resend',
  },
]) {
  test(`${scenario.label} emits only bounded success dimensions`, async ({ page }) => {
    await setup(page, { referralOverrides: scenario.referralOverrides });
    await openAndChoose(page, scenario.recipient);
    await page.getByTestId('button-preview-agreement').click();
    await expect(page.getByTestId('agreement-review')).toBeVisible();
    await page.getByTestId('button-submit-send-intake').click();

    await expect.poll(() => analyticsEvents(page)).toContainEqual({
      name: 'agreement_send_succeeded',
      data: {
        recipient_type: scenario.recipient,
        send_type: scenario.sendType,
      },
    });
    await expectNoSensitiveAnalytics(page);
  });
}

for (const validation of [
  {
    stage: 'preview' as const,
    message: 'Add an email to the participant record before sending the intake agreement',
    reason: 'missing_recipient_email',
  },
  {
    stage: 'preview' as const,
    message: 'A minor cannot sign their own agreement',
    reason: 'participant_is_minor',
  },
  {
    stage: 'send' as const,
    message: 'Confirm that the participant is not a minor before sending',
    reason: 'minor_status_unconfirmed',
  },
  {
    stage: 'send' as const,
    message: 'The supplied agreement details are invalid: internal field cost_code',
    reason: 'invalid_request',
  },
]) {
  test(`${validation.stage} validation maps to ${validation.reason} without raw error data`, async ({ page }) => {
    await setup(page, {
      previewError: validation.stage === 'preview'
        ? { status: 400, message: validation.message }
        : undefined,
      sendError: validation.stage === 'send'
        ? { status: 400, message: validation.message }
        : undefined,
    });
    await openAndChoose(page, 'participant');
    await page.getByTestId('button-preview-agreement').click();

    if (validation.stage === 'send') {
      await expect(page.getByTestId('agreement-review')).toBeVisible();
      await page.getByTestId('button-submit-send-intake').click();
    }

    await expect.poll(() => analyticsEvents(page)).toContainEqual({
      name: 'agreement_send_validation_failed',
      data: {
        recipient_type: 'participant',
        send_type: 'first_send',
        stage: validation.stage,
        reason: validation.reason,
      },
    });
    await expectNoSensitiveAnalytics(page, validation.message);
  });
}

for (const stage of ['preview', 'send'] as const) {
  test(`${stage} non-validation errors do not emit validation analytics`, async ({ page }) => {
    const message = `Provider outage containing private-participant@example.com at ${stage}`;
    await setup(page, {
      previewError: stage === 'preview' ? { status: 503, message } : undefined,
      sendError: stage === 'send' ? { status: 503, message } : undefined,
    });
    await openAndChoose(page, 'participant');
    await page.getByTestId('button-preview-agreement').click();

    if (stage === 'send') {
      await expect(page.getByTestId('agreement-review')).toBeVisible();
      await page.getByTestId('button-submit-send-intake').click();
    }

    await expect(page.getByText(message, { exact: true })).toBeVisible();
    expect(await analyticsEvents(page)).not.toContainEqual(
      expect.objectContaining({ name: 'agreement_send_validation_failed' }),
    );
    await expectNoSensitiveAnalytics(page, message);
  });
}