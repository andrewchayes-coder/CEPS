import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getVisibleRoleDocs, roleDocs, invoiceStatusSteps } from './content';
import { InvoiceStatus } from '@workspace/api-client-react';
import { HelpDocumentation } from './help-documentation';

const visibility: Record<string, string[]> = {
  staff: ['staff', 'service_coordinator', 'parent_guardian', 'self', 'vendor'],
  service_coordinator: ['service_coordinator', 'parent_guardian', 'self'],
  parent_guardian: ['parent_guardian'],
  self: ['self'],
  vendor: ['vendor'],
};
const render = (role?: string) => renderToStaticMarkup(createElement(HelpDocumentation, { role }));

test('all role guides share numeric date/month examples and Pacific time guidance', () => {
  for (const role of Object.keys(visibility)) {
    const html = render(role);
    assert.match(html, /10\/22\/2026/);
    assert.match(html, /10\/2026/);
    assert.match(html, /3:05 PM/);
    assert.match(html, /Pacific time/);
  }
});

test('every documented invoice status exists in the API status list', () => {
  const statuses = Object.values(InvoiceStatus);
  assert.deepEqual(invoiceStatusSteps.map(step => step.status).sort(), [...statuses].sort());
  for (const step of invoiceStatusSteps) {
    assert.ok(statuses.includes(step.status), `Unknown invoice status: ${step.title}`);
    const expectedTitle = step.status === 'needs_entry' ? 'Awaiting CEPS Entry'
      : step.status.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
    assert.equal(step.title, expectedTitle);
  }
  assert.doesNotMatch(render('vendor'), /choose New Invoice|correct the lines, and resubmit/);
});

for (const [role, expected] of Object.entries(visibility)) {
  test(`${role}: exact visible guide list, own default, and correct tab strip`, () => {
    assert.deepEqual(getVisibleRoleDocs(role).map((doc) => doc.role), expected);
    const html = render(role);
    const hasTabs = expected.length > 1;
    assert.equal((html.match(/role="tablist"/g) ?? []).length, hasTabs ? 1 : 0);
    assert.equal((html.match(/role="tab"/g) ?? []).length, hasTabs ? expected.length : 0);
    for (const doc of roleDocs) {
      assert.equal(html.includes(`data-testid="tab-help-${doc.role}"`), hasTabs && expected.includes(doc.role));
      // Inactive tabs do not render their guide bodies.
      assert.equal(html.includes(`data-testid="guide-help-${doc.role}"`), doc.role === role);
    }
    assert.equal((html.match(/Your role/g) ?? []).length, 1);
    assert.equal(html.includes('for every role'), role === 'staff');
    if (hasTabs) {
      assert.match(html, new RegExp(`role="tab"[^>]*aria-selected="true"[^>]*data-testid="tab-help-${role}"`));
    }
  });
}

test('unknown and unresolved roles do not fall back to staff documentation', () => {
  for (const role of [undefined, '', 'unknown']) {
    assert.deepEqual(getVisibleRoleDocs(role), []);
    const html = render(role);
    assert.match(html, /No help guide is available/);
    assert.doesNotMatch(html, /data-testid="(?:tab|guide)-help-/);
  }
});

test('coordinator additions render in the own-role guide', () => {
  const html = render('service_coordinator');
  for (const text of [
    'Submitting an invoice or receipt', 'Downloading a referral confirmation', 'Participant notes',
    'Invoice or Receipt', 'service start and end dates', 'one or more supporting files',
    'Awaiting CEPS Entry', 'Expiring Authorizations tile', 'caseload only',
    'Edits are recorded', 'visible to CEPS staff',
  ]) assert.ok(html.includes(text), `Missing coordinator workflow text: ${text}`);
});

test('both family guides render simplified submission, all invoice states, and payments/fees guidance', () => {
  for (const role of ['parent_guardian', 'self']) {
    const html = render(role);
    for (const text of [
      'Submitting an invoice or receipt', 'Invoice or Receipt', 'service start and end dates',
      'one or more files', 'Awaiting CEPS Entry', 'Pending Review', 'Validated',
      'Approved', 'Rejected', 'Duplicate', 'Payments', 'Fees',
    ]) assert.ok(html.includes(text), `Missing ${role} workflow text: ${text}`);
    assert.doesNotMatch(html, /see the invoices (?:vendors|my vendors) submit/);
  }
});

test('staff entry comes before validation, and vendor retains full authorization/month/amount form guidance', () => {
  const staff = render('staff');
  assert.ok(staff.indexOf('Complete Awaiting CEPS Entry') < staff.indexOf('Validate the invoice'));
  for (const text of ['enter their invoice lines', 'payment type', 'service start and end dates']) {
    assert.ok(staff.includes(text), `Missing staff entry instruction: ${text}`);
  }
  const vendor = render('vendor');
  for (const text of ['For each line, select an authorization', 'service month and amount', 'payment type', 'Invoice or Receipt']) {
    assert.ok(vendor.includes(text), `Missing full vendor form instruction: ${text}`);
  }
  assert.doesNotMatch(vendor, /enter service dates and units for each line/);
});

test('no role guide promises automatic email notifications', () => {
  for (const role of Object.keys(visibility)) {
    assert.doesNotMatch(render(role), /(?:receive an email|email link|emailed to you|link sent to my email)/i);
  }
});

test('messaging help renders for supported roles only and states the visibility, archive and permanence rules', () => {
  for (const role of ['staff', 'service_coordinator', 'parent_guardian', 'self']) {
    const html = render(role);
    for (const text of [
      '>Messages</div>', 'All CEPS staff see every thread', 'selected family portal users',
      'Archive (older)', 'Custom range', 'cannot be edited or deleted',
      'There are no email notifications yet.',
      'Check Messages when you sign in; the unread badge shows new replies.',
    ]) assert.ok(html.includes(text), `Missing messaging help for ${role}: ${text}`);
  }
  assert.ok(!roleDocs.find((doc) => doc.role === 'vendor')!.workflows.some((workflow) => workflow.name === 'Messages'));
  assert.match(render('staff'), /only admins can reassign a thread to another staff member/);
  for (const role of ['service_coordinator', 'parent_guardian', 'self']) {
    assert.doesNotMatch(render(role), /Claim a conversation/);
  }
});
