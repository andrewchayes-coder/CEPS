import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceEditSchema, lineServiceDateWarning } from './invoice-edit-schema';

const base = {
  paymentType: 'direct_payment', documentType: 'invoice',
  lineItems: [{ authorizationId: 'auth', serviceMonth: '2026-10', amount: '10.00' }],
};

test('invoice editor blocks invalid date pairs with errors under both fields', () => {
  for (const [start, end] of [
    ['2026-10-31', '2026-10-01'], ['2026-02-30', '2026-03-01'],
    ['2026-01-01', '2027-01-01'], ['', '2026-10-01'], ['2026-10-01', ''],
  ]) {
    const parsed = invoiceEditSchema.safeParse({ ...base, serviceStartDate: start, serviceEndDate: end });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.deepEqual(parsed.error.issues.map(issue => issue.path), [['serviceStartDate'], ['serviceEndDate']]);
    }
  }
});

test('legacy dates stay optional and out-of-range line months are warnings, not save blockers', () => {
  assert.ok(invoiceEditSchema.safeParse(base).success);
  const dates = { serviceStartDate: '2026-10-15', serviceEndDate: '2026-11-02' };
  assert.ok(invoiceEditSchema.safeParse({ ...base, ...dates }).success);
  assert.equal(lineServiceDateWarning('2026-09', dates.serviceStartDate, dates.serviceEndDate),
    'Line month 2026-09 is outside the submitted service dates 2026-10-15 – 2026-11-02');
  assert.equal(lineServiceDateWarning('2026-12', dates.serviceStartDate, dates.serviceEndDate),
    'Line month 2026-12 is outside the submitted service dates 2026-10-15 – 2026-11-02');
  for (const month of ['2026-10', '2026-11']) {
    assert.equal(lineServiceDateWarning(month, dates.serviceStartDate, dates.serviceEndDate), null);
  }
  assert.equal(lineServiceDateWarning('2026-10', '', ''), null);
});
