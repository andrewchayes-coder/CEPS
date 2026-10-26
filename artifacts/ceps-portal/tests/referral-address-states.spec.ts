import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const nonce = `referral-address-${Date.now()}`;
const clientUci = `${nonce}-uci`;
const vendorName = `${nonce} Vendor`;
let staff: { id: string; name: string; token: string };
let createdReferralId: string | undefined;

function database(source: string) {
  return execFileSync('pnpm', ['--filter', '@workspace/db', 'exec', 'tsx', '-e', source], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  });
}

test.beforeAll(() => {
  const output = database(`
    import { randomBytes } from 'node:crypto';
    import { db, pool, usersTable, sessionsTable } from './src/index.ts';
    (async () => {
      const name = ${JSON.stringify(nonce)} + ' staff';
      const token = randomBytes(32).toString('hex');
      const [user] = await db.insert(usersTable).values({
        name, email: ${JSON.stringify(nonce)} + '@example.test', role: 'staff'
      }).returning();
      await db.insert(sessionsTable).values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) });
      console.log('REFERRAL_FIXTURE=' + JSON.stringify({ id: user.id, name, token }));
      await pool.end();
    })().catch(e => { console.error(e); process.exit(1); });
  `);
  staff = JSON.parse(output.split('\n').find(line => line.startsWith('REFERRAL_FIXTURE='))!.slice(17));
});

test.afterAll(() => {
  if (!staff) return;
  database(`
    import { db, pool, usersTable, sessionsTable, clientsTable, vendorsTable, referralsTable, auditLogTable } from './src/index.ts';
    import { eq } from 'drizzle-orm';
    (async () => {
      await db.transaction(async tx => {
        const [client] = await tx.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.uciNumber, ${JSON.stringify(clientUci)}));
        const [vendor] = await tx.select({ id: vendorsTable.id }).from(vendorsTable).where(eq(vendorsTable.name, ${JSON.stringify(vendorName)}));
        if (client) await tx.delete(referralsTable).where(eq(referralsTable.clientId, client.id));
        await tx.delete(auditLogTable).where(eq(auditLogTable.userId, ${JSON.stringify(staff.id)}));
        if (client) await tx.delete(clientsTable).where(eq(clientsTable.id, client.id));
        if (vendor) await tx.delete(vendorsTable).where(eq(vendorsTable.id, vendor.id));
        await tx.delete(sessionsTable).where(eq(sessionsTable.userId, ${JSON.stringify(staff.id)}));
        await tx.delete(usersTable).where(eq(usersTable.id, ${JSON.stringify(staff.id)}));
      });
      await pool.end();
    })().catch(e => { console.error(e); process.exit(1); });
  `);
});

async function signedIn(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL, acceptDownloads: true });
  await context.addCookies([{ name: 'ceps_session', value: staff.token, url: baseURL }]);
  const page = await context.newPage();
  // The isolated Vite 4178 server needs API traffic forwarded to the live API,
  // just as in messaging.spec.ts; it otherwise answers API paths with app HTML.
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://localhost:80${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  return { page, context };
}

async function chooseState(page: Page, field: string, code: string, label: string) {
  await page.getByTestId(field).click();
  await page.getByTestId(`${field}-search`).fill(code);
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(page.getByTestId(field)).toContainText(label);
}

