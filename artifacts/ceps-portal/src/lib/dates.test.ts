import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDate, formatDateTime, formatMonth, formatMonthRange, formatDateRange } from './dates';
import { formatMessageClock, formatPacific } from './datetime';
import { formatServiceDates } from './invoice-service-dates';
import { formatPaymentServiceMonths } from './payment-utils';
import { getInvoiceDisplayMonth, getInvoiceSortMonth } from './invoice-utils';
import { downloadPaymentAudit } from './payment-audit';

test('calendar dates retain their day and validate Gregorian dates without timezone conversion', () => {
  assert.equal(formatDate('2026-03-01'), '03/01/2026');
  assert.equal(formatDate('2026-10-22'), '10/22/2026');
  assert.equal(formatDate('2024-02-29'), '02/29/2024');
  for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', 'invalid', '', null, undefined]) {
    assert.equal(formatDate(value), '—');
  }
});

test('timestamps use Pacific calendar days and twelve-hour clocks across winter, summer and midnight', () => {
  assert.equal(formatDate('2026-03-01T07:30Z'), '02/28/2026');
  assert.equal(formatDateTime('2026-03-01T07:30Z'), '02/28/2026 11:30 PM');
  assert.equal(formatDateTime('2026-10-22T22:05:00Z'), '10/22/2026 3:05 PM');
  assert.equal(formatDateTime('2026-07-01T07:00:00Z'), '07/01/2026 12:00 AM');
  assert.equal(formatDateTime('2026-03-01'), '03/01/2026');
  assert.equal(formatDateTime('invalid'), '—');
});

test('service months and month ranges are numeric, including a year boundary', () => {
  assert.equal(formatMonth('2026-10'), '10/2026');
  assert.equal(formatMonth('2026-13'), '—');
  assert.equal(formatMonth(null), '—');
  assert.equal(formatMonthRange('2026-12', '2027-01'), '12/2026 – 01/2027');
  assert.equal(formatMonthRange(null, '2027-01'), '01/2027');
  assert.equal(formatMonthRange(null, null), '—');
});

test('date ranges and submitted service dates share the calendar-safe format', () => {
  assert.equal(formatDateRange('2026-03-01', '2026-03-31'), '03/01/2026 – 03/31/2026');
  assert.equal(formatDateRange('2026-03-01', null), '03/01/2026');
  assert.equal(formatDateRange(null, null), '—');
  assert.equal(formatServiceDates('2026-03-01', '2026-03-31'), '03/01/2026 – 03/31/2026');
  assert.equal(formatServiceDates(null, '2026-03-31'), null);
});

test('payment months preserve contiguous ranges and gaps without month names', () => {
  assert.equal(formatPaymentServiceMonths({ paymentMonth: '2026-10' }), '10/2026');
  assert.equal(formatPaymentServiceMonths({ allocations: [{ serviceMonth: '2026-12' }, { serviceMonth: '2027-01' }] }), '12/2026 – 01/2027');
  assert.equal(formatPaymentServiceMonths({ allocations: [{ serviceMonth: '2026-01' }, { serviceMonth: '2026-03' }] }), '01/2026, 03/2026');
});

test('invoice month display changes do not change canonical sorting values', () => {
  const invoice = { serviceMonth: '2026-12', lineItems: [] };
  assert.equal(getInvoiceDisplayMonth(invoice), '12/2026');
  assert.equal(getInvoiceSortMonth(invoice), '2026-12');
  const next = { serviceMonth: '2027-01', lineItems: [] };
  assert.ok(getInvoiceSortMonth(invoice) < getInvoiceSortMonth(next));
});

test('check audit exports format date, month and timestamp cells without rewriting record values', () => {
  const row = { rowNumber: 1, result: 'match' as const, checkDate: '2026-03-01',
    serviceMonth: '2026-03', reviewedAt: '2026-03-01T07:30Z', checkAmount: '160.00' };
  let exported: (string | number)[][] = [];
  downloadPaymentAudit({ summary: {} as never, rows: [row] }, (_file, _headers, rows) => { exported = rows; });
  assert.equal(exported[0][2], '03/01/2026');
  assert.equal(exported[0][11], '03/2026');
  assert.equal(exported[0][16], '02/28/2026 11:30 PM');
  assert.equal(exported[0][7], '160.00');
  assert.equal(row.checkDate, '2026-03-01');
});

test('messaging preserves today-only clocks and adds PT only to the existing zoned formatter', () => {
  const timestamp = '2026-03-01T07:30Z';
  assert.equal(formatPacific(timestamp), '02/28/2026 11:30 PM PT');
  assert.equal(formatMessageClock(timestamp, new Date('2026-03-01T07:45Z')), '11:30 PM');
  assert.equal(formatMessageClock(timestamp, new Date('2026-03-01T08:30Z')), '02/28/2026');
});

test('server output helpers stay behaviorally identical to the portal helpers', async () => {
  const server = await import(new URL('../../../api-server/src/lib/dates.ts', import.meta.url).href);
  for (const value of ['2026-03-01', '2026-03-01T07:30Z', '2026-07-01T07:00Z', '', null]) {
    assert.equal(server.formatDate(value), formatDate(value));
    assert.equal(server.formatDateTime(value), formatDateTime(value));
  }
  assert.equal(server.formatMonth('2026-10'), formatMonth('2026-10'));
  assert.equal(server.formatMonthRange('2026-12', '2027-01'), formatMonthRange('2026-12', '2027-01'));
  assert.equal(server.formatDateRange('2026-03-01', '2026-03-31'), formatDateRange('2026-03-01', '2026-03-31'));
});

test('portal display code cannot introduce date-fns format or direct locale date formatting', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(root, 'components', 'ui')) walk(path);
      } else if (/\.[jt]sx?$/.test(entry.name) && !/\.test\./.test(entry.name) && path !== join(root, 'lib', 'dates.ts')) {
        const source = readFileSync(path, 'utf8');
        if (/import\s*\{[^}]*\bformat\b[^}]*\}\s*from\s*['"]date-fns['"]/.test(source)
          || /import\s+\*\s+as\s+\w+\s+from\s*['"]date-fns['"]/.test(source)
          || /from\s*['"]date-fns\/format['"]/.test(source)
          || /\.toLocaleDateString\s*\(/.test(source)) offenders.push(path.slice(root.length));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'Use lib/dates display helpers instead of one-off date formats');
});
