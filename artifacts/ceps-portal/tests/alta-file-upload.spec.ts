import { expect, test, type Page, type Request } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name);

const staffUser = {
  id: 'synthetic-staff',
  name: 'Synthetic Test Staff',
  email: 'staff@ceps.example',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2099-09-01T12:00:00.000Z',
};

async function signInAsDemoStaff(page: Page) {
  let signedIn = false;
  await page.route('**/api/auth/me', (route) =>
    signedIn
      ? route.fulfill({ json: staffUser })
      : route.fulfill({ status: 401, json: { error: 'Not authenticated' } }),
  );
  await page.route('**/api/auth/login', async (route) => {
    expect(await route.request().postDataJSON()).toEqual({
      email: 'staff@ceps.example',
      password: 'ceps-demo-2026',
    });
    signedIn = true;
    await route.fulfill({ json: staffUser });
  });

  await page.goto('/login');
  await page.getByTestId('button-quick-login-staff').click();
  await expect(page).toHaveURL(/\/$/);
}

async function postBody(request: Request) {
  return request.postDataJSON() as Record<string, unknown>;
}

test('demo staff can upload synthetic Alta Excel and CSV reports without touching persisted data', async ({ page }) => {
  await signInAsDemoStaff(page);

  let paymentImportRequests = 0;
  let auditRequests = 0;
  await page.route('**/api/payments/import/audit', async route => {
    auditRequests++;
    expect((await postBody(route.request())).worksheetRows).toHaveLength(4);
    await route.fulfill({ json: {
      summary: { match: 1, payee_mismatch: 0, amount_mismatch: 0, no_approved_invoice: 0, already_paid: 0, unknown_client: 0, unknown_authorization: 1, duplicate_row: 0 },
      rows: [
        { rowNumber: 2, checkNumber: 'SYNTHETIC-CHECK-001', checkDate: '09/01/2099', uciNumber: '0000000', participantName: 'Synthetic Participant', payeeName: 'Synthetic Vendor — NOT REAL', checkAmount: '123.45', result: 'match', reason: 'Matches approved invoice.', invoiceId: 'synthetic-invoice', invoiceVendor: 'Synthetic Vendor — NOT REAL', approvedAmount: '123.45', remainingAmount: '123.45', reviewedBy: 'Synthetic Reviewer' },
        { rowNumber: 4, checkNumber: '', uciNumber: '0000000', result: 'unknown_authorization', reason: 'No matching authorization.' },
      ],
      headerError: null, parseProblems: ['Row 4: malformed Check row.'], ignoredNonCheckRows: 1,
    } });
  });
  await page.route('**/api/payments/import', async (route) => {
    paymentImportRequests++;
    const body = await postBody(route.request());
    expect(body.acknowledgements).toEqual([]);
    expect(body.worksheetRows).toEqual([
      ['Transaction date', 'Transaction type', 'Num', 'Name', 'Description', 'Split', 'Amount', 'Customer'],
      ['09/01/2099', 'Check', 'SYNTHETIC-CHECK-001', 'Synthetic Vendor — NOT REAL', 'Services/Sep 99/SYNTH-AUTH-001', '', '123.45', 'Synthetic Participant 0000000 (TEST ONLY)'],
      ['09/02/2099', 'Invoice', 'SYNTHETIC-INVOICE-IGNORED', 'Synthetic Vendor — NOT REAL', 'Services/Sep 99/IGNORED', '', '50.00', 'Synthetic Participant 0000000 (TEST ONLY)'],
      ['09/03/2099', 'Check', '', 'Synthetic Vendor — NOT REAL', 'Services/Sep 99/SYNTH-AUTH-001', '', '10.00', 'Synthetic Participant 0000000 (TEST ONLY)'],
    ]);
    await route.fulfill({
      json: {
        imported: 1,
        skippedDuplicate: 0,
        flaggedDuplicate: 0,
        errored: 1,
        ignoredNonCheckRows: 1,
        headerError: null,
        parseProblems: ['Row 4: malformed Check row.'],
        results: [
          { rowNumber: 2, uciNumber: '0000000', outcome: 'imported', paymentId: 'synthetic-payment' },
          {
            rowNumber: 4,
            uciNumber: '0000000',
            outcome: 'errored',
            message: 'Row 4: malformed Check row.',
            paymentId: 'internal-payment-id-must-not-export',
          },
        ],
      },
    });
  });
  await page.route('**/api/payments?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));

  await page.goto('/payments');
  await page.getByTestId('button-import-alta-fms-payments').click();
  await page.getByTestId('input-alta-fms-payments').setInputFiles(
    fixture('synthetic-alta-fms-transaction-detail.xlsx'),
  );
  await expect(page.getByTestId('section-alta-fms-audit')).toBeVisible();
  expect(paymentImportRequests).toBe(0);
  await expect(page.getByTestId('button-confirm-alta-fms-import')).toBeEnabled();
  await page.getByTestId('button-confirm-alta-fms-import').click();
  await expect(page.getByTestId('text-alta-fms-imported')).toHaveText('1');
  await expect(page.getByTestId('text-alta-fms-errored')).toHaveText('1');
  await expect(page.getByTestId('text-alta-fms-ignored')).toHaveText('1');
  const paymentDownload = page.waitForEvent('download');
  await page.getByTestId('button-download-alta-fms-corrections').click();
  const paymentCsvPath = await (await paymentDownload).path();
  expect(paymentCsvPath).not.toBeNull();
  const paymentCsvText = await readFile(paymentCsvPath!, 'utf8');
  expect(paymentCsvText).toContain('Source row,UCI,Outcome,Detail');
  expect(paymentCsvText).toContain('4,0000000,Errored,Row 4: malformed Check row.');
  expect(paymentCsvText).not.toContain('Imported');
  expect(paymentCsvText).not.toContain('internal-payment-id-must-not-export');
  const paymentAuditDownload = page.waitForEvent('download');
  await page.getByTestId('button-download-alta-fms-full-audit').click();
  const paymentAuditCsvPath = await (await paymentAuditDownload).path();
  expect(paymentAuditCsvPath).not.toBeNull();
  const paymentAuditCsvText = await readFile(paymentAuditCsvPath!, 'utf8');
  expect(paymentAuditCsvText).toContain('Source row,UCI,Outcome,Detail');
  expect(paymentAuditCsvText).toContain('2,0000000,Imported,');
  expect(paymentAuditCsvText).toContain('4,0000000,Errored,Row 4: malformed Check row.');
  expect(paymentAuditCsvText).not.toContain('synthetic-payment');
  expect(paymentAuditCsvText).not.toContain('internal-payment-id-must-not-export');
  expect(paymentImportRequests).toBe(1);
  expect(auditRequests).toBe(1);

  let remittanceImportRequests = 0;
  await page.route('**/api/remittances/import', async (route) => {
    remittanceImportRequests++;
    const body = await postBody(route.request());
    expect(body.csvText).toContain('SYNTHETIC-ERROR-REPORT-NOT-REAL');
    expect(body.csvText).toContain('Synthetic Participant — NOT REAL');
    await route.fulfill({
      json: {
        remittanceBatchId: 'synthetic-empty-batch',
        parsed: 2,
        imported: 1,
        errored: 1,
        autoMatched: 1,
        needsManualMatch: 0,
        skippedDuplicate: 0,
        headerError: null,
        parseProblems: [],
        results: [
          {
            rowNumber: 3,
            uciNumber: '1111111',
            outcome: 'auto_matched',
            message: 'Matched successfully.',
            remittanceId: 'synthetic-remittance-id-must-not-export',
          },
          {
            rowNumber: 4,
            uciNumber: '0000000',
            outcome: 'errored',
            message: 'No participant found for synthetic UCI. Row not imported.',
            remittanceId: 'internal-remittance-id-must-not-export',
          },
        ],
      },
    });
  });
  await page.route('**/api/remittances?*', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );

  await page.goto('/remittances');
  await page.getByTestId('button-import-alta-remittances').click();
  await page.getByTestId('input-alta-remittances-csv').setInputFiles(
    fixture('synthetic-alta-payment-history-error.csv'),
  );
  await expect(page.getByTestId('text-alta-imported-count')).toHaveText('1');
  await expect(page.getByTestId('text-alta-errored-count')).toHaveText('1');
  await expect(page.getByTestId('text-alta-automatched-count')).toHaveText('1');
  await expect(page.getByTestId('text-alta-needsmatch-count')).toHaveText('0');
  const remittanceDownload = page.waitForEvent('download');
  await page.getByTestId('button-download-alta-remittance-corrections').click();
  const remittanceCsvPath = await (await remittanceDownload).path();
  expect(remittanceCsvPath).not.toBeNull();
  const remittanceCsvText = await readFile(remittanceCsvPath!, 'utf8');
  expect(remittanceCsvText).toContain('Source row,UCI,Outcome,Detail');
  expect(remittanceCsvText).toContain('4,0000000,Errored,No participant found for synthetic UCI. Row not imported.');
  expect(remittanceCsvText).not.toContain('Auto-matched');
  expect(remittanceCsvText).not.toContain('internal-remittance-id-must-not-export');
  const remittanceAuditDownload = page.waitForEvent('download');
  await page.getByTestId('button-download-alta-remittance-full-audit').click();
  const remittanceAuditCsvPath = await (await remittanceAuditDownload).path();
  expect(remittanceAuditCsvPath).not.toBeNull();
  const remittanceAuditCsvText = await readFile(remittanceAuditCsvPath!, 'utf8');
  expect(remittanceAuditCsvText).toContain('Source row,UCI,Outcome,Detail');
  expect(remittanceAuditCsvText).toContain('3,1111111,Auto-matched,Matched successfully.');
  expect(remittanceAuditCsvText).toContain('4,0000000,Errored,No participant found for synthetic UCI. Row not imported.');
  expect(remittanceAuditCsvText).not.toContain('synthetic-remittance-id-must-not-export');
  expect(remittanceAuditCsvText).not.toContain('internal-remittance-id-must-not-export');
  expect(remittanceImportRequests).toBe(1);

  // All write endpoints are intercepted above, so this test creates no database or audit data to clean up.
});

test('preflight blocks actionable exceptions until noted, exports only public audit columns, and resets on reupload', async ({ page }) => {
  await signInAsDemoStaff(page);
  let auditCalls = 0;
  let importCalls = 0;
  await page.route('**/api/payments/import/audit', async route => {
    auditCalls++;
    await route.fulfill({ json: {
      summary: { match: 0, payee_mismatch: 1, amount_mismatch: 0, no_approved_invoice: 0, already_paid: 0, unknown_client: 1, unknown_authorization: 0, duplicate_row: 0 },
      rows: [
        { rowNumber: 2, checkNumber: 'SYNTHETIC-CHECK-001', checkDate: '09/01/2099', uciNumber: '0000000', participantName: 'Synthetic Participant', payeeName: 'Check Alias', checkAmount: '123.45', result: 'payee_mismatch', reason: 'Payee differs from approved vendor.', invoiceId: 'internal-invoice-id', invoiceVendorId: 'private-vendor-id', invoiceVendor: 'Synthetic Approved Vendor', approvedAmount: '123.45', remainingAmount: '123.45', reviewedBy: 'Synthetic Reviewer' },
        { rowNumber: 4, result: 'unknown_client', reason: 'Participant could not be found.' },
      ],
      headerError: null, parseProblems: [], ignoredNonCheckRows: 1,
    } });
  });
  await page.route('**/api/payments/import', async route => {
    importCalls++;
    expect((await postBody(route.request())).acknowledgements).toEqual([{ rowNumber: 2, note: 'Approved alternate payee' }]);
    await route.fulfill({ json: { imported: 1, skippedDuplicate: 0, flaggedDuplicate: 0, errored: 0, ignoredNonCheckRows: 1, headerError: null, parseProblems: [], results: [{ rowNumber: 2, outcome: 'imported' }] } });
  });
  await page.route('**/api/payments?*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.goto('/payments');
  await page.getByTestId('button-import-alta-fms-payments').click();
  const file = fixture('synthetic-alta-fms-transaction-detail.xlsx');
  await page.getByTestId('input-alta-fms-payments').setInputFiles(file);
  await expect(page.getByTestId('button-confirm-alta-fms-import')).toBeDisabled();
  expect(importCalls).toBe(0);
  await expect(page.getByTestId('row-alta-fms-audit-4')).toContainText('Cannot acknowledge');
  await expect(page.getByTestId('row-alta-fms-audit-2')).toContainText('Synthetic Approved Vendor');
  await expect(page.getByTestId('link-alta-fms-audit-invoice-2')).toHaveAttribute('href', '/invoices/internal-invoice-id');
  const csvDownload = page.waitForEvent('download');
  await page.getByTestId('button-download-alta-fms-audit').click();
  const csv = await readFile((await (await csvDownload).path())!, 'utf8');
  expect(csv).toContain('Payee on check,Approved vendor,Check amount');
  expect(csv).toContain('Check Alias,Synthetic Approved Vendor,123.45');
  expect(csv).not.toContain('internal-invoice-id');
  expect(csv).not.toContain('private-vendor-id');
  await page.getByTestId('input-alta-fms-audit-note-2').fill('  ');
  await expect(page.getByTestId('button-confirm-alta-fms-import')).toBeDisabled();
  await page.getByTestId('input-alta-fms-audit-note-2').fill('Old note');
  await page.getByTestId('input-alta-fms-payments').setInputFiles(file);
  await expect.poll(() => auditCalls).toBe(2);
  await expect(page.getByTestId('input-alta-fms-audit-note-2')).toHaveValue('');
  await page.getByTestId('input-alta-fms-audit-note-2').fill(' Approved alternate payee ');
  await page.getByTestId('button-confirm-alta-fms-import').click();
  await expect(page.getByTestId('text-alta-fms-imported')).toHaveText('1');
  expect(importCalls).toBe(1);
});

test('staff Help explains pre-import audit and Edit Vendor provides QuickBooks alias', async ({ page }) => {
  await signInAsDemoStaff(page);
  await page.goto('/help');
  await expect(page.getByText('Alta FMS payment import')).toBeVisible();
  await expect(page.getByText('No payments are saved during this audit.', { exact: false })).toBeVisible();
  const vendor = {
    id: 'synthetic-vendor', name: 'Synthetic Vendor', qbPayeeName: 'Check Alias',
    w9Status: 'pending', preferred: false, active: true,
  };
  let contactSaved = false;
  await page.route('**/api/vendors/synthetic-vendor', async route => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ json: vendor });
    } else {
      await route.fulfill({ json: vendor });
    }
  });
  await page.route('**/api/vendors/synthetic-vendor/contact', async route => {
    expect((await postBody(route.request())).qbPayeeName).toBe('Alternate Check Name');
    contactSaved = true;
    await route.fulfill({ json: { ...vendor, qbPayeeName: 'Alternate Check Name' } });
  });
  await page.goto('/vendors/synthetic-vendor');
  await expect(page.getByTestId('input-vendor-qb-payee-name')).toHaveValue('Check Alias');
  await expect(page.getByText('QuickBooks payee name (if different)')).toBeVisible();
  await page.getByTestId('input-vendor-qb-payee-name').fill('Alternate Check Name');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(() => contactSaved).toBe(true);
});

