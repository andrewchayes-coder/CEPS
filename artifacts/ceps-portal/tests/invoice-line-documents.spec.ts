import { expect, test } from '@playwright/test';

const staff = {
  id: 'invoice-doc-staff',
  name: 'Invoice Staff',
  email: 'invoice-staff@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: null,
};

test('invoice detail renders each line document separately from invoice attachment', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
  await page.route('**/api/invoices/invoice-doc-1', (route) => route.fulfill({
    json: {
      id: 'invoice-doc-1',
      clientId: 'client-doc-1',
      clientName: 'Document Participant',
      vendorId: null,
      vendorName: null,
      submittedByRole: 'staff',
      submittedDate: '2026-06-01',
      serviceMonth: '2026-06',
      amountRequested: '30.00',
      paymentType: 'direct_payment',
      documentUrl: '/objects/invoice-wide.pdf',
      status: 'pending_review',
      reviewedBy: null,
      reviewedByName: null,
      reviewedAt: null,
      notes: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      lineItems: [
        { id: 'line-doc-1', authorizationId: 'auth-doc-1', authNumber: 'AUTH-1', serviceMonth: '2026-06', amount: '10.00', documentUrl: '/objects/line-one.pdf' },
        { id: 'line-doc-2', authorizationId: 'auth-doc-2', authNumber: 'AUTH-2', serviceMonth: '2026-06', amount: '20.00', documentUrl: '/objects/line-two.pdf' },
      ],
    },
  }));
  await page.route('**/api/invoices/invoice-doc-1/validate', (route) => route.fulfill({
    json: { valid: false, status: 'pending_review', checks: [] },
  }));
  await page.route('**/api/storage/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    body: '%PDF-1.4 test',
  }));

  await page.goto('/invoices/invoice-doc-1');
  await expect(page.getByTestId('link-line-item-0-document')).toHaveAttribute('href', '/api/storage/objects/line-one.pdf');
  await expect(page.getByTestId('link-line-item-1-document')).toHaveAttribute('href', '/api/storage/objects/line-two.pdf');
  await expect(page.getByText('Invoice-2026-06.pdf')).toBeVisible();
});

const createUser = {
  id: 'invoice-create-staff',
  name: 'Invoice Create Staff',
  email: 'invoice-create@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: null,
};

async function mockInvoiceFormDependencies(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: createUser }));
  await page.route('**/api/clients?*', (route) => route.fulfill({
    json: { total: 1, items: [{ id: 'client-form-1', firstName: 'Form', lastName: 'Participant', uciNumber: 'FORM-1' }] },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({
    json: { total: 1, items: [{ id: 'vendor-form-1', name: 'Form Vendor' }] },
  }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: {
      total: 2,
      items: [
        { id: 'auth-form-1', authNumber: 'AUTH-FORM-1', activityDescription: 'First service' },
        { id: 'auth-form-2', authNumber: 'AUTH-FORM-2', activityDescription: 'Second service' },
      ],
    },
  }));
}

async function mockDeterministicUploads(page: import('@playwright/test').Page) {
  await page.route('**/api/storage/uploads/request-url', async (route) => {
    const { name } = route.request().postDataJSON() as { name: string };
    const slug = name.replace(/\.pdf$/i, '');
    const ids: Record<string, string> = {
      'line-one': '11111111-1111-4111-8111-111111111111',
      'line-two': '22222222-2222-4222-8222-222222222222',
      'invoice-wide': '33333333-3333-4333-8333-333333333333',
      'line-one-replacement': '44444444-4444-4444-8444-444444444444',
    };
    await route.fulfill({ json: { uploadURL: `/test-upload/${slug}`, objectPath: `/objects/uploads/invoice-create-staff/${ids[slug]}` } });
  });
  await page.route('**/test-upload/**', (route) => route.fulfill({ status: 200, body: '' }));
}

async function choose(page: import('@playwright/test').Page, testId: string, optionTestId: string) {
  await page.getByTestId(testId).click();
  await page.getByTestId(optionTestId).click();
}

