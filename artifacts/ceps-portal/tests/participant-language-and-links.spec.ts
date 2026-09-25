import { expect, test, type Page } from '@playwright/test';

const participantId = 'participant-1';
const referralId = 'referral-1';
const participantName = 'Jordan Rivera';
const remittanceId = 'remittance-1';

const baseUser = {
  id: 'user-1',
  name: 'Test User',
  email: 'user@example.test',
  phone: null,
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const referral = {
  id: referralId,
  clientId: participantId,
  clientName: participantName,
  coordinatorName: 'Case Coordinator',
  referralDate: '2026-09-01',
  parentEmail: 'parent@example.test',
  status: 'intake',
  intakeFields: {
    clientFirstName: 'Jordan',
    clientLastName: 'Rivera',
    clientDob: '2000-01-01',
    clientUci: 'UCI-100',
    preferredLanguage: 'English',
    serviceType: 'direct_pay_459',
    activityDescription: 'Community activity',
    serviceStartDate: '2026-09-01',
    serviceEndDate: '2026-09-30',
    vendorName: 'Example Vendor',
    vendorEmail: 'vendor@example.test',
  },
};

async function mockSession(page: Page, role: string) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { ...baseUser, role } }),
  );
}

async function mockReferralList(page: Page) {
  await page.route('**/api/referrals?*', (route) =>
    route.fulfill({ json: { items: [referral], total: 1 } }),
  );
}

async function mockReferralDetail(page: Page) {
  await page.route(`**/api/referrals/${referralId}`, (route) =>
    route.fulfill({ json: referral }),
  );
}

test('key staff pages use Participant wording while preserving client record routes', async ({ page }) => {
  await mockSession(page, 'staff');
  await page.route('**/api/clients?*', (route) =>
    route.fulfill({
      json: {
        items: [{
          id: participantId,
          firstName: 'Jordan',
          lastName: 'Rivera',
          uciNumber: 'UCI-100',
          dateOfBirth: '2000-01-01',
          assignedCoordinatorName: 'Case Coordinator',
          status: 'active',
        }],
        total: 1,
      },
    }),
  );

  await page.goto('/clients');

  await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: participantName })).toHaveAttribute(
    'href',
    `/clients/${participantId}`,
  );

  await page.goto('/help');

  await expect(page.getByText('Convert to participant')).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
});

test('participant detail displays the preferred language and shows Not set when unset', async ({ page }) => {
  await mockSession(page, 'staff');
  await page.route('**/api/family-representatives?*', (route) => route.fulfill({ json: [] }));
  let preferredLanguage: string | null = 'Spanish';
  await page.route(`**/api/clients/${participantId}/case`, (route) =>
    route.fulfill({
      json: {
        client: {
          id: participantId,
          firstName: 'Jordan',
          lastName: 'Rivera',
          uciNumber: 'UCI-100',
          dateOfBirth: '2000-01-01',
          status: 'active',
          preferredLanguage,
        },
        referrals: [],
        authorizations: [],
        invoices: [],
        payments: [],
        remittances: [],
        documents: [],
      },
    }),
  );
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));

  await page.goto(`/clients/${participantId}`);
  await expect(page.getByTestId('client-preferred-language')).toHaveText('Spanish');

  preferredLanguage = null;
  await page.reload();
  await expect(page.getByTestId('client-preferred-language')).toHaveText('Not set');
  await expect(page.getByTestId('client-preferred-language')).toHaveClass(/text-muted-foreground/);
});

test('profile language is visible to coordinator and family, with their existing editor permissions', async ({ page }) => {
  await page.route(`**/api/clients/${participantId}/case`, (route) => route.fulfill({
    json: { client: { id: participantId, firstName: 'Jordan', lastName: 'Rivera', uciNumber: 'UCI-100', dateOfBirth: '2000-01-01', status: 'active', preferredLanguage: null }, referrals: [], authorizations: [], invoices: [], payments: [], remittances: [], documents: [] },
  }));
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/family-representatives?*', (route) => route.fulfill({ json: [] }));
  let role = 'service_coordinator';
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { ...baseUser, role } }));
  for (role of ['service_coordinator', 'parent_guardian', 'self']) {
    await page.goto(`/clients/${participantId}`);
    await expect(page.getByTestId('client-preferred-language')).toHaveText('Not set');
    await expect(page.getByTestId('button-edit-client')).toHaveCount(0);
    await expect(page.getByTestId('button-edit-contact-info')).toHaveCount(role === 'service_coordinator' ? 0 : 1);
  }
});