test('new referral preserves separate address states in storage, detail API, and confirmation PDF', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { page, context } = await signedIn(browser, baseURL!);
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));
  let referralId: string | undefined;
  try {
    await page.goto('/referrals/new');
    await page.getByLabel('Coordinator Name').fill('Regression Coordinator');
    await page.getByLabel('Email Address').fill('referral-coordinator@example.test');
    await page.getByLabel('Direct Phone Number').fill('5551234567');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Vendor Details', { exact: true })).toBeVisible();

    await expect(page.getByTestId('vendorServiceState')).toContainText('CA');
    await page.getByLabel('Vendor / Business Name').fill(vendorName);
    await page.getByLabel('Vendor Email').fill(`${nonce}@vendor.example.test`);
    await page.getByLabel('Vendor Phone').fill('5559876543');
    await page.getByPlaceholder('Street Address').fill('500 Service Ave');
    await page.getByPlaceholder('City').first().fill('San Juan');
    await page.getByPlaceholder('ZIP Code').first().fill('00901');
    await chooseState(page, 'vendorServiceState', 'PR', 'PR - Puerto Rico');
    await page.getByRole('radio', { name: 'Yes', exact: true }).click();
    await expect(page.getByTestId('vendorBillingState')).toContainText('CA');
    await page.getByPlaceholder('Billing Street Address').fill('10 Billing St');
    await chooseState(page, 'vendorBillingState', 'NV', 'NV - Nevada');

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Billing city is required', { exact: true })).toBeVisible();
    await expect(page.getByText('Billing ZIP is required', { exact: true })).toBeVisible();
    await expect(page.getByText('Billing street is required', { exact: true })).toHaveCount(0);
    await page.getByPlaceholder('City').nth(1).fill('Reno');
    await page.getByPlaceholder('ZIP Code').nth(1).fill('89501');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Activity Information', { exact: true })).toBeVisible();

    await page.getByLabel('Description of Activity').fill('Weekly arts instruction');
    await page.getByLabel('Service start date').fill('2026-10-01');
    await page.getByLabel('Service end date').fill('2027-05-01');
    await page.getByLabel('Monthly authorization amount').fill('123.45');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Participant Information', { exact: true })).toBeVisible();
    await expect(page.getByTestId('contactState')).toContainText('CA');
    await page.getByLabel('First Name').fill('Referral Regression');
    await page.getByLabel('Last Name').fill(nonce);
    await page.getByLabel('Date of Birth').fill('2000-01-01');
    await page.getByLabel('UCI Number').fill(clientUci);
    await page.getByLabel('Email Address').fill(`${nonce}@participant.example.test`);
    await page.getByLabel('Phone Number').fill('5555550199');
    await page.getByPlaceholder('Street Address').fill('200 Main St');
    await page.getByPlaceholder('City').fill('Portland');
    await page.getByPlaceholder('ZIP').fill('97201');
    await chooseState(page, 'contactState', 'OR', 'OR - Oregon');
    await page.getByTestId('select-preferred-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Supporting Documents', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Review & Submit', { exact: true })).toBeVisible();
    const createResponse = page.waitForResponse(response =>
      response.url().includes('/api/referrals') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Submit Referral', exact: true }).click();
    const created = await createResponse;
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    referralId = createdBody.id;
    createdReferralId = referralId;
    expect(referralId).toBeTruthy();
    await expect(page.getByText('Referral submitted', { exact: true })).toBeVisible();

    const dbOutput = database(`
      import { db, pool, clientsTable, vendorsTable, referralsTable } from './src/index.ts';
      import { eq } from 'drizzle-orm';
      (async () => {
        const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, ${JSON.stringify(clientUci)}));
        const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.name, ${JSON.stringify(vendorName)}));
        const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, ${JSON.stringify(referralId)}));
        console.log('REFERRAL_RESULT=' + JSON.stringify({ client, vendor, referral }));
        await pool.end();
      })().catch(e => { console.error(e); process.exit(1); });
    `);
    const persisted = JSON.parse(dbOutput.split('\n').find(line => line.startsWith('REFERRAL_RESULT='))!.slice(16));
    expect(persisted.vendor.billingAddress).toMatch(/NV 89501$/);
    expect(persisted.vendor.serviceAddress).toContain('PR');
    expect(persisted.client.address).toContain('OR, 97201');
    expect(persisted.referral.intakeFields.vendorServiceState).toBe('PR');
    expect(persisted.referral.intakeFields.vendorBillingState).toBe('NV');
    expect(persisted.referral.intakeFields.contactState).toBe('OR');

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('button-download-confirmation').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^ceps-referral-confirmation-.*\.pdf$/);
    const pdfPath = await download.path();
    expect(pdfPath).toBeTruthy();
    const pdfText = execFileSync('pdftotext', [pdfPath!, '-'], { encoding: 'utf8' });
    expect(pdfText).toMatch(/Billing state\s*:?\s*NV/i);
    expect(pdfText).toMatch(/Mailing state\s*:?\s*OR/i);

    const detailResponsePromise = page.waitForResponse(response =>
      response.url().includes(`/api/referrals/${referralId}`) && response.request().method() === 'GET');
    await page.goto(`/referrals/${referralId}`);
    const detailResponse = await detailResponsePromise;
    expect(detailResponse.status()).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.intakeFields.vendorServiceState).toBe('PR');
    expect(detail.intakeFields.vendorBillingState).toBe('NV');
    expect(detail.intakeFields.contactState).toBe('OR');
    await page.reload();
    const reloaded = await page.evaluate(async endpoint => (await fetch(endpoint)).json(), `/api/referrals/${referralId}`);
    expect(reloaded.intakeFields.vendorServiceState).toBe('PR');
    expect(reloaded.intakeFields.vendorBillingState).toBe('NV');
    expect(reloaded.intakeFields.contactState).toBe('OR');
    // React's development-only lifecycle diagnostic is not a failed request or
    // uncaught exception; retain strict checks for every other console error.
    expect(consoleErrors.filter(message =>
      !message.startsWith('flushSync was called from inside a lifecycle method.')
    )).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await context.close();
  }
});
