import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

// Real, nonce-scoped development fixtures. Never touches existing participants or accounts.
type Actor = { id: string; name: string; token: string };
type Fixture = {
  clientId: string; clientName: string; archiveId: string; archiveSubject: string; archiveDay: string; historyId: string; recentId: string;
  customRangeId: string; customRangeSubject: string; customOldDay: string; customYesterdayDay: string;
  staff: Actor; staffB: Actor; coordinator: Actor; family: Actor; self: Actor; vendor: Actor;
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
let fixture: Fixture;
let createdThreadId: string;
const subject = `Messaging browser check ${Date.now()}`;
const opening = 'Opening message from staff';

function database(source: string) {
  return execFileSync('pnpm', ['--filter', '@workspace/db', 'exec', 'tsx', '-e', source], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  });
}

test.describe.configure({ mode: 'default' });
test.beforeAll(() => {
  const output = database(`
    import { randomBytes } from 'node:crypto';
    import { db, pool, usersTable, clientsTable, sessionsTable, familyRepresentativesTable,
      messageThreadsTable, messagesTable, messageThreadFamilyMembersTable } from './src/index.ts';
    import { inArray } from 'drizzle-orm';
    (async () => {
      const nonce = 'msg-ui-' + randomBytes(6).toString('hex'), actors = {};
      await db.transaction(async tx => {
        for (const [key, role] of Object.entries({staff:'staff', staffB:'staff', coordinator:'service_coordinator',
          family:'parent_guardian', self:'self', vendor:'vendor'})) {
          const name = nonce + ' ' + key;
          const [user] = await tx.insert(usersTable).values({name, email:name.replaceAll(' ','-')+'@example.test', role}).returning();
          const token = randomBytes(32).toString('hex');
          await tx.insert(sessionsTable).values({userId:user.id, token, expiresAt:new Date(Date.now()+3600000)});
          actors[key] = {id:user.id, name, token};
        }
        const [client] = await tx.insert(clientsTable).values({firstName:'Messaging', lastName:nonce,
          uciNumber:nonce, dateOfBirth:'2000-01-01', assignedCoordinatorId:actors.coordinator.id}).returning();
        await tx.update(usersTable).set({linkedRecordId:client.id, linkedRecordType:'client'})
          .where(inArray(usersTable.id,[actors.family.id,actors.self.id]));
        await tx.insert(familyRepresentativesTable).values([
          {clientId:client.id,userId:actors.family.id,name:actors.family.name,relationship:'guardian'},
          {clientId:client.id,name:nonce+' No portal',relationship:'parent'}
        ]);
        const old = new Date(Date.now()-210*86400000), archiveSubject=nonce+' archived conversation';
        const [thread] = await tx.insert(messageThreadsTable).values({clientId:client.id,subject:archiveSubject,
          createdBy:actors.staff.id,createdAt:old,lastMessageAt:old,lastMessageBy:actors.staff.id,messageCount:1}).returning();
        await tx.insert(messagesTable).values({threadId:thread.id,clientId:client.id,authorUserId:actors.staff.id,
          body:'An older conversation',createdAt:old});
        await tx.insert(messageThreadFamilyMembersTable).values({threadId:thread.id,userId:actors.family.id,addedBy:actors.staff.id});
        const [recent]=await tx.insert(messageThreadsTable).values({clientId:client.id,subject:nonce+' recent conversation',
          createdBy:actors.staff.id,lastMessageBy:actors.staff.id,messageCount:1}).returning();
        await tx.insert(messagesTable).values({threadId:recent.id,clientId:client.id,authorUserId:actors.staff.id,body:'Recent fixture message'});
        await tx.insert(messageThreadFamilyMembersTable).values({threadId:recent.id,userId:actors.family.id,addedBy:actors.staff.id});
        const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'})
          .formatToParts(new Date()).reduce((o,p)=>(o[p.type]=p.value,o),{});
        const y=Number(parts.year), m=Number(parts.month)-1, d=Number(parts.day);
        const today=new Date(Date.UTC(y,m,d)), yesterday=new Date(today.getTime()-86400000);
        const oldMonth=m-18, oldDay=new Date(Date.UTC(y,oldMonth,Math.min(d,new Date(Date.UTC(y,oldMonth+1,0)).getUTCDate())));
        // These are calendar dates constructed from Pacific parts, not message instants.
        const dayText=(date)=>date.toISOString().slice(0,10);
        const customOldDay=dayText(oldDay), customYesterdayDay=dayText(yesterday);
        const oldAt=new Date(customOldDay+'T20:00:00.000Z'), yesterdayAt=new Date(customYesterdayDay+'T20:00:00.000Z');
        const customRangeSubject=nonce+' historical range conversation';
        const [customRange]=await tx.insert(messageThreadsTable).values({clientId:client.id,subject:customRangeSubject,
          createdBy:actors.staff.id,createdAt:oldAt,lastMessageAt:yesterdayAt,lastMessageBy:actors.staff.id,messageCount:2}).returning();
        await tx.insert(messagesTable).values([
          {threadId:customRange.id,clientId:client.id,authorUserId:actors.staff.id,body:'Historical Pacific-day message',createdAt:oldAt},
          {threadId:customRange.id,clientId:client.id,authorUserId:actors.staff.id,body:'Yesterday Pacific-day message',createdAt:yesterdayAt}
        ]);
        const historyAt=new Date();
        const [history]=await tx.insert(messageThreadsTable).values({clientId:client.id,subject:nonce+' pagination',
          createdBy:actors.staff.id,lastMessageAt:historyAt,lastMessageBy:actors.staff.id,messageCount:120}).returning();
        await tx.insert(messagesTable).values(Array.from({length:120},(_,i)=>({
          threadId:history.id,clientId:client.id,authorUserId:actors.staff.id,
          body:'History message '+String(i+1).padStart(3,'0'),createdAt:historyAt
        })));
        const archiveDay = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(old);
        console.log('MESSAGING_FIXTURE='+JSON.stringify({clientId:client.id,clientName:client.firstName+' '+client.lastName,
          archiveId:thread.id,archiveSubject,archiveDay,historyId:history.id,recentId:recent.id,
          customRangeId:customRange.id,customRangeSubject,customOldDay,customYesterdayDay,...actors}));
      });
      await pool.end();
    })().catch(e=>{console.error(e);process.exit(1)});
  `);
  fixture = JSON.parse(output.split('\n').find((line) => line.startsWith('MESSAGING_FIXTURE='))!.slice(18));
  createdThreadId = fixture.recentId;
});

