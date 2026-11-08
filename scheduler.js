/* ============================================================================
   SCHEDULER — how it is put together
   ----------------------------------------------------------------------------
   One collection, data/requests.json in the PRIVATE repo GitMISMO/scheduler-data,
   read and saved through the relay (project key "scheduler"):
       {docs:{<request id>:{...a request...}}}
   A request holds its MISMO people (Team HQ ids), its outside guests (each with a
   private link code), the times offered, everyone's answers, and a short log.

   Read, never written: Team HQ's people list and each person's Outlook availability
   (team-hq/data/people, team-hq/data/cal-<id>) — the same files Team HQ shows.
   Written to Team HQ: one task per request that is waiting on replies,
   "Follow up: <meeting>", owned by the organizer, due on the follow-up date, and
   marked Done once everyone has answered or the meeting is booked. That is the
   reminder: it lands on the organizer's Team HQ board on the right day whether or
   not anyone opens the Scheduler.

   Outside guests answer at respond.html through two relay routes that need no
   sign-in (POST /scheduler/poll/view and /scheduler/poll/answer; see the README).
   Until those are switched on, staff type guests' answers in by hand.

   Storage keys: tools:scheduler:<name>. Never localStorage.clear().
   ========================================================================== */
(function () {
'use strict';

var RELAY_URL = 'https://rgvdi67cg27o5kcmiytcqbqnrm0hmztx.lambda-url.us-east-1.on.aws';
var PROJECT = 'scheduler', HQ = 'team-hq', TOOL = 'the Scheduler';
var SITE = 'https://resources.mismo.org/scheduler/';
var PREVIEW = !!window.SCHED_PREVIEW;
var KEY = function (n) { return 'tools:scheduler:' + n; };
var ET = 'America/New_York';
var DEFAULT_FOLLOW_DAYS = 3;

/* ---------------- small helpers ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function rid(n) { var a = new Uint8Array(n || 9); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]; }).join(''); }
function linkCode() { var a = new Uint8Array(18); crypto.getRandomValues(a); return btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function lsGet(n, d) { try { var v = localStorage.getItem(KEY(n)); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lsSet(n, v) { try { if (v == null) localStorage.removeItem(KEY(n)); else localStorage.setItem(KEY(n), JSON.stringify(v)); } catch (e) {} }
function initials(n) { var p = String(n || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
function first(n) { return String(n || '').trim().split(/[\s,]+/)[0] || ''; }
var toastT;
function toast(msg) { var t = $('.toast'); if (!t) { t = el('div', 'toast'); t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3800); }
function copy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) { var t = el('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e) {} t.remove(); }
var ICON = {
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v12M6 10l6 6 6-6M5 20h14"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>'
};

/* ---------------- time ---------------- */
var ZONES = [
  { v: 'America/New_York', n: 'Eastern' }, { v: 'America/Chicago', n: 'Central' },
  { v: 'America/Denver', n: 'Mountain' }, { v: 'America/Phoenix', n: 'Arizona' }, { v: 'America/Los_Angeles', n: 'Pacific' }
];
function zoneName(tz) { var z = ZONES.find(function (x) { return x.v === tz; }); return z ? z.n : tz.replace(/^.*\//, '').replace(/_/g, ' '); }
function localZone() { try { var z = Intl.DateTimeFormat().resolvedOptions().timeZone; return ZONES.some(function (x) { return x.v === z; }) ? z : ET; } catch (e) { return ET; } }
var VIEW_TZ = lsGet('tz', null) || localZone();
function parts(t, tz) {
  var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  var o = {}; f.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, iso: o.year + '-' + o.month + '-' + o.day, wd: o.weekday };
}
function offsetOf(tz, t) { var p = parts(t, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60000) * 60000; }
/* a wall-clock day and minute in a zone, to a moment */
function at(iso, mins, tz) {
  var y = +iso.slice(0, 4), mo = +iso.slice(5, 7), d = +iso.slice(8, 10);
  var guess = Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60);
  var t = guess - offsetOf(tz, guess);
  var t2 = guess - offsetOf(tz, t);
  return t2;
}
function fmtTime(t, tz) { return new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); }
function fmtDay(t, tz, long) { return new Date(t).toLocaleDateString('en-US', { timeZone: tz, weekday: long ? 'long' : 'short', month: long ? 'long' : 'short', day: 'numeric' }); }
function fmtRange(s, e, tz) {
  var a = fmtTime(s, tz), b = fmtTime(e, tz);
  if (a.slice(-2) === b.slice(-2)) a = a.slice(0, -3);
  return a + '–' + b;
}
function tzAbbr(t, tz) { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(t)).find(function (p) { return p.type === 'timeZoneName'; }).value; } catch (e) { return ''; } }
function slotLabel(sl, tz, long) { tz = tz || VIEW_TZ; return fmtDay(sl.s, tz, long) + ', ' + fmtRange(sl.s, sl.e, tz) + ' ' + tzAbbr(sl.s, tz); }
function todayISO(tz) { return parts(Date.now(), tz || ET).iso; }
function isoAdd(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dow(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
function isWeekend(iso) { var w = dow(iso); return w === 0 || w === 6; }
/* business days after a moment, counted on MISMO's (Eastern) calendar */
function addBiz(t, n) { var iso = parts(t, ET).iso; while (n > 0) { iso = isoAdd(iso, 1); if (!isWeekend(iso)) n--; } return iso; }
function bizDaysAhead(n, fromIso) { var out = [], iso = fromIso || todayISO(VIEW_TZ); while (out.length < n) { iso = isoAdd(iso, 1); if (!isWeekend(iso)) out.push(iso); } return out; }
function dayWord(iso) { var t = todayISO(ET); if (iso === t) return 'today'; if (iso === isoAdd(t, 1)) return 'tomorrow'; if (iso < t) return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }); return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); }
function whenAgo(t) { var m = Math.round((Date.now() - t) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago'); return fmtDay(t, VIEW_TZ) + ' ' + fmtTime(t, VIEW_TZ); }

/* ---------------- the session ---------------- */
function RS() { return window.ResourcesSession || null; }
function me() {
  if (PREVIEW) return { email: 'vrios@mismo.org', name: 'Vanessa Rios' };
  var s = RS() && RS().current(); return s ? { email: String(s.email || '').toLowerCase(), name: s.name || s.email } : { email: '', name: '' };
}
function canEdit() { return PREVIEW || !!(RS() && RS().canEdit(PROJECT)); }

/* ---------------- talking to the relay ---------------- */
function err(code, msg, status) { var e = new Error(msg || code); e.code = code; e.status = status || 0; return e; }
function call(proj, path, method, body, noAuth) {
  var headers = {};
  if (!noAuth) {
    var tok = RS() && RS().token();
    if (!tok) return Promise.reject(err('SIGNED_OUT', 'Your sign-in has ended.', 401));
    headers.Authorization = 'Bearer ' + tok;
  }
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(RELAY_URL + '/' + proj + path, { method: method, cache: 'no-store', headers: headers, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (r.ok) return b;
        var e = err((b && b.error) || ('HTTP_' + r.status), b && b.message, r.status); e.body = b; throw e;
      });
    }, function () { throw err('OFFLINE', 'Could not reach resources.mismo.org', 0); });
}
function readData(proj, name) { return call(proj, '/data/' + encodeURIComponent(name), 'GET'); }
function writeData(proj, name, content, sha) { return call(proj, '/data/' + encodeURIComponent(name), 'PUT', { content: content, sha: sha || null }); }
function noAccess(e) {
  if (e && (e.code === 'NO_ACCESS' || e.status === 403) && RS()) RS().signIn({ reason: 'no-access', toolName: TOOL, gated: true });
}