test('ambiguous approved invoices require an explicit choice as well as a note; no-candidate exception needs only a note', async ({ page }) => {
  await signInAsDemoStaff(page);
  let auditCalls = 0;
  let importCalls = 0;
  await page.route('**/api/payments/import/audit', async route => {
    auditCalls++;
    await route.fulfill({ json: {
      summary: { match: 0, payee_mismatch: 1, amount_mismatch: 0, no_approved_invoice: 1, already_paid: 0, unknown_client: 0, unknown_authorization: 0, duplicate_row: 0 },
      rows: [
        {
          rowNumber: 2, checkNumber: 'SYNTHETIC-CHECK-001', checkDate: '09/01/2099', uciNumber: '0000000',
          participantName: 'Synthetic Participant', payeeName: 'Check Alias', checkAmount: '123.45',
          result: 'payee_mismatch', reason: 'Multiple approved invoices need explicit resolution.', invoiceId: null,
          candidates: [
            { invoiceId: 'private-invoice-a', vendorName: 'Vendor A', approvedAmount: '125.00', remainingAmount: '125.00', reviewedBy: 'Reviewer A', reviewedAt: '2099-08-01' },
            { invoiceId: 'private-invoice-b', vendorName: 'Vendor B', approvedAmount: '123.45', remainingAmount: null, reviewedBy: 'Reviewer B', reviewedAt: '2099-08-02' },
          ],
        },
        { rowNumber: 4, result: 'no_approved_invoice', reason: 'No approved invoice exists.', invoiceId: null, candidates: [] },
      ],
      parseProblems: [], headerError: null, ignoredNonCheckRows: 1,
    } });
  });
  await page.route('**/api/payments/import', async route => {
    importCalls++;
    expect((await postBody(route.request())).acknowledgements).toEqual([
      { rowNumber: 2, note: 'Confirmed with accounting', invoiceId: 'private-invoice-a' },
      { rowNumber: 4, note: 'Historical check, reviewed' },
    ]);
    await route.fulfill({ json: {
      imported: 1, skippedDuplicate: 0, flaggedDuplicate: 0, errored: 1, ignoredNonCheckRows: 1,
      headerError: null, parseProblems: [], results: [{ rowNumber: 2, outcome: 'imported' }, { rowNumber: 4, outcome: 'errored' }],
    } });
  });
  await page.route('**/api/payments?*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.goto('/payments');
  await page.getByTestId('button-import-alta-fms-payments').click();
  const file = fixture('synthetic-alta-fms-transaction-detail.xlsx');
  await page.getByTestId('input-alta-fms-payments').setInputFiles(file);
  await expect(page.getByTestId('choices-alta-fms-audit-2')).toBeVisible();
  await expect(page.getByTestId('choices-alta-fms-audit-4')).toHaveCount(0);
  await expect(page.getByTestId('radio-alta-fms-audit-invoice-2-0')).not.toBeChecked();
  await expect(page.getByTestId('radio-alta-fms-audit-invoice-2-1')).not.toBeChecked();
  await page.getByTestId('input-alta-fms-audit-note-2').fill('Confirmed with accounting');
  await page.getByTestId('input-alta-fms-audit-note-4').fill('Historical check, reviewed');
  await expect(page.getByTestId('button-confirm-alta-fms-import')).toBeDisabled();
  expect(importCalls).toBe(0);
  const download = page.waitForEvent('download');
  await page.getByTestId('button-download-alta-fms-audit').click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  expect(csv).toContain('Possible approved invoices');
  expect(csv).toContain('Vendor A');
  expect(csv).toContain('Vendor B');
  expect(csv).not.toContain('private-invoice-a');
  expect(csv).not.toContain('private-invoice-b');
  await page.getByTestId('radio-alta-fms-audit-invoice-2-1').check();
  await expect(page.getByTestId('button-confirm-alta-fms-import')).toBeEnabled();
  await page.getByTestId('input-alta-fms-payments').setInputFiles(file);
  await expect.poll(() => auditCalls).toBe(2);
  await expect(page.getByTestId('radio-alta-fms-audit-invoice-2-0')).not.toBeChecked();
  await expect(page.getByTestId('radio-alta-fms-audit-invoice-2-1')).not.toBeChecked();
  await expect(page.getByTestId('input-alta-fms-audit-note-2')).toHaveValue('');
  await page.getByTestId('input-alta-fms-audit-note-2').fill('Confirmed with accounting');
  await page.getByTestId('input-alta-fms-audit-note-4').fill('Historical check, reviewed');
  await page.getByTestId('radio-alta-fms-audit-invoice-2-0').check();
  await page.getByTestId('button-confirm-alta-fms-import').click();
  await expect(page.getByTestId('text-alta-fms-imported')).toHaveText('1');
  expect(importCalls).toBe(1);
});