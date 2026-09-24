import { expect, test, type Page } from '@playwright/test';

const staff = {
  id: 'invoice-create-staff', name: 'Invoice Staff', email: 'invoice-staff@example.test',
  phone: null, role: 'staff', active: true, lastLogin: null,
};

async function mockInvoiceForm(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
  await page.route('**/api/clients?*', (route) => route.fulfill({
    json: { total: 1, items: [{ id: 'client-1', firstName: 'Form', lastName: 'Participant' }] },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: { total: 1, items: [{ id: 'auth-1', authNumber: 'AUTH-1' }] },
  }));
  await page.route('**/api/storage/uploads/request-url', (route) => route.fulfill({
    json: { uploadURL: '/test-upload/invoice', objectPath: '/objects/uploads/invoice-create-staff/11111111-1111-4111-8111-111111111111' },
  }));
  await page.route('**/test-upload/**', (route) => route.fulfill({ status: 200, body: '' }));
}

async function uploadInvoice(page: Page) {
  await page.getByTestId('upload-invoice-document').locator('[data-testid="input-file-upload"]').setInputFiles({
    name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 invoice'),
  });
  await expect(page.getByTestId('text-invoice-document-attached')).toBeVisible();
}

test('invoice detail keeps existing line documents visible read-only', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staff }));
  await page.route('**/api/invoices/invoice-doc-1', (route) => route.fulfill({
    json: {
      id: 'invoice-doc-1', clientId: 'client-1', clientName: 'Document Participant',
      vendorId: null, vendorName: null, submittedByRole: 'staff', submittedDate: '2026-06-01',
      serviceMonth: '2026-06', amountRequested: '30.00', paymentType: 'direct_payment',
      documentUrl: '/objects/invoice-wide.pdf', status: 'pending_review',
      reviewedBy: null, reviewedByName: null, reviewedAt: null, notes: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      lineItems: [
        { id: 'line-1', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2026-06', amount: '10.00', documentUrl: '/objects/line-one.pdf' },
        { id: 'line-2', authorizationId: 'auth-2', authNumber: 'AUTH-2', serviceMonth: '2026-06', amount: '20.00', documentUrl: '/objects/line-two.pdf' },
      ],
    },
  }));
  await page.route('**/api/invoices/invoice-doc-1/validate', (route) => route.fulfill({
    json: { valid: false, status: 'pending_review', checks: [] },
  }));
  await page.route('**/api/storage/**', (route) => route.fulfill({
    status: 200, contentType: 'application/pdf', body: '%PDF-1.4 test',
  }));
  await page.goto('/invoices/invoice-doc-1');
  await expect(page.getByTestId('link-line-item-0-document')).toHaveAttribute('href', '/api/storage/objects/line-one.pdf');
  await expect(page.getByTestId('link-line-item-1-document')).toHaveAttribute('href', '/api/storage/objects/line-two.pdf');
  await page.getByTestId('button-edit-invoice').click();
  await expect(page.getByTestId('upload-edit-line-0-document')).toHaveCount(0);
  await expect(page.getByText('Payment Month', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByText('Service Month', { exact: true })).toHaveCount(2);
});

test('invoice-level upload is required at top; create sends no line documents', async ({ page }) => {
  await mockInvoiceForm(page);
  let payload: Record<string, unknown> | undefined;
  await page.route('**/api/invoices', (route) => {
    if (route.request().method() === 'POST') {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 201, json: { id: 'created-invoice' } });
    }
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.goto('/invoices/new');
  await expect(page.getByText('Invoice document', { exact: true })).toBeVisible();
  await expect(page.getByText('An invoice document is required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit Invoice' })).toBeDisabled();
  await expect(page.getByTestId('upload-line-0-document')).toHaveCount(0);
  await expect(page.getByText('Payment Month', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Service Month', { exact: true })).toHaveCount(1);

  await uploadInvoice(page);
  await expect(page.getByRole('button', { name: 'Submit Invoice' })).toBeEnabled();
  await page.getByTestId('button-remove-invoice-document').click();
  await expect(page.getByText('An invoice document is required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit Invoice' })).toBeDisabled();
  await uploadInvoice(page);
  await page.getByTestId('select-invoice-client').click();
  await page.getByTestId('select-invoice-client-option-client-1').click();
  await page.getByTestId('select-line-0-authorization').click();
  await page.getByTestId('select-line-0-authorization-option-auth-1').click();
  await page.getByTestId('input-line-0-amount').fill('10.00');
  await page.getByRole('button', { name: 'Submit Invoice' }).click();
  await expect.poll(() => payload).toBeDefined();
  expect(payload!.documentUrl).toBe('/objects/uploads/invoice-create-staff/11111111-1111-4111-8111-111111111111');
  expect((payload!.lineItems as Array<Record<string, unknown>>)[0]).not.toHaveProperty('documentUrl');
});

test('edit invoice does not send line documents and keeps existing attachments', async ({ page }) => {
  await mockInvoiceForm(page);
  let patch: Record<string, unknown> | undefined;
  await page.route('**/api/invoices/invoice-edit-1/validate', (route) => route.fulfill({
    json: { valid: false, status: 'pending_review', checks: [] },
  }));
  await page.route('**/api/invoices/invoice-edit-1', (route) => {
    if (route.request().method() === 'PATCH') {
      patch = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, json: {} });
    }
    return route.fulfill({ json: {
      id: 'invoice-edit-1', clientId: 'client-1', clientName: 'Form Participant',
      vendorId: null, vendorName: null, paymentType: 'direct_payment',
      amountRequested: '10.00', status: 'pending_review', documentUrl: '/objects/invoice.pdf',
      notes: null, submittedByRole: 'staff', submittedDate: '2026-06-01', serviceMonth: '2026-06',
      reviewedBy: null, reviewedByName: null, reviewedAt: null, createdAt: null,
      lineItems: [{ id: 'line-1', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2026-06', amount: '10.00', documentUrl: '/objects/existing.pdf' }],
    } });
  });
  await page.goto('/invoices/invoice-edit-1');
  await page.getByTestId('button-edit-invoice').click();
  await expect(page.getByTestId('upload-edit-line-0-document')).toHaveCount(0);
  await page.getByTestId('button-save-invoice').click();
  await expect.poll(() => patch).toBeDefined();
  expect((patch!.lineItems as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'line-1', authorizationId: 'auth-1' });
  expect((patch!.lineItems as Array<Record<string, unknown>>)[0]).not.toHaveProperty('documentUrl');
  expect(patch).not.toHaveProperty('documentUrl');
});