/* ---------------- the requests: read, keep, save ---------------- */
var DB = { server: { docs: {} }, sha: null, loaded: false, pending: {}, flushing: false, timer: null, problem: '', from: {} };

  /* ---- saving without overwriting anyone (November 5, 2026) ----------------------------
     (The Scheduler already kept a guest's answer, the robot's notes and the log; see
     keepGuestAnswers below. This covers everything else a staff member changes.)
     A save used to send the whole record exactly as this page had it. If the page had
     been open a while, or someone else saved in the moment before, their change was
     quietly put back. Now a save carries only what was changed here: it is laid over the
     newest copy at the moment it is written (and again if the relay says someone saved
     first), and everything this page did not change keeps its newest value.
       - Records inside a list are matched by their id, so two people changing different
         rows both keep their change, a row added by either is kept, and a row someone
         else removed stays removed unless it was changed here.
       - Running notes kept as text (log, notes) keep both people's additions.
       - When both changed the very same value, the newer save (this one) wins, unless
         the person saving says to keep theirs when asked. */
  var MG_LOGS = { log: true, notes: true };
  var MG_QUIET = /^(updatedAt|updatedBy|savedAt|savedBy|createdAt|createdBy|updated)$/;   /* when it was saved, and by whom */
  function mgObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function mgHas(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function mgCopy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  /* "", null and nothing are the same; 5 and "5" are the same */
  function mgNorm(v) {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  }
  function mgSame(x, y) {
    if (x === y) return true;
    if (mgObj(x) && mgObj(y)) {
      var k, seen = {};
      for (k in x) if (mgHas(x, k)) { seen[k] = 1; if (!mgSame(x[k], y[k])) return false; }
      for (k in y) if (mgHas(y, k) && !seen[k] && !mgSame(x[k], y[k])) return false;
      return true;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false;
      for (var i = 0; i < x.length; i++) if (!mgSame(x[i], y[i])) return false;
      return true;
    }
    if ((x && typeof x === 'object') || (y && typeof y === 'object')) return false;
    return mgNorm(x) === mgNorm(y);
  }
  /* what a row in a list is called in a question, and how it is matched */
  function mgName(x, i) {
    if (mgObj(x)) { var n = x.title || x.name || x.task || x.text || x.nm || x.full || x.email || x.id; if (n) return String(n).slice(0, 40); }
    return typeof x === 'string' ? x.slice(0, 40) : '#' + (i + 1);
  }
  function mgIdKey(x) { return mgObj(x) && x.id !== undefined && x.id !== null && x.id !== '' ? 'i:' + x.id : null; }
  function mgJsonKey(x) { return x === undefined ? null : 'j:' + JSON.stringify(x); }
  function mgIndex(lists, keyFn) {
    var out = [];
    for (var a = 0; a < lists.length; a++) {
      var m = {}, order = [];
      for (var i = 0; i < lists[a].length; i++) {
        var k = keyFn(lists[a][i]);
        if (k === null || mgHas(m, k)) return null;
        m[k] = lists[a][i]; order.push(k);
      }
      out.push({ m: m, order: order });
    }
    return out;
  }
  function mgList(C, M, B, path, ctx) {
    var common = function (x, y) { return x.order.filter(function (k) { return mgHas(y.m, k); }).join('\u0001'); };
    var reordered = common(M, B) !== common(B, M);      /* the order was changed here: this order stands */
    var lead = reordered ? M : C, rest = reordered ? C : M, out = [], keys = [], done = {};
    var one = function (k) {
      done[k] = 1;
      var b = mgHas(B.m, k), m = mgHas(M.m, k), c = mgHas(C.m, k), src = c ? C.m[k] : M.m[k];
      if (b && m && c) return { v: mgValue(C.m[k], M.m[k], B.m[k], path.concat(mgName(src, 0)), ctx) };
      if (b && m) return mgSame(M.m[k], B.m[k]) ? null : { v: mgCopy(M.m[k]) };   /* removed there: back only if changed here */
      if (b) return null;                                                         /* removed here */
      if (m && c) return { v: mgValue(C.m[k], M.m[k], undefined, path.concat(mgName(src, 0)), ctx) };
      return { v: mgCopy(src) };                                                  /* added on one side */
    };
    lead.order.forEach(function (k) { var r = one(k); if (r) { out.push(r.v); keys.push(k); } });
    rest.order.forEach(function (k, i) {
      if (done[k]) return;
      var r = one(k); if (!r) return;
      /* a row added at the end goes at the end; one added in between goes after the row
         it followed on its own side */
      var at = out.length, between = false;
      for (var q = i + 1; q < rest.order.length && !between; q++) between = keys.indexOf(rest.order[q]) >= 0;
      if (between) {
        at = 0;
        for (var j = i - 1; j >= 0; j--) { var p = keys.indexOf(rest.order[j]); if (p >= 0) { at = p + 1; break; } }
      }
      out.splice(at, 0, r.v); keys.splice(at, 0, k);
    });
    return out;
  }
  function mgValue(cur, mine, base, path, ctx) {
    if (mgSame(mine, base)) return mgCopy(cur);                     /* not changed here: the newest value stands */
    if (mgSame(cur, base) || mgSame(cur, mine)) return mgCopy(mine);
    var last = path.length ? String(path[path.length - 1]) : '';
    if (MG_LOGS[last] && typeof cur === 'string' && typeof mine === 'string' && (base == null || typeof base === 'string')) {
      var b0 = base || '';
      if (mine.indexOf(b0) === 0 && cur.indexOf(b0) === 0) {                                      /* both added to the end */
        var add = mine.slice(b0.length);
        return cur + (cur && !/\s$/.test(cur) && !/^\s/.test(add) ? '\n' : '') + add;
      }
    }
    if (mgObj(cur) && mgObj(mine) && (mgObj(base) || base == null)) {
      var b = mgObj(base) ? base : {}, out = mgCopy(cur), keys = {}, k;
      for (k in mine) if (mgHas(mine, k)) keys[k] = 1;
      for (k in b) if (mgHas(b, k)) keys[k] = 1;
      Object.keys(keys).forEach(function (k) {
        if (mgSame(mine[k], b[k])) return;
        if (!mgHas(mine, k)) { delete out[k]; return; }                               /* taken out here */
        if (!mgHas(cur, k) && mgHas(b, k)) { out[k] = mgCopy(mine[k]); return; }      /* taken out there, changed here */
        var v = mgValue(cur[k], mine[k], b[k], path.concat(k), ctx);
        if (v === undefined) delete out[k]; else out[k] = v;
      });
      return out;
    }
    if (Array.isArray(cur) && Array.isArray(mine) && (Array.isArray(base) || base == null)) {
      var bl = Array.isArray(base) ? base : [], ix = mgIndex([cur, mine, bl], mgIdKey);
      if (ix && (cur.length || mine.length)) return mgList(ix[0], ix[1], ix[2], path, ctx);
      /* plain values (names, ticks, pairs) are a set: what was added or taken out on each side */
      var plain = function (a) { return a.every(function (x) { return !mgObj(x); }); };
      if (plain(cur) && plain(mine) && plain(bl) && (ix = mgIndex([cur, mine, bl], mgJsonKey))) return mgList(ix[0], ix[1], ix[2], path, ctx);
      if (cur.length === mine.length && mine.length === bl.length)
        return cur.map(function (c, i) { return mgValue(c, mine[i], bl[i], path.concat(mgName(c, i)), ctx); });
      ix = mgIndex([cur, mine, bl], mgJsonKey);
      if (ix) return mgList(ix[0], ix[1], ix[2], path, ctx);
    }
    /* both changed this very value */
    var key = path.join(' › ');
    if (ctx && ctx.theirs && ctx.theirs[key]) return mgCopy(cur);
    if (ctx && ctx.clashes && !MG_QUIET.test(last) && !(ctx.quiet && ctx.quiet.test(key)))
      ctx.clashes.push({ key: key, theirs: cur, mine: mine });
    return mgCopy(mine);
  }
  /* one whole document: `base` is the copy the change started from (undefined: not known,
     so it is written as sent, the way it always was) */
  function mgDoc(cur, mine, base, ctx) {
    if (base === undefined || base === null || mine === null || mine === undefined) return mgCopy(mine);
    if (cur === null || cur === undefined) return mgSame(mine, base) ? null : mgCopy(mine);   /* removed by someone else */
    if (mgSame(cur, base)) return mgCopy(mine);                                                 /* nobody else saved: exactly as sent */
    return mgValue(cur, mine, base, [], ctx);
  }
  /* the question asked when both people changed the same thing; true keeps this page's */
  function mgShow(v) { var t = mgObj(v) || Array.isArray(v) ? JSON.stringify(v) : mgNorm(v); return t === '' ? '(blank)' : t.slice(0, 80); }
  function mgWord(k) { return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function mgAsk(what, clashes, labels) {
    var word = function (k) { return labels && labels[k] ? labels[k] : mgWord(k); };
    var list = clashes.slice(0, 8).map(function (c) {
      return '• ' + c.key.split(' › ').map(word).join(' › ') + ' — theirs: ' + mgShow(c.theirs) + '   ·   yours: ' + mgShow(c.mine);
    }).join('\n') + (clashes.length > 8 ? '\n• and ' + (clashes.length - 8) + ' more' : '');
    var msg = 'While you had ' + what + ' open, someone else saved a different value in the same ' +
      (clashes.length === 1 ? 'place' : 'places') + ':\n\n' + list +
      '\n\nOK keeps yours. Cancel keeps theirs for ' + (clashes.length === 1 ? 'this one' : 'these') +
      ' — your other changes still save.';
    try { return window.confirm(msg); } catch (e) { return true; }
  }

/* Each request as this page has seen it, by its updatedAt: a change is made to a copy of one
   of these, and that copy is what the change is compared with when it is saved. The guest's
   answer, the robot's notes and the log are not asked about: keepGuestAnswers settles those. */
var SEEN = {}, MY_STAMPS = {};
var MG_SCHED_QUIET = /(^|\u203a )(log|robot|robotEdit|answer|sentAt|reminders)( \u203a|$)/;
function noteSeen(r) {
  if (!r || !r.id || r.updatedAt == null) return;
  var m = SEEN[r.id] = SEEN[r.id] || {};
  if (!m[r.updatedAt]) m[r.updatedAt] = clone(r);        /* the first copy seen under that stamp */
  var ks = Object.keys(m); if (ks.length > 12) delete m[ks.sort(function (a, b) { return a - b; })[0]];
}
function seenFrom(r) { return r && r.id && r.updatedAt != null && SEEN[r.id] && SEEN[r.id][r.updatedAt] ? clone(SEEN[r.id][r.updatedAt]) : undefined; }

/* finished requests a month past their meeting live in monthly archive files (the robot
   moves them; see robot/archive.mjs). They're read here for Past Meetings, Couldn't Schedule,
   Statistics and search, and are shown read-only. */
var ARCH = { docs: {}, loaded: false, at: 0 };
function loadArchive() {
  if (PREVIEW) { ARCH.loaded = true; return Promise.resolve(false); }
  return readData(PROJECT, 'archive-index').then(function (b) {
    var months = Object.keys((b && b.data && b.data.months) || {}).sort().reverse().slice(0, 36);
    return Promise.all(months.map(function (m) { return readData(PROJECT, 'archive-' + m).then(function (x) { return (x && x.data && x.data.docs) || {}; }, function () { return {}; }); }));
  }).then(function (list) {
    var next = {}; list.forEach(function (d) { Object.keys(d).forEach(function (id) { next[id] = d[id]; }); });
    var changed = Object.keys(next).length !== Object.keys(ARCH.docs).length;
    ARCH.docs = next; ARCH.loaded = true; ARCH.at = Date.now();
    return changed;
  }, function () { ARCH.loaded = true; return false; });
}
function isArchived(r) { return !!(r && r.archivedAt); }

function docs() {
  var all = Object.assign({}, ARCH.docs, DB.server.docs || {});
  Object.keys(DB.pending).forEach(function (id) {
    if (DB.pending[id] === null) { delete all[id]; return; }
    var r = DB.pending[id];
    /* a Take Over, Hand Back or Approve not yet saved shows straight away */
    if (r.robotEdit) { r = Object.assign({}, r, { robot: Object.assign({}, r.robot || {}, r.robotEdit) }); }
    all[id] = r;
  });
  return all;
}
function getReq(id) { return docs()[id] || null; }
function allReqs() { var d = docs(); return Object.keys(d).map(function (k) { return d[k]; }); }
function saveState(text, bad) { var s = $('#savestate'); if (s) { s.textContent = text || ''; s.style.color = bad ? 'var(--bad)' : ''; } }
function loadReqs() {
  if (PREVIEW) { DB.loaded = true; return Promise.resolve(); }
  return readData(PROJECT, 'requests').then(function (b) {
    var c = b && b.data && typeof b.data === 'object' ? b.data : {};
    var before = JSON.stringify(DB.server.docs);
    DB.server = Object.assign({}, c, { docs: c.docs && typeof c.docs === 'object' ? c.docs : {} });
    DB.sha = (b && b.sha) || null; DB.loaded = true;
    Object.keys(DB.server.docs).forEach(function (id) { noteSeen(DB.server.docs[id]); });
    restoreUnsaved();
    return before !== JSON.stringify(DB.server.docs);
  }, function (e) { noAccess(e); throw e; });
}
function put(req, why) {
  if (isArchived(req) && !(DB.server.docs || {})[req.id]) { toast('This request is archived, so it can’t be changed. Start a new request instead.'); return Promise.reject(err('ARCHIVED')); }
  if (!canEdit()) { toast('You can look at the Scheduler but not change it. Ask Perry for Edit access.'); return Promise.reject(err('VIEW_ONLY')); }
  /* November 5, 2026: the copy this change was made to, before it is stamped */
  var from = seenFrom(req), had = DB.pending[req.id];
  req.updatedAt = Date.now(); req.updatedBy = me().name;
  if (why) { req.log = req.log || []; req.log.push({ at: Date.now(), by: me().name, what: why }); if (req.log.length > 80) req.log = req.log.slice(-80); }
  if (from) {
    /* laid over the newest copy this page has, so what someone else saved is kept; if they
       changed the very same thing, ask which to keep (OK keeps this change) */
    var latest = had || DB.server.docs[req.id] || null, ctx = { clashes: [], theirs: {}, quiet: MG_SCHED_QUIET };
    var merged = mgDoc(latest, req, from, ctx);
    if (ctx.clashes.length && !mgAsk('\u201c' + (req.title || 'this request') + '\u201d', ctx.clashes,
        { title: 'Title', purpose: 'What It Is For', duration: 'Length', where: 'Where', status: 'Status', chosen: 'Chosen Time', slots: 'Times Offered', guests: 'Guests', internal: 'MISMO People', optional: 'Optional' })) {
      ctx.clashes.forEach(function (c) { ctx.theirs[c.key] = 1; });
      merged = mgDoc(latest, req, from, { clashes: [], theirs: ctx.theirs });
    }
    if (merged) { merged.updatedAt = req.updatedAt; merged.updatedBy = req.updatedBy; req = merged; }
  }
  if (!had && !Object.prototype.hasOwnProperty.call(DB.from, req.id)) DB.from[req.id] = from;
  MY_STAMPS[req.updatedAt] = 1; noteSeen(req);
  DB.pending[req.id] = clone(req);
  keepUnsaved();
  render();
  if (PREVIEW) { DB.server.docs[req.id] = keepGuestAnswers(DB.server.docs[req.id], clone(req)); delete DB.pending[req.id]; saveState('Preview · nothing is saved'); afterSave([req.id]); render(); return Promise.resolve(); }
  saveState('Saving…');
  clearTimeout(DB.timer); DB.timer = setTimeout(flush, 250);
  return Promise.resolve();
}
function drop(id) { DB.pending[id] = null; delete DB.from[id]; keepUnsaved(); if (PREVIEW) { delete DB.server.docs[id]; delete DB.pending[id]; } else { clearTimeout(DB.timer); DB.timer = setTimeout(flush, 250); } render(); }
function keepUnsaved() {
  if (PREVIEW) return;
  var any = Object.keys(DB.pending).length;
  lsSet('unsaved:' + me().email, any ? DB.pending : null);
  lsSet('unsavedFrom:' + me().email, any ? DB.from : null);     /* the copies those changes started from */
}
function restoreUnsaved() {
  var kept = lsGet('unsaved:' + me().email, null);
  if (kept && !Object.keys(DB.pending).length) { DB.pending = kept; DB.from = lsGet('unsavedFrom:' + me().email, null) || {}; saveState('Finishing an earlier save…'); clearTimeout(DB.timer); DB.timer = setTimeout(flush, 800); }
}
var chain = Promise.resolve();

/* ----------------------------------------------------------------------------
   A GUEST'S ANSWER IS THEIRS, AND A SAVE FROM THIS PAGE MUST NOT LAND ON IT.
   The page saves a whole request at a time. A guest answering through their own
   link writes straight into the same file, through the relay, while someone here
   may have had the request open since before it arrived. Without this, the next
   save from this page would put back the copy it has been holding and the answer
   would be gone, with nothing to say so.
   So: every field a GUEST owns — their answer, when their link was sent, and the
   request's log — is taken from the file as it now stands, never from this page's
   copy. Everything a staff member owns (times, people, title, status) still saves
   the way it always has, last save winning.
   -------------------------------------------------------------------------- */
function keepGuestAnswers(onFile, mine) {
  if (!onFile || !mine || typeof onFile !== 'object' || typeof mine !== 'object') return mine;
  /* work on a copy: flush() compares what it sent with what is still waiting, and changing
     its copy here (dropping robotEdit) made the two never match, so it saved over and over */
  var out = clone(mine);
  if (Array.isArray(onFile.guests) && Array.isArray(out.guests)) {
    var byId = {};
    onFile.guests.forEach(function (g) { if (g && g.id) byId[g.id] = g; });
    out.guests = out.guests.map(function (g) {
      var srv = g && g.id ? byId[g.id] : null;
      if (!srv) return g;
      var keep = Object.assign({}, g);
      var sa = srv.answer && typeof srv.answer === 'object' ? srv.answer : null;
      var ma = g.answer && typeof g.answer === 'object' ? g.answer : null;
      /* the newer of the two answers wins, and an answer never loses to nothing */
      if (sa && (!ma || (Number(sa.at) || 0) > (Number(ma.at) || 0))) keep.answer = sa;
      if (!keep.sentAt && srv.sentAt) keep.sentAt = srv.sentAt;
      return keep;
    });
    /* a guest added to the file since this page loaded is kept too */
    var hav = {};
    out.guests.forEach(function (g) { if (g && g.id) hav[g.id] = 1; });
    onFile.guests.forEach(function (g) { if (g && g.id && !hav[g.id] && g.answer) out.guests.push(g); });
  }
  /* THE SCHEDULER ROBOT'S FIELDS ARE ITS OWN TOO. It runs on its own (GitHub, on
     every new email, answer and save), so a copy held open here goes stale fast.
     Its working notes always come from the file; staff change them only through
     an explicit robotEdit (Take Over / Hand Back). While it is running a request,
     the times on offer, who has been sent what and the booking are its to set —
     unless a staff member books or cancels, which always wins. */
  var sr = onFile.robot && typeof onFile.robot === 'object' ? onFile.robot : null;
  if (sr || out.robotEdit) {
    var robot = Object.assign({}, sr || out.robot || {}, out.robotEdit || {});
    delete out.robotEdit;
    out.robot = robot;
    if (sr && sr.auto && robot.auto) {
      var staffClosed = (out.status === 'booked' || out.status === 'cancelled') && out.status !== onFile.status;
      if (!staffClosed) { out.status = onFile.status; out.chosen = onFile.chosen; out.bookedAt = onFile.bookedAt; }
      if (Array.isArray(onFile.slots)) out.slots = onFile.slots;
      if (Array.isArray(onFile.guests) && Array.isArray(out.guests)) {
        var gf = {}; onFile.guests.forEach(function (g) { if (g && g.id) gf[g.id] = g; });
        out.guests.forEach(function (g) { var f = g && gf[g.id]; if (f) { if (f.sentAt) g.sentAt = f.sentAt; if (f.reminders) g.reminders = f.reminders; } });
      }
    }
  }
  /* the log is append-only on both sides, so take the union, newest 80 */
  var a = Array.isArray(onFile.log) ? onFile.log : [], b = Array.isArray(out.log) ? out.log : [];
  if (a.length || b.length) {
    var seen = {}, all = [];
    a.concat(b).forEach(function (e) {
      if (!e) return;
      var k = String(e.at) + '|' + String(e.what) + '|' + String(e.by);
      if (seen[k]) return; seen[k] = 1; all.push(e);
    });
    all.sort(function (x, y) { return (Number(x.at) || 0) - (Number(y.at) || 0); });
    out.log = all.slice(-120);
  }
  return out;
}

function flush() {
  if (DB.flushing || !Object.keys(DB.pending).length) return;
  if (!(RS() && RS().token())) {
    saveState('Sign in to finish saving', true);
    RS() && RS().signIn({ reason: 'expired' }).then(function () { flush(); }, function () { saveState('Not saved — you are signed out. Your change is kept on this computer.', true); });
    return;
  }
  DB.flushing = true;
  var batch = clone(DB.pending), from = clone(DB.from), ids = Object.keys(batch), tries = 0;
  function attempt() {
    var next = Object.assign({}, DB.server, { docs: Object.assign({}, DB.server.docs) });
    delete next.savedBy; delete next.savedAt;
    ids.forEach(function (id) {
      if (batch[id] === null) { delete next.docs[id]; return; }
      /* November 5, 2026: only what was changed here goes over the copy on file (this is
         run again on the newest copy when someone else saved first) */
      var mine = from[id] ? mgDoc(next.docs[id] || null, batch[id], from[id], { clashes: [], theirs: {} }) : batch[id];
      if (mine === null) return;              /* removed by someone else and not changed here */
      next.docs[id] = keepGuestAnswers(next.docs[id], mine);
    });
    if (JSON.stringify(next).length > 940000) return Promise.reject(err('TOO_BIG', 'The Scheduler’s file is nearly full. Ask Perry to archive old requests.'));
    return writeData(PROJECT, 'requests', next, DB.sha).then(function (b) {
      DB.server = next; DB.sha = (b && b.sha) || DB.sha;
      ids.forEach(function (id) {
        if (JSON.stringify(DB.pending[id]) === JSON.stringify(batch[id])) { delete DB.pending[id]; delete DB.from[id]; }
        else if (batch[id] !== null) DB.from[id] = clone(batch[id]);   /* changed again since: the rest goes next */
        noteSeen(next.docs[id]);
      });
      keepUnsaved();
    }, function (e) {
      if (e.status === 409 && tries < 6) { tries++; return new Promise(function (r) { setTimeout(r, 300 * tries + Math.random() * 400); }).then(loadReqs).then(attempt); }
      throw e;
    });
  }
  chain = chain.then(attempt).then(function () {
    DB.flushing = false; DB.problem = '';
    saveState('Saved ' + fmtTime(Date.now(), VIEW_TZ));
    afterSave(ids);
    if (Object.keys(DB.pending).length) flush();
  }, function (e) {
    DB.flushing = false;
    if (e.status === 401 || e.code === 'SIGNED_OUT') { flush(); return; }
    noAccess(e);
    var msg = e.code === 'OFFLINE' ? 'Not saved yet — no connection. It will try again.' :
      e.code === 'UNKNOWN_PROJECT' ? 'Saving is not switched on for the Scheduler yet (Perry: see the README).' :
      'Not saved yet (' + (e.message || e.code) + '). It will try again.';
    DB.problem = msg; saveState(msg, true);
    if (e.code !== 'UNKNOWN_PROJECT' && e.code !== 'NO_ACCESS') setTimeout(flush, 15000);
    render();
  });
}
/* other people's changes: the relay has no push, so look again while the page is in use */
setInterval(function () {
  if (PREVIEW || document.hidden || DB.flushing || Object.keys(DB.pending).length || !DB.loaded) return;
  Promise.all([loadReqs(), typeof loadInbox === 'function' ? loadInbox() : false, typeof loadHealth === 'function' ? loadHealth() : false, Date.now() - ARCH.at > 30 * 60000 ? loadArchive() : false]).then(function (ch) { if (ch[0] || ch[1] || ch[2] || ch[3]) render(); }, function () {});
}, 45000);
window.addEventListener('beforeunload', function (e) { if (Object.keys(DB.pending).length && !PREVIEW) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------- the team (from Team HQ) ---------------- */
/* Only used if Team HQ's own list can't be read; Team HQ's list always wins. */
var FALLBACK_PEOPLE = [
  { id: 'brian', name: 'Brian Vieaux', role: 'President', email: 'bvieaux@mismo.org' },
  { id: 'jonathan', name: 'Jonathan Kearns', role: 'VP, Programs and Operations', email: 'jkearns@mismo.org' },
  { id: 'amy', name: 'Amy Moses', role: 'VP, Strategic Growth', email: 'amoses@mismo.org' },
  { id: 'kelly', name: 'Kelly Bradshaw', role: 'Director, Strategic Growth', email: 'kbradshaw@mismo.org' },
  { id: 'jonna', name: 'Jonna Critchley', role: 'Director, Programs and Operations', email: 'jcritchley@mismo.org' },
  { id: 'perry', name: 'Perry Williams', role: 'Sr. Program Manager', email: 'pwilliams@mismo.org' },
  { id: 'vanessa', name: 'Vanessa Rios', role: 'Sr. Systems and Operations Specialist', email: 'vrios@mismo.org' }
];
var TEAM = { people: FALLBACK_PEOPLE.slice(), cal: {}, calAt: 0, hqOk: false };
function person(id) { return TEAM.people.find(function (p) { return p.id === id; }) || null; }
function personByName(n) { n = String(n || '').toLowerCase().trim(); return TEAM.people.find(function (p) { return p.name.toLowerCase() === n; }) || null; }
function personByEmail(e) { e = String(e || '').toLowerCase().trim(); return TEAM.people.find(function (p) { return (p.email || '').toLowerCase() === e; }) || null; }
function emailOf(p) {
  if (!p) return '';
  if (p.email) return p.email;
  var f = FALLBACK_PEOPLE.find(function (x) { return x.id === p.id || x.name === p.name; });
  return f ? f.email : '';
}
function meP() { var m = me(); return personByEmail(m.email) || personByName(m.name); }
function loadTeam() {
  if (PREVIEW) { TEAM.hqOk = true; TEAM.cal = previewCalendars(); TEAM.calAt = Date.now(); return Promise.resolve(); }
  return readData(HQ, 'people').then(function (b) {
    var d = (b && b.data && b.data.docs) || {};
    var list = Object.keys(d).map(function (k) { var p = d[k]; return Object.assign({ id: p.id || k }, p); })
      .filter(function (p) { return p && p.name && !p.left && !p.gone && String(p.status || '') !== 'gone'; });
    if (list.length) {
      list.forEach(function (p) { if (!p.email) p.email = emailOf(p); });
      TEAM.people = list.sort(function (a, b) { return (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name); });
    }
    TEAM.hqOk = true;
  }, function () { TEAM.hqOk = false; }).then(loadCalendars);
}
/* Outlook availability, as Team HQ reads it: times in UTC, Free and "working elsewhere" ignored */
function calTime(v) { var s = String(v || '').trim(); if (!s) return null; if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'; var t = Date.parse(s); return isNaN(t) ? null : t; }
function calEv(x) {
  if (!x) return null;
  var show = String(x.show || x.showAs || '').toLowerCase();
  if (!show || show === 'free' || show === 'workingelsewhere') return null;
  var av = x.allDay !== undefined ? x.allDay : x.isAllDay, all = av === true || String(av).toLowerCase() === 'true';
  if (all) { var d0 = String(x.s || x.start || '').slice(0, 10), d1 = String(x.e || x.end || '').slice(0, 10); return { s: at(d0, 0, ET), e: at(d1, 0, ET), show: show, t: String(x.title || x.t || '').slice(0, 80), all: 1 }; }
  var s = calTime(x.s || x.start), e = calTime(x.e || x.end); if (s == null || e == null) return null;
  return { s: s, e: e, show: show, t: String(x.title || x.t || '').trim().slice(0, 80) };
}
/* ----------------------------------------------------------------------------
   WHO IS FREE, FROM OUTLOOK
   A Power Automate flow ("Scheduler - Team Availability") asks Microsoft for the
   team's free/busy every half hour and writes it to data/availability.json here.
   It writes FREE/BUSY ONLY: a row per person of one digit per half hour, counted
   from "start" — 0 free, 1 tentative, 2 busy, 3 out of office. No meeting names,
   no locations, no joining links ever leave Outlook, so nothing private lands in
   a file the whole team can read.
   This turns those digits back into the blocks the rest of the page already
   understands, so the grid, the suggestions and the clash warnings all work off
   it without knowing where it came from.
   -------------------------------------------------------------------------- */
/* mismo.org is an alias of mba.org — the same mailbox either way — and people are
   recorded under whichever one they happen to use (Perry is pwilliams@mba.org in
   Team HQ, pwilliams@mismo.org in Outlook). Matching on the part before the @ for
   those two domains keeps everybody lined up; anyone outside them is matched whole. */
function avKey(email) {
  var s = String(email || '').trim().toLowerCase(), at = s.lastIndexOf('@');
  if (at < 0) return s;
  var dom = s.slice(at + 1);
  return (dom === 'mismo.org' || dom === 'mba.org') ? s.slice(0, at) : s;
}
var AV_SHOW = { '1': 'tentative', '2': 'busy', '3': 'oof' };
var AV_LABEL = { '1': 'Tentative', '2': 'Busy', '3': 'Out of office' };
function avBlocks(view, start, iv) {
  var out = [], i = 0, n = view.length;
  while (i < n) {
    var c = view.charAt(i);
    if (!AV_SHOW[c]) { i++; continue; }
    var j = i; while (j < n && view.charAt(j) === c) j++;
    out.push({ s: start + i * iv, e: start + j * iv, show: AV_SHOW[c], t: AV_LABEL[c] });
    i = j;
  }
  return out;
}
function loadCalendars(force) {
  if (PREVIEW) return Promise.resolve();
  if (!force && TEAM.calAt && Date.now() - TEAM.calAt < 5 * 60000) return Promise.resolve();
  return readData(PROJECT, 'availability').then(function (b) {
    var d = (b && (b.data || b.content)) || null;
    TEAM.calAt = Date.now();
    if (!d || !Array.isArray(d.people)) { TEAM.calFrom = ''; return; }
    var start = Date.parse(d.start), iv = (Number(d.intervalMinutes) || 30) * 60000;
    if (!isFinite(start)) { TEAM.calFrom = ''; return; }
    var byEmail = {};
    d.people.forEach(function (p) {
      if (p && p.id && typeof p.view === 'string') byEmail[avKey(p.id)] = p.view;
    });
    var by = {};
    TEAM.people.forEach(function (person) {
      var v = byEmail[avKey(person.email || emailOf(person))];
      if (v) by[person.id] = avBlocks(v, start, iv);
    });
    TEAM.cal = by;
    TEAM.calFrom = d.updatedAt || '';
    TEAM.calStart = start;
    TEAM.calEnd = start + iv * (d.people[0] && d.people[0].view ? d.people[0].view.length : 0);
  }, function () { TEAM.calAt = Date.now(); TEAM.calFrom = ''; });
}
function hasCal(pid) { return !!TEAM.cal[pid]; }
/* 'free' | 'busy' | 'tentative' | 'oof' | null (Outlook not connected) for a person over a stretch of time */
function calState(pid, s, e) {
  var list = TEAM.cal[pid]; if (!list) return null;
  var hit = list.filter(function (x) { return x.s < e && x.e > s; });
  if (!hit.length) return 'free';
  if (hit.some(function (x) { return x.show === 'oof'; })) return 'oof';
  if (hit.some(function (x) { return x.show === 'busy'; })) return 'busy';
  return 'tentative';
}
function calWhat(pid, s, e) { var list = TEAM.cal[pid] || []; var h = list.filter(function (x) { return x.s < e && x.e > s; }); return h.map(function (x) { return x.t || (x.show === 'oof' ? 'Out of office' : 'Busy'); }).join(', '); }

/* ---------------- Team HQ: one follow-up task per request ---------------- */
var HQ_TASK_PREFIX = 'sched-';
function hqTaskFor(req) {
  var owner = personByEmail(req.owner) || personByName(req.ownerName);
  if (!owner) return null;
  if (req.robot && req.robot.auto) {
    var look = needsYou(req), apr = awaitingApproval(req);
    return { id: HQ_TASK_PREFIX + req.id, o: owner.id, t: (apr ? 'Approve a time: ' : 'Needs a look: ') + (req.title || 'meeting request'), s: look ? 'Waiting on Someone' : 'Done', due: look ? todayISO(ET) : '',
      notes: apr ? 'The Scheduler is holding ' + slotLabel(req.robot.proposed, ET, true) + ' until Vanessa or Jonna approves it. ' + SITE + '#r=' + req.id
        : look ? 'The Scheduler stopped because ' + (req.robot.why || 'it needs a person') + '. ' + SITE + '#r=' + req.id : 'The Scheduler is handling this one. ' + SITE + '#r=' + req.id,
      p: look ? 'High' : 'Normal', d: [], r: '', w: '', rail: 0 };
  }
  var open = req.status !== 'booked' && req.status !== 'cancelled';
  var waiting = (req.guests || []).filter(function (g) { return g.sentAt && !g.answer; });
  var due = waiting.map(function (g) { return followDue(req, g); }).sort()[0] || '';
  var names = waiting.map(function (g) { return g.name || g.email; });
  return {
    id: HQ_TASK_PREFIX + req.id, o: owner.id,
    t: 'Follow up: ' + (req.title || 'meeting request'),
    s: open && waiting.length ? 'Waiting on Someone' : 'Done',
    due: open && waiting.length ? due : '',
    notes: open && waiting.length
      ? 'Still waiting to hear from ' + names.join(', ') + '. Open it in the Scheduler to draft a follow-up: ' + SITE + '#r=' + req.id
      : 'Everyone has answered or the meeting is booked. ' + SITE + '#r=' + req.id,
    p: 'Normal', d: [], r: '', w: '', rail: 0
  };
}
var hqChain = Promise.resolve();
function syncHqTasks(ids) {
  if (PREVIEW || !TEAM.hqOk) return;
  var wants = ids.map(getReq).filter(Boolean).map(function (r) { return { r: r, t: hqTaskFor(r) }; }).filter(function (x) { return x.t; });
  if (!wants.length) return;
  hqChain = hqChain.then(function () {
    var tries = 0;
    function go() {
      return readData(HQ, 'tasks').then(function (b) {
        var c = (b && b.data && typeof b.data === 'object') ? b.data : {}; var cur = c.docs || {};
        var changed = false, next = Object.assign({}, c, { docs: Object.assign({}, cur) });
        delete next.savedBy; delete next.savedAt;
        wants.forEach(function (x) {
          var had = cur[x.t.id];
          /* never open a task for a request nobody has been asked about yet */
          if (!had && x.t.s === 'Done') return;
          var merged = Object.assign({ at: Date.now(), by: x.t.o, ord: 99990 }, had || {}, x.t);
          if (had && had.s === 'Done' && x.t.s === 'Done') return;
          if (had && ['t', 's', 'due', 'notes', 'o'].every(function (k) { return had[k] === merged[k]; })) return;
          next.docs[x.t.id] = merged; changed = true;
        });
        if (!changed) return;
        return writeData(HQ, 'tasks', next, b && b.sha).catch(function (e) {
          if (e.status === 409 && tries < 5) { tries++; return new Promise(function (r) { setTimeout(r, 400 * tries); }).then(go); }
          throw e;
        });
      });
    }
    return go();
  }).catch(function (e) { console.warn('Team HQ reminder not updated:', e && (e.code || e.message)); });
}
function afterSave(ids) { syncHqTasks(ids); }

/* ---------------- asking Claude (the relay's Ask route; the key stays in the relay) ---------------- */
var ASK = { ready: null };
function askReady() {
  if (PREVIEW) { ASK.ready = false; return Promise.resolve(false); }
  if (ASK.ready !== null) return Promise.resolve(ASK.ready);
  return call(PROJECT, '/ask', 'POST', { prompt: '' }).then(function () { ASK.ready = true; return true; }, function (e) { ASK.ready = e.code === 'NO_PROMPT'; return ASK.ready; });
}
function ask(prompt) { return call(PROJECT, '/ask', 'POST', { prompt: prompt }).then(function (b) { return String((b && b.text) || ''); }); }
function jsonIn(text) { var a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a < 0 || b < a) return null; try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; } }

/* ---------------- outside links: on once the relay has the two public routes ---------------- */
var LINKS = { live: null };
function linksLive() {
  if (PREVIEW) { LINKS.live = true; return Promise.resolve(true); }
  if (LINKS.live !== null) return Promise.resolve(LINKS.live);
  return call(PROJECT, '/poll/ready', 'GET', null, true).then(function (b) { LINKS.live = !!(b && b.ok); return LINKS.live; }, function () { LINKS.live = false; return false; });
}
function guestLink(req, g) { return SITE + 'respond.html' + (PREVIEW ? '?preview=1' : '') + '#r=' + req.id + '&g=' + g.id + '.' + g.code; }

/* ---------------- a request's state ---------------- */
function followDue(req, g) {
  var last = Math.max(g.sentAt || 0, (g.followUps || []).reduce(function (a, b) { return Math.max(a, b); }, 0));
  return addBiz(last, +req.followDays || DEFAULT_FOLLOW_DAYS);
}
function guestState(req, g) {
  if (g.answer) return 'answered';
  if (!g.sentAt) return 'unsent';
  if (req.status === 'booked' || req.status === 'cancelled') return 'closed';
  return followDue(req, g) <= todayISO(ET) ? 'due' : 'waiting';
}
function isAuto(req) { return !!(req && req.robot && req.robot.auto && req.robot.stage !== 'person'); }
function needsLook(req) { return !!(req && req.robot && req.robot.auto && req.robot.stage === 'person' && req.status !== 'booked' && req.status !== 'cancelled'); }
function awaitingApproval(req) { return !!(req && req.robot && req.robot.auto && req.robot.stage === 'approve' && req.robot.proposed && !req.robot.approved && req.status !== 'booked' && req.status !== 'cancelled'); }
/* warm follow-ups the Scheduler sends a guest who hasn't answered: a week after the poll, then weekly, three at most (same rule as robot/logic.mjs) */
var FOLLOW_EVERY = 7 * 864e5, FOLLOW_MAX = 3;
/* a quick request (the email asked for dates within a week) is followed up at noon Eastern each working day */
function askedWins(req) {
  var R = req.robot || {}, ok = function (w) { return w && isFinite(w.s) && isFinite(w.e) && w.e > w.s; };
  if (ok(R.between)) return [R.between];
  var off = (R.offered || []).filter(ok);
  return off.length && off.every(function (w) { return w.e - w.s >= 6 * 36e5; }) ? off : [];
}
function isQuickReq(req, sentAt) { var w = askedWins(req); return !!(w.length && sentAt && Math.max.apply(null, w.map(function (x) { return x.e; })) <= sentAt + FOLLOW_EVERY); }
function followOf(req, g) {
  var R = req.robot || {}, restart = R.followRestartAt && R.followRestartAt > (g.sentAt || 0) ? R.followRestartAt : 0, since = restart || g.sentAt || 0;
  var mine = (g.reminders || []).filter(function (t) { return t >= since; }).sort(function (a, b) { return a - b; });
  if (isQuickReq(req, g.sentAt)) {
    var lq = mine.length ? mine[mine.length - 1] : since;
    return { sent: mine.length, next: !mine.length && restart ? restart : at(addBiz(lq, 1), 12 * 60, ET), quick: true };
  }
  var last = mine.length ? mine[mine.length - 1] : (restart ? restart - FOLLOW_EVERY : since);
  return { sent: mine.length, next: last + FOLLOW_EVERY };
}
function followWaiting(req) { return (req.guests || []).filter(function (g) { return g.sentAt && !g.answer && !g.gone; }); }
function followsFinished(req) { var R = req.robot || {}; return isAuto(req) && R.stage === 'polling' && !!R.followDone && !R.followStop && req.status !== 'booked' && req.status !== 'cancelled' && followWaiting(req).length > 0; }
function startFollows(req) {
  var fresh = followWaiting(req).some(function (g) { return followOf(req, g).sent >= FOLLOW_MAX; }), r = clone(req);
  r.robotEdit = fresh ? { followRestartAt: Date.now(), followStop: null, followDone: 0 } : { followStop: null, followDone: 0 };
  put(r, fresh ? 'Started follow-ups again' : 'Turned follow-ups back on');
  toast(fresh ? 'Follow-ups started again: the first goes out within a couple of hours, then one a week, three in all.' : 'Follow-ups are back on.');
}
function stopFollows(req) {
  var r = clone(req); r.robotEdit = { followStop: { by: me().name, at: Date.now() }, followDone: 0 };
  put(r, 'Stopped follow-ups'); toast('Follow-ups stopped. The poll stays open.');
}
/* no time works for everyone: the Scheduler waits for Vanessa or Jonna to pick, make someone optional, or send new times */
function awaitingDecision(req) { var R = req.robot || {}; return isAuto(req) && R.stage === 'polling' && !!R.decide && !R.sendMore && req.status !== 'booked' && req.status !== 'cancelled'; }
function sendNewTimes(req) {
  if (!confirm('Send a fresh set of times for “' + (req.title || 'this meeting') + '”?\n\nEveryone who already answered gets a “New Times” email from scheduling@mismo.org.')) return;
  var r = clone(req); r.robotEdit = { sendMore: { by: me().name, at: Date.now() } };
  put(r, 'Asked the Scheduler to send new times'); toast('New times go out from scheduling@mismo.org within a few minutes.');
}
function toggleOptional(req, g) {
  var r = clone(getReq(req.id)), on = false;
  r.guests.forEach(function (x) { if (x.id === g.id) { x.optional = !x.optional; on = x.optional; if (!on) delete x.optional; } });
  put(r, (on ? 'Made ' : 'Made required: ') + (g.name || g.email) + (on ? ' optional' : ''));
  toast(on ? first(g.name || g.email) + ' is optional: times only have to work for the others, and the invite lists them as optional.' : first(g.name || g.email) + ' is required again.');
}
function optionalStaff(r) { return ((r && r.internalOptional) || []).filter(function (id) { return (r.internal || []).indexOf(id) < 0; }).map(function (id) { var p = person(id); return p ? p.name : id; }); }
/* someone outside MISMO listed other outside people: held until Vanessa or Jonna check it (robot/logic.mjs) */
function awaitingPollCheck(req) { var R = req.robot || {}; return isAuto(req) && (!R.stage || R.stage === 'new') && !!R.pollHeld && !R.pollOk && req.status !== 'booked' && req.status !== 'cancelled'; }
function sendPollOk(req) {
  if (!canApprove()) { toast('Only Vanessa or Jonna can send it.'); return; }
  var r = clone(req); r.robotEdit = { pollOk: { by: me().name, at: Date.now() } };
  put(r, 'Checked the request and let the poll go out'); toast('The poll goes out from scheduling@mismo.org within a few minutes.');
}
/* a guest asked to move a booked meeting and MISMO is free: waiting for Vanessa or Jonna (robot/logic.mjs) */
function awaitingMove(req) { var R = req.robot || {}; return !!(R.auto && req.status === 'booked' && R.proposedMove && R.proposedMove.s); }
function approveMove(req) {
  if (!canApprove()) { toast('Only Vanessa or Jonna can approve a move.'); return; }
  var P = req.robot.proposedMove;
  if (!confirm('Move “' + (req.title || 'this meeting') + '” to ' + slotLabel(P, VIEW_TZ, true) + '?\n\nEveryone gets Outlook’s cancellation for the old time and a new invitation from scheduling@mismo.org.')) return;
  var r = clone(req); r.robotEdit = { moveTo: { s: P.s, e: P.e, by: me().name, at: Date.now() }, proposedMove: null };
  put(r, 'Approved moving it to ' + slotLabel(P, ET, true)); toast('Moving it. The new invitation goes out within a few minutes.');
}
function keepTime(req) { var r = clone(req); r.robotEdit = { proposedMove: null }; put(r, 'Kept the current time (the guest’s new time wasn’t used)'); toast('Kept the current time. Reply to the guest if they need to hear why.'); }
/* move a booked meeting yourself: pick a day and time; the Scheduler shows who from MISMO is free */
function openMove(req) {
  if (!canApprove()) { toast('Only Vanessa or Jonna can move a meeting.'); return; }
  var cur = slotById(req, req.chosen), dur = cur ? cur.e - cur.s : (+req.duration || 30) * 60000;
  var D = dialog('Move “' + req.title + '”');
  var days = bizDaysAhead(15, todayISO(ET));
  var f = el('div', 'move-f');
  f.innerHTML = '<p class="small muted">Times are Eastern. Everyone gets Outlook’s cancellation for ' + esc(cur ? slotLabel(cur, ET, true) : 'the old time') + ' and a new invitation from scheduling@mismo.org.</p>' +
    '<label class="fl">Day<select id="mv-d">' + days.map(function (d) { return '<option value="' + d + '">' + esc(fmtDay(at(d, 720, ET), ET)) + '</option>'; }).join('') + '</select></label>' +
    '<label class="fl">Start<select id="mv-t">' + Array.from({ length: 18 }, function (_, i) { var m = 480 + i * 30; return '<option value="' + m + '"' + (m === 600 ? ' selected' : '') + '>' + esc(fmtTime(at(days[0], m, ET), ET)) + '</option>'; }).join('') + '</select></label>' +
    '<p id="mv-s" class="small" style="margin-top:10px"></p>';
  D.body.appendChild(f);
  var say = $('#mv-s', f);
  function pick() { var d = $('#mv-d', f).value, m = +$('#mv-t', f).value, s = at(d, m, ET); return { s: s, e: s + dur }; }
  function check() {
    var p = pick(), busy = [], unk = [];
    (req.internal || []).forEach(function (pid) { var st = calState(pid, p.s, p.e), pp = person(pid) || { name: pid }; if (st === null) unk.push(first(pp.name)); else if (st !== 'free') busy.push(first(pp.name) + (st === 'tentative' ? ' (tentative)' : st === 'oof' ? ' (out of office)' : '')); });
    var clash = allReqs().some(function (o) { if (o.id === req.id || o.status !== 'booked' || (o.where || 'Zoom') !== 'Zoom' || (req.where || 'Zoom') !== 'Zoom' || zoomRoomOf(o) !== zoomRoomOf(req)) return false; var c = slotById(o, o.chosen); return c && c.s < p.e && c.e > p.s; });
    say.innerHTML = busy.length ? '<b style="color:var(--bad)">Busy then:</b> ' + esc(busy.join(', ')) + '.' : '<b style="color:var(--good)">Everyone from MISMO is free.</b>' + (unk.length ? ' (Outlook not connected for ' + esc(unk.join(', ')) + '.)' : '');
    if (clash) say.innerHTML += ' <b style="color:var(--bad)">Another Scheduler Zoom meeting is in the ' + (zoomRoomOf(req) === 'membership' ? 'membership' : 'MISMO') + ' room then.</b>';
  }
  $('#mv-d', f).onchange = check; $('#mv-t', f).onchange = check; check();
  D.foot.appendChild(btn('Cancel', 'ghost', D.close));
  D.foot.appendChild(btn('Move It', '', function () {
    var p = pick(); if (p.s < Date.now()) { toast('Pick a time that hasn’t passed.'); return; }
    var r = clone(getReq(req.id)); r.robotEdit = { moveTo: { s: p.s, e: p.e, by: me().name, at: Date.now() }, proposedMove: null };
    put(r, 'Moved it to ' + slotLabel(p, ET, true)); D.close(); toast('Moving it. The new invitation goes out within a few minutes.');
  }, 'check'));
}
/* which MISMO Zoom room a meeting uses (same rule as robot/logic.mjs roomOf) */
function zoomRoomOf(r) {
  var z = r && r.robot && r.robot.invite && r.robot.invite.zoom;
  if (z && z.id) return String(z.id) === '5015163748' ? 'membership' : 'main';
  return /\bmembership\b/i.test(((r && r.title) || '') + ' ' + ((r && r.purpose) || '')) ? 'membership' : 'main';
}
function cancelMeeting(req) {
  if (!canApprove()) { toast('Only Vanessa or Jonna can cancel a meeting.'); return; }
  var note = prompt('Cancel “' + (req.title || 'this meeting') + '”? Everyone gets Outlook’s cancellation from scheduling@mismo.org.\n\nA short note for them (optional):', '');
  if (note === null) return;
  var r = clone(req); r.robotEdit = { cancelMeeting: { by: me().name, at: Date.now(), note: String(note || '').slice(0, 300) } };
  put(r, 'Cancelled the meeting'); toast('Cancelling. Everyone gets Outlook’s cancellation within a few minutes.');
}
function needsYou(req) { return needsLook(req) || awaitingApproval(req) || followsFinished(req) || awaitingDecision(req) || awaitingPollCheck(req) || awaitingMove(req); }
/* Vanessa or Jonna approve a time before anyone outside MISMO is told it's booked */
var APPROVERS = ['vrios', 'jcritchley'];
function canApprove() { return PREVIEW || (canEdit() && APPROVERS.indexOf(avKey(me().email)) >= 0); }
function approveSlot(req, sl) {
  if (!canApprove()) { toast('Only Vanessa or Jonna can approve a time.'); return; }
  var r = clone(req); r.robotEdit = { approved: { id: sl.id, by: me().name, at: Date.now() } };
  if (!(r.slots || []).some(function (x) { return x.id === sl.id; })) r.slots = (r.slots || []).concat({ id: sl.id, s: sl.s, e: sl.e, added: Date.now() });
  put(r, 'Approved ' + slotLabel(sl, ET, true));
  toast('Approved. The calendar invitation goes out from scheduling@mismo.org within a few minutes.');
}
function phase(req) {
  if (req.status === 'cancelled') return 'cancelled';
  if (req.status === 'booked') return 'booked';
  if (needsLook(req)) return 'look';
  if (awaitingApproval(req)) return 'approve';
  if (req.robot && req.robot.auto && req.robot.stage === 'approve') return 'auto';
  if (isAuto(req) && (!req.robot.stage || req.robot.stage === 'new')) return 'auto';
  var gs = req.guests || [];
  if (!(req.slots || []).length) return 'draft';
  if (gs.length && !gs.some(function (g) { return g.sentAt || g.answer; })) return 'draft';
  if (gs.every(function (g) { return g.answer; })) return 'ready';
  return 'collecting';
}
var PHASE = {
  draft: { n: 'Getting ready', c: 'p-draft' }, collecting: { n: 'Waiting on replies', c: 'p-collect' },
  ready: { n: 'Ready to book', c: 'p-ready' }, booked: { n: 'Booked', c: 'p-booked' }, cancelled: { n: 'Cancelled', c: 'p-cancel' },
  look: { n: 'Needs a Look', c: 'p-due' }, unscheduled: { n: 'Couldn’t Schedule', c: 'p-unsch' }, auto: { n: 'Working on It', c: 'p-collect' }, approve: { n: 'Waiting for Approval', c: 'p-ready' }
};
function couldntSchedule(r) { return !!(r && r.status === 'cancelled' && r.closed === 'unscheduled'); }
function bookedSlot(r) { return r && r.status === 'booked' ? slotById(r, r.chosen) : null; }
function isPast(r) { var s = bookedSlot(r); return !!(s && s.e <= Date.now()); }
function closeUnscheduled(req) {
  if (!confirm('Close “' + (req.title || 'this request') + '” as Couldn’t Schedule? The Scheduler stops emailing about it, and it stays on the Dashboard for reference. You can bring it back later.')) return;
  var r = clone(req); r.status = 'cancelled'; r.closed = 'unscheduled'; r.closedAt = Date.now(); r.closedBy = me().name;
  put(r, 'Closed: couldn’t schedule'); toast('Closed as Couldn’t Schedule.');
}
function phasePill(req) { var p = couldntSchedule(req) ? PHASE.unscheduled : PHASE[phase(req)]; return '<span class="pill ' + p.c + '">' + p.n + '</span>'; }
function slotById(req, id) { return (req.slots || []).find(function (s) { return s.id === id; }) || null; }
/* everyone's answer for one time: 'yes' | 'maybe' | 'no' | null */
/* ----------------------------------------------------------------------------
   A HALF HOUR THIS TEAM HAS ALREADY GIVEN AWAY
   When a meeting here is booked, that time is spoken for — but Outlook does not
   know it yet. The invite still has to be looked over and sent, and even once it
   is, the free/busy feed only comes round every half hour. In between the same
   slot would keep being offered on every other request still open, and two
   meetings end up promised the same person at the same time.
   So a booked meeting here counts against anybody who is in both requests, at
   once, without waiting for Outlook to catch up. It can still be overridden by
   hand for a deliberate double-booking.
   -------------------------------------------------------------------------- */
function takenFor(req, pid, sl) {
  var rs = allReqs();
  for (var i = 0; i < rs.length; i++) {
    var o = rs[i];
    if (!o || o.id === req.id || o.status !== 'booked' || !o.chosen) continue;
    if ((o.internal || []).indexOf(pid) < 0) continue;
    var c = (o.slots || []).filter(function (x) { return x && x.id === o.chosen; })[0];
    if (c && isFinite(c.s) && isFinite(c.e) && c.s < sl.e && c.e > sl.s) return o;
  }
  return null;
}

/* ============================================================================
   THE POLL EMAIL, AND HOW IT GETS SENT
   MISMO already has one way of sending branded email and this uses it rather
   than inventing a second. Member 360 writes a batch into data/outbox.json in
   its own private repository; the commit wakes a Power Automate flow, which
   sends each one from the sender's own Outlook and records the result in
   data/outbox-sent.json. The Sponsorship Portal does the same. So does this.
   Nothing here sends anything by itself — writing the batch is the whole job,
   and the flow is the only thing that can put a message on the wire.
   The frame below is the one Member 360, the CMS and Summit HQ already use, so
   a guest sees the same MISMO email whichever tool it came from.
   ========================================================================== */
var EMAIL_LOGO = 'https://resources.mismo.org/member-360/mismo-logo-email.png';
var OUTBOX_KEEP = 60;
function escH(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function emailShell(inner, label) {
  var F = 'font-family:Arial,Helvetica,sans-serif';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;padding:0;background:#f1f6fa">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f1f6fa"><tr><td align="center" style="padding:24px 12px">' +
  '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #d5e2ed;border-radius:8px">' +
  '<tr><td style="background:#0d314c;padding:16px 32px;border-radius:7px 7px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#ffffff;border-radius:5px;padding:8px 12px"><img src="' + EMAIL_LOGO + '" alt="MISMO" width="132" style="display:block;border:0;outline:none;width:132px;height:auto"></td></tr></table></td><td valign="middle" align="right" style="' + F + ';font-size:13px;font-weight:600;color:#a9d8f3">' + escH(label || 'Scheduling') + '</td></tr></table></td></tr>' +
  '<tr><td style="height:3px;line-height:3px;font-size:0;background:#74bfeb">&nbsp;</td></tr>' +
  '<tr><td style="padding:26px 32px 14px;' + F + ';font-size:15px;line-height:1.6;color:#0d314c">' + inner + '</td></tr>' +
  '<tr><td style="padding:0 0 12px;font-size:0;line-height:0">&nbsp;</td></tr>' +
  '<tr><td style="background:#0d314c;padding:14px 32px;border-radius:0 0 7px 7px;' + F + ';font-size:12px;line-height:1.5;color:#a9d8f3">MISMO &middot; Mortgage Industry Standards Maintenance Organization &middot; ' +
  '<a href="https://www.mismo.org" style="color:#ffffff;text-decoration:underline">mismo.org</a></td></tr>' +
  '</table></td></tr></table></body></html>';
}
function slotsInOrder(req) {
  return (req.slots || []).filter(function (s) { return s && isFinite(s.s) && isFinite(s.e); })
    .slice().sort(function (a, b) { return a.s - b.s; });
}
function slotLine(sl) { return fmtDay(sl.s, ET, true) + ' · ' + fmtTime(sl.s, ET) + '–' + fmtTime(sl.e, ET) + ' ET'; }
function pollEmailHtml(req, g) {
  var F = 'font-family:Arial,Helvetica,sans-serif', link = guestLink(req, g);
  var rows = slotsInOrder(req).map(function (sl) {
    return '<tr><td style="padding:8px 0;border-bottom:1px solid #e5eef5;' + F + ';font-size:15px;color:#0d314c">' + escH(slotLine(sl)) + '</td></tr>';
  }).join('');
  var inner = '<p style="margin:0 0 14px">Hello ' + escH(first(g.name) || 'there') + ',</p>' +
    '<p style="margin:0 0 14px">' + escH(req.ownerName || 'MISMO') + ' would like to set up <b>' + escH(req.title || 'a meeting') + '</b>' +
    (req.duration ? ' (' + escH(String(req.duration)) + ' minutes)' : '') + '.</p>' +
    '<p style="margin:0 0 14px">Please choose the times that work for you. It takes less than a minute.</p>' +
    /* the Member 360 email button, copied exactly */
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:6px 0 22px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#0d314c" style="background:#0d314c;border-radius:6px;padding:12px 24px;mso-padding-alt:12px 24px">' +
    '<a href="' + escH(link) + '" target="_blank" style="display:inline-block;' + F + ';font-size:14px;font-weight:700;line-height:18px;color:#ffffff;text-decoration:none">Choose the Times That Work</a></td></tr></table></td></tr></table>' +
    '<p style="margin:0 0 14px">Tick ✓ for the times that work and ✗ for the ones that don’t, then press Send. There is a box for a note if none of them suit. ' +
    'The link is yours alone; nobody else’s answers are shown on it.</p>' +
    '<p style="margin:0">Thank you,<br>' + escH(req.ownerName || 'MISMO') + '</p>';
  return emailShell(inner, 'Scheduling');
}
function pollEmailText(req, g) {
  var link = guestLink(req, g);
  return 'Hello ' + (first(g.name) || 'there') + ',\n\n' +
    (req.ownerName || 'MISMO') + ' would like to set up "' + (req.title || 'a meeting') + '"' +
    (req.duration ? ' (' + req.duration + ' minutes)' : '') + '.\n\n' +
    'Here are the times on offer:\n' + slotsInOrder(req).map(function (sl) { return '  • ' + slotLine(sl); }).join('\n') +
    '\n\nMark the ones that work:\n' + link +
    '\n\nThe link is yours alone; nobody else’s answers are shown on it.\n\nThank you,\n' + (req.ownerName || 'MISMO') + '\n';
}
/* one batch into data/outbox.json, the way Member 360 does it */
function outboxAdd(batch) {
  return readData(PROJECT, 'outbox').then(function (b) {
    var cur = (b && (b.data || b.content)) || {};
    var docs = (cur.docs && typeof cur.docs === 'object') ? cur.docs : {};
    docs[batch.id] = batch;
    var keys = Object.keys(docs).sort(function (x, y) { return (docs[x].at || 0) - (docs[y].at || 0); });
    while (keys.length > OUTBOX_KEEP) delete docs[keys.shift()];
    var next = { docs: docs };
    /* Power Automate can loop over a list but not over an object, so the same
       batches ride along as a plain list (Member 360 and Sponsorship do this) */
    next.list = Object.keys(docs).map(function (k) { return Object.assign({ id: k }, docs[k]); });
    return writeData(PROJECT, 'outbox', next, (b && b.sha) || null);
  });
}
function sendPoll(req, guests) {
  var list = (guests || []).filter(function (g) { return g && g.email && g.code; });
  if (!list.length) return Promise.resolve(0);
  if (!slotsInOrder(req).length) { toast('Add some times first — there is nothing to ask about yet.'); return Promise.resolve(0); }
  var m = me();
  var batch = {
    id: 'ob' + rid(10), kind: 'scheduler-poll', at: Date.now(),
    from: m.email, fromName: m.name, requestId: req.id, requestTitle: req.title || '',
    emails: list.map(function (g) {
      return {
        to: g.email, toName: g.name || '', guestId: g.id,
        subject: 'Finding a Time for ' + (req.title || 'a MISMO Meeting'),
        html: pollEmailHtml(req, g), text: pollEmailText(req, g)
      };
    })
  };
  return outboxAdd(batch).then(function () {
    var r = clone(getReq(req.id)) || clone(req), now = Date.now();
    (r.guests || []).forEach(function (g) {
      if (list.some(function (x) { return x.id === g.id; }) && !g.sentAt) g.sentAt = now;
    });
    r.log = (Array.isArray(r.log) ? r.log : []).concat({ at: now, by: m.name, what: 'Poll emailed to ' + list.length + (list.length === 1 ? ' guest' : ' guests') }).slice(-80);
    put(r);
    toast('Queued for ' + list.length + (list.length === 1 ? ' guest' : ' guests') + '. It goes out from scheduling@mismo.org within a minute or two.');
    render({ full: true });
    return list.length;
  }, function (e) {
    toast('Could not queue it (' + ((e && (e.message || e.code)) || 'unknown') + '). Nothing was sent.', 1);
    return 0;
  });
}

function internalAnswer(req, pid, sl) {
  var hand = req.internalAns && req.internalAns[pid] && req.internalAns[pid][sl.id];
  if (hand) return { v: hand, hand: 1 };
  var bk = takenFor(req, pid, sl);
  if (bk) return { v: 'no', booked: bk };
  var c = calState(pid, sl.s, sl.e);
  if (c === null) return { v: null };
  return { v: c === 'free' ? 'yes' : c === 'tentative' ? 'maybe' : 'no', cal: 1, what: c === 'free' ? '' : calWhat(pid, sl.s, sl.e) };
}
function guestAnswer(g, sl) {
  if (!g.answer) return null;
  if ((g.answer.yes || []).indexOf(sl.id) >= 0) return 'yes';
  if ((g.answer.maybe || []).indexOf(sl.id) >= 0) return 'maybe';
  /* a time added after they answered hasn't been answered yet (same rule as the robot) */
  if (sl.added && g.answer.at && sl.added > g.answer.at + 15 * 60000) return null;
  return 'no';
}
function score(req, sl) {
  var s = 0, yes = 0, no = 0, maybe = 0, none = 0;
  (req.internal || []).forEach(function (pid) { var a = internalAnswer(req, pid, sl).v; if (a === 'yes') yes++; else if (a === 'maybe') maybe++; else if (a === 'no') no++; else none++; });
  (req.guests || []).forEach(function (g) { var a = guestAnswer(g, sl); if (a === 'yes') yes++; else if (a === 'maybe') maybe++; else if (a === 'no') no++; else none++; });
  s = yes * 3 + maybe - no * 6;
  return { s: s, yes: yes, maybe: maybe, no: no, none: none };
}
function bestSlot(req) {
  var sl = (req.slots || []).filter(function (x) { return x.s > Date.now(); });
  if (!sl.length) return null;
  var ranked = sl.map(function (x) { return { sl: x, sc: score(req, x) }; }).sort(function (a, b) { return b.sc.s - a.sc.s || a.sl.s - b.sl.s; });
  return ranked[0].sc.yes ? ranked[0] : null;
}
function followList(mineOnly) {
  var m = me(), out = [];
  allReqs().forEach(function (r) {
    if (mineOnly && String(r.owner || '').toLowerCase() !== m.email) return;
    if (r.status === 'booked' || r.status === 'cancelled') return;
    if (isAuto(r)) return;   /* the Scheduler sends its own reminders */
    (r.guests || []).forEach(function (g) {
      var st = guestState(r, g); if (st !== 'due' && st !== 'waiting') return;
      out.push({ r: r, g: g, due: followDue(r, g), st: st });
    });
  });
  return out.sort(function (a, b) { return a.due.localeCompare(b.due); });
}

/* ======================================================================
   SCREENS
   ====================================================================== */
var PANE_VIEWS = ['inbox', 'follow', 'list', 'new', 'cal'];
var STATE = { tab: 'dash', pane: null, reqId: null, fuMine: lsGet('fuMine', true), listMine: lsGet('listMine', false), listShow: lsGet('listShow', 'active') };
var PAGES = ['dash', 'stats', 'help'];
function readHash() {
  var h = location.hash.replace(/^#/, ''), m = /(?:^|&)r=([a-z0-9]+)/.exec(h), t = /(?:^|&)tab=([a-z]+)/.exec(h);
  STATE.reqId = m ? m[1] : null;
  var tab = t ? t[1] : 'dash';
  if (PANE_VIEWS.indexOf(tab) >= 0) { STATE.tab = 'dash'; STATE.pane = tab; }
  else { STATE.tab = PAGES.indexOf(tab) >= 0 ? tab : 'dash'; STATE.pane = null; }
  if (STATE.reqId) { STATE.tab = 'dash'; STATE.pane = 'req'; }
}
/* the Dashboard and Help are the pages; a request, the full lists, the calendar and a new
   request open in the panel on the right, over the Dashboard */
function go(tab, reqId) {
  var wasTab = STATE.tab;
  if (reqId) { STATE.tab = 'dash'; STATE.pane = 'req'; STATE.reqId = reqId; }
  else if (PANE_VIEWS.indexOf(tab) >= 0) { STATE.tab = 'dash'; STATE.pane = tab; STATE.reqId = null; }
  else { STATE.tab = PAGES.indexOf(tab) >= 0 ? tab : 'dash'; STATE.pane = null; STATE.reqId = null; }
  var h = reqId ? '#r=' + reqId : '#tab=' + (STATE.pane || STATE.tab);
  if (location.hash !== h) history.pushState(null, '', h);
  render({ full: true });
  if (!STATE.pane || wasTab !== STATE.tab) window.scrollTo(0, 0);
  var pb = $('#pane-b'); if (pb && STATE.pane) pb.scrollTop = 0;
}
function closePane() { go('dash'); }
window.addEventListener('popstate', function () { readHash(); render({ full: true }); });
window.addEventListener('hashchange', function () { readHash(); render({ full: true }); });

function render(opts) {
  var app = $('#app'); if (!app) return;
  document.title = 'Scheduler';
  var keepFocus = document.activeElement && document.activeElement.id;
  var full = opts && opts.full;
  /* never wipe a half-filled New Request form because something changed in the background */
  var formOpen = STATE.pane === 'new' && $('#pane-b #f-title');
  if (!(formOpen && !full)) renderPane();
  var y = window.scrollY;
  app.innerHTML = '';
  if (PREVIEW) app.appendChild(el('div', 'preview-band', '<b>Preview.</b> This is the Scheduler with sample data (made-up example requests). Nothing you do here is saved or sent. On resources.mismo.org it uses your team’s real data and Outlook availability.'));
  if (DB.problem) app.appendChild(el('div', 'notice bad', esc(DB.problem)));
  if (!DB.loaded) { app.appendChild(el('div', 'empty', '<span class="spinner"></span> Loading…')); return; }
  (STATE.tab === 'help' ? viewHelp : STATE.tab === 'stats' ? viewStats : viewDash)(app);
  if (!full) window.scrollTo(0, y);
  if (keepFocus && document.getElementById(keepFocus)) try { document.getElementById(keepFocus).focus(); } catch (e) {}
}
/* ---------------- the right-hand panel ---------------- */
function paneEl() {
  var p = $('#pane');
  if (p) return p;
  p = el('aside', 'pane'); p.id = 'pane'; p.setAttribute('aria-label', 'Details');
  p.innerHTML = '<div class="pane-h"><div style="min-width:0"><h2 id="pane-t"></h2><div class="ps" id="pane-s"></div></div><button class="pane-x" type="button" aria-label="Close" title="Close (Esc)">×</button></div><div class="pane-b" id="pane-b"></div>';
  $('.pane-x', p).onclick = closePane;
  document.body.appendChild(p);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && STATE.pane && !$$('.scrim').length) closePane(); });
  return p;
}
var PANE_TITLES = { inbox: ['Incoming Email', 'Everything that reached scheduling@mismo.org'], follow: ['Follow Up', 'People who haven’t answered yet, and what needs a look'], list: ['All Requests', 'Every meeting being scheduled, by anyone on the team'], 'new': ['New Request', 'Start one by hand. Emailed requests start on their own.'], cal: ['Team Calendar', 'When everyone is free, from Outlook'] };
function renderPane() {
  var p = paneEl(), b = $('#pane-b', p);
  if (!STATE.pane || !DB.loaded) { p.classList.remove('on'); return; }
  var top = b.scrollTop;
  b.innerHTML = '';
  if (STATE.pane === 'req') {
    var r = getReq(STATE.reqId);
    $('#pane-t', p).textContent = r ? (r.title || 'Meeting request') : 'Not found';
    $('#pane-s', p).textContent = r ? (couldntSchedule(r) ? PHASE.unscheduled : PHASE[phase(r)]).n + (r.robot && r.robot.auto ? ' · Automatic' : '') + ' · ' + (r.duration || 30) + ' min' : '';
    if (r) viewDetail(b, r); else b.appendChild(el('div', 'empty', 'That request isn’t here any more.'));
  } else {
    var t = PANE_TITLES[STATE.pane] || ['', ''];
    $('#pane-t', p).textContent = t[0]; $('#pane-s', p).textContent = t[1];
    ({ inbox: viewInbox, follow: viewFollow, list: viewList, 'new': viewNew, cal: viewCalendar })[STATE.pane](b);
  }
  p.classList.add('on');
  b.scrollTop = top;
}
$$('.tab').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.tab); }); });

