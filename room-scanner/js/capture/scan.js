/* ---------------------------------------------------------------------------
   Guided capture (brief §7, §29).

   Flow: stand still → tap each corner where the wall meets the floor → tap the
   jambs of doors and windows → tap the base of any furniture → finish.

   Captured markers are re-projected back onto the live camera image every
   frame, so they stick to the real corners as the phone is panned. That is the
   feedback loop that tells the user immediately whether a tap was good — the
   thing a batch SLAM pipeline can never give them.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Scan = (function () {
  'use strict';

  var G = RS.Geom, S = RS.Schema, Store = RS.Store, O = RS.Orientation, RC = RS.Raycast;

  var el = {};
  var stream = null;
  var rafId = null;
  var active = false;

  var step = 'corners';           // corners | openings | objects
  var subType = 'door';
  var objType = 'bed_double';
  var mode = 'sweep';             // sweep | live

  var corners = [];               // { x, y, confidence, tap, orient }
  var openings = [];              // { wallIndex, offset, width, type }
  var objects = [];               // { type, x, y, rot, confidence }
  var pendingJamb = null;         // first jamb tap while placing an opening
  var draftRoom = null;           // rebuilt after every corner so bearings work
  var cameraErrorMessage = null;  // friendly text shown to the user
  var cameraErrorName = null;     // raw DOMException name, used to give advice

  var opts = { cameraHeight: 1.45, fovDeg: 66, mirrored: false };

  /* -- Lifecycle ------------------------------------------------------------ */

  function init(refs) {
    el = refs;
    el.overlay.addEventListener('pointerdown', onTap);
  }

  function start() {
    active = true;
    step = 'corners';
    corners = []; openings = []; objects = []; pendingJamb = null; draftRoom = null;
    RS.Sweep.reset();
    var st = Store.getSettings();
    opts.cameraHeight = st.cameraHeight || 1.45;
    opts.fovDeg = st.fovDeg || 66;

    O.start();
    startCamera();
    loop();
    renderChrome();

    if (O.needsPermission()) {
      O.requestPermission().then(function (r) {
        if (r !== 'granted') {
          RS.UI.toast('Motion access was declined — switch to manual entry to draw the room by hand.', 'warn');
        }
      });
    } else if (!O.supported()) {
      RS.UI.toast('This device reports no orientation sensor. Use manual entry instead.', 'warn');
    }
  }

  function stop() {
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    stopCamera();
    O.stop();
    /* Captured frames are object URLs; leaving them would leak the whole sweep
       until the tab is closed. */
    RS.Sweep.reset();
    if (el.frame) { el.frame.removeAttribute('src'); el.frame.style.display = 'none'; }
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFailed('This browser exposes no camera API.');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (s) {
      stream = s;
      el.video.srcObject = s;
      el.video.play().catch(function () { /* autoplay guard */ });
      var track = s.getVideoTracks()[0];
      var settings = track ? track.getSettings() : {};
      opts.mirrored = settings.facingMode === 'user';
    }).catch(function (err) {
      cameraErrorName = err ? err.name : null;
      cameraFailed(err && err.name === 'NotAllowedError'
        ? 'Camera access was declined.'
        : 'No camera available. On a laptop this usually means the page is not on https or localhost.');
    });
  }

  function cameraFailed(msg) {
    cameraErrorMessage = msg;
    RS.UI.toast(msg + ' You can still draw the room by hand.', 'error');
    if (el.cameraError) {
      el.cameraError.textContent = msg;
      el.cameraError.style.display = 'block';
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    if (el.video) el.video.srcObject = null;
  }

  /* -- Frame loop ----------------------------------------------------------- */

  function loop() {
    if (!active) return;
    draw();
    rafId = requestAnimationFrame(loop);
  }

  /* Reviewing a captured frame is not the same optical situation as the live
     preview. The live video is drawn with object-fit: cover and is cropped; the
     review frame is drawn with object-fit: contain and is whole, letterboxed
     inside the element. Measuring against the element box in review mode would
     silently stretch every angle, so the content rect is computed instead — the
     actual rectangle the picture occupies. */
  function contentRect() {
    var r = el.overlay.getBoundingClientRect();
    var f = reviewing() ? RS.Sweep.current() : null;

    if (!f) {
      return {
        left: 0, top: 0,
        elemWidth: r.width, elemHeight: r.height,
        videoWidth: el.video.videoWidth || 0,
        videoHeight: el.video.videoHeight || 0
      };
    }
    var scale = Math.min(r.width / f.w, r.height / f.h);   // object-fit: contain
    var w = f.w * scale, h = f.h * scale;
    return {
      left: (r.width - w) / 2,
      top: (r.height - h) / 2,
      elemWidth: w, elemHeight: h,
      videoWidth: f.w, videoHeight: f.h
    };
  }

  function projOpts() {
    return Object.assign({}, opts, contentRect());
  }

  function reviewing() { return mode === 'sweep' && RS.Sweep.state === 'review'; }

  /* The pose to measure against: the live sensor, or the pose recorded with the
     frame currently on screen. Everything downstream is identical. */
  function currentOrient() {
    return reviewing() ? RS.Sweep.currentOrient() : O.snapshot();
  }

  /* World plan point → screen pixel, the inverse of the capture ray. Returns
     null when the point is behind the camera. */
  function planToScreen(p, o) {
    var orient = currentOrient();
    if (!orient) return null;
    var m = orient.matrix;
    /* Vector from camera to the floor point, world frame. */
    var v = { x: p.x, y: -p.y, z: -o.cameraHeight };
    /* World → device: multiply by the transpose. */
    var d = {
      x: m[0][0] * v.x + m[1][0] * v.y + m[2][0] * v.z,
      y: m[0][1] * v.x + m[1][1] * v.y + m[2][1] * v.z,
      z: m[0][2] * v.x + m[1][2] * v.y + m[2][2] * v.z
    };
    /* Device → screen frame: undo the screen rotation. */
    var s = O.rotateForScreen(d, -orient.screenAngle);
    if (s.z > -0.05) return null;
    var t = RC.visibleTangents(o);
    var nx = (s.x / -s.z) / t.tx;
    var ny = -(s.y / -s.z) / t.ty;
    if (o.mirrored) nx = -nx;
    return {
      /* Offset by the content rect so markers land on the picture, not on the
         letterbox bars beside it. */
      x: (o.left || 0) + (nx + 1) / 2 * o.elemWidth,
      y: (o.top || 0) + (ny + 1) / 2 * o.elemHeight,
      onScreen: Math.abs(nx) <= 1.25 && Math.abs(ny) <= 1.25
    };
  }

  function draw() {
    var o = projOpts();
    var W = o.elemWidth, H = o.elemHeight;
    if (!W || !H) return;
    var full = el.overlay.getBoundingClientRect();
    var ox = o.left || 0, oy = o.top || 0;

    var parts = [];
    var state = O.getState();

    /* Horizon: everything above it cannot hit the floor. Positioned inside the
       picture, which in review mode is not the whole element. */
    var horizonY = horizonScreenY(o);
    if (horizonY != null && horizonY > -H && horizonY < H * 2) {
      parts.push('<line x1="' + ox + '" y1="' + (oy + horizonY) + '" x2="' + (ox + W) + '" y2="' + (oy + horizonY) +
        '" stroke="rgba(255,255,255,.35)" stroke-width="1" stroke-dasharray="6 6"/>');
      parts.push('<text x="' + (ox + 10) + '" y="' + (oy + horizonY - 8) + '" fill="rgba(255,255,255,.6)" font-size="11" ' +
        'font-family="Lato, Segoe UI, Arial, sans-serif">horizon — aim below this line</text>');
    }

    /* Captured corners, re-projected. */
    var screenPts = [];
    corners.forEach(function (c, i) {
      var sp = planToScreen(c, o);
      screenPts.push(sp);
      if (!sp || !sp.onScreen) return;
      var col = c.confidence > 0.7 ? '#00a499' : (c.confidence > 0.45 ? '#e9a73c' : '#c8102e');
      parts.push('<circle cx="' + sp.x + '" cy="' + sp.y + '" r="13" fill="none" stroke="' + col + '" stroke-width="3"/>');
      parts.push('<circle cx="' + sp.x + '" cy="' + sp.y + '" r="3" fill="' + col + '"/>');
      parts.push('<text x="' + (sp.x + 18) + '" y="' + (sp.y + 5) + '" fill="#fff" font-size="13" font-weight="700" ' +
        'stroke="rgba(0,0,0,.5)" stroke-width="3" paint-order="stroke" ' +
        'font-family="Lato, Segoe UI, Arial, sans-serif">' + (i + 1) + '</text>');
    });

    /* The wall lines between them, so the room outline is visible in space. */
    for (var i = 0; i + 1 < screenPts.length; i++) {
      var a = screenPts[i], b = screenPts[i + 1];
      if (a && b) parts.push(edgeLine(a, b));
    }
    if (screenPts.length > 2 && step !== 'corners') {
      var f = screenPts[0], l = screenPts[screenPts.length - 1];
      if (f && l) parts.push(edgeLine(l, f));
    }

    /* Pending jamb marker. */
    if (pendingJamb) {
      var jp = planToScreen(pendingJamb.point, o);
      if (jp) parts.push('<circle cx="' + jp.x + '" cy="' + jp.y + '" r="9" fill="#e9a73c"/>');
    }

    /* Objects already placed. */
    objects.forEach(function (ob) {
      var sp = planToScreen(ob, o);
      if (!sp || !sp.onScreen) return;
      parts.push('<rect x="' + (sp.x - 9) + '" y="' + (sp.y - 9) + '" width="18" height="18" rx="3" ' +
        'fill="rgba(0,164,153,.25)" stroke="#00a499" stroke-width="2"/>');
    });

    /* Reticle. Live only — on a still frame you aim with your finger, and a
       crosshair in the middle of the picture is just clutter. */
    if (!reviewing()) {
      var cx = ox + W / 2, cy = oy + H / 2;
      var aimOk = horizonY == null || (H / 2) > horizonY + 10;
      var ret = aimOk ? '#ffffff' : '#e9a73c';
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="17" fill="none" stroke="' + ret + '" stroke-width="1.5" opacity=".85"/>');
      parts.push('<line x1="' + (cx - 26) + '" y1="' + cy + '" x2="' + (cx - 8) + '" y2="' + cy + '" stroke="' + ret + '" stroke-width="1.5"/>');
      parts.push('<line x1="' + (cx + 8) + '" y1="' + cy + '" x2="' + (cx + 26) + '" y2="' + cy + '" stroke="' + ret + '" stroke-width="1.5"/>');
      parts.push('<line x1="' + cx + '" y1="' + (cy - 26) + '" x2="' + cx + '" y2="' + (cy - 8) + '" stroke="' + ret + '" stroke-width="1.5"/>');
      parts.push('<line x1="' + cx + '" y1="' + (cy + 8) + '" x2="' + cx + '" y2="' + (cy + 26) + '" stroke="' + ret + '" stroke-width="1.5"/>');
    }

    /* Live plan mini-map, pinned to the element rather than the picture. */
    parts.push(miniMap(full.width, full.height));

    el.overlay.setAttribute('viewBox', '0 0 ' + full.width + ' ' + full.height);
    el.overlay.innerHTML = parts.join('');

    /* Stats line. */
    if (el.stats) {
      var sw = RS.Sweep.status();
      var q = Math.round(state.quality * 100);
      var line =
        '<span>corners <b>' + corners.length + '</b></span>' +
        '<span>openings <b>' + openings.length + '</b></span>' +
        '<span>items <b>' + objects.length + '</b></span>';
      if (mode === 'sweep' && sw.state === 'recording') {
        line = '<span>recording <b>' + sw.seconds.toFixed(0) + 's</b></span>' +
               '<span>frames <b>' + sw.count + '</b></span>' +
               '<span>turned <b>' + sw.swept + '°</b></span>';
      } else if (reviewing()) {
        line += '<span>frame <b>' + (sw.index + 1) + '/' + sw.count + '</b></span>';
      } else {
        line += '<span>signal <b>' + (state.live ? q + '%' : 'none') + '</b></span>';
      }
      line += '<span>h <b>' + opts.cameraHeight.toFixed(2) + ' m</b></span>';
      el.stats.innerHTML = line;
    }

    /* Show the captured frame under the overlay while reviewing. */
    if (el.frame) {
      var f = reviewing() ? RS.Sweep.current() : null;
      if (f) {
        if (el.frame.getAttribute('src') !== f.url) el.frame.setAttribute('src', f.url);
        el.frame.style.display = 'block';
      } else {
        el.frame.style.display = 'none';
      }
    }
  }

  function edgeLine(a, b) {
    return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
      '" stroke="rgba(0,164,153,.85)" stroke-width="2.5"/>';
  }

  /* Screen y where the ray pitch is exactly horizontal. */
  function horizonScreenY(o) {
    var orient = currentOrient();
    if (!orient) return null;
    var t = RC.visibleTangents(o);
    /* Search vertically for the sign change in the world z of the ray. */
    var prev = null;
    for (var i = 0; i <= 40; i++) {
      var y = (i / 40) * o.elemHeight;
      var ny = (y / o.elemHeight) * 2 - 1;
      var dCam = { x: 0, y: -ny * t.ty, z: -1 };
      var dDev = O.rotateForScreen(dCam, orient.screenAngle);
      var w = O.applyMatrix(orient.matrix, dDev);
      if (prev !== null && (prev.z < 0) !== (w.z < 0)) {
        var f = prev.z / (prev.z - w.z);
        return ((i - 1) / 40 + f / 40) * o.elemHeight;
      }
      prev = w;
    }
    return null;
  }

  function miniMap(W, H) {
    var size = Math.min(120, W * 0.28);
    var pad = 12;
    var x0 = W - size - pad, y0 = pad + 54;
    var s = '<g class="rs-minimap">';
    s += '<rect x="' + x0 + '" y="' + y0 + '" width="' + size + '" height="' + size +
      '" rx="6" fill="rgba(0,29,24,.55)" stroke="rgba(255,255,255,.25)"/>';
    if (corners.length) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      corners.concat([{ x: 0, y: 0 }]).forEach(function (p) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
      var span = Math.max(maxX - minX, maxY - minY, 1) * 1.18;
      var cxm = (minX + maxX) / 2, cym = (minY + maxY) / 2;
      var k = (size - 16) / span;
      function map(p) {
        return { x: x0 + size / 2 + (p.x - cxm) * k, y: y0 + size / 2 + (p.y - cym) * k };
      }
      var d = corners.map(function (p, i) {
        var q = map(p);
        return (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1);
      }).join(' ');
      if (corners.length > 2) d += ' Z';
      s += '<path d="' + d + '" fill="rgba(0,164,153,.22)" stroke="#00a499" stroke-width="1.6"/>';
      corners.forEach(function (p) {
        var q = map(p);
        s += '<circle cx="' + q.x.toFixed(1) + '" cy="' + q.y.toFixed(1) + '" r="2.6" fill="#fff"/>';
      });
      var st0 = map({ x: 0, y: 0 });
      s += '<circle cx="' + st0.x.toFixed(1) + '" cy="' + st0.y.toFixed(1) + '" r="3.4" fill="none" stroke="#fff" stroke-width="1.4"/>';
    } else {
      s += '<text x="' + (x0 + size / 2) + '" y="' + (y0 + size / 2) + '" fill="rgba(255,255,255,.6)" ' +
        'font-size="11" text-anchor="middle" font-family="Lato, Segoe UI, Arial, sans-serif">plan</text>';
    }
    s += '</g>';
    return s;
  }

  /* -- Tap handling --------------------------------------------------------- */

  function onTap(ev) {
    if (!active) return;
    if (mode === 'sweep' && RS.Sweep.state !== 'review') {
      RS.UI.toast(RS.Sweep.state === 'recording'
        ? 'Keep turning — press Stop when you have been all the way round.'
        : 'Press Record and turn slowly on the spot first.', 'warn');
      return;
    }

    var rect = el.overlay.getBoundingClientRect();
    var o = projOpts();
    /* Taps are measured from the corner of the picture, not the corner of the
       screen, so the letterbox bars either side of a review frame do not shift
       every angle. */
    var tap = {
      x: ev.clientX - rect.left - (o.left || 0),
      y: ev.clientY - rect.top - (o.top || 0)
    };
    var orient = currentOrient();

    if (!orient || (!reviewing() && !O.getState().live)) {
      RS.UI.toast('No orientation data yet — hold the phone still for a moment, or use manual entry.', 'warn');
      return;
    }
    if (tap.x < 0 || tap.y < 0 || tap.x > o.elemWidth || tap.y > o.elemHeight) {
      return;   /* tapped the letterbox, not the picture */
    }

    if (step === 'corners') {
      var p = RC.floorPoint(tap, orient, o);
      if (!p) {
        RS.UI.toast('Aim below the horizon, at the point where the wall meets the floor.', 'warn');
        return;
      }
      corners.push({ x: p.x, y: p.y, confidence: p.confidence, range: p.range, tap: tap, orient: orient });
      rebuildDraft();
      renderChrome();
    } else if (step === 'openings') {
      if (!draftRoom) return;
      var dir = RC.bearingVector(tap, orient, o);
      if (!dir) return;
      var hit = RC.bearingToWall(draftRoom, dir);
      if (!hit) {
        RS.UI.toast('That direction does not cross a wall of the room.', 'warn');
        return;
      }
      if (!pendingJamb) {
        pendingJamb = { dir: dir, point: hit.point };
        RS.UI.toast('Now tap the other side of the ' + S.OPENING_TYPES[subType].label.toLowerCase() + '.');
      } else {
        var span = RC.openingFromBearings(draftRoom, pendingJamb.dir, dir);
        pendingJamb = null;
        if (!span) { RS.UI.toast('Could not resolve that opening — try again.', 'warn'); return; }
        openings.push({
          type: subType,
          wallIndex: span.wallIndex,
          offset: span.offset,
          width: span.width,
          confidence: 0.8
        });
        renderChrome();
      }
    } else if (step === 'objects') {
      var fp = RC.floorPoint(tap, orient, o);
      if (!fp) {
        RS.UI.toast('Aim at the floor in front of the item.', 'warn');
        return;
      }
      var def = S.OBJECTS[objType];
      objects.push({
        type: objType, x: fp.x, y: fp.y, rot: 0,
        w: def.w, d: def.d, confidence: Math.min(0.85, fp.confidence)
      });
      renderChrome();
    }
  }

  function rebuildDraft() {
    if (corners.length < 3) { draftRoom = null; return; }
    draftRoom = S.newRoom('Draft');
    corners.forEach(function (c) { draftRoom.points.push(S.newPoint(c.x, c.y, c.confidence)); });
    S.syncWalls(draftRoom);
  }

  /* -- Step chrome ---------------------------------------------------------- */

  var SWEEP_TEXT = {
    idle: {
      title: 'Record a sweep',
      body: 'Stand in the middle of the room. Press Record and turn slowly all the way round, keeping the wall-floor line in shot. Press Stop, then tap the corners on the still pictures — no rush, and you can zoom in.'
    },
    recording: {
      title: 'Turn slowly on the spot',
      body: 'Do not walk — turn where you stand. Keep the bottom of the walls in frame. Around five seconds per wall is plenty.'
    },
    review: {
      title: 'Now tap the corners',
      body: 'Slide through the frames to find each corner, then tap where the wall meets the floor. Markers stay put as you scrub, so you can check each one from a different frame.'
    }
  };

  var STEP_TEXT = {
    corners: {
      title: 'Tap each corner',
      body: 'Stand roughly in the middle of the room and stay put. Tap where each wall meets the floor, going round in order. Three corners minimum; tap the fourth wall corner too for a rectangular room.'
    },
    openings: {
      title: 'Doors and windows',
      body: 'Tap one side of the opening, then the other. Height does not matter here — aim at either jamb.'
    },
    objects: {
      title: 'Furniture and fixtures',
      body: 'Choose an item, then tap the floor at its centre. Sizes come from a standard catalogue and can be adjusted later.'
    }
  };

  function renderChrome() {
    var sw = RS.Sweep.status();
    var inSweepSetup = mode === 'sweep' && sw.state !== 'review';

    /* Before there are frames to tap, the sweep instructions replace the step
       instructions entirely — there is nothing else to do yet. */
    var t = inSweepSetup ? SWEEP_TEXT[sw.state]
          : (mode === 'sweep' && step === 'corners' ? SWEEP_TEXT.review : STEP_TEXT[step]);
    if (el.stepTitle) el.stepTitle.textContent = t.title;
    if (el.instruct) el.instruct.textContent = t.body;

    /* Mode pills. */
    if (el.modePills) {
      el.modePills.querySelectorAll('[data-mode]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode);
      });
      el.modePills.style.display = sw.state === 'recording' ? 'none' : 'flex';
    }

    /* Scrubber, only once there are frames. */
    if (el.scrub) {
      el.scrub.style.display = reviewing() ? 'flex' : 'none';
      if (reviewing() && el.scrubber) {
        el.scrubber.max = String(Math.max(0, sw.count - 1));
        if (Number(el.scrubber.value) !== sw.index) el.scrubber.value = String(sw.index);
        if (el.scrubLabel) {
          el.scrubLabel.textContent = 'Frame ' + (sw.index + 1) + ' of ' + sw.count;
        }
      }
    }

    /* The step pills are meaningless until there are frames to tap on. */
    if (el.stepPills) el.stepPills.style.display = inSweepSetup ? 'none' : 'flex';

    /* Sub-type pills. */
    if (el.subtypes) {
      var html = '';
      if (step === 'openings') {
        Object.keys(S.OPENING_TYPES).forEach(function (k) {
          html += '<button type="button" data-subtype="' + k + '" aria-pressed="' + (subType === k) + '">' +
            S.OPENING_TYPES[k].label + '</button>';
        });
      } else if (step === 'objects') {
        var common = ['bed_double', 'wardrobe', 'sofa_3', 'dining_table', 'toilet', 'basin', 'shower', 'bath',
                      'counter', 'ksink', 'fridge', 'radiator'];
        common.forEach(function (k) {
          html += '<button type="button" data-objtype="' + k + '" aria-pressed="' + (objType === k) + '">' +
            S.OBJECTS[k].label + '</button>';
        });
      }
      el.subtypes.innerHTML = html;
      el.subtypes.style.display = html ? 'flex' : 'none';
    }

    /* Actions. */
    if (el.actions) {
      var a = '';

      /* Sweep mode owns the action bar until there are frames to work with. */
      if (inSweepSetup) {
        if (sw.state === 'recording') {
          a += '<button type="button" class="btn btn-lg btn-recording" data-act="sweep-stop">Stop (' +
               sw.seconds.toFixed(0) + 's)</button>';
          a += '<button type="button" class="btn btn-sm" data-act="height">Height ' +
               opts.cameraHeight.toFixed(2) + ' m</button>';
        } else {
          a += '<button type="button" class="btn btn-lg btn-record" data-act="sweep-start">Record</button>';
          a += '<button type="button" class="btn btn-sm" data-act="height">Height ' +
               opts.cameraHeight.toFixed(2) + ' m</button>';
          a += '<button type="button" class="btn btn-sm" data-act="checkup">Check setup</button>';
        }
        el.actions.innerHTML = a;
        return;
      }

      if (reviewing()) {
        a += '<button type="button" class="btn btn-sm" data-act="sweep-again">Re-record</button>';
      }
      a += '<button type="button" class="btn btn-sm" data-act="undo"' + (canUndo() ? '' : ' disabled') + '>Undo tap</button>';
      if (step === 'corners') {
        a += '<button type="button" class="btn btn-sm" data-act="height">Height ' + opts.cameraHeight.toFixed(2) + ' m</button>';
        if (corners.length >= 4) {
          a += '<button type="button" class="btn btn-sm" data-act="calib">Solve lens</button>';
        }
        a += '<button type="button" class="btn btn-accent btn-sm" data-act="next"' + (corners.length >= 3 ? '' : ' disabled') +
             '>Close room (' + corners.length + ')</button>';
      } else if (step === 'openings') {
        a += '<button type="button" class="btn btn-sm" data-act="back">Back</button>';
        a += '<button type="button" class="btn btn-accent btn-sm" data-act="next">Next</button>';
      } else {
        a += '<button type="button" class="btn btn-sm" data-act="back">Back</button>';
        if (RS.AI.spaceEnabled()) {
          a += '<button type="button" class="btn btn-sm" data-act="detect">Detect items</button>';
        }
        a += '<button type="button" class="btn btn-primary btn-sm" data-act="finish">Finish scan</button>';
      }
      el.actions.innerHTML = a;
    }
  }

  function canUndo() {
    if (step === 'corners') return corners.length > 0;
    if (step === 'openings') return openings.length > 0 || !!pendingJamb;
    return objects.length > 0;
  }

  function undoTap() {
    if (step === 'corners') { corners.pop(); rebuildDraft(); }
    else if (step === 'openings') { if (pendingJamb) pendingJamb = null; else openings.pop(); }
    else objects.pop();
    renderChrome();
  }

  function setStep(s) {
    if (s === 'openings' && corners.length < 3) {
      RS.UI.toast('Capture at least three corners first.', 'warn');
      return;
    }
    step = s;
    pendingJamb = null;
    rebuildDraft();
    renderChrome();
  }

  function setSubType(t) { subType = t; renderChrome(); }
  function setObjType(t) { objType = t; renderChrome(); }

  /* -- Sweep controls ------------------------------------------------------- */

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    if (m === 'live') RS.Sweep.reset();
    renderChrome();
  }

  function sweepStart() {
    if (!O.getState().live) {
      RS.UI.toast('Waiting for the motion sensor — hold the phone still for a second, then press Record again.', 'warn');
      return;
    }
    if (!el.video.videoWidth) {
      RS.UI.toast('The camera has not started yet.', 'warn');
      return;
    }
    RS.Sweep.start(el.video);
    renderChrome();
  }

  function sweepStop() {
    RS.Sweep.stop(function (sw) {
      if (!sw.count) {
        /* Say which thing failed. "Check your permissions" is what you write
           when you did not bother to find out. */
        var why;
        if (sw.skipped.noVideo && !sw.skipped.noPose) {
          why = 'the camera produced no picture. Check that no other app is using it, then reopen this page.';
        } else if (sw.skipped.noPose && !sw.skipped.noVideo) {
          why = 'the phone stopped reporting its orientation. Tap "Check setup" to see whether motion access was allowed.';
        } else if (sw.skipped.encodeFailed) {
          why = 'the frames could not be saved — the phone may be low on memory. Close some tabs and try a shorter sweep.';
        } else if (sw.skipped.noVideo && sw.skipped.noPose) {
          why = 'neither the camera nor the motion sensor produced anything. Tap "Check setup".';
        } else {
          why = 'no frames were grabbed at all. Tap "Check setup" to see what is missing.';
        }
        RS.UI.toast('Nothing was captured — ' + why, 'error');
      } else {
        step = 'corners';
        RS.UI.toast(sw.count + ' frames over ' + sw.swept + '°. Now slide through them and tap each corner.');
        if (sw.swept < 200) {
          RS.UI.toast('You only turned about ' + sw.swept + '°. If a corner is missing, re-record and go the whole way round.', 'warn');
        }
      }
      renderChrome();
    });
    renderChrome();
  }

  /* -- Setup diagnosis ------------------------------------------------------
     Everything that has to be true for a scan to work, and which of them is
     not. Replaces guessing at permission dialogs that never appeared. */
  function diagnose() {
    var os = O.getState();
    var secure = window.isSecureContext;
    var proto = location.protocol;
    var hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    var track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;

    return {
      secureContext: secure,
      protocol: proto,
      host: location.hostname,
      cameraApi: hasMedia,
      cameraStream: !!stream,
      cameraLive: !!(track && track.readyState === 'live'),
      cameraLabel: track ? (track.label || 'camera') : null,
      videoSize: el.video ? [el.video.videoWidth, el.video.videoHeight] : [0, 0],
      lastCameraError: cameraErrorMessage,
      cameraErrorName: cameraErrorName,
      motionSupported: os.supported,
      motionListening: os.listening,
      motionNeedsPermission: os.needsPermission,
      motionSamples: os.sampleCount,
      motionLive: os.live,
      steadiness: os.quality
    };
  }

  /* Ask for motion access again. iOS only ever shows this dialog from inside a
     real user gesture, so it has to be reachable from a button. */
  function requestMotion() {
    return O.requestPermission().then(function (r) {
      if (r === 'granted') { O.start(); }
      return r;
    });
  }

  function sweepAgain() {
    if (corners.length || openings.length || objects.length) {
      RS.UI.toast('Re-recording keeps the corners you have already placed.');
    }
    RS.Sweep.reset();
    renderChrome();
  }

  function sweepSeek(i) { RS.Sweep.seek(i); renderChrome(); }
  function sweepStep(d) { RS.Sweep.step(d); renderChrome(); }

  function setHeight(m) {
    opts.cameraHeight = G.clamp(Number(m) || 1.45, 0.6, 2.4);
    Store.saveSettings({ cameraHeight: opts.cameraHeight });
    /* Height is a pure scale factor, so already-captured corners can simply
       be rescaled rather than recaptured. */
    renderChrome();
  }

  function currentState() {
    return { step: step, corners: corners.length, openings: openings.length, objects: objects.length };
  }

  /* -- Commit --------------------------------------------------------------- */

  function finish(name, type) {
    if (corners.length < 3) {
      RS.UI.toast('A room needs at least three corners.', 'warn');
      return null;
    }
    var room = S.newRoom(name || 'Scanned room', type || 'other');
    room.capture.method = 'station';
    room.capture.cameraHeight = opts.cameraHeight;
    room.capture.fovDeg = opts.fovDeg;
    room.capture.capturedAt = Date.now();

    corners.forEach(function (c) { room.points.push(S.newPoint(c.x, c.y, c.confidence)); });
    S.syncWalls(room);

    /* Rooms are overwhelmingly rectilinear; regularise before anything else
       consumes the geometry. The user can undo it in one keystroke. */
    if (Store.getSettings().autoSquare) {
      var squared = G.squareUp(room.points, 14, 80);
      squared.forEach(function (p, i) { room.points[i].x = p.x; room.points[i].y = p.y; });
    }

    openings.forEach(function (o) {
      if (o.wallIndex >= room.points.length) return;
      var op = S.newOpening(o.type, o.wallIndex, o.offset);
      op.width = G.clamp(o.width, 0.3, 6);
      op.confidence = o.confidence;
      room.openings.push(op);
    });

    objects.forEach(function (o) {
      var ob = S.newObject(o.type, o.x, o.y, o.rot);
      ob.confidence = o.confidence;
      var snap = G.snapObjectToWall(room, ob, 0.7);
      if (snap) { ob.x = snap.x; ob.y = snap.y; ob.rot = snap.rot; }
      room.objects.push(ob);
    });

    return room;
  }

  /* -- Optional Tier 1 detection -------------------------------------------
     Grab one frame together with the pose at that instant, ask the Space what
     is in it, and convert each detection through the same ray-cast a tap uses.
     Failure here is a non-event: the user carries on tapping. */
  function runDetection() {
    if (!RS.AI.spaceEnabled()) {
      RS.UI.toast('No detection service is configured — add one in Settings.', 'warn');
      return Promise.resolve(0);
    }
    var orient = currentOrient();
    var o = projOpts();
    if (!orient) {
      RS.UI.toast('No pose for this frame yet.', 'warn');
      return Promise.resolve(0);
    }
    var frame;
    try {
      /* In review the frame on screen is the one to send, together with the
         pose recorded alongside it — not whatever the camera happens to be
         pointing at now. */
      frame = reviewing()
        ? RS.AI.frameFromImage(el.frame, 768)
        : RS.AI.frameFromVideo(el.video, 768);
    } catch (e) {
      RS.UI.toast(e.message, 'error');
      return Promise.resolve(0);
    }
    RS.UI.toast('Sending one 768 px frame for detection. First call after a sleep can take a minute.');
    return RS.AI.detectObjects(frame, o.fovDeg)
      .then(function (res) {
        var placed = RS.AI.detectionsToPlacements(res, orient, o);
        placed.forEach(function (p) {
          var def = S.OBJECTS[p.type];
          objects.push({ type: p.type, x: p.x, y: p.y, rot: 0, w: def.w, d: def.d, confidence: p.confidence });
        });
        renderChrome();
        RS.UI.toast(placed.length
          ? placed.length + ' item(s) suggested — each one is marked unconfirmed until you check it.'
          : 'Nothing recognised in that frame.');
        return placed.length;
      })
      .catch(function (e) {
        RS.UI.toast('Detection failed: ' + e.message + ' Carry on tapping.', 'error');
        return 0;
      });
  }

  /* Try to solve the field of view from the captured taps, using the
     rectilinearity of the room as the objective. */
  function autoCalibrate() {
    if (corners.length < 4) {
      RS.UI.toast('Capture at least four corners before auto-calibrating.', 'warn');
      return null;
    }
    var taps = corners.map(function (c) { return c.tap; });
    var orients = corners.map(function (c) { return c.orient; });
    var res = RC.autoCalibrateFov(taps, orients, projOpts());
    if (!res) { RS.UI.toast('Auto-calibration could not find a fit.', 'warn'); return null; }
    var before = RC.rectilinearityCost(corners);
    if (res.cost > before - 0.15) {
      RS.UI.toast('The current field of view already fits well (' + before.toFixed(1) + '° off square).');
      return null;
    }
    opts.fovDeg = res.fovDeg;
    Store.saveSettings({ fovDeg: res.fovDeg });
    res.points.forEach(function (p, i) {
      corners[i].x = p.x; corners[i].y = p.y; corners[i].confidence = p.confidence;
    });
    rebuildDraft();
    renderChrome();
    RS.UI.toast('Field of view solved: ' + res.fovDeg.toFixed(1) + '°, squareness ' +
      before.toFixed(1) + '° → ' + res.cost.toFixed(1) + '°.');
    return res;
  }

  return {
    init: init, start: start, stop: stop,
    undoTap: undoTap, setStep: setStep, setSubType: setSubType, setObjType: setObjType,
    setHeight: setHeight, finish: finish, autoCalibrate: autoCalibrate,
    runDetection: runDetection,
    setMode: setMode, sweepStart: sweepStart, sweepStop: sweepStop,
    diagnose: diagnose, requestMotion: requestMotion,
    sweepAgain: sweepAgain, sweepSeek: sweepSeek, sweepStep: sweepStep,
    reviewing: reviewing,
    get mode() { return mode; },
    currentState: currentState,
    get corners() { return corners; },
    get options() { return opts; }
  };
})();