test('create invoice binds distinct uploaded documents to each line and invoice attachment', async ({ page }) => {
  await mockInvoiceFormDependencies(page);
  await mockDeterministicUploads(page);
  let payload: Record<string, unknown> | undefined;
  await page.route('**/api/invoices', async (route) => {
    if (route.request().method() === 'POST') {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, json: { id: 'created-invoice' } });
    } else {
      await route.fulfill({ json: { items: [], total: 0 } });
    }
  });

  await page.goto('/invoices/new');
  await choose(page, 'select-invoice-client', 'select-invoice-client-option-client-form-1');
  await choose(page, 'select-invoice-vendor', 'select-invoice-vendor-option-vendor-form-1');
  await choose(page, 'select-line-0-authorization', 'select-line-0-authorization-option-auth-form-1');
  await page.getByTestId('input-line-0-amount').fill('10.00');
  await page.locator('#line-0-month').fill('2026-06');
  await page.getByTestId('button-add-line-item').click();
  await choose(page, 'select-line-1-authorization', 'select-line-1-authorization-option-auth-form-2');
  await page.getByTestId('input-line-1-amount').fill('20.00');
  await page.locator('#line-1-month').fill('2026-06');

  await page.getByTestId('upload-line-0-document').locator('[data-testid="input-file-upload"]').setInputFiles({
    name: 'line-one.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 one'),
  });
  await page.getByTestId('upload-line-1-document').locator('[data-testid="input-file-upload"]').setInputFiles({
    name: 'line-two.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 two'),
  });
  await page.getByTestId('upload-invoice-document').locator('[data-testid="input-file-upload"]').setInputFiles({
    name: 'invoice-wide.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 invoice'),
  });
  await expect(page.getByTestId('text-line-0-document-attached')).toBeVisible();
  await expect(page.getByTestId('text-line-1-document-attached')).toBeVisible();
  await expect(page.getByTestId('text-invoice-document-attached')).toBeVisible();
  await page.getByRole('button', { name: 'Submit Invoice' }).click();
  await expect.poll(() => payload).toBeDefined();
  const lines = payload!.lineItems as Array<Record<string, unknown>>;
  expect(lines.map((line) => line.authorizationId)).toEqual(['auth-form-1', 'auth-form-2']);
  expect(lines.map((line) => line.documentUrl)).toEqual([
    '/objects/uploads/invoice-create-staff/11111111-1111-4111-8111-111111111111',
    '/objects/uploads/invoice-create-staff/22222222-2222-4222-8222-222222222222',
  ]);
  expect(payload!.documentUrl).toBe('/objects/uploads/invoice-create-staff/33333333-3333-4333-8333-333333333333');
});

test('edit invoice replaces and clears line documents without sending invoice-level document', async ({ page }) => {
  await mockInvoiceFormDependencies(page);
  await mockDeterministicUploads(page);
  await page.route('**/api/invoices/invoice-edit-1/validate', (route) => route.fulfill({
    json: { valid: false, status: 'pending_review', checks: [] },
  }));
  let patch: Record<string, unknown> | undefined;
  await page.route('**/api/invoices/invoice-edit-1', async (route) => {
    if (route.request().method() === 'PATCH') {
      patch = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, json: {} });
    } else {
      await route.fulfill({
        json: {
          id: 'invoice-edit-1', clientId: 'client-form-1', clientName: 'Form Participant',
          vendorId: 'vendor-form-1', vendorName: 'Form Vendor', paymentType: 'direct_payment',
          amountRequested: '30.00', status: 'pending_review', documentUrl: '/objects/invoice-kept.pdf',
          notes: null, submittedByRole: 'staff', submittedDate: '2026-06-01', serviceMonth: '2026-06',
          reviewedBy: null, reviewedByName: null, reviewedAt: null, createdAt: null,
          lineItems: [
            { id: 'edit-line-1', authorizationId: 'auth-form-1', authNumber: 'AUTH-FORM-1', serviceMonth: '2026-06', amount: '10.00', documentUrl: '/objects/existing-one.pdf' },
            { id: 'edit-line-2', authorizationId: 'auth-form-2', authNumber: 'AUTH-FORM-2', serviceMonth: '2026-06', amount: '20.00', documentUrl: '/objects/existing-two.pdf' },
          ],
        },
      });
    }
  });

  await page.goto('/invoices/invoice-edit-1');
  await page.getByTestId('button-edit-invoice').click();
  await expect(page.getByTestId('text-edit-line-0-document-attached')).toContainText('/objects/existing-one.pdf');
  await expect(page.getByTestId('text-edit-line-1-document-attached')).toContainText('/objects/existing-two.pdf');
  await page.getByTestId('button-edit-remove-line-0-document').click();
  await page.getByTestId('upload-edit-line-0-document').locator('[data-testid="input-file-upload"]').setInputFiles({
    name: 'line-one-replacement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 replacement'),
  });
  await page.getByTestId('button-edit-remove-line-1-document').click();
  await page.getByTestId('button-save-invoice').click();
  await expect.poll(() => patch).toBeDefined();
  const lines = patch!.lineItems as Array<Record<string, unknown>>;
  expect(lines.map((line) => line.documentUrl)).toEqual(['/objects/uploads/invoice-create-staff/44444444-4444-4444-8444-444444444444', null]);
  expect(patch).not.toHaveProperty('documentUrl');
});