function seg(options, value, onPick) {
  var s = el('div', 'seg'); s.setAttribute('role', 'group');
  options.forEach(function (o) { var b = el('button', null, esc(o[1])); b.type = 'button'; b.setAttribute('aria-pressed', String(o[0] === value)); b.onclick = function () { onPick(o[0]); }; s.appendChild(b); });
  return s;
}
function btn(label, cls, onClick, icon) { var b = el('button', 'btn ' + (cls || ''), (icon ? ICON[icon] : '') + '<span>' + esc(label) + '</span>'); b.type = 'button'; if (onClick) b.onclick = onClick; return b; }
function personChip(name, tag, color) { return '<span class="chip"><span class="av"' + (color ? ' style="background:' + color + '"' : '') + '>' + esc(initials(name)) + '</span>' + esc(name) + (tag ? ' <span class="tag">' + esc(tag) + '</span>' : '') + '</span>'; }

/* ---------------- Follow Up ---------------- */
function viewFollow(app) {
  var head = el('div', 'pagehead');
  head.innerHTML = '<div class="grow"><h1>Follow Up</h1><p>People you asked about times and haven’t heard back from. Each one comes due a few business days after you last wrote to them (3 unless you change it on the request).</p></div>';
  head.appendChild(seg([[true, 'Mine'], [false, 'Everyone’s']], STATE.fuMine, function (v) { STATE.fuMine = v; lsSet('fuMine', v); render(); }));
  app.appendChild(head);
  var looks = allReqs().filter(needsYou);
  if (looks.length) {
    var pL0 = el('section', 'panel');
    pL0.innerHTML = '<div class="panel-h"><h2>Needs a Look</h2><span class="sub">' + looks.length + (looks.length === 1 ? ' request is' : ' requests are') + ' waiting on you</span></div>';
    var bL0 = el('div', 'panel-b'), lL0 = el('div', 'fu-list'); pL0.appendChild(bL0); bL0.appendChild(lL0);
    looks.forEach(function (r) {
      var c = el('div', 'fu');
      var ap = awaitingApproval(r);
      c.innerHTML = '<div class="who"><b>' + esc(r.title || 'Meeting request') + '</b><span>' + esc(ap ? 'Approve ' + slotLabel(r.robot.proposed, VIEW_TZ, true) + ' (' + (r.robot.proposed.how || '') + ')' : 'Stopped because ' + (r.robot.why || 'it needs a person')) + '</span></div>';
      var a = el('div', 'acts');
      if (ap && canApprove()) a.appendChild(btn('Approve', 'sm', function () { approveSlot(r, r.robot.proposed); }, 'check'));
      a.appendChild(btn('Open', ap ? 'sm ghost' : 'sm', function () { go(null, r.id); })); c.appendChild(a); lL0.appendChild(c);
    });
    app.appendChild(pL0);
  }
  var list = followList(STATE.fuMine), due = list.filter(function (x) { return x.st === 'due'; }), soon = list.filter(function (x) { return x.st === 'waiting'; });
  var p1 = el('section', 'panel');
  p1.innerHTML = '<div class="panel-h"><h2>Follow up now</h2><span class="sub">' + (due.length ? due.length + (due.length === 1 ? ' person' : ' people') : 'nobody') + '</span></div>';
  var b1 = el('div', 'panel-b'); p1.appendChild(b1);
  if (!due.length) b1.appendChild(el('div', 'empty', 'Nobody is overdue.'));
  else { var l1 = el('div', 'fu-list'); due.forEach(function (x) { l1.appendChild(fuCard(x)); }); b1.appendChild(l1); }
  app.appendChild(p1);
  var p2 = el('section', 'panel');
  p2.innerHTML = '<div class="panel-h"><h2>Still waiting, not due yet</h2><span class="sub">' + soon.length + '</span></div>';
  var b2 = el('div', 'panel-b'); p2.appendChild(b2);
  if (!soon.length) b2.appendChild(el('div', 'empty', 'No one else is pending.'));
  else { var l2 = el('div', 'fu-list'); soon.forEach(function (x) { l2.appendChild(fuCard(x)); }); b2.appendChild(l2); }
  app.appendChild(p2);
  var n = el('div', 'notice');
  n.innerHTML = '<b>Where else these reminders show up.</b> Every request that’s waiting on replies also puts a <b>“Follow up: …”</b> task on the organizer’s Team HQ board, due on the follow-up day. It’s ticked off by itself once everyone answers or the meeting is booked.';
  if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
    var nb = el('button', 'linkbtn', 'Also pop up a desktop alert while this page is open'); nb.type = 'button';
    nb.onclick = function () { Notification.requestPermission().then(function () { render(); }); };
    n.appendChild(el('div', null, '')).appendChild(nb);
  }
  app.appendChild(n);
}
function fuCard(x) {
  var r = x.r, g = x.g, c = el('div', 'fu' + (x.st === 'due' ? '' : ' soon'));
  var asked = Math.max(g.sentAt || 0, (g.followUps || []).slice(-1)[0] || 0);
  var nf = (g.followUps || []).length;
  c.innerHTML = '<div class="who"><b>' + esc(g.name || g.email) + (g.org ? ' <span class="muted" style="font-weight:400">· ' + esc(g.org) + '</span>' : '') + '</b>' +
    '<span>' + esc(r.title) + ' · ' + (nf ? 'followed up ' + nf + (nf === 1 ? ' time' : ' times') + ', last ' : 'asked ') + esc(fmtDay(asked, VIEW_TZ)) +
    ' · <b style="display:inline;color:' + (x.st === 'due' ? 'var(--bad)' : 'var(--warn)') + '">follow up ' + esc(dayWord(x.due)) + '</b>' +
    (STATE.fuMine ? '' : ' · ' + esc(first(r.ownerName)) + '’s') + '</span></div>';
  var a = el('div', 'acts');
  if (canEdit()) {
    a.appendChild(btn('Draft follow-up email', 'sm', function () { openDraft(r, 'follow', [g.id]); }, 'spark'));
    a.appendChild(btn('I followed up', 'sm ghost', function () { markFollowed(r, [g.id]); }, 'check'));
    a.appendChild(btn('Enter their answer', 'sm ghost', function () { openAnswer(r, g); }, 'pen'));
  }
  a.appendChild(btn('Open', 'sm ghost', function () { go(null, r.id); }));
  c.appendChild(a);
  return c;
}
function sentOn(t) { return parts(t, ET).iso === todayISO(ET) ? '' : ' (sent ' + fmtDay(t, ET) + ')'; }
function markFollowed(r0, gids) {
  askDate({ title: 'When did you follow up?', lead: 'Pick the day you followed up. The next reminder counts from that day.', days: getReq(r0.id).followDays, ok: 'Save' }).then(function (when) {
    if (!when) return;
    var r = clone(getReq(r0.id)), names = [];
    (r.guests || []).forEach(function (g) { if (gids.indexOf(g.id) >= 0) { g.followUps = (g.followUps || []).concat(when); names.push(g.name || g.email); } });
    put(r, 'Followed up with ' + names.join(', ') + sentOn(when));
    toast('Got it. If they still don\u2019t answer, you\u2019ll be reminded again on ' + dayWord(addBiz(when, r.followDays || DEFAULT_FOLLOW_DAYS)) + '.');
  });
}
/* fix the day an email went out: the first ask, or the latest follow-up */
function changeSentDate(req, g) {
  var isFollow = (g.followUps || []).length > 0;
  var last = isFollow ? g.followUps[g.followUps.length - 1] : g.sentAt;
  askDate({ title: isFollow ? 'When did you last follow up with ' + first(g.name) + '?' : 'When did you ask ' + first(g.name) + '?', def: last, days: req.followDays, ok: 'Save' }).then(function (when) {
    if (!when) return;
    var r = clone(getReq(req.id));
    r.guests.forEach(function (x) { if (x.id !== g.id) return; if (isFollow) x.followUps[x.followUps.length - 1] = when; else x.sentAt = when; });
    put(r, 'Changed the ' + (isFollow ? 'follow-up' : 'sent') + ' date for ' + (g.name || g.email) + ' to ' + fmtDay(when, ET));
  });
}

