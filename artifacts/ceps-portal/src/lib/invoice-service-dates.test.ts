import test from 'node:test';
import assert from 'node:assert/strict';
import { monthsInRange, validateServiceDateRange, blankLinesForServiceDates } from './invoice-service-dates.ts';

test('Sep-Nov', () => assert.deepEqual(monthsInRange('2026-09-15', '2026-11-02'), ['2026-09', '2026-10', '2026-11']));
test('single month', () => assert.deepEqual(monthsInRange('2026-09-01', '2026-09-30'), ['2026-09']));
test('year boundary', () => assert.deepEqual(monthsInRange('2026-11-20', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']));
test('missing/invalid/reversed', () => {
  assert.deepEqual(monthsInRange(null, '2026-01-01'), []);
  assert.deepEqual(monthsInRange('2026-02-30', '2026-03-01'), []);
  assert.deepEqual(monthsInRange('2026-05-01', '2026-04-01'), []);
  assert.equal(blankLinesForServiceDates(undefined, undefined, '2026-01')[0].serviceMonth, '2026-01');
});
test('12 month cap', () => {
  assert.equal(validateServiceDateRange('2026-01-15', '2026-12-01'), null);
  assert.ok(validateServiceDateRange('2026-01-15', '2027-01-01'));
});
