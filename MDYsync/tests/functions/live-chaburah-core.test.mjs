// Cloud Chaburah Live's pure logic: what is shown first, how a message is folded into a
// chat, what an error says. No DOM and no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../live-chaburah-core.js');

const thread = (id, segment, word, extra = {}) => ({
  id, anchor_segment: segment, anchor_word: word, message_count: 1, status: 'open',
  created_at: '2026-10-25T10:00:00Z', last_message_at: '2026-10-25T10:00:00Z', ...extra,
});

test('a discussion is filed under the daf, whichever recording or segment it came from', () => {
  assert.equal(C.dafKeyFromRef('Bekhorot 22a'), 'Bekhorot-22a');
  assert.equal(C.dafKeyFromRef('Bekhorot 22a (Hebrew)'), 'Bekhorot-22a');
  assert.equal(C.dafKeyFromRef('Bekhorot 22a (Chazarah Daf)'), 'Bekhorot-22a');
  assert.equal(C.dafKeyFromRef('Bekhorot 22a (Bornstein)'), 'Bekhorot-22a');
  assert.equal(C.dafKeyFromRef('Bekhorot 22a.5'), 'Bekhorot-22a');
  assert.equal(C.dafKeyFromRef('Bekhorot 22a:5'), 'Bekhorot-22a');
  assert.equal(C.dafKeyFromRef('Bava Kamma 7b.3'), 'Bava-Kamma-7b');
  assert.equal(C.dafKeyFromRef('nonsense'), null);
  assert.equal(C.dafKeyFromRef(''), null);
  assert.equal(C.dafLabelFromRef('Bava  Kamma 07b.3'), 'Bava Kamma 7b');
  assert.equal(C.segmentNumber('Bekhorot 22a.5'), 5);
  assert.equal(C.segmentNumber('Bekhorot 22a'), 0);
});

test('"near my place" puts the closest threads first, then the most recent', () => {
  const list = [thread('far', 40, 0), thread('near', 11, 3), thread('exact', 10, 5),
    thread('tie-old', 12, 5, { last_message_at: '2026-10-25T09:00:00Z' }),
    thread('tie-new', 8, 5, { last_message_at: '2026-10-25T11:00:00Z' })];
  const ids = C.sortThreads(list, 'near', { segment: 10, word: 5 }).map((t) => t.id);
  assert.equal(ids[0], 'exact');
  assert.equal(ids[1], 'near');
  assert.equal(ids.at(-1), 'far');
  assert.deepEqual(list.map((t) => t.id), ['far', 'near', 'exact', 'tie-old', 'tie-new'], 'the input is not reordered');
});

test('without a place, "near" falls back to the order of the daf', () => {
  const list = [thread('b', 5, 0), thread('a', 1, 9), thread('c', 5, 3)];
  assert.deepEqual(C.sortThreads(list, 'near', null).map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(C.sortThreads(list, 'all', { segment: 5, word: 0 }).map((t) => t.id), ['a', 'b', 'c']);
});

test('latest, unanswered and most active', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const list = [
    thread('old-busy', 1, 0, { message_count: 30, last_message_at: '2026-10-24T12:00:00Z' }),
    thread('recent-quiet', 2, 0, { message_count: 2, last_message_at: '2026-10-25T11:50:00Z' }),
    thread('recent-busy', 3, 0, { message_count: 9, last_message_at: '2026-10-25T11:30:00Z', status: 'answered' }),
  ];
  assert.deepEqual(C.sortThreads(list, 'latest', null, now).map((t) => t.id), ['recent-quiet', 'recent-busy', 'old-busy']);
  assert.deepEqual(C.sortThreads(list, 'unanswered', null, now).map((t) => t.id), ['recent-quiet', 'old-busy']);
  assert.deepEqual(C.sortThreads(list, 'active', null, now).map((t) => t.id), ['recent-busy', 'recent-quiet', 'old-busy']);
});

test('reply count never counts the opening question', () => {
  assert.equal(C.replyCount({ message_count: 1 }), 0);
  assert.equal(C.replyCount({ message_count: 13 }), 12);
  assert.equal(C.replyCount({ message_count: 0 }), 0);
});

test('time since the last activity, in words', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(C.timeAgo(ago(10 * 1000), now), 'just now');
  assert.equal(C.timeAgo(ago(60 * 1000), now), '1 minute ago');
  assert.equal(C.timeAgo(ago(8 * 60 * 1000), now), '8 minutes ago');
  assert.equal(C.timeAgo(ago(3 * 3600 * 1000), now), '3 hours ago');
  assert.equal(C.timeAgo(ago(26 * 3600 * 1000), now), 'yesterday');
  assert.equal(C.timeAgo(ago(3 * 86400 * 1000), now), '3 days ago');
  assert.equal(C.timeAgo(null, now), '');
});

test('unread activity is only shown for a followed thread that moved since the reader looked', () => {
  const t = thread('t', 1, 0, { author_id: 'other', message_count: 3, last_message_at: '2026-10-25T10:30:00Z' });
  assert.equal(C.hasUnread(t, { updated_at: '2026-10-25T10:00:00Z' }, true, 'me'), true);
  assert.equal(C.hasUnread(t, { updated_at: '2026-10-25T10:30:00Z' }, true, 'me'), false);
  assert.equal(C.hasUnread(t, { updated_at: '2026-10-25T10:00:00Z' }, false, 'me'), false, 'not followed');
  assert.equal(C.hasUnread(t, null, true, 'me'), true, 'followed and never opened');
  assert.equal(C.hasUnread({ ...t, author_id: 'me', message_count: 1 }, null, true, 'me'), false, 'my own, no replies yet');
});

