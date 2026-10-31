/* ielts-cloud.js — Supabase auth + progress sync for the IELTS mock test pages.
 * 1) Fill in the two values below (Supabase Dashboard -> Project Settings -> API).
 *    The anon key is meant to be public; Row Level Security (supabase-setup.sql) protects the data.
 * 2) Load AFTER the supabase-js script on every page.
 */
(function () {
  'use strict';
  var SUPABASE_URL = 'https://ajmbkryqxftpghysiobs.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_pTAvJNa8AQI521Bkk3Ysdw_bvCRu49w';

  var TEST_LABELS = { 'reading-320': 'Reading · Test 320', 'listening-1': 'Listening · Test 1' };
  var LOCAL_PREFIXES = ['ielts_reading_', 'ieltsfeverlt1:'];
  var configured = !/YOUR-/.test(SUPABASE_URL + SUPABASE_ANON_KEY);
  var root = document.documentElement;

  function showFatal(msg) {
    root.classList.remove('auth-pending');
    var d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:#f8fafc;font:16px/1.5 system-ui,sans-serif;color:#1f2937;padding:24px;text-align:center';
    d.innerHTML = '<div style="max-width:420px"><h2 style="margin:0 0 8px;color:#1e3a5f">Sign-in unavailable</h2><p style="margin:0 0 16px;color:#6b7280"></p><button style="padding:10px 20px;border:0;border-radius:8px;background:#e11d48;color:#fff;font-weight:700;cursor:pointer" onclick="location.reload()">Try again</button></div>';
    d.querySelector('p').textContent = msg;
    (document.body || root).appendChild(d);
  }

  if (!window.supabase || !window.supabase.createClient) {
    window.IeltsCloud = null;
    document.addEventListener('DOMContentLoaded', function () { showFatal('Could not load the sign-in service. Check your connection and try again.'); });
    return;
  }
  if (!configured) {
    window.IeltsCloud = { configured: false };
    document.addEventListener('DOMContentLoaded', function () {
      if (!document.getElementById('loginCard')) showFatal('Supabase is not configured yet. Add your project URL and anon key at the top of ielts-cloud.js.');
    });
    return;
  }

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  var currentUser = null;

  function purgeLocal() {
    try {
      var del = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        for (var j = 0; j < LOCAL_PREFIXES.length; j++) if (k && k.indexOf(LOCAL_PREFIXES[j]) === 0) del.push(k);
      }
      del.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }
  /* Call after any sign-in: if a different person signs in on this browser, wipe the previous person's local drafts. */
  function noteUser(user) {
    try {
      var last = localStorage.getItem('ielts_last_uid');
      if (last && last !== user.id) purgeLocal();
      localStorage.setItem('ielts_last_uid', user.id);
    } catch (e) {}
  }

  function safeNext(n) { return /^[\w.-]+\.html$/.test(n || '') ? n : 'index.html'; }
  function here() { return (location.pathname.split('/').pop() || 'index.html'); }

  /* ---------- gate: resolves with the user, or redirects to login ---------- */
  var readyP = sb.auth.getSession().then(function (r) {
    var s = r && r.data && r.data.session;
    if (!s) {
      if (!document.getElementById('loginCard')) location.replace('login.html?next=' + encodeURIComponent(here()));
      return null;
    }
    currentUser = s.user;
    root.classList.remove('auth-pending');
    return currentUser;
  }).catch(function () { showFatal('Could not check your sign-in. Check your connection and try again.'); return null; });

  sb.auth.onAuthStateChange(function (ev) {
    if (ev === 'SIGNED_OUT' && !document.getElementById('loginCard')) location.replace('login.html');
  });

  /* ---------- progress: single-flight queue so saves never race ---------- */
  var activeId = {};      // test_id -> row id of the in-progress attempt
  var chain = Promise.resolve();
  var timers = {}, pending = {};
  function enqueue(fn) { chain = chain.then(fn, fn).catch(function () {}); return chain; }

  function findActive(testId) {
    return sb.from('attempts').select('id,payload,updated_at,answered').eq('test_id', testId).eq('status', 'in_progress').maybeSingle()
      .then(function (r) { if (r.data) activeId[testId] = r.data.id; else delete activeId[testId]; return r.data || null; });
  }

  function writeSave(testId, payload, meta) {
    var row = { payload: payload, answered: (meta && meta.answered) || 0 };
    function insertIt() {
      row.test_id = testId; row.status = 'in_progress';
      return sb.from('attempts').insert(row).select('id').single().then(function (r) {
        if (r.error && r.error.code === '23505') return findActive(testId).then(function (a) { return a ? sb.from('attempts').update(row).eq('id', a.id) : null; });
        if (r.data) activeId[testId] = r.data.id;
        return r;
      });
    }
    if (!activeId[testId]) return findActive(testId).then(function (a) { return a ? sb.from('attempts').update(row).eq('id', a.id) : insertIt(); });
    return sb.from('attempts').update(row).eq('id', activeId[testId]).eq('status', 'in_progress').select('id').then(function (r) {
      if (!r.error && (!r.data || !r.data.length)) { delete activeId[testId]; return insertIt(); }
      return r;
    });
  }

  function flush(testId) {
    clearTimeout(timers[testId]); delete timers[testId];
    var p = pending[testId]; if (!p) return chain;
    delete pending[testId];
    return enqueue(function () { return writeSave(testId, p.payload, p.meta); });
  }

  var api = {
    configured: true,
    client: sb,
    ready: readyP,
    labels: TEST_LABELS,
    safeNext: safeNext,
    noteUser: noteUser,
    user: function () { return currentUser; },

    queueSave: function (testId, payload, meta) {
      if (!currentUser) return;
      pending[testId] = { payload: payload, meta: meta };
      clearTimeout(timers[testId]);
      timers[testId] = setTimeout(function () { flush(testId); }, 2500);
    },
    flushAll: function () { Object.keys(pending).forEach(flush); },

    /* Mark the attempt finished and store the result. */
    submit: function (testId, res) {
      clearTimeout(timers[testId]); delete timers[testId]; delete pending[testId];
      return enqueue(function () {
        var done = { status: 'submitted', submitted_at: new Date().toISOString(), payload: null,
          answered: res.answered == null ? 0 : res.answered,
          score: res.score == null ? null : res.score, total: res.total == null ? null : res.total,
          band: res.band == null ? null : String(res.band), part_scores: res.part_scores || null, answers: res.answers || null };
        function insertDone() { done.test_id = testId; return sb.from('attempts').insert(done); }
        var find = activeId[testId] ? Promise.resolve({ id: activeId[testId] }) : findActive(testId);
        return find.then(function (a) {
          if (!a) return insertDone();
          return sb.from('attempts').update(done).eq('id', a.id).then(function (r) { delete activeId[testId]; return r; });
        });
      });
    },

    /* "Start fresh": drop the unfinished cloud attempt. */
    discard: function (testId) {
      clearTimeout(timers[testId]); delete timers[testId]; delete pending[testId];
      return enqueue(function () {
        return sb.from('attempts').delete().eq('test_id', testId).eq('status', 'in_progress').then(function () { delete activeId[testId]; });
      });
    },

    /* Reconcile the browser's draft with the cloud draft (newest wins), and prefill the name.
       opts: testId, readLocal() -> obj|null, stamp(obj) -> ms, localKeyFor(obj) -> storage key, answeredOf(obj),
             onRestore(obj), prefill(name) */
    attach: function (opts) {
      return readyP.then(function (user) {
        if (!user) return;
        var nm = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || '';
        if (nm && opts.prefill) try { opts.prefill(nm); } catch (e) {}
        return findActive(opts.testId).then(function (row) {
          return { data: row };
        }).then(function (r) {
          var cloud = r && r.data && r.data.payload, local = null;
          try { local = opts.readLocal(); } catch (e) {}
          if (cloud && (!local || opts.stamp(cloud) > opts.stamp(local))) {
            try { localStorage.setItem(opts.localKeyFor(cloud), JSON.stringify(cloud)); } catch (e) {}
            if (opts.onRestore) opts.onRestore(cloud);
          } else if (local && !local.submitted && (!cloud || opts.stamp(local) > opts.stamp(cloud))) {
            api.queueSave(opts.testId, local, { answered: opts.answeredOf ? opts.answeredOf(local) : 0 });
          }
        });
      }).catch(function () {});
    },

    list: function () {
      return sb.from('attempts').select('id,test_id,status,answered,score,total,band,part_scores,started_at,updated_at,submitted_at')
        .order('updated_at', { ascending: false }).limit(200);
    },

    signOut: function () {
      api.flushAll();
      return chain.then(function () { return sb.auth.signOut(); }).then(function () { purgeLocal(); try { localStorage.removeItem('ielts_last_uid'); } catch (e) {} location.replace('login.html'); });
    }
  };
  window.IeltsCloud = api;

  window.addEventListener('pagehide', function () { api.flushAll(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) api.flushAll(); });
})();
