'use strict';

// The generated-summary panel for a Cloud Chabura thread.
//
// This file holds no provider credential and no prompt. It reads summaries the
// database already has, and asks the server to make one when the reader asks
// for it. The server decides whether that is allowed, whether it is worth the
// money, and what the model is permitted to see -- see
// netlify/functions/chabura-summary.mjs.
//
// Three things are load-bearing here rather than cosmetic:
//
//   * Every state this panel can be in ends with the thread being readable.
//     No provider key, a failed request, a refused request, a summary that is
//     stale, a point a moderator withdrew -- each renders as its own quiet
//     message and nothing else on the page changes. A summary is an aid to
//     reading the discussion, never a substitute for it and never a gate.
//
//   * Every point carries links to the replies it came from, built from
//     source_comment_ids. A point with no sources cannot exist (the database
//     refuses it), so a point with no links here is a bug, not a state.
//
//   * The panel says what it is. "Generated summary", the model that wrote it,
//     when, and the standing caveat that it describes what people said and
//     decides nothing.

(function () {
  const { client, currentUser, describeError } = window.DafSyncChabura.core;

  const ENDPOINT = '/api/chabura/summary';

  // Matches MIN_REPLIES_FOR_SUMMARY in the function. Duplicated deliberately:
  // the client uses it only to decide whether to show a button, and the server
  // enforces it. If they drift, the server wins and the button is a wasted
  // click -- not a bypass.
  const MIN_REPLIES_FOR_SUMMARY = 8;
  const MIN_CATCHUP_REPLIES = 3;

  const CAVEAT = 'Generated from the replies below. It describes what participants said and does not decide anything — for a ruling, ask your rav.';

  // --- Reading ---------------------------------------------------------------

  // Two reads, both under RLS: the summary header, then its points through the
  // projection view that blanks anything redacted. The viewer's own feedback
  // row is a third, and only when signed in.
  async function fetchSummary(noteId) {
    const { data: rows, error } = await client()
      .from('thread_summaries')
      .select('id, summary_version, model_id, generated_at, generation_ms, source_comment_count, ' +
              'source_max_sequence, stale, stale_reason, hidden, useful_count, not_useful_count')
      .eq('note_id', noteId).eq('scope', 'thread')
      .maybeSingle();
    if (error) throw error;
    if (!rows) return null;

    const { data: points, error: pointsError } = await client()
      .from('thread_summary_points_public')
      .select('id, position, body, source_comment_ids, redacted, moderator_edited')
      .eq('summary_id', rows.id)
      .order('position', { ascending: true });
    if (pointsError) throw pointsError;

    let myVerdict = null;
    const user = currentUser();
    if (user) {
      const { data: feedback } = await client()
        .from('thread_summary_feedback').select('verdict')
        .eq('summary_id', rows.id).eq('user_id', user.id).maybeSingle();
      myVerdict = feedback?.verdict || null;
    }

    return { ...rows, points: points || [], myVerdict };
  }

  // --- Server requests -------------------------------------------------------

  async function accessToken() {
    const session = await window.DafSyncAuth?.client?.auth?.getSession?.();
    return session?.data?.session?.access_token || null;
  }

  async function post(body) {
    const token = await accessToken();
    if (!token) return { ok: false, status: 401, body: { error: 'sign-in-required' } };
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body: payload };
  }

  function requestThreadSummary(noteId, { force = false } = {}) {
    return post({ noteId, mode: 'thread', force });
  }

  function requestCatchup(noteId, sinceSequence) {
    return post({ noteId, mode: 'catchup', sinceSequence });
  }

  // Errors the reader can do something about get their own wording; everything
  // else is one honest sentence. The panel is never allowed to show a raw
  // provider or PostgREST message.
  function describeRequestFailure(result) {
    const code = result?.body?.error || result?.body?.reason || '';
    if (result?.status === 503 || code === 'unconfigured') return 'Summaries are not switched on for this site.';
    if (result?.status === 401 || code === 'sign-in-required') return 'Sign in to generate a summary.';
    if (code === 'not-public') return 'Only public discussions can be summarised.';
    if (code === 'not-found') return 'This discussion is no longer available.';
    if (code === 'cooling-down') return 'This was summarised very recently. Try again in a few minutes.';
    if (code === 'too-short') return `Summaries start once a discussion has ${MIN_REPLIES_FOR_SUMMARY} replies.`;
    if (code === 'too-few-new') return 'There is not much new here — reading it will be quicker.';
    if (code === 'no-citable-points') return 'Nothing could be summarised without misrepresenting the discussion.';
    return 'The summary could not be generated. The discussion below is unaffected.';
  }

  // --- Feedback and reporting ------------------------------------------------

  // Clicking the verdict you already gave withdraws it, which is why this
  // returns the new verdict rather than assuming it.
  async function setFeedback(summaryId, verdict, currentVerdict) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to give feedback.');
    if (currentVerdict === verdict) {
      const { error } = await client().from('thread_summary_feedback')
        .delete().eq('summary_id', summaryId).eq('user_id', user.id);
      if (error) throw error;
      return null;
    }
    const { error } = await client().from('thread_summary_feedback')
      .upsert({ summary_id: summaryId, user_id: user.id, verdict });
    if (error) throw error;
    return verdict;
  }

  async function reportSummary(summaryId, reason) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to report this.');
    const { error } = await client().from('reports').insert({
      reporter_id: user.id,
      target_type: 'summary',
      target_id: summaryId,
      reason: String(reason || '').slice(0, 500),
    });
    if (error) throw error;
  }

  async function moderateSummary(summaryId, hidden, reason) {
    const { error } = await client().rpc('moderate_thread_summary', {
      p_summary_id: summaryId, p_hidden: hidden, p_reason: reason || null,
    });
    if (error) throw error;
  }

  async function moderatePoint(pointId, { redact = false, body = null } = {}) {
    const { error } = await client().rpc('moderate_thread_summary_point', {
      p_point_id: pointId, p_redact: redact, p_body: body,
    });
    if (error) throw error;
  }

  // --- Rendering -------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(className, label, onClick, options = {}) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
    if (options.pressed != null) node.setAttribute('aria-pressed', String(options.pressed));
    node.addEventListener('click', onClick);
    return node;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return '';
    return when.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  // The citation links. `resolve` turns a comment id into something the reader
  // can click -- the controller supplies it, because only the controller knows
  // whether that reply is already on screen (scroll to it) or in a branch that
  // has not been loaded yet (a permalink that will load it).
  function sourceLinks(point, { noteId, resolve }) {
    const wrap = el('span', 'cs-sources');
    wrap.appendChild(el('span', 'cs-sources-label', 'From: '));
    point.source_comment_ids.forEach((commentId, index) => {
      const link = el('a', 'cs-source-link', `reply ${index + 1}`);
      link.href = `/chaburah/thread/?thread=${encodeURIComponent(noteId)}&comment=${encodeURIComponent(commentId)}`;
      link.setAttribute('aria-label', `Go to supporting reply ${index + 1} of ${point.source_comment_ids.length}`);
      if (typeof resolve === 'function') {
        link.addEventListener('click', (event) => {
          // Only intercept a plain click: ctrl/cmd/middle-click must keep
          // opening a real permalink in a new tab.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          if (resolve(commentId) === true) event.preventDefault();
        });
      }
      wrap.appendChild(link);
      if (index < point.source_comment_ids.length - 1) wrap.appendChild(document.createTextNode(', '));
    });
    return wrap;
  }

  function pointItem(point, options) {
    const item = el('li', 'cs-point');
    if (point.redacted) {
      item.classList.add('cs-point-redacted');
      item.appendChild(el('p', 'cs-point-body',
        'This point was withdrawn because a reply it relied on was removed.'));
      return item;
    }
    item.appendChild(el('p', 'cs-point-body', point.body));

    const foot = el('p', 'cs-point-foot');
    foot.appendChild(sourceLinks(point, options));
    if (point.moderator_edited) {
      foot.appendChild(el('span', 'cs-badge', 'edited by a moderator'));
    }
    item.appendChild(foot);

    if (options.isAdmin) {
      const tools = el('div', 'cs-point-tools');
      tools.appendChild(button('cc-btn cc-btn-sm', 'Withdraw', () => options.onWithdrawPoint(point)));
      tools.appendChild(button('cc-btn cc-btn-sm', 'Reword', () => options.onRewordPoint(point)));
      item.appendChild(tools);
    }
    return item;
  }

  function header(summary, options) {
    // options.headingId is supplied by renderInto, never hardcoded.
    const head = el('div', 'cs-head');

    const title = el('h2', 'cs-title', options.mode === 'catchup' ? 'What you missed' : 'Summary of this discussion');
    title.id = options.headingId;
    head.appendChild(title);

    const badge = el('span', 'cs-ai-badge', 'Generated');
    badge.title = 'Written by a language model, not by a participant.';
    head.appendChild(badge);

    const meta = el('p', 'cs-meta');
    const parts = [];
    if (summary.model_id) parts.push(`Model: ${summary.model_id}`);
    if (summary.generated_at) parts.push(`Generated ${formatTime(summary.generated_at)}`);
    if (summary.source_comment_count != null) parts.push(`from ${summary.source_comment_count} replies`);
    meta.textContent = parts.join(' · ');
    head.appendChild(meta);

    return head;
  }

  function notice(text, className) {
    const box = el('p', `cs-notice ${className || ''}`.trim(), text);
    box.setAttribute('role', 'note');
    return box;
  }

  // Renders the whole panel into `host`. Every branch is a complete, readable
  // state -- there is no path here that leaves the host half-built.
  function renderInto(host, model) {
    if (!host) return;
    host.innerHTML = '';

    if (!model || model.state === 'hidden') {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    const panel = el('section', 'cs-panel');
    // Derived from the host, because the catch-up panel and the thread summary
    // can both be on the page at once and two elements may not share an id.
    const headingId = `${host.id || 'cs'}Heading`;
    panel.setAttribute('aria-labelledby', headingId);

    // Nothing to offer and nothing to show, but something to say -- an
    // unconfigured endpoint, or a request that failed after the offer was
    // dismissed. A button here would only invite a second failure.
    if (model.state === 'error') {
      const heading = el('h2', 'cs-title', 'Summary of this discussion');
      heading.id = headingId;
      panel.appendChild(heading);
      panel.appendChild(notice(model.error, 'cs-notice-error'));
      host.appendChild(panel);
      return;
    }

    if (model.state === 'offer') {
      const heading = el('h2', 'cs-title', model.offerHeading || 'Summary of this discussion');
      heading.id = headingId;
      panel.appendChild(heading);
      panel.appendChild(el('p', 'cs-note', model.offerText));
      const action = button('cc-btn cc-btn-primary cc-btn-sm', model.busy ? 'Summarising…' : 'Summarise this discussion',
        model.onGenerate);
      action.disabled = Boolean(model.busy);
      panel.appendChild(action);
      if (model.error) panel.appendChild(notice(model.error, 'cs-notice-error'));
      host.appendChild(panel);
      return;
    }

    const summary = model.summary;
    panel.appendChild(header(summary, { ...model, headingId }));
    panel.appendChild(el('p', 'cs-caveat', CAVEAT));

    if (summary.stale) {
      panel.appendChild(notice(
        summary.stale_reason && summary.stale_reason.startsWith('source-')
          ? 'A reply this summary was based on has changed or been removed since it was written.'
          : 'The discussion has moved on since this was written.',
        'cs-notice-stale'));
    }

    const list = el('ul', 'cs-points');
    summary.points.forEach((point) => list.appendChild(pointItem(point, model)));
    panel.appendChild(list);

    if (model.state === 'catchup') {
      // Catch-up is computed for this reader and never stored, so it carries
      // no feedback controls: there is no shared row to attach an opinion to.
      panel.appendChild(el('p', 'cs-note', 'Worked out for you just now, and not saved.'));
      host.appendChild(panel);
      return;
    }

    const actions = el('div', 'cs-actions');
    if (model.signedIn) {
      actions.appendChild(button('cc-btn cc-btn-sm', 'Useful',
        () => model.onFeedback('useful'), { pressed: summary.myVerdict === 'useful' }));
      actions.appendChild(button('cc-btn cc-btn-sm', 'Not useful',
        () => model.onFeedback('not_useful'), { pressed: summary.myVerdict === 'not_useful' }));
    }
    if (summary.useful_count || summary.not_useful_count) {
      actions.appendChild(el('span', 'cs-tally',
        `${summary.useful_count || 0} found this useful · ${summary.not_useful_count || 0} did not`));
    }
    if (model.canRegenerate) {
      const regen = button('cc-btn cc-btn-sm', model.busy ? 'Regenerating…' : 'Regenerate', model.onRegenerate);
      regen.disabled = Boolean(model.busy);
      actions.appendChild(regen);
    }
    if (model.signedIn) {
      actions.appendChild(button('cc-btn cc-btn-sm', 'Report', model.onReport));
    }
    if (model.isAdmin) {
      actions.appendChild(button('cc-btn cc-btn-sm', summary.hidden ? 'Unhide summary' : 'Hide summary',
        model.onModerate));
    }
    panel.appendChild(actions);

    if (summary.hidden) {
      panel.appendChild(notice('You are seeing this because you moderate. Readers cannot see it.', 'cs-notice-stale'));
    }
    if (model.error) panel.appendChild(notice(model.error, 'cs-notice-error'));

    host.appendChild(panel);
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.summary = {
    MIN_REPLIES_FOR_SUMMARY,
    MIN_CATCHUP_REPLIES,
    CAVEAT,
    fetchSummary,
    requestThreadSummary,
    requestCatchup,
    describeRequestFailure,
    setFeedback,
    reportSummary,
    moderateSummary,
    moderatePoint,
    renderInto,
    describeError,
    __testing: { formatTime, sourceLinks, pointItem },
  };
})();