test('staff and family editors preserve non-list languages and save trimmed Other text', async ({ page }) => {
  let role = 'staff';
  let currentLanguage = 'Somali';
  const patches: any[] = [];
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { ...baseUser, role } }));
  await page.route(`**/api/clients/${participantId}/case`, (route) => route.fulfill({
    json: { client: { id: participantId, firstName: 'Jordan', lastName: 'Rivera', uciNumber: 'UCI-100', dateOfBirth: '2000-01-01', status: 'active', preferredLanguage: currentLanguage }, referrals: [], authorizations: [], invoices: [], payments: [], remittances: [], documents: [] },
  }));
  await page.route(`**/api/clients/${participantId}`, (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      patches.push(body);
      currentLanguage = body.preferredLanguage;
      return route.fulfill({ json: { id: participantId, ...body } });
    }
    return route.fallback();
  });
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/family-representatives?*', (route) => route.fulfill({ json: [] }));

  for (role of ['staff', 'self']) {
    await page.goto(`/clients/${participantId}`);
    await page.getByTestId(role === 'staff' ? 'button-edit-client' : 'button-edit-contact-info').click();
    await expect(page.getByTestId('select-preferred-language')).toContainText('Other');
    await expect(page.getByTestId('input-preferred-language-other')).toHaveValue(currentLanguage);
    await page.getByTestId('input-preferred-language-other').fill('  Tigrinya  ');
    await page.getByTestId(role === 'staff' ? 'button-save-client' : 'button-save-contact-info').click();
    await expect.poll(() => patches.length).toBe(role === 'staff' ? 1 : 2);
    expect(patches.at(-1).preferredLanguage).toBe('Tigrinya');
    currentLanguage = 'Somali';
  }
});

test('referral list and detail participant names link to the existing client record', async ({ page }) => {
  await mockSession(page, 'staff');
  await mockReferralList(page);
  await mockReferralDetail(page);

  await page.goto('/referrals');

  await expect(page.getByRole('columnheader', { name: /Participant/ })).toBeVisible();
  await expect(page.getByPlaceholder('Search participants or coordinators...')).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: participantName })).toHaveAttribute(
    'href',
    `/clients/${participantId}`,
  );

  await page.goto(`/referrals/${referralId}`);

  const participantLinks = page.getByRole('link', { name: participantName });
  await expect(page.getByText('Participant Info')).toBeVisible();
  await expect(page.getByText(/\bClients?\b/)).toHaveCount(0);
  await expect(participantLinks).toHaveCount(2);
  await expect(participantLinks.first()).toHaveAttribute('href', `/clients/${participantId}`);
  await expect(participantLinks.last()).toHaveAttribute('href', `/clients/${participantId}`);
});

test('referral participant names remain plain text when the role cannot open client records', async ({ page }) => {
  await mockSession(page, 'restricted');
  await mockReferralList(page);
  await mockReferralDetail(page);

  await page.goto('/referrals');

  await expect(page.getByText(participantName)).toBeVisible();
  await expect(page.getByRole('link', { name: participantName })).toHaveCount(0);

  await page.goto(`/referrals/${referralId}`);

  await expect(page.getByText(participantName)).toHaveCount(2);
  await expect(page.getByRole('link', { name: participantName })).toHaveCount(0);
});

