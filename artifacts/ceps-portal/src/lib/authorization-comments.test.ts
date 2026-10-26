import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationCommentSubtitle } from './authorization-comments';

test('authorization dropdown comments are at most 60 characters without changing short comments', () => {
  assert.equal(authorizationCommentSubtitle(null), undefined);
  assert.equal(authorizationCommentSubtitle(''), undefined);
  assert.equal(authorizationCommentSubtitle('Full short comment'), 'Full short comment');
  assert.equal(authorizationCommentSubtitle('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(authorizationCommentSubtitle('x'.repeat(61)), `${'x'.repeat(59)}…`);
  assert.equal(Array.from(authorizationCommentSubtitle('😀'.repeat(61))!).length, 60);
  assert.equal(authorizationCommentSubtitle('😀'.repeat(61)), `${'😀'.repeat(59)}…`);
});
