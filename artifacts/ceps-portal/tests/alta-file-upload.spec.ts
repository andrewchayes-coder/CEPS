import { expect, test, type Page, type Request } from '@playwright/test';
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
          { rowNumber: 4, uciNumber: '0000000', outcome: 'errored', message: 'Row 4: malformed Check row.' },
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
        parsed: 1,
        imported: 0,
        errored: 1,
        autoMatched: 0,
        needsManualMatch: 0,
        skippedDuplicate: 0,
        headerError: null,
        parseProblems: [],
        results: [{
          rowNumber: 4,
          uciNumber: '0000000',
          outcome: 'errored',
          message: 'No participant found for synthetic UCI. Row not imported.',
        }],
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
  await expect(page.getByTestId('text-alta-imported-count')).toHaveText('0');
  await expect(page.getByTestId('text-alta-errored-count')).toHaveText('1');
  await expect(page.getByTestId('text-alta-automatched-count')).toHaveText('0');
  await expect(page.getByTestId('text-alta-needsmatch-count')).toHaveText('0');
  expect(remittanceImportRequests).toBe(1);

  // All write endpoints are intercepted above. The zero-import error result therefore
  // cannot insert a remittance, and this test creates no database or audit data to clean up.
});