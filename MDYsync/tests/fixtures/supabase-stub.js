'use strict';

// An in-memory stand-in for vendor/supabase-js.min.js, served in its place by
// the Playwright harness (tests/support/harness.mjs routes the vendor URL to
// this file). Replacing the vendored library outright -- rather than trying to
// pre-define window.supabase in an init script -- is the only approach that
// survives page load order: the real vendor script would simply overwrite an
// earlier definition, and auth.js runs its `typeof window.supabase.createClient
// !== 'function'` guard the moment it loads.
//
// It implements enough PostgREST query-builder surface for the client code in
// this repo (see tests/README.md for the enumerated operator list) over plain
// arrays supplied per test as window.__DAFSYNC_TEST_DB__.
//
// IMPORTANT, and stated here so a green test run is never mistaken for more
// than it is: this stub does NOT enforce Row Level Security. It answers every
// query as a trusted caller would. It exists to exercise CLIENT behaviour --
// rendering, pagination, optimistic updates, error handling, empty states --
// without writing to the production database. Authorization must be proven
// against the real database with real anon/authenticated/admin roles (that is
// Prompt 2's adversarial RLS/RPC test work), never here.
(function () {
  function clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // PostgREST `ilike` uses SQL wildcards (% and _), not regex, so escape
  // everything else before translating those two.
  function ilikeToRegExp(pattern) {
    const escaped = String(pattern)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    return new RegExp('^' + escaped + '$', 'i');
  }

  function compare(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    return a < b ? -1 : 1;
  }

  // --- PostgREST filter expressions ---------------------------------------
  // `.or()` takes a raw PostgREST expression string, not a builder call, so the
  // stub has to parse it. The keyset pagination in chabura-data.js sends
  //   last_activity_at.lt.<ts>,and(last_activity_at.eq.<ts>,id.lt.<id>)
  // which needs comma-splitting at depth 0, nested and(...) groups, and the
  // ordering operators. Kept deliberately small: it supports exactly the
  // grammar this repo emits, and throws on anything else rather than silently
  // matching every row and making a broken query look like a passing test.
  function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const character of text) {
      if (character === '(') { depth += 1; current += character; }
      else if (character === ')') { depth -= 1; current += character; }
      else if (character === ',' && depth === 0) { parts.push(current); current = ''; }
      else current += character;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
  }

  function parseExpression(text) {
    const group = /^(and|or)\(([\s\S]*)\)$/.exec(text.trim());
    if (group) {
      return { kind: group[1], children: splitTopLevel(group[2]).map(parseExpression) };
    }
    const firstDot = text.indexOf('.');
    const secondDot = text.indexOf('.', firstDot + 1);
    if (firstDot < 0 || secondDot < 0) {
      throw new Error('supabase-stub: cannot parse PostgREST filter "' + text + '"');
    }
    // A leaf that still contains a top-level comma or a group means the caller
    // handed a whole list where a single condition was expected. Left
    // unchecked, the remainder gets swallowed into the comparison VALUE and the
    // filter quietly matches the wrong rows -- which is exactly how a
    // mis-parsed keyset cursor let its own boundary row through twice.
    if (splitTopLevel(text).length > 1 || text.includes('(')) {
      throw new Error('supabase-stub: expected a single condition, got a list: "' + text + '"');
    }
    return {
      kind: 'leaf',
      column: text.slice(0, firstDot),
      operator: text.slice(firstDot + 1, secondDot),
      value: text.slice(secondDot + 1),
    };
  }

  // `.is(col, null)` and `.not(col, 'is', null)` both land here. PostgREST
  // spells the null literal as the bare word "null" inside an expression
  // string and as a real null when passed through the builder.
  function isNullish(value) { return value === null || value === undefined; }

  function testIs(value, target) {
    if (target === null || target === 'null') return isNullish(value);
    if (target === true || target === 'true') return value === true;
    if (target === false || target === 'false') return value === false;
    return value === target;
  }

  function evaluate(row, node) {
    if (node.kind === 'and') return node.children.every((child) => evaluate(row, child));
    if (node.kind === 'or') return node.children.some((child) => evaluate(row, child));
    const value = row[node.column];
    const target = node.value;
    switch (node.operator) {
      case 'eq': return String(value) === String(target);
      case 'neq': return String(value) !== String(target);
      case 'lt': return !isNullish(value) && compare(value, target) < 0;
      case 'lte': return !isNullish(value) && compare(value, target) <= 0;
      case 'gt': return !isNullish(value) && compare(value, target) > 0;
      case 'gte': return !isNullish(value) && compare(value, target) >= 0;
      case 'is': return testIs(value, target);
      default: throw new Error('supabase-stub: unsupported PostgREST operator "' + node.operator + '"');
    }
  }

  function createClient() {
    const db = window.__DAFSYNC_TEST_DB__ || {};
    const control = window.__DAFSYNC_TEST_CONTROL__ || {};
    let session = window.__DAFSYNC_TEST_SESSION__ || null;
    const authListeners = new Set();

    function table(name) {
      if (!Array.isArray(db[name])) db[name] = [];
      return db[name];
    }

    // Lets a test assert real failure handling (the feed's "Could not load the
    // feed." path, a rejected insert's toast) without inventing a broken
    // network. Keyed "table:operation", e.g. "line_notes:select".
    function injectedError(tableName, operation) {
      const key = tableName + ':' + operation;
      const failures = control.failures || {};
      if (!failures[key]) return null;
      const failure = failures[key];
      if (failure.once) delete failures[key];
      return { message: failure.message || 'Injected test failure', code: failure.code || 'TEST' };
    }

    function recordCall(entry) {
      if (!Array.isArray(window.__DAFSYNC_TEST_CALLS__)) window.__DAFSYNC_TEST_CALLS__ = [];
      window.__DAFSYNC_TEST_CALLS__.push(entry);
    }

    function builder(tableName) {
      const query = {
        operation: 'select',
        filters: [],
        orders: [],
        limitCount: null,
        payload: null,
        rowMode: null, // 'single' | 'maybeSingle' | null
      };

      function matches(row) {
        return query.filters.every((filter) => {
          const value = row[filter.column];
          if (filter.type === 'eq') return value === filter.value;
          if (filter.type === 'in') return filter.value.includes(value);
          if (filter.type === 'ilike') return typeof value === 'string' && ilikeToRegExp(filter.value).test(value);
          if (filter.type === 'is') return testIs(value, filter.value);
          if (filter.type === 'not') return !evaluate(row, { kind: 'leaf', column: filter.column, operator: filter.operator, value: filter.value });
          if (filter.type === 'or') return evaluate(row, filter.node);
          if (filter.type === 'textSearch') {
            // body_tsv is a generated column over body (+ selected_text on
            // line_notes); the stub searches those source columns directly
            // rather than pretending to be a real tsvector.
            const haystack = ((row.body || '') + ' ' + (row.selected_text || '')).toLowerCase();
            return String(filter.value)
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean)
              .every((term) => haystack.includes(term));
          }
          return true;
        });
      }

      function runSelect() {
        const error = injectedError(tableName, 'select');
        if (error) return { data: null, error };
        let rows = table(tableName).filter(matches);
        if (query.orders.length) {
          // PostgREST applies successive .order() calls as tie-breakers, not as
          // independent passes. Sorting once per order (which is what this did
          // before) let the LAST call win outright and silently broke the
          // (last_activity_at desc, id desc) keyset ordering the feed relies on.
          rows = rows.slice().sort((a, b) => {
            for (const order of query.orders) {
              const direction = order.ascending ? 1 : -1;
              const result = compare(a[order.column], b[order.column]) * direction;
              if (result !== 0) return result;
            }
            return 0;
          });
        }
        if (query.limitCount !== null) rows = rows.slice(0, query.limitCount);
        if (query.rowMode === 'single') {
          if (rows.length !== 1) {
            return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
          }
          return { data: clone(rows[0]), error: null };
        }
        if (query.rowMode === 'maybeSingle') {
          return { data: rows.length ? clone(rows[0]) : null, error: null };
        }
        return { data: clone(rows), error: null };
      }

      // The database derives several columns with triggers, and the thread
      // reader reads them straight back off an inserted row. Without these the
      // stub would hand back a comment with no depth, no root and no sequence,
      // and a spec asserting nesting would pass on a lie. These MIRROR the real
      // triggers in 20260902190000_cloud_chabura_thread_foundation.sql -- they
      // do not prove them. That proof is supabase/tests/rls_authorization.sql,
      // which runs against a real Postgres.
      function applyServerDerivations(record) {
        if (tableName === 'comments') {
          const siblings = table('comments').filter((row) => row.note_id === record.note_id);
          record.activity_sequence = siblings.length + 1;
          if (!record.parent_comment_id) {
            record.root_comment_id = record.id;
            record.depth = 0;
          } else {
            const parent = siblings.find((row) => row.id === record.parent_comment_id);
            record.root_comment_id = parent ? parent.root_comment_id : record.id;
            record.depth = parent ? (parent.depth || 0) + 1 : 0;
          }
          if (record.deleted_at === undefined) record.deleted_at = null;
          if (record.edited_at === undefined) record.edited_at = null;
          if (record.hidden === undefined) record.hidden = false;
        }
        return record;
      }

      // redact_on_soft_delete: the body is replaced server-side on the
      // transition to deleted, so a client that skipped the step cannot leave
      // the original text readable over the API.
      function applyRedaction(previous, next) {
        if (!previous || previous.deleted_at || !next.deleted_at) return next;
        const redacted = { ...next, body: '[deleted]' };
        if (tableName === 'line_notes') {
          redacted.title = null;
          redacted.selected_text = null;
        }
        return redacted;
      }

      function runMutation() {
        const error = injectedError(tableName, query.operation);
        if (error) return { data: null, error };
        const rows = table(tableName);

        if (query.operation === 'insert' || query.operation === 'upsert') {
          const incoming = Array.isArray(query.payload) ? query.payload : [query.payload];
          const inserted = incoming.map((row) => {
            const record = applyServerDerivations(
              Object.assign({ id: uuid(), created_at: new Date().toISOString() }, clone(row))
            );
            if (query.operation === 'upsert') {
              // Upserted tables in this repo and the columns their primary keys
              // are made of: progress/preferences (user_id, ref_key, variant),
              // thread_read_state (user_id, note_id), bookmarks (user_id,
              // target_type, target_id).
              const KEY_COLUMNS = ['user_id', 'ref_key', 'variant', 'note_id', 'target_type', 'target_id'];
              const keys = Object.keys(record).filter((k) => KEY_COLUMNS.includes(k));
              const existingIndex = rows.findIndex((existing) => keys.every((k) => existing[k] === record[k]));
              if (existingIndex >= 0) {
                rows[existingIndex] = Object.assign({}, rows[existingIndex], record);
                return rows[existingIndex];
              }
            }
            rows.push(record);
            return record;
          });
          recordCall({ table: tableName, operation: query.operation, rows: clone(inserted) });
          return { data: clone(inserted), error: null };
        }

        if (query.operation === 'update') {
          const updated = [];
          rows.forEach((row, index) => {
            if (!matches(row)) return;
            rows[index] = applyRedaction(row, Object.assign({}, row, clone(query.payload)));
            updated.push(rows[index]);
          });
          recordCall({ table: tableName, operation: 'update', rows: clone(updated) });
          return { data: clone(updated), error: null };
        }

        if (query.operation === 'delete') {
          const removed = rows.filter(matches);
          for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i])) rows.splice(i, 1);
          recordCall({ table: tableName, operation: 'delete', rows: clone(removed) });
          return { data: clone(removed), error: null };
        }

        return { data: null, error: { message: 'Unsupported operation ' + query.operation } };
      }

      function run() {
        return query.operation === 'select' ? runSelect() : runMutation();
      }

      const api = {
        select(_columns) {
          // A trailing .select() after insert/update/delete asks PostgREST to
          // return the affected rows; it must not turn the call back into a read.
          if (query.operation === 'select') query.operation = 'select';
          return api;
        },
        insert(payload) { query.operation = 'insert'; query.payload = payload; return api; },
        upsert(payload) { query.operation = 'upsert'; query.payload = payload; return api; },
        update(payload) { query.operation = 'update'; query.payload = payload; return api; },
        delete() { query.operation = 'delete'; return api; },
        eq(column, value) { query.filters.push({ type: 'eq', column, value }); return api; },
        in(column, value) { query.filters.push({ type: 'in', column, value: value || [] }); return api; },
        ilike(column, value) { query.filters.push({ type: 'ilike', column, value }); return api; },
        textSearch(column, value) { query.filters.push({ type: 'textSearch', column, value }); return api; },
        is(column, value) { query.filters.push({ type: 'is', column, value }); return api; },
        neq(column, value) { query.filters.push({ type: 'not', column, operator: 'eq', value }); return api; },
        not(column, operator, value) { query.filters.push({ type: 'not', column, operator, value }); return api; },
        // PostgREST's `or=` takes a COMMA-SEPARATED LIST of conditions, any one
        // of which may match -- not a single condition. Splitting at the top
        // level is therefore part of the operator, not an optimisation.
        or(expression) {
          const node = { kind: 'or', children: splitTopLevel(expression).map(parseExpression) };
          query.filters.push({ type: 'or', node });
          return api;
        },
        order(column, options) { query.orders.push({ column, ascending: options ? options.ascending !== false : true }); return api; },
        limit(count) { query.limitCount = count; return api; },
        single() { query.rowMode = 'single'; return api; },
        maybeSingle() { query.rowMode = 'maybeSingle'; return api; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
        catch(onRejected) { return Promise.resolve().then(run).catch(onRejected); },
      };
      return api;
    }

    function setSession(next) {
      session = next;
      window.__DAFSYNC_TEST_SESSION__ = next;
      authListeners.forEach((listener) => {
        try { listener(next ? 'SIGNED_IN' : 'SIGNED_OUT', next); } catch (error) { console.error(error); }
      });
    }

    const client = {
      from: builder,
      rpc(name, params) {
        recordCall({ rpc: name, params: clone(params) });
        const handlers = (window.__DAFSYNC_TEST_CONTROL__ || {}).rpc || {};
        const handler = handlers[name];
        const result = typeof handler === 'function' ? handler(params, db) : { data: null, error: null };
        return Promise.resolve(result || { data: null, error: null });
      },
      auth: {
        getSession() { return Promise.resolve({ data: { session }, error: null }); },
        getUser() { return Promise.resolve({ data: { user: session ? session.user : null }, error: null }); },
        onAuthStateChange(callback) {
          authListeners.add(callback);
          return { data: { subscription: { unsubscribe() { authListeners.delete(callback); } } } };
        },
        signInWithPassword({ email }) {
          const next = { user: { id: (control.signInUserId || uuid()), email } };
          setSession(next);
          return Promise.resolve({ data: next, error: null });
        },
        signUp({ email }) {
          return Promise.resolve({ data: { user: { id: uuid(), email }, session: null }, error: null });
        },
        signInWithOAuth() { return Promise.resolve({ data: {}, error: null }); },
        signOut() { setSession(null); return Promise.resolve({ error: null }); },
      },
      // Exposed for tests that need to drive an auth transition mid-page.
      __setSession: setSession,
    };

    window.__DAFSYNC_TEST_CLIENT__ = client;
    return client;
  }

  window.supabase = { createClient };
})();
