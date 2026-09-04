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
  await page.route('**/api/payments/import', async (route) => {
    paymentImportRequests++;
    const body = await postBody(route.request());
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