test.afterAll(() => {
  if (!fixture) return;
  const ids = ['staff', 'staffB', 'coordinator', 'family', 'self', 'vendor'].map((key) => fixture[key as keyof Fixture] as Actor).map((a) => a.id);
  database(`
    import { db,pool,usersTable,clientsTable,sessionsTable,familyRepresentativesTable,auditLogTable,
      messageThreadsTable,messagesTable,messageThreadFamilyMembersTable,messageThreadReadsTable } from './src/index.ts';
    import { eq,inArray } from 'drizzle-orm';
    (async()=>{
      await db.transaction(async tx=>{
        const userIds=${JSON.stringify(ids)},clientId=${JSON.stringify(fixture.clientId)};
        const threads=await tx.select({id:messageThreadsTable.id}).from(messageThreadsTable).where(eq(messageThreadsTable.clientId,clientId));
        const tids=threads.map(t=>t.id);
        if(tids.length){
          await tx.delete(messageThreadReadsTable).where(inArray(messageThreadReadsTable.threadId,tids));
          await tx.delete(messageThreadFamilyMembersTable).where(inArray(messageThreadFamilyMembersTable.threadId,tids));
          await tx.delete(messagesTable).where(inArray(messagesTable.threadId,tids));
          await tx.delete(messageThreadsTable).where(inArray(messageThreadsTable.id,tids));
        }
        await tx.delete(auditLogTable).where(inArray(auditLogTable.userId,userIds));
        await tx.delete(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId,clientId));
        await tx.delete(sessionsTable).where(inArray(sessionsTable.userId,userIds));
        await tx.delete(clientsTable).where(eq(clientsTable.id,clientId));
        await tx.delete(usersTable).where(inArray(usersTable.id,userIds));
      });await pool.end();
    })().catch(e=>{console.error(e);process.exit(1)});
  `);
});

