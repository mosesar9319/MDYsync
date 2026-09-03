// Direct tests for the summary function's redaction, citation and threshold
// rules.
//
// Run with `npm run test:functions` (node --test). These are the checks that
// decide what leaves this system: which replies a third-party model is allowed
// to see, whether a generated sentence may be published without a source, and
// how often any of it happens at all. None of that is reachable from the
// Playwright suite, which cannot call a Netlify function, and none of it is
// reachable from the SQL suite, which cannot see this file.
//
// Importing the module does NOT import the Anthropic SDK: the provider client
// is loaded lazily inside generatePoints(), so these run with no key, no
// network and no dependency on the deploy being configured.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectSourceReplies,
  decideThreadGeneration,
  buildUserPrompt,
  extractJson,
  validatePoints,
  __testing,
} from '../../netlify/functions/chabura-summary.mjs';

const {
  MIN_REPLIES_FOR_SUMMARY, REGENERATE_AFTER_REPLIES, MIN_REGENERATE_INTERVAL_MS,
  MAX_SOURCE_REPLIES, MAX_POINTS, SYSTEM_PROMPT,
} = __testing;

function reply(overrides = {}) {
  return {
    id: overrides.id || `id-${Math.random().toString(16).slice(2)}`,
    body: 'A reply body.',
    author_display_name: 'Reader One',
    activity_sequence: 1,
    hidden: false,
    deleted_at: null,
    ...overrides,
  };
}

// --- What the model is allowed to see --------------------------------------

test('a moderator-hidden reply is never sent to the model', () => {
  const rows = [
    reply({ id: 'a', activity_sequence: 1 }),
    reply({ id: 'b', activity_sequence: 2, hidden: true, body: 'HIDDEN-CANARY' }),
    reply({ id: 'c', activity_sequence: 3 }),
  ];
  const selected = selectSourceReplies(rows);
  assert.deepEqual(selected.map((row) => row.id), ['a', 'c']);
  assert.ok(!JSON.stringify(selected).includes('HIDDEN-CANARY'));
});

test('a soft-deleted reply is never sent to the model, tombstone text and all', () => {
  const rows = [
    reply({ id: 'a', activity_sequence: 1 }),
    reply({ id: 'b', activity_sequence: 2, deleted_at: '2026-09-01T00:00:00Z', body: '[deleted]' }),
    // Belt and braces: the redaction trigger writes '[deleted]', but a row
    // carrying that text without the timestamp must be dropped too.
    reply({ id: 'c', activity_sequence: 3, body: '[deleted]' }),
  ];
  assert.deepEqual(selectSourceReplies(rows).map((row) => row.id), ['a']);
});

test('empty and whitespace-only replies are dropped rather than sent as blanks', () => {
  const rows = [reply({ id: 'a', body: '   ' }), reply({ id: 'b', body: '' }), reply({ id: 'c', body: 'Real.' })];
  assert.deepEqual(selectSourceReplies(rows).map((row) => row.id), ['c']);
});

test('replies are ordered by activity_sequence, whatever order they arrived in', () => {
  const rows = [
    reply({ id: 'c', activity_sequence: 30 }),
    reply({ id: 'a', activity_sequence: 10 }),
    reply({ id: 'b', activity_sequence: 20 }),
  ];
  assert.deepEqual(selectSourceReplies(rows).map((row) => row.id), ['a', 'b', 'c']);
});

test('catch-up sees only replies after the viewer read position', () => {
  const rows = [1, 2, 3, 4, 5].map((n) => reply({ id: `r${n}`, activity_sequence: n }));
  const selected = selectSourceReplies(rows, { sinceSequence: 3 });
  assert.deepEqual(selected.map((row) => row.id), ['r4', 'r5']);
});

test('a single request cannot cost more than the ceiling, and keeps the newest replies', () => {
  const rows = Array.from({ length: MAX_SOURCE_REPLIES + 120 }, (_, index) =>
    reply({ id: `r${index}`, activity_sequence: index + 1 }));
  const selected = selectSourceReplies(rows);
  assert.equal(selected.length, MAX_SOURCE_REPLIES);
  assert.equal(selected[selected.length - 1].id, `r${MAX_SOURCE_REPLIES + 119}`);
});

// --- Traceability -----------------------------------------------------------

