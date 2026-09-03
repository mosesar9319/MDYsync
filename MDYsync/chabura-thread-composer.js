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

  function draftKey(noteId, parentId) {
    return `${DRAFT_PREFIX}:${noteId}:${parentId || 'root'}`;
  }

  // localStorage throws in some privacy modes; a lost draft must never take the
  // composer down with it.
  function readDraft(noteId, parentId) {
    try {
      const raw = localStorage.getItem(draftKey(noteId, parentId));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function writeDraft(noteId, parentId, value) {
    try {
      if (!value || !value.body.trim()) localStorage.removeItem(draftKey(noteId, parentId));
      else localStorage.setItem(draftKey(noteId, parentId), JSON.stringify(value));
    } catch { /* a browser refusing storage is not an error worth surfacing */ }
  }

  function clearDraft(noteId, parentId) {
    try { localStorage.removeItem(draftKey(noteId, parentId)); } catch { /* ignore */ }
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  }

  // options: { noteId, parentId, parentName, participants, quote, onSubmit,
  //            onCancel, onDirtyChange, autoFocus, disabledReason }
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
      candidates.forEach((person) => {
        const selected = state.mentions.has(person.id);
        const chip = button(`ct-mention-chip${selected ? ' is-selected' : ''}`, person.name, () => {
          if (state.mentions.has(person.id)) state.mentions.delete(person.id);
          else state.mentions.set(person.id, person.name);
          renderMentions();
          persist();
        }, { pressed: selected, ariaLabel: `${selected ? 'Remove mention of' : 'Mention'} ${person.name}` });
        chip.dataset.userId = person.id;
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
      writeDraft(options.noteId, options.parentId, snapshot());
      options.onDirtyChange?.(isDirty());
    }, 250);

    function restore() {
      const draft = readDraft(options.noteId, options.parentId);
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
        clearDraft(options.noteId, options.parentId);
        updateCounter();
      } catch (err) {
        // The complete draft survives, including the quote and mentions.
        showError(window.DafSyncChabura.threadData.describeError(err));
        writeDraft(options.noteId, options.parentId, snapshot());
      } finally {
        state.submitting = false;
        submit.disabled = false;
        submit.textContent = options.parentId ? 'Post reply' : 'Post';
      }
    }

    function tryCancel() {
      if (isDirty() && !window.confirm('Discard this draft?')) return;
      clearDraft(options.noteId, options.parentId);
      options.onCancel?.();
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); doSubmit(); });
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
        if (!isDirty()) { clearDraft(options.noteId, options.parentId); options.onCancel?.(); return; }
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

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.threadComposer = {
    BODY_LIMIT,
    COUNTER_VISIBLE_FROM,
    draftKey,
    readDraft,
    writeDraft,
    clearDraft,
    createComposer,
  };
})();