async function signedIn(browser: Browser, baseURL: string, actor: Actor, mobile = false) {
  const context = await browser.newContext({ baseURL, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'ceps_session', value: actor.token, url: baseURL }]);
  const page = await context.newPage();
  // The isolated Vite server bypasses Replit's artifact gateway. Forward requests
  // to the real development API instead of receiving Vite's HTML fallback.
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:8080${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  return { page, context };
}
async function chooseRange(page: Page, label: string) {
  await page.getByTestId('select-message-range').click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test('staff A assigns to B, who follows a dashboard notice, reads the assigned inbox and clears the notices', async ({ browser, baseURL }) => {
  const staffA = await signedIn(browser, baseURL!, fixture.staff);
  const staffB = await signedIn(browser, baseURL!, fixture.staffB);
  try {
    await staffA.page.goto(`/messages/${fixture.recentId}`);
    await staffA.page.getByTestId('select-thread-assignee').selectOption(fixture.staffB.id);
    await expect(staffA.page.getByTestId('text-thread-assignment')).toContainText(fixture.staff.name);
    await expect(staffA.page.getByTestId('select-thread-assignee')).toHaveValue(fixture.staffB.id);
    await staffB.page.goto('/');
    await expect(staffB.page.getByTestId('card-alert-message_assigned_new')).toContainText(fixture.staff.name);
    await expect(staffB.page.getByTestId(`link-alert-message_assigned_new-${fixture.recentId}`))
      .toHaveAttribute('href', `/messages/${fixture.recentId}`);
    await staffB.page.getByTestId('card-alert-message_assigned_to_you').click();
    await expect(staffB.page).toHaveURL(/\/messages\?view=assigned_to_me$/);
    await expect(staffB.page.getByTestId('tab-messages-assigned_to_me')).toHaveAttribute('aria-selected', 'true');
    await expect(staffB.page.getByTestId('count-assigned-to-me')).toHaveText('1');
    await expect(staffB.page.getByTestId(`text-row-assignee-${fixture.recentId}`)).toContainText(fixture.staffB.name);
    await staffB.page.getByTestId(`message-thread-${fixture.recentId}`).click();
    await expect(staffB.page.getByTestId('message-thread-view')).toContainText('Recent fixture message');
    await expect(staffB.page.getByTestId('count-assigned-to-me')).toHaveText('0');
    await staffB.page.goto('/');
    await expect(staffB.page.getByTestId('card-alert-message_assigned_new')).toHaveCount(0);
    await expect(staffB.page.getByTestId('card-alert-message_assigned_to_you')).toHaveCount(0);
    await staffA.page.goto(`/clients/${fixture.clientId}`);
    await expect(staffA.page.getByTestId(`text-row-assignee-${fixture.recentId}`)).toContainText(fixture.staffB.name);
  } finally { await Promise.all([staffA.context.close(), staffB.context.close()]); }
});

test('resolve status controls and family replies reopen conversations', async ({ browser, baseURL }) => {
  const staff = await signedIn(browser, baseURL!, fixture.staff);
  const family = await signedIn(browser, baseURL!, fixture.family);
  const coordinator = await signedIn(browser, baseURL!, fixture.coordinator);
  try {
    await staff.page.goto(`/messages/${fixture.recentId}`);
    await expect(staff.page.getByTestId('select-message-status')).toHaveValue('all');
    await staff.page.getByTestId('button-thread-status').click();
    await expect(staff.page.getByTestId('button-thread-status')).toHaveText('Reopen');
    await expect(staff.page.getByTestId(`badge-thread-resolved-${fixture.recentId}`)).toBeVisible();
    await staff.page.getByTestId('textarea-reply').fill('Clarification from the resolver');
    await staff.page.getByTestId('button-send-reply').click();
    await expect(staff.page.getByTestId('textarea-reply')).toBeEnabled();
    await expect(staff.page.getByTestId('badge-thread-status-resolved')).toBeVisible();
    await staff.page.getByTestId('select-message-status').selectOption('open');
    await expect(staff.page.getByTestId(`message-thread-${fixture.recentId}`)).toHaveCount(0);
    await staff.page.getByTestId('select-message-status').selectOption('resolved');
    await expect(staff.page.getByTestId(`message-thread-${fixture.recentId}`)).toBeVisible();
    await family.page.goto(`/messages/${fixture.recentId}`);
    await expect(family.page.getByTestId('badge-thread-status-resolved')).toBeVisible();
    await expect(family.page.getByTestId('button-thread-status')).toHaveCount(0);
    await family.page.getByTestId('textarea-reply').fill('Please reopen this conversation');
    await family.page.getByTestId('button-send-reply').click();
    await expect(family.page.getByTestId('textarea-reply')).toBeEnabled();
    await expect(family.page.getByTestId('badge-thread-status-resolved')).toHaveCount(0);
    await staff.page.reload();
    await expect(staff.page.getByTestId('button-thread-status')).toHaveText('Mark resolved');
    await expect(staff.page.getByTestId(`message-thread-${fixture.recentId}`)).toHaveCount(0);
    await staff.page.getByTestId('select-message-status').selectOption('all');
    await expect(staff.page.getByTestId(`message-thread-${fixture.recentId}`)).toBeVisible();
    await coordinator.page.goto(`/messages/${fixture.recentId}`);
    await coordinator.page.getByTestId('button-thread-status').click();
    await expect(coordinator.page.getByTestId('button-thread-status')).toHaveText('Reopen');
    await coordinator.page.getByTestId('button-thread-status').click();
    await expect(coordinator.page.getByTestId('button-thread-status')).toHaveText('Mark resolved');
  } finally {
    await Promise.all([staff.context.close(), family.context.close(), coordinator.context.close()]);
  }
});

test('staff creates a participant conversation, coordinator and selected family reply, staff sees unread', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const staff = await signedIn(browser, baseURL!, fixture.staff);
  const coordinator = await signedIn(browser, baseURL!, fixture.coordinator);
  const family = await signedIn(browser, baseURL!, fixture.family);
  try {
    await staff.page.goto(`/clients/${fixture.clientId}`);
    await staff.page.getByTestId('card-participant-messages').getByRole('button', { name: 'New message' }).click();
    await expect(staff.page.getByTestId('checkbox-recipient-coordinator')).toBeChecked();
    await staff.page.getByTestId(`checkbox-recipient-family-${fixture.family.id}`).check();
    await expect(staff.page.getByTestId('text-compose-no-portal')).toContainText('have portal access');
    await staff.page.getByTestId('input-message-subject').fill(subject);
    await staff.page.getByTestId('input-message-body').fill(opening);
    await staff.page.getByTestId('button-compose-send').click();
    await expect(staff.page.getByTestId('text-thread-subject')).toHaveText(subject);
    createdThreadId = new URL(staff.page.url()).pathname.split('/').at(-1)!;
    await expect(staff.page.getByTestId('text-thread-to')).toContainText(fixture.family.name);
    await coordinator.page.goto('/messages');
    await expect(coordinator.page.getByTestId('messaging-unread-badge')).toBeVisible();
    await expect(coordinator.page.getByTestId(`message-thread-${createdThreadId}`)).toHaveAttribute('data-unread', 'true');
    await coordinator.page.getByTestId(`message-thread-${createdThreadId}`).click();
    await expect(coordinator.page.getByTestId('message-thread-view')).toContainText(opening);
    await coordinator.page.getByTestId('textarea-reply').fill('Coordinator reply');
    await coordinator.page.getByTestId('textarea-reply').press('Control+Enter');
    await expect(coordinator.page.getByTestId('message-thread-view')).toContainText('Coordinator reply');
    await expect(coordinator.page.getByTestId('message-pending')).toHaveCount(0);
    await coordinator.page.getByTestId('textarea-reply').fill('A second coordinator reply');
    await coordinator.page.getByTestId('button-send-reply').click();
    await expect(coordinator.page.getByTestId('message-thread-view')).toContainText('A second coordinator reply');
    await expect(coordinator.page.getByTestId('textarea-reply')).toBeEnabled();
    await family.page.goto('/messages');
    await expect(family.page.getByTestId('messaging-unread-badge')).toBeVisible();
    await family.page.getByTestId(`message-thread-${createdThreadId}`).click();
    const reply = 'Family reply\nhttps://example.test/safe <b>plain text</b> javascript:alert(1)';
    await family.page.getByTestId('textarea-reply').fill(reply);
    await family.page.getByTestId('button-send-reply').click();
    await expect(family.page.getByTestId('message-pending')).toHaveCount(0);
    const link = family.page.getByTestId('message-thread-view').getByRole('link', { name: 'https://example.test/safe' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(family.page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(family.page.getByText('<b>plain text</b>', { exact: false }).last()).toBeVisible();
    await staff.page.goto('/messages');
    await expect(staff.page.getByTestId(`message-thread-${createdThreadId}`)).toHaveAttribute('data-unread', 'true');
    await staff.page.getByTestId(`message-thread-${createdThreadId}`).click();
    await expect(staff.page.getByTestId('message-thread-view')).toContainText('Family reply');
    await expect(staff.page.getByTestId(`message-thread-${createdThreadId}`)).toHaveAttribute('data-unread', 'false');
    await staff.page.getByTestId('button-add-family-member').click();
    await staff.page.getByTestId(`checkbox-add-family-${fixture.self.id}`).check();
    await staff.page.getByTestId('button-confirm-add-family').click();
    await expect(staff.page.getByTestId('text-thread-to')).toContainText(fixture.self.name);
    await staff.page.route('**/api/messages/threads/*/messages', (route) => route.fulfill({ status: 500, json: { error: 'Simulated send failure' } }));
    await staff.page.getByTestId('textarea-reply').fill('Keep this failed reply');
    await staff.page.getByTestId('button-send-reply').click();
    await expect(staff.page.getByTestId('error-reply')).toBeVisible();
    await expect(staff.page.getByTestId('textarea-reply')).toHaveValue('Keep this failed reply');
  } finally {
    await Promise.all([staff.context.close(), coordinator.context.close(), family.context.close()]);
  }
});

test('archive and custom Pacific date range change captions and returned rows', async ({ browser, baseURL }) => {
  const { page, context } = await signedIn(browser, baseURL!, fixture.coordinator);
  try {
    await page.goto('/messages');
    await expect(page.getByTestId('text-message-range-caption')).toHaveText('Showing the last 6 months');
    await expect(page.getByTestId(`message-thread-${fixture.archiveId}`)).toHaveCount(0);
    await chooseRange(page, 'Archive (older)');
    await expect(page.getByTestId('text-message-range-caption')).toHaveText('Showing archived messages (older than 6 months)');
    await expect(page.getByTestId(`message-thread-${fixture.archiveId}`)).toBeVisible();
    await expect(page.getByTestId(`message-thread-${createdThreadId}`)).toHaveCount(0);
    await chooseRange(page, 'Custom range');
    await page.getByTestId('date-range-display').click();
    await page.getByRole('combobox').last().click();
    await page.getByRole('option', { name: 'Custom Range', exact: true }).click();
    await page.locator('input[type="date"]').first().fill(fixture.archiveDay);
    await page.locator('input[type="date"]').last().fill(fixture.archiveDay);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('text-message-range-caption')).toHaveText(`Showing ${fixture.archiveDay} to ${fixture.archiveDay}`);
    await expect(page.getByTestId(`message-thread-${fixture.archiveId}`)).toBeVisible();
    await expect(page.getByTestId(`message-thread-${createdThreadId}`)).toHaveCount(0);
    await page.getByTestId('input-message-search').fill('not-present-in-this-conversation');
    await expect(page.getByTestId(`message-thread-${fixture.archiveId}`)).toHaveCount(0);
  } finally { await context.close(); }
});

test('custom range opens old messages in an active thread', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const { page, context } = await signedIn(browser, baseURL!, fixture.staffB);
  const readPosts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(`/api/messages/threads/${fixture.customRangeId}/read`)) {
      readPosts.push(request.url());
    }
  });
  const useCustomRange = async (root: Page | Locator) => {
    await root.getByTestId('select-message-range').click();
    await page.getByRole('option', { name: 'Custom range', exact: true }).click();
    await root.getByTestId('date-range-display').click();
    await page.getByRole('combobox').last().click();
    await page.getByRole('option', { name: 'Custom Range', exact: true }).click();
    await page.locator('input[type="date"]').first().fill(fixture.customOldDay);
    await page.locator('input[type="date"]').last().fill(fixture.customOldDay);
    await page.keyboard.press('Escape');
    await root.getByTestId('date-range-display').click();
  };
  try {
    await page.goto('/messages');
    await page.getByTestId('input-message-search').fill(fixture.customRangeSubject);
    await useCustomRange(page);
    const row = page.getByTestId(`message-thread-${fixture.customRangeId}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`text-thread-range-${fixture.customRangeId}`))
      .toHaveText(`1 message in this range · latest ${fixture.customOldDay}`);
    await expect(page.getByTestId('text-message-range-caption'))
      .toHaveText(`Threads with messages from ${fixture.customOldDay} to ${fixture.customOldDay}`);
    await expect(row).toHaveAttribute('data-unread', 'true');
    await row.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('until')).toBe(fixture.customOldDay);
    await expect(page.getByTestId('message-thread-view')).toContainText('Historical Pacific-day message');
    await expect(page.getByTestId('message-thread-view')).not.toContainText('Yesterday Pacific-day message');
    await expect(page.getByTestId('banner-message-history')).toBeVisible();
    await expect(page.getByText('Historical Pacific-day message')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('historical-view.png'), fullPage: false });
    expect(readPosts).toHaveLength(0);
    const historicalList = await page.evaluate(async ({ id, subject, day }) => {
      const params = new URLSearchParams({ search: subject, dateFrom: day, dateTo: day });
      const response = await fetch(`/api/messages/threads?${params}`);
      return (await response.json()).items.find((item: { id: string }) => item.id === id);
    }, { id: fixture.customRangeId, subject: fixture.customRangeSubject, day: fixture.customOldDay });
    expect(historicalList?.unread).toBe(true);

    const readResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().includes(`/api/messages/threads/${fixture.customRangeId}/read`));
    await page.getByTestId('button-jump-to-latest').click();
    expect((await readResponse).status()).toBe(200);
    await expect.poll(() => new URL(page.url()).searchParams.has('until')).toBe(false);
    await expect(page.getByTestId('message-thread-view')).toContainText('Yesterday Pacific-day message');
    await expect(page.getByTestId('banner-message-history')).toHaveCount(0);
    await expect.poll(() => readPosts.length).toBeGreaterThan(0);
    const latestList = await page.evaluate(async ({ id, subject }) => {
      const params = new URLSearchParams({ search: subject });
      const response = await fetch(`/api/messages/threads?${params}`);
      return (await response.json()).items.find((item: { id: string }) => item.id === id);
    }, { id: fixture.customRangeId, subject: fixture.customRangeSubject });
    expect(latestList?.unread).toBe(false);

    await page.goto(`/clients/${fixture.clientId}`);
    const card = page.getByTestId('card-participant-messages');
    await expect(card).toBeVisible();
    await card.getByTestId('input-participant-message-search').fill(fixture.customRangeSubject);
    await useCustomRange(card);
    const participantRow = card.getByTestId(`message-thread-${fixture.customRangeId}`);
    await expect(participantRow).toBeVisible();
    await expect(card.getByTestId(`text-thread-range-${fixture.customRangeId}`))
      .toHaveText(`1 message in this range · latest ${fixture.customOldDay}`);
    await expect(participantRow).toHaveAttribute('href', `/messages/${fixture.customRangeId}?until=${fixture.customOldDay}`);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
});

test('vendor has no Messages navigation, no messaging requests, and an unauthorized direct route', async ({ browser, baseURL }) => {
  const { page, context } = await signedIn(browser, baseURL!, fixture.vendor);
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/api/messages')) requests.push(request.url()); });
  try {
    await page.goto('/messages');
    await expect(page.getByTestId('page-messages')).toContainText('Not authorized');
    await expect(page.getByTestId('nav-messages')).toHaveCount(0);
    await expect(page.getByTestId('nav-messages-mobile')).toHaveCount(0);
    expect(requests).toEqual([]);
  } finally { await context.close(); }
});

test('mobile stacks list and thread, supports back navigation, and family compose uses its own participant', async ({ browser, baseURL }) => {
  const { page, context } = await signedIn(browser, baseURL!, fixture.family, true);
  try {
    await page.goto('/messages');
    await expect(page.getByTestId(`message-thread-${createdThreadId}`)).toBeVisible();
    await page.getByTestId(`message-thread-${createdThreadId}`).click();
    await expect(page.getByTestId('message-thread-view')).toBeVisible();
    await expect(page.getByTestId('list-message-threads')).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByTestId('button-messages-back').click();
    await expect(page).toHaveURL(/\/messages$/);
    await page.getByTestId('button-new-message').first().click();
    await expect(page.getByTestId('compose-message-dialog')).toBeVisible();
    await expect(page.getByTestId('text-compose-fixed-recipients')).toContainText(fixture.coordinator.name);
    await expect(page.getByTestId('compose-recipients').getByRole('checkbox')).toHaveCount(0);
  } finally { await context.close(); }
});

test('older messages load 50, 50, 20 with a lossless composite cursor and preserve scroll position', async ({ browser, baseURL }) => {
  const { page, context } = await signedIn(browser, baseURL!, fixture.staff);
  const cursors: URLSearchParams[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/messages/threads/${fixture.historyId}` && url.searchParams.has('before')) cursors.push(url.searchParams);
  });
  try {
    await page.goto(`/messages/${fixture.historyId}`);
    const articles = page.getByTestId('message-thread-view').locator('article[data-testid^="message-"]');
    const scroller = page.getByTestId('message-thread-scroll');
    await expect(articles).toHaveCount(50);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.getByTestId('button-load-older-messages').click();
    await expect(articles).toHaveCount(100);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.getByTestId('button-load-older-messages').click();
    await expect(articles).toHaveCount(120);
    await expect(page.getByTestId('button-load-older-messages')).toHaveCount(0);
    expect(new Set(await articles.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).size).toBe(120);
    expect(cursors).toHaveLength(2);
    for (const cursor of cursors) {
      expect(cursor.get('before')).toMatch(/\.\d{6}Z$/);
      expect(cursor.get('beforeId')).toMatch(/^[\da-f-]{36}$/);
      expect(cursor.get('limit')).toBe('50');
    }
  } finally { await context.close(); }
});
