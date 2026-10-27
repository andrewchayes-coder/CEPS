import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const client = { id: 'billing-client', firstName: 'Ari', lastName: 'Rivera', uciNumber: '8936241', dateOfBirth: '2011-03-12', status: 'active' };
const baseFlag = { id: 'flag-payment-1', reason: 'Check invoice amount', flaggedBy: 'staff-1', flaggedByName: 'CEPS Staff', flaggedAt: '2026-01-15T12:00:00Z', resolvedAt: null, resolvedBy: null, resolutionNote: null };

async function commonMocks(page: Page, role = 'staff', permissions = ['remittance_entry']) {
  const calls: { importBodies: any[]; flags: any[]; resolves: any[]; billingGets: number; reportQueries: URL[]; exports: URL[]; csvBodies: string[] } = {
    importBodies: [], flags: [], resolves: [], billingGets: 0, reportQueries: [], exports: [], csvBodies: [],
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { id: 'staff-1', name: 'CEPS Staff', email: 'staff@test', role, active: true, permissions } });
    if (path === '/api/clients/billing-client/case') return route.fulfill({ json: { client, authorizations: [], invoices: [], payments: [{ id: 'payment-1', clientId: client.id, qbCheckNumber: 'CHK-100', checkDate: '2026-01-10', amount: '125.00', paymentType: 'direct_payment', source: 'quickbooks', allocatedAmount: '125.00', remainingAmount: '0.00', allocations: [{ id: 'line-billed', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2025-12', amount: '125.00', remittedAmount: '0.00', remitted: 'none', remittanceLinks: [], billingStatus: 'billed', billedAt: '2026-01-01T00:00:00Z', billedAmount: '125.00', invoiceNumber: 'INV-2026-01', billingCount: 2 }] }], remittances: [], referrals: [], documents: [] } });
    if (path === '/api/fees') return route.fulfill({ json: [] });
    if (path === '/api/family-representatives') return route.fulfill({ json: [] });
    if (path.endsWith('/message-threads')) return route.fulfill({ json: { total: 0, items: [] } });
    if (path.endsWith('/notes')) return route.fulfill({ json: [] });
    if (path === '/api/clients' || path === '/api/vendors') return route.fulfill({ json: { items: [], total: 0 } });
    if (path === '/api/user-directory') return route.fulfill({ json: [] });
    if (path === '/api/dashboard/summary' || path.endsWith('/dashboard-summary')) return route.fulfill({ json: { totals: { activeClients: 0, activeAuthorizations: 0, pendingInvoices: 0, vendorsMissingW9: 0, paymentsThisMonth: 0, unmatchedRemittances: 0 }, referralsByStatus: [] } });
    if (path === '/api/billing/rows') { calls.billingGets++; return route.fulfill({ json: { items: [], total: 0 } }); }
    if (path === '/api/remittances') return route.fulfill({ json: { items: [], total: 0 } });
    if (path.startsWith('/api/reports/billing')) {
      if (path.endsWith('/export')) {
        calls.exports.push(url);
        const csv = 'Participant,Invoice\nAri Rivera,INV-CSV-1\n';
        calls.csvBodies.push(csv);
        return route.fulfill({ contentType: 'text/csv', body: csv });
      }
      calls.reportQueries.push(url);
      return route.fulfill({ json: { items: [], total: 0 } });
    }
    return route.fulfill({ json: [] });
  });
  return calls;
}

test('remittance page separates payment and invoice history; billing import previews then commits', async ({ page }, testInfo) => {
  const calls = await commonMocks(page);
  const importResult = (mode: 'preview' | 'commit') => ({
    mode, headers: ['Invoice'], rows: [
      { id: 'row-match', rowNumber: 2, invoiceNumber: 'INV-100', billedAt: '2026-01-01', uciNumber: '8936241', authNumber: 'AUTH-1', serviceMonth: '2025-12', serviceCode: '459', billedAmount: '125.00', matchStatus: 'matched', reviewReason: null, clientName: 'Ari Rivera', targetCount: 1 },
      { id: 'row-deferred', rowNumber: 3, invoiceNumber: 'INV-101', billedAt: '2026-01-02', uciNumber: '8936241', authNumber: 'AUTH-1', serviceMonth: '2025-12', serviceCode: '459', billedAmount: '75.00', matchStatus: 'unmatched', reviewReason: 'Deferred for review', clientName: 'Ari Rivera', targetCount: 0 },
      { id: 'row-untracked', rowNumber: 4, invoiceNumber: 'INV-102', billedAt: '2026-01-03', uciNumber: '9999999', authNumber: 'UNKNOWN', serviceMonth: '2025-12', serviceCode: '459', billedAmount: '50.00', matchStatus: 'unmatched', reviewReason: 'Service is not tracked', clientName: null, targetCount: 0, untracked: true },
    ], imported: mode === 'commit' ? 1 : 0, matched: 1, unmatched: 1, amountMismatch: 0, alreadyImported: 0,
    deferred: 1, totalAmount: '250.00', importBatchId: mode === 'commit' ? 'billing-batch-1' : null,
    untrackedCount: 1, untrackedAmount: '50.00',
  });
  await page.route('**/api/billing/import', async (route) => {
    const body = route.request().postDataJSON();
    calls.importBodies.push(body);
    await route.fulfill({ json: importResult(body.mode) });
  });
  await page.goto('/remittances');
  const paymentCard = page.getByTestId('card-payment-history-import');
  const invoiceCard = page.getByTestId('card-invoice-history-import');
  await expect(paymentCard).toContainText('Alta Payment History (payments)');
  await expect(paymentCard).toContainText('Records payments received from Alta. Does not mark items as Billed.');
  await expect(invoiceCard).toContainText('Alta Invoice History (billing)');
  await expect(invoiceCard).toContainText('Marks items as Billed. Does not record any payment.');
  await expect(paymentCard).not.toHaveText(/Invoice History/);
  await page.getByTestId('button-import-alta-billing').click();
  await page.getByTestId('input-billing-file').setInputFiles({ name: 'alta-invoices.csv', mimeType: 'text/csv', buffer: Buffer.from('Invoice\nINV-100') });
  await expect(page.getByTestId('billing-import-summary')).toBeVisible();
  await expect(page.getByText('Preview only. Nothing has been saved yet.')).toBeVisible();
  await expect(page.getByTestId('stat-billing-matched')).toContainText('1');
  await expect(page.getByTestId('stat-billing-deferred')).toContainText('1');
  await expect(page.getByTestId('group-billing-untracked')).toContainText('1 rows');
  await expect(page.getByTestId('group-billing-untracked')).toContainText('$50.00');
  await expect(page.getByText('Invoice total').locator('..')).toContainText('$250.00');
  await page.getByTestId('button-confirm-billing-import').click();
  await expect(page.getByText('Imported 1 rows.')).toBeVisible();
  expect(calls.importBodies.map((x) => x.mode)).toEqual(['preview', 'commit']);
  expect(calls.importBodies[0].csvContent).toContain('INV-100');
  await expect.poll(() => calls.billingGets).toBeGreaterThan(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(invoiceCard).toBeVisible();
  const cards = await Promise.all([paymentCard, invoiceCard].map((el) => el.boundingBox()));
  expect(cards.every((box) => !!box && box.x >= 0 && box.x + box.width <= 390)).toBe(true);
  const screenshot = await page.screenshot({ path: testInfo.outputPath('billing-remittances-mobile.png') });
  await testInfo.attach('billing-remittances-mobile.png', { body: screenshot, contentType: 'image/png' });
});

test('client payment and fee billing statuses, details and review flags honor permissions', async ({ page }, testInfo) => {
  const calls = await commonMocks(page);
  const activeFlags: Record<string, any> = {};
  const allocations = [
    { id: 'line-billed', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2025-12', amount: '125.00', remittedAmount: '0.00', remitted: 'none', remittanceLinks: [], billingStatus: 'billed', billedAt: '2026-01-01T00:00:00Z', billedAmount: '125.00', invoiceNumber: 'INV-2026-01', billingCount: 2 },
    { id: 'line-pending', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2025-11', amount: '100.00', remittedAmount: '0.00', remitted: 'none', remittanceLinks: [], billingStatus: 'pending' },
    { id: 'line-partial', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2025-10', amount: '100.00', remittedAmount: '25.00', remitted: 'partial', remittanceLinks: [], billingStatus: 'partially_paid' },
    { id: 'line-paid', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2025-09', amount: '100.00', remittedAmount: '100.00', remitted: 'full', remittanceLinks: [], billingStatus: 'paid' },
  ];
  const caseData = { client, authorizations: [], invoices: [], remittances: [], referrals: [], documents: [], payments: [
    { id: 'payment-1', clientId: client.id, qbCheckNumber: 'CHK-100', checkDate: '2026-01-10', amount: '425.00', paymentType: 'direct_payment', source: 'quickbooks', allocatedAmount: '425.00', remainingAmount: '0.00', allocations },
  ] };
  const fees: any[] = [
    { id: 'fee-1', clientId: client.id, paymentId: null, authorizationId: null, authNumber: null, feeMonth: '2025-12', amount: '160.00', remittedAmount: '0.00', feeAuthorizationMissing: false, status: 'pending', billingStatus: 'pending' },
  ];
  await page.route('**/api/clients/billing-client/case', (route) => route.fulfill({ json: { ...caseData, payments: caseData.payments.map((p) => ({ ...p, allocations: allocations.map((line) => ({ ...line, flag: activeFlags[line.id] ?? null })) })) } }));
  await page.route('**/api/fees**', (route) => route.fulfill({ json: fees.map((fee) => ({ ...fee, flag: activeFlags[fee.id] ?? null })) }));
  const targetByFlag: Record<string, string> = {};
  await page.route('**/api/review-flags', async (route) => {
    const body = route.request().postDataJSON();
    calls.flags.push(body);
    const flag = { ...baseFlag, id: `flag-${body.targetId}`, reason: body.reason, resolvedAt: null, resolutionNote: null };
    activeFlags[body.targetId] = flag;
    targetByFlag[flag.id] = body.targetId;
    await route.fulfill({ status: 201, json: flag });
  });
  await page.route('**/api/review-flags/*/resolve', async (route) => {
    const body = route.request().postDataJSON();
    calls.resolves.push(body);
    const flagId = new URL(route.request().url()).pathname.split('/')[3];
    const targetId = targetByFlag[flagId];
    activeFlags[targetId] = { ...activeFlags[targetId], resolvedAt: '2026-02-01T12:00:00Z', resolutionNote: body.note };
    await route.fulfill({ json: activeFlags[targetId] });
  });
  await page.goto('/clients/billing-client?tab=payments');
  await expect(page.getByTestId('status-payment-billing-line-billed-badge')).toHaveText('Billed');
  await expect(page.getByTestId('status-payment-billing-line-pending-badge')).toHaveText('Pending');
  await expect(page.getByTestId('status-payment-billing-line-partial-badge')).toHaveText('Partially paid');
  await expect(page.getByTestId('status-payment-billing-line-paid-badge')).toHaveText('Paid');
  await page.getByTestId('status-payment-billing-line-billed-details').click();
  await expect(page.getByText('INV-2026-01')).toBeVisible();
  await expect(page.getByText('12/31/2025', { exact: true })).toBeVisible();
  await expect(page.getByText('$125.00').last()).toBeVisible();
  await expect(page.getByTestId('status-payment-billing-line-billed-billing-count')).toContainText('Billed 2 times');
  await page.getByTestId('button-flag-payment-line-line-billed').click();
  await page.getByTestId('button-flag-payment-line-line-billed-input').fill('Please review billing');
  await page.getByTestId('button-flag-payment-line-line-billed-submit').click();
  await expect(page.getByTestId('status-payment-billing-line-billed-flag')).toContainText('Please review billing');
  expect(calls.flags[0]).toEqual({ targetType: 'payment_line', targetId: 'line-billed', reason: 'Please review billing' });
  await page.getByTestId('button-flag-payment-line-line-billed').click();
  await page.getByTestId('button-flag-payment-line-line-billed-input').fill('Resolved after checking');
  await page.getByTestId('button-flag-payment-line-line-billed-submit').click();
  await expect(page.getByTestId('status-payment-billing-line-billed-flag')).toHaveCount(0);
  expect(calls.resolves).toEqual([{ note: 'Resolved after checking' }]);
  await page.getByTestId('tab-fees').click();
  await page.getByTestId('button-flag-fee-fee-1').click();
  await page.getByTestId('button-flag-fee-fee-1-input').fill('Fee needs review');
  await page.getByTestId('button-flag-fee-fee-1-submit').click();
  expect(calls.flags[1]).toEqual({ targetType: 'fee', targetId: 'fee-1', reason: 'Fee needs review' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('button-flag-fee-fee-1')).toBeVisible();
  const screenshot = await page.screenshot({ path: testInfo.outputPath('billing-client-fees-mobile.png') });
  await testInfo.attach('billing-client-fees-mobile.png', { body: screenshot, contentType: 'image/png' });
  expect(calls.exports).toHaveLength(0);
});

test('billing reports are staff-only; status and age filters reach numeric queries and CSV export', async ({ page }, testInfo) => {
  const calls = await commonMocks(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/reports');
  await expect(page.getByTestId('tab-billing-flagged')).toBeVisible();
  await expect(page.getByTestId('tab-billing-unpaid')).toBeVisible();
  await page.getByTestId('tab-billing-flagged').click();
  await expect(page.getByTestId('card-billing-report-flagged')).toBeVisible();
  await expect.poll(() => calls.reportQueries.some((url) => url.searchParams.get('status') === 'open')).toBe(true);
  const statusSelect = page.getByTestId('select-flag-status');
  await statusSelect.click();
  await page.getByRole('option', { name: 'Resolved' }).click();
  await expect.poll(() => calls.reportQueries.some((url) => url.searchParams.get('status') === 'resolved')).toBe(true);
  await statusSelect.click();
  await page.getByRole('option', { name: 'All' }).click();
  await expect.poll(() => calls.reportQueries.some((url) => url.searchParams.get('status') === 'all')).toBe(true);
  const flaggedDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('button-export-billing-flagged').click();
  const flaggedDownload = await flaggedDownloadPromise;
  expect(flaggedDownload.suggestedFilename()).toBe('flagged_for_review.csv');
  expect(await readFile((await flaggedDownload.path())!, 'utf8')).toContain('Ari Rivera,INV-CSV-1');
  await expect.poll(() => calls.exports.length).toBe(1);
  expect(calls.exports[0].searchParams.get('status')).toBe('all');
  expect(calls.exports[0].searchParams.has('limit')).toBe(false);
  expect(calls.csvBodies[0]).toContain('Ari Rivera,INV-CSV-1');
  await page.getByTestId('tab-billing-unpaid').click();
  const ageSelect = page.getByTestId('select-unpaid-age');
  await expect.poll(() => calls.reportQueries.some((url) => url.searchParams.get('olderThanDays') === '0')).toBe(true);
  for (const [label, expected] of [['30+ days ago', '30'], ['60+ days ago', '60'], ['90+ days ago', '90']] as const) {
    await ageSelect.click();
    await page.getByRole('option', { name: label }).click();
    await expect.poll(() => calls.reportQueries.some((url) => url.searchParams.get('olderThanDays') === expected)).toBe(true);
  }
  const unpaidDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('button-export-billing-unpaid').click();
  const unpaidDownload = await unpaidDownloadPromise;
  expect(unpaidDownload.suggestedFilename()).toBe('billed_not_paid.csv');
  expect(await readFile((await unpaidDownload.path())!, 'utf8')).toContain('Ari Rivera,INV-CSV-1');
  await expect.poll(() => calls.exports.length).toBe(2);
  expect(calls.exports[1].searchParams.get('olderThanDays')).toBe('90');
  expect(calls.exports[1].searchParams.has('limit')).toBe(false);
  expect(calls.csvBodies[1]).toContain('Ari Rivera,INV-CSV-1');
  await expect(page.getByRole('tab', { name: 'Billed, not paid' })).toBeVisible();
  const desktopScreenshot = await page.screenshot({ path: testInfo.outputPath('billing-reports-desktop.png') });
  await testInfo.attach('billing-reports-desktop.png', { body: desktopScreenshot, contentType: 'image/png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('button-export-billing-unpaid')).toBeVisible();
  const mobileScreenshot = await page.screenshot({ path: testInfo.outputPath('billing-reports-mobile.png') });
  await testInfo.attach('billing-reports-mobile.png', { body: mobileScreenshot, contentType: 'image/png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('staff without remittance_entry cannot see billing mutation controls', async ({ page }) => {
  await commonMocks(page, 'staff', []);
  await page.goto('/remittances');
  await expect(page.getByTestId('card-payment-history-import')).toHaveCount(0);
  await expect(page.getByTestId('button-import-alta-billing')).toHaveCount(0);
  await page.goto('/clients/billing-client?tab=payments');
  await expect(page.getByTestId('button-flag-payment-line-line-billed')).toHaveCount(0);
});