/* ---------------- Requests ---------------- */
function viewList(app) {
  var head = el('div', 'pagehead');
  head.innerHTML = '<div class="grow"><h1>Meeting Requests</h1><p>Every meeting being scheduled, by anyone on the team.</p></div>';
  if (canEdit()) head.appendChild(btn('New Request', 'big', function () { go('new'); }, 'plus'));
  app.appendChild(head);
  /* the figures first: what's moving, what's waiting, what needs a person */
  var all0 = allReqs(), weekAgo = Date.now() - 7 * 864e5;
  var nActive = all0.filter(function (r) { var ph = phase(r); return ph !== 'booked' && ph !== 'cancelled'; }).length;
  var nPoll = all0.filter(function (r) { return isAuto(r) && r.robot.stage === 'polling' && r.status !== 'booked' && r.status !== 'cancelled'; }).length;
  var nLook = all0.filter(needsYou).length;
  var nBooked = all0.filter(function (r) { return r.status === 'booked' && (r.bookedAt || 0) > weekAgo; }).length;
  var st = el('div', 'stats');
  [['active', nActive, 'In Progress', ''], ['active', nPoll, 'Polls Out', ''], ['look', nLook, 'Needs a Look', nLook ? 'hot' : ''], ['booked', nBooked, 'Booked This Week', 'good']].forEach(function (x, i) {
    var b = el('button', 'stat ' + x[3], '<b>' + x[1] + '</b><span>' + esc(x[2]) + '</span>'); b.type = 'button';
    b.setAttribute('aria-pressed', String(STATE.listShow === x[0] && i !== 1 && !(x[0] === 'active' && i === 1)));
    b.onclick = function () { STATE.listShow = x[0]; lsSet('listShow', x[0]); render(); };
    st.appendChild(b);
  });
  app.appendChild(st);
  var f = el('div', 'filters');
  f.appendChild(seg([[false, 'Everyone’s'], [true, 'Mine']], STATE.listMine, function (v) { STATE.listMine = v; lsSet('listMine', v); render(); }));
  f.appendChild(seg([['active', 'In Progress'], ['look', 'Needs a Look'], ['booked', 'Scheduled'], ['past', 'Past'], ['unscheduled', 'Couldn’t Schedule'], ['all', 'All']], STATE.listShow, function (v) { STATE.listShow = v; lsSet('listShow', v); render(); }));
  app.appendChild(f);
  var m = me().email;
  var list = allReqs().filter(function (r) {
    if (STATE.listMine && String(r.owner || '').toLowerCase() !== m) return false;
    var ph = phase(r);
    if (STATE.listShow === 'active') return ph !== 'booked' && ph !== 'cancelled';
    if (STATE.listShow === 'booked') return ph === 'booked' && !isPast(r);
    if (STATE.listShow === 'past') return isPast(r);
    if (STATE.listShow === 'unscheduled') return couldntSchedule(r);
    if (STATE.listShow === 'look') return needsYou(r);
    return true;
  }).sort(function (a, b) {
    var sa = bookedSlot(a), sb = bookedSlot(b);
    if (STATE.listShow === 'booked' && sa && sb) return sa.s - sb.s;
    if (STATE.listShow === 'past' && sa && sb) return sb.s - sa.s;
    if (STATE.listShow === 'unscheduled') return (b.closedAt || b.updatedAt || 0) - (a.closedAt || a.updatedAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  if (!list.length) {
    /* no empty well: say what happens next instead */
    var none = { look: 'Nothing needs a look right now.', booked: 'Nothing scheduled ahead.', past: 'No past meetings yet.', unscheduled: 'Nothing closed as Couldn’t Schedule.', all: 'No requests yet.', active: 'Nothing in progress right now.' }[STATE.listShow] || '';
    app.appendChild(el('p', 'muted', esc(none) + ' When an email reaches scheduling@mismo.org, the Scheduler takes it from there:'));
    app.appendChild(howItRuns());
    return;
  }
  var g = el('div', 'reqs');
  list.forEach(function (r) {
    var c = el('button', 'req'); c.type = 'button';
    var gs = r.guests || [], ans = gs.filter(function (x) { return x.answer; }).length;
    var due = (gs.filter(function (x) { return guestState(r, x) === 'due'; })).length;
    var who = (r.internal || []).map(function (id) { var p = person(id); return p ? first(p.name) : id; }).concat(optionalStaff(r).map(function (n) { return first(n) + ' (optional)'; }), gs.map(function (x) { return x.name || x.email; }));
    var chosen = r.status === 'booked' && slotById(r, r.chosen);
    c.innerHTML = '<div class="line">' + phasePill(r) + (due ? '<span class="pill p-due">Follow up</span>' : '') + (r.robot && r.robot.auto ? '<span class="auto-tag">Automatic</span>' : '') + '<span class="muted" style="margin-left:auto">' + esc(first(r.ownerName)) + '</span></div>' +
      '<h3>' + esc(r.title || 'Untitled meeting') + '</h3>' +
      '<div class="line">' + esc(who.join(', ') || 'No one added yet') + '</div>' +
      (chosen ? '<div class="line"><b style="color:var(--ink)">' + esc(slotLabel(chosen, VIEW_TZ, true)) + '</b></div>'
        : gs.length ? '<div class="line"><span>' + ans + ' of ' + gs.length + ' outside ' + (gs.length === 1 ? 'guest has' : 'guests have') + ' answered</span></div><div class="bar"><i style="width:' + Math.round(100 * ans / gs.length) + '%"></i></div>'
        : '<div class="line">' + (r.slots || []).length + ' times offered</div>');
    c.onclick = function () { go(null, r.id); };
    g.appendChild(c);
  });
  app.appendChild(g);
}

function howItRuns() {
  var f = el('div', 'flow');
  [['We Hear Back Right Away', 'The person who asked gets a branded email saying we have their request and are working on it.'],
   ['Their Times Come First', 'If everyone from MISMO is free at a time they suggested, it’s held and Vanessa or Jonna approves it before anyone is told.'],
   ['Otherwise a Poll', 'Guests get their own link to the times everyone at MISMO is free, with the person who asked copied.'],
   ['The Poll Keeps Itself Current', 'Times come off when Outlook changes or a guest says no, new ones are added, and a time that works for everyone goes to Vanessa or Jonna to approve.']
  ].forEach(function (x, i) { f.appendChild(el('div', null, '<span class="step">' + (i + 1) + '</span><h3>' + esc(x[0]) + '</h3><p>' + esc(x[1]) + '</p>')); });
  return f;
}

/* ---------------- New request (and editing one) ---------------- */
function requestForm(req, onSave, onCancel) {
  var isNew = !req;
  req = req ? clone(req) : { id: rid(10), title: '', purpose: '', duration: 30, where: 'Zoom', followDays: DEFAULT_FOLLOW_DAYS, internal: [], guests: [], slots: [], owner: me().email, ownerName: me().name, createdAt: Date.now(), createdBy: me().name, source: '' };
  var wrap = el('div');
  if (isNew) {
    var s1 = el('section', 'panel');
    s1.innerHTML = '<div class="panel-h"><span class="step">1</span><h2>Got an email asking for a meeting?</h2><span class="sub">Optional — saves typing</span></div>' +
      '<div class="panel-b"><label class="f"><span>Paste the email here <span class="hint">(in Outlook: open it, press Ctrl+A to select everything, Ctrl+C to copy, then click here and press Ctrl+V)</span></span><textarea id="f-src" rows="6" placeholder="Paste the whole email, including the From and To lines…"></textarea></label>' +
      '<div class="grow-row" style="margin-top:10px"><span id="f-read-say" class="small muted"></span></div></div>';
    var rb = btn('Read it for me', '', null, 'spark'); rb.id = 'f-read';
    $('.grow-row', s1).insertBefore(rb, $('.grow-row', s1).firstChild);
    wrap.appendChild(s1);
  }
  var s2 = el('section', 'panel');
  s2.innerHTML = '<div class="panel-h">' + (isNew ? '<span class="step">2</span>' : '') + '<h2>The meeting</h2></div><div class="panel-b"><div class="form">' +
    '<label class="f w8"><span>Meeting name</span><input type="text" id="f-title" maxlength="140" placeholder="e.g. MISMO Membership Info_Example Lending"></label>' +
    '<label class="f w4"><span>How long</span><select id="f-dur"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option><option value="90">90 minutes</option><option value="120">2 hours</option></select></label>' +
    '<label class="f"><span>What it’s about <span class="hint">(goes into the emails Claude drafts)</span></span><textarea id="f-purpose" rows="3" maxlength="2000" placeholder="e.g. Walk Example Lending through MISMO membership benefits and next steps."></textarea></label>' +
    '<label class="f w4"><span>Where</span><select id="f-where"><option>Zoom</option><option>Microsoft Teams</option><option>Phone</option><option>In person</option></select></label>' +
    '<label class="f w4"><span>Organizer <span class="hint">(gets the reminders)</span></span><select id="f-owner"></select></label>' +
    '<label class="f w4"><span>Remind me to follow up after</span><select id="f-follow"><option value="1">1 business day</option><option value="2">2 business days</option><option value="3">3 business days</option><option value="5">5 business days</option></select></label>' +
    '<div class="f"><span>Who asked for it <span class="hint">(optional)</span></span><input type="text" id="f-asker" maxlength="120" placeholder="e.g. Kelly Bradshaw"></div>' +
    '</div></div>';
  wrap.appendChild(s2);
  var s3 = el('section', 'panel');
  s3.innerHTML = '<div class="panel-h">' + (isNew ? '<span class="step">3</span>' : '') + '<h2>Who’s coming from MISMO</h2><span class="sub">Their Outlook shows when they’re free</span></div><div class="panel-b"><div class="chips" id="f-int"></div></div>';
  wrap.appendChild(s3);
  var s4 = el('section', 'panel');
  s4.innerHTML = '<div class="panel-h">' + (isNew ? '<span class="step">4</span>' : '') + '<h2>Who’s coming from outside MISMO</h2><span class="sub">They’ll mark the times that work for them</span></div><div class="panel-b"><div id="f-guests"></div></div>';
  var addG = btn('Add another person', 'ghost sm', null, 'plus'); $('.panel-b', s4).appendChild(addG);
  wrap.appendChild(s4);
  var foot = el('div', 'grow-row');
  var save = btn(isNew ? 'Save and pick times' : 'Save changes', 'big', null, isNew ? 'cal' : 'check');
  foot.appendChild(save);
  if (onCancel) foot.appendChild(btn('Cancel', 'ghost big', onCancel));
  var say = el('span', 'small', ''); say.style.color = 'var(--bad)'; foot.appendChild(say);
  wrap.appendChild(foot);

  /* fill in */
  $('#f-title', wrap).value = req.title || '';
  $('#f-dur', wrap).value = String(req.duration || 30);
  $('#f-purpose', wrap).value = req.purpose || '';
  $('#f-where', wrap).value = req.where || 'Zoom';
  $('#f-follow', wrap).value = String(req.followDays || DEFAULT_FOLLOW_DAYS);
  $('#f-asker', wrap).value = req.askedBy || '';
  var os = $('#f-owner', wrap);
  var owners = TEAM.people.map(function (p) { return { v: (emailOf(p) || '').toLowerCase(), n: p.name }; }).filter(function (o) { return o.v; });
  if (req.owner && !owners.some(function (o) { return o.v === req.owner.toLowerCase(); })) owners.unshift({ v: req.owner, n: req.ownerName || req.owner });
  owners.forEach(function (o) { var op = el('option', null, esc(o.n)); op.value = o.v; os.appendChild(op); });
  os.value = (req.owner || '').toLowerCase();
  function paintInternal(sel) {
    var box = $('#f-int', wrap); box.innerHTML = '';
    TEAM.people.forEach(function (p) {
      var l = el('label', 'pick');
      l.innerHTML = '<input type="checkbox" value="' + esc(p.id) + '"' + (sel.indexOf(p.id) >= 0 ? ' checked' : '') + '>' + personChip(p.name, hasCal(p.id) ? 'Outlook ✓' : 'no Outlook');
      box.appendChild(l);
    });
  }
  paintInternal(req.internal || []);
  function guestRow(g) {
    var r = el('div', 'guest-row'); r.dataset.gid = g.id || '';
    r.innerHTML = '<input type="text" class="g-name" placeholder="Name" maxlength="100" aria-label="Name"><input type="email" class="g-email" placeholder="Email" maxlength="200" aria-label="Email"><input type="text" class="g-org" placeholder="Company" maxlength="120" aria-label="Company">';
    $('.g-name', r).value = g.name || ''; $('.g-email', r).value = g.email || ''; $('.g-org', r).value = g.org || '';
    var x = el('button', 'btn ghost sm', 'Remove'); x.type = 'button'; x.onclick = function () { r.remove(); }; r.appendChild(x);
    $('#f-guests', wrap).appendChild(r);
  }
  (req.guests.length ? req.guests : [{}]).forEach(guestRow);
  addG.onclick = function () { guestRow({}); };

  function apply(found) {
    if (found.title) $('#f-title', wrap).value = found.title;
    if (found.purpose) $('#f-purpose', wrap).value = found.purpose;
    if (found.duration) $('#f-dur', wrap).value = String([15, 30, 45, 60, 90, 120].reduce(function (a, b) { return Math.abs(b - found.duration) < Math.abs(a - found.duration) ? b : a; }));
    if (found.askedBy) $('#f-asker', wrap).value = found.askedBy;
    if (found.askedByEmail) req.askedByEmail = found.askedByEmail;
    if (found.internal) paintInternal(found.internal);
    if (found.guests && found.guests.length) { $('#f-guests', wrap).innerHTML = ''; found.guests.forEach(guestRow); }
  }
  if (isNew) {
    $('#f-read', wrap).onclick = function () {
      var txt = $('#f-src', wrap).value.trim(), sayR = $('#f-read-say', wrap);
      if (!txt) { sayR.textContent = 'Paste the email first.'; return; }
      sayR.innerHTML = '<span class="spinner"></span> Reading it…';
      readEmail(txt).then(function (found) {
        apply(found);
        sayR.textContent = found.byClaude ? 'Filled in below. Check it over — fix anything that’s off.' : 'Filled in what I could find below (Claude wasn’t available, so check it carefully).';
      }, function () { sayR.textContent = 'Couldn’t read that one. Fill in the details below.'; });
    };
  }
  save.onclick = function () {
    var title = $('#f-title', wrap).value.trim();
    if (!title) { say.textContent = 'Give the meeting a name.'; $('#f-title', wrap).focus(); return; }
    var guests = [], bad = '';
    $$('.guest-row', wrap).forEach(function (r) {
      var n = $('.g-name', r).value.trim(), e = $('.g-email', r).value.trim(), o = $('.g-org', r).value.trim();
      if (!n && !e) return;
      if (e && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(e)) bad = 'Check the email address for ' + (n || e) + '.';
      if (!e) bad = 'Add an email address for ' + n + '.';
      var old = (req.guests || []).find(function (g) { return g.id === r.dataset.gid; });
      guests.push(Object.assign(old ? clone(old) : { id: rid(6), code: linkCode() }, { name: n, email: e, org: o }));
    });
    if (bad) { say.textContent = bad; return; }
    var owner = $('#f-owner', wrap).value, op = TEAM.people.find(function (p) { return (emailOf(p) || '').toLowerCase() === owner; });
    var durChanged = req.duration && +$('#f-dur', wrap).value !== +req.duration;
    Object.assign(req, {
      title: title, purpose: $('#f-purpose', wrap).value.trim(), duration: +$('#f-dur', wrap).value, where: $('#f-where', wrap).value,
      followDays: +$('#f-follow', wrap).value, askedBy: $('#f-asker', wrap).value.trim(), owner: owner, ownerName: op ? op.name : req.ownerName,
      internal: $$('#f-int input:checked', wrap).map(function (i) { return i.value; }), guests: guests
    });
    if (durChanged) req.slots = (req.slots || []).map(function (s) { return Object.assign({}, s, { e: s.s + req.duration * 60000 }); });
    if (isNew) req.source = ($('#f-src', wrap) || {}).value || '';
    onSave(req, isNew);
  };
  return wrap;
}
function viewNew(app) {
  if (!canEdit()) { app.appendChild(el('div', 'notice', 'You have View access to the Scheduler, so you can look but not start requests. Ask Perry for Edit access in People &amp; Access.')); return; }
  var head = el('div', 'pagehead'); head.innerHTML = '<div class="grow"><h1>New Meeting Request</h1><p>Four short steps. Next you’ll pick the times to offer.</p></div>';
  app.appendChild(head);
  var pre = STATE.prefill; STATE.prefill = null;
  app.appendChild(requestForm(null, function (req) {
    if (pre) { req.inboxId = pre.inboxId; if (!req.askedByEmail) req.askedByEmail = pre.askedByEmail; }
    put(req, pre ? 'Started the request from an email to ' + ((INBOX.server.docs[pre.inboxId] || {}).mailbox || 'the scheduling inbox') : 'Started the request').then(function () {
      if (pre) updInbox(pre.inboxId, { status: 'started', reqId: req.id });
      go(null, req.id); setTimeout(function () { openPicker(getReq(req.id)); }, 150);
    });
  }));
  if (pre) { $('#f-src', app).value = pre.src; setTimeout(function () { var b = $('#f-read', app); if (b) b.click(); }, 50); }
}

/* reading a pasted email: Claude when it can, a careful guess when it can't */
function readEmail(txt) {
  var roster = TEAM.people.map(function (p) { return p.id + ' = ' + p.name + (emailOf(p) ? ' <' + emailOf(p) + '>' : ''); }).join('\n');
  return askReady().then(function (ok) {
    if (!ok) return guessFromEmail(txt);
    var prompt = 'You help MISMO staff set up meetings. Read the email below (it may be a forwarded thread) and work out the meeting someone wants scheduled.\n\n' +
      'MISMO staff (id = name <email>):\n' + roster + '\n\n' +
      'Return ONLY a JSON object, no other text:\n{"title": short meeting name (use the name given in the email if there is one), "purpose": one or two plain sentences on what the meeting is for, "duration": minutes as a number (30 if not said), "askedBy": the person asking for the meeting to be scheduled, "askedByEmail": their email address if shown, "internal": [ids of the MISMO staff who should attend, from the list above], "guests": [{"name":..., "email":..., "org": company}] for attendees outside MISMO only}\n' +
      'Only include attendees the email says should be in the meeting, not everyone copied. Use email addresses exactly as written in the email; leave email "" if it isn’t there. Do not include the person who will do the scheduling unless the email says they attend.\n\nEMAIL:\n' + txt.slice(0, 20000);
    return ask(prompt).then(function (text) {
      var j = jsonIn(text); if (!j) return guessFromEmail(txt);
      var ids = TEAM.people.map(function (p) { return p.id; });
      return { byClaude: true, title: String(j.title || '').slice(0, 140), purpose: String(j.purpose || '').slice(0, 2000), duration: +j.duration || 30, askedBy: String(j.askedBy || '').slice(0, 120), askedByEmail: /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(String(j.askedByEmail || '').trim()) ? String(j.askedByEmail).trim().toLowerCase() : '',
        internal: (Array.isArray(j.internal) ? j.internal : []).filter(function (x) { return ids.indexOf(x) >= 0; }),
        guests: (Array.isArray(j.guests) ? j.guests : []).slice(0, 20).map(function (g) { return { name: String(g.name || '').slice(0, 100), email: String(g.email || '').slice(0, 200), org: String(g.org || '').slice(0, 120) }; }) };
    }, function () { return guessFromEmail(txt); });
  });
}
function guessFromEmail(txt) {
  var found = { title: '', internal: [], guests: [], purpose: '' };
  var q = /[“"]([^”"\n]{4,120})[”"]/.exec(txt); if (q) found.title = q[1].trim();
  if (!found.title) { var s = /^\s*Subject:\s*(?:(?:RE|FW|FWD):\s*)*(.+)$/im.exec(txt); if (s) found.title = s[1].trim().slice(0, 140); }
  var seen = {}, re = /([A-Z][\w.'\-]+(?:,?\s+[A-Z][\w.'\-]+){0,3})\s*[<(](?:mailto:)?([^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,})[>)]/g, m;
  while ((m = re.exec(txt))) {
    var em = m[2].toLowerCase(); if (seen[em]) continue; seen[em] = 1;
    var nm = m[1].replace(/^(?:From|To|Cc|Sent|Subject)\s*:?\s*/i, '').trim();
    if (/,/.test(nm)) { var bits = nm.split(/\s*,\s*/); nm = bits[1] + ' ' + bits[0]; }
    var p = personByEmail(em) || personByName(nm);
    if (p) { if (found.internal.indexOf(p.id) < 0) found.internal.push(p.id); }
    else if (!/@(mismo|mba)\.org$/.test(em)) found.guests.push({ name: nm, email: em, org: (em.split('@')[1] || '').split('.')[0].replace(/^./, function (c) { return c.toUpperCase(); }) });
  }
  var fr = /^\s*From:\s*([^<\n]+?)\s*<([^>\s]+@[^>\s]+)>/m.exec(txt);
  if (fr) { var fn = fr[1].trim(); if (/,/.test(fn)) { var fb = fn.split(/\s*,\s*/); fn = fb[1] + ' ' + fb[0]; } found.askedBy = fn; found.askedByEmail = fr[2].toLowerCase(); }
  var me0 = meP(); found.internal = found.internal.filter(function (id) { return !me0 || id !== me0.id; });
  return Promise.resolve(found);
}

/* ---------------- one request ---------------- */
function viewDetail(app, req) {
  var editable = canEdit() && req.status !== 'cancelled' && !isArchived(req);
  var head = el('div', 'pagehead');
  var meta = [esc(req.duration || 30) + ' min', esc(req.where || ''), 'Organizer: ' + esc(req.ownerName || req.owner)];
  if (req.askedBy) meta.push('Asked for by ' + esc(req.askedBy));
  head.innerHTML = '<div class="grow"><div style="margin-bottom:6px">' + phasePill(req) + '</div><h1>' + esc(req.title) + '</h1><p>' + meta.join(' · ') + '</p>' + (req.purpose ? '<p>' + esc(req.purpose) + '</p>' : '') + '</div>';
  var acts = el('div', 'grow-row');
  if (editable) {
    acts.appendChild(btn('Draft an email', '', function () { openDraft(req, phase(req) === 'booked' ? 'confirm' : (req.guests || []).some(function (g) { return g.sentAt; }) ? 'follow' : 'ask'); }, 'spark'));
    if (req.askedByEmail) acts.appendChild(btn('Reply to ' + (first(req.askedBy) || 'the person who asked'), 'ghost', function () { openReply(replySourceFor(req), req); }, 'mail'));
    acts.appendChild(btn('Edit details', 'ghost', function () { openEdit(req); }, 'pen'));
  }
  head.appendChild(acts);
  app.appendChild(head);
  if (isArchived(req)) app.appendChild(el('div', 'notice', '<b>Archived ' + esc(fmtDay(req.archivedAt, VIEW_TZ)) + '.</b> Finished requests move to the archive a month after the meeting (or after they were closed). It’s kept for reference and can’t be changed; guest links no longer work.'));

  if (req.status === 'booked') {
    var sl = slotById(req, req.chosen);
    var bk = el('div', 'booked');
    bk.innerHTML = '<div style="flex:1 1 280px"><div class="small muted">Booked for</div><div class="when">' + esc(sl ? slotLabel(sl, VIEW_TZ, true) : 'a time no longer listed') + '</div>' + (sl && VIEW_TZ !== ET ? '<div class="small muted">' + esc(slotLabel(sl, ET, true)) + '</div>' : '') + '</div>';
    var ba = el('div', 'grow-row'), inv = (req.robot && req.robot.invite) || null, zm = inv && inv.zoom;
    if (inv) {
      var it = inv.state === 'sent' ? '<b>Calendar invite sent</b> from scheduling@mismo.org' + (inv.at ? ' ' + esc(whenAgo(inv.at)) : '') + '.'
        : inv.state === 'failed' ? '<b>The invite couldn’t be sent automatically</b> (' + esc(String(inv.lastErr || '').slice(0, 120)) + '). Send it with the button.'
        : '<b>Sending the calendar invite…</b> It goes out from scheduling@mismo.org within a few minutes.';
      if (zm && zm.joinUrl) it += '<br>Zoom: <a href="' + esc(zm.joinUrl) + '" target="_blank" rel="noopener">' + esc(zm.joinUrl.replace(/\?.*$/, '')) + '</a>' + (zm.passcode ? ' · passcode ' + esc(zm.passcode) : '');
      $('div', bk).appendChild(el('div', 'small', it)).style.marginTop = '8px';
    }
    if (sl && (!inv || inv.state === 'failed')) {
      ba.appendChild(btn('Create the invite in Outlook', '', function () { window.open(owaInvite(req, sl), '_blank', 'noopener'); }, 'cal'));
      ba.appendChild(btn('Download invite file', 'ghost', function () { downloadIcs(req, sl); }, 'down'));
    }
    if (awaitingMove(req)) {
      var PM = req.robot.proposedMove;
      var mvn = el('div', 'notice warn', '<b>' + esc(PM.from || 'A guest') + ' asked to move it to ' + esc(slotLabel(PM, VIEW_TZ, true)) + '.</b> Everyone from MISMO is free then. Nothing has changed for anyone yet.' + (PM.note ? '<br><span class="small muted">“' + esc(PM.note) + '”</span>' : '') + ' ');
      if (canApprove()) { var mva = el('button', 'linkbtn', 'Approve the Move'); mva.type = 'button'; mva.onclick = function () { approveMove(req); }; mvn.appendChild(mva); mvn.appendChild(document.createTextNode(' · ')); var mvk = el('button', 'linkbtn', 'Keep the Current Time'); mvk.type = 'button'; mvk.onclick = function () { keepTime(req); }; mvn.appendChild(mvk); }
      $('div', bk).appendChild(mvn);
    }
    if (editable && req.robot && req.robot.auto) {
      /* the Scheduler sent the invitation, so it moves or cancels it in Outlook too */
      if (canApprove() && sl && sl.e > Date.now()) {
        ba.appendChild(btn('Move Meeting', 'ghost', function () { openMove(req); }, 'cal'));
        ba.appendChild(btn('Cancel Meeting', 'ghost', function () { cancelMeeting(req); }));
      }
    } else if (editable) {
      ba.appendChild(btn('Draft the confirmation email', 'ghost', function () { openDraft(req, 'confirm'); }, 'spark'));
      ba.appendChild(btn('Pick a different time', 'ghost', function () { var r = clone(req); r.status = ''; r.chosen = null; put(r, 'Reopened to pick a different time'); }));
    }
    bk.appendChild(ba); app.appendChild(bk);
  }
  if (req.status === 'cancelled') app.appendChild(el('div', 'notice warn', (couldntSchedule(req) ? '<b>We couldn’t find a time for this one.</b> Closed' + (req.closedBy ? ' by ' + esc(first(req.closedBy)) : '') + (req.closedAt ? ' ' + esc(fmtDay(req.closedAt, VIEW_TZ)) : '') + '. ' : '<b>This request was cancelled.</b> ') + (canEdit() ? '<button class="linkbtn" type="button" id="reopen">Bring it back</button>' : '')));
  if (req.status === 'cancelled' && req.robot && req.robot.cancelInvite) { var ci = req.robot.cancelInvite; app.appendChild(el('div', 'notice', ci.state === 'done' ? '<b>Meeting cancelled.</b> Everyone was sent Outlook’s cancellation from scheduling@mismo.org.' : ci.state === 'failed' ? '<b>The Outlook invitation couldn’t be cancelled automatically</b> (' + esc(String(ci.lastErr || '').slice(0, 120)) + '). Please cancel it in the scheduling@mismo.org calendar.' : '<b>Cancelling the Outlook invitation…</b> Everyone gets the cancellation within a few minutes.')); }
  if (req.robot) app.appendChild(robotPanel(req, editable));
  if ($('#reopen')) $('#reopen').onclick = function () { var r = clone(req); r.status = ''; delete r.closed; delete r.closedAt; delete r.closedBy; put(r, 'Brought back'); };

  /* times + who can make it */
  var pT = el('section', 'panel');
  var future = (req.slots || []).filter(function (s) { return s.e > Date.now(); });
  pT.innerHTML = '<div class="panel-h"><span class="step">1</span><h2>Times you’re offering</h2><span class="sub">' + (req.slots || []).length + ' offered' + ((req.slots || []).length !== future.length ? ', ' + ((req.slots || []).length - future.length) + ' already passed' : '') + '</span></div>';
  var pa = el('div', 'acts'); $('.panel-h', pT).appendChild(pa);
  if (editable && req.status !== 'booked' && !isAuto(req)) pa.appendChild(btn((req.slots || []).length ? 'Change the times' : 'Pick times', (req.slots || []).length ? 'ghost sm' : 'sm', function () { openPicker(req); }, 'cal'));
  var pb = el('div', 'panel-b'); pT.appendChild(pb);
  if (!(req.slots || []).length) pb.appendChild(el('div', 'empty', 'No times yet. ' + (editable ? 'Use <b>Pick times</b> — it shows when everyone from MISMO is free in Outlook.' : '')));
  else pb.appendChild(gridFor(req, editable));
  app.appendChild(pT);

  /* outside guests */
  var pG = el('section', 'panel');
  pG.innerHTML = '<div class="panel-h"><span class="step">2</span><h2>Outside guests</h2><span class="sub">' + (LINKS.live ? 'Each gets a private link to mark the times that work' : 'Enter their answers when they reply') + '</span></div>';
  var ga = el('div', 'acts'); $('.panel-h', pG).appendChild(ga);
  var unsent = (req.guests || []).filter(function (g) { return !g.sentAt && !g.answer; });
  if (editable && unsent.length && (req.slots || []).length && req.status !== 'booked' && !isAuto(req)) ga.appendChild(btn('Send the Poll', 'sm', function () { sendPoll(req, unsent); }));
    if (editable && unsent.length && (req.slots || []).length && req.status !== 'booked' && !isAuto(req)) ga.appendChild(btn('Draft the invitation email', 'ghost sm', function () { openDraft(req, 'ask', unsent.map(function (g) { return g.id; })); }, 'spark'));
  var gb = el('div', 'panel-b'); pG.appendChild(gb);
  if (LINKS.live === false && (req.guests || []).length) gb.appendChild(el('div', 'notice warn', '<b>Self-serve links aren’t switched on yet.</b> Until Perry turns them on (see the README), your emails ask guests to reply with the times that work, and you click <b>Enter their answer</b> when they do.'));
  if (!(req.guests || []).length) gb.appendChild(el('div', 'empty', 'Only MISMO people on this one. ' + (editable ? '<button class="linkbtn" type="button" id="addg">Add someone from outside</button>' : '')));
  else {
    var t = el('table', 'guests');
    t.innerHTML = '<thead><tr><th>Who</th><th>Status</th><th></th></tr></thead>';
    var tb = el('tbody'); t.appendChild(tb);
    (req.guests || []).forEach(function (g) {
      var st = guestState(req, g), tr = el('tr');
      var auto = isAuto(req), nRem = (g.reminders || []).length;
      var stTxt = auto && (st === 'waiting' || st === 'due') ? '<span class="pill p-wait">Poll sent ' + esc(fmtDay(g.sentAt, VIEW_TZ)) + (nRem ? ' · ' + nRem + (nRem === 1 ? ' follow-up' : ' follow-ups') : '') + '</span>'
        : auto && st === 'unsent' ? '<span class="pill p-draft">Poll going out</span>'
        : st === 'answered' ? '<span class="pill p-yes">Answered ' + esc(fmtDay(g.answer.at || Date.now(), VIEW_TZ)) + (g.answer.via === 'manual' ? ' (entered by hand)' : g.answer.via === 'email' ? ' (by email)' : '') + '</span>' + (g.answer.note ? '<div class="small muted" style="margin-top:4px">“' + esc(g.answer.note) + '”</div>' : '')
        : st === 'unsent' ? '<span class="pill p-draft">Not asked yet</span>'
        : st === 'due' ? '<span class="pill p-due">No reply — follow up ' + esc(dayWord(followDue(req, g))) + '</span>'
        : st === 'closed' ? '<span class="pill p-draft">No reply</span>'
        : '<span class="pill p-wait">Asked ' + esc(fmtDay(g.sentAt, VIEW_TZ)) + ' · follow up ' + esc(dayWord(followDue(req, g))) + '</span>';
      tr.innerHTML = '<td><b>' + esc(g.name || '(no name)') + '</b>' + (g.optional ? ' <span class="pill p-draft">Optional</span>' : '') + '<div class="small muted">' + esc(g.email) + (g.org ? ' · ' + esc(g.org) : '') + '</div></td><td>' + stTxt + '</td>';
      if ((st === 'waiting' || st === 'due') && editable && !auto) {
        var cd = el('button', 'linkbtn small', 'Wrong date? Change it'); cd.type = 'button'; cd.style.display = 'block'; cd.style.marginTop = '4px';
        cd.onclick = function () { changeSentDate(req, g); };
        tr.children[1].appendChild(cd);
      }
      var td = el('td'), a = el('div', 'acts'); td.appendChild(a); tr.appendChild(td);
      if (LINKS.live) a.appendChild(btn('Copy their link', 'ghost sm', function () { copy(guestLink(req, g)).then(function () { toast('Copied ' + first(g.name) + '’s private link. It only works for them.'); }); }, 'link'));
      if (editable && req.status !== 'booked') {
        if (st === 'unsent' && !auto) a.appendChild(btn('I sent it', 'ghost sm', function () {
          askDate({ title: 'When did you send it to ' + first(g.name) + '?', days: req.followDays, ok: 'Mark as sent' }).then(function (when) {
            if (!when) return;
            var r = clone(getReq(req.id)); r.guests.forEach(function (x) { if (x.id === g.id) x.sentAt = when; });
            put(r, 'Marked as asked: ' + (g.name || g.email) + sentOn(when));
            toast('If ' + first(g.name) + ' doesn\u2019t answer, you\u2019ll be reminded on ' + dayWord(addBiz(when, r.followDays || DEFAULT_FOLLOW_DAYS)) + '.');
          });
        }, 'check'));
        if ((st === 'due' || st === 'waiting') && !auto) a.appendChild(btn('Follow up', 'ghost sm', function () { openDraft(req, 'follow', [g.id]); }, 'spark'));
        a.appendChild(btn(st === 'answered' ? 'Change answer' : 'Enter their answer', 'ghost sm', function () { openAnswer(req, g); }, 'pen'));
        a.appendChild(btn(g.optional ? 'Make required' : 'Make optional', 'ghost sm', function () { toggleOptional(req, g); }));
      }
      tb.appendChild(tr);
    });
    gb.appendChild(t);
  }
  app.appendChild(pG);
  if ($('#addg')) $('#addg').onclick = function () { openEdit(req); };

  /* the original email and what happened */
  var pL = el('section', 'panel');
  pL.innerHTML = '<div class="panel-h"><h2>Background</h2></div>';
  var lb = el('div', 'panel-b'); pL.appendChild(lb);
  if (req.source) { lb.appendChild(el('div', 'small muted', 'The email that started it')); var pre = el('pre', 'src'); pre.textContent = req.source; lb.appendChild(pre); }
  var ul = el('ul', 'log');
  (req.log || []).slice().reverse().forEach(function (x) { ul.appendChild(el('li', null, '<span>' + esc(fmtDay(x.at, VIEW_TZ) + ' ' + fmtTime(x.at, VIEW_TZ)) + '</span><span>' + esc(x.what) + ' — ' + esc(first(x.by)) + '</span>')); });
  if ((req.log || []).length) { lb.appendChild(el('div', 'small muted', 'History')); lb.appendChild(ul); }
  if (editable && req.status !== 'booked') {
    var cx = btn('Cancel this request', 'danger sm', function () { if (confirm('Cancel “' + req.title + '”? Its Team HQ reminder will be ticked off. You can bring it back later.')) { var r = clone(req); r.status = 'cancelled'; delete r.closed; r.closedAt = Date.now(); r.closedBy = me().name; put(r, 'Cancelled'); } });
    cx.style.marginTop = '14px';
    if (req.status !== 'cancelled') { var cu0 = btn('Close as Couldn’t Schedule', 'ghost sm', function () { closeUnscheduled(req); }); cu0.style.marginTop = '14px'; cu0.style.marginRight = '8px'; lb.appendChild(cu0); }
    lb.appendChild(cx);
  }
  app.appendChild(pL);
}

/* ---------------- what the Scheduler did on its own ---------------- */
var SENT = { docs: null, at: 0 };
function loadSent() {
  if (PREVIEW) { SENT.docs = previewSent(); return Promise.resolve(); }
  if (SENT.docs && Date.now() - SENT.at < 60000) return Promise.resolve();
  return readData(PROJECT, 'outbox-sent').then(function (b) { SENT.docs = ((b && (b.data || b.content)) || {}).docs || {}; SENT.at = Date.now(); }, function () { SENT.docs = SENT.docs || {}; SENT.at = Date.now(); });
}
function robotPanel(req, editable) {
  var R = req.robot || {}, look = needsLook(req), on = isAuto(req);
  var p = el('section', 'panel');
  var sub = couldntSchedule(req) ? 'Couldn’t schedule — closed' : req.status === 'cancelled' ? 'Cancelled' : look ? 'Stopped — needs a person' : awaitingApproval(req) ? 'Found a time — waiting for approval' : !R.auto ? 'Handed over to staff' : req.status === 'booked' ? 'Booked it' : R.stage === 'polling' ? 'Poll out, set ' + (R.round || 1) + ' of times' : 'Working on it';
  p.innerHTML = '<div class="panel-h"><h2>Scheduled Automatically</h2><span class="sub">' + esc(sub) + '</span></div>';
  var acts = el('div', 'acts'); $('.panel-h', p).appendChild(acts);
  var b = el('div', 'panel-b'); p.appendChild(b);
  if (awaitingApproval(req)) {
    var P = R.proposed, apb = el('div', 'booked');
    apb.innerHTML = '<div style="flex:1 1 280px"><div class="small muted">Waiting for approval · ' + esc(P.how || '') + '</div><div class="when">' + esc(slotLabel(P, VIEW_TZ, true)) + '</div>' +
      (VIEW_TZ !== ET ? '<div class="small muted">' + esc(slotLabel(P, ET, true)) + '</div>' : '') + '<div class="small muted">Nothing has gone to anyone outside MISMO yet. To use a different time, press <b>Book</b> under it in the grid below.</div></div>';
    var apa = el('div', 'grow-row');
    if (canApprove()) apa.appendChild(btn('Approve This Time', '', function () { approveSlot(req, P); }, 'check'));
    else apa.appendChild(el('span', 'small muted', 'Vanessa or Jonna approves this.'));
    apb.appendChild(apa); b.appendChild(apb);
  }
  if (R.approved && R.stage === 'approve') b.appendChild(el('div', 'notice', '<b>Approved by ' + esc(R.approved.by || 'staff') + '.</b> The calendar invitation goes out within a few minutes.'));
  if (awaitingPollCheck(req)) {
    var pc = el('div', 'notice warn', '<b>Check this one first.</b> It came from outside MISMO and includes other people outside MISMO, so nobody has been emailed yet. If it looks genuine, send the poll. If not, close it and nobody is emailed. ');
    if (canApprove()) { var pcb = el('button', 'linkbtn', 'Send the Poll'); pcb.type = 'button'; pcb.onclick = function () { sendPollOk(req); }; pc.appendChild(pcb); pc.appendChild(document.createTextNode(' · ')); var pcc = el('button', 'linkbtn', 'Close It'); pcc.type = 'button'; pcc.onclick = function () { closeUnscheduled(req); }; pc.appendChild(pcc); }
    b.appendChild(pc);
  }
  if (awaitingDecision(req)) {
    var dc = el('div', 'notice warn', '<b>No time on the poll works for everyone, so the Scheduler is waiting for you.</b> Press <b>Book</b> under the best time in the grid below, mark someone <b>optional</b> under Outside guests so the time only has to work for the others, or send a fresh set of times. ');
    if (editable) { var dcb = el('button', 'linkbtn', 'Send New Times'); dcb.type = 'button'; dcb.onclick = function () { sendNewTimes(req); }; dc.appendChild(dcb); }
    b.appendChild(dc);
  }
  if (look) { var lk = el('div', 'notice bad', '<b>The Scheduler stopped because ' + esc(R.why || 'it needs a person') + '.</b> Fix what’s needed (for example <b>Edit details</b> to add who should attend), then hand it back, or take it from here yourself. If there’s no time that works, close it as Couldn’t Schedule. '); if (editable) { var lkb = el('button', 'linkbtn', 'Close as Couldn’t Schedule'); lkb.type = 'button'; lkb.onclick = function () { closeUnscheduled(req); }; lk.appendChild(lkb); } b.appendChild(lk); }
  if (R.replyAt) b.appendChild(el('div', 'notice', '<b>' + esc(R.replyFrom || 'Someone') + ' replied by email ' + esc(whenAgo(R.replyAt)) + ':</b> “' + esc(R.replySnippet || '') + '”'));
  var rq = R.requester || {};
  var offered = (R.offered || []).map(function (w) { return fmtDay(w.s, VIEW_TZ) + ' ' + fmtTime(w.s, VIEW_TZ) + '–' + fmtTime(w.e, VIEW_TZ); });
  var live = (req.slots || []).filter(function (x) { return x.s > Date.now(); }).length;
  var f = el('div', 'robotfacts');
  f.innerHTML = '<div><small>Asked By</small><b>' + esc(rq.name || rq.email || '—') + '</b>' + (rq.name && rq.email ? '<span class="small muted">' + esc(rq.email) + '</span>' : '') + '</div>' +
    '<div><small>Times They Suggested</small><b>' + (offered.length ? esc(offered.slice(0, 3).join('; ')) + (offered.length > 3 ? ' +' + (offered.length - 3) : '') : 'None') + '</b></div>' +
    '<div><small>Times on Offer Now</small><b>' + (req.status === 'booked' ? 'Booked' : live) + '</b>' + ((R.dropped || []).length ? '<span class="small muted">' + R.dropped.length + ' taken off</span>' : '') + '</div>' +
    '<div><small>Read By</small><b>' + (R.readBy === 'claude' ? 'Claude' : R.readBy === 'checked' ? 'Checked by staff' : 'Plain reader') + '</b></div>';
  b.appendChild(f);
  /* follow-ups to guests who haven't answered */
  var fw = followWaiting(req);
  if (R.auto && R.stage === 'polling' && req.status !== 'booked' && req.status !== 'cancelled' && fw.length) {
    var fb = el('div', 'notice' + (followsFinished(req) ? ' warn' : ''));
    var lines = fw.map(function (g) {
      var s = followOf(req, g), nm = esc(g.name || g.email);
      if (R.followStop) return nm + ': ' + s.sent + ' of ' + FOLLOW_MAX + ' sent, stopped';
      if (s.sent >= FOLLOW_MAX) return nm + ': all ' + FOLLOW_MAX + ' sent, no answer yet';
      return nm + ': ' + s.sent + ' of ' + FOLLOW_MAX + ' sent · next ' + esc(fmtDay(Math.max(s.next, Date.now()), VIEW_TZ));
    });
    fb.innerHTML = '<b>' + (followsFinished(req) ? 'Three follow-ups went out with no answer. Start them again, or leave them stopped.' : R.followStop ? 'Follow-ups are stopped' + (R.followStop.by ? ' (' + esc(first(R.followStop.by)) + ')' : '') + '.' : '' + (isQuickReq(req, (fw[0] || {}).sentAt) ? 'This one is quick, so friendly follow-ups go at noon Eastern each working day, three at most.' : 'Friendly follow-ups go out a week apart, three at most.') + '') + '</b><br>' + lines.join('<br>');
    if (editable) {
      var fa = el('div', 'grow-row'); fa.style.marginTop = '10px';
      if (R.followStop || followsFinished(req)) fa.appendChild(btn('Start Follow-Ups Again', 'sm', function () { startFollows(req); }));
      if (!R.followStop) fa.appendChild(btn(followsFinished(req) ? 'Leave Them Stopped' : 'Stop Follow-Ups', 'ghost sm', function () { stopFollows(req); }));
      fb.appendChild(fa);
    }
    b.appendChild(fb);
  }
  if ((R.dropped || []).length) {
    b.appendChild(el('div', 'small muted', 'Times taken off the poll, newest first'));
    var ul = el('ul', 'log'); R.dropped.slice().reverse().slice(0, 6).forEach(function (d) { ul.appendChild(el('li', null, '<span>' + esc(slotLabel(d, VIEW_TZ)) + '</span><span>' + esc(d.why) + '</span>')); });
    b.appendChild(ul);
  }
  var mails = el('div'); mails.innerHTML = '<div class="small muted" style="margin:12px 0 6px">Emails the Scheduler sent</div><div class="small muted">Loading…</div>';
  b.appendChild(mails);
  loadSent().then(function () {
    var list = Object.keys(SENT.docs || {}).map(function (k) { return Object.assign({ id: k }, SENT.docs[k]); }).filter(function (m) { return m.reqId === req.id && !m.sending; })
      .sort(function (x, y) { return (y.at || 0) - (x.at || 0); });
    var waiting = (R.pending || []).length;
    var body = list.map(function (m) {
      return '<tr><td>' + esc(fmtDay(m.at, VIEW_TZ) + ' ' + fmtTime(m.at, VIEW_TZ)) + '</td><td>' + esc(m.subject || '') + '</td><td>' + esc((m.to || []).join(', ')) + ((m.cc || []).length ? '<div class="small muted">copy: ' + esc(m.cc.join(', ')) + '</div>' : '') + '</td><td>' +
        (m.ok ? '<span class="pill p-yes">Sent</span>' : '<span class="pill p-due">Not sent' + ((m.tries || 0) >= 5 ? ', gave up' : ', will retry') + '</span>') + '</td></tr>';
    }).join('');
    mails.innerHTML = '<div class="small muted" style="margin:12px 0 6px">Emails the Scheduler sent' + (waiting ? ' · ' + waiting + ' waiting to go' : '') + '</div>' +
      (body ? '<div style="overflow-x:auto"><table class="mails"><thead><tr><th>When</th><th>Email</th><th>To</th><th>Status</th></tr></thead><tbody>' + body + '</tbody></table></div>' : '<div class="small muted">None yet.</div>');
  });
  if (editable && req.status !== 'booked') {
    if (on) acts.appendChild(btn('Take Over', 'ghost sm', function () {
      if (!confirm('Take this one over? The Scheduler stops emailing about it, and you pick times, send polls and follow up yourself.')) return;
      var r = clone(req); r.robotEdit = { auto: false }; put(r, 'Took over from the Scheduler'); }));
    else acts.appendChild(btn(look ? 'Hand Back to the Scheduler' : 'Let the Scheduler Handle It', 'sm', function () {
      var r = clone(req), sent = (r.guests || []).some(function (g) { return g.sentAt; });
      r.robotEdit = { auto: true, stage: (r.slots || []).length && sent ? 'polling' : 'new', why: '', round: 1, stalled: 0, readBy: R.readBy === 'claude' ? 'claude' : 'checked', requester: R.requester || { name: r.askedBy || '', email: r.askedByEmail || '' } };
      put(r, look ? 'Handed back to the Scheduler' : 'Handed to the Scheduler'); toast('The Scheduler will pick it up within a few minutes.'); }));
  }
  return p;
}

function replySourceFor(req) {
  var x = req.inboxId && INBOX.server.docs[req.inboxId];
  if (x) return x;
  var sub = /^\s*Subject:\s*(.+)$/im.exec(req.source || '');
  return { from: req.askedByEmail, fromName: req.askedBy || '', subject: sub ? sub[1].trim() : req.title, body: req.source || req.purpose || '', receivedAt: req.createdAt };
}
/* the who-can-make-it grid */
function gridFor(req, editable) {
  var box = el('div');
  var slots = (req.slots || []).slice().sort(function (a, b) { return a.s - b.s; });
  var best = bestSlot(req);
  var tzRow = el('div', 'grow-row small muted'); tzRow.style.marginBottom = '10px';
  tzRow.appendChild(el('span', null, 'Times shown in'));
  tzRow.appendChild(tzSelect());
  if (best && req.status !== 'booked') tzRow.appendChild(el('span', null, '· Best so far: <b style="color:var(--good)">' + esc(slotLabel(best.sl)) + '</b> (' + best.sc.yes + ' can make it' + (best.sc.no ? ', ' + best.sc.no + ' can’t' : '') + ')'));
  box.appendChild(tzRow);
  /* MISMO people who were out of office the whole time asked for: the Scheduler went ahead without them */
  if (optionalStaff(req).length) box.appendChild(el('p', 'small muted', '<b>Optional from MISMO:</b> ' + esc(optionalStaff(req).join(', ')) + ' — out of office the whole time asked for, so the times only have to work for the others. They get the invitation as optional.'));
  var wrap = el('div', 'gridwrap'), t = el('table', 'av'); wrap.appendChild(t);
  var h = '<thead><tr><th>Person</th>';
  slots.forEach(function (sl) {
    var past = sl.e < Date.now();
    h += '<th class="' + (best && best.sl.id === sl.id ? 'best' : '') + '"' + (past ? ' style="opacity:.5"' : '') + '><span class="d">' + esc(fmtDay(sl.s, VIEW_TZ)) + '</span>' + esc(fmtRange(sl.s, sl.e, VIEW_TZ)) + (req.chosen === sl.id ? '<br><span class="pill p-booked" style="margin-top:4px">Booked</span>' : '') + '</th>';
  });
  t.innerHTML = h + '</tr></thead>';
  var tb = el('tbody'); t.appendChild(tb);
  function cellHTML(v, title, clickable) {
    var txt = { yes: 'Works', maybe: 'Tentative', no: 'Can’t' }[v] || '—';
    return '<button type="button" class="cell c-' + (v || 'none') + '"' + (clickable ? '' : ' disabled') + ' title="' + esc(title || '') + '">' + txt + '</button>';
  }
  if ((req.internal || []).length) {
    tb.appendChild(el('tr', 'grp', '<td colspan="' + (slots.length + 1) + '">MISMO — from Outlook</td>'));
    req.internal.forEach(function (pid) {
      var p = person(pid) || { name: pid }, tr = el('tr');
      tr.innerHTML = '<td><b>' + esc(p.name) + '</b><div class="small muted">' + (hasCal(pid) ? 'Outlook connected' : 'Outlook not connected — click to set') + '</div></td>';
      slots.forEach(function (sl) {
        var a = internalAnswer(req, pid, sl), td = el('td', 'c');
        td.innerHTML = cellHTML(a.v, a.hand ? 'Set by hand. Click to change.' : a.booked ? 'Already booked here: ' + (a.booked.title || 'another meeting') + (editable ? ' · Click to override' : '') : a.cal ? (a.what ? 'Outlook: ' + a.what : 'Free in Outlook') + (editable ? ' · Click to override' : '') : 'Click to set', editable);
        if (editable) $('button', td).onclick = function () {
          var r = clone(getReq(req.id)); r.internalAns = r.internalAns || {}; r.internalAns[pid] = r.internalAns[pid] || {};
          var cur = r.internalAns[pid][sl.id] || null, order = [null, 'yes', 'no'], nx = order[(order.indexOf(cur) + 1) % order.length];
          if (nx) r.internalAns[pid][sl.id] = nx; else delete r.internalAns[pid][sl.id];
          put(r);
        };
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
  }
  if ((req.guests || []).length) {
    tb.appendChild(el('tr', 'grp', '<td colspan="' + (slots.length + 1) + '">Outside guests</td>'));
    req.guests.forEach(function (g) {
      var tr = el('tr');
      tr.innerHTML = '<td><b>' + esc(g.name || g.email) + '</b>' + (g.optional ? ' <span class="small muted">(optional)</span>' : '') + '<div class="small muted">' + esc(g.org || '') + (g.answer ? '' : (g.org ? ' · ' : '') + 'no answer yet') + '</div></td>';
      slots.forEach(function (sl) {
        var td = el('td', 'c'); td.innerHTML = cellHTML(guestAnswer(g, sl), editable ? 'Click to enter ' + first(g.name) + '’s answers' : '', editable);
        if (editable) $('button', td).onclick = function () { openAnswer(req, g); };
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
  }
  var tf = el('tfoot'), fr = el('tr'); fr.appendChild(el('td', null, 'Can make it'));
  slots.forEach(function (sl) {
    var sc = score(req, sl), td = el('td', 'c');
    td.innerHTML = '<div class="mono">' + sc.yes + '/' + (sc.yes + sc.maybe + sc.no + sc.none) + '</div>';
    if (editable && req.status !== 'booked' && sl.s > Date.now()) {
      var bb = btn('Book', 'sm' + (best && best.sl.id === sl.id ? '' : ' ghost'), function () { bookSlot(req, sl); }); bb.style.marginTop = '5px'; td.appendChild(bb);
    }
    fr.appendChild(td);
  });
  tf.appendChild(fr); t.appendChild(tf);
  box.appendChild(wrap);
  box.appendChild(el('div', 'legend', '<span><i style="background:var(--free)"></i>Works</span><span><i style="background:var(--some)"></i>Tentative in Outlook</span><span><i style="background:var(--busy)"></i>Can’t / busy</span><span><i style="background:var(--unk)"></i>Don’t know yet</span>'));
  return box;
}
function tzSelect() {
  var s = el('select'); s.style.width = 'auto'; s.style.minHeight = '30px'; s.style.padding = '3px 8px'; s.setAttribute('aria-label', 'Time zone');
  ZONES.forEach(function (z) { var o = el('option', null, esc(z.n)); o.value = z.v; s.appendChild(o); });
  s.value = VIEW_TZ; s.onchange = function () { VIEW_TZ = s.value; lsSet('tz', VIEW_TZ); render(); };
  return s;
}
function bookSlot(req, sl) {
  if (isAuto(req)) {
    if (!confirm('Approve ' + slotLabel(sl, VIEW_TZ, true) + ' for “' + req.title + '”?\n\nThe Scheduler then sends everyone the calendar invitation from scheduling@mismo.org.')) return;
    return approveSlot(req, sl);
  }
  var sc = score(req, sl);
  var msg = 'Book “' + req.title + '” for ' + slotLabel(sl, VIEW_TZ, true) + '?\n\n' + sc.yes + ' can make it' + (sc.maybe ? ', ' + sc.maybe + ' tentative' : '') + (sc.no ? ', ' + sc.no + ' can’t' : '') + (sc.none ? ', ' + sc.none + ' haven’t said' : '') + '.\n\nNext you’ll send the calendar invite from Outlook.';
  if (!confirm(msg)) return;
  var r = clone(getReq(req.id)); r.status = 'booked'; r.chosen = sl.id; r.bookedAt = Date.now();
  put(r, 'Booked for ' + slotLabel(sl, ET, true));
  toast('Booked. Now send the invite from Outlook — the buttons are at the top.');
  window.scrollTo(0, 0);
}

/* ======================================================================
   INCOMING: meeting requests that arrived by email
   ----------------------------------------------------------------------
   A Power Automate flow watches scheduling@mismo.org (people's own meeting
   requests reach it through an Outlook rule that redirects them there) and
   sends each email to the relay, which adds it to data/inbox.json in the
   private scheduler-data repo: {docs:{<id>:{from, fromName, subject, body,
   receivedAt, mailbox, status:'new'|'started'|'dismissed', reqId}}}.
   Staff turn an email into a request (Claude reads it), draft a reply to the
   person who sent it, or set it aside. Nothing here sends anything.
   ====================================================================== */
var INBOX = { server: { docs: {} }, sha: null, loaded: false, show: lsGet('inShow', 'new') };
function inboxItems() { var d = INBOX.server.docs || {}; return Object.keys(d).map(function (k) { return d[k]; }).sort(function (a, b) { return (b.receivedAt || 0) - (a.receivedAt || 0); }); }
function inboxNew() { return inboxItems().filter(function (x) { return x.status === 'new'; }); }
function loadInbox() {
  if (PREVIEW) { INBOX.loaded = true; return Promise.resolve(false); }
  return readData(PROJECT, 'inbox').then(function (b) {
    var c = b && b.data && typeof b.data === 'object' ? b.data : {}, before = JSON.stringify(INBOX.server.docs);
    INBOX.server = Object.assign({}, c, { docs: c.docs && typeof c.docs === 'object' ? c.docs : {} });
    INBOX.sha = (b && b.sha) || null; INBOX.loaded = true;
    return before !== JSON.stringify(INBOX.server.docs);
  }, function () { INBOX.loaded = true; return false; });
}
/* ---------------- the health check (written by the robot: data/health.json) ---------------- */
var HEALTH = { data: null, loaded: false };
function loadHealth() {
  if (PREVIEW) { HEALTH.loaded = true; return Promise.resolve(false); }
  return readData(PROJECT, 'health').then(function (b) {
    var before = JSON.stringify(HEALTH.data);
    HEALTH.data = b && b.data && typeof b.data === 'object' ? b.data : null; HEALTH.loaded = true;
    return before !== JSON.stringify(HEALTH.data);
  }, function () { HEALTH.loaded = true; return false; });
}
var H_LABEL = { emailLoop: 'Email In and Out', availability: 'Outlook Availability', sending: 'Sending Emails', invites: 'Calendar Invitations', claude: 'Reading Emails (Claude)', storage: 'Data Storage', runs: 'Robot Runs Today' };
/* the robot can't say it has stopped, so the page works it out: on working days it runs at least every two hours */
function robotCheck(h, now) {
  var p = parts(now, ET), wd = !isWeekend(p.iso), last = h && h.lastRunAt;
  if (!last) return { state: 'unk', label: 'Scheduler Robot', msg: 'No run recorded yet.' };
  if (wd && p.h >= 9 && p.h < 18 && now - last > 2.5 * 36e5) return { state: 'down', label: 'Scheduler Robot', msg: 'Hasn’t run since ' + whenAgo(last) + '. GitHub Actions may be paused or out of minutes; nothing is being decided or sent.', at: last };
  return { state: 'ok', label: 'Scheduler Robot', msg: 'Running normally.', at: last };
}
function healthStrip() {
  var h = HEALTH.data, now = Date.now(), rows = [];
  if (!HEALTH.loaded || PREVIEW) return null;
  rows.push(robotCheck(h, now));
  if (h && h.checks) Object.keys(H_LABEL).forEach(function (k) { var c = h.checks[k]; if (c) rows.push({ state: c.state, label: H_LABEL[k], msg: c.msg + (k === 'claude' && h.claudeModel ? ' Model: ' + h.claudeModel + (h.modelPinned ? ' (pinned).' : ' (newest Sonnet, not pinned).') : ''), at: c.at, since: c.since }); });
  var bad = rows.filter(function (r) { return r.state === 'down'; }), meh = rows.filter(function (r) { return r.state === 'warn'; });
  var overall = bad.length ? 'down' : meh.length ? 'warn' : (h ? 'ok' : 'unk');
  var open = STATE.healthOpen != null ? STATE.healthOpen : overall !== 'ok';
  var box = el('div', 'hstrip' + (overall === 'down' || overall === 'warn' ? ' ' + overall : ''));
  var head = el('button'); head.type = 'button'; head.setAttribute('aria-expanded', String(open));
  var say = overall === 'down' ? '<b>' + esc(bad.map(function (r) { return r.label; }).join(', ')) + (bad.length === 1 ? ' needs' : ' need') + ' a look.</b> Vanessa and Jonna have been emailed.'
    : overall === 'warn' ? '<b>Mostly fine.</b> Keep an eye on ' + esc(meh.map(function (r) { return r.label; }).join(', ')) + '.'
    : overall === 'unk' ? '<b>Health check starting.</b> The robot reports in on its next run.'
    : '<b>Everything is working.</b> Emails come in and go out, Outlook is current, and the robot ran ' + esc(whenAgo(h.lastRunAt)) + '.';
  head.innerHTML = '<span class="hdot ' + (overall === 'ok' ? '' : overall) + '" aria-hidden="true"></span><span>' + say + '</span><span class="hs-more">' + (open ? 'Hide details' : 'Details') + '</span>';
  head.onclick = function () { STATE.healthOpen = !open; render(); };
  box.appendChild(head);
  if (open) {
    var ul = el('ul', 'hlist');
    rows.forEach(function (r) {
      ul.appendChild(el('li', null, '<span class="hdot ' + (r.state === 'ok' ? '' : r.state) + '" aria-hidden="true"></span><div><b>' + esc(r.label) + '</b> <span class="sr-only">(' + esc(r.state === 'ok' ? 'working' : r.state === 'warn' ? 'warning' : r.state === 'down' ? 'not working' : 'unknown') + ')</span>· ' + esc(r.msg || '') +
        (r.at ? ' <span class="ha">' + esc(whenAgo(r.at)) + '</span>' : '') + (r.state === 'down' && r.since ? ' <span class="ha">· first noticed ' + esc(whenAgo(r.since)) + '</span>' : '') + '</div>'));
    });
    box.appendChild(ul);
  }
  return box;
}

/* small changes (status, link to a request), read-modify-write so a newly arrived email is never lost */
var inChain = Promise.resolve();
function updInbox(id, patch) {
  var cur = INBOX.server.docs[id]; if (!cur) return Promise.resolve();
  INBOX.server.docs[id] = Object.assign({}, cur, patch, { by: me().name, byAt: Date.now() });
  render();
  if (PREVIEW) return Promise.resolve();
  inChain = inChain.then(function () {
    var tries = 0;
    function go() {
      return readData(PROJECT, 'inbox').then(function (b) {
        var c = (b && b.data && typeof b.data === 'object') ? b.data : {}, next = Object.assign({}, c, { docs: Object.assign({}, c.docs || {}) });
        delete next.savedBy; delete next.savedAt;
        if (!next.docs[id]) return;
        next.docs[id] = Object.assign({}, next.docs[id], patch, { by: me().name, byAt: Date.now() });
        return writeData(PROJECT, 'inbox', next, b && b.sha).then(function (r) { INBOX.server = next; INBOX.sha = r && r.sha; });
      }).catch(function (e) { if (e.status === 409 && tries < 5) { tries++; return new Promise(function (r) { setTimeout(r, 400 * tries); }).then(go); } throw e; });
    }
    return go();
  }).catch(function (e) { toast('That change to Incoming didn’t save (' + (e.code || e.message) + '). Try again.'); });
  return inChain;
}
function emailText(x) {
  return 'From: ' + (x.fromName ? x.fromName + ' <' + x.from + '>' : x.from) + '\n' + (x.to ? 'To: ' + x.to + '\n' : '') + (x.cc ? 'Cc: ' + x.cc + '\n' : '') +
    'Sent: ' + new Date(x.receivedAt || Date.now()).toLocaleString('en-US', { timeZone: ET, dateStyle: 'full', timeStyle: 'short' }) + '\nSubject: ' + (x.subject || '') + '\n\n' + (x.body || '');
}
function displayName(x) { var n = String(x.fromName || '').trim(); if (/,/.test(n)) { var b = n.split(/\s*,\s*/); n = b[1] + ' ' + b[0]; } return n || x.from; }


var CALV = { day: '' };
function viewCalendar(app) {
  var head = el('div', 'pagehead');
  head.innerHTML = '<div class="grow"><h1>Team Availability</h1><p>Free and busy from Outlook for everyone at MISMO, refreshed every half hour. Meeting names, places and joining links are never brought across — only whether somebody is free.</p></div>';
  app.appendChild(head);

  var withCal = TEAM.people.filter(function (p) { return hasCal(p.id); });
  if (!withCal.length) {
    app.appendChild(el('div', 'panel', '<div class="empty">No availability has arrived yet. It is written every half hour by the <b>Scheduler - Team Availability</b> flow in Power Automate — if this stays empty, that flow is off or failing.</div>'));
    return;
  }

  var days = bizDaysAhead(10);
  if (!CALV.day || days.indexOf(CALV.day) < 0) CALV.day = days[0];

  var bar = el('div', 'calbar');
  days.forEach(function (iso) {
    var b = el('button', 'calday' + (iso === CALV.day ? ' on' : ''), esc(fmtDay(at(iso, 0, VIEW_TZ), VIEW_TZ)));
    b.type = 'button';
    b.addEventListener('click', function () { CALV.day = iso; render({ full: true }); });
    bar.appendChild(b);
  });
  app.appendChild(bar);

  var M = 60000, half = 30 * M, first = at(CALV.day, 8 * 60, VIEW_TZ), cols = 20;
  var panel = el('div', 'panel'), wrapEl = el('div', 'cal-wrap');
  var tbl = document.createElement('table'); tbl.className = 'calgrid';

  var thead = document.createElement('thead'), hr = document.createElement('tr');
  hr.appendChild(el('th', 'calname', ''));
  for (var c = 0; c < cols; c++) {
    var th = document.createElement('th');
    th.className = 'calhour';
    if (c % 2 === 0) th.textContent = fmtTime(first + c * half, VIEW_TZ).replace(/:00/, '');
    hr.appendChild(th);
  }
  thead.appendChild(hr); tbl.appendChild(thead);

  var tb = document.createElement('tbody');
  withCal.forEach(function (p) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', 'calname', esc(p.name)));
    for (var c = 0; c < cols; c++) {
      var s = first + c * half, st = calState(p.id, s, s + half);
      var td = document.createElement('td');
      td.className = 'calcell ' + (st === 'busy' ? 'busy' : st === 'tentative' ? 'tent' : st === 'oof' ? 'oof' : st === 'free' ? 'free' : 'unk');
      td.title = p.name + ' · ' + fmtTime(s, VIEW_TZ) + ' · ' + (st === 'oof' ? 'Out of office' : st === 'busy' ? 'Busy' : st === 'tentative' ? 'Tentative' : st === 'free' ? 'Free' : 'Not known');
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  });

  var sr = document.createElement('tr'); sr.className = 'calsum';
  sr.appendChild(el('td', 'calname', 'Everyone free'));
  for (var c2 = 0; c2 < cols; c2++) {
    var s2 = first + c2 * half, free = 0;
    withCal.forEach(function (p) { if (calState(p.id, s2, s2 + half) === 'free') free++; });
    var td2 = el('td', 'calcell calcount' + (free === withCal.length ? ' all' : ''), String(free));
    td2.title = free + ' of ' + withCal.length + ' free at ' + fmtTime(s2, VIEW_TZ);
    sr.appendChild(td2);
  }
  tb.appendChild(sr);

  tbl.appendChild(tb); wrapEl.appendChild(tbl); panel.appendChild(wrapEl);
  var leg = el('div', 'callegend');
  leg.innerHTML = '<span><i class="free"></i>Free</span><span><i class="tent"></i>Tentative</span><span><i class="busy"></i>Busy</span><span><i class="oof"></i>Out of office</span><span><i class="unk"></i>Not known</span>';
  panel.appendChild(leg);
  if (TEAM.calFrom) panel.appendChild(el('div', 'calfoot', 'Outlook last read ' + esc(fmtTime(Date.parse(TEAM.calFrom), VIEW_TZ)) + ' · times shown in ' + esc(VIEW_TZ)));
  app.appendChild(panel);
}
function viewInbox(app) {
  var head = el('div', 'pagehead');
  head.innerHTML = '<div class="grow"><h1>Incoming</h1><p>Meeting requests that came in by email to scheduling@mismo.org (including the ones your Outlook rule sends there). Start a request from one, or have Claude draft a reply to the person who asked.</p></div>';
  head.appendChild(seg([['new', 'New'], ['all', 'All']], INBOX.show, function (v) { INBOX.show = v; lsSet('inShow', v); render(); }));
  app.appendChild(head);
  var list = inboxItems().filter(function (x) { return INBOX.show === 'all' || x.status === 'new'; });
  if (!INBOX.loaded) { app.appendChild(el('div', 'empty', '<span class="spinner"></span> Loading…')); return; }
  if (!list.length) {
    app.appendChild(el('div', 'panel', '<div class="empty">' + (INBOX.show === 'new' ? 'No new meeting requests. ' : 'Nothing has come in yet. ') +
      (inboxItems().length ? '' : 'Once the email watcher is switched on (see How It Works), emails to scheduling@mismo.org appear here by themselves.') + '</div>'));
    return;
  }
  var box = el('div', 'fu-list');
  list.forEach(function (x) { box.appendChild(inboxCard(x)); });
  app.appendChild(box);
  /* opened from the Dashboard: go straight to that email, opened up */
  if (STATE.inFocus) {
    var fid = STATE.inFocus; STATE.inFocus = null;
    var card = $('[data-in="' + fid + '"]', box);
    if (card) {
      card.classList.add('in-focus');
      var mb = $('.in-more', card); if (mb && $('pre', card).hidden) mb.click();
      setTimeout(function () { card.scrollIntoView({ behavior: RED() ? 'auto' : 'smooth', block: 'start' }); }, 30);
    }
  }
}
/* the Scheduler's own daily test email (robot/health.mjs): kept out of the Dashboard and counts */
function isHealthMail(x) { return /^\s*(?:(?:re|fw|fwd)\s*:\s*)*Scheduler Health Check \d{4}-\d{2}-\d{2}/i.test((x && x.subject) || ''); }
function openEmail(x) {
  var req = x.reqId ? getReq(x.reqId) : null;
  if (req) { go(null, req.id); return; }
  STATE.inFocus = x.id;
  if (x.status !== 'new') { INBOX.show = 'all'; lsSet('inShow', 'all'); }
  go('inbox');
}
function inboxCard(x) {
  var c = el('div', 'fu' + (x.status === 'new' ? '' : ' soon'));
  c.setAttribute('data-in', x.id);
  c.style.borderLeftColor = x.status === 'new' ? 'var(--sky)' : 'var(--border-strong)';
  c.style.alignItems = 'flex-start';
  var req = x.reqId ? getReq(x.reqId) : null;
  var st = x.status === 'started' ? '<span class="pill p-ready">Request started' + (x.by ? ' by ' + esc(first(x.by)) : '') + '</span>' : x.status === 'dismissed' ? '<span class="pill p-draft">Set aside' + (x.by ? ' by ' + esc(first(x.by)) : '') + '</span>' : '<span class="pill p-collect">New</span>';
  var snip = String(x.body || '').replace(/\s+/g, ' ').slice(0, 260);
  var who = el('div', 'who');
  who.innerHTML = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">' + st + '<span class="small muted">' + esc(fmtDay(x.receivedAt, VIEW_TZ) + ' ' + fmtTime(x.receivedAt, VIEW_TZ)) + (x.mailbox ? ' · to ' + esc(x.mailbox) : '') + '</span></div>' +
    '<b>' + esc(x.subject) + '</b><span>From ' + esc(displayName(x)) + ' &lt;' + esc(x.from) + '&gt;</span>' +
    '<div class="small" style="color:var(--ink-2);margin-top:6px">' + esc(snip) + (String(x.body || '').length > 260 ? '…' : '') + '</div>';
  var more = el('button', 'linkbtn small in-more', 'Show the whole email'); more.type = 'button'; more.style.marginTop = '6px';
  var pre = el('pre', 'src'); pre.hidden = true; pre.style.marginTop = '8px'; pre.textContent = emailText(x);
  more.onclick = function () { pre.hidden = !pre.hidden; more.textContent = pre.hidden ? 'Show the whole email' : 'Hide the email'; };
  if (x.robotNote) who.appendChild(el('div', 'small', '<span class="auto-tag" style="margin:6px 6px 0 0">Scheduler</span>' + esc(x.robotNote)));
  who.appendChild(more); who.appendChild(pre);
  c.appendChild(who);
  var a = el('div', 'acts'); a.style.flexDirection = 'column'; a.style.alignItems = 'stretch';
  if (req) a.appendChild(btn('Open the request', 'sm', function () { go(null, req.id); }));
  if (canEdit()) {
    if (x.status !== 'started') a.appendChild(btn('Start a request', 'sm', function () { STATE.prefill = { src: emailText(x), inboxId: x.id, askedByEmail: x.from }; go('new'); }, 'plus'));
    a.appendChild(btn('Draft a reply', 'sm ghost', function () { openReply(x); }, 'spark'));
    if (x.status === 'new') a.appendChild(btn('Not a meeting request', 'sm ghost', function () { updInbox(x.id, { status: 'dismissed' }); toast('Set aside. Find it again under All.'); }));
    else if (x.status === 'dismissed') a.appendChild(btn('Put back', 'sm ghost', function () { updInbox(x.id, { status: 'new' }); }));
  }
  c.appendChild(a);
  return c;
}

/* a reply to the person who asked, written from their email */
function openReply(x, req) {
  var D = dialog('Draft a reply to ' + first(displayName(x)), true);
  var form = el('div', 'form');
  form.innerHTML = '<label class="f"><span>What should the reply do?</span><select id="r-goal">' +
    '<option value="ack">Say thanks and that I’m setting it up</option>' +
    '<option value="info">Ask for anything I’m missing (who, how long, which days)</option>' +
    '<option value="times">Tell them which times I’m offering</option>' +
    '<option value="other">Something else (say below)</option></select></label>' +
    '<label class="f"><span>Anything to add? <span class="hint">(optional)</span></span><textarea id="r-extra" rows="2" maxlength="1000"></textarea></label>';
  D.body.appendChild(form);
  if (req && (req.slots || []).length) $('#r-goal', form).value = 'times';
  var goB = btn('Draft it', 'big', null, 'spark'); goB.style.marginTop = '14px';
  var say = el('span', 'small muted'); say.style.marginLeft = '10px';
  D.body.appendChild(goB); D.body.appendChild(say);
  var out = el('div', 'draft-out'); out.hidden = true; D.body.appendChild(out);
  D.foot.appendChild(btn('Close', 'ghost', D.close));
  goB.onclick = function () {
    var goal = $('#r-goal', form).value, extra = $('#r-extra', form).value.trim();
    if (goal === 'other' && !extra) { say.textContent = 'Say what the reply should do in the box above.'; return; }
    var times = req ? timesBlock(req, ET) : '';
    var subj = /^re:/i.test(x.subject || '') ? x.subject : 'RE: ' + (x.subject || '');
    goB.disabled = true; say.innerHTML = '<span class="spinner"></span> Writing…';
    var fallback = function () {
      var hi = 'Hi ' + first(displayName(x)) + ',\n\n';
      var mid = goal === 'info' ? 'Thanks for reaching out. I’m happy to set this up. Could you confirm who should attend (with email addresses for anyone outside MISMO), how long the meeting should be, and any days that work best?'
        : goal === 'times' && times ? 'Thanks for reaching out. Here are the times I’m offering:\n\n' + times + '\n\nI’ll send the invitation once everyone has confirmed.'
        : 'Thanks for reaching out. I’m setting this up now and will send out some times shortly.';
      return { subject: subj, body: hi + mid + (extra ? '\n\n' + extra : '') + '\n\nBest,\n' + senderSig() };
    };
    askReady().then(function (ok) {
      if (!ok) return { d: fallback(), byClaude: false };
      var prompt = 'Draft a reply email for a MISMO staff member who schedules meetings. Warm, professional, concise (under 140 words), plain text, no markdown, no emoji.\n\n' +
        'GOAL: ' + { ack: 'Thank them and say you are setting the meeting up and will follow up with times.', info: 'Thank them and ask only for what the email does not already say among: who should attend (and outside attendees’ email addresses), how long, which days or times suit. Do not ask for anything the email already answers.', times: 'Thank them and list the times being offered, exactly as given below.', other: 'Do what the sender’s note says.' }[goal] + '\n\n' +
        (times && goal === 'times' ? 'TIMES (copy exactly):\n' + times + '\n\n' : '') +
        (extra ? 'SENDER’S NOTE (follow it): ' + extra + '\n\n' : '') +
        'SENDER: ' + me().name + (meP() && meP().role ? ', ' + meP().role : '') + ', MISMO\n\n' +
        'THE EMAIL YOU ARE REPLYING TO (use its names and details; never invent facts; do not repeat phone numbers or links):\n' + emailText(x).slice(0, 8000) + '\n\n' +
        'End with a sign-off line (e.g. "Best,") and then {{SIGNATURE}} on its own line. Return ONLY JSON: {"subject": "...", "body": "..."}';
      return ask(prompt).then(function (text) {
        var j = jsonIn(text); if (!j || !j.body) return { d: fallback(), byClaude: false };
        var body = String(j.body); body = body.indexOf('{{SIGNATURE}}') >= 0 ? body.replace(/\{\{SIGNATURE\}\}/g, senderSig()) : body + '\n\n' + senderSig();
        return { d: { subject: subj, body: body }, byClaude: true };
      }, function () { return { d: fallback(), byClaude: false }; });
    }).then(function (res) {
      goB.disabled = false; goB.querySelector('span').textContent = 'Draft it again';
      say.textContent = res.byClaude ? 'Drafted by Claude from their email. Read it over before you send.' : (PREVIEW ? 'Standard wording (in the preview Claude isn’t connected; on the real site Claude writes it from their email).' : 'Standard wording — Claude wasn’t available just now.');
      out.hidden = false; out.innerHTML = '';
      var sl = el('label', 'f'); sl.innerHTML = '<span>Subject</span><input type="text">'; $('input', sl).value = res.d.subject;
      var bl = el('label', 'f'); bl.style.marginTop = '10px'; bl.innerHTML = '<span>Email <span class="hint">(you can edit it here)</span></span><textarea rows="12"></textarea>'; $('textarea', bl).value = res.d.body;
      out.appendChild(sl); out.appendChild(bl);
      var row = el('div', 'grow-row'); row.style.marginTop = '12px';
      row.appendChild(btn('Copy the reply', '', function () { copy($('textarea', bl).value).then(function () { toast('Copied. In Outlook, open their email, press Reply, and paste.'); }); }));
      row.appendChild(btn('Open as a new email in Outlook', 'ghost', function () { window.open(owaCompose([x.from], [], $('input', sl).value, $('textarea', bl).value), '_blank', 'noopener'); }, 'mail'));
      out.appendChild(row);
      out.appendChild(el('p', 'small muted', 'Best way: open their email in Outlook, press <b>Reply</b>, and paste this in, so it stays in the same conversation.'));
    });
  };
}

/* ======================================================================
   DIALOGS
   ====================================================================== */
function dialog(title, wide) {
  var s = el('div', 'scrim'), d = el('div', 'dlg' + (wide ? ' wide' : ''));
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', title);
  d.innerHTML = '<div class="dlg-h"><h2>' + esc(title) + '</h2><button class="x" type="button" aria-label="Close">\u00d7</button></div><div class="dlg-b"></div><div class="dlg-f"></div>';
  s.appendChild(d); document.body.appendChild(s);
  var before = document.activeElement;
  function close() { s.remove(); document.removeEventListener('keydown', onKey); if (before && before.focus) try { before.focus(); } catch (e) {} }
  function onKey(e) { if (e.key === 'Escape') { var all = $$('.scrim'); if (all[all.length - 1] === s) close(); } }
  document.addEventListener('keydown', onKey);
  $('.x', d).onclick = close;
  s.addEventListener('mousedown', function (e) { if (e.target === s) close(); });
  setTimeout(function () { var f = $('.dlg-b input, .dlg-b select, .dlg-b textarea, .dlg-b button', d) || $('.x', d); try { f.focus(); } catch (e) {} }, 30);
  return { body: $('.dlg-b', d), foot: $('.dlg-f', d), close: close, root: d };
}

/* ---------------- "when did you send it?" ----------------
   Sending happens in Outlook, so the Scheduler only knows the day you tell it. Today is the default; an earlier day
   (up to 60 days back) starts the follow-up clock from then, so marking it late doesn't push the reminder back. */
function askDate(o) {
  return new Promise(function (resolve) {
    var D = dialog(o.title || 'When did you send it?'), today = todayISO(ET), done = false;
    var defIso = o.def ? parts(o.def, ET).iso : today;
    D.body.appendChild(el('p', 'small muted', esc(o.lead || 'Pick the day the email went out. The follow-up reminder counts from that day.')));
    var row = el('div', 'grow-row');
    var inp = el('input'); inp.type = 'date'; inp.value = defIso > today ? today : defIso; inp.max = today; inp.min = isoAdd(today, -60); inp.style.width = 'auto'; inp.setAttribute('aria-label', 'Day it was sent');
    row.appendChild(inp);
    row.appendChild(btn('Today', 'ghost sm', function () { inp.value = today; hint(); }));
    var yd = isoAdd(today, -1); while (isWeekend(yd)) yd = isoAdd(yd, -1);
    row.appendChild(btn(dow(yd) === 5 && dow(today) === 1 ? 'Last Friday' : 'Yesterday', 'ghost sm', function () { inp.value = yd; hint(); }));
    D.body.appendChild(row);
    var h = el('p', 'small'); h.style.marginTop = '12px'; D.body.appendChild(h);
    function pick() { var v = inp.value; if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v > today || v < inp.min) return null; return v === today ? (o.def && parts(o.def, ET).iso === today ? o.def : Date.now()) : at(v, 12 * 60, ET); }
    function hint() {
      var t = pick();
      h.innerHTML = t ? 'If there\u2019s no reply, you\u2019ll be reminded to follow up on <b>' + esc(new Date(addBiz(t, o.days || DEFAULT_FOLLOW_DAYS) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })) + '</b>.'
        : '<span style="color:var(--bad)">Pick a day between ' + esc(inp.min) + ' and today.</span>';
    }
    inp.addEventListener('input', hint); inp.addEventListener('change', hint); hint();
    var x = $('.x', D.root), close0 = D.close;
    function finish(v) { if (done) return; done = true; close0(); resolve(v); }
    x.onclick = function () { finish(null); };
    D.foot.appendChild(btn('Cancel', 'ghost', function () { finish(null); }));
    D.foot.appendChild(btn(o.ok || 'Save', '', function () { var t = pick(); if (!t) { hint(); return; } finish(t); }, 'check'));
    /* Escape or a click outside also count as cancel */
    var obs = new MutationObserver(function () { if (!document.body.contains(D.root)) { obs.disconnect(); if (!done) { done = true; resolve(null); } } });
    obs.observe(document.body, { childList: true });
  });
}

/* ---------------- editing a request ---------------- */
/* November 5, 2026: a dialog left open says so when someone else saves its request */
function watchDialog(D, req) {
  var on = req && DB.server.docs[req.id], at = on ? on.updatedAt : null, said = false;   /* the copy on file as it opened */
  var iv = setInterval(function () {
    if (!document.body.contains(D.root)) { clearInterval(iv); return; }
    var now = DB.server.docs[req.id];
    if (said || !now || now.updatedAt == null || String(now.updatedAt) === String(at) || MY_STAMPS[now.updatedAt]) return;   /* not this page's own */
    said = true;
    var n = el('div', 'notice warn', 'Someone else just saved this request. Saving keeps their changes and adds yours.');
    n.setAttribute('role', 'status'); n.style.marginBottom = '10px';
    D.body.insertBefore(n, D.body.firstChild);
  }, 3000);
}
function openEdit(req) {
  var D = dialog('Edit \u201c' + req.title + '\u201d', true);
  watchDialog(D, req);
  D.foot.remove();
  D.body.appendChild(requestForm(req, function (r) { put(r, 'Edited the details'); D.close(); }, function () { D.close(); }));
}

/* ---------------- picking the times to offer ---------------- */
function openPicker(req) {
  if (!req) return;
  var D = dialog('Pick the times to offer', true);
  watchDialog(D, req);
  var dur = (+req.duration || 30) * 60000, STEP = 30;
  var picked = {}; (req.slots || []).forEach(function (s) { picked[s.s] = s.id; });
  var start = bizDaysAhead(1)[0], DAYS = 10;
  var who = (req.internal || []).map(function (id) { return person(id) || { id: id, name: id }; });
  var withCal = who.filter(function (p) { return hasCal(p.id); }), noCal = who.filter(function (p) { return !hasCal(p.id); });
  var top = el('div', 'tp-top');
  D.body.appendChild(el('p', 'small muted', 'Click a start time to offer it (it covers ' + (req.duration || 30) + ' minutes). <b>Green</b> = everyone from MISMO on this meeting is free in Outlook; <b>amber</b> = someone is tentative; <b>red</b> = someone is busy. Faded rows are outside 9\u20135 Eastern. Aim for 3\u20136 times across a few days.' +
    (noCal.length ? '<br><b>Not in Outlook here:</b> ' + esc(noCal.map(function (p) { return p.name; }).join(', ')) + ' \u2014 check their calendar yourself, or set their answers in the grid afterwards.' : '') +
    (!who.length ? '<br>No MISMO people are on this meeting yet, so there\u2019s no Outlook to check.' : '')));
  D.body.appendChild(top);
  top.appendChild(el('span', 'small muted', 'Times in')); top.appendChild(tzSelect());
  var prev = btn('Earlier', 'ghost sm'), next = btn('Later', 'ghost sm'), sug = btn('Suggest 5 good times', 'sm', null, 'spark'), clr = btn('Clear', 'ghost sm');
  top.appendChild(prev); top.appendChild(next); top.appendChild(sug); top.appendChild(clr);
  var rng = el('span', 'small muted'); top.appendChild(rng);
  var wrap = el('div', 'tp-wrap'); D.body.appendChild(wrap);
  var countSay = el('span', 'small muted'); countSay.style.marginRight = 'auto'; countSay.style.alignSelf = 'center';
  D.foot.appendChild(countSay);
  D.foot.appendChild(btn('Cancel', 'ghost', D.close));
  var saveB = btn('Use these times', '', null, 'check'); D.foot.appendChild(saveB);
  /* the picker's own zone select re-renders the page; redraw the grid too */
  $('select', top).addEventListener('change', function () { draw(); });

  function days() { var out = [], iso = isoAdd(start, -1); while (out.length < DAYS) { iso = isoAdd(iso, 1); if (!isWeekend(iso)) out.push(iso); } return out; }
  function state(s) {
    var e = s + dur, busy = [], tent = [];
    withCal.forEach(function (p) { var c = calState(p.id, s, e); if (c === 'busy' || c === 'oof') busy.push(p); else if (c === 'tentative') tent.push(p); });
    if (!withCal.length) return { c: 's-unk', t: 'No Outlook to check', n: '' };
    if (busy.length) return { c: 's-busy', t: 'Busy: ' + busy.map(function (p) { var w = calWhat(p.id, s, e); return first(p.name) + (w ? ' (' + w + ')' : ''); }).join('; '), n: busy.length === 1 ? first(busy[0].name) : busy.length + ' busy' };
    if (tent.length) return { c: 's-some', t: 'Tentative: ' + tent.map(function (p) { return first(p.name); }).join(', '), n: 'tentative' };
    return { c: 's-free', t: 'Everyone free', n: '' };
  }
  function inETHours(s) { var p = parts(s, ET), m = p.h * 60 + p.mi, pe = parts(s + dur, ET), me2 = pe.h * 60 + pe.mi; return m >= 540 && (me2 <= 1020 && me2 > m); }
  function draw() {
    var ds = days(), tz = VIEW_TZ;
    rng.textContent = new Date(ds[0] + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) + ' \u2013 ' + new Date(ds[ds.length - 1] + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
    var t = el('table', 'tp'), h = '<thead><tr><th></th>';
    ds.forEach(function (d) { h += '<th>' + esc(new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })) + '</th>'; });
    t.innerHTML = h + '</tr></thead>';
    var tb = el('tbody'); t.appendChild(tb);
    var covered = {}; Object.keys(picked).forEach(function (k) { var s = +k; for (var x = s + STEP * 60000; x < s + dur; x += STEP * 60000) covered[x] = 1; });
    for (var mins = 7 * 60; mins <= 18 * 60 + 30; mins += STEP) {
      var tr = el('tr'), lab = el('td', null, esc(fmtTime(at(ds[0], mins, tz), tz).replace(':00', '')));
      tr.appendChild(lab);
      ds.forEach(function (d) {
        var s = at(d, mins, tz), td = el('td'), b = el('button', 'slot'); b.type = 'button';
        var st = state(s), on = picked[s] !== undefined, past = s < Date.now();
        b.className = 'slot ' + st.c + (on ? ' s-on' : covered[s] ? ' s-in' : '');
        b.textContent = on ? '\u2713 ' + fmtTime(s, tz) : st.n;
        b.title = fmtDay(s, tz, true) + ' ' + fmtRange(s, s + dur, tz) + ' \u2014 ' + st.t;
        b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', b.title + (on ? ' (picked)' : ''));
        if (!inETHours(s)) b.style.opacity = '.45';
        if (past) { b.disabled = true; b.style.opacity = '.25'; }
        b.onclick = function () { if (picked[s] !== undefined) delete picked[s]; else picked[s] = null; draw(); };
        td.appendChild(b); tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
    var sc = wrap.scrollTop; wrap.innerHTML = ''; wrap.appendChild(t); wrap.scrollTop = sc;
    var n = Object.keys(picked).length;
    countSay.textContent = n ? n + (n === 1 ? ' time picked' : ' times picked') : 'No times picked yet';
  }
  prev.onclick = function () { var d = days(); start = isoAdd(d[0], -14); if (start < todayISO(VIEW_TZ)) start = bizDaysAhead(1)[0]; draw(); };
  next.onclick = function () { var d = days(); start = isoAdd(d[d.length - 1], 1); draw(); };
  clr.onclick = function () { picked = {}; draw(); };
  sug.onclick = function () {
    var got = [], perDay = {}, ds = days();
    var tries = [600, 660, 840, 900, 720, 570, 780, 960, 630, 870];   /* minutes past midnight Eastern, mid-morning and mid-afternoon first */
    for (var round = 0; round < 2 && got.length < 5; round++) {
      ds.forEach(function (d) {
        if (got.length >= 5 || (perDay[d] || 0) > round) return;
        var rot = ds.indexOf(d) * 3 + round * 5;
        for (var i0 = 0; i0 < tries.length; i0++) {
          var s = at(d, tries[(i0 + rot) % tries.length], ET);
          if (s < Date.now() + 2 * 3600000 || picked[s] !== undefined || !inETHours(s)) continue;
          if (got.some(function (x) { return Math.abs(x - s) < dur + 60 * 60000; })) continue;
          var st = state(s); if (st.c !== 's-free' && st.c !== 's-unk') continue;
          got.push(s); perDay[d] = (perDay[d] || 0) + 1; return;
        }
      });
    }
    if (!got.length) { toast('No times where everyone is free in these days. Try Later.'); return; }
    got.forEach(function (s) { picked[s] = null; }); draw();
    toast('Picked ' + got.length + ' times when everyone is free. Change any you like.');
  };
  saveB.onclick = function () {
    var keys = Object.keys(picked).map(Number).sort(function (a, b) { return a - b; });
    if (!keys.length) { toast('Pick at least one time.'); return; }
    var r = clone(getReq(req.id));
    var old = {}; (r.slots || []).forEach(function (s) { old[s.s] = s; });
    r.slots = keys.map(function (s) { return old[s] ? Object.assign({}, old[s], { e: s + dur }) : { id: rid(5), s: s, e: s + dur }; });
    var ids = r.slots.map(function (s) { return s.id; });
    (r.guests || []).forEach(function (g) { if (g.answer) { g.answer.yes = (g.answer.yes || []).filter(function (x) { return ids.indexOf(x) >= 0; }); g.answer.maybe = (g.answer.maybe || []).filter(function (x) { return ids.indexOf(x) >= 0; }); } });
    put(r, 'Offered ' + keys.length + ' times');
    D.close();
    var unsent = (r.guests || []).filter(function (g) { return !g.sentAt && !g.answer; });
    if (unsent.length) setTimeout(function () { toast('Next: \u201cDraft the invitation email\u201d under Outside guests.'); }, 300);
  };
  draw();
  /* start the grid at about 8 AM */
  setTimeout(function () { var rows = $$('tbody tr', wrap); if (rows[2]) wrap.scrollTop = rows[2].offsetTop - 40; }, 40);
}

/* ---------------- entering an answer by hand ---------------- */
function openAnswer(req, g) {
  req = getReq(req.id); g = (req.guests || []).find(function (x) { return x.id === g.id; }) || g;
  var D = dialog(first(g.name || g.email) + '\u2019s answer');
  var slots = (req.slots || []).slice().sort(function (a, b) { return a.s - b.s; });
  var ans = {}; slots.forEach(function (sl) { ans[sl.id] = guestAnswer(g, sl) || (g.answer ? 'no' : null); });
  D.body.appendChild(el('p', 'small muted', 'From their email or call, mark each time. Times in ' + esc(zoneName(VIEW_TZ)) + '.'));
  if (!slots.length) D.body.appendChild(el('div', 'empty', 'Pick some times first.'));
  slots.forEach(function (sl) {
    var row = el('div', 'ans-row'); row.appendChild(el('span', null, esc(slotLabel(sl))));
    var tri = el('div', 'tri'); tri.setAttribute('role', 'group'); tri.setAttribute('aria-label', slotLabel(sl));
    [['yes', 'Works', 'y'], ['no', 'Can\u2019t', 'n']].forEach(function (o) {
      var b = el('button', o[2], o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(ans[sl.id] === o[0]));
      b.onclick = function () { ans[sl.id] = o[0]; $$('button', tri).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); };
      tri.appendChild(b);
    });
    row.appendChild(tri); D.body.appendChild(row);
  });
  var nl = el('label', 'f'); nl.style.marginTop = '14px'; nl.innerHTML = '<span>Anything they said <span class="hint">(optional)</span></span><textarea rows="2" maxlength="1000"></textarea>';
  $('textarea', nl).value = (g.answer && g.answer.note) || ''; D.body.appendChild(nl);
  if (g.answer) D.foot.appendChild(btn('Clear their answer', 'danger', function () { var r = clone(getReq(req.id)); r.guests.forEach(function (x) { if (x.id === g.id) delete x.answer; }); put(r, 'Cleared the answer from ' + (g.name || g.email)); D.close(); }));
  D.foot.appendChild(btn('Cancel', 'ghost', D.close));
  D.foot.appendChild(btn('Save their answer', '', function () {
    var r = clone(getReq(req.id));
    r.guests.forEach(function (x) {
      if (x.id !== g.id) return;
      x.answer = { yes: Object.keys(ans).filter(function (k) { return ans[k] === 'yes'; }), maybe: [], note: $('textarea', nl).value.trim(), at: Date.now(), via: 'manual', by: me().name };
      if (!x.sentAt) x.sentAt = Date.now();
    });
    put(r, 'Entered the answer from ' + (g.name || g.email)); D.close();
    var all = r.guests.every(function (x) { return x.answer; });
    toast(all ? 'Everyone has answered. Pick the best time and press Book.' : 'Saved.');
  }, 'check'));
}

/* ---------------- drafting an email ---------------- */
var KINDS = {
  ask: 'Ask them which times work',
  follow: 'Follow up (no reply yet)',
  confirm: 'Confirm the time that was booked',
  other: 'Something else'
};
function timesBlock(req, tz) {
  var slots = (req.slots || []).filter(function (s) { return s.s > Date.now(); }).sort(function (a, b) { return a.s - b.s; });
  var byDay = [], last = '';
  slots.forEach(function (s) { var d = fmtDay(s.s, tz, true); if (d !== last) { byDay.push({ d: d, t: [] }); last = d; } byDay[byDay.length - 1].t.push(fmtRange(s.s, s.e, tz)); });
  return byDay.map(function (x) { return '\u2022 ' + x.d + ': ' + x.t.join(', '); }).join('\n') + (slots.length ? '\n(All times ' + zoneName(tz) + ' Time)' : '');
}
function senderSig() { var p = meP(), m = me(); return m.name + (p && p.role ? '\n' + p.role + ', MISMO' : '\nMISMO'); }
function templateFor(kind, req, extra) {
  var where = req.where === 'In person' ? 'in person' : req.where === 'Phone' ? 'by phone' : 'on ' + req.where;
  var about = req.purpose ? ' ' + req.purpose.replace(/\s+$/, '').replace(/([^.!?])$/, '$1.') : '';
  var sl = slotById(req, req.chosen);
  var T = {
    ask: { subject: 'Scheduling: ' + req.title, body: 'Hi {{FIRST_NAME}},\n\nI\u2019m helping set up \u201c' + req.title + '\u201d, a ' + (req.duration || 30) + '-minute meeting ' + where + '.' + about + '\n\nCould you let me know which of these times work for you?\n\n{{TIMES}}\n\n{{HOW_TO_ANSWER}}\n\nThank you,\n{{SIGNATURE}}' },
    follow: { subject: 'Following up: ' + req.title, body: 'Hi {{FIRST_NAME}},\n\nJust following up on scheduling \u201c' + req.title + '\u201d. When you have a moment, could you let me know which of these times work for you?\n\n{{TIMES}}\n\n{{HOW_TO_ANSWER}}\n\nIf none of them work, just say so and I\u2019ll find some others.\n\nThank you,\n{{SIGNATURE}}' },
    confirm: { subject: 'Confirmed: ' + req.title + (sl ? ' \u2014 ' + fmtDay(sl.s, ET, true) : ''), body: 'Hi {{FIRST_NAME}},\n\nThank you for your flexibility. \u201c' + req.title + '\u201d is confirmed for ' + (sl ? fmtDay(sl.s, ET, true) + ', ' + fmtRange(sl.s, sl.e, ET) + ' Eastern' : 'the time we agreed') + ', ' + where + '. A calendar invitation is on its way.\n\nLooking forward to speaking with you.\n\nBest,\n{{SIGNATURE}}' },
    other: { subject: req.title, body: 'Hi {{FIRST_NAME}},\n\n' + (extra || '') + '\n\nBest,\n{{SIGNATURE}}' }
  };
  return T[kind];
}
function draftWithClaude(kind, req, recips, extra, tz) {
  var sl = slotById(req, req.chosen);
  var facts = [
    'Meeting name: ' + req.title,
    'What it is for: ' + (req.purpose || '(not given)'),
    'Length: ' + (req.duration || 30) + ' minutes; where: ' + (req.where || 'Zoom'),
    req.askedBy ? 'Requested by: ' + req.askedBy : '',
    'Writing to: ' + recips.map(function (g) { return (g.name || g.email) + (g.org ? ' (' + g.org + ')' : ''); }).join('; '),
    'MISMO people attending: ' + (req.internal || []).map(function (id) { var p = person(id); return p ? p.name + (p.role ? ', ' + p.role : '') : id; }).join('; '),
    kind === 'confirm' && sl ? 'Booked time: ' + fmtDay(sl.s, ET, true) + ', ' + fmtRange(sl.s, sl.e, ET) + ' Eastern' : '',
    kind === 'follow' ? 'Earlier emails about this so far: ' + Math.max.apply(null, recips.map(function (g) { return 1 + (g.followUps || []).length; })) : '',
    'Sender: ' + me().name + (meP() && meP().role ? ', ' + meP().role : '') + ', MISMO (Mortgage Industry Standards Maintenance Organization)'
  ].filter(Boolean).join('\n');
  var goal = {
    ask: 'Ask the recipient which of the offered times work for them. Briefly say what the meeting is.',
    follow: 'A short, friendly follow-up: they have not yet said which times work. Do not guilt them. Offer to find other times if none work.',
    confirm: 'Confirm the booked time, thank them, and say a calendar invitation is on its way. Do not list the other times.',
    other: 'Write the email described in the sender\u2019s note.'
  }[kind];
  var prompt = 'Draft an email for a MISMO staff member to send. Warm, professional, concise (under 160 words before the times list), plain text, no markdown, no emoji.\n\n' +
    'GOAL: ' + goal + '\n\nFACTS (use only these; never invent times, links, names or details):\n' + facts + '\n\n' +
    (extra ? 'SENDER\u2019S NOTE (follow it): ' + extra + '\n\n' : '') +
    (req.source ? 'THE EMAIL THAT ASKED FOR THIS MEETING (background only: use it for who asked, who introduced whom, what the meeting is about and the right tone; do not quote it, and never repeat phone numbers, links or anything not meant for the recipient):\n' + String(req.source).slice(0, 6000) + '\n\n' : '') +
    'PLACEHOLDERS \u2014 put each of these on its own line exactly as written, and the app fills them in:\n' +
    '{{FIRST_NAME}} after "Hi" in the greeting (e.g. "Hi {{FIRST_NAME}},")\n' +
    (kind === 'ask' || kind === 'follow' ? '{{TIMES}} where the list of times goes\n{{HOW_TO_ANSWER}} right after the times (it says how to reply)\n' : '') +
    '{{SIGNATURE}} as the very last line, after a sign-off such as "Best," or "Thank you,"\n\n' +
    'Return ONLY JSON: {"subject": "...", "body": "..."}';
  return ask(prompt).then(function (text) {
    var j = jsonIn(text);
    if (!j || !j.body || j.body.indexOf('{{SIGNATURE}}') < 0) throw err('BAD_DRAFT');
    if ((kind === 'ask' || kind === 'follow') && j.body.indexOf('{{TIMES}}') < 0) j.body = j.body.replace('{{SIGNATURE}}', '{{TIMES}}\n\n{{HOW_TO_ANSWER}}\n\n{{SIGNATURE}}');
    if ((kind === 'ask' || kind === 'follow') && j.body.indexOf('{{HOW_TO_ANSWER}}') < 0) j.body = j.body.replace('{{TIMES}}', '{{TIMES}}\n\n{{HOW_TO_ANSWER}}');
    return { subject: String(j.subject || req.title).slice(0, 200), body: String(j.body) };
  });
}
function fill(tpl, req, recips, tz, oneGuest) {
  var names = recips.map(function (g) { return first(g.name) || g.email; });
  var nm = names.length <= 1 ? (names[0] || 'there') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  var how = LINKS.live && oneGuest
    ? 'You can tick the times that work for you here (it takes a minute, no sign-in):\n' + guestLink(req, oneGuest)
    : 'Just reply to this email with the times that work' + (recips.length > 1 ? ' for each of you' : '') + '.';
  return tpl.replace(/\{\{FIRST_NAME\}\}/g, nm).replace(/\{\{TIMES\}\}/g, timesBlock(req, tz)).replace(/\{\{HOW_TO_ANSWER\}\}/g, how).replace(/\{\{SIGNATURE\}\}/g, senderSig());
}
function owaCompose(to, cc, subject, body) {
  var q = 'to=' + encodeURIComponent(to.join(',')) + (cc.length ? '&cc=' + encodeURIComponent(cc.join(',')) : '') + '&subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  return 'https://outlook.office.com/mail/deeplink/compose?' + q;
}
function mailto(to, cc, subject, body) { return 'mailto:' + to.map(encodeURIComponent).join(',') + '?' + (cc.length ? 'cc=' + cc.map(encodeURIComponent).join(',') + '&' : '') + 'subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body); }

function openDraft(req, kind, gids) {
  req = getReq(req.id);
  var D = dialog('Draft the email for me', true);
  var guests = req.guests || [];
  var form = el('div', 'form');
  form.innerHTML = '<label class="f w6"><span>What kind of email</span><select id="d-kind"></select></label>' +
    '<label class="f w3"><span>Times in</span><select id="d-tz"></select></label>' +
    '<div class="f"><span>To</span><div class="chips" id="d-to"></div></div>' +
    '<label class="f"><span class="grow-row"><input type="checkbox" id="d-cc"> <span>Copy the MISMO people on this meeting</span></span></label>' +
    '<label class="f"><span>Anything to add or mention? <span class="hint">(optional \u2014 e.g. \u201cmention Kelly asked me to set this up\u201d or \u201ckeep it very short\u201d)</span></span><textarea id="d-extra" rows="2" maxlength="1000"></textarea></label>';
  D.body.appendChild(form);
  Object.keys(KINDS).forEach(function (k) { var o = el('option', null, esc(KINDS[k])); o.value = k; $('#d-kind', form).appendChild(o); });
  $('#d-kind', form).value = kind || 'ask';
  ZONES.forEach(function (z) { var o = el('option', null, esc(z.n)); o.value = z.v; $('#d-tz', form).appendChild(o); });
  $('#d-tz', form).value = ET;
  function paintTo() {
    var k = $('#d-kind', form).value, box = $('#d-to', form); box.innerHTML = '';
    var pre = gids && gids.length ? gids : guests.filter(function (g) {
      if (k === 'ask') return !g.sentAt && !g.answer; if (k === 'follow') return !g.answer && g.sentAt; return true;
    }).map(function (g) { return g.id; });
    if (!pre.length && k !== 'follow') pre = guests.map(function (g) { return g.id; });
    guests.forEach(function (g) {
      var l = el('label', 'pick'); l.innerHTML = '<input type="checkbox" value="' + esc(g.id) + '"' + (pre.indexOf(g.id) >= 0 ? ' checked' : '') + '>' + personChip(g.name || g.email, g.answer ? 'answered' : g.sentAt ? 'asked' : 'not asked');
      box.appendChild(l);
    });
    if (!guests.length) box.appendChild(el('span', 'small muted', 'No outside guests \u2014 the email goes to the MISMO people.'));
    $('#d-cc', form).checked = k === 'confirm' || (k === 'ask' && !!req.askedBy);
  }
  paintTo();
  $('#d-kind', form).onchange = function () { gids = null; paintTo(); };
  var go = btn('Draft it', 'big', null, 'spark'); go.style.marginTop = '14px';
  var say = el('span', 'small muted'); say.style.marginLeft = '10px';
  D.body.appendChild(go); D.body.appendChild(say);
  var out = el('div', 'draft-out'); out.hidden = true; D.body.appendChild(out);
  D.foot.appendChild(btn('Close', 'ghost', D.close));

  go.onclick = function () {
    var k = $('#d-kind', form).value, tz = $('#d-tz', form).value, extra = $('#d-extra', form).value.trim();
    var ids = $$('#d-to input:checked', form).map(function (i) { return i.value; });
    var recips = guests.filter(function (g) { return ids.indexOf(g.id) >= 0; });
    var internalPeople = (req.internal || []).map(person).filter(Boolean);
    if (!recips.length && !guests.length) recips = internalPeople.map(function (p) { return { id: 'p-' + p.id, name: p.name, email: emailOf(p), internal: 1 }; });
    if (!recips.length) { say.textContent = 'Tick at least one person.'; return; }
    if ((k === 'ask' || k === 'follow') && !(req.slots || []).some(function (s) { return s.s > Date.now(); })) { say.textContent = 'Pick some times first.'; return; }
    if (k === 'other' && !extra) { say.textContent = 'Say what the email should be about in the box above.'; return; }
    go.disabled = true; say.innerHTML = '<span class="spinner"></span> Writing\u2026';
    askReady().then(function (ok) {
      if (!ok) return { d: templateFor(k, req, extra), byClaude: false };
      return draftWithClaude(k, req, recips, extra, tz).then(function (d) { return { d: d, byClaude: true }; }, function () { return { d: templateFor(k, req, extra), byClaude: false }; });
    }).then(function (res) {
      go.disabled = false; go.querySelector('span').textContent = 'Draft it again';
      say.textContent = res.byClaude ? 'Drafted by Claude. Read it over and change anything before you send.' : (PREVIEW ? 'Standard wording (in the preview Claude isn\u2019t connected; on the real site Claude writes it).' : 'Standard wording \u2014 Claude wasn\u2019t available just now.');
      showDraft(out, req, k, recips, tz, res.d, $('#d-cc', form).checked ? internalPeople.map(emailOf).filter(Boolean) : []);
    });
  };
  if (!guests.length || gids) setTimeout(function () { go.click(); }, 50);
}
function showDraft(out, req, kind, recips, tz, d, cc) {
  out.hidden = false; out.innerHTML = '';
  var perPerson = LINKS.live && (kind === 'ask' || kind === 'follow') && recips.length > 1 && !recips[0].internal;
  var who = perPerson ? recips[0] : null;
  if (perPerson) {
    var sw = el('div', 'grow-row small'); sw.style.marginBottom = '10px';
    sw.innerHTML = '<span>Each person gets their own private link, so send one email each. Showing the email for</span>';
    var s = el('select'); s.style.width = 'auto';
    recips.forEach(function (g) { var o = el('option', null, esc(g.name || g.email)); o.value = g.id; s.appendChild(o); });
    s.onchange = function () { who = recips.find(function (g) { return g.id === s.value; }); paint(); };
    sw.appendChild(s); out.appendChild(sw);
  }
  var subj = el('label', 'f'); subj.innerHTML = '<span>Subject</span><input type="text">';
  var body = el('label', 'f'); body.style.marginTop = '10px'; body.innerHTML = '<span>Email <span class="hint">(you can edit it here)</span></span><textarea rows="14"></textarea>';
  out.appendChild(subj); out.appendChild(body);
  var row = el('div', 'grow-row'); row.style.marginTop = '12px'; out.appendChild(row);
  function toList() { return (who ? [who] : recips).map(function (g) { return g.email; }).filter(Boolean); }
  var marked = {};
  function paint() {
    if (sent) {
      var targets = who ? [who] : recips, cur = getReq(req.id) || req;
      var done = targets.every(function (t) { var g = (cur.guests || []).find(function (x) { return x.id === t.id; }); return marked[t.id] || (kind === 'ask' && g && g.sentAt); });
      sent.disabled = done; sent.querySelector('span').textContent = done ? 'Marked as sent' : 'I sent it';
    }
    $('input', subj).value = d.subject;
    $('textarea', body).value = fill(d.body, req, who ? [who] : recips, tz, who || (recips.length === 1 && !recips[0].internal ? recips[0] : null));
  }
  var sent = null;
  row.appendChild(btn('Open in Outlook', '', function () { window.open(owaCompose(toList(), cc, $('input', subj).value, $('textarea', body).value), '_blank', 'noopener'); }, 'mail'));
  row.appendChild(btn('Copy the email', 'ghost', function () { copy($('textarea', body).value).then(function () { toast('Copied. Paste it into a new email in Outlook.'); }); }));
  var alt = el('a', 'small'); alt.textContent = 'or use my computer\u2019s email app'; alt.href = '#';
  alt.onclick = function (e) { e.preventDefault(); location.href = mailto(toList(), cc, $('input', subj).value, $('textarea', body).value); };
  row.appendChild(alt);
  if ((kind === 'ask' || kind === 'follow') && !recips[0].internal && canEdit()) {
    var sent = btn('I sent it', 'ghost', function () {
      var targets = who ? [who.id] : recips.map(function (g) { return g.id; });
      askDate({ title: 'When did you send it?', days: getReq(req.id).followDays, ok: 'Mark as sent' }).then(function (when) {
        if (!when) return;
        var r = clone(getReq(req.id)), names = [];
        r.guests.forEach(function (g) {
          if (targets.indexOf(g.id) < 0) return; names.push(g.name || g.email);
          if (kind === 'ask' || !g.sentAt) g.sentAt = g.sentAt || when; else g.followUps = (g.followUps || []).concat(when);
        });
        targets.forEach(function (t) { marked[t] = 1; });
        put(r, (kind === 'ask' ? 'Asked ' : 'Followed up with ') + names.join(', ') + sentOn(when));
        toast('Noted. If ' + (names.length === 1 ? first(names[0]) + ' doesn\u2019t' : 'they don\u2019t') + ' answer, you\u2019ll be reminded on ' + dayWord(addBiz(when, r.followDays || DEFAULT_FOLLOW_DAYS)) + '.');
        paint();
      });
    }, 'check');
    row.appendChild(sent);
    out.appendChild(el('p', 'small muted', 'After you send it from Outlook, press <b>I sent it</b> and pick the day you sent it, so the follow-up reminder counts from then.'));
  }
  paint();
}

/* ---------------- the calendar invite ---------------- */
function attendees(req) {
  var list = (req.internal || []).map(person).filter(Boolean).map(function (p) { return { name: p.name, email: emailOf(p) }; });
  return list.concat((req.guests || []).map(function (g) { return { name: g.name, email: g.email }; })).filter(function (a) { return a.email && a.email.toLowerCase() !== String(req.owner || '').toLowerCase(); });
}
function inviteBody(req) { return (req.purpose ? req.purpose + '\n\n' : '') + (req.where === 'Zoom' || req.where === 'Microsoft Teams' ? '(Add the ' + req.where + ' link here.)\n\n' : '') + 'Scheduled with the MISMO Scheduler.'; }
function owaInvite(req, sl) {
  var iso = function (t) { return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'); };
  return 'https://outlook.office.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent' +
    '&subject=' + encodeURIComponent(req.title) + '&startdt=' + encodeURIComponent(iso(sl.s)) + '&enddt=' + encodeURIComponent(iso(sl.e)) +
    '&location=' + encodeURIComponent(req.where || '') + '&body=' + encodeURIComponent(inviteBody(req)) +
    '&to=' + encodeURIComponent(attendees(req).map(function (a) { return a.email; }).join(','));
}
function downloadIcs(req, sl) {
  var stamp = function (t) { return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
  var escI = function (s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); };
  var fold = function (line) { var out = ''; while (line.length > 74) { out += line.slice(0, 74) + '\r\n '; line = line.slice(74); } return out + line; };
  var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MISMO//Scheduler//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + req.id + '-' + sl.id + '@resources.mismo.org', 'DTSTAMP:' + stamp(Date.now()), 'DTSTART:' + stamp(sl.s), 'DTEND:' + stamp(sl.e),
    'SUMMARY:' + escI(req.title), 'LOCATION:' + escI(req.where), 'DESCRIPTION:' + escI(inviteBody(req)),
    'ORGANIZER;CN=' + escI(req.ownerName) + ':mailto:' + req.owner]
    .concat(attendees(req).map(function (a) { return 'ATTENDEE;CN=' + escI(a.name) + ';ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:' + a.email; }))
    .concat(['END:VEVENT', 'END:VCALENDAR']);
  var blob = new Blob([lines.map(fold).join('\r\n')], { type: 'text/calendar' });
  var a = el('a'); a.href = URL.createObjectURL(blob); a.download = req.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) + '.ics';
  document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Downloaded. Open the file and Outlook shows the meeting, ready to send.');
}

/* ======================================================================
   HOW IT WORKS
   ====================================================================== */
/* ======================================================================
   THE DASHBOARD — everything on one page, the way Membership Desk and
   MISMO Media read: the headline first, four figure boxes, then the work.
   A request, the full lists, the calendar and a new request open in the
   panel on the right.
   ====================================================================== */
var DICON = {
  you: '<path d="M9 11.5l2.6 2.6L17 8.7"/><rect x="3.5" y="3.5" width="17" height="17" rx="3"/>',
  poll: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  booked: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
  mail: '<path d="M3 13h4l2 3h6l2-3h4"/><path d="M5.5 5h13l2.5 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>'
};
function RED() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
function countUp(n, v) { if (RED() || !v) { n.textContent = String(v); return; } var t0 = null; function f(t) { if (!t0) t0 = t; var k = Math.min(1, (t - t0) / 600); n.textContent = String(Math.round(v * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(f); } requestAnimationFrame(f); }
function ktile(o) {
  var b = el('button', 'ktile'); b.type = 'button'; b.style.setProperty('--k', o.k);
  b.setAttribute('aria-label', o.lab + ': ' + o.v + ', ' + o.sub);
  b.innerHTML = '<span class="kt"><i><svg viewBox="0 0 24 24" aria-hidden="true">' + o.ic + '</svg></i>' + esc(o.lab) + '<span class="go">→</span></span><b class="kn">0</b><span class="sub" title="' + esc(o.sub) + '">' + esc(o.sub) + '</span><div class="mini"></div>';
  b.onclick = o.go; countUp($('.kn', b), o.v);
  var m = $('.mini', b); m.appendChild(el('div', 'mcap', esc(o.cap || '')));
  var bar = el('div', 'kbar'); m.appendChild(bar);
  (o.parts || []).filter(function (p) { return p.v > 0; }).forEach(function (p) { var i = el('i'); i.style.cssText = 'flex:' + (RED() ? p.v : 0) + ' 1 0;background:' + p.k; if (p.t) i.title = p.t; bar.appendChild(i); if (!RED()) setTimeout(function () { i.style.flexGrow = String(p.v); }, 60); });
  return b;
}
function dashRow(o) {
  var r = el('div', 'row' + (o.cls ? ' ' + o.cls : '')); r.tabIndex = 0; r.setAttribute('role', 'button');
  r.style.setProperty('--k', o.k || 'var(--sky)');
  r.innerHTML = '<span class="dot"></span><span class="nm">' + esc(o.nm) + (o.small ? '<small>' + esc(o.small) + '</small>' : '') + '</span>' +
    (o.wh != null ? '<span class="wh">' + esc(o.wh) + '</span>' : '') + (o.age ? '<span class="age ' + (o.ageCls || '') + '">' + esc(o.age) + '</span>' : '<span></span>');
  if (o.acts) { var a = el('span', 'acts'); o.acts.forEach(function (x) { a.appendChild(x); }); r.appendChild(a); }
  r.onclick = function (e) { if (e.target.closest('.acts')) return; o.go(); };
  r.onkeydown = function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target === r) { e.preventDefault(); o.go(); } };
  return r;
}
function dashPanel(title, hint, link, linkGo) {
  var p = el('div', 'panel');
  p.innerHTML = '<div class="ph"><h2>' + esc(title) + '</h2>' + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</div>';
  if (link) { var l = el('button', 'link', esc(link) + '&nbsp;→'); l.type = 'button'; l.onclick = linkGo; if (hint) l.style.marginLeft = '12px'; $('.ph', p).appendChild(l); }
  var rows = el('div', 'rows'); p.appendChild(rows);
  return { p: p, rows: rows };
}
function allClear(title, line) {
  var d = el('div', 'allclear');
  d.innerHTML = '<span class="ac-i"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg></span><div><b>' + esc(title) + '</b><span>' + esc(line) + '</span></div>';
  return d;
}
function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }
function shortAgo(t) { var m = Math.round((Date.now() - t) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago'); return new Date(t).toLocaleDateString('en-US', { timeZone: VIEW_TZ, month: 'short', day: 'numeric' }); }
function viewDash(app) {
  var now = Date.now(), all = allReqs(), weekAgo = now - 7 * 864e5;
  var approvals = all.filter(awaitingApproval), looks = all.filter(function (r) { return needsLook(r) || followsFinished(r) || awaitingDecision(r) || awaitingPollCheck(r) || awaitingMove(r); }), due = followList(true).filter(function (x) { return x.st === 'due'; });
  var open = all.filter(function (r) { var ph = phase(r); return ph !== 'booked' && ph !== 'cancelled'; });
  var polls = open.filter(function (r) { var ph = phase(r); return ph === 'collecting' || ph === 'ready'; });
  var booked = all.filter(function (r) { return r.status === 'booked'; });
  var bookedWeek = booked.filter(function (r) { return (r.bookedAt || 0) > weekAgo; });
  var coming = booked.map(function (r) { return { r: r, sl: slotById(r, r.chosen) }; }).filter(function (x) { return x.sl && x.sl.e > now; }).sort(function (a, b) { return a.sl.s - b.sl.s; });
  var inbox = inboxItems().filter(function (x) { return !isHealthMail(x); }), inWeek = inbox.filter(function (x) { return (x.receivedAt || 0) > weekAgo; });
  var guestsWaiting = 0, guestsIn = 0;
  polls.forEach(function (r) { (r.guests || []).forEach(function (g) { if (g.answer) guestsIn++; else if (g.sentAt) guestsWaiting++; }); });
  var needN = approvals.length + looks.length + due.length;

  /* ---- the headline ---- */
  var hr = new Date().getHours(), nm = first(me().name);
  var hero = el('div', 'hero');
  hero.innerHTML = '<div class="hero-l"><div class="hero-eb"><span>Scheduler</span><span class="hero-dot"></span><span id="asof">As of ' + esc(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) + '</span></div>' +
    '<h1>' + (hr < 12 ? 'Good Morning' : hr < 17 ? 'Good Afternoon' : 'Good Evening') + (nm ? ', ' + esc(nm) : '') + '</h1><p class="hero-s"></p><div class="hero-acts"></div></div><div class="hero-r"></div>';
  var hs = $('.hero-s', hero), B = function (t) { return '<b>' + esc(t) + '</b>'; }, sent = [];
  sent.push(needN ? B(plural(needN, 'thing needs you', 'things need you')) + (approvals.length ? ', ' + plural(approvals.length, 'time', 'times') + ' to approve' : '') + '.' : B('Nothing needs you right now.'));
  if (polls.length) sent.push(plural(polls.length, 'poll is', 'polls are') + ' out' + (guestsWaiting ? ', waiting on ' + plural(guestsWaiting, 'guest', 'guests') : '') + '.');
  sent.push(bookedWeek.length ? B(plural(bookedWeek.length, 'meeting', 'meetings') + ' booked') + ' this week' + (coming.length ? ', ' + coming.length + ' coming up.' : '.') : (coming.length ? plural(coming.length, 'meeting is', 'meetings are') + ' coming up.' : ''));
  hs.innerHTML = sent.join(' ');
  var ha = $('.hero-acts', hero);
  var b1 = el('button', 'hbtn', needN ? 'Review What Needs You' : 'Start a Request'); b1.type = 'button';
  b1.onclick = needN ? function () { var t = $('#dash-needs'); if (t) t.scrollIntoView({ behavior: RED() ? 'auto' : 'smooth', block: 'start' }); } : function () { go('new'); };
  ha.appendChild(b1);
  if (needN && canEdit()) { var b2 = el('button', 'hbtn ghost', 'Start a Request'); b2.type = 'button'; b2.onclick = function () { go('new'); }; ha.appendChild(b2); }
  var b3 = el('button', 'hbtn ghost', 'Team Calendar'); b3.type = 'button'; b3.onclick = function () { go('cal'); }; ha.appendChild(b3);
  /* the ring: of the last 30 days' requests, how many are booked */
  var recent = all.filter(function (r) { return (r.createdAt || 0) > now - 30 * 864e5 && r.status !== 'cancelled'; });
  var rb = recent.filter(function (r) { return r.status === 'booked'; }).length, pct = recent.length ? Math.round(100 * rb / recent.length) : 0;
  var LEN = 2 * Math.PI * 54, off = function (v) { return (LEN * (1 - v / 100)).toFixed(1); };
  var ring = $('.hero-r', hero);
  ring.innerHTML = '<div class="hring"><svg viewBox="0 0 132 132" aria-hidden="true"><defs><linearGradient id="hring-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#74bfeb"/><stop offset="1" stop-color="#5fd39a"/></linearGradient></defs><circle cx="66" cy="66" r="54" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="12"/><circle class="arc" cx="66" cy="66" r="54" fill="none" stroke="url(#hring-g)" stroke-width="12" stroke-linecap="' + (pct ? 'round' : 'butt') + '" stroke-dasharray="' + LEN.toFixed(1) + '" stroke-dashoffset="' + (RED() ? off(pct) : off(0)) + '" transform="rotate(-90 66 66)"/></svg><div class="hring-m"><b>' + pct + '%</b><span>Booked</span></div></div><div class="hring-c"><b>' + rb + '</b> booked · <b>' + (recent.length - rb) + '</b> in progress</div>';
  ring.title = 'Of the requests started in the last 30 days, ' + pct + '% are booked';
  if (!RED()) setTimeout(function () { var a = $('.arc', ring); if (a) a.setAttribute('stroke-dashoffset', off(pct)); }, 80);
  app.appendChild(hero);
  var hsx = healthStrip(); if (hsx) app.appendChild(hsx);

  /* ---- the four boxes ---- */
  var tiles = el('div', 'dash-tiles');
  var autoBooked = bookedWeek.filter(function (r) { return r.robot && r.robot.auto; }).length;
  var notReq = inWeek.filter(function (x) { return x.status === 'dismissed' || (x.status === 'new' && x.robotAt); }).length;
  tiles.appendChild(ktile({ k: '#ff8f7d', ic: DICON.you, lab: 'Needs You', v: needN,
    sub: needN ? [approvals.length ? approvals.length + ' to approve' : '', looks.length ? looks.length + ' to look at' : '', due.length ? due.length + ' to follow up' : ''].filter(Boolean).join(' · ') : 'nothing waiting on you',
    cap: needN ? 'Approve · Look at · Follow up' : 'All clear', parts: needN ? [{ v: approvals.length, k: '#ff8f7d', t: 'To approve' }, { v: looks.length, k: '#f0b94a', t: 'To look at' }, { v: due.length, k: '#74bfeb', t: 'To follow up' }] : [{ v: 1, k: '#5fd39a' }],
    go: function () { var t = $('#dash-needs'); if (t) t.scrollIntoView({ behavior: RED() ? 'auto' : 'smooth', block: 'start' }); } }));
  tiles.appendChild(ktile({ k: '#74bfeb', ic: DICON.poll, lab: 'Polls Out', v: polls.length,
    sub: polls.length ? plural(guestsWaiting, 'guest', 'guests') + ' still to answer' : 'no polls waiting',
    cap: guestsIn + guestsWaiting ? guestsIn + ' answered · ' + guestsWaiting + ' waiting' : 'No guests waiting', parts: [{ v: guestsIn, k: '#5fd39a', t: 'Answered' }, { v: guestsWaiting, k: '#74bfeb', t: 'Waiting' }],
    go: function () { STATE.listShow = 'active'; go('list'); } }));
  tiles.appendChild(ktile({ k: '#5fd39a', ic: DICON.booked, lab: 'Booked This Week', v: bookedWeek.length,
    sub: coming.length ? coming.length + ' coming up' : 'nothing on the calendar yet',
    cap: bookedWeek.length ? autoBooked + ' automatic · ' + (bookedWeek.length - autoBooked) + ' by hand' : 'None this week', parts: [{ v: autoBooked, k: '#5fd39a', t: 'Automatic' }, { v: bookedWeek.length - autoBooked, k: '#9fb3c8', t: 'By hand' }],
    go: function () { STATE.listShow = 'booked'; lsSet('listShow', 'booked'); go('list'); } }));
  tiles.appendChild(ktile({ k: '#f0b94a', ic: DICON.mail, lab: 'Emails This Week', v: inWeek.length,
    sub: inWeek.length ? (inWeek.length - notReq) + ' became requests' : 'nothing came in this week',
    cap: inWeek.length ? (inWeek.length - notReq) + ' requests · ' + notReq + ' set aside' : 'scheduling@mismo.org', parts: [{ v: inWeek.length - notReq, k: '#f0b94a', t: 'Became requests' }, { v: notReq, k: '#9fb3c8', t: 'Set aside' }],
    go: function () { go('inbox'); } }));
  app.appendChild(tiles);

  var grid = el('div', 'hgrid'), L = el('div', 'hside'), R = el('div', 'hside');
  grid.appendChild(L); grid.appendChild(R); app.appendChild(grid);

  /* ---- Needs You ---- */
  var nd = dashPanel('Needs You', needN ? 'approve first, then look' : '', due.length ? 'Follow Up' : '', function () { go('follow'); });
  nd.p.id = 'dash-needs'; nd.p.style.scrollMarginTop = 'calc(var(--hq-h) + 16px)';
  approvals.forEach(function (r) {
    var P = r.robot.proposed, acts = [];
    if (canApprove()) acts.push(btn('Approve', 'sm', function () { approveSlot(r, P); }, 'check'));
    nd.rows.appendChild(dashRow({ k: '#ff8f7d', nm: r.title || 'Meeting request', small: 'Approve ' + slotLabel(P, VIEW_TZ, true), wh: P.how || '', age: 'Waiting ' + shortAgo(P.at || r.updatedAt || now).replace(' ago', ''), ageCls: 'late', acts: acts, go: function () { go(null, r.id); } }));
  });
  looks.forEach(function (r) {
    if (awaitingMove(r)) {
      var ma = canApprove() ? [btn('Approve the Move', 'sm', function () { approveMove(r); }, 'check')] : [];
      nd.rows.appendChild(dashRow({ k: '#ff8f7d', nm: r.title || 'Meeting request', small: (r.robot.proposedMove.from || 'A guest') + ' asked to move it to ' + slotLabel(r.robot.proposedMove, VIEW_TZ, true), wh: '', age: 'Move?', ageCls: 'late', acts: ma, go: function () { go(null, r.id); } }));
      return;
    }
    if (awaitingPollCheck(r)) {
      var pa = canApprove() ? [btn('Send the Poll', 'sm', function () { sendPollOk(r); }, 'check')] : [];
      nd.rows.appendChild(dashRow({ k: '#f0b94a', nm: r.title || 'Meeting request', small: 'From outside MISMO and includes other outside people: check it, then send the poll or close it', wh: '', age: 'Check first', ageCls: 'wait', acts: pa, go: function () { go(null, r.id); } }));
      return;
    }
    if (awaitingDecision(r)) {
      var da = canEdit() ? [btn('Send New Times', 'sm ghost', function () { sendNewTimes(r); })] : [];
      nd.rows.appendChild(dashRow({ k: '#f0b94a', nm: r.title || 'Meeting request', small: 'No time works for everyone: book the best one, make someone optional, or send new times', wh: '', age: 'Your call', ageCls: 'wait', acts: da, go: function () { go(null, r.id); } }));
      return;
    }
    if (followsFinished(r)) {
      var fa = canEdit() ? [btn('Start Again', 'sm', function () { startFollows(r); })] : [];
      nd.rows.appendChild(dashRow({ k: '#f0b94a', nm: r.title || 'Meeting request', small: 'Three follow-ups, no answer from ' + followWaiting(r).map(function (g) { return g.name || g.email; }).join(', '), wh: '', age: 'Follow-ups done', ageCls: 'wait', acts: fa, go: function () { go(null, r.id); } }));
      return;
    }
    nd.rows.appendChild(dashRow({ k: '#f0b94a', nm: r.title || 'Meeting request', small: 'Stopped because ' + (r.robot.why || 'it needs a person'), wh: (r.robot.requester && (r.robot.requester.name || r.robot.requester.email)) || '', age: 'Needs a look', ageCls: 'wait', go: function () { go(null, r.id); } }));
  });
  due.forEach(function (x) {
    nd.rows.appendChild(dashRow({ k: '#74bfeb', nm: 'Follow up with ' + (x.g.name || x.g.email), small: x.r.title, wh: 'asked ' + fmtDay(Math.max(x.g.sentAt || 0, (x.g.followUps || []).slice(-1)[0] || 0), VIEW_TZ), age: 'Due ' + dayWord(x.due), ageCls: 'sky', go: function () { go(null, x.r.id); } }));
  });
  if (!needN) nd.p.appendChild(allClear('You’re all caught up', 'Nothing to approve or look at. Times the Scheduler finds land here for you or Vanessa to approve.'));
  L.appendChild(nd.p);

  /* ---- Polls Out ---- */
  var pl = dashPanel('Polls Out', polls.length ? 'newest first' : '', 'All Requests', function () { STATE.listShow = 'active'; go('list'); });
  polls.slice().sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); }).slice(0, 6).forEach(function (r) {
    var gs = r.guests || [], ans = gs.filter(function (g) { return g.answer; }).length, live = (r.slots || []).filter(function (s) { return s.s > now; }).length;
    var rem = followWaiting(r).reduce(function (a, g) { return Math.max(a, followOf(r, g).sent); }, 0);
    var who = (r.internal || []).map(function (id) { var p = person(id); return p ? first(p.name) : id; }).concat(optionalStaff(r).map(function (n) { return first(n) + ' (optional)'; }), gs.map(function (g) { return g.name || g.email; }));
    pl.rows.appendChild(dashRow({ k: isAuto(r) ? '#74bfeb' : '#9fb3c8', nm: r.title || 'Meeting request', small: who.join(', '), wh: ans + ' of ' + gs.length + ' answered · ' + plural(live, 'time', 'times') + ' on offer', age: isAuto(r) && r.robot.followStop ? 'Follow-ups stopped' : rem ? 'Follow-up ' + rem + ' of ' + FOLLOW_MAX : (isAuto(r) ? 'Automatic' : 'By hand'), ageCls: rem ? 'wait' : '', go: function () { go(null, r.id); } }));
  });
  if (!polls.length) pl.p.appendChild(el('div', 'empty', 'No polls out. When a request needs guests to choose, its poll shows here with who has answered.'));
  L.appendChild(pl.p);

  /* ---- Scheduled: every booked meeting still ahead ---- */
  var whoOf = function (r) { return (r.internal || []).map(function (id) { var p = person(id); return p ? first(p.name) : id; }).concat((r.guests || []).map(function (g) { return g.name || g.email; })).join(', '); };
  var cu = dashPanel('Scheduled', coming.length ? plural(coming.length, 'meeting', 'meetings') + ' ahead' : '', coming.length > 6 ? 'All Scheduled' : '', function () { STATE.listShow = 'booked'; lsSet('listShow', 'booked'); go('list'); });
  coming.slice(0, 6).forEach(function (x) {
    var r = x.r, soon = x.sl.s < now + 7 * 864e5;
    cu.rows.appendChild(dashRow({ k: '#5fd39a', nm: r.title || 'Meeting', small: whoOf(r), wh: fmtTime(x.sl.s, VIEW_TZ) + ' ' + tzAbbr(x.sl.s, VIEW_TZ) + ' · ' + (r.where || 'Zoom'), age: dayWord(parts(x.sl.s, VIEW_TZ).iso).replace(/^./, function (c) { return c.toUpperCase(); }), ageCls: soon ? 'ok' : '', go: function () { go(null, r.id); } }));
  });
  if (!coming.length) cu.p.appendChild(el('div', 'empty', 'Nothing on the calendar ahead. Once a time is approved, the meeting shows here until it happens.'));
  L.appendChild(cu.p);

  /* ---- Past Meetings: booked and already happened ---- */
  var pastM = booked.map(function (r) { return { r: r, sl: slotById(r, r.chosen) }; }).filter(function (x) { return x.sl && x.sl.e <= now; }).sort(function (a, b) { return b.sl.s - a.sl.s; });
  var pm = dashPanel('Past Meetings', pastM.length ? pastM.length + ' so far' : '', pastM.length > 5 ? 'All Past' : '', function () { STATE.listShow = 'past'; lsSet('listShow', 'past'); go('list'); });
  pastM.slice(0, 5).forEach(function (x) {
    var r = x.r;
    pm.rows.appendChild(dashRow({ k: '#9fb3c8', nm: r.title || 'Meeting', small: whoOf(r), wh: fmtTime(x.sl.s, VIEW_TZ) + ' ' + tzAbbr(x.sl.s, VIEW_TZ) + ' · ' + (r.where || 'Zoom'), age: fmtDay(x.sl.s, VIEW_TZ), go: function () { go(null, r.id); } }));
  });
  if (!pastM.length) pm.p.appendChild(el('div', 'empty', 'Meetings move here once they’ve happened, so you can look back at what was scheduled.'));
  L.appendChild(pm.p);

  /* ---- Team This Week ---- */
  var tw = dashPanel('Team This Week', 'free time, 9–5 Eastern', 'Calendar', function () { go('cal'); });
  var tNow = Date.now(), tIso = todayISO(ET), dayOver = tNow >= at(tIso, 17 * 60, ET);
  var days5 = bizDaysAhead(5, dayOver ? tIso : isoAdd(tIso, -1)).filter(function (d) { return !isWeekend(d); }).slice(0, 5);
  var g = el('div', 'avgrid');
  g.appendChild(el('span'));
  days5.forEach(function (d) { g.appendChild(el('span', 'h', esc(new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })))); });
  TEAM.people.forEach(function (pp) {
    g.appendChild(el('span', 'who', esc(pp.name)));
    days5.forEach(function (d) {
      var free = 0, known = 0;
      for (var m = 9 * 60; m < 17 * 60; m += 30) { if (at(d, m + 30, ET) <= tNow) continue; var st = calState(pp.id, at(d, m, ET), at(d, m + 30, ET)); if (st === null) continue; known++; if (st === 'free') free++; }
      var c = el('span', 'c');
      if (!known) { c.style.background = 'var(--unk)'; c.textContent = '–'; c.title = pp.name + ': no Outlook data'; }
      else { var f = free / known, pctF = Math.round(100 * f); c.textContent = pctF + '%'; c.title = pp.name + ', ' + d + ': ' + pctF + '% free'; c.style.background = 'color-mix(in srgb,' + (f >= .6 ? '#5fd39a' : f >= .3 ? '#f0b94a' : '#ff8f7d') + ' ' + Math.round(22 + 30 * (f >= .6 ? f : 1 - f)) + '%,var(--surface))'; }
      g.appendChild(c);
    });
  });
  tw.rows.appendChild(g);
  tw.p.appendChild(el('div', 'avkey', '<span><i style="background:color-mix(in srgb,#5fd39a 45%,var(--surface))"></i>Mostly free</span><span><i style="background:color-mix(in srgb,#f0b94a 40%,var(--surface))"></i>Some time</span><span><i style="background:color-mix(in srgb,#ff8f7d 45%,var(--surface))"></i>Booked up</span>'));
  R.appendChild(tw.p);

  /* ---- Couldn't Schedule: closed without a time ---- */
  var unsch = all.filter(couldntSchedule).sort(function (a, b) { return (b.closedAt || b.updatedAt || 0) - (a.closedAt || a.updatedAt || 0); });
  var us = dashPanel('Couldn’t Schedule', unsch.length ? plural(unsch.length, 'request', 'requests') : '', unsch.length > 4 ? 'All' : '', function () { STATE.listShow = 'unscheduled'; lsSet('listShow', 'unscheduled'); go('list'); });
  unsch.slice(0, 4).forEach(function (r) {
    var why = (r.robot && r.robot.why) ? 'Stopped because ' + r.robot.why : 'Closed by ' + (first(r.closedBy || '') || 'staff');
    us.rows.appendChild(dashRow({ k: '#ff8f7d', nm: r.title || 'Meeting request', small: why, wh: whoOf(r), age: 'Closed ' + shortAgo(r.closedAt || r.updatedAt || now), go: function () { go(null, r.id); } }));
  });
  if (!unsch.length) us.p.appendChild(el('div', 'empty', 'Nothing yet. If we try and can’t find a time, close the request as Couldn’t Schedule and it stays here for reference.'));
  L.appendChild(us.p);

  /* ---- Incoming Email ---- */
  var ib = dashPanel('Incoming Email', 'scheduling@mismo.org', 'All Email', function () { go('inbox'); });
  inbox.slice(0, 5).forEach(function (x) {
    var req = x.reqId ? getReq(x.reqId) : null;
    ib.rows.appendChild(dashRow({ cls: 'r3', k: x.status === 'started' ? '#5fd39a' : x.status === 'dismissed' ? '#9fb3c8' : '#f0b94a', nm: x.subject || '(no subject)', small: displayName(x) + (x.robotNote ? ' · ' + x.robotNote : ''), age: shortAgo(x.receivedAt || now), go: function () { openEmail(x); } }));
  });
  if (!inbox.length) ib.p.appendChild(el('div', 'empty', 'Nothing has come in yet. Emails to scheduling@mismo.org show here a few minutes after they arrive.'));
  R.appendChild(ib.p);

  /* ---- What the Scheduler did ---- */
  var ac = dashPanel('Latest Activity', '', '', null), feed = el('div', 'feed');
  var events = [];
  all.forEach(function (r) { (r.log || []).forEach(function (e) { events.push({ r: r, e: e }); }); });
  events.sort(function (a, b) { return (b.e.at || 0) - (a.e.at || 0); }).slice(0, 14).forEach(function (x) {
    var f = el('div', 'fi'); f.innerHTML = '<span>' + esc(shortAgo(x.e.at || now)) + '</span><div><b>' + esc(x.r.title || 'Meeting request') + '</b> <em>· ' + esc(x.e.what) + (x.e.by && x.e.by !== 'Scheduler' ? ' (' + esc(first(x.e.by)) + ')' : '') + '</em></div>';
    f.onclick = function () { go(null, x.r.id); }; feed.appendChild(f);
  });
  if (!events.length) feed.appendChild(el('div', 'empty', 'What the Scheduler does shows here as it happens.'));
  ac.rows.appendChild(feed); R.appendChild(ac.p);
  /* keep the two columns level: show as much activity as the left column has room for */
  requestAnimationFrame(function () {
    if (getComputedStyle(grid).gridTemplateColumns.split(' ').length < 2) { while (feed.children.length > 6) feed.removeChild(feed.lastChild); return; }
    /* measure at natural height (the columns stretch to match afterwards) */
    grid.style.alignItems = 'start'; L.style.height = R.style.height = 'auto';
    $$('.panel', grid).forEach(function (p) { p.style.flex = '0 0 auto'; });
    while (feed.children.length > 3 && R.offsetHeight > L.offsetHeight + 4) feed.removeChild(feed.lastChild);
    grid.style.alignItems = ''; L.style.height = R.style.height = '';
    $$('.panel', grid).forEach(function (p) { p.style.flex = ''; });
  });
}

/* ======================================================================
   HELP — the full documentation, one topic at a time, the Membership Desk way
   ====================================================================== */
var HELP_STEPS = function (rows) { return '<div class="hsteps">' + rows.map(function (r, i) { return '<div class="hstep"><b class="n">' + (i + 1) + '</b><strong>' + r[0] + '</strong><span>' + r[1] + '</span></div>'; }).join('') + '</div>'; };
var HELP_FAQ = function (rows) { return '<div class="hfaq">' + rows.map(function (r) { return '<div><b>' + r[0] + '</b><span>' + r[1] + '</span></div>'; }).join('') + '</div>'; };
var HELP = [
  { id: 'overview', k: '#74bfeb', t: 'Overview', h: function () { return '<h2>What the Scheduler Does</h2><p class="lead">The Scheduler finds a meeting time that works for people inside and outside MISMO, like Doodle but on its own. Anyone can email a request to <b>scheduling@mismo.org</b>. The Scheduler reads it, checks everyone’s Outlook, offers times, keeps the poll current and books the meeting. You and Vanessa only step in to approve a time or when something needs a person.</p>' +
    HELP_STEPS([['An Email Comes In', 'Someone emails scheduling@mismo.org, or forwards a request there. Within about five minutes the Scheduler reads it with Claude: who should meet, for how long, and any times they suggested.'],
      ['Their Times Come First', 'If everyone from MISMO is free at a time they suggested, and nobody else has to agree, that time is held for approval.'],
      ['Otherwise a Poll', 'Each outside guest gets their own link to the times when everyone at MISMO is free. The person who asked is copied.'],
      ['You Approve, It Books', 'When a time works for everyone, you or Vanessa approve it on the Dashboard. Within minutes everyone gets an Outlook invitation from scheduling@mismo.org with the MISMO Zoom room link. The invitation is the confirmation. Nothing to send by hand.']]) +
    '<div class="hnote"><b>Nothing goes to anyone outside MISMO as “booked” until you or Vanessa approve it.</b> Meetings with MISMO people only are booked straight away, because there is nobody outside to tell. And when no time works for everyone, the Scheduler asks you what to do instead of sending a second poll.</div>' +
    '<h3>Who Uses It</h3><ul><li><b>Vanessa</b> looks after scheduling day to day: she approves times, decides what happens when no time works, and gets the Needs a Look emails.</li><li><b>Jonna</b> can approve too, and is copied on every email that goes to staff.</li><li><b>Everyone on the team</b> can open the Scheduler, see every request and run one by hand. Access is set in People &amp; Access, like every other tool.</li></ul>'; } },
  { id: 'flow', k: '#5fd39a', t: 'How a Request Flows', h: function () { return '<h2>From Email to Booked Meeting</h2><p class="lead">Every request moves through the same stages. Its stage shows as the colored tag on the request.</p>' +
    '<table><thead><tr><th>Stage</th><th>What is happening</th><th>What you do</th></tr></thead><tbody>' +
    '<tr><td><b>Working on It</b></td><td>The Scheduler has read the email and is checking Outlook.</td><td>Nothing.</td></tr>' +
    '<tr><td><b>Waiting on Replies</b></td><td>A poll is out. Times come off when someone at MISMO gets busy or a guest says no; when no time works for everyone, Vanessa and Jonna decide what happens next (book the closest time, make someone optional, or send new times). A guest marked optional doesn’t have to be free for a time to work. Guests who haven’t answered get a warm follow-up a week after the poll, then weekly, three at most; for a quick request (dates within the next week) it’s noon Eastern each following working day.</td><td>Nothing. It shows under Polls Out on the Dashboard.</td></tr>' +
    '<tr><td><b>Waiting for Approval</b></td><td>A time works for everyone. It is held, so no other request can take it.</td><td>Approve it, or press Book under a different time.</td></tr>' +
    '<tr><td><b>Waiting on Replies, in Needs You</b></td><td>Everyone has answered and no time works for all of them. Nothing more goes out until you decide.</td><td>Book the closest time, make someone optional, or press Send New Times. See When No Time Works.</td></tr>' +
    '<tr><td><b>Booked</b></td><td>Everyone has the Outlook invitation with the Zoom room link.</td><td>Nothing. If the invitation couldn’t go by itself, Vanessa gets Booked, Send the Invite with a button that opens it in Outlook.</td></tr>' +
    '<tr><td><b>Needs a Look</b></td><td>The Scheduler stopped and told Vanessa why.</td><td>Fix what’s needed, then Hand Back to the Scheduler, or carry on by hand.</td></tr>' +
    '<tr><td><b>Couldn’t Schedule</b></td><td>Closed after we tried and no time could be found. Kept on the Dashboard for reference.</td><td>Bring it back from the request to try again.</td></tr>' +
    '<tr><td><b>Cancelled</b></td><td>Stopped for good.</td><td>Bring it back from the request if needed.</td></tr></tbody></table>' +
    '<h3>Rules It Follows</h3><ul><li>Times are offered 9:00 AM to 5:00 PM Eastern, on working days only. Fridays between Memorial Day and Labor Day end at 1:00 PM.</li><li>MISMO holidays are never offered: MLK Day, Presidents’ Day, Memorial Day, Juneteenth, Independence Day, Labor Day, Veterans Day, Thanksgiving and the day after, and Winter Break.</li><li>A poll offers up to six times spread over the coming working days, one a day first and never more than two a day, starting the next working day.</li><li>If the email limits the dates (for example “the week of the 16th”), every time on the poll is inside them. Times someone suggests for themselves (“Thursday 1–3 works”) are tried first, and if they don’t work the poll offers other times.</li><li>Tentative in Outlook counts as busy when offering new times.</li><li>If Outlook information is missing or more than six hours old, nothing is decided until it is fresh. If it stays missing for a working day, Vanessa is told.</li><li>Once people have answered, the Scheduler never sends a second set of times on its own: Vanessa or Jonna decide. (If nobody has answered and the times simply run out, it refreshes them.)</li><li>If someone outside MISMO asks for a meeting that includes other outside people (anyone not at their own organization, or anyone at all when they write from a personal address like Gmail), nobody is emailed until Vanessa or Jonna check it and press <b>Send the Poll</b>. This stops anyone using the scheduling mailbox to email strangers. Requests from MISMO staff are never held.</li><li>A guest marked optional doesn’t have to be free for a time to work, and is invited as optional.</li><li>If someone from MISMO is out of office for all the days asked for (or the coming week, when no days are named), the Scheduler doesn’t wait for them: it goes ahead with the others and invites them as optional. It never does this for the person who asked, or when they’re the only one from MISMO on the meeting.</li><li>Meetings can be any length. The length comes from the email (for example “an hour”) or from Edit details; changing it while a poll is out swaps in fresh times at the new length.</li><li>Zoom meetings use a MISMO Zoom room: membership meetings (a name or purpose that says membership) use the membership room (membership@mismo.org, 501 516 3748); everything else uses the main MISMO room (info@mismo.org, 282 517 5426). Two Scheduler meetings never share a room at the same time, and each room keeps clear of its own account’s calendar. The main room also keeps clear of the workgroup meetings on the Meeting Trackers schedule.</li></ul>'; } },
  { id: 'approve', k: '#ff8f7d', t: 'Approving a Time', h: function () { return '<h2>Approving a Time</h2><p class="lead">When the Scheduler finds a time that works for everyone, Vanessa gets an <b>Approve a Time</b> email with Jonna copied, and the request appears at the top of <b>Needs You</b> on the Dashboard.</p>' +
    HELP_STEPS([['Open the Dashboard', 'The time waiting for approval is the first row under Needs You, with why it was picked.'], ['Approve', 'Press Approve on the row, or open the request and press Approve This Time. Only Vanessa and Jonna see the button.'], ['Or Pick Another Time', 'Open the request and press Book under any time in the grid. That approves that time instead, and works even while the poll is still out.'], ['It Sends Everything', 'Within a few minutes everyone gets an Outlook invitation from scheduling@mismo.org with the Zoom room link; that is their confirmation. Optional guests are invited as optional. Vanessa gets Booked and Invited, with Jonna copied.']]) +
    '<div class="hnote"><b>If Outlook changes before you approve</b> (someone books that time), the Scheduler lets the held time go and finds another. Nothing has gone to the guests, so there is nothing to take back.</div>'; } },
  { id: 'polls', k: '#a78bfa', t: 'Polls and Guests', h: function () { return '<h2>What Guests See</h2><p class="lead">Each guest gets an email from MISMO Scheduling with one button: <b>Choose the Times That Work</b>. The times are not listed in the email, so they are always current when the guest opens the link. It only says the meeting’s name, length and place; the notes on a request (what it’s about, who asked and why) stay inside MISMO.</p>' +
    '<ul><li>The link opens a MISMO page with the meeting, its length and where it is. The guest ticks ✓ for times that work and ✗ for the ones that don’t, can add a note, and presses Send.</li><li>Times show in the guest’s own time zone, and they can switch it.</li><li>Each link belongs to one guest. It never shows other guests or their answers.</li><li>Guests can come back to the same link to change their answers until the meeting is booked.</li><li>If you send new times, or change the meeting’s length, guests who already answered get a short <b>New Times</b> email.</li><li>A guest who hasn’t answered gets three warm follow-ups, a week apart (or at noon Eastern each working day when the request is for the coming week). Stop them on the request with <b>Stop Follow-Ups</b>.</li><li>Press <b>Make optional</b> next to a guest under Outside guests when the meeting can go ahead without them. Press <b>Make required</b> to undo it.</li></ul>' +
    '<h3>When a Guest Replies by Email</h3><p class="lead">Their reply lands in scheduling@mismo.org and shows in the request’s history. While their poll is out, Claude reads it:</p><ul><li><b>They name times on the poll</b> (“Tuesday at 10 works”): it counts as their answer, just as if they’d used the link, and shows as <b>Answered (by email)</b>. If that gives a time that works for everyone, it’s held for your approval as usual.</li><li><b>They suggest a different time</b> (“could we do Thursday at 2?”): if everyone from MISMO is free (and the Zoom room), it’s held for your approval. With other guests on the poll, it’s added to the poll instead, and anyone who already answered is asked to look. If MISMO isn’t free, nothing changes and you’re told why (for example “Kelly Bradshaw is busy then”).</li><li><b>Anything vague</b> (“I’m flexible”, a question): nothing changes.</li></ul><p>Either way, Vanessa gets a <b>Reply About</b> email with what they wrote and what the Scheduler did. Nothing goes to anyone outside MISMO until you or Vanessa approve. A reply about a meeting that’s already booked (for example Outlook’s <b>New Time Proposed</b>) also comes to Vanessa, since the invitation has to be moved by hand. To enter an answer yourself, open the request and press <b>Enter their answer</b> next to their name.</p>'; } },
  { id: 'decide', k: '#eb6834', t: 'When No Time Works', h: function () { return '<h2>When No Time Works for Everyone</h2><p class="lead">Once guests have answered and no time on the poll works for all of them, the Scheduler stops and asks. It never sends a second poll on its own. Vanessa gets a <b>No Time Works Yet</b> email, with Jonna copied, listing the closest times and who can make each, and the request shows in <b>Needs You</b>.</p>' +
    '<table><thead><tr><th>You want to</th><th>Do this</th><th>What happens</th></tr></thead><tbody>' +
    '<tr><td>Go with the closest time</td><td>Open the request and press <b>Book</b> under that time.</td><td>Booked straight away. Everyone gets the invitation.</td></tr>' +
    '<tr><td>Go ahead without someone</td><td>Under Outside guests, press <b>Make optional</b> next to them.</td><td>Times only have to work for the others. If one already does, it’s held for your approval. They’re still invited, as optional.</td></tr>' +
    '<tr><td>Try a fresh set of times</td><td>Press <b>Send New Times</b> (on the Needs You row or on the request).</td><td>New times go on the poll and everyone who answered gets a New Times email.</td></tr>' +
    '<tr><td>Change the length</td><td>Press <b>Edit details</b> and change it (for example to an hour).</td><td>A fresh set of times at the new length goes out.</td></tr>' +
    '<tr><td>Give up</td><td>Press <b>Close as Couldn’t Schedule</b>.</td><td>It moves to Couldn’t Schedule on the Dashboard for reference.</td></tr></tbody></table>'; } },
  { id: 'dash', k: '#f0b94a', t: 'The Dashboard', h: function () { return '<h2>Reading the Dashboard</h2><p class="lead">Everything is on one page. Click any row to open it in the panel on the right; press × or Escape to close it.</p>' +
    '<table><thead><tr><th>Part</th><th>What it shows</th></tr></thead><tbody>' +
    '<tr><td><b>The Banner</b></td><td>What needs you, polls out, and meetings booked this week. The ring shows how many of the last 30 days’ requests are booked.</td></tr>' +
    '<tr><td><b>Needs You</b></td><td>Times to approve, polls where no time works (your call), polls whose three follow-ups went unanswered, requests the Scheduler stopped on, and people to follow up with on requests run by hand.</td></tr>' +
    '<tr><td><b>Polls Out</b></td><td>Every poll waiting on guests: who has answered, how many times are on offer, and which follow-up they’re on.</td></tr>' +
    '<tr><td><b>Booked This Week</b></td><td>Meetings booked in the last seven days, automatic and by hand.</td></tr>' +
    '<tr><td><b>Emails This Week</b></td><td>Everything that reached scheduling@mismo.org, and how many became requests.</td></tr>' +
    '<tr><td><b>Scheduled</b></td><td>Every booked meeting still ahead, soonest first. This week’s are marked green.</td></tr>' +
    '<tr><td><b>Past Meetings</b></td><td>Meetings we scheduled that have already happened, newest first, for reference.</td></tr>' +
    '<tr><td><b>Couldn’t Schedule</b></td><td>Requests we tried and closed without a time, with the reason. Open one and press Bring it back to try again.</td></tr>' +
    '<tr><td><b>Team This Week</b></td><td>How much of each person’s day is free from 9 to 5 Eastern, from Outlook. Open Calendar for the half-hour view.</td></tr>' +
    '<tr><td><b>Incoming Email</b></td><td>The latest emails and what the Scheduler did with each one.</td></tr>' +
    '<tr><td><b>Latest Activity</b></td><td>Everything the Scheduler and the team did, newest first.</td></tr></tbody></table>' +
    '<div class="hnote"><b>Search</b> is at the top of the menu on the left. Type a person’s name or email, a company, a subject line, a MISMO teammate, or a word like booked or couldn’t; type two words to narrow it down (for example <i>kelly booked</i>). It finds requests, outside guests and the emails that came in.</div>'; } },
  { id: 'stats', k: '#2477b8', t: 'Statistics', h: function () { return '<h2>Statistics</h2><p class="lead">The Statistics tab on the left shows how scheduling is going. Pick Last 30 Days, Last 90 Days, This Year or All Time at the top; everything counts the requests started in that period. Hover over any bar for its number.</p>' +
    '<table><thead><tr><th>Part</th><th>What it shows</th></tr></thead><tbody>' +
    '<tr><td><b>The Six Figures</b></td><td>Requests, Booked, Couldn’t Schedule, In Progress, the average time from request to booked, and how long guests take to answer a poll.</td></tr>' +
    '<tr><td><b>Where Requests Ended Up</b></td><td>The split between booked, couldn’t schedule, still in progress and cancelled.</td></tr>' +
    '<tr><td><b>How Meetings Got Booked</b></td><td>Whether the times the person offered worked straight away, the first poll did it, more times were needed, or it was booked by hand.</td></tr>' +
    '<tr><td><b>Polls and Approvals</b></td><td>Guests asked and answered, follow-ups, reply times, and how long a found time waits for approval.</td></tr>' +
    '<tr><td><b>MISMO People in Meetings</b></td><td>For each person, meetings booked out of the requests they were on.</td></tr>' +
    '<tr><td><b>Organizations</b></td><td>The companies we schedule with most, from the guest’s company or email address.</td></tr>' +
    '<tr><td><b>Email to scheduling@mismo.org</b></td><td>What came in, how much became requests, and how often the Scheduler had to stop for a person.</td></tr></tbody></table>'; } },
  { id: 'hand', k: '#9fb3c8', t: 'Running One by Hand', h: function () { return '<h2>Running a Request Yourself</h2><p class="lead">Any request can be run by hand, and any request you start by hand can be given to the Scheduler.</p>' +
    HELP_STEPS([['Start a Request', 'Press Start a Request in the banner. Paste the email and press Read it for me, or fill it in.'], ['Pick Times', 'A calendar shows when the MISMO people are free in Outlook. Click the times to offer.'], ['Send the Poll', 'Each guest gets the same branded poll email from scheduling@mismo.org, with their own link.'], ['Book', 'Press Book under the time that works. Then send the invite and, if you like, Draft the confirmation email.']]) +
    '<ul><li><b>Take Over</b> on an automatic request stops the Scheduler emailing about it; you carry on by hand.</li><li><b>Let the Scheduler Handle It</b> (or <b>Hand Back to the Scheduler</b> on a Needs a Look) gives it back. It picks up within a few minutes.</li><li>Requests run by hand show in <b>Follow Up</b> when a guest is due a nudge, and add a follow-up task to the organizer’s Team HQ board.</li></ul>'; } },
  { id: 'emails', k: '#5fd39a', t: 'Emails It Sends', h: function () { return '<h2>Every Email, Who Gets It and When</h2><p class="lead">All of them come from <b>MISMO Scheduling</b> (scheduling@mismo.org) in the MISMO email frame. Replies come back to scheduling@mismo.org.</p>' +
    '<table><thead><tr><th>Email</th><th>Goes to</th><th>When</th></tr></thead><tbody>' +
    '<tr><td><b>We’re Working on Your Meeting Request</b></td><td>The person who asked</td><td>Only when nothing else reaches them straight away, for example while a time waits for approval.</td></tr>' +
    '<tr><td><b>Finding a Time for …</b></td><td>Each outside guest, the person who asked copied</td><td>When a poll goes out.</td></tr>' +
    '<tr><td><b>No Time Works Yet</b></td><td>Vanessa, Jonna copied</td><td>When everyone has answered and no time works for all of them. It lists the closest times. The Scheduler never sends a second set on its own: you Book a time, make someone optional, or press Send New Times.</td></tr>' +
    '<tr><td><b>New Times for …</b></td><td>Guests who already answered</td><td>Only when you press Send New Times (or change the meeting’s length).</td></tr>' +
    '<tr><td><b>Following Up / Still Hoping / One Last Note</b></td><td>A guest who hasn’t answered</td><td>Three warm follow-ups: a week after the poll, then a week apart. For a quick request (the email asks for dates within the next week, like “Monday”), they go at noon Eastern on each following working day instead. They stop when the guest answers, the meeting is booked, or you press Stop Follow-Ups.</td></tr>' +
    '<tr><td><b>Follow-Ups Finished</b></td><td>Vanessa, Jonna copied</td><td>When the third follow-up goes with no answer. Start them again for three more, leave them stopped, or close the request as Couldn’t Schedule.</td></tr>' +
    '<tr><td><b>Approve a Time</b></td><td>Vanessa, Jonna copied</td><td>When a time works for everyone.</td></tr>' +
    '<tr><td><b>Confirmed: … on …</b></td><td>The guests and the person who asked, MISMO attendees copied</td><td>Only if the calendar invitation couldn’t go by itself. Normally the invitation is the confirmation, so no separate email goes out.</td></tr>' +
    '<tr><td><b>Calendar Invitation</b></td><td>Everyone in the meeting</td><td>Once a time is approved: an Outlook invitation from scheduling@mismo.org with a MISMO Zoom room link (the membership room for membership meetings, otherwise info@mismo.org’s room). Guests can join any time. The Scheduler never books two meetings in the same room at once, or over that room account’s own meetings, since a room holds one meeting at a time.</td></tr>' +
    '<tr><td><b>Booked and Invited</b></td><td>Vanessa, Jonna copied</td><td>Once the invitation has gone. (If it can’t go by itself, this is <b>Booked, Send the Invite</b> instead, with a button that opens it in Outlook.)</td></tr>' +
    '<tr><td><b>Needs a Look</b></td><td>Vanessa, Jonna copied</td><td>When the Scheduler stops on a request.</td></tr>' +
    '<tr><td><b>Reply About …</b></td><td>Vanessa, Jonna copied</td><td>When someone replies to a Scheduler email. If the reply named times, it says what the Scheduler did with them.</td></tr>' +
    '<tr><td><b>Approve a New Time: …</b></td><td>Vanessa, Jonna copied</td><td>A guest asked to move a booked meeting and everyone from MISMO is free then. Approve it, or keep the current time.</td></tr>' +
    '<tr><td><b>Moved and Invited / Cancelled: …</b></td><td>Vanessa, Jonna copied</td><td>After a meeting is moved (old invitation cancelled, new one sent) or cancelled (Outlook’s cancellation sent). If Outlook couldn’t be updated, the subject says Update Outlook.</td></tr>' +
    '<tr><td><b>Check a Request: …</b></td><td>Vanessa, Jonna copied</td><td>When someone outside MISMO asks for a meeting that includes other outside people. Nothing goes out until one of you presses Send the Poll.</td></tr>' +
    '<tr><td><b>Scheduler Health: … Needs a Look</b> / <b>Working Again</b></td><td>Vanessa, Jonna copied</td><td>When a part of the Scheduler stops, and when it’s back. See Health Check.</td></tr>' +
    '<tr><td><b>Scheduler Health Check (date)</b></td><td>scheduling@mismo.org</td><td>Each working day at 8 AM Eastern, to test that email goes out and comes back. No action needed.</td></tr></tbody></table>' +
    '<p class="lead">Every email the Scheduler sent for a request is listed on that request, with whether it went out.</p>'; } },
  { id: 'look', k: '#f0b94a', t: 'When It Stops', h: function () { return '<h2>Needs a Look</h2><p class="lead">The Scheduler stops and emails Vanessa, with Jonna copied, rather than guess. The request shows the reason at the top. If no time can be found, press <b>Close as Couldn’t Schedule</b>: it moves to the Couldn’t Schedule list on the Dashboard for reference.</p>' +
    '<table><thead><tr><th>Why it stopped</th><th>What to do</th></tr></thead><tbody>' +
    '<tr><td>The email doesn’t say who from MISMO should be in the meeting</td><td>Edit details, tick the MISMO people, then Hand Back to the Scheduler.</td></tr>' +
    '<tr><td>The person who asked isn’t on the guest list</td><td>Edit details and add them as a guest, then hand it back.</td></tr>' +
    '<tr><td>It was read without Claude</td><td>Check the details are right, then hand it back. This only happens if Claude can’t be reached.</td></tr>' +
    '<tr><td>Three follow-ups went with no answer (shows in Needs You, but the poll stays open)</td><td>Press Start Again for three more, Leave Them Stopped, reach out yourself, or close it as Couldn’t Schedule.</td></tr>' +
    '<tr><td>No time in the next three weeks when everyone from MISMO is free</td><td>Free up a calendar or offer times by hand.</td></tr>' +
    '<tr><td>Outlook information missing for a working day</td><td>Tell Jonna: the Team Availability flow in Power Automate may have stopped.</td></tr>' +
    '<tr><td>An email failed five times</td><td>Tell Jonna: the Send Emails flow in Power Automate may need attention.</td></tr></tbody></table>'; } },
  { id: 'health', k: '#0f7b5c', t: 'Health Check', h: function () { return '<h2>Health Check</h2><p class="lead">The strip under the greeting on the Dashboard says whether every part of the Scheduler is working. Green means it is. If something stops, Vanessa gets an email (Jonna copied) once when it happens, once a day while it lasts, and once when it’s working again.</p>' +
    '<table><thead><tr><th>Check</th><th>How it knows</th><th>If it’s red</th></tr></thead><tbody>' +
    '<tr><td><b>Scheduler Robot</b></td><td>The robot runs at least every two hours on working days. The page notices when it hasn’t.</td><td>Open GitHub, scheduler-data, Actions. Check the workflow isn’t turned off and the account hasn’t run out of Actions minutes.</td></tr>' +
    '<tr><td><b>Email In and Out</b></td><td>At 8 AM Eastern each working day the robot sends a short test email to scheduling@mismo.org. It goes out through the Send Emails flow and comes back through the Email Watcher flow, so one test proves both. It should be back within two hours.</td><td>In Power Automate, check the run history of Scheduler - Send Emails and Scheduler - Email Watcher. A flow that was turned off or lost its sign-in shows there.</td></tr>' +
    '<tr><td><b>Outlook Availability</b></td><td>The Team Availability flow refreshes everyone’s Outlook every half hour.</td><td>Check Scheduler - Team Availability in Power Automate. Until it’s fresh, no new times are offered.</td></tr>' +
    '<tr><td><b>Sending Emails</b></td><td>Emails the Send Emails flow refused in the last day.</td><td>Check the flow’s run history. Each failed email is retried, and after five tries Vanessa is told which one.</td></tr>' +
    '<tr><td><b>Calendar Invitations</b></td><td>Invitations that failed this week.</td><td>Open the request and send the invite from Outlook with the buttons there.</td></tr>' +
    '<tr><td><b>Reading Emails (Claude)</b></td><td>Whether Claude answered the last time it was asked.</td><td>Usually a short outage. New requests go to a person meanwhile; check the ANTHROPIC_API_KEY secret if it lasts.</td></tr>' +
    '<tr><td><b>Data Storage</b></td><td>How full the data files are. Closed requests are archived automatically.</td><td>Tell Jonna.</td></tr>' +
    '<tr><td><b>Robot Runs Today</b></td><td>How many times the robot ran today. A normal day is 15–20.</td><td>Something is saving over and over, usually a Scheduler tab left open. Close Scheduler tabs and reopen one.</td></tr>' +
    '</tbody></table><p>The daily test email lands in the scheduling@ mailbox with the subject “Scheduler Health Check” and the date. You can delete it or leave it; it never becomes a request.</p>'; } },
  { id: 'behind', k: '#14486e', t: 'Behind the Scenes', h: function () { return '<h2>How It’s Put Together</h2><p class="lead">For Jonna, and for anyone looking after the Scheduler later.</p>' +
    '<table><thead><tr><th>Piece</th><th>What it does</th><th>Where it lives</th></tr></thead><tbody>' +
    '<tr><td><b>Send Invite</b></td><td>Puts the approved meeting on the scheduling@mismo.org calendar and sends everyone the Outlook invitation with the Zoom room link.</td><td>Power Automate, “Scheduler - Send Invite” (Jonna’s license). Its link is the FLOW_INVITE_URL secret on GitHub.</td></tr>' +
    '<tr><td><b>Email Watcher</b></td><td>Passes every new email in scheduling@mismo.org to the Scheduler on GitHub, within about five minutes.</td><td>Power Automate, “Scheduler - Email Watcher” (Jonna’s license). Needs its GitHub key in the Authorization header.</td></tr>' +
    '<tr><td><b>The Scheduler Robot</b></td><td>Reads emails with Claude, decides, keeps polls current, books, and sends the emails. Runs on every new email, every guest answer or save, and every two hours on working days.</td><td>GitHub: GitMISMO/scheduler-data, robot folder and the Actions tab.</td></tr>' +
    '<tr><td><b>Send Emails</b></td><td>Sends each email from scheduling@mismo.org.</td><td>Power Automate, “Scheduler - Send Emails”. Its address is the FLOW_SEND_URL secret.</td></tr>' +
    '<tr><td><b>Team Availability</b></td><td>Copies everyone’s free/busy from Outlook every half hour, plus info@mismo.org’s, for the Zoom room. Free or busy only, never meeting names.</td><td>Power Automate, “Scheduler - Team Availability”.</td></tr>' +
    '<tr><td><b>The Zoom Room</b></td><td>Every Scheduler Zoom meeting uses info@mismo.org’s Personal Meeting Room (meeting ID 282 517 5426, mba-org.zoom.us/j/2825175426), set so guests can join any time.</td><td>Zoom, signed in as info@mismo.org. If MBA ever grants a Zoom app, adding the ZOOM_ secrets gives each meeting its own link instead.</td></tr>' +
    '<tr><td><b>Workgroup Schedule</b></td><td>Keeps the Zoom room clear of every active workgroup meeting on the Meeting Trackers schedule, for the next four weeks.</td><td>Read from GitMISMO/meeting-trackers-data with the MT_DATA_TOKEN secret, a read-only key that <b>expires Nov 5, 2027</b> and then needs renewing.</td></tr>' +
    '<tr><td><b>Claude</b></td><td>Reads each email. Picks the newest Sonnet model on MISMO’s account.</td><td>The ANTHROPIC_API_KEY secret, billed to MISMO’s API credit (a penny or two per email).</td></tr>' +
    '<tr><td><b>This Page and the Guest Page</b></td><td>The Dashboard, and the page guests open from their link.</td><td>GitHub: GitMISMO/scheduler, at resources.mismo.org/scheduler/.</td></tr></tbody></table>' +
    '<h3>Good to Know</h3><ul><li><b>Leave new emails in scheduling@mismo.org for about five minutes.</b> The Email Watcher checks every few minutes; an email cleared before then is never seen.</li><li>If something seems stuck, open the Actions tab in GitMISMO/scheduler-data. Each run says what it did, and Run workflow starts one by hand.</li><li>Changes go through pull requests that Jonna merges.</li><li>Guest links are switched on in the site’s settings file (projects.json) with guestLinks.</li></ul>'; } },
  { id: 'faq', k: '#74bfeb', t: 'Questions', h: function () { return '<h2>Questions</h2><p class="lead">Anything else: ask Jonna Critchley.</p>' + HELP_FAQ([
    ['Can I forward a request from my own inbox?', 'Yes. Forward it to scheduling@mismo.org and say who should attend. Your Outlook can also do it for you with a rule.'],
    ['Does the Scheduler send the calendar invite?', 'Yes. Once a time is approved, the Outlook invitation goes out from scheduling@mismo.org with the Zoom room link, and the meeting sits on the scheduling@mismo.org calendar. If it can’t, Vanessa gets a button to send it from Outlook.'],
    ['Which Zoom link do meetings use?', 'The MISMO Zoom room: info@mismo.org’s Personal Meeting Room, mba-org.zoom.us/j/2825175426. Guests can join without anyone hosting.'],
    ['How do I move or cancel a booked meeting?', 'Open the request and press <b>Move Meeting</b> (pick a day and time; it shows who from MISMO is free) or <b>Cancel Meeting</b>. The Scheduler cancels the old Outlook invitation and sends a new one, or sends everyone Outlook’s cancellation. Guests can also reply to their invitation with a time that suits them: if everyone from MISMO is free then, the move waits for Vanessa or Jonna to approve. Meetings booked before November 7 can be moved too, but their old invitation has to be deleted in Outlook by hand.'],
    ['Where do old requests go?', 'A month after the meeting (or a month after a request was closed without one), the Scheduler moves it to a monthly archive so the working file stays small. Archived requests still show in Past Meetings, Couldn’t Schedule, Statistics and search, marked Archived and read-only. Emails in the scheduling inbox are trimmed to the newest message after two weeks and cleared after 120 days; the request keeps its own copy of what was asked.'],
    ['What if a guest emails their times instead of using the link?', 'The Scheduler reads the reply. Times on the poll count as their answer; a new time they suggest is held for approval (or added to the poll when there are other guests) if everyone from MISMO is free. Vanessa gets a Reply About email saying what it did. Vague replies change nothing.'],
    ['What if someone from MISMO is out of office?', 'If they’re out for all the days asked for, the Scheduler doesn’t wait for them. It goes ahead with the others from MISMO and sends them the invitation as optional. The request shows them under Optional from MISMO. It never drops the person who asked, or the only person from MISMO on the meeting. If they’re out for only part of the time, it simply offers the days they’re back.'],
    ['Can a meeting be an hour?', 'Yes. If the email asks for an hour, the Scheduler offers hour-long times. To change a request already under way, press Edit details and change the length; fresh times at the new length go out.'],
    ['Can someone be optional?', 'Yes. Press Make optional next to them under Outside guests. Times then only have to work for everyone else, and they get the invite as optional.'],
    ['Can I book before everyone has answered?', 'Yes. Press Book under a time in the grid. On an automatic request that books it straight away and sends the invitation.'],
    ['What time zone are times in?', 'MISMO always works in Eastern time. Guests see times in their own zone and can change it. On this page, pick the zone in the Calendar.'],
    ['Can I change a meeting’s name before it’s confirmed?', 'Yes. Open the request and press Edit details. The name is used in every email after that.'],
    ['Why didn’t someone get the “working on it” email?', 'If the poll or a confirmation reached them straight away, that is their acknowledgment. They only get it when there is a wait.'],
    ['Can two requests book the same person at the same time?', 'No. A booked time, and a time waiting for approval, counts as busy for every other request straight away, before Outlook catches up.'],
    ['What if a guest says none of the times work?', 'Those times come off. When no time is left that works for everyone, Vanessa and Jonna get No Time Works Yet and decide: book the closest, make someone optional, or send new times. No second poll goes out on its own.'],
    ['Is anyone’s calendar shown to guests?', 'No. Guests only see times when everyone from MISMO is free. Meeting names never leave Outlook.']]); } }
];
/* ---------------- Statistics ---------------- */
var STAT_RANGES = [['30', 'Last 30 Days'], ['90', 'Last 90 Days'], ['year', 'This Year'], ['all', 'All Time']];
function statFrom(k) {
  var now = Date.now();
  if (k === '30') return now - 30 * 864e5;
  if (k === '90') return now - 90 * 864e5;
  if (k === 'year') return at(todayISO(ET).slice(0, 4) + '-01-01', 0, ET);
  return 0;
}
function dur(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  var hr = ms / 36e5;
  if (hr < 1) return Math.max(1, Math.round(ms / 6e4)) + ' min';
  if (hr < 48) return (hr < 10 ? Math.round(hr * 10) / 10 : Math.round(hr)) + ' hrs';
  return Math.round(hr / 24 * 10) / 10 + ' days';
}
function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
function pctOf(n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; }
var STTIP = null;
function stTip(node, text) {
  node.setAttribute('aria-label', text); node.tabIndex = 0;
  var show = function (x, y) { if (!STTIP) { STTIP = el('div', 'sttip'); document.body.appendChild(STTIP); } STTIP.textContent = text; STTIP.hidden = false; var w = STTIP.offsetWidth; STTIP.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 12)) + 'px'; STTIP.style.top = (y + 16) + 'px'; };
  var hide = function () { if (STTIP) STTIP.hidden = true; };
  node.addEventListener('mousemove', function (e) { show(e.clientX, e.clientY); });
  node.addEventListener('mouseleave', hide);
  node.addEventListener('focus', function () { var r = node.getBoundingClientRect(); show(r.left, r.bottom - 10); });
  node.addEventListener('blur', hide);
}
/* one bar split into parts, with the key underneath carrying every number */
function mixPanel(title, hint, parts, empty) {
  var pn = dashPanel(title, hint, '', null), tot = parts.reduce(function (a, x) { return a + x.v; }, 0);
  if (!tot) { pn.p.appendChild(el('div', 'empty', empty)); return pn.p; }
  var bar = el('div', 'mixbar'); bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', title + ': ' + parts.map(function (x) { return x.t + ' ' + x.v; }).join(', '));
  parts.forEach(function (x) { if (!x.v) return; var i = el('i'); i.style.flex = x.v + ' 1 0'; i.style.background = x.k; stTip(i, x.t + ': ' + x.v + ' (' + pctOf(x.v, tot) + ')'); bar.appendChild(i); });
  var key = el('div', 'mixkey');
  parts.forEach(function (x) { key.appendChild(el('div', null, '<i style="background:' + x.k + '"></i>' + esc(x.t) + '<b>' + x.v + '<em>' + pctOf(x.v, tot) + '</em></b>')); });
  pn.p.appendChild(bar); pn.p.appendChild(key);
  return pn.p;
}
/* one bar per name, longest first; the number sits beside each bar */
function barsPanel(title, hint, rows, empty, note) {
  var pn = dashPanel(title, hint, '', null);
  if (!rows.length) { pn.p.appendChild(el('div', 'empty', empty)); return pn.p; }
  var max = Math.max.apply(null, rows.map(function (r) { return r.v; })) || 1, box = el('div', 'hbars');
  rows.forEach(function (r) {
    var row = el('div', 'hbar', '<span class="t" title="' + esc(r.t) + '">' + esc(r.t) + '</span><span class="tr">' + (r.v ? '<i style="width:' + Math.max(1, 100 * r.v / max) + '%"></i>' : '') + '</span><b>' + r.v + (r.x ? ' <em>' + esc(r.x) + '</em>' : '') + '</b>');
    stTip($('.tr', row), r.t + ': ' + (r.tip || r.v));
    box.appendChild(row);
  });
  pn.p.appendChild(box);
  if (note) pn.p.appendChild(el('div', 'small muted', note)).style.cssText = 'padding:0 16px 14px';
  return pn.p;
}
function figsPanel(title, hint, rows) {
  var pn = dashPanel(title, hint, '', null), f = el('div', 'figs');
  rows.forEach(function (r) { var d = el('div', null, '<span>' + esc(r[0]) + '</span><b>' + esc(String(r[1])) + '</b>'); if (r[2]) d.title = r[2]; f.appendChild(d); });
  pn.p.appendChild(f); return pn.p;
}
var FREEMAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|msn|proton|protonmail)\./;
function orgOf(g) {
  if (g.org && String(g.org).trim()) return String(g.org).trim();
  var d = String(g.email || '').split('@')[1] || '';
  if (!d) return 'Unknown';
  return FREEMAIL.test(d) ? 'Personal email' : d;
}
function viewStats(app) {
  var rk = STATE.statRange || lsGet('statRange', '90'), from = statFrom(rk), now = Date.now();
  var rangeName = (STAT_RANGES.find(function (x) { return x[0] === rk; }) || STAT_RANGES[1])[1];
  var head = el('div', 'stathead');
  head.appendChild(el('div', null, '<h1>Statistics</h1><p>Requests started in the period, and what happened to them.</p>'));
  head.appendChild(seg(STAT_RANGES, rk, function (v) { STATE.statRange = v; lsSet('statRange', v); render({ full: true }); }));
  app.appendChild(head);

  var reqs = allReqs().filter(function (r) { return (r.createdAt || 0) >= from; });
  var booked = reqs.filter(function (r) { return r.status === 'booked'; });
  var unsch = reqs.filter(couldntSchedule);
  var cancelled = reqs.filter(function (r) { return r.status === 'cancelled' && !couldntSchedule(r); });
  var open = reqs.filter(function (r) { return r.status !== 'booked' && r.status !== 'cancelled'; });
  var upcoming = booked.filter(function (r) { return !isPast(r); }).length;
  var toBook = booked.filter(function (r) { return r.bookedAt && r.createdAt; }).map(function (r) { return r.bookedAt - r.createdAt; });
  var guests = [], replies = [], reminders = 0, afterReminder = 0;
  reqs.forEach(function (r) { (r.guests || []).forEach(function (g) {
    if (!g.sentAt) return; guests.push(g); reminders += (g.reminders || []).length + (g.followUps || []).length;
    if (g.answer && g.answer.at) { replies.push(Math.max(0, g.answer.at - g.sentAt)); if ((g.reminders || []).concat(g.followUps || []).some(function (t) { return t < g.answer.at; })) afterReminder++; }
  }); });
  var answered = guests.filter(function (g) { return g.answer; }).length;
  var auto = booked.filter(function (r) { return r.robot && r.robot.auto; }).length;

  /* ---- the six figures ---- */
  var tiles = el('div', 'stiles');
  [['var(--c1)', 'Requests', reqs.length, rangeName.toLowerCase()],
   ['var(--c3)', 'Booked', booked.length, pctOf(booked.length, reqs.length - cancelled.length) + ' of requests · ' + upcoming + ' still ahead'],
   ['var(--c2)', 'Couldn’t Schedule', unsch.length, pctOf(unsch.length, reqs.length - cancelled.length) + ' of requests'],
   ['var(--c4)', 'In Progress', open.length, open.filter(needsYou).length + ' need you'],
   ['var(--c1)', 'Time to Book', dur(avg(toBook)), 'on average, request to booked'],
   ['var(--c3)', 'Guest Reply Time', dur(avg(replies)), 'on average, poll to answer']
  ].forEach(function (t) { var d = el('div', 'stile', '<small>' + esc(t[1]) + '</small><b>' + esc(String(t[2])) + '</b><span>' + esc(t[3]) + '</span>'); d.style.setProperty('--k', t[0]); tiles.appendChild(d); });
  app.appendChild(tiles);

  /* three rows of two, so each pair lines up and no column runs short */
  var L, R, row = function () { var g = el('div', 'hgrid stgrid'); L = el('div', 'hside'); R = el('div', 'hside'); g.appendChild(L); g.appendChild(R); app.appendChild(g); };
  row();

  /* ---- where requests ended up ---- */
  L.appendChild(mixPanel('Where Requests Ended Up', plural(reqs.length, 'request', 'requests'), [
    { t: 'Booked', v: booked.length, k: 'var(--c1)' }, { t: 'Couldn’t Schedule', v: unsch.length, k: 'var(--c2)' },
    { t: 'In Progress', v: open.length, k: 'var(--c3)' }, { t: 'Cancelled', v: cancelled.length, k: 'var(--c4)' }
  ], 'No requests started in this period.'));

  /* ---- how the booked ones got booked ---- */
  var how = { matched: 0, poll1: 0, pollMore: 0, hand: 0 };
  booked.forEach(function (r) {
    var R0 = r.robot || {};
    if (!R0.auto) how.hand++;
    else if (!(r.guests || []).some(function (g) { return g.sentAt; })) how.matched++;
    else if ((R0.round || 1) > 1) how.pollMore++;
    else how.poll1++;
  });
  R.appendChild(mixPanel('How Meetings Got Booked', auto ? pctOf(auto, booked.length) + ' automatic' : '', [
    { t: 'Their times worked', v: how.matched, k: 'var(--c1)' }, { t: 'Poll, first set of times', v: how.poll1, k: 'var(--c2)' },
    { t: 'Poll, more times needed', v: how.pollMore, k: 'var(--c3)' }, { t: 'Booked by hand', v: how.hand, k: 'var(--c4)' }
  ], 'Nothing booked in this period yet.'));

  row();
  /* ---- polls (bottom row, left) ---- */
  var approvals = reqs.filter(function (r) { return r.robot && r.robot.approved && r.robot.proposed && r.robot.approved.at && r.robot.proposed.at; }).map(function (r) { return Math.max(0, r.robot.approved.at - r.robot.proposed.at); });
  var pollsP = figsPanel('Polls and Approvals', '', [
    ['Polls sent', reqs.filter(function (r) { return (r.guests || []).some(function (g) { return g.sentAt; }); }).length],
    ['Guests asked', guests.length],
    ['Guests who answered', answered + ' (' + pctOf(answered, guests.length) + ')'],
    ['Follow-ups sent', reminders],
    ['Answered after a follow-up', afterReminder],
    ['Average reply time', dur(avg(replies))],
    ['Times approved', approvals.length],
    ['Average wait for approval', dur(avg(approvals)), 'From the Scheduler finding a time to Vanessa or Jonna approving it']
  ]);

  /* ---- MISMO people ---- */
  var ppl = TEAM.people.map(function (pp) {
    var inReq = reqs.filter(function (r) { return (r.internal || []).indexOf(pp.id) >= 0; });
    var b = inReq.filter(function (r) { return r.status === 'booked'; }).length;
    return { t: pp.name, v: b, x: 'of ' + inReq.length, tip: b + ' booked of ' + inReq.length + ' requests' , n: inReq.length };
  }).filter(function (x) { return x.n; }).sort(function (a, b) { return b.v - a.v || b.n - a.n; });
  L.appendChild(barsPanel('MISMO People in Meetings', 'booked of requested', ppl, 'No MISMO people on requests in this period.'));

  /* ---- organizations ---- */
  var orgs = {};
  reqs.forEach(function (r) { var seen = {}; (r.guests || []).forEach(function (g) { var o = orgOf(g); if (seen[o]) return; seen[o] = 1; orgs[o] = orgs[o] || { t: o, v: 0, b: 0 }; orgs[o].v++; if (r.status === 'booked') orgs[o].b++; }); });
  var orgRows = Object.keys(orgs).map(function (k) { var o = orgs[k]; return { t: o.t, v: o.v, x: o.b + ' booked', tip: o.v + ' requests, ' + o.b + ' booked' }; }).sort(function (a, b) { return b.v - a.v || a.t.localeCompare(b.t); });
  var more = orgRows.length > 8 ? orgRows.length - 8 : 0;
  R.appendChild(barsPanel('Organizations', 'requests', orgRows.slice(0, 8), 'No outside guests on requests in this period.', more ? '+ ' + plural(more, 'more organization', 'more organizations') + '. Search finds any of them by name.' : ''));

  row(); L.appendChild(pollsP);
  /* ---- email intake ---- */
  var mail = inboxItems().filter(function (x) { return (x.receivedAt || 0) >= from && !isHealthMail(x); });
  var became = mail.filter(function (x) { return x.status === 'started' || allReqs().some(function (r) { return r.inboxId === x.id; }); }).length;
  var robotMade = reqs.filter(function (r) { return r.createdBy === 'Scheduler' || (r.robot && r.robot.auto && r.robot.readBy); });
  var byClaude = robotMade.filter(function (r) { return r.robot && r.robot.readBy === 'claude'; }).length;
  var stopped = reqs.filter(function (r) { return r.robot && (r.robot.stage === 'person' || r.robot.why); }).length;
  R.appendChild(figsPanel('Email to scheduling@mismo.org', '', [
    ['Emails received', mail.length],
    ['Became requests', became + ' (' + pctOf(became, mail.length) + ')'],
    ['Set aside', mail.filter(function (x) { return x.status === 'dismissed'; }).length],
    ['Started by the Scheduler', robotMade.length],
    ['Read by Claude', byClaude + ' (' + pctOf(byClaude, robotMade.length) + ')'],
    ['Stopped for a person', stopped],
    ['Asked by MISMO staff', reqs.filter(function (r) { return /@mismo\.org$/i.test(r.askedByEmail || ''); }).length],
    ['Asked by outside people', reqs.filter(function (r) { return r.askedByEmail && !/@mismo\.org$/i.test(r.askedByEmail); }).length]
  ]));
  /* ---- reliability: the health check's day-by-day record ---- */
  var hist = ((HEALTH.data && HEALTH.data.history) || []).filter(function (d) { return d.date >= parts(from, ET).iso; });
  if (hist.length) {
    var green = hist.filter(function (d) { return d.worst === 'ok'; }).length, bad = hist.filter(function (d) { return d.worst === 'down'; });
    var loops = hist.filter(function (d) { return d.loop != null; }), loopOk = loops.filter(function (d) { return d.loop; }).length;
    var runs = hist.filter(function (d) { return d.runs != null; });
    var rows = [
      ['Days recorded', hist.length],
      ['All working', green + ' (' + pctOf(green, hist.length) + ')'],
      ['Something stopped', bad.length + (bad.length ? ': ' + bad.slice(-3).map(function (d) { return fmtDay(at(d.date, 720, ET), ET) + ' (' + (d.issues || []).join(', ') + ')'; }).join('; ') : '')],
      ['Daily email test passed', loops.length ? loopOk + ' of ' + loops.length : 'Not run yet'],
      ['Robot runs a day', runs.length ? Math.round(runs.reduce(function (a, d) { return a + d.runs; }, 0) / runs.length) + ' on average, ' + Math.max.apply(null, runs.map(function (d) { return d.runs; })) + ' at most' : '—'],
      ['Robot last ran', HEALTH.data && HEALTH.data.lastRunAt ? whenAgo(HEALTH.data.lastRunAt) : '—']
    ];
    row(); L.appendChild(figsPanel('Reliability', 'from the health check', rows));
    var H = HEALTH.data || {}, st = (H.checks || {}).storage || {};
    R.appendChild(figsPanel('What the Scheduler Keeps', 'right now', [
      ['Requests in the working file', Object.keys(DB.server.docs || {}).length],
      ['Archived requests', Object.keys(ARCH.docs).length],
      ['Emails in the inbox file', inboxItems().length],
      ['Data storage', st.msg || '—'],
      ['Claude model', H.claudeModel ? H.claudeModel + (H.modelPinned ? ' (pinned)' : '') : '—'],
      ['Guest details kept', 'Two years, then removed from the archive']
    ]));
  }
}

function viewHelp(app) {
  var head = el('div', 'pagehead'); head.innerHTML = '<div class="grow"><h1>Help</h1><p>How the Scheduler works, step by step. Questions: Jonna Critchley.</p></div>';
  app.appendChild(head);
  var cur = STATE.help || 'overview', grid = el('div', 'helpgrid'), nav = el('nav', 'helpnav'), body = el('div', 'panel helpbody');
  nav.setAttribute('aria-label', 'Help topics');
  HELP.forEach(function (t) {
    var b = el('button', null, '<i style="--k:' + t.k + '"></i>' + esc(t.t)); b.type = 'button';
    if (t.id === cur) b.setAttribute('aria-current', 'true');
    b.onclick = function () { STATE.help = t.id; render({ full: true }); };
    nav.appendChild(b);
  });
  body.innerHTML = (HELP.filter(function (t) { return t.id === cur; })[0] || HELP[0]).h();
  grid.appendChild(nav); grid.appendChild(body); app.appendChild(grid);
}

/* ======================================================================
   PREVIEW DATA (only when not on resources.mismo.org)
   ====================================================================== */
function etAt(iso, hhmm) { var p = hhmm.split(':'); return at(iso, (+p[0]) * 60 + (+p[1]), ET); }
function previewRequests() {
  var M = 60000;
  var vq = { id: 'vq7m2k9p4a', title: 'Sample: MISMO Membership Info (made up)', purpose: 'Walk a made-up prospect through MISMO membership benefits.', duration: 30, where: 'Zoom', followDays: 3,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Kelly Bradshaw', askedByEmail: 'kbradshaw@mismo.org', inboxId: 'mkelly0001', createdAt: etAt('2026-10-27', '10:15'), createdBy: 'Vanessa Rios', internal: ['kelly', 'amy'],
    slots: [['2026-11-03', '10:00'], ['2026-11-03', '14:00'], ['2026-11-04', '11:00'], ['2026-11-05', '10:00'], ['2026-11-05', '15:00']].map(function (x, i) { var s = etAt(x[0], x[1]); return { id: 'v' + i, s: s, e: s + 30 * M }; }),
    guests: [
      { id: 'g1', code: 'preview-riley', name: 'Riley Chen', email: 'riley.chen@example.com', org: 'Example Title Co', sentAt: etAt('2026-10-27', '11:05'), answer: { yes: ['v0', 'v2', 'v3'], maybe: [], note: 'Mornings are best for me.', at: etAt('2026-10-28', '09:40'), via: 'link' } },
      { id: 'g2', code: 'preview-jordan', name: 'Jordan Park', email: 'jordan.park@example.com', org: 'Example Title Co', sentAt: etAt('2026-10-27', '11:05') }
    ],
    source: 'From: Bradshaw, Kelly <kbradshaw@mismo.org>\nTo: Critchley, Jonna; Rios, Vanessa\nCc: Moses, Amy\nSubject: Sample (made up): FW: Example Title Co - MISMO membership intro\n\nJC and VR,\n\nCould we get help scheduling a meeting \u201cMISMO Membership Info\u201d with:\n1. Kelly\n2. Amy\n3. Riley Chen\n4. Jordan Park\n\nFrom: Riley Chen <riley.chen@example.com>\nSent: Tuesday, October 27, 2026 9:14 AM\nTo: Bradshaw, Kelly <kbradshaw@mismo.org>\nCc: Jordan Park <jordan.park@example.com>\nSubject: Example Title Co - MISMO membership intro\n\nHi Kelly, we would like to learn more about MISMO membership. Jordan and I are open most mornings next week. (This is a made-up example.)',
    log: [{ at: etAt('2026-10-27', '10:15'), by: 'Vanessa Rios', what: 'Started the request' }, { at: etAt('2026-10-27', '10:22'), by: 'Vanessa Rios', what: 'Offered 5 times' }, { at: etAt('2026-10-27', '11:05'), by: 'Vanessa Rios', what: 'Asked Riley Chen, Jordan Park' }, { at: etAt('2026-10-28', '09:40'), by: 'Riley Chen', what: 'Answered through their link' }],
    updatedAt: etAt('2026-10-28', '09:40') };
  var sd = { id: 'sd4n8q2r6t', title: 'Sample: Product Demo (made up)', purpose: 'A made-up demo for Casey Morgan of Example Servicing, with Jonathan and Perry.', duration: 30, where: 'Zoom', followDays: 3,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Jonathan Kearns', createdAt: etAt('2026-10-26', '13:00'), createdBy: 'Vanessa Rios', internal: ['jonathan', 'perry'],
    slots: [['2026-11-02', '13:00'], ['2026-11-03', '15:00'], ['2026-11-04', '10:00']].map(function (x, i) { var s = etAt(x[0], x[1]); return { id: 's' + i, s: s, e: s + 30 * M }; }),
    guests: [{ id: 'g3', code: 'preview-casey', name: 'Casey Morgan', email: 'casey.morgan@example.com', org: 'Example Servicing', sentAt: etAt('2026-10-26', '13:30'), answer: { yes: ['s1', 's2'], maybe: [], at: etAt('2026-10-28', '14:10'), via: 'manual', by: 'Vanessa Rios', note: 'Tuesday afternoon is best.' } }],
    status: 'booked', chosen: 's1', bookedAt: etAt('2026-10-28', '16:56'),
    log: [{ at: etAt('2026-10-26', '13:00'), by: 'Vanessa Rios', what: 'Started the request' }, { at: etAt('2026-10-28', '14:10'), by: 'Vanessa Rios', what: 'Entered the answer from Casey Morgan' }, { at: etAt('2026-10-28', '16:56'), by: 'Vanessa Rios', what: 'Booked for Tuesday, November 3, 3:00–3:30 PM EST' }],
    updatedAt: etAt('2026-10-28', '16:56') };
  var ex = { id: 'ex5c3w8y1z', title: 'Sample: Quarterly Check-in (made up)', purpose: 'A made-up request so you can see what an overdue follow-up looks like.', duration: 45, where: 'Microsoft Teams', followDays: 3,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', createdAt: etAt('2026-10-21', '15:00'), createdBy: 'Vanessa Rios', internal: ['jonna', 'brian'],
    slots: [['2026-11-06', '10:00'], ['2026-11-09', '14:00'], ['2026-11-10', '11:00']].map(function (x, i) { var s = etAt(x[0], x[1]); return { id: 'e' + i, s: s, e: s + 45 * M }; }),
    guests: [{ id: 'g4', code: 'preview-pat', name: 'Pat Example', email: 'pat@example.com', org: 'Example Lending', sentAt: etAt('2026-10-22', '10:00') }],
    log: [{ at: etAt('2026-10-22', '10:00'), by: 'Vanessa Rios', what: 'Asked Pat Example' }], updatedAt: etAt('2026-10-22', '10:00') };
  var now = Date.now(), d1 = bizDaysAhead(3);
  var au = { id: 'au8k2m4p6q', title: 'Sample: Membership Info, Example Lending (made up)', purpose: 'A made-up request the Scheduler is running on its own.', duration: 30, where: 'Zoom', followDays: 2,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Sam Rivera', askedByEmail: 'sam.rivera@example.com', createdAt: now - 26 * 36e5, createdBy: 'Scheduler', internal: ['kelly'],
    slots: [[d1[0], '10:00'], [d1[0], '14:00'], [d1[1], '10:30'], [d1[2], '13:30']].map(function (x, i) { var s = etAt(x[0], x[1]); return { id: 'a' + i, s: s, e: s + 30 * M, added: now - 26 * 36e5 }; }),
    guests: [{ id: 'g5', code: 'preview-sam', name: 'Sam Rivera', email: 'sam.rivera@example.com', org: 'Example Lending', sentAt: now - 26 * 36e5, reminders: [now - 2 * 36e5] }],
    robot: { auto: true, stage: 'polling', round: 1, readBy: 'claude', requester: { name: 'Sam Rivera', email: 'sam.rivera@example.com' },
      offered: [{ s: etAt(d1[0], '09:00'), e: etAt(d1[0], '09:30') }], dropped: [{ id: 'a9', s: etAt(d1[1], '15:00'), e: etAt(d1[1], '15:30'), why: 'someone at MISMO is now busy' }] },
    log: [{ at: now - 26 * 36e5, by: 'Scheduler', what: 'Started from an email to scheduling@mismo.org (read by Claude); 1 suggested time' }, { at: now - 26 * 36e5, by: 'Scheduler', what: 'None of the times they offered work for everyone at MISMO; poll sent to Sam Rivera with 5 times' }],
    updatedAt: now - 2 * 36e5 };
  var lk = { id: 'lk3n5p7r9s', title: 'Sample: Intro Call (made up)', purpose: 'A made-up request the Scheduler handed to a person.', duration: 30, where: 'Zoom', followDays: 2,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Alex Kim', askedByEmail: 'alex.kim@example.com', createdAt: now - 3 * 36e5, createdBy: 'Scheduler', internal: [], slots: [],
    guests: [{ id: 'g6', code: 'preview-alex', name: 'Alex Kim', email: 'alex.kim@example.com', org: 'Example Bank' }],
    robot: { auto: true, stage: 'person', why: 'the email doesn’t say who from MISMO should be in the meeting', readBy: 'claude', acked: now - 3 * 36e5, requester: { name: 'Alex Kim', email: 'alex.kim@example.com' }, offered: [] },
    log: [{ at: now - 3 * 36e5, by: 'Scheduler', what: 'Handed to a person: the email doesn’t say who from MISMO should be in the meeting' }], updatedAt: now - 3 * 36e5 };
  var apS = etAt(d1[1], '11:00');
  var ap = { id: 'ap2b4d6f8h', title: 'Sample: Data Standards Briefing, Example Credit Union (made up)', purpose: 'A made-up request where the Scheduler found a time and is waiting for approval.', duration: 30, where: 'Zoom', followDays: 2,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Morgan Lee', askedByEmail: 'morgan.lee@example.com', createdAt: now - 40 * 6e4, createdBy: 'Scheduler', internal: ['jonathan', 'perry'],
    slots: [{ id: 'p0', s: apS, e: apS + 30 * M, added: now - 40 * 6e4 }],
    guests: [{ id: 'g7', code: 'preview-morgan', name: 'Morgan Lee', email: 'morgan.lee@example.com', org: 'Example Credit Union' }],
    robot: { auto: true, stage: 'approve', readBy: 'claude', acked: now - 40 * 6e4, requester: { name: 'Morgan Lee', email: 'morgan.lee@example.com' }, offered: [{ s: apS - 60 * M, e: apS + 60 * M }],
      proposed: { id: 'p0', s: apS, e: apS + 30 * M, how: 'one of the times Morgan Lee offered, and everyone from MISMO is free', at: now - 40 * 6e4 } },
    log: [{ at: now - 40 * 6e4, by: 'Scheduler', what: 'Found a time — waiting for approval' }], updatedAt: now - 40 * 6e4 };
  var fuS = etAt(bizDaysAhead(6)[5], '13:00');
  var fu = { id: 'fu6h1j3k5m', title: 'Sample: eMortgage Roundtable Prep (made up)', purpose: 'A made-up booked meeting that’s still ahead.', duration: 30, where: 'Zoom', followDays: 2,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Taylor Brooks', askedByEmail: 'taylor.brooks@example.com', createdAt: now - 5 * 864e5, createdBy: 'Scheduler', internal: ['amy', 'jonna'],
    slots: [{ id: 'f0', s: fuS, e: fuS + 30 * M }], guests: [{ id: 'g8', code: 'preview-taylor', name: 'Taylor Brooks', email: 'taylor.brooks@example.com', org: 'Example Lending' }],
    status: 'booked', chosen: 'f0', bookedAt: now - 4 * 864e5, robot: { auto: true, stage: 'booked', readBy: 'claude', invite: { state: 'sent', at: now - 4 * 864e5, zoom: { id: '81234567890', joinUrl: 'https://us02web.zoom.us/j/81234567890?pwd=example', passcode: '482913' } }, requester: { name: 'Taylor Brooks', email: 'taylor.brooks@example.com' }, offered: [] },
    log: [{ at: now - 4 * 864e5, by: 'Scheduler', what: 'Booked after Jonna approved' }], updatedAt: now - 4 * 864e5 };
  var un = { id: 'un9p2r4t6v', title: 'Sample: Vendor Intro, Example Tech (made up)', purpose: 'A made-up request we tried and couldn’t schedule.', duration: 30, where: 'Zoom', followDays: 2,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Drew Patel', askedByEmail: 'drew.patel@example.com', createdAt: now - 12 * 864e5, createdBy: 'Scheduler', internal: ['brian'], slots: [],
    guests: [{ id: 'g9', code: 'preview-drew', name: 'Drew Patel', email: 'drew.patel@example.com', org: 'Example Tech' }],
    status: 'cancelled', closed: 'unscheduled', closedAt: now - 2 * 864e5, closedBy: 'Vanessa Rios',
    robot: { auto: true, stage: 'person', round: 3, why: 'three sets of times went out and none worked for everyone', readBy: 'claude', requester: { name: 'Drew Patel', email: 'drew.patel@example.com' }, offered: [] },
    log: [{ at: now - 2 * 864e5, by: 'Vanessa Rios', what: 'Closed: couldn’t schedule' }], updatedAt: now - 2 * 864e5 };
  var fdS = bizDaysAhead(4);
  var fd = { id: 'fd3k5m7p9r', title: 'Sample: Data Exchange Intro, Example Bank (made up)', purpose: 'A made-up poll where three follow-ups went with no answer.', duration: 30, where: 'Zoom', followDays: 2,
    owner: 'vrios@mismo.org', ownerName: 'Vanessa Rios', askedBy: 'Chris Wong', askedByEmail: 'chris.wong@example.com', createdAt: now - 22 * 864e5, createdBy: 'Scheduler', internal: ['jonathan'],
    slots: [[fdS[1], '10:00'], [fdS[2], '14:00'], [fdS[3], '11:00']].map(function (x, i) { var s = etAt(x[0], x[1]); return { id: 'd' + i, s: s, e: s + 30 * M, added: now - 2 * 864e5 }; }),
    guests: [{ id: 'g10', code: 'preview-chris', name: 'Chris Wong', email: 'chris.wong@example.com', org: 'Example Bank', sentAt: now - 22 * 864e5, reminders: [now - 15 * 864e5, now - 8 * 864e5, now - 864e5] }],
    robot: { auto: true, stage: 'polling', round: 3, readBy: 'claude', followDone: now - 864e5, requester: { name: 'Chris Wong', email: 'chris.wong@example.com' }, offered: [] },
    log: [{ at: now - 864e5, by: 'Scheduler', what: 'Three follow-ups sent with no answer from Chris Wong; Vanessa and Jonna told' }], updatedAt: now - 864e5 };
  return [ap, au, lk, vq, sd, ex, fu, un, fd];
}
function previewSent() {
  var now = Date.now();
  return {
    'ack-au8k2m4p6q': { at: now - 26 * 36e5, ok: true, to: ['sam.rivera@example.com'], cc: [], subject: 'We’re Working on Your Meeting Request: Sample: Membership Info, Example Lending (made up)', reqId: 'au8k2m4p6q' },
    'poll-au8k2m4p6q-g5-r1': { at: now - 26 * 36e5, ok: true, to: ['sam.rivera@example.com'], cc: [], subject: 'Finding a Time for Sample: Membership Info, Example Lending (made up)', reqId: 'au8k2m4p6q' },
    'remind-au8k2m4p6q-g5-1': { at: now - 2 * 36e5, ok: true, to: ['sam.rivera@example.com'], cc: [], subject: 'Following Up: Finding a Time for Sample: Membership Info, Example Lending (made up)', reqId: 'au8k2m4p6q' },
    'ack-lk3n5p7r9s': { at: now - 3 * 36e5, ok: true, to: ['alex.kim@example.com'], cc: [], subject: 'We’re Working on Your Meeting Request: Sample: Intro Call (made up)', reqId: 'lk3n5p7r9s' }
  };
}
function previewInbox() {
  var vq = previewRequests().filter(function (r) { return r.id === 'vq7m2k9p4a'; })[0];
  return [
    { id: 'mkelly0001', mailbox: 'scheduling@mismo.org', from: 'kbradshaw@mismo.org', fromName: 'Bradshaw, Kelly', to: 'Critchley, Jonna; Rios, Vanessa', cc: 'Moses, Amy',
      subject: 'Sample (made up): FW: Example Title Co - MISMO membership intro', receivedAt: etAt('2026-10-27', '09:38'), body: vq.source.split('\n\n').slice(1).join('\n\n'), status: 'started', reqId: vq.id, by: 'Vanessa Rios' },
    { id: 'msample0002', mailbox: 'scheduling@mismo.org', from: 'sample.sender@example.com', fromName: 'Sample Sender', to: 'scheduling@mismo.org',
      subject: 'Sample (made up): Could we find 45 minutes with the eNote workgroup leads?', receivedAt: Date.now() - 2 * 3600000,
      body: 'Hi team,\n\nCould you help set up a 45-minute call next week with the eNote workgroup co-chairs and our two product leads, Dana Lee (dana.lee@example.com) and Sam Ortiz (sam.ortiz@example.com)? Perry should join from MISMO.\n\nAny afternoon Tuesday through Thursday works on our side.\n\nThanks,\nSample Sender\nExample Lending', status: 'new' }
  ];
}
function previewCalendars() {
  var names = ['Workgroup call', 'Member call', '1:1', 'Standards review', 'Sponsor call', 'Planning', 'Board prep', 'Vendor demo'];
  var by = {}, ids = ['brian', 'jonathan', 'amy', 'kelly', 'jonna', 'perry'];
  var from = '2026-10-19', to = isoAdd(todayISO(ET) > '2026-11-20' ? todayISO(ET) : '2026-11-20', 21);
  ids.forEach(function (pid, pi) {
    var list = [], iso = from, n = 0;
    while (iso <= to) {
      if (!isWeekend(iso)) {
        if (dow(iso) === 4) list.push({ s: etAt(iso, '09:00'), e: etAt(iso, '10:00'), show: 'busy', t: 'MISMO Team Meeting' });
        for (var k = 0; k < 3; k++) {
          var h = 9 + ((n * 7 + pi * 5 + k * 3) % 8), half = (n + k + pi) % 2 ? '30' : '00';
          var s = etAt(iso, (h < 10 ? '0' : '') + h + ':' + half), len = ((n + k) % 3 + 1) * 30;
          list.push({ s: s, e: s + len * 60000, show: (n + k + pi) % 9 === 0 ? 'tentative' : 'busy', t: names[(n + k + pi) % names.length] });
        }
        n++;
      }
      iso = isoAdd(iso, 1);
    }
    by[pid] = list;
  });
  /* keep the sample membership picture readable: Kelly and Amy free at most of the offered times, Amy busy at one */
  var free = [['2026-11-03', '10:00'], ['2026-11-04', '11:00'], ['2026-11-05', '10:00'], ['2026-11-05', '15:00'], ['2026-11-03', '15:00'], ['2026-11-04', '10:00']].map(function (x) { return etAt(x[0], x[1]); });
  Object.keys(by).forEach(function (pid) { by[pid] = by[pid].filter(function (x) { return !free.some(function (s) { return x.s < s + 45 * 60000 && x.e > s; }); }); });
  by.amy.push({ s: etAt('2026-11-03', '13:30'), e: etAt('2026-11-03', '15:00'), show: 'busy', t: 'Member call' });
  return by;
}

/* ======================================================================
   START
   ====================================================================== */
/* the theme button is handled with the rail, at the foot of this file */

/* a desktop alert while the page is open, once a day per person due */
function alertDue() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  var told = lsGet('told', {}), today = todayISO(ET), fresh = [];
  followList(true).forEach(function (x) { if (x.st !== 'due') return; var k = x.r.id + ':' + x.g.id; if (told[k] !== today) { fresh.push(x); told[k] = today; } });
  if (!fresh.length) return;
  lsSet('told', told);
  try { new Notification('Time to follow up', { body: fresh.map(function (x) { return (x.g.name || x.g.email) + ' — ' + x.r.title; }).join('\n'), tag: 'scheduler-follow' }); } catch (e) {}
}

function start() {
  readHash();
  render();
  Promise.all([linksLive(), askReady()]).then(render);
  setInterval(function () { if (!document.hidden) { render(); alertDue(); } }, 10 * 60000);
  setTimeout(alertDue, 3000);
}
if (PREVIEW) {
  previewRequests().forEach(function (r) { DB.server.docs[r.id] = r; });
  previewInbox().forEach(function (x) { INBOX.server.docs[x.id] = x; });
  DB.loaded = true; INBOX.loaded = true;
  saveState('Preview · nothing is saved');
  loadTeam().then(start);
} else {
  var go0 = function () {
    var rs = RS();
    if (!rs) { $('#app').innerHTML = '<div class="notice bad">The sign-in couldn’t load. Reload the page.</div>'; return; }
    rs.requireAccess(PROJECT, { toolName: TOOL }).then(function () {
      render();
      loadArchive().then(function (ch) { if (ch) render(); });
      return Promise.all([loadReqs(), loadTeam(), loadInbox(), loadHealth()]).then(function () {
        start();
        /* bring Team HQ's reminders up to date (an outside guest may have answered by link) */
        syncHqTasks(allReqs().filter(function (r) { return (r.guests || []).some(function (g) { return g.sentAt; }); }).map(function (r) { return r.id; }));
      }, function (e) {
        $('#app').innerHTML = '';
        $('#app').appendChild(el('div', 'notice bad', e && e.code === 'UNKNOWN_PROJECT'
          ? '<b>The Scheduler isn’t connected to saving yet.</b> Perry needs to finish the one-time setup in the README (the <span class="kbd">scheduler</span> entry in projects.json and the scheduler-data repository).'
          : 'Couldn’t load the Scheduler (' + esc(e && (e.message || e.code)) + '). Reload the page to try again.'));
      });
    }, function () {
      $('#app').innerHTML = '<div class="notice bad">Couldn’t reach resources.mismo.org to check your access. Check your connection and reload the page.</div>';
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go0); else go0();
}

/* ---- handles the rail, the search and the theme button need (Scheduler build, Nov 2026) ---- */
window.__sched = {
  go: function(t, id){ return go(t, id); },
  allReqs: function(){ try { return allReqs(); } catch(e){ return []; } },
  /* what the search shows and matches for one request */
  about: function(r){ try {
    var lab = couldntSchedule(r) ? PHASE.unscheduled.n : isPast(r) ? 'Past meeting' : (PHASE[phase(r)] || {}).n || '';
    var s = bookedSlot(r), when = s ? slotLabel(s, VIEW_TZ, true) : '';
    var staffN = (r.internal || []).map(function (id) { var x = person(id); return x ? x.name : id; });
    return { label: lab, when: when, staff: staffN };
  } catch(e){ return { label: '', when: '', staff: [] }; } },
  get INBOX(){ try { return INBOX; } catch(e){ return null; } },
  get STATE(){ try { return STATE; } catch(e){ return null; } }
};
window.allReqs = window.__sched.allReqs;
window.go = window.__sched.go;
Object.defineProperty(window,'INBOX',{get:function(){return window.__sched.INBOX;},configurable:true});
})();
