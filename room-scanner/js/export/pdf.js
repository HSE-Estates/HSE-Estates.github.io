/* ---------------------------------------------------------------------------
   PDF export — a small, dependency-free PDF 1.4 writer producing a branded
   drawing sheet.

   Layout:
     header       organisation logo (if one is set) and the project name
     green rule   the brand band
     plan         the drawing, rasterised at 300 dpi from the same SVG that
                  feeds the screen, PNG and (via the model) the DXF
     title block  drawing name, floor area, scale ratio, capture method and
                  the accuracy statement

   Everything except the plan itself is real PDF text, so it stays crisp and
   selectable. The logo is supplied by the user in Settings and embedded here —
   the app ships no organisation's mark of its own.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.PDF = (function () {
  'use strict';

  /* Points, portrait. A3 is worth having: a whole-floor plan on A4 ends up at
     1:100 or worse, where a 900 mm doorway is under ten millimetres on paper. */
  var PAPER = {
    A5: { w: 419.53, h: 595.28 },
    A4: { w: 595.28, h: 841.89 },
    A3: { w: 841.89, h: 1190.55 },
    A2: { w: 1190.55, h: 1683.78 }
  };
  var A4 = PAPER.A4;
  var MARGIN = 34;

  /* Brand colours as PDF fill operands, kept in step with css/theme.css. */
  var C = {
    green: '0 0.388 0.329',
    teal: '0 0.643 0.6',
    ink: '0.086 0.129 0.122',
    grey: '0.42 0.478 0.463',
    rule: '0.835 0.867 0.855'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      /* Helvetica in WinAnsi: keep it to Latin-1 so nothing renders as a box. */
      .replace(/²/g, '2')
      .replace(/[‐-―]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/·/g, '-')
      .replace(/[^\x20-\x7e\xa0-\xff]/g, '-');
  }

  /* Rough Helvetica advance widths — accurate enough to right-align a date. */
  function textWidth(str, size, bold) {
    return String(str).length * size * (bold ? 0.55 : 0.5);
  }

  /* opts:
       jpeg, imgW, imgH        the rasterised plan
       title, subtitle         project and room names
       fields  [{label, value}]  title-block columns
       lines   [str]           notes under the title block
       stamp                   date
       logo    { jpeg, w, h }  optional, from Settings
       org                     optional organisation name
       landscape               page orientation                                */
  function build(opts) {
    var sheet = PAPER[opts.paper] || A4;
    var page = opts.landscape ? { w: sheet.h, h: sheet.w } : { w: sheet.w, h: sheet.h };
    var hasHeader = !!(opts.logo || opts.org);
    var headerH = hasHeader ? 54 : 0;
    var fields = opts.fields || [];
    var notes = opts.lines || [];
    var footerH = 34 + (fields.length ? 26 : 0) + notes.length * 10;

    var contentTop = page.h - MARGIN - headerH;
    var contentBottom = MARGIN + footerH;
    var availW = page.w - MARGIN * 2;
    var availH = Math.max(80, contentTop - contentBottom - 14);

    var scale = Math.min(availW / opts.imgW, availH / opts.imgH);
    var drawW = opts.imgW * scale;
    var drawH = opts.imgH * scale;
    var drawX = MARGIN + (availW - drawW) / 2;
    var drawY = contentBottom + 10 + (availH - drawH) / 2;

    var c = [];

    /* -- header ------------------------------------------------------------ */
    if (hasHeader) {
      var headerY = page.h - MARGIN;
      var textX = MARGIN;

      if (opts.logo) {
        var maxH = 32, maxW = 150;
        var ls = Math.min(maxH / opts.logo.h, maxW / opts.logo.w);
        var lw = opts.logo.w * ls, lh = opts.logo.h * ls;
        c.push('q');
        c.push(f(lw) + ' 0 0 ' + f(lh) + ' ' + f(MARGIN) + ' ' + f(headerY - lh) + ' cm');
        c.push('/Logo Do');
        c.push('Q');
        textX = MARGIN + lw + 14;
      }

      if (opts.org) {
        c.push('BT ' + C.ink + ' rg /F2 11 Tf ' +
          f(textX) + ' ' + f(headerY - 13) + ' Td (' + esc(opts.org) + ') Tj ET');
      }
      c.push('BT ' + C.grey + ' rg /F1 8.5 Tf ' +
        f(textX) + ' ' + f(headerY - (opts.org ? 25 : 14)) + ' Td (' + esc(opts.title) + ') Tj ET');

      /* Brand rule under the header. */
      c.push(C.green + ' rg');
      c.push(f(MARGIN) + ' ' + f(page.h - MARGIN - headerH + 8) + ' ' + f(availW) + ' 2.5 re f');
      c.push(C.teal + ' rg');
      c.push(f(MARGIN) + ' ' + f(page.h - MARGIN - headerH + 8) + ' 54 2.5 re f');
    }

    /* -- plan -------------------------------------------------------------- */
    c.push('q');
    c.push(f(drawW) + ' 0 0 ' + f(drawH) + ' ' + f(drawX) + ' ' + f(drawY) + ' cm');
    c.push('/Im0 Do');
    c.push('Q');

    /* -- title block -------------------------------------------------------- */
    var blockTop = MARGIN + footerH;
    c.push(C.rule + ' RG 0.8 w');
    c.push(f(MARGIN) + ' ' + f(blockTop) + ' m ' + f(page.w - MARGIN) + ' ' + f(blockTop) + ' l S');
    c.push(C.green + ' rg');
    c.push(f(MARGIN) + ' ' + f(blockTop - 2.5) + ' 54 2.5 re f');

    var y = blockTop - 16;
    if (fields.length) {
      var colW = availW / fields.length;
      fields.forEach(function (fl, i) {
        var x = MARGIN + colW * i;
        c.push('BT ' + C.grey + ' rg /F1 6.5 Tf ' +
          f(x) + ' ' + f(y) + ' Td (' + esc(String(fl.label).toUpperCase()) + ') Tj ET');
        c.push('BT ' + C.ink + ' rg /F2 11 Tf ' +
          f(x) + ' ' + f(y - 13) + ' Td (' + esc(fl.value) + ') Tj ET');
      });
      y -= 26;
    }

    notes.forEach(function (ln, i) {
      c.push('BT ' + C.grey + ' rg /F1 7.4 Tf ' +
        f(MARGIN) + ' ' + f(y - 8 - i * 10) + ' Td (' + esc(ln) + ') Tj ET');
    });

    if (opts.stamp) {
      c.push('BT ' + C.grey + ' rg /F1 7.4 Tf ' +
        f(page.w - MARGIN - textWidth(opts.stamp, 7.4)) + ' ' + f(blockTop - 16) +
        ' Td (' + esc(opts.stamp) + ') Tj ET');
    }

    var content = c.join('\n');

    /* -- objects ------------------------------------------------------------ */
    var objects = [];
    function obj(body) { objects.push(body); return objects.length; }   // 1-based

    var catalog = obj(null);
    var pages = obj(null);
    var pageObj = obj(null);
    var contentObj = obj(null);
    var imgObj = obj(null);
    var f1 = obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    var f2 = obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    var logoObj = opts.logo ? obj(null) : 0;

    var xobjects = '/Im0 ' + imgObj + ' 0 R' + (logoObj ? ' /Logo ' + logoObj + ' 0 R' : '');

    objects[catalog - 1] = '<< /Type /Catalog /Pages ' + pages + ' 0 R >>';
    objects[pages - 1] = '<< /Type /Pages /Kids [' + pageObj + ' 0 R] /Count 1 >>';
    objects[pageObj - 1] = '<< /Type /Page /Parent ' + pages + ' 0 R ' +
      '/MediaBox [0 0 ' + f(page.w) + ' ' + f(page.h) + '] ' +
      '/Resources << /XObject << ' + xobjects + ' >> ' +
      '/Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> ' +
      '/Contents ' + contentObj + ' 0 R >>';
    objects[contentObj - 1] = { dict: '<< /Length ' + content.length + ' >>', stream: content };
    objects[imgObj - 1] = imageObject(opts.jpeg, opts.imgW, opts.imgH);
    if (logoObj) objects[logoObj - 1] = imageObject(opts.logo.jpeg, opts.logo.w, opts.logo.h);

    var out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    var offsets = [];
    objects.forEach(function (o, i) {
      offsets.push(out.length);
      out += (i + 1) + ' 0 obj\n';
      out += (typeof o === 'string')
        ? o + '\nendobj\n'
        : o.dict + '\nstream\n' + o.stream + '\nendstream\nendobj\n';
    });

    var xrefAt = out.length;
    out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach(function (off) { out += pad10(off) + ' 00000 n \n'; });
    out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalog + ' 0 R ' +
      '/Info << /Producer (Room Scanner) /Title (' + esc(opts.title) + ')' +
      (opts.org ? ' /Author (' + esc(opts.org) + ')' : '') + ' >> >>\n' +
      'startxref\n' + xrefAt + '\n%%EOF';

    return toBytes(out);
  }

  function imageObject(jpeg, w, h) {
    return {
      dict: '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
            ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode' +
            ' /Length ' + jpeg.length + ' >>',
      stream: jpeg
    };
  }

  function toBytes(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
  }

  function pad10(v) { return ('0000000000' + v).slice(-10); }
  function f(v) { return (Math.round(v * 100) / 100).toString(); }

  return { build: build, toBytes: toBytes, textWidth: textWidth, A4: A4, PAPER: PAPER, MARGIN: MARGIN };
})();
