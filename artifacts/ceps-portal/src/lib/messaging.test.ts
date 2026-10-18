import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, mergeNewestFirst, rangeCaption, rangeParams, unreadBadgeLabel, visiblePending } from './messaging';
import type { ThreadMessage } from '@workspace/api-client-react';

const msg = (id: string, body = 'x', isMine = false): ThreadMessage => ({ id, body, isMine, createdAt: '2025-01-01T00:00:00.000000Z', author: { userId: 'u', name: 'N', role: 'staff' } });

describe('messaging helpers', () => {
  it('badge label', () => {
    assert.equal(unreadBadgeLabel(0), null);
    assert.equal(unreadBadgeLabel(7), '7');
    assert.equal(unreadBadgeLabel(100), '99+');
  });
  it('range params and captions', () => {
    assert.deepEqual(rangeParams({ mode: 'recent' }), { range: 'recent' });
    assert.deepEqual(rangeParams({ mode: 'archive' }), { range: 'archive' });
    assert.deepEqual(rangeParams({ mode: 'custom', from: '2025-01-01', to: '2025-02-01' }), { dateFrom: '2025-01-01', dateTo: '2025-02-01' });
    assert.equal(rangeCaption({ mode: 'custom', from: '2025-01-01', to: '2025-02-01' }), 'Showing 2025-01-01 to 2025-02-01');
  });
  it('linkify only http(s) and trims punctuation', () => {
    const s = linkify('see https://a.com/x, and javascript:alert(1)');
    assert.deepEqual(s[1], { type: 'link', value: 'https://a.com/x', href: 'https://a.com/x' });
    assert.equal(s.filter((x) => x.type === 'link').length, 1);
  });
  it('merge dedupes', () => {
    assert.deepEqual(mergeNewestFirst([msg('a'), msg('b')], [msg('b'), msg('c')]).map((m) => m.id), ['a', 'b', 'c']);
  });
  it('pending hidden when equivalent message arrives', () => {
    const p = [{ tempId: 't', body: 'hi', knownIds: ['a'] }];
    assert.equal(visiblePending(p, [msg('a', 'hi', true)]).length, 1);
    assert.equal(visiblePending(p, [msg('z', 'hi', true), msg('a')]).length, 0);
  });
});