test('create ignores a delayed upload after its row is removed', async ({ page }) => {
  await mockInvoiceFormDependencies(page);
  let releaseRequest!: () => void;
  let requestStarted = false;
  await page.route('**/api/storage/uploads/request-url', async (route) => {
    requestStarted = true;
    await new Promise<void>((resolve) => { releaseRequest = resolve; });
    await route.fulfill({ json: { uploadURL: '/test-upload/removed-line', objectPath: '/objects/uploads/invoice-create-staff/55555555-5555-4555-8555-555555555555' } });
  });
  await page.route('**/test-upload/**', (route) => route.fulfill({ status: 200, body: '' }));
  let payload: Record<string, unknown> | undefined;
  await page.route('**/api/invoices', async (route) => {
    payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, json: { id: 'race-created' } });
  });

  await page.goto('/invoices/new');
  await choose(page, 'select-invoice-client', 'select-invoice-client-option-client-form-1');
  await choose(page, 'select-line-0-authorization', 'select-line-0-authorization-option-auth-form-1');
  await page.getByTestId('input-line-0-amount').fill('10.00');
  await page.getByTestId('button-add-line-item').click();
  await choose(page, 'select-line-1-authorization', 'select-line-1-authorization-option-auth-form-2');
  await page.getByTestId('input-line-1-amount').fill('20.00');
  await page.getByTestId('upload-line-0-document').locator('[data-testid="input-file-upload"]').setInputFiles({
    name: 'removed-line.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 removed'),
  });
  await expect.poll(() => requestStarted).toBe(true);
  await page.getByTestId('button-remove-line-0').click();
  releaseRequest();
  await page.getByRole('button', { name: 'Submit Invoice' }).click();
  await expect.poll(() => payload).toBeDefined();
  expect((payload!.lineItems as Array<Record<string, unknown>>).length).toBe(1);
  expect((payload!.lineItems as Array<Record<string, unknown>>)[0].documentUrl).toBeNull();
});

test('edit keeps a delayed upload bound when a preceding row is removed', async ({ page }) => {
  await mockInvoiceFormDependencies(page);
  let releaseRequest!: () => void;
  let requestStarted = false;
  await page.route('**/api/storage/uploads/request-url', async (route) => {
    requestStarted = true;
    await new Promise<void>((resolve) => { releaseRequest = resolve; });
    await route.fulfill({ json: { uploadURL: '/test-upload/moved-line', objectPath: '/objects/uploads/invoice-create-staff/66666666-6666-4666-8666-666666666666' } });
  });
  await page.route('**/test-upload/**', (route) => route.fulfill({ status: 200, body: '' }));
  let patch: Record<string, unknown> | undefined;
  await page.route('**/api/invoices/invoice-race-edit', async (route) => {
    if (route.request().method() === 'PATCH') {
      patch = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, json: {} });
      return;
    }
    await route.fulfill({
      json: {
        id: 'invoice-race-edit', clientId: 'client-form-1', clientName: 'Form Participant',
        vendorId: 'vendor-form-1', vendorName: 'Form Vendor', paymentType: 'direct_payment',
        amountRequested: '30.00', status: 'pending_review', documentUrl: '/objects/invoice-kept.pdf',
        notes: null, submittedByRole: 'staff', submittedDate: '2026-06-01', serviceMonth: '2026-06',
        reviewedBy: null, reviewedByName: null, reviewedAt: null, createdAt: null,
        lineItems: [
          { id: 'race-line-1', authorizationId: 'auth-form-1', authNumber: 'AUTH-FORM-1', serviceMonth: '2026-06', amount: '10.00', documentUrl: null },
          { id: 'race-line-2', authorizationId: 'auth-form-2', authNumber: 'AUTH-FORM-2', serviceMonth: '2026-06', amount: '20.00', documentUrl: null },
        ],
      },
    });
  });
  await page.route('**/api/invoices/invoice-race-edit/validate', (route) => route.fulfill({
    json: { valid: false, status: 'pending_review', checks: [] },
  }));

  await page.goto('/invoices/invoice-race-edit');
  await page.getByTestId('button-edit-invoice').click();
  await page.getByTestId('upload-edit-line-1-document').locator('[data-testid="input-file-upload"]').setInputFiles({
    name: 'moved-line.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 moved'),
  });
  await expect.poll(() => requestStarted).toBe(true);
  await page.getByTestId('button-remove-line-0').click();
  releaseRequest();
  await page.getByTestId('button-save-invoice').click();
  await expect.poll(() => patch).toBeDefined();
  const lines = patch!.lineItems as Array<Record<string, unknown>>;
  expect(lines).toHaveLength(1);
  expect(lines[0].authorizationId).toBe('auth-form-2');
  expect(lines[0].documentUrl).toBe('/objects/uploads/invoice-create-staff/66666666-6666-4666-8666-666666666666');
});