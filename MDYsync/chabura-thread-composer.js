'use strict';

// The Cloud Chabura reply composer.
//
// A real <textarea>, not a contenteditable surface -- the plan's explicit
// choice for the first implementation, and the reason paste, undo, spellcheck,
// IME input and mobile keyboards all behave without being reimplemented.
//
// Deliberately NOT maxlength="2000" the way the old note dialog's composer is.
// maxlength truncates silently at the moment of typing or pasting: a reader who
// pastes three paragraphs loses the tail with no message at all. The plan says
// "Do not silently truncate text", so the limit is enforced by a visible count
// and a blocked submit that says what to do.

(function () {
  const { el, button } = window.DafSyncChabura.threadView;

  const BODY_LIMIT = 2000;
  const COUNTER_VISIBLE_FROM = BODY_LIMIT - 200; // "only near the limit"
  const DRAFT_PREFIX = 'dafsync.chabura.draft';
  // Bumped when the key shape changes. v1 keys were NOT scoped to an account,
  // so any left on a device are discarded rather than migrated -- see below.
  const DRAFT_VERSION = 'v2';

  // Scoped to the ACCOUNT as well as the thread and reply target. Without the
  // user id, signing out and signing in as someone else on the same device
  // restored the first account's unsent draft into the second account's
  // composer -- someone else's half-written words, attributed to whoever hit
  // Post. A signed-out reader gets no draft storage at all, since there is
  // nobody to attribute it to.
  function draftKey(userId, noteId, parentId) {
    if (!userId) return null;
    return `${DRAFT_PREFIX}.${DRAFT_VERSION}:${userId}:${noteId}:${parentId || 'root'}`;
  }

  // localStorage throws in some privacy modes; a lost draft must never take the
  // composer down with it.
  function readDraft(userId, noteId, parentId) {
    const key = draftKey(userId, noteId, parentId);
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function writeDraft(userId, noteId, parentId, value) {
    const key = draftKey(userId, noteId, parentId);
    if (!key) return;
    try {
      if (!value || !value.body.trim()) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* a browser refusing storage is not an error worth surfacing */ }
  }

  function clearDraft(userId, noteId, parentId) {
    const key = draftKey(userId, noteId, parentId);
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  // Unscoped v1 drafts are DELETED, never adopted. Adopting one would hand
  // whoever signs in next the previous account's words -- exactly the defect
  // the version bump exists to close. Losing an old draft is the safe failure.
  function purgeUnscopedDrafts() {
    try {
      const stale = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(`${DRAFT_PREFIX}:`)) stale.push(key);
      }
      stale.forEach((key) => localStorage.removeItem(key));
    } catch { /* ignore */ }
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  }

  // options: { noteId, parentId, parentName, participants, quote, onSubmit,
  //            onCancel, onDirtyChange, autoFocus, disabledReason }
  function currentViewerId() {
    return window.DafSyncAuth?.getUser?.()?.id || null;
  }

  function createComposer(options) {
    const state = {
      quote: options.quote || null,
      mentions: new Map(), // userId -> display name
      submitting: false,
    };

    const form = el('form', 'ct-composer');
    form.setAttribute('aria-label', options.parentId ? `Reply to ${options.parentName || 'this reply'}` : 'Reply to this discussion');

    if (options.disabledReason) {
      form.appendChild(el('p', 'ct-composer-disabled', options.disabledReason));
      return { node: form, focus() {}, isDirty: () => false, destroy() {} };
    }

    if (options.parentId) {
      const context = el('p', 'ct-composer-context');
      context.append(document.createTextNode('Replying to '));
      context.appendChild(el('strong', null, options.parentName || 'this reply'));
      const cancel = button('cc-btn cc-btn-quiet cc-btn-sm', 'Cancel', () => tryCancel());
      context.appendChild(cancel);
      form.appendChild(context);
    }

    const quoteSlot = el('div', 'ct-composer-quote');
    form.appendChild(quoteSlot);

    const textarea = document.createElement('textarea');
    textarea.className = 'ct-composer-input';
    textarea.rows = options.parentId ? 3 : 4;
    textarea.placeholder = options.parentId ? 'Write a reply…' : 'Add to this discussion…';
    textarea.setAttribute('aria-describedby', 'ct-composer-help');
    form.appendChild(textarea);

    const restored = el('p', 'ct-composer-restored');
    restored.hidden = true;
    form.appendChild(restored);

    const mentionRow = el('div', 'ct-mentions');
    form.appendChild(mentionRow);

    const footer = el('div', 'ct-composer-footer');
    const counter = el('span', 'ct-composer-count');
    counter.setAttribute('aria-live', 'polite');
    counter.hidden = true;
    const help = el('span', 'ct-composer-help', 'Ctrl+Enter to post');
    help.id = 'ct-composer-help';
    const submit = el('button', 'cc-btn cc-btn-primary cc-btn-sm', options.parentId ? 'Post reply' : 'Post');
    submit.type = 'submit';
    const error = el('p', 'ct-composer-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;

    footer.append(help, counter, submit);
    form.append(footer, error);

    // --- quote ---
    function renderQuote() {
      quoteSlot.innerHTML = '';
      if (!state.quote) return;
      const card = el('div', 'ct-quote ct-quote-draft');
      card.appendChild(el('p', 'ct-quote-head', `${state.quote.author} wrote`));
      card.appendChild(el('p', 'ct-quote-body', state.quote.excerpt));
      card.appendChild(button('cc-btn cc-btn-quiet cc-btn-sm', 'Remove quote', () => {
        state.quote = null;
        renderQuote();
        persist();
      }, { ariaLabel: 'Remove the quoted reply' }));
      quoteSlot.appendChild(card);
    }

    // --- mentions ---
    // Candidates stay limited to people already visible in this thread, which
    // is the existing server-side-adjacent rule; nothing here can surface a
    // user the reader could not already see, and no email is ever rendered.
    function renderMentions() {
      mentionRow.innerHTML = '';
      const candidates = (options.participants || []).filter((person) => person.id !== options.viewerId);
      if (!candidates.length) return;
      const label = el('span', 'ct-mentions-label', 'Mention:');
      mentionRow.appendChild(label);
      candidates.forEach((person, index) => {
        const selected = state.mentions.has(person.id);
        const chip = button(`ct-mention-chip${selected ? ' is-selected' : ''}`, person.name, () => {
          if (state.mentions.has(person.id)) state.mentions.delete(person.id);
          else state.mentions.set(person.id, person.name);
          renderMentions();
          persist();
          // Keep focus on the chip just toggled, not lost to the re-render.
          mentionRow.querySelector(`[data-user-id="${person.id}"]`)?.focus();
        }, { pressed: selected, ariaLabel: `${selected ? 'Remove mention of' : 'Mention'} ${person.name}` });
        chip.dataset.userId = person.id;
        // One tab stop for the whole group, then arrows within it -- the
        // standard toolbar pattern, so Tab still moves on to the textarea
        // instead of walking through every participant.
        chip.tabIndex = index === 0 ? 0 : -1;
        chip.addEventListener('keydown', (event) => {
          const chips = [...mentionRow.querySelectorAll('.ct-mention-chip')];
          const at = chips.indexOf(event.currentTarget);
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            chips[(at + 1) % chips.length]?.focus();
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            chips[(at - 1 + chips.length) % chips.length]?.focus();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            textarea.focus();
          }
        });
        mentionRow.appendChild(chip);
      });
    }

    // --- drafts ---
    function snapshot() {
      return {
        body: textarea.value,
        quote: state.quote,
        mentions: [...state.mentions.entries()].map(([id, name]) => ({ id, name })),
      };
    }

    const persist = debounce(() => {
      writeDraft(options.viewerId, options.noteId, options.parentId, snapshot());
      options.onDirtyChange?.(isDirty());
    }, 250);

    function restore() {
      const draft = readDraft(options.viewerId, options.noteId, options.parentId);
      if (!draft || !draft.body) return;
      textarea.value = draft.body;
      state.quote = draft.quote || state.quote;
      (draft.mentions || []).forEach((person) => state.mentions.set(person.id, person.name));
      restored.textContent = 'Draft restored from your last visit.';
      restored.hidden = false;
      updateCounter();
    }

    function isDirty() {
      return Boolean(textarea.value.trim());
    }

    function updateCounter() {
      const length = textarea.value.length;
      const near = length >= COUNTER_VISIBLE_FROM;
      counter.hidden = !near;
      if (near) {
        counter.textContent = `${length} / ${BODY_LIMIT}`;
        counter.classList.toggle('is-over', length > BODY_LIMIT);
      }
    }

    function showError(message) {
      error.textContent = message;
      error.hidden = false;
    }

    function clearError() {
      error.hidden = true;
      error.textContent = '';
    }

    async function doSubmit() {
      if (state.submitting) return;
      clearError();
      const body = textarea.value.trim();
      if (!body) { showError('Write something first.'); textarea.focus(); return; }
      // The LIVE viewer, not the one captured when the composer was built: a
      // session can end while a long reply is being written, and the captured
      // id would still look signed in.
      if (!currentViewerId()) {
        showError('Your session ended. Sign in again in another tab, then post — your text is still here.');
        return;
      }
      if (textarea.value.length > BODY_LIMIT) {
        // Says exactly how much has to go, and does not remove a character itself.
        showError(`This reply is ${textarea.value.length - BODY_LIMIT} characters over the ${BODY_LIMIT} limit. Shorten it and post again — nothing has been removed.`);
        textarea.focus();
        return;
      }

      state.submitting = true;
      submit.disabled = true;
      submit.textContent = 'Posting…';
      try {
        await options.onSubmit({
          body,
          mentionedUserIds: [...state.mentions.keys()],
          quotedCommentId: state.quote?.commentId || null,
          quotedExcerpt: state.quote?.excerpt || null,
        });
        // Only cleared once the server has actually accepted it.
        textarea.value = '';
        state.quote = null;
        state.mentions.clear();
        renderQuote();
        renderMentions();
        restored.hidden = true;
        clearDraft(options.viewerId, options.noteId, options.parentId);
        updateCounter();
      } catch (err) {
        // The complete draft survives, including the quote and mentions -- and
        // it is written BEFORE anything else can fail, so no path loses it.
        writeDraft(options.viewerId, options.noteId, options.parentId, snapshot());
        const data = window.DafSyncChabura.threadData;
        // A refused reply has several possible causes behind one error code;
        // ask which one rather than saying "no permission" and leaving the
        // reader to guess whether it was them, the thread, or the server.
        let message = null;
        try { message = await data.explainRejectedReply(options.noteId, err); } catch { /* keep the generic one */ }
        showError(message || data.describeError(err));
      } finally {
        state.submitting = false;
        submit.disabled = false;
        submit.textContent = options.parentId ? 'Post reply' : 'Post';
      }
    }

    function tryCancel() {
      if (isDirty() && !window.confirm('Discard this draft?')) return;
      clearDraft(options.viewerId, options.noteId, options.parentId);
      options.onCancel?.();
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); doSubmit(); });
    // When the on-screen keyboard opens it shrinks the visual viewport rather
    // than the layout one, so the footer can end up behind it with no scroll
    // having happened. Nudging the composer into the new visual viewport keeps
    // Post and Cancel reachable.
    textarea.addEventListener('focus', () => {
      setTimeout(() => form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 250);
    });
    textarea.addEventListener('input', () => { updateCounter(); persist(); clearError(); });
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        doSubmit();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!isDirty()) { clearDraft(options.viewerId, options.noteId, options.parentId); options.onCancel?.(); return; }
        tryCancel();
      }
    });

    renderQuote();
    renderMentions();
    restore();
    updateCounter();

    return {
      node: form,
      focus() { textarea.focus(); },
      isDirty,
      setQuote(quote) { state.quote = quote; renderQuote(); persist(); },
      destroy() { persist(); },
    };
  }

  // An edit is the same textarea with the same limit rules, seeded with the
  // existing body and saving in place. Built on the same primitives rather than
  // window.prompt(), which cannot show a character count, cannot preserve what
  // was typed if the save fails, and gives a screen reader no context at all.
  function createEditor({ body, onSave, onCancel }) {
    const form = el('form', 'ct-composer ct-editor');
    form.setAttribute('aria-label', 'Edit your post');

    const textarea = document.createElement('textarea');
    textarea.className = 'ct-composer-input';
    textarea.rows = 4;
    textarea.value = body || '';
    form.appendChild(textarea);

    const footer = el('div', 'ct-composer-footer');
    const counter = el('span', 'ct-composer-count');
    counter.setAttribute('aria-live', 'polite');
    counter.hidden = true;
    const save = el('button', 'cc-btn cc-btn-primary cc-btn-sm', 'Save changes');
    save.type = 'submit';
    const cancel = button('cc-btn cc-btn-sm', 'Cancel', () => tryCancel());
    footer.append(counter, cancel, save);
    const error = el('p', 'ct-composer-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.append(footer, error);

    function updateCounter() {
      const length = textarea.value.length;
      counter.hidden = length < COUNTER_VISIBLE_FROM;
      if (!counter.hidden) {
        counter.textContent = `${length} / ${BODY_LIMIT}`;
        counter.classList.toggle('is-over', length > BODY_LIMIT);
      }
    }

    function tryCancel() {
      if (textarea.value !== (body || '') && !window.confirm('Discard your changes?')) return;
      onCancel?.();
    }

    async function submit() {
      const next = textarea.value.trim();
      if (!next) { error.textContent = 'An edit cannot empty the post. Delete it instead.'; error.hidden = false; textarea.focus(); return; }
      if (textarea.value.length > BODY_LIMIT) {
        error.textContent = `This is ${textarea.value.length - BODY_LIMIT} characters over the ${BODY_LIMIT} limit. Shorten it — nothing has been removed.`;
        error.hidden = false;
        textarea.focus();
        return;
      }
      if (next === (body || '').trim()) { onCancel?.(); return; }
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        await onSave(next);
      } catch (err) {
        // The edited text stays on screen: a failed save must not silently
        // revert to the original and lose the rewrite.
        error.textContent = window.DafSyncChabura.threadData.describeError(err);
        error.hidden = false;
      } finally {
        save.disabled = false;
        save.textContent = 'Save changes';
      }
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
    textarea.addEventListener('input', () => { updateCounter(); error.hidden = true; });
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); tryCancel(); }
    });

    updateCounter();
    return { node: form, focus() { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); } };
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.threadComposer = {
    BODY_LIMIT,
    COUNTER_VISIBLE_FROM,
    DRAFT_VERSION,
    draftKey,
    readDraft,
    writeDraft,
    clearDraft,
    purgeUnscopedDrafts,
    createComposer,
    createEditor,
  };
})();
