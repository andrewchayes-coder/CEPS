import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-upload-race',
  name: 'Upload Race Staff',
  email: 'upload-race@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

async function mockCommon(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { total: 1, items: [{ id: 'client-1', firstName: 'A', lastName: 'Client', uciNumber: '123' }] } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
}

test.describe('File Upload Race Conditions', () => {

  test('Select B before A finishes, A completes before B: queue fires only for B after B finishes', async ({ page }) => {
    await mockCommon(page);

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: false, authorization: null } });
    });

    let resolveUploadA: () => void;
    let resolveUploadB: () => void;
    let resolveParseA: () => void;
    let resolveParseB: () => void;
    
    await page.route('**/api/storage/uploads/request-url', async (route) => {
      const body = route.request().postDataJSON();
      const slug = body.name === 'uploadA.pdf' ? 'uploadA' : 'uploadB';
      await route.fulfill({
        json: {
          uploadURL: `/upload/${slug}`,
          objectPath: `/objects/uploads/${slug}.pdf`,
        },
      });
    });

    await page.route('**/upload/uploadA', async (route) => {
      await new Promise<void>((r) => { resolveUploadA = r; });
      await route.fulfill({ status: 200, body: '' });
    });

    await page.route('**/upload/uploadB', async (route) => {
      await new Promise<void>((r) => { resolveUploadB = r; });
      await route.fulfill({ status: 200, body: '' });
    });

    await page.route('**/api/authorizations/parse-pdf', async (route) => {
      const body = route.request().postDataJSON();
      if (body.fileName === 'uploadA.pdf') {
        await new Promise<void>((r) => { resolveParseA = r; });
        await route.fulfill({ json: { success: true, error: null, fields: { clientName: 'A Name' } } });
      } else {
        await new Promise<void>((r) => { resolveParseB = r; });
        await route.fulfill({ json: { success: true, error: null, fields: { clientName: 'B Name' } } });
      }
    });

    await page.route('**/api/unmatched-pos/match', async (route) => {
      await route.fulfill({ json: { method: 'none', client: null } });
    });

    const queueBodies: Record<string, unknown>[] = [];
    await page.route('**/api/unmatched-pos', async (route) => {
      queueBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 201, json: { id: 'unmatched-1' } });
    });

    await page.goto('/authorizations/new');

    // Start Upload A
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'uploadA.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock A'),
    });
    
    await expect.poll(() => resolveUploadA).toBeDefined();
    await expect.poll(() => resolveParseA).toBeDefined();
    
    // Start Upload B before A finishes
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'uploadB.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock B'),
    });

    await expect.poll(() => resolveUploadB).toBeDefined();
    await expect.poll(() => resolveParseB).toBeDefined();

    // Now let B's parse finish
    resolveParseB({});
    
    // Let A's parse finish
    resolveParseA({});

    // Let A's upload finish
    resolveUploadA({});
    
    // Expect no queueing yet because B is the active file and B's upload is still pending
    // Also, A's upload finishing should NOT trigger queueing because A is no longer active
    // Wait a brief moment to ensure no stray network calls
    await page.waitForTimeout(500);
    expect(queueBodies).toHaveLength(0);

    // Let B's upload finish
    resolveUploadB({});

    // Now B's queueing should fire!
    await expect.poll(() => queueBodies.length).toBe(1);
    expect(queueBodies[0].posPdfUrl).toBe('/objects/uploads/uploadB.pdf');
    expect(queueBodies[0].clientName).toBe('B Name');
  });

  test('Select A, select B, B upload fails: create/amend is blocked or PDF is omitted, A URL is never sent', async ({ page }) => {
    await mockCommon(page);

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: false, authorization: null } });
    });

    let resolveUploadA: () => void;
    let resolveUploadB: (res: any) => void;
    
    await page.route('**/api/storage/uploads/request-url', async (route) => {
      const body = route.request().postDataJSON();
      const slug = body.name === 'uploadA.pdf' ? 'uploadA' : 'uploadB';
      await route.fulfill({
        json: {
          uploadURL: `/upload/${slug}`,
          objectPath: `/objects/uploads/${slug}.pdf`,
        },
      });
    });

    await page.route('**/upload/uploadA', async (route) => {
      await new Promise<void>((r) => { resolveUploadA = r; });
      await route.fulfill({ status: 200, body: '' });
    });

    await page.route('**/upload/uploadB', async (route) => {
      await new Promise<void>((r) => { 
        resolveUploadB = (res) => { r(); route.fulfill(res).catch(console.error); }; 
      });
    });

    await page.route('**/api/authorizations/parse-pdf', async (route) => {
      await route.fulfill({ json: { success: true, error: null, fields: {} } });
    });

    await page.goto('/authorizations/new');
    
    await page.getByLabel('POS Number').fill('POS-NEW-FAIL');
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('500');

    // Start Upload A
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'uploadA.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock A'),
    });
    
    await expect.poll(() => resolveUploadA).toBeDefined();
    resolveUploadA({}); // A succeeds

    // Wait until A's URL is theoretically set and we could save
    // We can ensure A finishes its internal React updates
    await page.waitForTimeout(500);

    // But then immediately start Upload B
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'uploadB.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock B'),
    });

    await expect.poll(() => resolveUploadB).toBeDefined();

    // Now fail B
    resolveUploadB({ status: 500 });

    const createBodies: Record<string, unknown>[] = [];
    await page.route('**/api/authorizations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      createBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { saved: true, authorization: { id: 'new-auth', ...createBodies[0] } } });
    });

    // Make sure we select client manually since parse doesn't fill it
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-NEW-FAIL');
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('500');
    
    // We expect the form to re-enable because B's failure cleared activeUploadId
    // And posPdfUrl was set to undefined. Wait a tick for debounced lookup resolution:
    await page.waitForTimeout(1000);

    // B has failed, so the activeUploadId was set to null. isUploadPending is false.
    // The button must be enabled.
    await expect.poll(() => resolveUploadB).toBeDefined(); // (just to ensure it executed)
    
    // Playwright typing debounces can be tricky. We can explicitly await a tiny bit to ensure the sync Pair is over.
    await page.waitForTimeout(1000);
    
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeEnabled({ timeout: 10000 });
    const createPromise = page.waitForResponse(r => r.url().includes('/api/authorizations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save Authorization' }).click();
    await createPromise;
    
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0].posPdfUrl).toBeUndefined(); // A's URL must NOT be used because active file B failed. B's URL is null/undefined.
  });

});
