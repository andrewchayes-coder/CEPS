import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageThreadHeader } from '@workspace/api-client-react';
import { ThreadAssignment } from './thread-assignment';

const thread: MessageThreadHeader = {
  id: 'thread', clientId: 'participant', clientName: 'Participant', subject: 'Question',
  lastMessageAt: '2026-10-26T12:00:00Z', lastMessagePreview: 'Question', lastMessageByName: 'Family',
  messageCount: 1, unread: false, includeCoordinator: true, coordinatorName: null,
  familyMemberNames: [], assignee: null, createdAt: '2026-10-26T12:00:00Z',
};

function render(admin: boolean, owner: 'me' | 'other' | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['/api/messages/assignable-staff', 'me', admin], [
    { userId: 'me', name: 'My Name' }, { userId: 'other', name: 'Other Staff' },
  ]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ThreadAssignment thread={{ ...thread, assignee: owner ? {
        userId: owner, name: owner === 'me' ? 'My Name' : 'Other Staff',
      } : null }} qk={['thread']} currentUserId="me" canAssignOthers={admin} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

test('non-admin staff see Claim, Release, or a read-only owner, never an assignment select', () => {
  const unassigned = render(false, null);
  assert.match(unassigned, />Claim</);
  assert.doesNotMatch(unassigned, /<select|>Release<|>Assign to me</);
  const own = render(false, 'me');
  assert.match(own, />Release</);
  assert.doesNotMatch(own, /<select|>Claim<|>Assign to me</);
  const other = render(false, 'other');
  assert.match(other, /Assigned to Other Staff/);
  assert.doesNotMatch(other, /<select|<button|>Claim<|>Release</);
});

test('admins retain the assignment select and Assign to me action', () => {
  for (const owner of [null, 'other'] as const) {
    const html = render(true, owner);
    assert.match(html, /<select/);
    assert.match(html, />Assign to me</);
    assert.match(html, />Other Staff</);
  }
  const own = render(true, 'me');
  assert.match(own, /<select/);
  assert.doesNotMatch(own, />Assign to me</);
});
