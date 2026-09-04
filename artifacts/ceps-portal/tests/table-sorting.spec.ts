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

async function mockSession(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: staffUser }),
  );
}

test('server-sorted clients reset pagination and expose accessible sort state', async ({ page }) => {
  const requests: URL[] = [];

  await mockSession(page);
  await page.route('**/api/clients?*', (route) => {
    const url = new URL(route.request().url());
    requests.push(url);

    const offset = Number(url.searchParams.get('offset') ?? 0);
    const direction = url.searchParams.get('sortDirection');
    const firstName =
      direction === 'asc' ? 'Alpha' : direction === 'desc' ? 'Zulu' : `Page ${offset / 50 + 1}`;

    return route.fulfill({
      json: {
        total: 100,
        items: Array.from({ length: 50 }, (_, index) => ({
          id: `client-${offset + index}`,
          firstName: index === 0 ? firstName : `Client ${offset + index}`,
          lastName: 'Person',
          uciNumber: `UCI-${offset + index}`,
          dateOfBirth: '1990-01-01',
          assignedCoordinatorName: null,
          status: 'active',
        })),
      },
    });
  });

  await page.goto('/clients');
  await expect(page.getByText('Page 1 of 2')).toBeVisible();

  const nameHeader = page.getByRole('columnheader', { name: /Sort by Name/ });
  const uciHeader = page.getByRole('columnheader', { name: /Sort by UCI Number/ });
  const actionsHeader = page.getByRole('columnheader', { name: 'Actions' });

  await expect(nameHeader).not.toHaveAttribute('aria-sort');
  await expect(uciHeader).not.toHaveAttribute('aria-sort');
  await expect(actionsHeader).not.toHaveAttribute('aria-sort');
  await expect(actionsHeader.getByRole('button')).toHaveCount(0);

  await page.getByTestId('button-clients-next').click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect.poll(() => requests.at(-1)?.searchParams.get('offset')).toBe('50');

  await nameHeader.getByRole('button').click();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(uciHeader).not.toHaveAttribute('aria-sort');
  await expect.poll(() => {
    const request = requests.at(-1);
    return {
      offset: request?.searchParams.get('offset'),
      sortBy: request?.searchParams.get('sortBy'),
      direction: request?.searchParams.get('sortDirection'),
    };
  }).toEqual({ offset: '0', sortBy: 'name', direction: 'asc' });
  await expect(page.locator('tbody tr').first().getByRole('cell').first()).toContainText('Alpha');

  await nameHeader.getByRole('button').click();
  await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => {
    const request = requests.at(-1);
    return {
      offset: request?.searchParams.get('offset'),
      sortBy: request?.searchParams.get('sortBy'),
      direction: request?.searchParams.get('sortDirection'),
    };
  }).toEqual({ offset: '0', sortBy: 'name', direction: 'desc' });
  await expect(page.locator('tbody tr').first().getByRole('cell').first()).toContainText('Zulu');
});

test('locally sorted users use typed boolean order in both directions', async ({ page }) => {
  await mockSession(page);
  await page.route('**/api/users', (route) =>
    route.fulfill({
      json: [
        { ...staffUser, id: 'user-z', name: 'Zulu Active', active: true },
        {
          ...staffUser,
          id: 'user-a',
          name: 'Alpha Inactive',
          email: 'alpha@example.test',
          active: false,
          lastLogin: null,
        },
      ],
    }),
  );

  await page.goto('/admin/users');

  const nameHeader = page.getByRole('columnheader', { name: /Sort by Name/ });
  const statusHeader = page.getByRole('columnheader', { name: /Sort by Status/ });
  const actionsHeader = page.getByRole('columnheader', { name: 'Actions' });
  const firstNameCell = () => page.locator('tbody tr').first().getByRole('cell').first();

  await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(statusHeader).not.toHaveAttribute('aria-sort');
  await expect(firstNameCell()).toHaveText('Alpha Inactive');
  await expect(actionsHeader).not.toHaveAttribute('aria-sort');
  await expect(actionsHeader.getByRole('button')).toHaveCount(0);

  await statusHeader.getByRole('button').click();
  await expect(statusHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(nameHeader).not.toHaveAttribute('aria-sort');
  await expect(firstNameCell()).toHaveText('Alpha Inactive');

  await statusHeader.getByRole('button').click();
  await expect(statusHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(firstNameCell()).toHaveText('Zulu Active');
});