// Generated summaries for a Cloud Chabura discussion.
//
// Everything about this function follows from one rule: the browser must never
// hold the provider credential, and must never be trusted about what a thread
// contains. So the client sends an id, not text. This function re-reads the
// discussion from the database, decides for itself what is public, and sends
// only that to the model.
//
// It reads the thread with the CALLER'S OWN Supabase token, not a service key.
// That is deliberate: row-level security is then the visibility boundary for
// the read, exactly as it is in the browser, so there is no path by which this
// function can see more of the database than the person asking. The service
// key appears once, at the very end, to write the cache -- a table the browser
// is not granted at all.
//
// Two modes:
//
//   thread  -- a summary of the whole public discussion. Cached in
//              thread_summaries, and therefore generated rarely: only when
//              there is no summary, the stored one has been invalidated, or
//              enough new replies have arrived to be worth the money.
//
//   catchup -- what happened since the viewer's own read position. This is
//              viewer-specific state and is NEVER written to a publicly
//              readable table; it is computed, returned with no-store, and
//              forgotten.
//
// What is deliberately NOT sent to the model: hidden replies, soft-deleted
// replies, anything from a private or hidden thread (the whole request is
// refused in that case), email addresses, and any profile column beyond the
// display name already shown on every rendered reply. The filter is applied
// twice -- once as a query predicate and once in JavaScript over the rows that
// came back -- because a filter that exists only in a query string is one
// PostgREST quirk away from not existing at all.

const MODEL_ID = 'claude-opus-5';
const PROMPT_VERSION = 'chabura-thread-v1';

// Thresholds. Documented, with their reasoning, in docs/AI_SUMMARIES.md.
const MIN_REPLIES_FOR_SUMMARY = 8;     // below this, reading the thread IS the summary
const REGENERATE_AFTER_REPLIES = 10;   // new replies before a fresh summary is worth paying for
const MIN_REGENERATE_INTERVAL_MS = 10 * 60 * 1000;
const MIN_CATCHUP_REPLIES = 3;
const MAX_SOURCE_REPLIES = 300;        // hard ceiling on what one request can cost
const MAX_BODY_CHARS = 1200;           // per reply, before truncation
const MAX_POINTS = 8;
const CATCHUP_COOLDOWN_MS = 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Environment -----------------------------------------------------------

function env(name) {
  // Netlify.env in production; process.env under `netlify dev` and in tests.
  if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(name) || '';
  return process.env[name] || '';
}

