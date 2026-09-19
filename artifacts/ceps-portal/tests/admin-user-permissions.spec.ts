import { expect, test } from '@playwright/test';

const user = { id: 'admin', name: 'Admin', email: 'admin@test', role: 'staff', active: true, permissions: ['invoice_approve'] };

async function setup(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/users*', (route) => route.fulfill({ json: [{ ...user }] }));
}

test('create permission checkboxes have stable ids and default all', async ({ page }) => {
  await setup(page);
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Add User' }).click();
  for (const permission of ['invoice_log_validate', 'invoice_approve', 'check_writing']) {
    await expect(page.getByTestId(`checkbox-create-permission-${permission}`)).toBeChecked();
  }
});

test('edit permission checkboxes initialize from current subset', async ({ page }) => {
  await setup(page);
  await page.goto('/admin/users');
  await page.getByTestId('button-edit-user-admin').click();
  await expect(page.getByTestId('checkbox-edit-permission-invoice_approve')).toBeChecked();
  await expect(page.getByTestId('checkbox-edit-permission-invoice_log_validate')).not.toBeChecked();
});

test('create submits exact subset and explicit empty permissions, and edit replaces permissions', async ({ page }) => {
  await setup(page);
  const creates: any[] = [];
  const patches: any[] = [];
  await page.route('**/api/users', async (route) => {
    if (route.request().method() === 'POST') {
      creates.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { ...user, id: 'new-user', permissions: creates.at(-1).permissions } });
    } else await route.fulfill({ json: [{ ...user }] });
  });
  await page.route('**/api/users/admin', async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...user, permissions: patches.at(-1).permissions } });
    } else await route.fulfill({ json: [{ ...user }] });
  });
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Add User' }).click();
  await page.getByLabel('Full Name').fill('Subset User');
  await page.getByRole('textbox', { name: 'Email' }).fill('subset@example.test');
  await page.getByLabel('Initial Password').fill('password123');
  await page.getByTestId('checkbox-create-permission-invoice_log_validate').uncheck();
  await page.getByTestId('checkbox-create-permission-check_writing').uncheck();
  await page.getByRole('button', { name: 'Create User' }).click();
  await expect.poll(() => creates.length).toBe(1);
  expect(creates[0].permissions).toEqual(['invoice_approve']);

  await page.getByTestId('button-edit-user-admin').click();
  await page.getByTestId('checkbox-edit-permission-invoice_approve').uncheck();
  await page.getByTestId('checkbox-edit-permission-check_writing').check();
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0].permissions).toEqual(['check_writing']);
});

test('create submits explicit empty permissions', async ({ page }) => {
  await setup(page);
  let payload: any;
  await page.route('**/api/users', async (route) => {
    if (route.request().method() === 'POST') {
      payload = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { ...user, id: 'none-user', permissions: [] } });
    } else await route.fulfill({ json: [{ ...user }] });
  });
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Add User' }).click();
  await page.getByLabel('Full Name').fill('No Workflow Access');
  await page.getByRole('textbox', { name: 'Email' }).fill('none@example.test');
  await page.getByLabel('Initial Password').fill('password123');
  for (const permission of ['invoice_log_validate', 'invoice_approve', 'check_writing']) {
    await page.getByTestId(`checkbox-create-permission-${permission}`).uncheck();
  }
  await page.getByRole('button', { name: 'Create User' }).click();
  await expect.poll(() => payload).not.toBeUndefined();
  expect(payload.permissions).toEqual([]);
});