import { expect, test, type Page } from '@playwright/test';

const staffUser = {
  id: 'staff-1',
  name: 'Test Staff',
  email: 'staff@example.test',
  phone: null,
  role: 'staff',
  active: true,
  lastLogin: '2026-09-04T12:00:00.000Z',
};

type SearchScenario = {
  name: string;
  path: string;
  endpoint: string;
  input: RegExp;
  response: Record<string, unknown>;
};

const scenarios: SearchScenario[] = [
  {
    name: 'participants',
    path: '/clients',
    endpoint: '/api/clients',
    input: /Search by name or UCI/i,
    response: { items: [], total: 100 },
  },
  {
    name: 'vendors',
    path: '/vendors',
    endpoint: '/api/vendors',
    input: /Search by vendor name, email, or phone/i,
    response: { items: [], total: 100 },
  },
  {
    name: 'invoices',
    path: '/invoices',
    endpoint: '/api/invoices',
    input: /Search by vendor, participant, or auth/i,
    response: { items: [], total: 100 },
  },
  {
    name: 'authorizations',
    path: '/authorizations',
    endpoint: '/api/authorizations',
    input: /Search by Auth #, Participant, or Vendor/i,
    response: { items: [], total: 100 },
  },
  {
    name: 'payments',
    path: '/payments',
    endpoint: '/api/payments',
    input: /Search by check #, vendor, or participant/i,
    response: { items: [], total: 100 },
  },
  {
    name: 'referrals',
    path: '/referrals',
    endpoint: '/api/referrals',
    input: /Search participants or coordinators/i,
    response: { items: [], total: 100 },
  },
  {
    name: 'remittances',
    path: '/remittances',
    endpoint: '/api/remittances',
    input: /Search participant, reference, auth #, or batch/i,
    response: { items: [], total: 100 },
  },
  {
    name: 'audit log',
    path: '/audit-log',
    endpoint: '/api/audit-log',
    input: /Search users, actions, entities, or details/i,
    response: { entries: [], total: 100 },
  },
];

async function mockSharedApis(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: staffUser }));
  // The audit page loads the user filter independently of its audit entries.
  await page.route('**/api/users', (route) => route.fulfill({ json: [] }));
}

for (const scenario of scenarios) {
  test(`${scenario.name} broad search sends search and resets pagination`, async ({ page }) => {
    const requests: URL[] = [];
    await mockSharedApis(page);
    await page.route(`**${scenario.endpoint}?*`, (route) => {
      requests.push(new URL(route.request().url()));
      return route.fulfill({ json: scenario.response });
    });

    await page.goto(scenario.path);
    await expect(page.getByText('Page 1 of 2')).toBeVisible();

    const search = page.getByPlaceholder(scenario.input);
    await expect(search).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.poll(() => requests.some((request) => request.searchParams.get('offset') === '50')).toBe(true);

    await search.fill('b');
    await search.fill('br');
    await search.fill('broad-term');
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    await expect.poll(
      () => requests.filter((request) => request.searchParams.get('search') === 'broad-term').length,
      { timeout: 2_000 },
    ).toBe(1);
    await page.waitForTimeout(400);
    expect(requests.filter((request) => request.searchParams.get('search') === 'b')).toHaveLength(0);
    expect(requests.filter((request) => request.searchParams.get('search') === 'br')).toHaveLength(0);
    expect(requests.filter((request) => request.searchParams.get('search') === 'broad-term')).toHaveLength(1);
    expect(requests.at(-1)?.searchParams.get('offset')).toBe('0');
  });
}