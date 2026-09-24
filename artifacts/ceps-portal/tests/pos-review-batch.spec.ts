import { test, expect, type Page } from '@playwright/test';

const staff = { id: 'staff-1', name: 'CEPS Staff', email: 'staff@example.test', role: 'staff', active: true };
const documents = ['one', 'two', 'three'].map((name, i) => ({
  id: `pos-${name}`, batchId: 'batch-123', sourceFileName: `${name}.pdf`,
  posPdfUrl: `/objects/uploads/${name}.pdf`, parseStatus: i === 2 ? 'failed' : 'parsed',
  parseError: i === 2 ? 'Could not extract text' : null,
  reviewStatus: 'pending', createdAt: `2026-09-0${i + 1}T12:00:00Z`,
  authNumber: `AUTH-${i + 1}`, servicePeriodStart: '2026-09-01', servicePeriodEnd: '2026-10-01',
  serviceCode: '459', maxPeriodAmount: '735.00',
  suggestedClientId: i === 0 ? 'client-1' : null, suggestedClientName: i === 0 ? 'A Participant' : null,
  suggestedAuthorizationId: i === 1 ? 'auth-existing' : null,
}));

async function mockStaff(page: Page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: staff }));
  await page.route('**/api/clients?*', route => route.fulfill({ json: { items: [{ id: 'client-1', firstName: 'A', lastName: 'Participant', uciNumber: 'UCI-7' }], total: 1 } }));
  await page.route('**/api/vendors?*', route => route.fulfill({ json: { items: [{ id: 'vendor-1', name: 'Able Services' }], total: 1 } }));
  await page.route('**/api/storage/objects/**', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 test' }));
  await page.route('**/api/authorizations/auth-existing', route => route.fulfill({ json: {
    id: 'auth-existing', authNumber: 'AUTH-2', clientId: 'client-1', vendorId: 'vendor-1', serviceCode: '459',
    paymentType: 'direct_payment', servicePeriodStart: '2026-09-01', servicePeriodEnd: '2026-10-01',
    maxPeriodAmount: '700.00', monthlyAmount: '100.00', status: 'active',
  } }));
  await page.route('**/api/unmatched-pos?*', route => route.fulfill({ json: { items: documents.filter(item => item.reviewStatus === 'pending'), total: documents.filter(item => item.reviewStatus === 'pending').length } }));
  await page.route('**/api/unmatched-pos/pos-*/review', route => {
    const action = route.request().postDataJSON() as { action: string; reason?: string };
    if (action.action === 'discard' && !action.reason) return route.fulfill({ status: 400, json: { error: 'Reason required' } });
    const item = documents.find(doc => route.request().url().includes(doc.id))!;
    item.reviewStatus = 'pending'; // response is asserted; keep fixtures available to subsequent tests
    return route.fulfill({ json: { saved: true } });
  });
}

test('uploads three PDFs to one batch and exposes progress', async ({ page }) => {
  await mockStaff(page);
  await page.route('**/api/authorizations?*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/storage/uploads/request-url', async route => {
    const body = route.request().postDataJSON() as { name: string };
    return route.fulfill({ json: { uploadURL: `/upload/${body.name}`, objectPath: `/objects/uploads/${body.name}` } });
  });
  await page.route('**/upload/**', route => route.fulfill({ status: 200, body: '' }));
  let batchFiles: unknown[] = [];
  await page.route('**/api/unmatched-pos/batches', route => {
    batchFiles = (route.request().postDataJSON() as { files: unknown[] }).files;
    return route.fulfill({ status: 201, json: { batchId: 'batch-123', items: documents, queuedCount: 3 } });
  });
  await page.route('**/api/unmatched-pos/batches/batch-123', route => route.fulfill({ json: { batchId: 'batch-123', items: documents, total: 3, parsedCount: 2, failedCount: 1 } }));
  await page.goto('/authorizations');
  await page.getByTestId('button-toggle-pos-batch').click();
  await page.getByTestId('input-pos-batch').setInputFiles(['one', 'two', 'three'].map(name => ({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })));
  await page.getByTestId('button-create-pos-batch').click();
  await expect(page.getByText(/Batch created/)).toBeVisible();
  expect(batchFiles).toHaveLength(3);
  await expect(page.getByText('1 failed to parse; failed PDFs can still be reviewed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review this batch' })).toHaveAttribute('href', '/authorizations/review?batchId=batch-123');
});

test('review shows suggestion, filters vendors by client, amends, and requires discard reason', async ({ page }) => {
  await mockStaff(page);
  await page.goto('/authorizations/review?batchId=batch-123');
  await expect(page.getByTestId('text-review-progress')).toContainText('1 of 3');
  await expect(page.getByTestId('select-review-client')).toContainText('A Participant');
  await expect(page.getByTestId('select-review-vendor')).toContainText('Able Services');
  expect(page.url()).toContain('batchId=batch-123');
  await page.getByTestId('button-skip-pos').click();
  await expect(page.getByTestId('text-amendment-suggestion')).toBeVisible();
  await page.getByTestId('button-discard-pos').click();
  await expect(page.getByTestId('button-confirm-discard')).toBeDisabled();
  await page.getByTestId('input-discard-reason').fill('Duplicate scan');
  await expect(page.getByTestId('button-confirm-discard')).toBeEnabled();
  const requests = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  expect(requests.some(url => url.includes('/api/vendors?') && url.includes('clientId=client-1'))).toBeTruthy();
});

