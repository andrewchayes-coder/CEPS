import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-amend-pos',
  name: 'Amend POS Staff',
  email: 'amend-pos@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

const vendorUser = {
  id: 'vendor-user',
  name: 'Vendor User',
  email: 'vendor@example.test',
  phone: null,
  role: 'vendor',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
  vendorId: 'vendor-1',
};

const mockClient = {
  id: 'client-1',
  firstName: 'Test',
  lastName: 'Client',
  uciNumber: 'UCI-123',
  dateOfBirth: '1990-01-01',
  status: 'active',
};

const existingAuth = {
  id: 'auth-existing',
  clientId: mockClient.id,
  authNumber: 'POS-EXACT-1',
  serviceCode: '459',
  paymentType: 'direct_payment',
  servicePeriodStart: '2026-01-01T00:00:00.000Z',
  servicePeriodEnd: '2026-12-31T00:00:00.000Z',
  monthlyAmount: '100.00',
  maxPeriodAmount: '1200.00',
  status: 'active',
  posNotes: 'Old notes'
};

async function mockCommon(page: Page, user = staffUser) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { total: 1, items: [mockClient] } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { total: 0, items: [] } }));
}

test.describe('POS Amendment and Cancellation', () => {

  test('New pair (lookup miss) -> creates new authorization', async ({ page }) => {
    await mockCommon(page);

    let lookupCalls = 0;
    await page.route('**/api/authorizations/lookup?*', async (route) => {
      lookupCalls++;
      await route.fulfill({ json: { exists: false, authorization: null } });
    });

    const createBodies: Record<string, unknown>[] = [];
    await page.route('**/api/authorizations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      createBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { saved: true, authorization: { id: 'new-auth', ...createBodies[0] } } });
    });

    await page.goto('/authorizations/new');
    
    // Manual client + auth lookup
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-NEW-1');
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('500');
    await page.getByLabel('POS Notes').fill('Create notes');

    // It should trigger lookup but remain in creation mode
    await expect.poll(() => lookupCalls).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: 'Manual POS Entry' })).toBeVisible();
    
    await page.getByRole('button', { name: 'Save Authorization' }).click();
    
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).toMatchObject({
      authNumber: 'POS-NEW-1',
      posNotes: 'Create notes'
    });
  });

  test('Existing pair -> enters amendment mode, requires confirmation, exact payload', async ({ page }) => {
    await mockCommon(page);

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: true, authorization: existingAuth } });
    });

    const createBodies: Record<string, unknown>[] = [];
    await page.route('**/api/authorizations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      createBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { saved: true, authorization: { id: 'new-auth', ...createBodies[0] } } });
    });

    const amendBodies: Record<string, unknown>[] = [];
    await page.route(`**/api/authorizations/${existingAuth.id}/amend`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      amendBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { saved: true, authorization: { ...existingAuth, ...amendBodies[0] } } });
    });

    await page.goto('/authorizations/new');
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-EXACT-1');
    
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('1500');
    await page.getByLabel('POS Notes').fill('New amended notes');

    // Check UI switches to Amend mode
    await expect(page.getByRole('heading', { name: 'Amend Authorization' })).toBeVisible();
    await expect(page.getByText('Amendment Summary')).toBeVisible();
    
    // Check confirmation gating
    const amendBtn = page.getByRole('button', { name: 'Apply Amendment' });
    await expect(amendBtn).toBeDisabled();

    await page.getByLabel('Confirm Amendment').check();
    await expect(amendBtn).toBeEnabled();

    await amendBtn.click();
    
    // Existing pair never create
    expect(createBodies).toHaveLength(0);
    
    // Exact amend payload includes dates/amounts/posNotes/confirmed, but NOT posPdfUrl when manually amended
    expect(amendBodies).toHaveLength(1);
    expect(amendBodies[0]).not.toHaveProperty('posPdfUrl');
    expect(amendBodies[0]).toMatchObject({
      servicePeriodStart: '2026-02-01',
      servicePeriodEnd: '2026-07-31',
      maxPeriodAmount: '1500',
      posNotes: 'New amended notes',
      confirmed: true
    });
  });

  test('Uploaded amendment payload includes latest URL and diff UI shows replacement', async ({ page }) => {
    await mockCommon(page);

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: true, authorization: existingAuth } });
    });
    
    await page.route('**/api/storage/uploads/request-url', async (route) => {
      await route.fulfill({
        json: {
          uploadURL: `/upload/amend`,
          objectPath: `/objects/uploads/amend.pdf`,
        },
      });
    });

    await page.route('**/upload/amend', async (route) => {
      await route.fulfill({ status: 200, body: '' });
    });

    await page.route('**/api/authorizations/parse-pdf', async (route) => {
      await route.fulfill({ json: { success: true, error: null, fields: { authNumber: 'POS-EXACT-1', clientId: 'client-1' } } });
    });

    await page.route('**/api/unmatched-pos/match', async (route) => {
      await route.fulfill({ json: { method: 'uci', client: mockClient } });
    });

    const amendBodies: Record<string, unknown>[] = [];
    await page.route(`**/api/authorizations/${existingAuth.id}/amend`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      amendBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { saved: true, authorization: { ...existingAuth, ...amendBodies[0] } } });
    });

    await page.goto('/authorizations/new');
    
    // Now upload a file first
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'amend.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 amend mock'),
    });

    // Wait for the parse & lookup hit to switch us to amend mode
    await expect(page.getByRole('heading', { name: 'Amend Authorization' })).toBeVisible();

    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('1500');

    // Wait for the diff to show Replaced
    await expect(page.getByText('New PDF uploaded').last()).toBeVisible();
    await expect(page.getByText('Changed').last()).toBeVisible();

    await page.getByLabel('Confirm Amendment').check();
    
    const amendPromise = page.waitForResponse(r => r.url().includes('/amend') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Apply Amendment' }).click();
    await amendPromise;

    expect(amendBodies).toHaveLength(1);
    expect(amendBodies[0].posPdfUrl).toBe('/objects/uploads/amend.pdf');
  });

  test('Confirming then changing a proposed value disables submit until reconfirmed', async ({ page }) => {
    await mockCommon(page);

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: true, authorization: existingAuth } });
    });

    await page.goto('/authorizations/new');
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-EXACT-1');
    
    // UI switches to Amend mode
    await expect(page.getByRole('heading', { name: 'Amend Authorization' })).toBeVisible();
    
    // Check confirmation gating
    const amendBtn = page.getByRole('button', { name: 'Apply Amendment' });
    const confirmCheckbox = page.getByLabel('Confirm Amendment');

    await expect(amendBtn).toBeDisabled();
    
    await confirmCheckbox.check();
    await expect(amendBtn).toBeEnabled();

    // Change a proposed value
    await page.getByLabel('Max Period Amount').fill('1700');
    
    // Submit should be disabled again and checkbox unchecked because fingerprint changed
    await expect(amendBtn).toBeDisabled();
    await expect(confirmCheckbox).not.toBeChecked();

    // Reconfirm
    await confirmCheckbox.check();
    await expect(amendBtn).toBeEnabled();
  });

  test('Lookup resolves after pair changed to B and cannot enable amend A (delayed lookup test)', async ({ page }) => {
    await mockCommon(page);

    let resolveLookupA: (value: any) => void;
    let resolveLookupB: (value: any) => void;

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      const authNumber = new URL(route.request().url()).searchParams.get('authNumber');
      if (authNumber === 'POS-A') {
        await new Promise((r) => { resolveLookupA = r; });
        await route.fulfill({ json: { exists: true, authorization: { ...existingAuth, authNumber: 'POS-A' } } });
      } else if (authNumber === 'POS-B') {
        await new Promise((r) => { resolveLookupB = r; });
        await route.fulfill({ json: { exists: false, authorization: null } });
      } else {
        await route.fallback();
      }
    });

    await page.goto('/authorizations/new');
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    
    // Type POS-A (triggering lookup A)
    await page.getByLabel('POS Number').fill('POS-A');
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled(); // Blocked while syncing/fetching

    // Wait for the A query to start by ensuring resolveLookupA is defined
    await expect.poll(() => resolveLookupA).toBeDefined();

    // Change to POS-B before A resolves
    await page.getByLabel('POS Number').fill('POS-B');
    await expect.poll(() => resolveLookupB).toBeDefined();

    // Resolve A now
    resolveLookupA({});
    
    // A resolves, but current pair is B. So it should NOT switch to Amend mode.
    await expect(page.getByRole('heading', { name: 'Manual POS Entry' })).toBeVisible();

    // Resolve B now (miss)
    resolveLookupB({});

    // Now it should be in Create mode and not blocked
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('500');
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeEnabled();
  });

  test('Selecting replacement files with out-of-order upload completion uses only latest PDF and blocks submit while pending', async ({ page }) => {
    await mockCommon(page);

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: false, authorization: null } });
    });

    let resolveUpload1: () => void;
    let resolveUpload2: () => void;
    
    await page.route('**/api/storage/uploads/request-url', async (route) => {
      const body = route.request().postDataJSON();
      const slug = body.name === 'upload1.pdf' ? 'upload1' : 'upload2';
      await route.fulfill({
        json: {
          uploadURL: `/upload/${slug}`,
          objectPath: `/objects/uploads/${slug}.pdf`,
        },
      });
    });

    await page.route('**/upload/upload1', async (route) => {
      await new Promise<void>((r) => { resolveUpload1 = r; });
      await route.fulfill({ status: 200, body: '' });
    });

    await page.route('**/upload/upload2', async (route) => {
      await new Promise<void>((r) => { resolveUpload2 = r; });
      await route.fulfill({ status: 200, body: '' });
    });

    // Mock parse to return immediately so it doesn't block
    await page.route('**/api/authorizations/parse-pdf', async (route) => {
      await route.fulfill({ json: { success: true, error: null, fields: {} } });
    });

    await page.goto('/authorizations/new');
    
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-NEW-2');
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('500');

    // Fill form so submit would be enabled
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeEnabled();

    // Start Upload 1
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'upload1.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock'),
    });

    // Submit is blocked while pending
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled();
    await expect.poll(() => resolveUpload1).toBeDefined();

    // Start Upload 2 BEFORE Upload 1 finishes
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'upload2.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock 2'),
    });

    await expect.poll(() => resolveUpload2).toBeDefined();
    
    // Submit is still blocked
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled();

    // Resolve Upload 1 (the older one)
    resolveUpload1({});
    
    // Submit is STILL blocked because active upload (2) is pending
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled();

    // Resolve Upload 2
    resolveUpload2({});

    // Now fill form (because file upload resets it!)
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-NEW-2');
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('500');

    // Submit is now enabled
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeEnabled();

    const createBodies: Record<string, unknown>[] = [];
    await page.route('**/api/authorizations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      createBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { saved: true, authorization: { id: 'new-auth', ...createBodies[0] } } });
    });

    const createPromise = page.waitForResponse(r => r.url().includes('/api/authorizations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save Authorization' }).click();
    await createPromise;
    
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0].posPdfUrl).toBe('/objects/uploads/upload2.pdf'); // Must use the latest objectPath
  });

  test('Stale A failure cannot unblock pending B', async ({ page }) => {
    await mockCommon(page);

    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: false, authorization: null } });
    });

    let resolveUpload1: (response: { status: number }) => void;
    let resolveUpload2: (response: { status: number }) => void;
    
    await page.route('**/api/storage/uploads/request-url', async (route) => {
      const body = route.request().postDataJSON();
      const slug = body.name === 'upload1.pdf' ? 'upload1' : 'upload2';
      await route.fulfill({
        json: {
          uploadURL: `/upload/${slug}`,
          objectPath: `/objects/uploads/${slug}.pdf`,
        },
      });
    });

    await page.route('**/upload/upload1', async (route) => {
      await new Promise<void>((r) => { 
        resolveUpload1 = (res) => { r(); route.fulfill(res).catch(console.error); }; 
      });
    });

    await page.route('**/upload/upload2', async (route) => {
      await new Promise<void>((r) => { 
        resolveUpload2 = (res) => { r(); route.fulfill(res).catch(console.error); }; 
      });
    });

    // Mock parse to return immediately so it doesn't block
    await page.route('**/api/authorizations/parse-pdf', async (route) => {
      await route.fulfill({ json: { success: true, error: null, fields: {} } });
    });

    await page.goto('/authorizations/new');
    
    // Start Upload 1
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'upload1.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock'),
    });

    // Submit is blocked while pending
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled();
    await expect.poll(() => resolveUpload1).toBeDefined();

    // Start Upload 2 BEFORE Upload 1 finishes
    await page.getByTestId('input-file-upload').setInputFiles({
      name: 'upload2.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock 2'),
    });

    await expect.poll(() => resolveUpload2).toBeDefined();
    
    // Submit is still blocked
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled();

    // Resolve Upload 1 (the older one) as FAILURE
    resolveUpload1({ status: 500 });
    
    // Submit is STILL blocked because active upload (2) is pending
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeDisabled();

    // Resolve Upload 2 as SUCCESS
    resolveUpload2({ status: 200 });

    // Now fill form (because file upload resets it!)
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-NEW-2');
    await page.getByLabel('Period Start Date').fill('2026-02-01');
    await page.getByLabel('Period End Date').fill('2026-07-31');
    await page.getByLabel('Max Period Amount').fill('500');

    // Submit is now enabled
    await expect(page.getByRole('button', { name: 'Save Authorization' })).toBeEnabled();
  });

  test('Soft-deleted / null lookup create behavior allows creation', async ({ page }) => {
    await mockCommon(page);

    // Mock a lookup hit where authorization is null (e.g. soft-deleted)
    await page.route('**/api/authorizations/lookup?*', async (route) => {
      await route.fulfill({ json: { exists: true, authorization: null } });
    });

    await page.goto('/authorizations/new');
    await page.getByTestId('select-auth-client').click();
    await page.getByTestId('select-auth-client-option-client-1').click();
    await page.getByLabel('POS Number').fill('POS-SOFT-DEL-1');
    
    // Should still be in Manual POS Entry (creation) mode, not amend mode
    await expect(page.getByRole('heading', { name: 'Manual POS Entry' })).toBeVisible();
  });

  test('Cancel authorization requires reason and sends it', async ({ page }) => {
    await mockCommon(page);

    await page.route(`**/api/authorizations/${existingAuth.id}`, async (route) => {
      await route.fulfill({ json: existingAuth });
    });
    await page.route(`**/api/authorizations/${existingAuth.id}/versions`, async (route) => {
      await route.fulfill({ json: [] });
    });

    const cancelBodies: Record<string, unknown>[] = [];
    await page.route(`**/api/authorizations/${existingAuth.id}/cancel`, async (route) => {
      cancelBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { saved: true, authorization: { ...existingAuth, status: 'canceled' } } });
    });

    await page.goto(`/authorizations/${existingAuth.id}`);
    
    await page.getByTestId('button-cancel-authorization').click();
    await expect(page.getByRole('dialog', { name: 'Cancel Authorization' })).toBeVisible();

    const confirmBtn = page.getByTestId('button-confirm-cancel');
    await expect(confirmBtn).toBeDisabled();

    await page.getByTestId('input-cancel-reason').fill('Voided by Alta');
    await expect(confirmBtn).toBeEnabled();

    await confirmBtn.click();
    expect(cancelBodies).toHaveLength(1);
    expect(cancelBodies[0]).toEqual({ reason: 'Voided by Alta' });
  });

  test('Nonstaff cancel controls hidden', async ({ page }) => {
    // Login as a vendor user
    await mockCommon(page, vendorUser);
    
    await page.route(`**/api/authorizations/${existingAuth.id}`, async (route) => {
      await route.fulfill({ json: existingAuth });
    });
    
    await page.goto(`/authorizations/${existingAuth.id}`);
    
    // Wait for the heading to ensure the page has loaded
    await expect(page.getByRole('heading', { name: 'Authorization (POS)' })).toBeVisible();
    
    // The cancel button should not exist
    await expect(page.getByTestId('button-cancel-authorization')).toHaveCount(0);
    // Edit and Delete should also not exist for nonstaff
    await expect(page.getByTestId('button-edit-authorization')).toHaveCount(0);
    await expect(page.getByTestId('button-delete-authorization')).toHaveCount(0);
  });

});
