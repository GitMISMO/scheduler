/* The Times Form: a fillable PDF of one guest's poll times, for a guest who can't open the
   poll page (some company networks block it). Staff download it from the request page and
   attach it to an email; the guest ticks Works or Can't for each time, saves, and emails it
   back to scheduling@mismo.org, where the robot reads the ticks (robot/pdfform.mjs).

   Written by hand rather than with a PDF library so the page has nothing to load and the
   robot's tests can build the same form. Plain PDF 1.7 with an AcroForm:
     ref            read-only, hidden: MISMO-TIMES:<request id>.<guest id>.<guest code>
     t_<slot id>    one radio group per time, options /Works and /Cant
     note           a free-text box
   The reference is also printed in the footer and kept in the document's Keywords, so it
   survives even a viewer that drops form fields.

   TimesForm.build({ req, guest, slots, tz, organizer }) → Uint8Array */
(function (root) {
  'use strict';
  var REF_TAG = 'MISMO-TIMES:';
  var W = {
    'Helvetica': [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 761, 556, 761, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 761, 611, 761, 761, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 761, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500],
    'Helvetica-Bold': [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 761, 556, 761, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 761, 611, 761, 761, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 761, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556]
  };
  /* Windows-1252 for the characters people actually type; anything else becomes '?' */
  var CP = { 8364: 128, 8218: 130, 402: 131, 8222: 132, 8230: 133, 8224: 134, 8225: 135, 710: 136, 8240: 137, 352: 138, 8249: 139, 338: 140, 381: 142,
    8216: 145, 8217: 146, 8220: 147, 8221: 148, 8226: 149, 8211: 150, 8212: 151, 732: 152, 8482: 153, 353: 154, 8250: 155, 339: 156, 382: 158, 376: 159, 8239: 32, 8201: 32, 160: 32 };
  function win(s) {
    var out = '';
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 32 && c < 127) out += s[i];
      else if (CP[c]) out += String.fromCharCode(CP[c]);
      else if (c >= 161 && c < 256) out += s[i];
      else if (c === 10 || c === 9) out += ' ';
      else if (c >= 0xD800 && c < 0xDC00) { out += '?'; i++; }
      else out += '?';
    }
    return out;
  }
  function lit(s) { return '(' + win(s).replace(/[\\()]/g, '\\$&') + ')'; }
  /* a text string outside the page's text (tooltips, the document's title): plain ASCII as is,
     anything else as UTF-16, which every viewer reads the same way */
  function tstr(s) {
    s = String(s == null ? '' : s);
    if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/[\\()]/g, '\\$&') + ')';
    var h = 'FEFF';
    for (var i = 0; i < s.length; i++) h += ('000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
    return '<' + h + '>';
  }
  function width(s, font, size) { var w = 0, t = win(s), a = W[font]; for (var i = 0; i < t.length; i++) w += a[t.charCodeAt(i) - 32] || 556; return w * size / 1000; }
  function wrap(s, font, size, max) {
    var words = String(s || '').split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (width(t, font, size) <= max || !cur) cur = t; else { lines.push(cur); cur = w; } });
    if (cur) lines.push(cur);
    return lines;
  }
  function f(n) { return (Math.round(n * 100) / 100).toString(); }

  /* dates and times in the guest's zone (Eastern unless told otherwise) */
  function fmt(t, tz, o) { return new Date(t).toLocaleString('en-US', Object.assign({ timeZone: tz }, o)); }
  function dayOf(t, tz) { return fmt(t, tz, { weekday: 'long', month: 'long', day: 'numeric' }); }
  function timeOf(t, tz) { return fmt(t, tz, { hour: 'numeric', minute: '2-digit' }); }
  function abbr(t, tz) { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(t)).filter(function (p) { return p.type === 'timeZoneName'; })[0].value; } catch (e) { return ''; } }
  var ZNAME = { 'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific' };

  function build(o) {
    var req = o.req || {}, g = o.guest || {}, tz = o.tz || 'America/New_York';
    var slots = (o.slots || req.slots || []).filter(function (s) { return s && isFinite(s.s) && isFinite(s.e); }).slice().sort(function (a, b) { return a.s - b.s; });
    var ref = REF_TAG + req.id + '.' + g.id + '.' + (g.code || '');
    var NAVY = '0.051 0.192 0.298', SKY = '0.455 0.749 0.922', INK = '0.051 0.192 0.298', MUTED = '0.29 0.388 0.471', LINE = '0.835 0.886 0.929';
    var PW = 612, PH = 792, M = 54, CW = PW - 2 * M;

    var objs = [];              // objs[i] = body of object i+1
    function add(body) { objs.push(body); return objs.length; }
    function reserve() { objs.push(null); return objs.length; }
    function stream(dict, data) { return '<<' + dict + ' /Length ' + data.length + '>>\nstream\n' + data + '\nendstream'; }

    var catalog = reserve(), pagesId = reserve(), helv = add('<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>'),
      bold = add('<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>'),
      zadb = add('<</Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats>>');
    var RES = '/Resources <</Font <</Helv ' + helv + ' 0 R /HeBo ' + bold + ' 0 R /ZaDb ' + zadb + ' 0 R>>>>';

    /* radio appearances: an empty circle, and one with a navy dot */
    var R = 15;
    function circle(cx, cy, r) { var k = 0.5523 * r; return f(cx + r) + ' ' + f(cy) + ' m ' + f(cx + r) + ' ' + f(cy + k) + ' ' + f(cx + k) + ' ' + f(cy + r) + ' ' + f(cx) + ' ' + f(cy + r) + ' c ' + f(cx - k) + ' ' + f(cy + r) + ' ' + f(cx - r) + ' ' + f(cy + k) + ' ' + f(cx - r) + ' ' + f(cy) + ' c ' + f(cx - r) + ' ' + f(cy - k) + ' ' + f(cx - k) + ' ' + f(cy - r) + ' ' + f(cx) + ' ' + f(cy - r) + ' c ' + f(cx + k) + ' ' + f(cy - r) + ' ' + f(cx + r) + ' ' + f(cy - k) + ' ' + f(cx + r) + ' ' + f(cy) + ' c '; }
    var ring = '1 g ' + circle(R / 2, R / 2, R / 2 - 0.8) + 'f 1.2 w ' + MUTED + ' RG ' + circle(R / 2, R / 2, R / 2 - 0.8) + 's';
    var apOff = add(stream('/Type /XObject /Subtype /Form /BBox [0 0 ' + R + ' ' + R + ']', 'q ' + ring + ' Q'));
    var apYes = add(stream('/Type /XObject /Subtype /Form /BBox [0 0 ' + R + ' ' + R + ']', 'q ' + ring + ' 0.122 0.541 0.243 rg ' + circle(R / 2, R / 2, R / 2 - 3.6) + 'f Q'));
    var apNo = add(stream('/Type /XObject /Subtype /Form /BBox [0 0 ' + R + ' ' + R + ']', 'q ' + ring + ' 0.706 0.157 0.141 rg ' + circle(R / 2, R / 2, R / 2 - 3.6) + 'f Q'));

    var pages = [], fields = [], ROW = 28;
    var page = null;
    function newPage() {
      page = { content: [], annots: [], id: reserve() };
      pages.push(page);
      var c = page.content;
      /* the MISMO header band, as on every Scheduler email */
      c.push(NAVY + ' rg 0 ' + (PH - 64) + ' ' + PW + ' 64 re f');
      c.push(SKY + ' rg 0 ' + (PH - 67) + ' ' + PW + ' 3 re f');
      c.push('BT 1 g /HeBo 22 Tf ' + M + ' ' + (PH - 42) + ' Td ' + lit('MISMO') + ' Tj ET');
      c.push('BT 0.663 0.847 0.953 rg /HeBo 11 Tf ' + f(PW - M - width('Scheduling', 'Helvetica-Bold', 11)) + ' ' + (PH - 40) + ' Td ' + lit('Scheduling') + ' Tj ET');
      return PH - 100;
    }
    function text(x, y, s, font, size, color) { page.content.push('BT ' + (color || INK) + ' rg /' + (font === 'Helvetica-Bold' ? 'HeBo' : 'Helv') + ' ' + size + ' Tf ' + f(x) + ' ' + f(y) + ' Td ' + lit(s) + ' Tj ET'); }
    function rule(y) { page.content.push(LINE + ' RG 0.8 w ' + M + ' ' + f(y) + ' m ' + (PW - M) + ' ' + f(y) + ' l S'); }

    var y = newPage();
    text(M, y, 'Choose the Times That Work', 'Helvetica-Bold', 20); y -= 26;
    wrap(req.title || 'MISMO Meeting', 'Helvetica-Bold', 13, CW).forEach(function (l) { text(M, y, l, 'Helvetica-Bold', 13); y -= 17; });
    var facts = [(+req.duration || 30) + ' minutes', req.where || 'Zoom'].concat(o.organizer ? ['with ' + o.organizer] : []).join('  ·  ');
    text(M, y, facts, 'Helvetica', 11, MUTED); y -= 24;
    var first = String(g.name || '').trim().split(/\s+/)[0] || 'there';
    var intro = 'Hello ' + first + ', for each time below, choose Works or Can’t. Add a note if you like, save this form, and email it back to scheduling@mismo.org (replying to the email it came with is easiest). The Scheduler reads it as soon as it arrives.';
    wrap(intro, 'Helvetica', 11, CW).forEach(function (l) { text(M, y, l, 'Helvetica', 11); y -= 15; });
    y -= 12;

    var zone = ZNAME[tz] || tz.replace(/^.*\//, '').replace(/_/g, ' ');
    var COLW = PW - M - 110, COLC = PW - M - 36;   // centers of the Works and Can't columns
    function head() {
      text(M, y, 'Day', 'Helvetica-Bold', 10, MUTED);
      text(M + 190, y, 'Time (' + zone + ')', 'Helvetica-Bold', 10, MUTED);
      text(COLW - width('Works', 'Helvetica-Bold', 10) / 2, y, 'Works', 'Helvetica-Bold', 10, MUTED);
      text(COLC - width('Can’t', 'Helvetica-Bold', 10) / 2, y, 'Can’t', 'Helvetica-Bold', 10, MUTED);
      y -= 8; rule(y);
    }
    head();
    var lastDay = '';
    slots.forEach(function (sl) {
      if (y - ROW < 150) { y = newPage(); head(); lastDay = ''; }
      var d = dayOf(sl.s, tz), mid = y - ROW / 2;
      if (d !== lastDay) text(M, mid - 4, d, 'Helvetica-Bold', 11);
      lastDay = d;
      text(M + 190, mid - 4, timeOf(sl.s, tz) + ' – ' + timeOf(sl.e, tz) + ' ' + abbr(sl.s, tz), 'Helvetica', 11);
      var name = 't_' + String(sl.id).replace(/[^A-Za-z0-9_-]/g, '');
      var field = reserve(), kids = [];
      [['Works', COLW, apYes], ['Cant', COLC, apNo]].forEach(function (op) {
        var rect = [op[1] - R / 2, mid - R / 2, op[1] + R / 2, mid + R / 2].map(f).join(' ');
        var w = add('<</Type /Annot /Subtype /Widget /Parent ' + field + ' 0 R /P ' + page.id + ' 0 R /Rect [' + rect + '] /F 4 /AS /Off' +
          ' /TU ' + tstr((op[0] === 'Works' ? 'Works: ' : 'Can’t: ') + d + ' ' + timeOf(sl.s, tz)) +
          ' /MK <</BC [' + MUTED + '] /BG [1 1 1] /CA (l)>> /AP <</N <</' + op[0] + ' ' + op[2] + ' 0 R /Off ' + apOff + ' 0 R>>>>>>');
        kids.push(w); page.annots.push(w);
      });
      objs[field - 1] = '<</FT /Btn /Ff 49152 /T ' + tstr(name) + ' /TU ' + tstr(d + ' ' + timeOf(sl.s, tz)) + ' /V /Off /Kids [' + kids.map(function (k) { return k + ' 0 R'; }).join(' ') + ']>>';
      fields.push(field);
      y -= ROW; rule(y);
    });

    /* the note, then the reference */
    if (y < 190) y = newPage();
    y -= 26;
    text(M, y, 'Anything we should know? (optional)', 'Helvetica-Bold', 11); y -= 8;
    var noteRect = [M, y - 84, PW - M, y];
    page.content.push(LINE + ' RG 1 w ' + noteRect[0] + ' ' + f(noteRect[1]) + ' ' + CW + ' 84 re S');
    var apNote = add(stream('/Type /XObject /Subtype /Form /BBox [0 0 ' + CW + ' 84]', '/Tx BMC EMC'));
    var note = add('<</Type /Annot /Subtype /Widget /FT /Tx /Ff 4096 /T (note) /TU (Anything we should know?) /P ' + page.id + ' 0 R /F 4 /Rect [' + noteRect.map(f).join(' ') + '] /DA (/Helv 11 Tf 0 g) /V () /AP <</N ' + apNote + ' 0 R>>>>');
    page.annots.push(note); fields.push(note);
    y -= 108;
    wrap('Prefer email? You can also just reply with the days and times that work for you. The times above were open when this form was made; if one has filled up since, we’ll be in touch.', 'Helvetica', 9.5, CW)
      .forEach(function (l) { text(M, y, l, 'Helvetica', 9.5, MUTED); y -= 12.5; });
    var refField = add('<</Type /Annot /Subtype /Widget /FT /Tx /Ff 1 /F 6 /T (ref) /P ' + page.id + ' 0 R /Rect [0 0 0 0] /DA (/Helv 0 Tf 0 g) /V ' + tstr(ref) + '>>');
    page.annots.push(refField); fields.push(refField);
    pages.forEach(function (p, i) {
      page = p;
      text(M, 30, 'Form reference ' + ref + '  ·  Page ' + (i + 1) + ' of ' + pages.length, 'Helvetica', 7.5, MUTED);
      var content = add(stream('', p.content.join('\n')));
      objs[p.id - 1] = '<</Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] ' + RES + ' /Contents ' + content + ' 0 R /Annots [' + p.annots.map(function (a) { return a + ' 0 R'; }).join(' ') + ']>>';
    });
    objs[pagesId - 1] = '<</Type /Pages /Count ' + pages.length + ' /Kids [' + pages.map(function (p) { return p.id + ' 0 R'; }).join(' ') + ']>>';
    objs[catalog - 1] = '<</Type /Catalog /Pages ' + pagesId + ' 0 R /AcroForm <</Fields [' + fields.map(function (x) { return x + ' 0 R'; }).join(' ') + '] /NeedAppearances false /DA (/Helv 0 Tf 0 g) /DR <</Font <</Helv ' + helv + ' 0 R /ZaDb ' + zadb + ' 0 R>>>>>>>>';
    var info = add('<</Title ' + tstr('Times Form: ' + (req.title || 'MISMO Meeting')) + ' /Author (MISMO Scheduling) /Subject ' + tstr('Times for ' + (g.name || g.email || 'a guest')) + ' /Keywords ' + tstr(ref) + ' /Producer (MISMO Scheduler)>>');

    var out = '%PDF-1.7\n%âãÏÓ\n', offs = [];
    objs.forEach(function (b, i) { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + b + '\nendobj\n'; });
    var xref = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(function (o) { return ('0000000000' + o).slice(-10) + ' 00000 n \n'; }).join('');
    out += 'trailer\n<</Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R /Info ' + info + ' 0 R>>\nstartxref\n' + xref + '\n%%EOF\n';
    var bytes = new Uint8Array(out.length);
    for (var i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return bytes;
  }
  function fileName(req, g) { return ('Times Form - ' + (req.title || 'MISMO Meeting') + ' - ' + (g.name || g.email || 'Guest')).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + '.pdf'; }

  var API = { build: build, fileName: fileName, REF_TAG: REF_TAG };
  if (typeof module === 'object' && module.exports) module.exports = API;
  root.TimesForm = API;
})(typeof window !== 'undefined' ? window : globalThis);