test('staff creates and immediately assigns a coordinator without losing referral edits', async ({ page }) => {
  await mockSession(page, 'staff');
  await mockReferralDetail(page);
  await page.route('**/api/users?*', (route) =>
    route.fulfill({ json: [{ ...baseUser, id: 'coordinator-1', name: 'Existing Coordinator', role: 'service_coordinator' }] }),
  );
  await page.route('**/api/users', async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ name: 'New Coordinator', email: 'new@example.test', role: 'service_coordinator' });
    await route.fulfill({ status: 201, json: { ...baseUser, id: 'coordinator-2', name: body.name, email: body.email, role: body.role } });
  });
  await page.route(`**/api/referrals/${referralId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON();
    expect(body.notes).toBe('Keep these edits');
    expect(body.serviceCoordinatorId).toBe('coordinator-2');
    await route.fulfill({ json: { ...referral, ...body, coordinatorName: 'New Coordinator' } });
  });

  await page.goto(`/referrals/${referralId}`);
  await page.getByTestId('button-edit-referral').click();
  await page.locator('textarea').fill('Keep these edits');
  await page.getByTestId('button-add-referral-coordinator').click();
  await page.getByTestId('input-new-coordinator-name').fill('New Coordinator');
  await page.getByTestId('input-new-coordinator-email').fill('new@example.test');
  await page.getByTestId('button-create-referral-coordinator').click();
  await expect(page.getByText('Coordinator created and selected')).toBeVisible();
  await page.getByTestId('button-save-referral').click();
  await expect(page.getByText('Referral updated', { exact: true })).toBeVisible();
});

test('participant Payments tab shows remittance totals, links, and prefilled creation', async ({ page }) => {
  await mockSession(page, 'staff');
  const client = {
    id: participantId,
    firstName: 'Jordan',
    lastName: 'Rivera',
    uciNumber: 'UCI-100',
    dateOfBirth: '2000-01-01',
    status: 'active',
    assignedCoordinatorName: 'Case Coordinator',
  };
  const remittance = {
    id: remittanceId,
    clientId: participantId,
    clientName: participantName,
    authorizationId: 'auth-1',
    authNumber: 'AUTH-100',
    altaReference: 'ALTA-100',
    remittanceDate: '2026-09-03',
    amount: '125.00',
    allocatedAmount: '100.00',
    remainingAmount: '25.00',
    status: 'received',
    source: 'manual',
    autoMatched: false,
    allocations: [],
  };
  await page.route(`**/api/clients/${participantId}/case`, (route) =>
    route.fulfill({ json: { client, referrals: [], authorizations: [{ id: 'auth-1', clientId: participantId, authNumber: 'AUTH-100', vendorId: 'vendor-1', vendorName: 'Vendor', serviceCode: '459', servicePeriodStart: '2026-01-01', servicePeriodEnd: '2026-12-31', maxPeriodAmount: '1000.00', totalPaid: '0.00', status: 'active' }], invoices: [], payments: [], remittances: [remittance] } }),
  );
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { items: [client], total: 1 } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));

  await page.goto(`/clients/${participantId}`);
  await page.getByRole('tab', { name: /Payments/ }).click();
  await expect(page.getByTestId('participant-remittance-matched-summary')).toContainText('0 · $0.00');
  await expect(page.getByTestId('participant-remittance-outstanding-summary')).toContainText('1 · $25.00');
  await expect(page.getByText('ALTA-100')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View' })).toHaveAttribute('href', `/remittances/${remittanceId}`);

  await page.getByTestId('button-create-remittance').click();
  await expect(page.getByTestId('select-create-remittance-client')).toBeDisabled();
  await expect(page.getByTestId('select-create-remittance-client')).toContainText(participantName);
});

test('participant Payments tab has a remittance empty state', async ({ page }) => {
  await mockSession(page, 'staff');
  await page.route(`**/api/clients/${participantId}/case`, (route) =>
    route.fulfill({ json: { client: { id: participantId, firstName: 'Jordan', lastName: 'Rivera', uciNumber: 'UCI-100', dateOfBirth: '2000-01-01', status: 'active' }, referrals: [], authorizations: [], invoices: [], payments: [], remittances: [] } }),
  );
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));

  await page.goto(`/clients/${participantId}`);
  await page.getByRole('tab', { name: /Payments/ }).click();
  await expect(page.getByText('No remittances found for this participant.')).toBeVisible();
});

test('staff Documents tab formats document and signature statuses as compact semantic groups', async ({ page }) => {
  await mockSession(page, 'staff');
  const client = {
    id: participantId,
    firstName: 'Jordan',
    lastName: 'Rivera',
    uciNumber: 'UCI-100',
    dateOfBirth: '2000-01-01',
    status: 'active',
  };
  const documents = [
    { id: 'doc-pending', name: 'Pending form', category: 'intake', recordType: 'referral', recordId: referralId, recordLabel: 'Referral', status: 'pending', statusDate: '2026-09-01', signatureStatus: 'unsigned', objectPath: null },
    { id: 'doc-sent', name: 'Sent agreement', category: 'agreement', recordType: 'referral', recordId: referralId, recordLabel: 'Referral', status: 'sent', statusDate: '2026-09-02', signatureStatus: 'sent', objectPath: null },
    { id: 'doc-received', name: 'Signed agreement', category: 'agreement', recordType: 'referral', recordId: referralId, recordLabel: 'Referral', status: 'received', statusDate: '2026-09-03', signatureStatus: 'signed', objectPath: null },
    { id: 'doc-fallback', name: 'Archived form', category: 'other', recordType: 'referral', recordId: referralId, recordLabel: 'Referral', status: 'needs_review', statusDate: null, signatureStatus: null, objectPath: null },
  ];
  await page.route(`**/api/clients/${participantId}/case`, (route) =>
    route.fulfill({ json: { client, referrals: [], authorizations: [], invoices: [], payments: [], remittances: [], documents } }),
  );
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));

  await page.goto(`/clients/${participantId}?tab=documents`);

  await expect(page.getByRole('tab', { name: 'Documents' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('status-document-doc-pending')).toHaveText('Pending');
  await expect(page.getByTestId('status-document-doc-sent')).toHaveText('Sent');
  await expect(page.getByTestId('status-document-doc-received')).toHaveText('Received');
  await expect(page.getByTestId('status-document-doc-fallback')).toHaveText('Needs Review');
  await expect(page.getByTestId('status-signature-doc-pending')).toHaveText('Unsigned');
  await expect(page.getByTestId('status-signature-doc-sent')).toHaveText('Sent');
  await expect(page.getByTestId('status-signature-doc-received')).toHaveText('Signed');
  await expect(page.getByTestId('signature-group-document-doc-pending')).toContainText('Signature');
  await expect(page.locator('[data-status-kind="document"]')).toHaveCount(4);
  await expect(page.locator('[data-status-kind="signature"]')).toHaveCount(3);
  await expect(page.getByTestId('row-document-doc-received')).toContainText('Sep 3, 2026');
  await expect(page.getByTestId('row-document-doc-fallback')).toContainText('-');
});

test('Documents tab remains staff-only', async ({ page }) => {
  await mockSession(page, 'parent_guardian');
  await page.route(`**/api/clients/${participantId}/case`, (route) =>
    route.fulfill({
      json: {
        client: { id: participantId, firstName: 'Jordan', lastName: 'Rivera', uciNumber: 'UCI-100', dateOfBirth: '2000-01-01', status: 'active' },
        referrals: [], authorizations: [], invoices: [], payments: [], remittances: [], documents: [],
      },
    }),
  );
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [] }));

  await page.goto(`/clients/${participantId}?tab=documents`);

  await expect(page.getByRole('tab', { name: 'Documents' })).toHaveCount(0);
  await expect(page.getByText('Case Documents')).toHaveCount(0);
});

test('fee-blocked participant deletion opens the Fees tab and closes the conflict dialog', async ({ page }) => {
  await mockSession(page, 'staff');
  const client = {
    id: participantId,
    firstName: 'Jordan',
    lastName: 'Rivera',
    uciNumber: 'UCI-100',
    dateOfBirth: '2000-01-01',
    status: 'active',
  };
  const fee = {
    id: 'fee-1',
    clientId: participantId,
    authorizationId: null,
    paymentId: null,
    amount: '160.00',
    feeMonth: '2026-09',
    ruleApplied: 'confirmed_flat_160_per_participant_service_month',
    status: 'pending',
    notes: null,
    createdAt: '2026-09-01T12:00:00.000Z',
  };

  await page.route(`**/api/clients/${participantId}/case`, (route) =>
    route.fulfill({ json: { client, referrals: [], authorizations: [], invoices: [], payments: [], remittances: [], documents: [] } }),
  );
  await page.route('**/api/fees?*', (route) => route.fulfill({ json: [fee] }));
  await page.route(`**/api/clients/${participantId}`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Participant cannot be deleted while active financial records reference them',
        blockers: [{
          type: 'fee',
          label: 'Fees',
          count: 1,
          records: [{ id: fee.id, label: 'Fee for 2026-09', href: `/clients/${participantId}?tab=fees` }],
        }],
      }),
    }),
  );

  await page.goto(`/clients/${participantId}`);
  await expect(page.getByTestId('tab-fees')).toHaveAttribute('data-state', 'inactive');
  await page.getByTestId('button-delete-client').click();
  await page.getByTestId('button-confirm-delete').click();
  await expect(page.getByTestId('delete-conflict-details')).toContainText('1 Fee');

  await page.getByRole('link', { name: 'Fee for 2026-09' }).click();

  await expect(page).toHaveURL(new RegExp(`/clients/${participantId}\\?tab=fees$`));
  await expect(page.getByTestId('delete-conflict-details')).toHaveCount(0);
  await expect(page.getByTestId('tab-fees')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('content-fees')).toContainText('$160.00');
});