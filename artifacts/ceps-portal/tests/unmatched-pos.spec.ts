import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-unmatched-pos',
  name: 'Unmatched POS Staff',
  email: 'unmatched-pos@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const uciClient = {
  id: 'client-uci-match',
  firstName: 'Correct',
  lastName: 'Participant',
  uciNumber: 'UCI-12345',
  dateOfBirth: '1990-01-01',
  status: 'active',
};

const queueClient = {
  id: 'client-queued-match',
  firstName: 'Newly',
  lastName: 'Onboarded',
  uciNumber: 'UCI-99999',
  dateOfBirth: '1991-02-02',
  status: 'active',
};

const parsedFields = {
  clientName: 'Not Yet Onboarded',
  clientAddress: '123 Main Street',
  clientPhone: '555-0100',
  uciNumber: null,
  authNumber: 'POS-QUEUE-001',
  serviceCode: '459',
  activityDescription: 'Supported employment',
  servicePeriodStart: '2026-04-01',
  servicePeriodEnd: '2026-09-30',
  units: 6,
  monthlyAmount: '125.50',
  maxPeriodAmount: '753.00',
  caseworkerName: 'Case Worker',
};

const queuedDocument = {
  id: 'unmatched-pos-1',
  posPdfUrl: '/objects/uploads/unmatched-pos.pdf',
  sourceFileName: 'unmatched-pos.pdf',
  ...parsedFields,
  createdBy: staffUser.id,
  createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:00:00.000Z',
};

async function mockCommonStaffApis(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) => route.fulfill({
    json: { total: 2, items: [uciClient, queueClient] },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({
    json: { total: 0, items: [] },
  }));
  await page.route('**/api/storage/uploads/request-url', async (route) => {
    const body = route.request().postDataJSON() as { name: string };
    const slug = body.name === 'matched-pos.pdf' ? 'matched-pos' : 'unmatched-pos';
    await route.fulfill({
      json: {
        uploadURL: `/upload/${slug}`,
        objectPath: `/objects/uploads/${slug}.pdf`,
      },
    });
  });
  await page.route('**/upload/**', (route) => route.fulfill({ status: 200, body: '' }));
}

async function uploadPdf(page: Page, filename: string) {
  await page.getByTestId('input-file-upload').setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 synthetic POS fixture'),
  });
}

test('POS PDFs match by UCI, queue unmatched documents, and complete queued matches', async ({ page }) => {
  await mockCommonStaffApis(page);

  const unmatchedSaveBodies: Record<string, unknown>[] = [];
  let parseMode: 'uci' | 'none' = 'uci';
  await page.route('**/api/authorizations/parse-pdf', async (route) => {
    const fields = parseMode === 'uci'
      ? { ...parsedFields, clientName: 'C. Participant', uciNumber: uciClient.uciNumber }
      : parsedFields;
    await route.fulfill({ json: { success: true, error: null, fields } });
  });
  await page.route('**/api/unmatched-pos/match', async (route) => {
    await route.fulfill({
      json: parseMode === 'uci'
        ? {
            method: 'uci',
            client: {
              id: uciClient.id,
              firstName: uciClient.firstName,
              lastName: uciClient.lastName,
              uciNumber: uciClient.uciNumber,
            },
          }
        : { method: 'none', client: null },
    });
  });
  await page.route('**/api/unmatched-pos', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    unmatchedSaveBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 201, json: queuedDocument });
  });

  await page.goto('/authorizations/new');
  await uploadPdf(page, 'matched-pos.pdf');
  await expect(page.getByTestId('text-parse-note')).toContainText('High confidence match by UCI');
  await expect(page.getByTestId('select-auth-client')).toContainText('Correct Participant');
  expect(unmatchedSaveBodies).toHaveLength(0);

  parseMode = 'none';
  await uploadPdf(page, 'unmatched-pos.pdf');
  await expect.poll(() => unmatchedSaveBodies.length).toBe(1);
  expect(unmatchedSaveBodies[0]).toMatchObject({
    posPdfUrl: '/objects/uploads/unmatched-pos.pdf',
    sourceFileName: 'unmatched-pos.pdf',
    ...parsedFields,
  });
  await expect(page.getByTestId('text-parse-note')).toContainText('safely queued');
  await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled();

  let completed = false;
  let listRequests = 0;
  await page.route('**/api/unmatched-pos?*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    listRequests++;
    await route.fulfill({
      json: completed ? { items: [], total: 0 } : { items: [queuedDocument], total: 1 },
    });
  });
  const completeBodies: Record<string, unknown>[] = [];
  await page.route('**/api/unmatched-pos/*/complete', async (route) => {
    completeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    completed = true;
    await route.fulfill({
      status: 201,
      json: {
        saved: true,
        warnings: [],
        authorization: {
          id: 'authorization-from-queue',
          clientId: queueClient.id,
          authNumber: queuedDocument.authNumber,
        },
      },
    });
  });

  await page.goto('/authorizations/unmatched');
  await expect(page.getByTestId(`card-unmatched-${queuedDocument.id}`)).toBeVisible();
  await page.getByTestId(`select-client-${queuedDocument.id}`).click();
  await page.getByTestId(`select-client-${queuedDocument.id}-option-${queueClient.id}`).click();
  await page.getByTestId(`button-complete-${queuedDocument.id}`).click();

  expect(completeBodies).toEqual([{
    clientId: queueClient.id,
    paymentType: 'direct_payment',
    acceptMaxAmountWarning: false,
  }]);
  await expect.poll(() => listRequests).toBeGreaterThan(1);
  await expect(page.getByTestId(`card-unmatched-${queuedDocument.id}`)).toHaveCount(0);
});