test('messages are folded into a chat in order, once, and edits replace', () => {
  let chat = [];
  chat = C.mergeMessage(chat, { id: 'b', seq: 2, body: 'second' });
  chat = C.mergeMessage(chat, { id: 'a', seq: 1, body: 'first' });
  chat = C.mergeMessage(chat, { id: 'c', seq: 3, body: 'third' });
  assert.deepEqual(chat.map((m) => m.id), ['a', 'b', 'c']);
  const before = chat;
  chat = C.mergeMessage(chat, { id: 'b', seq: 2, body: 'second (edited)', edited_at: 'x' });
  assert.equal(chat.length, 3);
  assert.equal(chat[1].body, 'second (edited)');
  assert.equal(before[1].body, 'second', 'the old array is untouched');
  chat = C.mergeMessage(chat, { id: 'c', seq: 3, body: 'third' });
  assert.equal(chat.length, 3, 'the same message arriving by two routes is kept once');
  chat = C.mergeMessage(chat, { id: 'b', seq: 2, body: '', hidden: true });
  assert.equal(chat[1].hidden, true);
  assert.equal(chat[1].body, '');
});

test('threads are folded into a daf list by id, and removed', () => {
  let list = [thread('a', 1, 0)];
  list = C.mergeThread(list, thread('b', 2, 0));
  assert.deepEqual(list.map((t) => t.id), ['b', 'a']);
  list = C.mergeThread(list, { id: 'a', message_count: 5 });
  assert.equal(list.find((t) => t.id === 'a').message_count, 5);
  assert.equal(list.find((t) => t.id === 'a').anchor_segment, 1, 'a summary keeps the columns it did not mention');
  list = C.removeThread(list, 'b');
  assert.deepEqual(list.map((t) => t.id), ['a']);
});

test('a quote bar shows a short line, or says the message is gone', () => {
  assert.equal(C.quoteSnippet({ body: 'a   b\nc' }), 'a b c');
  assert.equal(C.quoteSnippet({ body: 'x'.repeat(200) }, 20).length, 20);
  assert.equal(C.quoteSnippet({ body: '', deleted_at: 'x' }), 'This message was deleted');
  assert.equal(C.quoteSnippet({ body: '', hidden: true }), 'This message was removed');
  assert.equal(C.quoteSnippet(null), '');
});

test('a body must be 1 to 2000 characters once trimmed', () => {
  assert.ok(C.bodyProblem('   '));
  assert.ok(C.bodyProblem('a'.repeat(2001)));
  assert.equal(C.bodyProblem('  hello  '), null);
  assert.equal(C.bodyProblem('a'.repeat(2000)), null);
});

test('database error codes become plain sentences, and a network fault says so', () => {
  assert.match(C.errorText({ message: 'live_rate_limited' }), /quickly/);
  assert.match(C.errorText({ message: 'live_account_too_new' }), /24 hours/);
  assert.match(C.errorText({ message: 'live_root_has_replies' }), /replies/);
  assert.match(C.errorText({ message: 'TypeError: Failed to fetch' }), /connection/);
  assert.match(C.errorText({ code: '42501', message: 'permission denied' }), /permission/);
  assert.match(C.errorText({ message: 'something odd' }), /try again/);
  for (const code of Object.keys(C.ERROR_TEXT)) assert.ok(C.ERROR_TEXT[code].length > 10);
});

test('a selection becomes word ranges, from runs, one ref, or a whole segment', () => {
  assert.deepEqual(C.runsFromTarget({ runs: [{ ref: 'A 1a.1', start: 2, end: 4 }, { ref: 'A 1a.2', start: 0, end: 1 }] }),
    [{ ref: 'A 1a.1', start: 2, end: 4 }, { ref: 'A 1a.2', start: 0, end: 1 }]);
  assert.deepEqual(C.runsFromTarget({ ref: 'A 1a.1', start: 3, end: 3 }), [{ ref: 'A 1a.1', start: 3, end: 3 }]);
  assert.deepEqual(C.runsFromTarget({ ref: 'A 1a.1' }, [{ ref: 'A 1a.1', he: 'אחד שנים שלשה' }]), [{ ref: 'A 1a.1', start: 0, end: 2 }]);
  assert.deepEqual(C.runsFromTarget({ ref: 'A 1a.9' }, []), []);
});

test('a thread link names the daf and the discussion', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(C.threadUrl('https://dafsync.netlify.app', 'Bekhorot 22a (Hebrew)', id),
    `https://dafsync.netlify.app/browse/?ref=Bekhorot%2022a&live=${id}`);
  assert.equal(C.threadIdFromSearch(`?ref=x&live=${id}`), id);
  assert.equal(C.threadIdFromSearch('?live=not-an-id'), null);
  assert.equal(C.threadIdFromSearch(''), null);
});

test('presence counts the tabs that are here, by key, and ignores keys that have left', () => {
  const state = { a: [{ presence_ref: 'x' }], b: [{ presence_ref: 'y' }, { presence_ref: 'z' }], c: [] };
  assert.equal(C.presenceCount(state), 2);
  assert.equal(C.presenceCount({}), 0);
  assert.equal(C.presenceCount(null), 0);
});