test('a point with no resolvable citation is dropped, not published', () => {
  const replies = [reply({ id: 'a' }), reply({ id: 'b' })];
  const points = validatePoints({
    points: [
      { text: 'Cited properly.', sources: [1] },
      { text: 'Cites nothing.', sources: [] },
      { text: 'Cites a reply that was never sent.', sources: [99] },
      { text: 'Cites nonsense.', sources: ['two', null] },
    ],
  }, replies);
  assert.deepEqual(points, [{ text: 'Cited properly.', source_comment_ids: ['a'] }]);
});

test('citations resolve to real comment ids, never to the numbers the model wrote', () => {
  const replies = [reply({ id: 'first' }), reply({ id: 'second' }), reply({ id: 'third' })];
  const [point] = validatePoints({ points: [{ text: 'Two sources.', sources: [3, 1] }] }, replies);
  assert.deepEqual(point.source_comment_ids, ['third', 'first']);
});

test('a duplicated citation is recorded once', () => {
  const replies = [reply({ id: 'a' })];
  const [point] = validatePoints({ points: [{ text: 'Same source twice.', sources: [1, 1, 1] }] }, replies);
  assert.deepEqual(point.source_comment_ids, ['a']);
});

test('an out-of-range or zero index cannot reach into the array', () => {
  const replies = [reply({ id: 'a' }), reply({ id: 'b' })];
  assert.deepEqual(validatePoints({ points: [{ text: 'x', sources: [0] }] }, replies), []);
  assert.deepEqual(validatePoints({ points: [{ text: 'x', sources: [-1] }] }, replies), []);
  assert.deepEqual(validatePoints({ points: [{ text: 'x', sources: [3] }] }, replies), []);
});

test('a malformed response yields no points rather than throwing', () => {
  const replies = [reply({ id: 'a' })];
  for (const parsed of [null, undefined, {}, { points: 'nope' }, { points: [null, 7, 'text'] }]) {
    assert.deepEqual(validatePoints(parsed, replies), []);
  }
});

test('the point count is capped', () => {
  const replies = [reply({ id: 'a' })];
  const many = Array.from({ length: MAX_POINTS + 6 }, (_, i) => ({ text: `Point ${i}.`, sources: [1] }));
  assert.equal(validatePoints({ points: many }, replies).length, MAX_POINTS);
});

test('an absurdly long point is refused, matching the database check', () => {
  const replies = [reply({ id: 'a' })];
  const long = { text: 'x'.repeat(801), sources: [1] };
  assert.deepEqual(validatePoints({ points: [long] }, replies), []);
});

// --- Response parsing -------------------------------------------------------

test('JSON is recovered from a code fence or a sentence of preamble', () => {
  const expected = { points: [{ text: 'A point.', sources: [1] }] };
  assert.deepEqual(extractJson('{"points":[{"text":"A point.","sources":[1]}]}'), expected);
  assert.deepEqual(extractJson('```json\n{"points":[{"text":"A point.","sources":[1]}]}\n```'), expected);
  assert.deepEqual(extractJson('Here you go:\n{"points":[{"text":"A point.","sources":[1]}]}'), expected);
});

test('unparseable output returns null instead of throwing', () => {
  for (const bad of ['', 'no json here', '{ broken', null, undefined]) {
    assert.equal(extractJson(bad), null);
  }
});

// --- When generation is allowed to happen ----------------------------------

test('a short thread is never summarised', () => {
  const decision = decideThreadGeneration({
    replyCount: MIN_REPLIES_FOR_SUMMARY - 1, existing: null, maxSequence: 5, now: Date.now(),
  });
  assert.deepEqual(decision, { generate: false, reason: 'too-short' });
});

test('a long enough thread with no summary generates once', () => {
  const decision = decideThreadGeneration({
    replyCount: MIN_REPLIES_FOR_SUMMARY, existing: null, maxSequence: 20, now: Date.now(),
  });
  assert.equal(decision.generate, true);
  assert.equal(decision.reason, 'none');
});

test('a current summary is not regenerated on a page load', () => {
  const now = Date.now();
  const existing = {
    generated_at: new Date(now - 60 * 60 * 1000).toISOString(),
    stale: false,
    source_max_sequence: 100,
  };
  // Some new replies, but fewer than the threshold.
  const decision = decideThreadGeneration({
    replyCount: 60, existing, maxSequence: 100 + REGENERATE_AFTER_REPLIES - 1, now,
  });
  assert.deepEqual(decision, { generate: false, reason: 'current' });
});

