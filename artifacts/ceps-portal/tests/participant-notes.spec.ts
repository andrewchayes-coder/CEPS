import { expect, test, type Page } from '@playwright/test';

const client = { id: 'notes-client', firstName: 'Ari', lastName: 'Rivera', uciNumber: '8936241', dateOfBirth: '2011-03-12', status: 'active' };

async function setup(page: Page, role: string, notes: any[]) {
  const calls = { notesGets: 0, posts: [] as any[], patches: [] as any[], deletes: 0 };
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: { id: 'u1', name: 'Pat Staff', email: 'p@example.test', role, permissions: [] } }));
  await page.route('**/api/clients/notes-client/case', (r) => r.fulfill({ json: { client, authorizations: [], invoices: [], payments: [], remittances: [], referrals: [], documents: [] } }));
  await page.route('**/api/fees**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/family-representatives**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/clients/notes-client/notes**', async (r) => {
    const m = r.request().method();
    const url = r.request().url();
    if (m === 'GET') { calls.notesGets++; return r.fulfill({ json: notes }); }
    if (m === 'POST') {
      const body = r.request().postDataJSON(); calls.posts.push(body);
      notes = [{ id: 'n-new', body: body.body, authorName: 'Pat Staff', authorRole: 'staff', createdAt: '2025-03-01T00:00:00.000Z', updatedAt: null, updatedByName: null, canEdit: true, canDelete: true }, ...notes];
      return r.fulfill({ status: 201, json: notes[0] });
    }
    if (m === 'PATCH') {
      const body = r.request().postDataJSON(); calls.patches.push(body);
      notes = notes.map((n) => n.id === url.split('/').pop() ? { ...n, body: body.body, updatedAt: '2025-03-02T00:00:00.000Z', updatedByName: 'Pat Staff' } : n);
      return r.fulfill({ json: notes.find((n) => n.id === url.split('/').pop()) });
    }
    if (m === 'DELETE') { calls.deletes++; notes = notes.filter((n) => n.id !== url.split('/').pop()); return r.fulfill({ status: 204, body: '' }); }
    return r.continue();
  });
  return calls;
}

const base = { authorName: 'Pat Staff', authorRole: 'staff', updatedAt: null, updatedByName: null, canEdit: true, canDelete: true };

test('add, edit, cancel, delete notes', async ({ page }) => {
  const calls = await setup(page, 'staff', [
    { ...base, id: 'n1', body: 'Line one\nLine two', createdAt: '2025-01-15T20:30:00.000Z' },
    { ...base, id: 'n2', body: 'Other', authorName: 'Sam SC', authorRole: 'service_coordinator', canEdit: false, canDelete: false, createdAt: '2025-01-10T20:30:00.000Z' },
  ]);
  await page.goto('/clients/notes-client');
  await expect(page.getByTestId('text-note-count')).toHaveText('(2)');
  await expect(page.getByTestId('note-role-n2')).toHaveText('SC');
  await expect(page.getByTestId('note-role-n1')).toHaveText('CEPS');
  await expect(page.getByTestId('button-edit-note-n2')).toHaveCount(0);
  await expect(page.getByTestId('note-body-n1')).toHaveCSS('white-space', 'pre-wrap');
  await page.getByTestId('input-new-note').fill('  Fresh note ');
  await page.getByTestId('button-add-note').click();
  await expect(page.getByTestId('note-body-n-new')).toHaveText('Fresh note');
  expect(calls.posts[0]).toEqual({ body: 'Fresh note' });
  await expect(page.getByTestId('list-notes').locator('li').first()).toHaveAttribute('data-testid', 'note-n-new');
  await page.getByTestId('button-edit-note-n1').click();
  await page.getByTestId('input-edit-note-n1').fill('Changed');
  await page.getByTestId('button-cancel-note-n1').click();
  await expect(page.getByTestId('note-body-n1')).toHaveText('Line one\nLine two');
  await page.getByTestId('button-edit-note-n1').click();
  await page.getByTestId('input-edit-note-n1').fill('Changed');
  await page.getByTestId('button-save-note-n1').click();
  await expect(page.getByTestId('note-edited-n1')).toContainText('Edited');
  await page.getByTestId('button-delete-note-n1').click();
  await page.getByTestId('button-confirm-delete-note').click();
  await expect(page.getByTestId('note-n1')).toHaveCount(0);
  expect(calls.deletes).toBe(1);
});

test('Pacific timestamps across DST', async ({ page }) => {
  await setup(page, 'service_coordinator', [
    { ...base, id: 'w', body: 'w', createdAt: '2025-01-15T20:30:00.000Z' },
    { ...base, id: 's', body: 's', createdAt: '2025-07-15T20:30:00.000Z' },
  ]);
  await page.goto('/clients/notes-client');
  await expect(page.getByTestId('note-created-w')).toHaveText('Jan 15, 2025, 12:30 PM PST');
  await expect(page.getByTestId('note-created-s')).toHaveText('Jul 15, 2025, 1:30 PM PDT');
});

for (const role of ['parent_guardian', 'self', 'vendor']) {
  test(`notes hidden and not queried for ${role}`, async ({ page }) => {
    const calls = await setup(page, role, []);
    await page.goto('/clients/notes-client');
    await expect(page.getByTestId('card-contact-information')).toBeVisible();
    await expect(page.getByTestId('card-participant-notes')).toHaveCount(0);
    expect(calls.notesGets).toBe(0);
  });
}

test('audit log links client_note to participant with full detail', async ({ page }) => {
  const detail = 'A long detail\nsecond line '.repeat(20);
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: { id: 'u1', name: 'Pat', email: 'p@example.test', role: 'staff', permissions: ['manage_users'] } }));
  await page.route('**/api/user-directory**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/audit-log**', (r) => r.fulfill({ json: { total: 1, entries: [{ id: 'a1', userName: 'Pat', action: 'create', entityType: 'client_note', entityId: 'notes-client', detail, createdAt: '2025-01-15T20:30:00.000Z' }] } }));
  await page.goto('/audit-log');
  await expect(page.getByTestId('link-audit-participant-a1')).toHaveAttribute('href', '/clients/notes-client');
  await expect(page.getByTestId('detail-audit-a1')).toHaveText(detail.trim());
  await expect(page.getByTestId('detail-audit-a1')).toHaveCSS('white-space', 'pre-wrap');
});
