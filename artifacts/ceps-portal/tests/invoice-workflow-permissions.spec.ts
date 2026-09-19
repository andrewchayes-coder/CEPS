import { expect, test } from '@playwright/test';

const invoice = {
  id: 'invoice-workflow-1', clientId: 'client-workflow', clientName: 'Pat Participant',
  vendorId: null, vendorName: null, amountRequested: '100.00', status: 'validated',
  submittedByRole: 'staff', submittedDate: '2026-01-01', serviceMonth: '2026-01',
  lineItems: [{ id: 'line-1', authorizationId: 'auth-1', authNumber: 'AUTH-1', serviceMonth: '2026-01', amount: '100.00' }],
};

async function mock(page: import('@playwright/test').Page, permissions: string[], detail = invoice) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { id: 'staff', name: 'Staff', email: 'staff@test', role: 'staff', active: true, permissions } }));
  await page.route('**/api/invoices/queues/ready-to-approve*', (route) => route.fulfill({ json: { items: [invoice], total: 1 } }));
  await page.route('**/api/invoices/queues/ready-for-check-writing*', (route) => route.fulfill({ json: { items: [{ ...invoice, status: 'approved' }], total: 1 } }));
  await page.route('**/api/invoices?*', (route) => route.fulfill({ json: { items: [invoice], total: 1 } }));
  await page.route('**/api/invoices/invoice-workflow-1', (route) => route.fulfill({ json: detail }));
  await page.route('**/api/clients?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
}

test('shows only queue tabs granted to the staff member and always retains all invoices', async ({ page }) => {
  await mock(page, ['invoice_approve']);
  await page.goto('/invoices');
  await expect(page.getByTestId('tab-invoices-all')).toBeVisible();
  await expect(page.getByTestId('tab-invoices-approve')).toBeVisible();
  await expect(page.getByTestId('tab-invoices-validate')).toHaveCount(0);
  await expect(page.getByTestId('tab-invoices-checks')).toHaveCount(0);
});

test('approve queue calls decision and supports rejection', async ({ page }) => {
  await mock(page, ['invoice_approve']);
  const decisions: unknown[] = [];
  let removed = false;
  await page.route('**/api/invoices/queues/ready-to-approve*', (route) => route.fulfill({ json: { items: removed ? [] : [invoice], total: removed ? 0 : 1 } }));
  await page.route('**/api/invoices/*/decision', async (route) => {
    decisions.push(route.request().postDataJSON());
    removed = true;
    await route.fulfill({ json: { ...invoice, status: route.request().postDataJSON().status } });
  });
  await page.goto('/invoices');
  await page.getByTestId('tab-invoices-approve').click();
  await page.getByRole('link', { name: 'View' }).click();
  await expect(page).toHaveURL(/\/invoices\/invoice-workflow-1/);
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => decisions.length).toBe(1);
  expect(decisions[0]).toEqual({ status: 'approved' });
  await page.goto('/invoices');
  await page.getByTestId('tab-invoices-approve').click();
  await expect(page.getByText('No invoices found.')).toBeVisible();
});

test('explicit Validate click posts validation and refetches the invoice', async ({ page }) => {
  const pending = { ...invoice, status: 'pending_review' };
  await mock(page, ['invoice_log_validate', 'invoice_approve'], pending);
  let validations = 0;
  let validated = false;
  await page.route('**/api/invoices/invoice-workflow-1', (route) => route.fulfill({ json: validated ? { ...pending, status: 'validated' } : pending }));
  await page.route('**/api/invoices?*', (route) => route.fulfill({ json: { items: validated ? [] : [pending], total: validated ? 0 : 1 } }));
  await page.route('**/api/invoices/invoice-workflow-1/validate', async (route) => {
    validations++;
    validated = true;
    await route.fulfill({ json: { valid: true, status: 'validated', checks: [] } });
  });
  await page.goto('/invoices/invoice-workflow-1');
  await page.getByTestId('button-validate-invoice').click();
  await expect.poll(() => validations).toBe(1);
  await expect(page.getByRole('button', { name: 'Validate invoice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
});

test('reject click posts rejected decision body', async ({ page }) => {
  await mock(page, ['invoice_approve']);
  const bodies: unknown[] = [];
  let removed = false;
  await page.route('**/api/invoices/queues/ready-to-approve*', (route) => route.fulfill({ json: { items: removed ? [] : [invoice], total: removed ? 0 : 1 } }));
  await page.route('**/api/invoices/*/decision', async (route) => {
    bodies.push(route.request().postDataJSON());
    removed = true;
    await route.fulfill({ json: { ...invoice, status: 'rejected' } });
  });
  await page.goto('/invoices/invoice-workflow-1');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ status: 'rejected' });
  await page.goto('/invoices');
  await page.getByTestId('tab-invoices-approve').click();
  await expect(page.getByText('No invoices found.')).toBeVisible();
});

test('check-writing payment is preselected, submitted, and removed from the queue', async ({ page }) => {
  await mock(page, ['check_writing']);
  let paid = false;
  let paymentBody: any;
  await page.route('**/api/invoices/queues/ready-for-check-writing*', (route) => route.fulfill({
    json: { items: paid ? [] : [{ ...invoice, status: 'approved' }], total: paid ? 0 : 1 },
  }));
  await page.route('**/api/clients?*', (route) => route.fulfill({
    json: { items: [{ id: invoice.clientId, firstName: 'Pat', lastName: 'Participant' }], total: 1 },
  }));
  await page.route('**/api/vendors?*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/authorizations?*', (route) => route.fulfill({
    json: { items: [{ id: 'auth-1', authNumber: 'AUTH-1', clientId: invoice.clientId }], total: 1 },
  }));
  await page.route('**/api/payments', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { items: [], total: 0 } });
    paymentBody = route.request().postDataJSON();
    paid = true;
    await route.fulfill({ status: 201, json: { id: 'payment-1', ...paymentBody } });
  });
  await page.goto('/invoices');
  await page.getByTestId('tab-invoices-checks').click();
  await page.getByRole('button', { name: 'Log Payment' }).click();
  await expect(page.getByTestId('select-payment-invoice-id')).toContainText('$100.00');
  await page.getByTestId('input-payment-check-number').fill('CHECK-1');
  await page.getByTestId('input-payment-date').fill('2026-01-15');
  await page.getByTestId('input-payment-alloc-0-amount').fill('100.00');
  await page.getByTestId('button-save-payment').click();
  await expect.poll(() => paymentBody).not.toBeUndefined();
  expect(paymentBody.invoiceId).toBe(invoice.id);
  expect(paymentBody.allocations).toEqual([{ authorizationId: 'auth-1', amount: '100.00' }]);
  await expect(page.getByText('No invoices found.')).toBeVisible();
});