test('enough new replies earns a regeneration', () => {
  const now = Date.now();
  const existing = {
    generated_at: new Date(now - 60 * 60 * 1000).toISOString(),
    stale: false,
    source_max_sequence: 100,
  };
  const decision = decideThreadGeneration({
    replyCount: 60, existing, maxSequence: 100 + REGENERATE_AFTER_REPLIES, now,
  });
  assert.deepEqual(decision, { generate: true, reason: 'new-activity' });
});

test('an invalidated summary is regenerated even with no new replies', () => {
  const now = Date.now();
  const existing = {
    generated_at: new Date(now - 60 * 60 * 1000).toISOString(),
    stale: true,
    source_max_sequence: 100,
  };
  const decision = decideThreadGeneration({ replyCount: 60, existing, maxSequence: 100, now });
  assert.deepEqual(decision, { generate: true, reason: 'stale' });
});

test('the cooldown applies to an explicit regenerate request too', () => {
  const now = Date.now();
  const existing = {
    generated_at: new Date(now - 1000).toISOString(),
    stale: true,
    source_max_sequence: 100,
  };
  // Stale, brand new, and explicitly asked for: still refused, because the
  // button is one any reader can hold down.
  assert.deepEqual(
    decideThreadGeneration({ replyCount: 60, existing, maxSequence: 400, now, force: true }),
    { generate: false, reason: 'cooling-down' });
  assert.deepEqual(
    decideThreadGeneration({ replyCount: 60, existing, maxSequence: 400, now }),
    { generate: false, reason: 'cooling-down' });
});

test('once the cooldown has passed, an explicit request is honoured', () => {
  const now = Date.now();
  const existing = {
    generated_at: new Date(now - MIN_REGENERATE_INTERVAL_MS - 1000).toISOString(),
    stale: false,
    source_max_sequence: 100,
  };
  assert.deepEqual(
    decideThreadGeneration({ replyCount: 60, existing, maxSequence: 100, now, force: true }),
    { generate: true, reason: 'requested' });
});

// --- The prompt itself ------------------------------------------------------

test('the standing instructions forbid presenting a ruling', () => {
  assert.match(SYSTEM_PROMPT, /halachic ruling/i);
  assert.match(SYSTEM_PROMPT, /disagree/i);
  assert.match(SYSTEM_PROMPT, /cannot cite must not be written/i);
});

test('the prompt labels replies with the indices the citations refer to', () => {
  const note = { segment_ref: 'Chullin 89a.1', body: 'The opening question.', author_display_name: 'Author Two' };
  const replies = [reply({ id: 'a', body: 'First answer.' }), reply({ id: 'b', body: 'Second answer.' })];
  const prompt = buildUserPrompt({ note, replies, mode: 'thread' });
  assert.match(prompt, /\[1\] Reader One: First answer\./);
  assert.match(prompt, /\[2\] Reader One: Second answer\./);
  assert.match(prompt, /Chullin 89a\.1/);
});

test('the prompt never carries a comment id, only its position', () => {
  const note = { segment_ref: 'Chullin 89a.1', body: 'Q' };
  const replies = [reply({ id: 'b0000000-0000-4000-8000-000000000001' })];
  const prompt = buildUserPrompt({ note, replies, mode: 'thread' });
  assert.ok(!prompt.includes('b0000000-0000-4000-8000-000000000001'));
});

test('catch-up tells the model the reader has already read everything earlier', () => {
  const note = { segment_ref: 'Chullin 89a.1', body: 'Q' };
  const prompt = buildUserPrompt({ note, replies: [reply()], mode: 'catchup' });
  assert.match(prompt, /since this reader last read/i);
  assert.match(prompt, /already read everything before them/i);
});

test('a very long reply is truncated before it is sent', () => {
  const note = { segment_ref: 'Chullin 89a.1', body: 'Q' };
  const replies = [reply({ body: 'x'.repeat(5000) })];
  const prompt = buildUserPrompt({ note, replies, mode: 'thread' });
  assert.ok(prompt.length < 3000);
  assert.match(prompt, /…/);
});