test('confirm sends edited fields and cancellation requires a reason for suggested authorizations', async ({ page }) => {
  await mockStaff(page);
  const submissions: Array<{ action: string; fields?: { authNumber: string }; clientId?: string; reason?: string }> = [];
  await page.route('**/api/unmatched-pos/pos-*/review', route => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: { saved: true, warnings: [], reviewStatus: 'confirmed' } });
  });
  await page.goto('/authorizations/review');
  await expect(page.getByTestId('button-mark-cancellation')).toHaveCount(0);
  await page.getByTestId('input-review-authNumber').fill('AUTH-UPDATED');
  await page.getByTestId('button-confirm-next').click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ action: 'confirm', clientId: 'client-1', fields: { authNumber: 'AUTH-UPDATED' } });
  await expect(page.getByTestId('button-mark-cancellation')).toBeVisible();
  await expect(page.getByTestId('input-review-authNumber')).toBeDisabled();
  await expect(page.getByTestId('select-review-payment')).toBeDisabled();
  await expect(page.getByTestId('select-review-vendor')).toBeDisabled();
  await expect(page.getByTestId('text-amendment-limits')).toContainText('Amendments can change dates, amounts, notes, and the PDF only');
  await page.getByTestId('button-mark-cancellation').click();
  await expect(page.getByTestId('button-confirm-cancellation')).toBeDisabled();
  await page.getByTestId('input-cancellation-reason').fill('Services ended');
  await page.getByTestId('button-confirm-cancellation').click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toMatchObject({ action: 'cancel', reason: 'Services ended' });
});

test('amendment submits supported fields only and highlights changed amounts', async ({ page }) => {
  await mockStaff(page);
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/unmatched-pos/pos-two/review', route => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: { saved: true, warnings: [], reviewStatus: 'confirmed' } });
  });
  await page.goto('/authorizations/review');
  await page.getByTestId('button-skip-pos').click();
  await expect(page.getByText('(changed)').first()).toBeVisible();
  await page.getByTestId('input-review-monthlyAmount').fill('');
  await page.getByTestId('button-confirm-next').click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ action: 'amend', fields: { monthlyAmount: null, maxPeriodAmount: '735.00' } });
  expect(submissions[0]).not.toHaveProperty('vendorId');
  expect(submissions[0]).not.toHaveProperty('paymentType');
  expect(submissions[0]).not.toHaveProperty('clientId');
  expect(submissions[0].fields).not.toHaveProperty('authNumber');
});

test('queued POS blocks actions until parsed; failed parse requires manual service and amount', async ({ page }) => {
  await mockStaff(page);
  const queued = { ...documents[0], parseStatus: 'queued', authNumber: null, serviceCode: null, maxPeriodAmount: null };
  let parsed = false;
  let submissions = 0;
  await page.route('**/api/unmatched-pos?*', route => route.fulfill({ json: {
    items: [parsed ? { ...queued, parseStatus: 'failed', parseError: 'Unreadable PDF' } : queued], total: 1,
  } }));
  await page.route('**/api/unmatched-pos/pos-one/review', route => { submissions++; return route.fulfill({ json: { saved: true, warnings: [], reviewStatus: 'confirmed' } }); });
  await page.goto('/authorizations/review');
  await expect(page.getByTestId('status-pos-parsing')).toBeVisible();
  await expect(page.getByTestId('button-confirm-next')).toBeDisabled();
  await expect(page.getByTestId('button-discard-pos')).toBeDisabled();
  parsed = true;
  await page.getByTestId('button-refresh-review').click();
  await expect(page.getByText(/PDF extraction failed/)).toBeVisible();
  await page.getByTestId('button-confirm-next').click();
  await expect(page.getByRole('alert').last()).toContainText('authorization number and choose a service code');
  await page.getByTestId('input-review-authNumber').fill('AUTH-MANUAL');
  await page.getByTestId('select-review-serviceCode').click();
  await page.getByRole('option', { name: /459/ }).click();
  await page.getByTestId('input-review-servicePeriodStart').fill('2026-09-01');
  await page.getByTestId('input-review-servicePeriodEnd').fill('2026-10-01');
  await page.getByTestId('input-review-maxPeriodAmount').fill('0');
  await page.getByTestId('button-confirm-next').click();
  await expect(page.getByRole('alert').last()).toContainText('max period amount greater than zero');
  expect(submissions).toBe(0);
  await page.getByTestId('input-review-maxPeriodAmount').fill('851.25');
  await page.getByTestId('input-review-units').fill('3');
  await page.getByTestId('input-review-activity').fill('Supported services');
  await page.getByTestId('button-confirm-next').click();
  await expect.poll(() => submissions).toBe(1);
});