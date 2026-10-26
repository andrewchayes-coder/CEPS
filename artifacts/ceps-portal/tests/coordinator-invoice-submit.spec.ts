import { expect, test } from '@playwright/test';

test('coordinator submits each attached file separately and retries only a failed invoice', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: { id: 'coordinator-1', name: 'Case Coordinator', email: 'coordinator@test', role: 'service_coordinator', active: true },
  }));
  await page.route('**/api/clients?*', (route) => route.fulfill({
    json: { items: [{ id: 'client-1', firstName: 'Pat', lastName: 'Participant' }], total: 1 },
  }));
  const vendorQueries: URL[] = [];
  await page.route('**/api/vendors?*', (route) => {
    vendorQueries.push(new URL(route.request().url()));
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.route('**/api/storage/uploads/request-url', async (route) => {
    const { name } = route.request().postDataJSON();
    const slug = name.replace('.pdf', '');
    await route.fulfill({ json: { uploadURL: `/upload/${slug}`, objectPath: `/objects/uploads/${slug}.pdf` } });
  });
  await page.route('**/upload/**', (route) => route.fulfill({ status: 200, body: '' }));

  const submitted: Record<string, unknown>[] = [];
  let firstFailure = true;
  let releaseFailure: (() => void) | undefined;
  let reachedFirstFailure = false;
  await page.route('**/api/invoices', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { items: [], total: 0 } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(body);
    if (body.documentUrl === '/objects/uploads/invoice-b.pdf' && firstFailure) {
      firstFailure = false;
      reachedFirstFailure = true;
      await new Promise<void>((resolve) => { releaseFailure = resolve; });
      return route.fulfill({ status: 500, json: { error: 'Temporary submission failure' } });
    }
    await route.fulfill({ status: 201, json: { id: `invoice-${submitted.length}`, ...body, status: 'needs_entry' } });
  });

  await page.goto('/invoices/new');
  await page.getByTestId('select-coordinator-invoice-client').click();
  await page.getByTestId('select-coordinator-invoice-client-option-client-1').click();
  await expect.poll(() => vendorQueries.length).toBeGreaterThan(0);
  expect(vendorQueries.at(-1)?.searchParams.get('invoiceEligible')).toBe('true');
  await page.getByTestId('input-coordinator-invoice-files').setInputFiles([
    { name: 'invoice-a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF invoice a') },
    { name: 'invoice-b.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF invoice b') },
  ]);
  await page.getByTestId('input-serviceStartDate').fill('2026-09-15');
  await page.getByTestId('input-serviceEndDate').fill('2026-11-02');
  await expect(page.getByText('Ready to submit')).toHaveCount(2);
  await page.getByRole('button', { name: 'Submit Invoice(s)' }).click();
  await expect.poll(() => submitted.length).toBe(2);
  await expect.poll(() => reachedFirstFailure).toBe(true);
  await expect(page.getByRole('list', { name: 'Attached invoice files' }).getByText('Submitted to CEPS')).toHaveCount(1);
  await expect(page.getByTestId('select-coordinator-invoice-client')).toBeDisabled();
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  releaseFailure?.();
  await expect(page.getByRole('button', { name: 'Retry failed invoice submissions' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Attached invoice files' }).getByText('Temporary submission failure')).toBeVisible();
  expect(submitted[0].clientId).toBe('client-1');
  expect(submitted[0].amountRequested).toBe('0');
  expect(submitted.every((body) => !('lineItems' in body))).toBe(true);

  await page.getByRole('button', { name: 'Retry failed invoice submissions' }).click();
  await expect(page.getByRole('list', { name: 'Attached invoice files' }).getByText('Submitted to CEPS')).toHaveCount(2);
  await expect.poll(() => submitted.length).toBe(3);
  expect(submitted[2].documentUrl).toBe('/objects/uploads/invoice-b.pdf');
  expect(submitted[2].clientId).toBe('client-1');
});

test('staff Needs Entry queue requests oldest-first and keeps workflow actions gated', async ({ page }) => {
  const invoice = {
    id: 'invoice-entry-1',
    clientId: 'client-1',
    clientName: 'Pat Participant',
    vendorId: null,
    vendorName: null,
    amountRequested: '0.00',
    status: 'needs_entry',
    submittedByRole: 'service_coordinator',
    submittedDate: '2026-01-01',
    serviceMonth: '2026-01',
    paymentType: 'direct_payment',
    documentUrl: '/objects/uploads/invoice.pdf',
    lineItems: [],
  };
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: { id: 'staff-1', name: 'CEPS Staff', email: 'staff@test', role: 'staff', active: true, permissions: ['invoice_log_validate', 'invoice_approve'] },
  }));
  const invoiceListQueries: URL[] = [];
  await page.route('**/api/invoices?*', async (route) => {
    invoiceListQueries.push(new URL(route.request().url()));
    await route.fulfill({ json: { items: [invoice], total: 1 } });
  });
  let updateBody: Record<string, unknown> | undefined;
  let currentInvoice = invoice;
  await page.route('**/api/invoices/invoice-entry-1', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: currentInvoice });
    updateBody = route.request().postDataJSON() as Record<string, unknown>;
    currentInvoice = { ...invoice, ...updateBody, status: 'pending_review' };
    await route.fulfill({ json: currentInvoice });
  });
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: { items: [{ id: 'auth-1', authNumber: 'AUTH-1', clientId: 'client-1' }], total: 1 },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));

  await page.goto('/invoices');
  await page.getByTestId('tab-invoices-needs-entry').click();
  await expect(page.getByText('Awaiting CEPS Entry')).toBeVisible();
  await expect.poll(() => invoiceListQueries.length).toBeGreaterThan(0);
  const needsEntryQuery = invoiceListQueries.at(-1)!;
  expect(needsEntryQuery.searchParams.get('status')).toBe('needs_entry');
  expect(needsEntryQuery.searchParams.get('sortBy')).toBe('createdAt');
  expect(needsEntryQuery.searchParams.get('sortDirection')).toBe('asc');

  await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByTestId('needs-entry-workspace')).toBeVisible();
  await expect(page.getByTestId('inline-invoice-editor')).toBeVisible();
  await expect(page.getByTestId('select-line-0-authorization')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Line Items & Send to Review' })).toBeVisible();
  await expect(page.getByTestId('button-edit-invoice')).toHaveCount(0);
  await expect(page.getByTestId('button-validate-invoice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);

  await page.getByTestId('select-line-0-authorization').click();
  await page.getByTestId('select-line-0-authorization-option-auth-1').click();
  await page.getByTestId('input-line-0-amount').fill('100.00');
  await page.getByRole('button', { name: 'Save Line Items & Send to Review' }).click();
  await expect.poll(() => updateBody).toBeDefined();
  expect(updateBody?.status).toBe('pending_review');
  expect(updateBody?.lineItems).toHaveLength(1);
  await expect(page.getByTestId('needs-entry-workspace')).toHaveCount(0);
  await expect(page.getByTestId('button-validate-invoice')).toBeVisible();
});

test('Needs Entry editor validates service dates but permits an out-of-range line month', async ({ page }, testInfo) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));
  const invoice = {
    id: 'invoice-date-entry-1',
    clientId: 'client-1',
    clientName: 'Pat Participant',
    vendorId: null,
    vendorName: null,
    amountRequested: '125.00',
    status: 'needs_entry',
    submittedByRole: 'service_coordinator',
    submittedDate: '2026-11-03',
    serviceMonth: '2026-10',
    serviceStartDate: '2026-09-15',
    serviceEndDate: '2026-11-02',
    paymentType: 'direct_payment',
    documentType: 'invoice',
    documentUrl: '/objects/uploads/invoice.pdf',
    lineItems: [{
      id: 'line-date-1',
      authorizationId: 'auth-1',
      authNumber: 'AUTH-1',
      serviceCode: 'SVC-1',
      serviceMonth: '2026-10',
      amount: '125.00',
    }],
  };
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: { id: 'staff-date-1', name: 'CEPS Staff', email: 'staff@test', role: 'staff', active: true, permissions: ['invoice_log_validate'] },
  }));
  await page.route('**/api/invoices?*', (route) => route.fulfill({ json: { items: [invoice], total: 1 } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: { items: [{ id: 'auth-1', authNumber: 'AUTH-1', clientId: 'client-1', serviceCode: 'SVC-1', paymentType: 'direct_payment' }], total: 1 },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));

  const patches: Record<string, unknown>[] = [];
  // Do not let Vite's HTML fallback masquerade as the fixture's uploaded PDF.
  // Document preview is outside this editor-only regression.
  await page.route('**/api/storage/**', route => route.fulfill({
    status: 404, json: { error: 'No uploaded document in this mocked editor fixture' },
  }));
  await page.route('**/api/invoices/invoice-date-entry-1', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: invoice });
    if (route.request().method() !== 'PATCH') return route.fulfill({ status: 405 });
    patches.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, json: { ...invoice, ...patches.at(-1), status: 'pending_review' } });
  });

  await page.goto('/invoices');
  await page.getByTestId('tab-invoices-needs-entry').click();
  await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByTestId('inline-invoice-editor')).toBeVisible();

  await page.getByTestId('input-edit-serviceStartDate').fill('2026-11-03');
  await page.getByTestId('button-save-invoice').click();
  const dateError = 'Service end date must be on or after the start date';
  await expect(page.getByText(dateError, { exact: true })).toHaveCount(2);
  expect(patches).toHaveLength(0);
  await testInfo.attach('needs-entry-date-validation.png', { body: await page.screenshot(), contentType: 'image/png' });

  await page.getByTestId('input-edit-serviceStartDate').fill('2026-09-15');
  await page.locator('#edit-line-0-month').fill('2026-12');
  const warning = page.getByTestId('warning-line-0-service-dates');
  await expect(warning).toHaveText('Line month 2026-12 is outside the submitted service dates 2026-09-15 – 2026-11-02');
  await testInfo.attach('needs-entry-out-of-range-warning.png', { body: await page.screenshot(), contentType: 'image/png' });

  await page.getByTestId('button-save-invoice').click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({
    serviceStartDate: '2026-09-15',
    serviceEndDate: '2026-11-02',
    lineItems: [{ id: 'line-date-1', authorizationId: 'auth-1', serviceMonth: '2026-12', amount: '125.00' }],
  });
  await expect(warning).toBeVisible();
  expect(uncaughtErrors).toEqual([]);
});