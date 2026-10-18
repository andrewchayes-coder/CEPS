import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCoordinatorTiles, getInvoicesInReview, filterAlertsForRole, resolveReportTab, getAllowedReportTabs, TILE_VARIANT_STYLES, getMessageAlertHref,
} from './dashboard-models.ts';

test('message assignment links select the owned inbox or the assigned thread', () => {
  assert.equal(getMessageAlertHref('message_assigned_to_you'), '/messages?view=assigned_to_me');
  assert.equal(getMessageAlertHref('message_assigned_new', 'thread-id'), '/messages/thread-id');
  assert.equal(getMessageAlertHref('message_assigned_new'), '/messages?view=assigned_to_me');
  assert.equal(getMessageAlertHref('pending_w9'), undefined);
});

test('coordinator tiles: expiring first, red when >0', () => {
  const t = getCoordinatorTiles({ expiringAuthorizations: 3, activeClients: 7 }, 4, 2);
  assert.deepEqual(t.map((x) => x.title), ['Expiring Authorizations', 'Active Referrals', 'My Participants']);
  assert.equal(t[0].variant, 'alert');
  assert.equal(t[0].subtitle, 'Ending in the next 30 days');
  assert.equal(t[1].subtitleTone, 'orange');
  assert.match(TILE_VARIANT_STYLES.alert.card, /border-destructive/);
});
test('coordinator tiles: neutral at 0 / missing', () => {
  const t = getCoordinatorTiles({}, 1, 0);
  assert.equal(t[0].value, 0);
  assert.equal(t[0].variant, 'neutral');
  assert.equal(t[0].subtitle, 'None in the next 30 days');
  assert.equal(t[1].subtitleTone, 'muted');
});
test('invoices in review', () => {
  assert.equal(getInvoicesInReview({ invoicesInReview: 5, pendingInvoices: 1 }), 5);
  assert.equal(getInvoicesInReview({ pendingInvoices: 2, needsEntryInvoices: 3 }), 5);
});
test('alert filtering', () => {
  const a = [{ kind: 'expiring_authorization' }, { kind: 'missing_document' }];
  assert.equal(filterAlertsForRole(a, 'service_coordinator').length, 1);
  assert.equal(filterAlertsForRole(a, 'staff').length, 2);
});
test('report tab fallback', () => {
  for (const p of [null, '', 'vendor-payments', 'case-status', 'missing-docs', 'bogus']) {
    assert.equal(resolveReportTab('service_coordinator', p), 'expiring-auth');
  }
  assert.equal(resolveReportTab('service_coordinator', 'pending-auth'), 'pending-auth');
  assert.equal(resolveReportTab('staff', null), 'vendor-payments');
  assert.equal(resolveReportTab('staff', 'case-status'), 'case-status');
  assert.equal(resolveReportTab('vendor', 'case-status'), 'vendor-payments');
  assert.deepEqual(getAllowedReportTabs('vendor'), ['vendor-payments']);
});