// The feature is optional by design. With no provider key configured the
// endpoint answers 503 'unconfigured' and the client hides the panel, which is
// the acceptance criterion "failure falls back to the normal thread" in its
// most common form: a deploy that simply has not been given a key.
function readConfig() {
  return {
    anthropicKey: env('ANTHROPIC_API_KEY'),
    supabaseUrl: (env('SUPABASE_URL') || env('VITE_SUPABASE_URL')).replace(/\/+$/, ''),
    anonKey: env('SUPABASE_ANON_KEY'),
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

// --- Supabase over plain HTTP ----------------------------------------------

async function pg(config, path, { token, service = false, method = 'GET', body, prefer } = {}) {
  const key = service ? config.serviceKey : config.anonKey;
  const headers = {
    apikey: key,
    authorization: `Bearer ${service ? config.serviceKey : (token || key)}`,
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (prefer) headers.prefer = prefer;

  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`supabase ${response.status}`);
    error.status = response.status;
    error.detail = detail.slice(0, 400);
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function identify(config, token) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.anonKey, authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user && user.id ? user : null;
}

// --- Selection: what the model is allowed to see ---------------------------

// The second half of the two-layer filter. Applied to rows that already came
// back from a filtered query, over the caller's own RLS, and it still throws
// away anything hidden, deleted or empty -- because this is the last point at
// which a reply can be stopped from reaching a third party.
export function selectSourceReplies(rows, { sinceSequence = null } = {}) {
  return (rows || [])
    .filter((row) => row && row.id && !row.hidden && !row.deleted_at)
    .filter((row) => typeof row.body === 'string' && row.body.trim() && row.body.trim() !== '[deleted]')
    .filter((row) => (sinceSequence == null ? true : Number(row.activity_sequence) > Number(sinceSequence)))
    .sort((a, b) => Number(a.activity_sequence) - Number(b.activity_sequence))
    .slice(-MAX_SOURCE_REPLIES);
}

// Decides whether generating is worth doing at all. Separated out and exported
// because "do not generate on every page load" is a rule that deserves a test,
// not a comment.
export function decideThreadGeneration({ replyCount, existing, maxSequence, now, force = false }) {
  if (replyCount < MIN_REPLIES_FOR_SUMMARY) {
    return { generate: false, reason: 'too-short' };
  }
  if (!existing) return { generate: true, reason: 'none' };

  const age = now - (Date.parse(existing.generated_at || '') || 0);
  if (force) {
    // Even an explicit request respects the cooldown: "regenerate" is a button
    // any reader can press, and a button any reader can press is a cost anyone
    // can run up.
    if (age < MIN_REGENERATE_INTERVAL_MS) return { generate: false, reason: 'cooling-down' };
    return { generate: true, reason: 'requested' };
  }
  if (existing.stale) {
    if (age < MIN_REGENERATE_INTERVAL_MS) return { generate: false, reason: 'cooling-down' };
    return { generate: true, reason: 'stale' };
  }
  const newReplies = Number(maxSequence) - Number(existing.source_max_sequence || 0);
  if (newReplies >= REGENERATE_AFTER_REPLIES) {
    if (age < MIN_REGENERATE_INTERVAL_MS) return { generate: false, reason: 'cooling-down' };
    return { generate: true, reason: 'new-activity' };
  }
  return { generate: false, reason: 'current' };
}

// --- Prompt ----------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You summarise a study discussion about a passage of Talmud for readers who have not read it yet.',
  '',
  'Rules you must not break:',
  '- You are describing what PARTICIPANTS SAID. You are not deciding anything.',
  '- Never state or imply a halachic ruling, a practical decision, or that a question is settled.',
  '  If participants disagree, say that they disagree and describe both sides. If a question is left',
  '  open, say it was left open. Never resolve it yourself.',
  '- Never add information that is not in the replies you were given: no outside sources, no citations',
  '  the participants did not make, no background you happen to know.',
  '- Attribute carefully. "One participant suggested" is right; "the correct answer is" is not.',
  '- Every point must cite the reply numbers it came from, using the [n] labels given to you.',
  '  A point you cannot cite must not be written.',
  '',
  'Return ONLY a JSON object, with no prose around it and no code fence:',
  '{"points":[{"text":"...","sources":[1,4]}]}',
  `Write at most ${MAX_POINTS} points, each one or two plain sentences, in the order the discussion took them.`,
].join('\n');

export function buildUserPrompt({ note, replies, mode }) {
  const lines = [];
  lines.push(`Passage: ${note.segment_ref || 'unknown'}`);
  if (note.selected_text) lines.push(`Words the discussion is anchored to: ${note.selected_text}`);
  lines.push('');
  lines.push('Opening post:');
  lines.push(`${note.author_display_name || 'A participant'}: ${truncate(note.body, MAX_BODY_CHARS)}`);
  lines.push('');
  lines.push(mode === 'catchup'
    ? 'Replies posted since this reader last read the discussion:'
    : 'Replies, in order:');
  replies.forEach((reply, index) => {
    lines.push(`[${index + 1}] ${reply.author_display_name || 'A participant'}: ${truncate(reply.body, MAX_BODY_CHARS)}`);
  });
  lines.push('');
  lines.push(mode === 'catchup'
    ? 'Summarise only what these new replies added, for someone who already read everything before them.'
    : 'Summarise the discussion.');
  return lines.join('\n');
}

function truncate(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

// --- Response handling -----------------------------------------------------

// Models are asked for bare JSON and usually give it; a code fence or a
// sentence of preamble is a formatting slip, not a reason to fail the request.
export function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// The traceability gate. A point whose citations do not resolve to replies that
// were actually sent to the model is DROPPED, not repaired: an uncitable
// sentence about a Torah discussion is exactly what this feature must not
// publish. The same rule is a NOT NULL + cardinality check in the database, so
// a bug here fails loudly rather than storing an unsourced claim.
export function validatePoints(parsed, replies) {
  const points = Array.isArray(parsed && parsed.points) ? parsed.points : [];
  const out = [];
  for (const point of points) {
    const text = typeof point?.text === 'string' ? point.text.trim() : '';
    if (!text || text.length > 800) continue;
    const indices = Array.isArray(point?.sources) ? point.sources : [];
    const ids = [];
    for (const index of indices) {
      const position = Number(index);
      if (!Number.isInteger(position) || position < 1 || position > replies.length) continue;
      const id = replies[position - 1].id;
      if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) continue;
    out.push({ text, source_comment_ids: ids.slice(0, 12) });
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

// --- The model call --------------------------------------------------------

async function generatePoints(config, { note, replies, mode }) {
  // Imported lazily so an unconfigured deploy -- the common case until a key is
  // set -- never pays to load the SDK, and so the pure helpers above can be
  // unit-tested without it.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: config.anthropicKey });

  const started = Date.now();
  // Streamed because a long discussion is a long request, and a non-streaming
  // call with a large max_tokens is the classic way to hit a request timeout.
  const stream = anthropic.messages.stream({
    model: MODEL_ID,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: buildUserPrompt({ note, replies, mode }) }],
  });
  const message = await stream.finalMessage();

  const text = (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return {
    points: validatePoints(extractJson(text), replies),
    generationMs: Date.now() - started,
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
  };
}

// --- Cache writes (service role) -------------------------------------------

async function storeSummary(config, { note, replies, points, generationMs, inputTokens, outputTokens, previousVersion }) {
  // Replace rather than accumulate: a superseded summary is unreachable text
  // derived from replies that may since have been moderated. The delete
  // cascades to its points.
  await pg(config, `thread_summaries?note_id=eq.${note.id}&scope=eq.thread`, {
    service: true, method: 'DELETE',
  });

  const maxSequence = replies.reduce((max, row) => Math.max(max, Number(row.activity_sequence) || 0), 0);
  const inserted = await pg(config, 'thread_summaries', {
    service: true,
    method: 'POST',
    prefer: 'return=representation',
    body: [{
      note_id: note.id,
      scope: 'thread',
      summary_version: (previousVersion || 0) + 1,
      prompt_version: PROMPT_VERSION,
      model_id: MODEL_ID,
      source_comment_ids: replies.map((row) => row.id),
      source_comment_count: replies.length,
      source_max_sequence: maxSequence,
      generation_ms: generationMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    }],
  });

  const summary = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!summary) throw new Error('summary-insert-failed');

  await pg(config, 'thread_summary_points', {
    service: true,
    method: 'POST',
    body: points.map((point, index) => ({
      summary_id: summary.id,
      position: index,
      body: point.text,
      source_comment_ids: point.source_comment_ids,
    })),
  });

  return summary;
}

// Best-effort, per-instance catch-up throttle. Serverless instances are not
// shared, so this is a speed bump rather than a limit -- said plainly here so
// nobody later mistakes it for one. The real cost control is that catch-up is
// only offered when a viewer has unread replies at all.
const catchupSeen = new Map();
function catchupCoolingDown(userId, now) {
  const last = catchupSeen.get(userId);
  if (last && now - last < CATCHUP_COOLDOWN_MS) return true;
  catchupSeen.set(userId, now);
  if (catchupSeen.size > 500) catchupSeen.clear();
  return false;
}

// --- Handler ---------------------------------------------------------------

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method-not-allowed' }, { status: 405 });
  }

  const config = readConfig();
  if (!config.anthropicKey || !config.supabaseUrl || !config.anonKey) {
    return Response.json({ error: 'unconfigured' }, { status: 503 });
  }

  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return Response.json({ error: 'sign-in-required' }, { status: 401 });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'bad-request' }, { status: 400 });
  }

  const noteId = String(payload?.noteId || '');
  const mode = payload?.mode === 'catchup' ? 'catchup' : 'thread';
  if (!UUID_RE.test(noteId)) return Response.json({ error: 'bad-request' }, { status: 400 });
  if (mode === 'thread' && !config.serviceKey) {
    return Response.json({ error: 'unconfigured' }, { status: 503 });
  }

  const user = await identify(config, token);
  if (!user) return Response.json({ error: 'sign-in-required' }, { status: 401 });

  try {
    // Read as the caller: RLS decides what this function can see.
    const notes = await pg(
      config,
      `line_notes?id=eq.${noteId}&select=id,author_id,author_display_name,body,segment_ref,daf_ref_key,` +
        `selected_text,is_private,hidden,deleted_at,status`,
      { token },
    );
    const note = Array.isArray(notes) ? notes[0] : null;
    if (!note) return Response.json({ error: 'not-found' }, { status: 404 });

    // Only PUBLIC threads are summarised, including for their own author. A
    // private note is a private note; summarising it would put its text through
    // a third party for no reader who could ever be shown the result.
    if (note.is_private || note.hidden || note.deleted_at) {
      return Response.json({ error: 'not-public' }, { status: 403 });
    }

    // The since-filter is pushed into the query for catch-up rather than
    // applied afterwards: on a thread longer than the row limit, filtering in
    // JavaScript would fetch the OLDEST replies and then discard all of them.
    const since = mode === 'catchup' ? Number(payload?.sinceSequence) : null;
    if (mode === 'catchup' && (!Number.isFinite(since) || since < 0)) {
      return Response.json({ error: 'bad-request' }, { status: 400 });
    }
    const rows = await pg(
      config,
      `comments?note_id=eq.${noteId}&hidden=is.false&deleted_at=is.null` +
        (mode === 'catchup' ? `&activity_sequence=gt.${since}` : '') +
        `&select=id,body,author_display_name,activity_sequence,hidden,deleted_at` +
        `&order=activity_sequence.asc&limit=${MAX_SOURCE_REPLIES + 50}`,
      { token },
    );

    if (mode === 'catchup') {
      const replies = selectSourceReplies(rows, { sinceSequence: since });
      if (replies.length < MIN_CATCHUP_REPLIES) {
        return Response.json(
          { status: 'not-eligible', reason: 'too-few-new', newReplies: replies.length },
          { headers: { 'cache-control': 'private, no-store' } },
        );
      }
      if (catchupCoolingDown(user.id, Date.now())) {
        return Response.json({ status: 'not-eligible', reason: 'cooling-down' },
          { status: 429, headers: { 'cache-control': 'private, no-store' } });
      }

      const result = await generatePoints(config, { note, replies, mode: 'catchup' });
      if (!result.points.length) {
        return Response.json({ error: 'no-citable-points' }, { status: 502 });
      }
      // Returned and forgotten. Never written to any table, and marked
      // no-store so no shared cache in front of this function keeps one
      // viewer's read position and serves it to another.
      return Response.json({
        status: 'ok',
        mode: 'catchup',
        model_id: MODEL_ID,
        generated_at: new Date().toISOString(),
        source_comment_count: replies.length,
        points: result.points,
      }, { headers: { 'cache-control': 'private, no-store' } });
    }

    const replies = selectSourceReplies(rows);
    const maxSequence = replies.reduce((max, row) => Math.max(max, Number(row.activity_sequence) || 0), 0);

    const existingRows = await pg(
      config,
      `thread_summaries?note_id=eq.${noteId}&scope=eq.thread&select=id,summary_version,generated_at,stale,source_max_sequence`,
      { token },
    );
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;

    const decision = decideThreadGeneration({
      replyCount: replies.length,
      existing,
      maxSequence,
      now: Date.now(),
      force: payload?.force === true,
    });

    if (!decision.generate) {
      return Response.json({
        status: 'not-eligible',
        reason: decision.reason,
        summaryId: existing ? existing.id : null,
        minReplies: MIN_REPLIES_FOR_SUMMARY,
      }, { status: decision.reason === 'cooling-down' ? 429 : 200 });
    }

    const result = await generatePoints(config, { note, replies, mode: 'thread' });
    if (!result.points.length) {
      return Response.json({ error: 'no-citable-points' }, { status: 502 });
    }

    const summary = await storeSummary(config, {
      note,
      replies,
      points: result.points,
      generationMs: result.generationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      previousVersion: existing ? existing.summary_version : 0,
    });

    // The client re-reads the stored rows through RLS rather than trusting this
    // response body, so only the id and the provenance come back.
    return Response.json({
      status: 'ok',
      mode: 'thread',
      summaryId: summary.id,
      summary_version: summary.summary_version,
      model_id: MODEL_ID,
      generated_at: summary.generated_at,
      point_count: result.points.length,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    // Never echo the upstream message: a PostgREST or provider error can carry
    // internal hostnames, row contents and key prefixes. Same rule as
    // link-preview.mjs.
    console.error('chabura-summary failed', error && error.message, error && error.detail);
    return Response.json({ error: 'generation-failed' }, { status: 502 });
  }
};

export const config = { path: '/api/chabura/summary' };

export const __testing = {
  MIN_REPLIES_FOR_SUMMARY,
  REGENERATE_AFTER_REPLIES,
  MIN_REGENERATE_INTERVAL_MS,
  MIN_CATCHUP_REPLIES,
  MAX_SOURCE_REPLIES,
  MAX_POINTS,
  MODEL_ID,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  truncate,
};
