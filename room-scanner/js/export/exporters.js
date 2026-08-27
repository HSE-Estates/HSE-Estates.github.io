/* ---------------------------------------------------------------------------
   Export orchestration (brief §22).

   SVG and DXF are true vector outputs generated straight from the model.
   PNG and PDF are rasterised from the same SVG at 300 dpi, so every output in
   the set comes from one geometry source.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Export = (function () {
  'use strict';

  var S = RS.Schema;

  function slug(s) {
    return String(s || 'plan').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'plan';
  }

  function stamp() {
    var d = new Date();
    function p(v) { return ('0' + v).slice(-2); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(data, filename, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      /* The anchor may already be gone — a re-render, or a second export
         started before this one's cleanup ran. Revoking the object URL is the
         part that actually matters, so it must not be skipped by a throw. */
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /* -- SVG ----------------------------------------------------------------- */

  function planSvg(project, rooms) {
    return RS.Plan.render(project, {
      rooms: rooms || project.rooms,
      interactive: false,
      margin: 0.35
    });
  }

  function exportSvg(project, rooms) {
    var svg = planSvg(project, rooms);
    download(svg, slug(project.name) + '-' + stamp() + '.svg', 'image/svg+xml');
    return svg;
  }

  /* -- Rasterisation -------------------------------------------------------- */

  function viewBoxOf(svgString) {
    var m = /viewBox="([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)"/.exec(svgString);
    if (!m) return { w: 1000, h: 1000 };
    return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
  }

  /* Draw the SVG into a canvas. The SVG is self-contained — no external fonts
     or images — so the canvas is never tainted and toDataURL keeps working. */
  function rasterise(svgString, pxWidth) {
    var vb = viewBoxOf(svgString);
    var pxHeight = Math.max(1, Math.round(pxWidth * vb.h / vb.w));
    var sized = svgString
      .replace(/width="[^"]*"/, 'width="' + pxWidth + '"')
      .replace(/height="[^"]*"/, 'height="' + pxHeight + '"');

    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = pxWidth;
        canvas.height = pxHeight;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pxWidth, pxHeight);
        ctx.drawImage(img, 0, 0, pxWidth, pxHeight);
        resolve(canvas);
      };
      img.onerror = function () { reject(new Error('The plan could not be rasterised.')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
    });
  }

  function exportPng(project, rooms, pxWidth) {
    var svg = planSvg(project, rooms);
    return rasterise(svg, pxWidth || 2400).then(function (canvas) {
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          download(blob, slug(project.name) + '-' + stamp() + '.png', 'image/png');
          resolve(blob);
        }, 'image/png');
      });
    });
  }

  /* -- Branding -------------------------------------------------------------
     The app ships no organisation's logo. One comes either from the repository
     (branding/logo.txt, so it is present on every device) or from Settings on
     this device. Transparency is flattened onto white, because the sheet header
     is white and the PDF writer embeds JPEG, which has no alpha channel. */
  function logoForPdf() {
    var url = (RS.Brand.effective().logoDataUrl || '').trim();
    if (!url) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve({
            jpeg: atob(canvas.toDataURL('image/jpeg', 0.94).split(',')[1]),
            w: canvas.width,
            h: canvas.height
          });
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }

  /* Drawing scale as an architect would state it: how many real millimetres
     each drawn millimetre represents on the printed A4 sheet. */
  function scaleRatio(metresAcross, pointsAcross) {
    if (!(metresAcross > 0) || !(pointsAcross > 0)) return null;
    var drawnMm = pointsAcross * 25.4 / 72;
    var ratio = (metresAcross * 1000) / drawnMm;
    /* Snap to a conventional ratio when we are within a few percent of one. */
    var nice = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500];
    for (var i = 0; i < nice.length; i++) {
      if (Math.abs(ratio - nice[i]) / nice[i] < 0.04) return '1:' + nice[i];
    }
    return '1:' + Math.round(ratio);
  }

  /* -- PDF ------------------------------------------------------------------ */

  /* How big the plan prints on a given sheet and orientation. Used both to
     choose automatically and to report the scale honestly. */
  function layoutFor(paper, mode, aspect, headerH) {
    var sheet = RS.PDF.PAPER[paper] || RS.PDF.A4;
    var page = mode === 'landscape' ? { w: sheet.h, h: sheet.w } : { w: sheet.w, h: sheet.h };
    var availW = page.w - 68;
    var availH = Math.max(80, (page.h - 34 - headerH) - (34 + 26 + 3 * 10) - 14);
    return {
      paper: paper, mode: mode, page: page, availW: availW, availH: availH,
      drawW: Math.min(availW, availH * aspect)
    };
  }

  function exportPdf(project, rooms, options) {
    var opt = Object.assign({ paper: 'A4', orientation: 'auto' }, options || {});
    var list = (rooms || project.rooms).filter(function (r) { return r.points.length >= 3; });
    if (!list.length) return Promise.reject(new Error('There is nothing drawn to export yet.'));

    var svg = planSvg(project, list);
    var vb = viewBoxOf(svg);
    var settings = RS.Brand.effective();

    return logoForPdf().then(function (logo) {
      var headerH = (logo || settings.orgName) ? 54 : 0;
      var aspect = vb.w / vb.h;

      /* Auto picks the orientation that prints the plan LARGEST, which is not
         the same as matching its aspect ratio: the header and title block eat
         height, so a moderately wide plan often prints bigger portrait. A wide
         whole-floor plan does come out landscape, which is the case that
         prompted the question. */
      var best;
      if (opt.orientation === 'auto') {
        best = ['portrait', 'landscape']
          .map(function (m) { return layoutFor(opt.paper, m, aspect, headerH); })
          .sort(function (a, b) { return b.drawW - a.drawW; })[0];
      } else {
        best = layoutFor(opt.paper, opt.orientation, aspect, headerH);
      }

      var landscape = best.mode === 'landscape';
      /* 300 dpi across the printable width of the chosen sheet. */
      var pxWidth = Math.round(Math.min(5000, (best.availW / 72) * 300));
      return rasterise(svg, pxWidth).then(function (canvas) {
        return finish(canvas, logo, landscape, best, vb, list, project, settings, opt);
      });
    });
  }

  function finish(canvas, logo, landscape, best, vb, list, project, settings, opt) {
    return Promise.resolve().then(function () {
      var dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      var jpeg = atob(dataUrl.split(',')[1]);

      var totalArea = list.reduce(function (t, r) { return t + S.roomArea(r); }, 0);
      var room = list[0] || {};
      var method = {
        station: 'Camera scan, single-station ray cast',
        xr: 'AR depth capture',
        manual: 'Drawn by hand',
        detected: 'Assisted detection, user confirmed'
      }[(room.capture || {}).method] || 'Drawn by hand';
      var corrected = list.every(function (r) {
        return r.capture.method !== 'station' || r.capture.scaleCorrected;
      });

      /* State the scale actually printed, using the same fit the writer uses. */
      var fit = Math.min(best.availW / canvas.width, best.availH / canvas.height);
      var ratio = scaleRatio(vb.w, canvas.width * fit);

      var storeyLabel = list.length > 1
        ? S.storeyName(room.storey || 0)
        : (room.name || 'Floor plan');

      var bytes = RS.PDF.build({
        jpeg: jpeg,
        imgW: canvas.width,
        imgH: canvas.height,
        org: settings.orgName || '',
        logo: logo,
        title: project.name || 'Floor plan',
        paper: opt.paper,
        fields: [
          { label: 'Drawing', value: storeyLabel },
          { label: 'Rooms', value: String(list.length) },
          { label: 'Floor area', value: totalArea.toFixed(2) + ' sq m' },
          { label: 'Scale on ' + opt.paper + (landscape ? ' landscape' : ''), value: ratio || '-' }
        ],
        lines: [
          'Capture method: ' + method + (corrected
            ? ', scale corrected against a measured wall.'
            : ', scale estimated from camera height and NOT corrected against a measurement.'),
          'Dimensions are internal, in metres, measured to the inner face of the walls.',
          'Indicative survey for space planning. Not a measured survey - verify critical dimensions on site before ordering or building.'
        ],
        stamp: new Date().toLocaleDateString('en-IE', { year: 'numeric', month: 'long', day: 'numeric' }),
        landscape: landscape
      });

      download(new Blob([bytes], { type: 'application/pdf' }),
        slug(project.name) + '-' + stamp() + '.pdf');
      return bytes;
    });
  }

  /* What sheet and scale a given choice will actually produce, worked out
     without rendering anything. Lets the export dialog warn before the click
     rather than after the PDF opens. */
  function predictSheet(project, rooms, options) {
    var opt = Object.assign({ paper: 'A4', orientation: 'auto' }, options || {});
    var list = (rooms || project.rooms).filter(function (r) { return r.points.length >= 3; });
    if (!list.length) return null;

    var vb = viewBoxOf(planSvg(project, list));
    var brand = RS.Brand.effective();
    var headerH = (brand.logoDataUrl || brand.orgName) ? 54 : 0;
    var aspect = vb.w / vb.h;

    var chosen = opt.orientation === 'auto'
      ? ['portrait', 'landscape'].map(function (m) { return layoutFor(opt.paper, m, aspect, headerH); })
          .sort(function (a, b) { return b.drawW - a.drawW; })[0]
      : layoutFor(opt.paper, opt.orientation, aspect, headerH);

    var ratio = scaleRatio(vb.w, chosen.drawW);
    var ratioNum = Number(String(ratio || '1:100').split(':')[1]) || 100;
    /* A standard 900 mm door leaf, in millimetres on the printed page. */
    var doorMm = 900 / ratioNum;

    /* Anything past about 1:100 stops being readable for a floor plan — door
       and window widths collapse into the line weight. */
    var order = ['A5', 'A4', 'A3', 'A2'];
    var next = order[Math.min(order.length - 1, order.indexOf(opt.paper) + 1)];
    return {
      mode: chosen.mode,
      paper: opt.paper,
      ratio: ratio,
      drawW: chosen.drawW,
      doorMm: doorMm.toFixed(1),
      tooSmall: ratioNum > 110,
      suggestion: next !== opt.paper ? next : 'exporting one floor at a time'
    };
  }

  /* -- DXF ------------------------------------------------------------------ */

  function exportDxf(project, rooms, units) {
    var dxf = RS.DXF.build(project, { rooms: rooms, units: units || 'mm' });
    download(dxf, slug(project.name) + '-' + stamp() + '.dxf', 'application/dxf');
    return dxf;
  }

  /* -- JSON ------------------------------------------------------------------ */

  function exportJson(project) {
    var json = JSON.stringify(project, null, 2);
    download(json, slug(project.name) + '-' + stamp() + '.json', 'application/json');
    return json;
  }

  function importJson(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          resolve(S.coerceProject(JSON.parse(reader.result)));
        } catch (e) {
          reject(new Error('That file is not a valid project export.'));
        }
      };
      reader.onerror = function () { reject(new Error('The file could not be read.')); };
      reader.readAsText(file);
    });
  }

  /* Small preview used on the project cards. */
  function thumbnail(project) {
    if (!project.rooms.length || !project.rooms[0].points.length) return '';
    return RS.Plan.render(project, {
      rooms: [project.rooms[0]],
      interactive: false,
      margin: 0.2,
      presentation: { showDimensions: false, showAreas: false, showNorth: false, style: 'presentation' }
    });
  }

  return {
    exportSvg: exportSvg, exportPng: exportPng, exportPdf: exportPdf,
    exportDxf: exportDxf, exportJson: exportJson, importJson: importJson,
    planSvg: planSvg, rasterise: rasterise, thumbnail: thumbnail,
    logoForPdf: logoForPdf, scaleRatio: scaleRatio, predictSheet: predictSheet,
    download: download, slug: slug
  };
})();
