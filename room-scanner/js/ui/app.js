/* ---------------------------------------------------------------------------
   UI wiring: screens, toolbar, inspector, modals, keyboard.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.UI = (function () {
  'use strict';

  var S = RS.Schema, G = RS.Geom, Store = RS.Store, Ed = RS.Editor;
  var el = {};
  var screen = 'projects';

  /* -- Icons ---------------------------------------------------------------- */
  var ICON = {
    select: '<path d="M4 2l14 8-6 1.6L9.6 18z"/>',
    door: '<path d="M4 3h9v14H4z"/><path d="M13 17a10 10 0 00-9-10"/><circle cx="10.6" cy="10.5" r=".9"/>',
    window: '<path d="M2 6h16v8H2z"/><path d="M10 6v8M2 10h16"/>',
    opening: '<path d="M2 5h4M14 5h4M4 5v10M16 5v10M2 15h4M14 15h4"/>',
    object: '<path d="M3 7h14v9H3z"/><path d="M3 11h14M7 7V4h6v3"/>',
    measure: '<path d="M2 12L12 2l6 6L8 18z"/><path d="M6 8l1.6 1.6M9 5l1.6 1.6M12 11l1.6 1.6"/>',
    del: '<path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12"/>',
    pan: '<path d="M10 2v8M2 10h8M10 10l6 6M10 10v7M10 10H3"/>',
    undo: '<path d="M7 5L3 9l4 4"/><path d="M3 9h8a5 5 0 010 10H8"/>',
    redo: '<path d="M13 5l4 4-4 4"/><path d="M17 9H9a5 5 0 000 10h3"/>',
    square: '<path d="M3 3h14v14H3z"/><path d="M3 7h14M7 3v14"/>',
    fit: '<path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4"/>'
  };

  function icon(name, size) {
    return '<svg viewBox="0 0 20 20" width="' + (size || 20) + '" height="' + (size || 20) +
      '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
      'stroke-linejoin="round">' + (ICON[name] || '') + '</svg>';
  }

  /* -- Boot ----------------------------------------------------------------- */

  function init() {
    el.appbar = document.querySelector('.appbar');
    el.screens = {
      projects: document.getElementById('screen-projects'),
      scan: document.getElementById('screen-scan'),
      plan: document.getElementById('screen-plan')
    };
    el.projectList = document.getElementById('project-list');
    el.toolbar = document.getElementById('toolbar');
    el.canvasBar = document.getElementById('canvas-bar');
    el.canvasHost = document.getElementById('canvas-host');
    el.inspector = document.getElementById('inspector');
    el.modalBackdrop = document.getElementById('modal-backdrop');
    el.modal = document.getElementById('modal');
    el.toasts = document.getElementById('toasts');

    Store.loadSettings();

    RS.Scan.init({
      video: document.getElementById('scan-video'),
      frame: document.getElementById('scan-frame'),
      overlay: document.getElementById('scan-overlay'),
      stepTitle: document.getElementById('scan-step-title'),
      instruct: document.getElementById('scan-instruct'),
      stats: document.getElementById('scan-stats'),
      actions: document.getElementById('scan-actions'),
      subtypes: document.getElementById('scan-subtypes'),
      modePills: document.getElementById('scan-mode'),
      stepPills: document.getElementById('scan-steps'),
      scrub: document.getElementById('scan-scrub'),
      scrubber: document.getElementById('scan-scrubber'),
      scrubLabel: document.getElementById('scrub-label'),
      cameraError: document.getElementById('scan-camera-error')
    });

    bindAppbar();
    bindScanChrome();
    Ed.mount(el.canvasHost, { onChange: function () { /* renderer settled */ } });

    Store.subscribe(function (st, reason) {
      if (reason === 'projects' || reason === 'saved') renderProjects();
      renderInspector();
      renderToolbar();
      renderCanvasBar();
    });

    document.addEventListener('keydown', onKey);
    el.modalBackdrop.addEventListener('click', function (e) {
      if (e.target === el.modalBackdrop) closeModal();
    });

    /* Site branding lives in the repository so it reaches every device, not
       just the one the logo was chosen on. It is optional and never blocks
       startup. */
    RS.Brand.load().then(function () {
      applyBrandToChrome();
      renderInspector();
    });

    renderProjects();
    show('projects');

    if (!Store.listProjects().length) {
      /* First run: give them something to look at rather than a blank page. */
      loadSample();
    }
  }

  /* Put the configured logo into the app bar, not only into exports. The chip
     turns white because organisation logos are drawn for a white ground and
     would be illegible on the green bar. */
  function applyBrandToChrome() {
    var brand = RS.Brand.effective();
    var mark = document.getElementById('brand-mark');
    if (!mark) return;
    if (brand.logoDataUrl) {
      mark.classList.add('has-logo');
      mark.innerHTML = '<img src="' + escapeHtml(brand.logoDataUrl) + '" alt="">';
      mark.setAttribute('aria-hidden', 'true');
    } else {
      mark.classList.remove('has-logo');
    }
    if (brand.orgName) {
      var sub = document.querySelector('.appbar .subtitle');
      if (sub) sub.textContent = brand.orgName;
    }
  }

  /* -- Screens --------------------------------------------------------------- */

  function show(name) {
    if (screen === 'scan' && name !== 'scan') RS.Scan.stop();
    screen = name;
    Object.keys(el.screens).forEach(function (k) {
      el.screens[k].classList.toggle('active', k === name);
    });
    document.getElementById('btn-scan').style.display = name === 'scan' ? 'none' : '';
    if (name === 'plan') {
      renderToolbar(); renderCanvasBar(); renderInspector();
      Ed.render(); Ed.zoomToFit();
    }
    if (name === 'projects') renderProjects();
  }

  function bindAppbar() {
    document.getElementById('btn-projects').onclick = function () { show('projects'); };
    document.getElementById('btn-scan').onclick = startScan;
    document.getElementById('btn-export').onclick = exportModal;
    document.getElementById('btn-settings').onclick = settingsModal;
    document.getElementById('btn-inspector').onclick = function () {
      el.inspector.classList.toggle('open');
    };
    document.getElementById('btn-new-project').onclick = newProject;
    document.getElementById('btn-import-project').onclick = importPicker;
    document.getElementById('zoom-in').onclick = function () { Ed.zoomBy(1 / 1.25); };
    document.getElementById('zoom-out').onclick = function () { Ed.zoomBy(1.25); };
    document.getElementById('zoom-fit').onclick = function () { Ed.zoomToFit(); };
  }

  /* -- Projects screen -------------------------------------------------------- */

  function renderProjects() {
    if (!el.projectList) return;
    var list = Store.listProjects();
    if (!list.length) {
      el.projectList.innerHTML =
        '<div class="empty" style="grid-column:1/-1">' +
        '<h3 style="margin-bottom:8px">No surveys yet</h3>' +
        '<p>Start a scan on a phone or tablet, or create a blank plan and draw it by hand.</p>' +
        '</div>';
      return;
    }
    el.projectList.innerHTML = list.map(function (p) {
      var full = Store.readProject(p.id);
      var thumb = '';
      try {
        thumb = full ? RS.Export.thumbnail(S.coerceProject(full)) : '';
      } catch (e) { thumb = ''; }
      return '<div class="card" data-id="' + p.id + '">' +
        '<div class="thumb" data-open="' + p.id + '">' + (thumb ||
          '<span class="hint">Empty plan</span>') + '</div>' +
        '<div class="body">' +
          '<div class="name" data-open="' + p.id + '">' + escapeHtml(p.name) + '</div>' +
          '<div class="meta">' + p.rooms + ' room' + (p.rooms === 1 ? '' : 's') + ' · ' +
            relTime(p.updatedAt) + '</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button class="btn btn-sm btn-ghost" data-open="' + p.id + '">Open</button>' +
          '<span style="flex:1"></span>' +
          '<button class="btn btn-sm btn-ghost btn-danger" data-del="' + p.id + '">Delete</button>' +
        '</div></div>';
    }).join('');

    el.projectList.querySelectorAll('[data-open]').forEach(function (n) {
      n.onclick = function () {
        if (Store.loadProject(n.getAttribute('data-open'))) show('plan');
      };
    });
    el.projectList.querySelectorAll('[data-del]').forEach(function (n) {
      n.onclick = function (e) {
        e.stopPropagation();
        var id = n.getAttribute('data-del');
        confirmModal('Delete this survey?', 'The plan and all its rooms will be removed from this device. This cannot be undone.', function () {
          Store.deleteProject(id);
          renderProjects();
          toast('Survey deleted.');
        });
      };
    });
  }

  function newProject() {
    promptModal('New survey', 'Name', 'Survey ' + new Date().toLocaleDateString('en-IE'), function (name) {
      Store.createProject(name);
      show('plan');
      toast('Blank plan created. Draw the outline, or start a scan.');
    });
  }

  function loadSample() {
    fetch('samples/sample-room.json')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var p = S.coerceProject(j);
        Store.setProject(p);
        Store.save();
        renderProjects();
      })
      .catch(function () {
        /* Opened straight from disk: fetch() is blocked for file:// URLs, so
           build the same worked example in memory instead. */
        var p = S.newProject('Sample survey — first floor bedroom');
        p.presentation.style = 'presentation';
        var room = S.newRoom('Bedroom 1', 'bedroom');
        room.capture.method = 'station';
        room.capture.scaleCorrected = true;
        [[0, 0], [4.2, 0], [4.2, 3.4], [0, 3.4]].forEach(function (c) {
          room.points.push(S.newPoint(c[0], c[1], 0.9));
        });
        S.syncWalls(room);
        room.walls[0].thickness = 0.30; room.walls[0].exterior = true;
        room.walls[3].thickness = 0.30; room.walls[3].exterior = true;
        room.walls[1].thickness = 0.10; room.walls[2].thickness = 0.10;
        var win = S.newOpening('window', 0, 2.10); win.width = 1.35;
        var door = S.newOpening('door', 2, 3.10);
        room.openings.push(win, door);
        [['bed_double', 2.10, 1.05, 0, 1], ['bedside', 1.20, 0.30, 0, 1],
         ['bedside', 3.00, 0.30, 0, 1], ['wardrobe', 0.35, 2.50, 90, 1],
         ['dresser', 3.65, 2.60, 90, 0.48], ['radiator', 0.06, 0.90, 90, 1]
        ].forEach(function (o) {
          var ob = S.newObject(o[0], o[1], o[2], o[3]);
          ob.confidence = o[4];
          room.objects.push(ob);
        });
        p.rooms = [room];
        Store.setProject(p);
        Store.save();
        renderProjects();
      });
  }

  /* -- Scan ------------------------------------------------------------------- */

  function startScan() {
    if (!Store.state.project) Store.createProject('Survey ' + new Date().toLocaleDateString('en-IE'));
    show('scan');
    RS.Scan.start();
  }

  function bindScanChrome() {
    document.getElementById('scan-exit').onclick = function () {
      RS.Scan.stop();
      show(Store.state.project ? 'plan' : 'projects');
    };
    document.getElementById('scan-steps').onclick = function (e) {
      var b = e.target.closest('[data-step]');
      if (!b) return;
      RS.Scan.setStep(b.getAttribute('data-step'));
      syncScanSteps();
    };
    document.getElementById('scan-mode').onclick = function (e) {
      var b = e.target.closest('[data-mode]');
      if (!b) return;
      RS.Scan.setMode(b.getAttribute('data-mode'));
    };
    document.getElementById('scan-scrubber').oninput = function (e) {
      RS.Scan.sweepSeek(Number(e.target.value));
    };
    document.getElementById('scrub-prev').onclick = function () { RS.Scan.sweepStep(-1); };
    document.getElementById('scrub-next').onclick = function () { RS.Scan.sweepStep(1); };
    document.getElementById('scan-subtypes').onclick = function (e) {
      var b = e.target.closest('[data-subtype],[data-objtype]');
      if (!b) return;
      if (b.hasAttribute('data-subtype')) RS.Scan.setSubType(b.getAttribute('data-subtype'));
      else RS.Scan.setObjType(b.getAttribute('data-objtype'));
    };
    document.getElementById('scan-actions').onclick = function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'undo') RS.Scan.undoTap();
      else if (act === 'height') heightModal();
      else if (act === 'calib') RS.Scan.autoCalibrate();
      else if (act === 'next') {
        var st = RS.Scan.currentState();
        if (st.step === 'corners') { RS.Scan.setStep('openings'); }
        else if (st.step === 'openings') { RS.Scan.setStep('objects'); }
        syncScanSteps();
      } else if (act === 'back') {
        var s2 = RS.Scan.currentState();
        RS.Scan.setStep(s2.step === 'objects' ? 'openings' : 'corners');
        syncScanSteps();
      } else if (act === 'detect') RS.Scan.runDetection();
      else if (act === 'checkup') checkupModal();
      else if (act === 'sweep-start') RS.Scan.sweepStart();
      else if (act === 'sweep-stop') RS.Scan.sweepStop();
      else if (act === 'sweep-again') RS.Scan.sweepAgain();
      else if (act === 'finish') finishScan();
    };
  }

  function syncScanSteps() {
    var cur = RS.Scan.currentState().step;
    document.querySelectorAll('#scan-steps [data-step]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-step') === cur);
    });
  }

  /* Everything that has to be true for a scan to work, and which of them is
     not. A permission dialog that never appeared is invisible; this makes it
     visible. */
  function checkupModal() {
    var d = RS.Scan.diagnose();

    function row(ok, label, detail, fatal) {
      var mark = ok ? '&#10003;' : (fatal ? '&#10007;' : '!');
      var colour = ok ? 'var(--ok, #2f6b4f)' : (fatal ? 'var(--hse-red)' : 'var(--hse-amber)');
      return '<div class="kv" style="align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--line-soft)">' +
        '<span style="display:flex;gap:8px"><b style="color:' + colour + ';width:14px">' + mark + '</b>' +
        '<span>' + label + (detail ? '<br><span class="hint">' + escapeHtml(detail) + '</span>' : '') + '</span></span></div>';
    }

    var body = '';
    body += row(d.secureContext, 'Secure connection',
      d.secureContext ? d.protocol + '//' + d.host
        : 'Page is on ' + d.protocol + '//' + d.host + '. Browsers block the camera and motion sensors unless the address starts with https, or is localhost. This is the usual reason no permission dialog ever appears.',
      !d.secureContext);
    body += row(d.cameraApi, 'Camera supported by this browser', d.cameraApi ? null : 'No getUserMedia in this browser.', true);
    body += row(d.cameraLive, 'Camera running',
      d.cameraLive ? (d.cameraLabel + ' at ' + d.videoSize[0] + '×' + d.videoSize[1])
        : (d.lastCameraError || 'The camera has not started.'), true);
    body += row(d.motionSupported, 'Motion sensor supported',
      d.motionSupported ? null : 'This device reports no orientation sensor — a desktop, usually.', true);
    body += row(d.motionLive, 'Motion sensor reporting',
      d.motionLive ? (d.motionSamples + ' readings received') :
        (d.motionSamples ? 'Readings stopped arriving.' :
          'No readings at all' + (d.motionNeedsPermission ? ' — access has not been granted.' : '.')), true);

    var canAsk = d.motionNeedsPermission && !d.motionLive;
    var buttons = [{ label: 'Close', ghost: true }];
    if (canAsk) {
      buttons.push({
        label: 'Allow motion access', primary: true, action: function () {
          RS.Scan.requestMotion().then(function (r) {
            toast(r === 'granted'
              ? 'Motion access granted. Press Record.'
              : 'Motion access was refused. On iPhone: Settings → Apps → Safari → Motion & Orientation Access, then reload.',
              r === 'granted' ? undefined : 'warn');
          });
          return false;
        }
      });
    }

    var advice = '';
    if (!d.secureContext) {
      advice = '<div class="notice error" style="margin-top:12px"><b>This is the problem.</b> ' +
        'Open the app from its <code>https://…github.io/…</code> address, not from a file or an ' +
        'http address. No permission dialog can appear on an insecure page — the browser refuses ' +
        'silently, which is exactly what you saw.</div>';
    } else if (!d.cameraLive && /NotAllowed|Security|Permission/i.test(d.cameraErrorName || '')) {
      advice = '<div class="notice warn" style="margin-top:12px">Camera access was refused earlier and the ' +
        'browser is remembering that, so it will not ask again. Tap the padlock or camera icon in the ' +
        'address bar and set the camera to Allow, then reload.</div>';
    } else if (!d.cameraLive && /NotReadable|TrackStart|NotFound/i.test(d.cameraErrorName || '')) {
      advice = '<div class="notice warn" style="margin-top:12px">Another app is holding the camera. Close it ' +
        'and reload this page.</div>';
    } else if (canAsk) {
      advice = '<div class="notice warn" style="margin-top:12px">Motion access has not been granted. iPhones only ' +
        'ask when you tap a button, so tap <b>Allow motion access</b> below.</div>';
    }

    openModal('Check setup', body + advice +
      '<p class="hint" style="margin-top:12px">All five need a tick before a sweep can record.</p>',
      buttons);
  }

  function heightModal() {
    var h = RS.Scan.options.cameraHeight;
    openModal('Camera height', '' +
      '<p>How high are you holding the phone above the floor? An approximate value is fine — ' +
      'the whole room scales linearly with it, so one measured wall corrects everything afterwards.</p>' +
      '<label class="field"><span>Height above floor (m)</span>' +
      '<input type="number" id="m-height" step="0.01" min="0.6" max="2.4" value="' + h.toFixed(2) + '"></label>' +
      '<div class="row"><button class="btn btn-sm" data-h="1.20">Waist 1.20</button>' +
      '<button class="btn btn-sm" data-h="1.45">Chest 1.45</button>' +
      '<button class="btn btn-sm" data-h="1.60">Eye 1.60</button></div>',
      [{ label: 'Cancel', ghost: true }, {
        label: 'Set height', primary: true, action: function () {
          RS.Scan.setHeight(document.getElementById('m-height').value);
          toast('Camera height set.');
        }
      }]);
    el.modal.querySelectorAll('[data-h]').forEach(function (b) {
      b.onclick = function () { document.getElementById('m-height').value = b.getAttribute('data-h'); };
    });
  }

  function finishScan() {
    var st = RS.Scan.currentState();
    if (st.corners < 3) { toast('Capture at least three corners first.', 'warn'); return; }
    var types = S.ROOM_TYPES.map(function (t) {
      return '<option value="' + t.id + '">' + t.label + '</option>';
    }).join('');
    var prev = Store.activeRoom();
    var curStorey = prev ? (prev.storey || 0) : 0;
    openModal('Finish scan', '' +
      '<label class="field"><span>Room name</span><input type="text" id="m-name" value="Room ' +
        ((Store.state.project.rooms.filter(function (r) { return r.points.length; }).length) + 1) + '"></label>' +
      '<div class="row"><label class="field" style="margin:0"><span>Room type</span>' +
        '<select id="m-type">' + types + '</select></label>' +
      '<label class="field" style="margin:0"><span>Floor</span><select id="m-storey">' +
        [-1, 0, 1, 2, 3].map(function (n) {
          return opt(String(n), S.storeyName(n), String(curStorey));
        }).join('') + '</select></label></div>' +
      '<div class="notice">Captured ' + st.corners + ' corners, ' + st.openings + ' openings and ' +
        st.objects + ' items. You will be asked for one measured wall length next — that is what ' +
        'turns the shape into accurate dimensions.</div>',
      [{ label: 'Keep scanning', ghost: true }, {
        label: 'Create plan', primary: true, action: function () {
          var name = document.getElementById('m-name').value;
          var type = document.getElementById('m-type').value;
          var room = RS.Scan.finish(name, type);
          if (!room) return;
          room.storey = Number(document.getElementById('m-storey').value) || 0;
          RS.Scan.stop();
          Store.do('Add scanned room', function (p) {
            /* Drop the placeholder empty room the project was created with. */
            p.rooms = p.rooms.filter(function (r) { return r.points.length >= 3; });
            /* Every scan comes back centred on its own standing position, so a
               second room would land on top of the first. Park it clear to the
               right; joining it through a shared door then places it properly. */
            var right = -Infinity;
            S.roomsOnStorey(p, room.storey).forEach(function (r) {
              right = Math.max(right, S.bounds(r).maxX);
            });
            if (isFinite(right)) {
              var b = S.bounds(room);
              G.translateRoom(room, right + 2.0 - b.minX, -b.minY);
            } else {
              room.placed = true;      // first room on the floor defines the frame
            }
            p.rooms.push(room);
          });
          Store.setActiveRoom(room.id);
          show('plan');
          setTimeout(function () { scaleModal(function () { offerJoin(room); }); }, 350);
        }
      }]);
  }

  /* -- Scale correction -------------------------------------------------------- */

  /* After a scan, a newly placed room that is not the first on its floor is
     floating beside the others. Offer the join straight away — it is the one
     step people forget, and the plan is wrong-looking until it is done. */
  function offerJoin(room) {
    var p = Store.state.project;
    var others = S.roomsOnStorey(p, room.storey || 0)
      .filter(function (r) { return r.id !== room.id && r.points.length >= 3; });
    var doors = room.openings.filter(function (o) { return o.type !== 'window' && o.type !== 'patio'; });
    if (!others.length) return;
    if (!doors.length) {
      toast('Add the door you walked through, then you can join this room to the rest of the floor.', 'warn');
      return;
    }
    setTimeout(function () { connectModal(room); }, 260);
  }

  function scaleModal(onDone) {
    var room = Store.activeRoom();
    if (!room || room.points.length < 3) { if (onDone) onDone(); return; }
    var opts = room.points.map(function (p, i) {
      return '<option value="' + i + '">Wall ' + (i + 1) + ' — currently ' +
        S.wallLength(room, i).toFixed(2) + ' m</option>';
    }).join('');
    openModal('Set the scale', '' +
      '<p>Measure <b>one</b> wall with a tape and type it in. Every corner scales by the same ' +
      'factor, so this single number corrects the whole room — and tells us what your camera ' +
      'height really was.</p>' +
      '<label class="field"><span>Which wall did you measure?</span><select id="m-wall">' + opts + '</select></label>' +
      '<label class="field"><span>Measured length (m)</span>' +
      '<input type="number" id="m-len" step="0.01" min="0.2" placeholder="e.g. 3.62"></label>' +
      '<p class="hint">Skip this and the plan stays proportionally correct but its absolute ' +
      'dimensions are only as good as the camera-height guess.</p>',
      [{ label: 'Skip', ghost: true, action: function () { if (onDone) onDone(); } }, {
        label: 'Apply scale', primary: true, action: function () {
          var wi = Number(document.getElementById('m-wall').value);
          var v = Number(document.getElementById('m-len').value);
          if (!(v > 0.1)) { toast('Enter the measured length in metres.', 'warn'); return false; }
          var res;
          Store.do('Correct scale', function () {
            res = RS.Raycast.calibrateFromKnownLength(room, wi, v);
          });
          if (res) {
            Ed.zoomToFit();
            toast('Scaled by ×' + res.factor.toFixed(3) + '. Implied camera height ' +
              res.impliedHeight.toFixed(2) + ' m.');
          }
          if (onDone) onDone();
        }
      }]);
  }

  /* -- Toolbar ----------------------------------------------------------------- */

  var TOOLS = [
    { id: 'select', icon: 'select', label: 'Select and edit (V)' },
    { id: 'door', icon: 'door', label: 'Add a door (D)' },
    { id: 'window', icon: 'window', label: 'Add a window (W)' },
    { id: 'opening', icon: 'opening', label: 'Add an open span (O)' },
    { id: 'measure', icon: 'measure', label: 'Measure (M)' },
    { id: 'delete', icon: 'del', label: 'Delete by click (X)' },
    { id: 'pan', icon: 'pan', label: 'Pan (space)' }
  ];

  function renderToolbar() {
    if (!el.toolbar || screen !== 'plan') return;
    el.toolbar.innerHTML = TOOLS.map(function (t) {
      return '<button class="tool" data-tool="' + t.id + '" title="' + t.label + '" ' +
        'aria-pressed="' + (Store.state.tool === t.id) + '" aria-label="' + t.label + '">' +
        icon(t.icon) + '</button>';
    }).join('') +
      '<div class="tool-sep"></div>' +
      '<button class="tool" data-cmd="square" title="Square up the outline">' + icon('square') + '</button>' +
      '<button class="tool" data-cmd="fit" title="Zoom to fit (F)">' + icon('fit') + '</button>' +
      '<div class="tool-sep"></div>' +
      '<button class="tool" data-cmd="undo" title="Undo (Ctrl+Z)"' + (Store.canUndo() ? '' : ' disabled') + '>' + icon('undo') + '</button>' +
      '<button class="tool" data-cmd="redo" title="Redo (Ctrl+Y)"' + (Store.canRedo() ? '' : ' disabled') + '>' + icon('redo') + '</button>';

    el.toolbar.querySelectorAll('[data-tool]').forEach(function (b) {
      b.onclick = function () {
        Store.setTool(b.getAttribute('data-tool'));
        Ed.clearMeasure();
      };
    });
    el.toolbar.querySelectorAll('[data-cmd]').forEach(function (b) {
      b.onclick = function () {
        var c = b.getAttribute('data-cmd');
        if (c === 'undo') { var l = Store.undo(); if (l) toast('Undid: ' + l); }
        else if (c === 'redo') { var r = Store.redo(); if (r) toast('Redid: ' + r); }
        else if (c === 'fit') Ed.zoomToFit();
        else if (c === 'square') Ed.squareUpRoom();
      };
    });
  }

  function renderCanvasBar() {
    if (!el.canvasBar || screen !== 'plan' || !Store.state.project) return;
    var p = Store.state.project;
    var active = Store.activeRoom();
    var storey = active ? (active.storey || 0) : 0;
    var storeyList = S.storeys(p);
    if (storeyList.indexOf(storey) < 0) storeyList.push(storey);

    var storeyOpts = storeyList.sort(function (a, b) { return a - b; }).map(function (n) {
      return '<option value="' + n + '"' + (n === storey ? ' selected' : '') + '>' +
        escapeHtml(S.storeyName(n)) + '</option>';
    }).join('');

    /* Only rooms on the current storey — a floor selector that still lists the
       upstairs bedrooms is just a longer list. */
    var rooms = S.roomsOnStorey(p, storey).map(function (r) {
      return '<option value="' + r.id + '"' + (r.id === Store.state.activeRoomId ? ' selected' : '') + '>' +
        escapeHtml(r.name) + (r.placed ? '' : ' ·') + '</option>';
    }).join('');

    el.canvasBar.innerHTML =
      '<select id="storey-select" style="width:auto;min-width:118px">' + storeyOpts + '</select>' +
      '<select id="room-select" style="width:auto;min-width:120px">' + rooms + '</select>' +
      '<button class="btn btn-sm btn-ghost" id="room-add">+ Room</button>' +
      '<div class="sep"></div>' +
      '<label class="check"><input type="checkbox" id="floor-toggle"' +
        (Store.state.view.showFloor !== false ? ' checked' : '') + '> Whole floor</label>' +
      '<label class="check"><input type="checkbox" id="snap-toggle"' + (Store.state.view.snap ? ' checked' : '') + '> Snap</label>' +
      '<div class="sep"></div>' +
      '<button class="btn btn-sm btn-ghost" id="btn-fitfloor">Fit floor</button>' +
      '<button class="btn btn-sm btn-ghost" id="btn-scale">Set scale</button>' +
      '<div class="grow"></div>' +
      '<span class="hint" id="save-state">Saved on this device</span>';

    document.getElementById('room-select').onchange = function (e) { Store.setActiveRoom(e.target.value); };
    document.getElementById('storey-select').onchange = function (e) {
      var n = Number(e.target.value);
      var first = S.roomsOnStorey(Store.state.project, n)[0];
      if (first) Store.setActiveRoom(first.id);
      else toast('No rooms on that floor yet.', 'warn');
      renderCanvasBar();
    };
    document.getElementById('floor-toggle').onchange = function (e) {
      Store.state.view.showFloor = e.target.checked;
      Ed.render();
    };
    document.getElementById('btn-fitfloor').onclick = function () { Ed.zoomToFit(true); };
    document.getElementById('room-add').onclick = function () {
      promptModal('Add room', 'Room name', 'Room ' + (Store.state.project.rooms.length + 1), function (name) {
        var room = S.newRoom(name);
        room.storey = storey;
        /* A sensible starting rectangle placed clear of the existing rooms. */
        var offset = S.roomsOnStorey(Store.state.project, storey).reduce(function (m, r) {
          return r.points.length ? Math.max(m, S.bounds(r).maxX + 1.5) : m;
        }, 0);
        [[0, 0], [4, 0], [4, 3], [0, 3]].forEach(function (c) {
          room.points.push(S.newPoint(offset + c[0], c[1], 1));
        });
        S.syncWalls(room);
        Store.do('Add room', function (p2) { p2.rooms.push(room); });
        Store.setActiveRoom(room.id);
      });
    };
    document.getElementById('snap-toggle').onchange = function (e) {
      Store.state.view.snap = e.target.checked;
    };
    document.getElementById('btn-scale').onclick = scaleModal;
  }

  /* -- Inspector ---------------------------------------------------------------- */

  function renderInspector() {
    if (!el.inspector || screen !== 'plan') return;
    var room = Store.activeRoom();
    if (!room) { el.inspector.innerHTML = ''; return; }
    var p = Store.state.project;
    /* Per-room checks and whole-floor checks land in one list — a room that is
       fine on its own but sitting inside its neighbour is still wrong. */
    var issues = S.validate(room).concat(RS.Stitch.validateBuilding(p, room.storey || 0));

    var html = '';

    /* Room ---------------------------------------------------------------- */
    html += '<div class="insp-section"><h3>Room</h3>' +
      '<label class="field"><span>Name</span><input type="text" id="i-name" value="' + escapeHtml(room.name) + '"></label>' +
      '<label class="field"><span>Type</span><select id="i-type">' +
        S.ROOM_TYPES.map(function (t) {
          return '<option value="' + t.id + '"' + (t.id === room.type ? ' selected' : '') + '>' + t.label + '</option>';
        }).join('') + '</select></label>' +
      '<div class="kv"><span>Floor area</span><b>' + G.formatArea(S.roomArea(room), p.presentation.dimensionUnits) + '</b></div>' +
      '<div class="kv"><span>Perimeter</span><b>' + S.roomPerimeter(room).toFixed(2) + ' m</b></div>' +
      '<div class="kv"><span>Corners</span><b>' + room.points.length + '</b></div>' +
      '<div class="kv"><span>Capture</span><b>' + captureLabel(room) + '</b></div>' +
      '<label class="field" style="margin-top:10px"><span>Floor</span><select id="i-storey">' +
        [-1, 0, 1, 2, 3].map(function (n) {
          return opt(String(n), S.storeyName(n), String(room.storey || 0));
        }).join('') + '</select></label>' +
      '</div>';

    /* Joining ------------------------------------------------------------- */
    var doors = room.openings.filter(function (o) { return o.type !== 'window' && o.type !== 'patio'; });
    var linked = doors.filter(function (o) { return o.link; });
    var otherRooms = S.roomsOnStorey(p, room.storey || 0)
      .filter(function (r) { return r.id !== room.id && r.points.length >= 3; });

    html += '<div class="insp-section"><h3>Joining rooms</h3>';
    if (!otherRooms.length) {
      html += '<p class="hint">Only one room on this floor so far. Scan the next one, then join them ' +
        'through the door between them.</p>';
    } else if (!doors.length) {
      html += '<p class="hint">This room has no doors yet. Add the door you walked through, then it can ' +
        'be joined to the room on the other side.</p>';
    } else {
      html += '<div class="kv"><span>Doors joined</span><b>' + linked.length + ' of ' + doors.length + '</b></div>';
      html += '<div class="kv"><span>Positioned</span><b>' + (room.placed ? 'yes' : 'not yet') + '</b></div>';
      html += '<button class="btn btn-sm btn-block btn-accent" id="i-connect" style="margin-top:8px">' +
        'Join through a door</button>';
      if (linked.length) {
        html += '<button class="btn btn-sm btn-block" id="i-restitch" style="margin-top:6px">' +
          'Re-align the whole floor</button>';
        html += '<div style="margin-top:8px">' + linked.map(function (o) {
          var other = S.findRoom(p, o.link.roomId);
          return '<div class="kv"><span>' + escapeHtml(S.OPENING_TYPES[o.type].label) + '</span>' +
            '<b>→ ' + escapeHtml(other ? other.name : '?') + ' ' +
            '<button class="btn btn-sm btn-ghost btn-danger" data-unlink="' + o.id +
            '" style="padding:0 6px">×</button></b></div>';
        }).join('') + '</div>';
      }
    }
    html += '</div>';

    /* Wall lengths --------------------------------------------------------- */
    html += '<div class="insp-section"><h3>Wall lengths</h3>';
    for (var i = 0; i < room.points.length; i++) {
      html += '<div class="row" style="margin-bottom:6px">' +
        '<span class="hint none" style="width:52px;flex:none">Wall ' + (i + 1) + '</span>' +
        '<input type="number" step="0.01" min="0.1" data-walllen="' + i + '" value="' +
          S.wallLength(room, i).toFixed(2) + '">' +
        '<select data-wallthick="' + i + '" style="flex:none;width:96px">' +
          thickOption(0.10, room.walls[i].thickness, '100 int') +
          thickOption(0.15, room.walls[i].thickness, '150') +
          thickOption(0.30, room.walls[i].thickness, '300 ext') +
          thickOption(0.35, room.walls[i].thickness, '350 ext') +
        '</select></div>';
    }
    html += '<p class="hint">Typing a length moves that wall\'s far end and carries the rest of the outline with it.</p></div>';

    /* Selection ------------------------------------------------------------- */
    html += '<div class="insp-section"><h3>Selection</h3>' + selectionPanel(room) + '</div>';

    /* Furniture palette ------------------------------------------------------ */
    html += '<div class="insp-section"><h3>Add furniture and fixtures</h3>';
    var groups = {};
    Object.keys(S.OBJECTS).forEach(function (k) {
      var g = S.OBJECTS[k].group;
      (groups[g] = groups[g] || []).push(k);
    });
    Object.keys(groups).forEach(function (g) {
      html += '<div class="palette-group">' + g + '</div><div class="palette">';
      groups[g].forEach(function (k) {
        html += '<button type="button" data-add="' + k + '" title="' + S.OBJECTS[k].label + '">' +
          RS.Symbols.icon(k) + '</button>';
      });
      html += '</div>';
    });
    html += '<p class="hint">Pick an item, then tap the plan. Items snap against the nearest wall.</p></div>';

    /* Presentation ----------------------------------------------------------- */
    html += '<div class="insp-section"><h3>Presentation</h3>' +
      '<label class="field"><span>Style</span><select id="i-style">' +
        opt('technical', 'Technical drawing', p.presentation.style) +
        opt('presentation', 'Estate agent', p.presentation.style) +
        opt('plan25', '2.5D presentation', p.presentation.style) +
      '</select></label>' +
      '<label class="field"><span>Dimension units</span><select id="i-units">' +
        opt('m', 'Metres (3.62)', p.presentation.dimensionUnits) +
        opt('mm', 'Millimetres (3620)', p.presentation.dimensionUnits) +
        opt('ftin', 'Feet and inches', p.presentation.dimensionUnits) +
      '</select></label>' +
      check('showDimensions', 'Dimensions', p.presentation) +
      check('showAreas', 'Areas', p.presentation) +
      check('showLabels', 'Room labels', p.presentation) +
      check('showFurniture', 'Furniture', p.presentation) +
      check('showNorth', 'North arrow', p.presentation) +
      check('showGrid', 'Grid', p.presentation) +
      '</div>';

    /* Issues ------------------------------------------------------------------ */
    html += '<div class="insp-section"><h3>Checks ' +
      (issues.length ? '<span class="tag ' + (issues.some(function (x) { return x.level === 'error'; }) ? 'error' : 'warn') +
        '">' + issues.length + '</span>' : '<span class="tag">clear</span>') + '</h3>';
    if (!issues.length) {
      html += '<p class="hint">Nothing looks wrong with this outline.</p>';
    } else {
      html += '<div class="issue-list">' + issues.map(function (is, k) {
        return '<div class="issue ' + (is.level === 'error' ? 'error' : '') + '" data-issue="' + k + '">' +
          escapeHtml(is.text) + '</div>';
      }).join('') + '</div>';
    }
    html += '</div>';

    /* AI ---------------------------------------------------------------------- */
    html += '<div class="insp-section"><h3>AI assistance <span class="tag">optional</span></h3>';
    if (!RS.AI.enabled()) {
      html += '<p class="hint">Off. The plan is complete without it — switch a provider on in ' +
        'Settings if you want room classification, a plausibility review or automatic styling.</p>' +
        '<button class="btn btn-sm btn-block" id="i-ai-setup">Set up AI</button>';
    } else {
      html += '<button class="btn btn-sm btn-block" data-ai="classify" style="margin-bottom:6px">Classify and label this room</button>' +
        '<button class="btn btn-sm btn-block" data-ai="review" style="margin-bottom:6px">Review the plan for mistakes</button>' +
        '<button class="btn btn-sm btn-block" data-ai="style">Style for an audience</button>' +
        '<p class="hint" style="margin-top:8px">Sends dimensions and item names only — never a photograph. ' +
        'Measurements are never changed by the model.</p>';
    }
    html += '</div>';

    el.inspector.innerHTML = html;
    bindInspector(room, issues);
  }

  function thickOption(v, cur, label) {
    return '<option value="' + v + '"' + (Math.abs(cur - v) < 0.001 ? ' selected' : '') + '>' + label + '</option>';
  }
  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>';
  }
  function check(key, label, pres) {
    return '<label class="check"><input type="checkbox" data-pres="' + key + '"' +
      (pres[key] ? ' checked' : '') + '> ' + label + '</label>';
  }
  function captureLabel(room) {
    var m = { station: 'Camera scan', xr: 'AR capture', manual: 'Drawn', detected: 'Assisted' }[room.capture.method] || 'Drawn';
    if (room.capture.method === 'station') {
      m += room.capture.scaleCorrected ? ', scaled' : ', unscaled';
    }
    return m;
  }

  function selectionPanel(room) {
    var sel = Store.state.selection;
    if (!sel) return '<p class="hint">Nothing selected. Click a corner, a door or an item on the plan.</p>';

    if (sel.kind === 'point') {
      var pt = room.points[sel.index];
      if (!pt) return '<p class="hint">Nothing selected.</p>';
      return '<div class="row"><label class="field" style="margin:0"><span>X (m)</span>' +
        '<input type="number" step="0.01" id="s-px" value="' + pt.x.toFixed(2) + '"></label>' +
        '<label class="field" style="margin:0"><span>Y (m)</span>' +
        '<input type="number" step="0.01" id="s-py" value="' + pt.y.toFixed(2) + '"></label></div>' +
        '<div class="kv"><span>Capture confidence</span><b>' + Math.round(pt.confidence * 100) + '%</b></div>' +
        '<button class="btn btn-sm btn-danger btn-block" id="s-del" style="margin-top:8px">Delete corner</button>';
    }

    if (sel.kind === 'opening') {
      var op = room.openings.filter(function (o) { return o.id === sel.id; })[0];
      if (!op) return '<p class="hint">Nothing selected.</p>';
      return '<label class="field"><span>Type</span><select id="s-otype">' +
          Object.keys(S.OPENING_TYPES).map(function (k) {
            return opt(k, S.OPENING_TYPES[k].label, op.type);
          }).join('') + '</select></label>' +
        '<div class="row"><label class="field" style="margin:0"><span>Width (m)</span>' +
          '<input type="number" step="0.01" min="0.2" id="s-owidth" value="' + op.width.toFixed(2) + '"></label>' +
        '<label class="field" style="margin:0"><span>From corner (m)</span>' +
          '<input type="number" step="0.01" id="s-ooffset" value="' + op.offset.toFixed(2) + '"></label></div>' +
        '<div class="row"><label class="field" style="margin:0"><span>Hinge</span><select id="s-ohinge">' +
          opt('start', 'First jamb', op.hinge) + opt('end', 'Second jamb', op.hinge) + '</select></label>' +
        '<label class="field" style="margin:0"><span>Swing</span><select id="s-oswing">' +
          opt('in', 'Into room', op.swing) + opt('out', 'Out of room', op.swing) + '</select></label></div>' +
        '<button class="btn btn-sm btn-danger btn-block" id="s-del">Delete opening</button>';
    }

    if (sel.kind === 'object') {
      var ob = room.objects.filter(function (o) { return o.id === sel.id; })[0];
      if (!ob) return '<p class="hint">Nothing selected.</p>';
      return '<label class="field"><span>Item</span><select id="s-otype2">' +
          Object.keys(S.OBJECTS).map(function (k) {
            return opt(k, S.OBJECTS[k].label, ob.type);
          }).join('') + '</select></label>' +
        '<div class="row"><label class="field" style="margin:0"><span>Width (m)</span>' +
          '<input type="number" step="0.01" min="0.1" id="s-w" value="' + ob.w.toFixed(2) + '"></label>' +
        '<label class="field" style="margin:0"><span>Depth (m)</span>' +
          '<input type="number" step="0.01" min="0.1" id="s-d" value="' + ob.d.toFixed(2) + '"></label></div>' +
        '<label class="field"><span>Rotation (°)</span>' +
          '<input type="number" step="5" id="s-rot" value="' + Math.round(ob.rot) + '"></label>' +
        (ob.confidence < 0.55
          ? '<div class="notice warn" style="margin-bottom:10px">Detected, not confirmed. Adjust it and it becomes confirmed.</div>'
          : '') +
        '<button class="btn btn-sm btn-danger btn-block" id="s-del">Delete item</button>';
    }
    return '';
  }

  function bindInspector(room, issues) {
    var $ = function (id) { return document.getElementById(id); };

    if ($('i-name')) $('i-name').onchange = function (e) {
      Store.do('Rename room', function () { room.name = e.target.value.slice(0, 40); });
    };
    if ($('i-type')) $('i-type').onchange = function (e) {
      Store.do('Set room type', function () { room.type = e.target.value; });
    };
    if ($('i-storey')) $('i-storey').onchange = function (e) {
      var n = Number(e.target.value);
      Store.do('Change floor', function (p2) {
        /* Moving a room to another floor breaks any join it had on this one —
           a door cannot lead between storeys. */
        room.openings.forEach(function (o) { S.unlinkOpening(p2, o); });
        room.storey = n;
        room.placed = false;
      });
      renderCanvasBar();
      Ed.zoomToFit();
    };
    if ($('i-connect')) $('i-connect').onclick = function () { connectModal(room); };
    if ($('i-restitch')) $('i-restitch').onclick = function () {
      var res;
      Store.do('Re-align floor', function (p2) { res = RS.Stitch.restitch(p2, room.id); });
      Ed.zoomToFit(true);
      toast(res.moved
        ? 'Re-aligned ' + res.moved + ' room' + (res.moved === 1 ? '' : 's') + ' from "' + room.name + '".'
        : 'Nothing to re-align — no joined rooms downstream of this one.');
    };
    el.inspector.querySelectorAll('[data-unlink]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-unlink');
        Store.do('Unjoin door', function (p2) {
          var op = room.openings.filter(function (o) { return o.id === id; })[0];
          S.unlinkOpening(p2, op);
        });
        toast('Door unjoined. The rooms stay where they are.');
      };
    });

    el.inspector.querySelectorAll('[data-walllen]').forEach(function (inp) {
      inp.onchange = function () {
        Ed.setWallLength(Number(inp.getAttribute('data-walllen')), Number(inp.value));
      };
    });
    el.inspector.querySelectorAll('[data-wallthick]').forEach(function (sel2) {
      sel2.onchange = function () {
        var i = Number(sel2.getAttribute('data-wallthick'));
        Store.do('Set wall thickness', function () {
          room.walls[i].thickness = Number(sel2.value);
          room.walls[i].exterior = Number(sel2.value) >= 0.2;
        });
      };
    });

    el.inspector.querySelectorAll('[data-add]').forEach(function (b) {
      b.onclick = function () {
        Ed.setPlacing(b.getAttribute('data-add'));
        toast('Now tap the plan to place the ' + S.OBJECTS[b.getAttribute('data-add')].label.toLowerCase() + '.');
        el.inspector.classList.remove('open');
      };
    });

    el.inspector.querySelectorAll('[data-pres]').forEach(function (c) {
      c.onchange = function () {
        Store.do('Presentation', function (p) { p.presentation[c.getAttribute('data-pres')] = c.checked; });
      };
    });
    if ($('i-style')) $('i-style').onchange = function (e) {
      Store.do('Change style', function (p) { p.presentation.style = e.target.value; });
    };
    if ($('i-units')) $('i-units').onchange = function (e) {
      Store.do('Change units', function (p) { p.presentation.dimensionUnits = e.target.value; });
    };

    el.inspector.querySelectorAll('[data-issue]').forEach(function (d) {
      d.onclick = function () {
        var is = issues[Number(d.getAttribute('data-issue'))];
        if (is && is.target) Ed.focusOn(is.target);
      };
    });

    /* Selection editors. */
    var sel = Store.state.selection;
    if ($('s-del')) $('s-del').onclick = function () { Ed.deleteSelection(); };

    if (sel && sel.kind === 'point') {
      ['s-px', 's-py'].forEach(function (id) {
        if (!$(id)) return;
        $(id).onchange = function () {
          Store.do('Set corner position', function () {
            room.points[sel.index].x = Number($('s-px').value);
            room.points[sel.index].y = Number($('s-py').value);
          });
        };
      });
    }

    if (sel && sel.kind === 'opening') {
      var op = room.openings.filter(function (o) { return o.id === sel.id; })[0];
      if (op) {
        if ($('s-otype')) $('s-otype').onchange = function (e) {
          Store.do('Change opening type', function () {
            op.type = e.target.value;
            var def = S.OPENING_TYPES[op.type];
            op.height = def.height; op.sill = def.sill;
          });
        };
        ['s-owidth', 's-ooffset'].forEach(function (id) {
          if (!$(id)) return;
          $(id).onchange = function () {
            Store.do('Resize opening', function () {
              op.width = G.clamp(Number($('s-owidth').value), 0.2, 6);
              op.offset = Number($('s-ooffset').value);
              op.measured = true;
            });
          };
        });
        if ($('s-ohinge')) $('s-ohinge').onchange = function (e) {
          Store.do('Set hinge', function () { op.hinge = e.target.value; });
        };
        if ($('s-oswing')) $('s-oswing').onchange = function (e) {
          Store.do('Set swing', function () { op.swing = e.target.value; });
        };
      }
    }

    if (sel && sel.kind === 'object') {
      var ob = room.objects.filter(function (o) { return o.id === sel.id; })[0];
      if (ob) {
        if ($('s-otype2')) $('s-otype2').onchange = function (e) {
          Store.do('Change item', function () {
            ob.type = e.target.value;
            var def = S.OBJECTS[ob.type];
            ob.w = def.w; ob.d = def.d; ob.confidence = 1;
          });
        };
        ['s-w', 's-d', 's-rot'].forEach(function (id) {
          if (!$(id)) return;
          $(id).onchange = function () {
            Store.do('Resize item', function () {
              ob.w = Math.max(0.1, Number($('s-w').value));
              ob.d = Math.max(0.1, Number($('s-d').value));
              ob.rot = Number($('s-rot').value) || 0;
              ob.measured = true;
              ob.confidence = 1;      // a human touched it, so it is confirmed
            });
          };
        });
      }
    }

    if ($('i-ai-setup')) $('i-ai-setup').onclick = settingsModal;
    el.inspector.querySelectorAll('[data-ai]').forEach(function (b) {
      b.onclick = function () { runAI(b.getAttribute('data-ai'), room); };
    });
  }

  /* -- Joining rooms through a shared door ---------------------------------------- */

  function connectModal(room) {
    var p = Store.state.project;
    var doors = room.openings.filter(function (o) {
      return o.type !== 'window' && o.type !== 'patio';
    });
    if (!doors.length) { toast('Add the door you walked through first.', 'warn'); return; }

    function doorLabel(r, o, i) {
      return S.OPENING_TYPES[o.type].label + ' ' + (i + 1) + ' — ' +
        o.width.toFixed(2) + ' m on wall ' + (o.wallIndex + 1) +
        (o.link ? ' (already joined)' : '');
    }

    var mine = doors.map(function (o, i) {
      return '<option value="' + o.id + '">' + escapeHtml(doorLabel(room, o, i)) + '</option>';
    }).join('');

    openModal('Join through a door', '' +
      '<p>Pick the door you walked through and the same door as measured from the other room. ' +
      'Both rooms measured it independently, so the two observations are enough to place this ' +
      'room exactly — no guessing and nothing to drag.</p>' +
      '<label class="field"><span>Door in "' + escapeHtml(room.name) + '"</span>' +
        '<select id="c-mine">' + mine + '</select></label>' +
      '<label class="field"><span>The same door, in</span>' +
        '<select id="c-theirs"></select></label>' +
      '<div id="c-note"></div>' +
      '<p class="hint">"' + escapeHtml(room.name) + '" moves; the other room stays exactly where it is.</p>',
      [{ label: 'Cancel', ghost: true }, {
        label: 'Join', primary: true, action: function () {
          var mineId = document.getElementById('c-mine').value;
          var theirs = document.getElementById('c-theirs').value;
          if (!theirs) { toast('No matching door to join to.', 'warn'); return false; }
          var parts = theirs.split('|');
          return applyConnect(room, mineId, parts[0], parts[1]);
        }
      }], true);

    function refreshCandidates() {
      var mineId = document.getElementById('c-mine').value;
      var opening = room.openings.filter(function (o) { return o.id === mineId; })[0];
      var list = opening ? RS.Stitch.candidates(p, room, opening) : [];
      var sel = document.getElementById('c-theirs');
      sel.innerHTML = list.length
        ? list.map(function (c) {
            return '<option value="' + c.roomId + '|' + c.openingId + '">' +
              escapeHtml(c.roomName + ' — ' + S.OPENING_TYPES[c.type].label + ' ' + c.width.toFixed(2) + ' m' +
                (c.widthDelta < 0.06 ? '  (good width match)' : '')) + '</option>';
          }).join('')
        : '<option value="">No unjoined doors in the other rooms</option>';
      document.getElementById('c-note').innerHTML = list.length ? '' :
        '<div class="notice warn">The other rooms on this floor have no spare doors. ' +
        'Scan the adjoining room and capture the shared door in it too.</div>';
    }
    document.getElementById('c-mine').onchange = refreshCandidates;
    refreshCandidates();
  }

  function applyConnect(room, mineId, otherRoomId, otherOpeningId) {
    var p = Store.state.project;
    var opening = room.openings.filter(function (o) { return o.id === mineId; })[0];
    var otherRoom = S.findRoom(p, otherRoomId);
    var otherOpening = S.findOpening(p, otherRoomId, otherOpeningId);
    if (!opening || !otherRoom || !otherOpening) { toast('That door no longer exists.', 'error'); return false; }

    var res;
    Store.do('Join rooms', function () {
      res = RS.Stitch.connect(p, otherRoom, otherOpening, room, opening);
    });
    if (!res || !res.ok) {
      toast(res ? res.reason : 'The join failed.', 'error');
      return true;
    }
    Ed.zoomToFit(true);
    var msg = 'Joined to "' + otherRoom.name + '" — rotated ' + res.rotatedBy + '°, ' +
      Math.round(res.wallThickness * 1000) + ' mm wall between them.';
    if (res.overlap) {
      toast(msg + ' But it now overlaps "' + res.overlap.name + '" — that usually means the wrong door.', 'error');
    } else if (res.warning) {
      toast(res.warning, 'warn');
    } else {
      toast(msg + ' Door widths agree to ' + Math.round(res.widthMismatch * 1000) + ' mm.');
    }
    return true;
  }

  /* -- AI actions ---------------------------------------------------------------- */

  function runAI(task, room) {
    var payload = RS.AI.summarise(room);
    if (task === 'style') {
      openModal('Style for an audience', '' +
        '<label class="field"><span>Who is this plan for?</span>' +
        '<textarea id="m-audience" rows="3">A letting brochure — needs to look inviting, exact dimensions matter less.</textarea></label>' +
        '<p class="hint">The model chooses presentation settings only. It cannot move or resize anything.</p>',
        [{ label: 'Cancel', ghost: true }, {
          label: 'Ask', primary: true, action: function () {
            var audience = document.getElementById('m-audience').value;
            busy('Asking the model…');
            RS.AI.run('style', payload, 'Audience: ' + audience)
              .then(function (res) {
                RS.AI.applyStyle(Store.state.project, res);
                closeModal();
                toast('Style applied: ' + (res.rationale || res.style));
              })
              .catch(aiError);
            return false;
          }
        }]);
      return;
    }

    busy(task === 'classify' ? 'Classifying the room…' : 'Reviewing the plan…');
    RS.AI.run(task, payload)
      .then(function (res) {
        if (task === 'classify') {
          RS.AI.applyClassification(room, res);
          closeModal();
          toast('Labelled "' + res.label + '" (' + Math.round(res.confidence * 100) + '% confident): ' + res.reasoning);
        } else {
          var body = '<p class="hint">' + escapeHtml(res.summary || '') + '</p><div class="issue-list">' +
            (res.findings || []).map(function (f) {
              return '<div class="issue ' + (f.severity === 'error' ? 'error' : '') + '">' +
                escapeHtml(f.text) + (f.recheck ? '<br><b>Re-check:</b> ' + escapeHtml(f.recheck) : '') + '</div>';
            }).join('') + '</div>' +
            '<div class="notice" style="margin-top:12px">These are suggestions about what to look at again. ' +
            'Nothing on the plan has been changed.</div>';
          openModal('Plan review', body, [{ label: 'Close', primary: true }]);
        }
      })
      .catch(aiError);
  }

  function aiError(err) {
    openModal('AI request failed', '<div class="notice error">' + escapeHtml(err.message) + '</div>' +
      '<p class="hint">The plan is unaffected — every measurement is local and independent of this.</p>',
      [{ label: 'Close', primary: true }]);
  }

  /* -- Export --------------------------------------------------------------------- */

  function exportModal() {
    if (!Store.state.project) { toast('Open a survey first.', 'warn'); return; }
    var p = Store.state.project;
    var room = Store.activeRoom();
    var storey = room ? (room.storey || 0) : 0;
    var onFloor = S.roomsOnStorey(p, storey).filter(function (r) { return r.points.length >= 3; }).length;
    openModal('Export', '' +
      '<label class="field"><span>What to include</span><select id="m-scope">' +
        '<option value="floor">' + escapeHtml(S.storeyName(storey)) + ' — ' + onFloor +
          ' room' + (onFloor === 1 ? '' : 's') + '</option>' +
        '<option value="room">Just "' + escapeHtml(room ? room.name : '') + '"</option>' +
        '<option value="all">Every floor — ' + p.rooms.length + ' rooms</option>' +
      '</select></label>' +
      '<div class="row"><label class="field" style="margin:0"><span>Paper (PDF)</span>' +
        '<select id="m-paper">' +
          opt('A4', 'A4', 'A4') + opt('A3', 'A3 — for whole floors', 'A4') +
          opt('A2', 'A2 — large houses', 'A4') + opt('A5', 'A5', 'A4') +
        '</select></label>' +
      '<label class="field" style="margin:0"><span>Orientation</span>' +
        '<select id="m-orient">' +
          opt('auto', 'Automatic', 'auto') +
          opt('landscape', 'Landscape', 'auto') +
          opt('portrait', 'Portrait', 'auto') +
        '</select></label></div>' +
      '<div id="m-sheet-note" class="hint" style="margin-bottom:12px"></div>' +
      '<div class="row" style="margin-bottom:8px">' +
        '<button class="btn btn-block" data-exp="svg">SVG — vector</button>' +
        '<button class="btn btn-block" data-exp="png">PNG — image</button></div>' +
      '<div class="row" style="margin-bottom:8px">' +
        '<button class="btn btn-block" data-exp="pdf">PDF — A4 sheet</button>' +
        '<button class="btn btn-block" data-exp="dxf">DXF — CAD</button></div>' +
      '<div class="row" style="margin-bottom:12px">' +
        '<button class="btn btn-block" data-exp="json">Project JSON</button>' +
        '<button class="btn btn-block" data-exp="import">Import JSON…</button></div>' +
      '<p class="hint">SVG and DXF are true vector output generated from the geometry. ' +
      'PNG and PDF are rendered from the same drawing at 300 dpi. DXF is written in ' +
      'millimetres on the standard architectural layers.</p>',
      [{ label: 'Close', ghost: true }]);

    function selectedRooms() {
      var scope = document.getElementById('m-scope').value;
      return scope === 'room' ? [Store.activeRoom()]
        : scope === 'all' ? p.rooms.filter(function (r) { return r.points.length >= 3; })
        : S.roomsOnStorey(p, storey).filter(function (r) { return r.points.length >= 3; });
    }

    /* Tell them what the sheet will actually produce before they click, rather
       than leaving them to open the PDF and find out the plan is tiny. */
    function updateSheetNote() {
      var note = document.getElementById('m-sheet-note');
      var paper = document.getElementById('m-paper').value;
      var orient = document.getElementById('m-orient').value;
      var rooms = selectedRooms();
      if (!rooms.length || !rooms[0]) { note.textContent = ''; return; }
      var pred = RS.Export.predictSheet(p, rooms, { paper: paper, orientation: orient });
      if (!pred) { note.textContent = ''; return; }
      var msg = 'PDF will be <b>' + paper + ' ' + pred.mode + '</b> at about <b>' +
        pred.ratio + '</b>.';
      if (pred.tooSmall) {
        msg += ' <span style="color:var(--hse-red)">At that scale a doorway is barely ' +
          pred.doorMm + ' mm on paper — try ' + pred.suggestion + '.</span>';
      }
      note.innerHTML = msg;
    }
    document.getElementById('m-paper').onchange = updateSheetNote;
    document.getElementById('m-orient').onchange = updateSheetNote;
    document.getElementById('m-scope').onchange = updateSheetNote;
    updateSheetNote();

    el.modal.querySelectorAll('[data-exp]').forEach(function (b) {
      b.onclick = function () {
        var rooms = selectedRooms();
        var kind = b.getAttribute('data-exp');
        var pdfOpts = {
          paper: document.getElementById('m-paper').value,
          orientation: document.getElementById('m-orient').value
        };
        try {
          if (kind === 'svg') { RS.Export.exportSvg(p, rooms); done('SVG'); }
          else if (kind === 'png') RS.Export.exportPng(p, rooms).then(function () { done('PNG'); }).catch(expError);
          else if (kind === 'pdf') RS.Export.exportPdf(p, rooms, pdfOpts).then(function () { done('PDF'); }).catch(expError);
          else if (kind === 'dxf') { RS.Export.exportDxf(p, rooms, 'mm'); done('DXF'); }
          else if (kind === 'json') { RS.Export.exportJson(p); done('JSON'); }
          else if (kind === 'import') importPicker();
        } catch (e) { expError(e); }
      };
    });
  }

  function done(what) { toast(what + ' exported.'); }
  function expError(e) { toast('Export failed: ' + e.message, 'error'); }

  function importPicker() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function () {
      if (!input.files || !input.files[0]) return;
      RS.Export.importJson(input.files[0]).then(function (p) {
        Store.setProject(p);
        Store.save();
        closeModal();
        show('plan');
        toast('Project imported.');
      }).catch(function (e) { toast(e.message, 'error'); });
    };
    input.click();
  }

  /* -- Settings -------------------------------------------------------------------- */

  function settingsModal() {
    var s = Store.getSettings();
    var brand = RS.Brand.effective();
    var models = (RS.AI.MODELS[s.aiProvider] || []).map(function (m) {
      return opt(m.id, m.label, s.aiModel);
    }).join('');

    openModal('Settings', '' +
      '<h3 style="margin-bottom:10px">Capture</h3>' +
      '<div class="row"><label class="field" style="margin:0"><span>Camera height (m)</span>' +
        '<input type="number" step="0.01" id="st-height" value="' + (s.cameraHeight || 1.45) + '"></label>' +
      '<label class="field" style="margin:0"><span>Camera FOV (°)</span>' +
        '<input type="number" step="0.5" id="st-fov" value="' + (s.fovDeg || 66) + '"></label></div>' +
      '<label class="check" style="margin-bottom:16px"><input type="checkbox" id="st-square"' +
        (s.autoSquare ? ' checked' : '') + '> Square up the outline automatically after a scan</label>' +

      '<h3 style="margin:16px 0 10px">Sheet branding</h3>' +
      '<label class="field"><span>Organisation name</span>' +
        '<input type="text" id="st-org" value="' + escapeHtml(s.orgName || brand.siteOrgName || '') + '" ' +
        'placeholder="appears in the PDF header"></label>' +
      '<div class="row" style="align-items:center;margin-bottom:8px">' +
        '<div class="none" style="width:118px;height:52px;border:1px solid var(--line);' +
          'border-radius:var(--r-md);background:#fff;display:grid;place-items:center;overflow:hidden">' +
          (brand.logoDataUrl
            ? '<img id="st-logo-img" alt="Current logo" src="' + escapeHtml(brand.logoDataUrl) + '" style="max-width:100%;max-height:100%">'
            : '<span class="hint" id="st-logo-img">no logo</span>') +
        '</div>' +
        '<div><button class="btn btn-sm btn-block" id="st-logo-pick" style="margin-bottom:4px">Choose logo</button>' +
        '<button class="btn btn-sm btn-block" id="st-logo-save" style="margin-bottom:4px"' +
          (brand.logoDataUrl ? '' : ' disabled') + '>Save for whole site</button>' +
        '<button class="btn btn-sm btn-block btn-danger" id="st-logo-clear"' +
          (s.logoDataUrl ? '' : ' disabled') + '>' + (brand.fromSite ? 'Remove' : 'Use site logo') + '</button></div>' +
      '</div>' +
      '<div class="notice" style="margin-bottom:8px">' +
        (brand.fromSite
          ? 'Showing the <b>site logo</b> from <code>branding/logo.txt</code>. It appears on every device.'
          : brand.logoDataUrl
            ? 'Showing a logo saved <b>on this device only</b>. It will not appear on your phone or on the ' +
              'published site until you click <b>Save for whole site</b> and put the downloaded ' +
              '<code>logo.txt</code> in the <code>branding</code> folder.'
            : 'No logo set. Choose one, then click <b>Save for whole site</b> and drop the downloaded ' +
              '<code>logo.txt</code> into the <code>branding</code> folder so it reaches every device.') +
      '</div>' +
      '<p class="hint" style="margin-bottom:16px">PNG, JPEG or SVG. Use a logo you are entitled to use — ' +
      'the app ships none of its own, and a plan carrying an organisation\'s logo reads as a document ' +
      'issued by that organisation.</p>' +

      '<h3 style="margin:16px 0 10px">Optional AI</h3>' +
      '<label class="field"><span>Provider</span><select id="st-provider">' +
        opt('none', 'Off — nothing is sent anywhere', s.aiProvider) +
        opt('claude', 'Claude (Anthropic)', s.aiProvider) +
        opt('gemini', 'Gemini (Google)', s.aiProvider) +
      '</select></label>' +
      '<label class="field"><span>Model</span><select id="st-model">' + (models || '<option>—</option>') + '</select></label>' +
      '<label class="field"><span>API key</span>' +
        '<input type="password" id="st-key" value="' + escapeHtml(s.aiKey || '') + '" placeholder="stored on this device only"></label>' +
      '<label class="check" style="margin-bottom:12px"><input type="checkbox" id="st-consent"' +
        (s.consentAI ? ' checked' : '') + '> I understand room dimensions and item names will be sent to this provider</label>' +
      '<div class="row" style="margin-bottom:16px"><button class="btn btn-sm" id="st-test">Test connection</button></div>' +

      '<h3 style="margin:16px 0 10px">Optional heavy processing</h3>' +
      '<label class="field"><span>Hugging Face Space or Render URL</span>' +
        '<input type="text" id="st-space" value="' + escapeHtml(s.spaceUrl || '') + '" ' +
        'placeholder="https://yourname-roomscan.hf.space"></label>' +
      '<p class="hint" style="margin-bottom:16px">Used only when you ask for depth or object detection during a scan. ' +
      'A single 768 px frame is sent. See server/hf-space/README.md to deploy one on the free tier.</p>' +

      '<h3 style="margin:16px 0 10px">Data and privacy</h3>' +
      '<p class="hint">Surveys are stored in this browser only. Nothing is uploaded unless you export or ' +
      'explicitly use an AI feature.</p>' +
      '<div class="row" style="margin-bottom:10px">' +
        '<button class="btn btn-sm btn-block" id="st-privacy">Privacy notice</button>' +
        '<button class="btn btn-sm btn-block btn-danger" id="st-clear">Delete all surveys</button>' +
      '</div>',
      [{ label: 'Close', ghost: true }, { label: 'Save', primary: true, action: saveSettings }]);

    document.getElementById('st-provider').onchange = function () {
      var v = document.getElementById('st-provider').value;
      var sel = document.getElementById('st-model');
      sel.innerHTML = (RS.AI.MODELS[v] || []).map(function (m) { return opt(m.id, m.label, ''); }).join('') ||
        '<option>—</option>';
    };
    document.getElementById('st-test').onclick = function () {
      saveSettings(true);
      var btn = document.getElementById('st-test');
      btn.disabled = true; btn.textContent = 'Testing…';
      RS.AI.testConnection()
        .then(function (r) {
          btn.disabled = false; btn.textContent = 'Test connection';
          toast('Connected. The model classified the test room as "' + r.label + '".');
        })
        .catch(function (e) {
          btn.disabled = false; btn.textContent = 'Test connection';
          toast(e.message, 'error');
        });
    };
    document.getElementById('st-privacy').onclick = privacyModal;
    document.getElementById('st-logo-pick').onclick = pickLogo;
    document.getElementById('st-logo-save').onclick = function () {
      var url = RS.Brand.effective().logoDataUrl;
      if (!url) { toast('Choose a logo first.', 'warn'); return; }
      RS.Export.download(url, 'logo.txt', 'text/plain');
      openModal('One file to add to your repository', '' +
        '<p>A file called <code>logo.txt</code> has just downloaded.</p>' +
        '<ol style="margin:0 0 12px 18px;line-height:1.7">' +
        '<li>Find it in your Downloads folder.</li>' +
        '<li>Move it into the <b>branding</b> folder of the project, replacing the empty one.</li>' +
        '<li>Commit and push.</li>' +
        '</ol>' +
        '<p>From then on the logo is part of the site: it appears on your phone, on the ' +
        'published page and for anyone else who opens it — no settings to repeat.</p>' +
        '<p class="hint">To change the organisation name for everyone too, edit ' +
        '<code>branding/brand.json</code> and set <code>orgName</code>.</p>',
        [{ label: 'Got it', primary: true }]);
    };
    document.getElementById('st-logo-clear').onclick = function () {
      Store.saveSettings({ logoDataUrl: '' });
      var b = RS.Brand.effective();
      var box = document.getElementById('st-logo-img');
      if (box) {
        box.outerHTML = b.logoDataUrl
          ? '<img id="st-logo-img" alt="Current logo" src="' + b.logoDataUrl + '" style="max-width:100%;max-height:100%">'
          : '<span class="hint" id="st-logo-img">no logo</span>';
      }
      toast(b.logoDataUrl ? 'Using the site logo again.' : 'Logo removed.');
    };
    document.getElementById('st-clear').onclick = function () {
      confirmModal('Delete everything?', 'Every survey stored in this browser will be removed. Export anything you want to keep first.', function () {
        Store.listProjects().forEach(function (p) { Store.deleteProject(p.id); });
        location.reload();
      });
    };
  }

  /* A plain-English statement of what leaves the device. Scanning buildings
     means scanning places people live and work, so this is a question that
     gets asked before deployment, not after. */
  function privacyModal() {
    var s = Store.getSettings();
    var aiOn = RS.AI.enabled();
    var spaceOn = RS.AI.spaceEnabled();
    openModal('Privacy notice', '' +
      '<h3 style="margin-bottom:8px">What is stored</h3>' +
      '<p>Surveys, settings and any logo you choose are held in this browser\'s local storage, on ' +
      'this device. There is no account, no server and no database. Clearing your browser data ' +
      'deletes them, and so does <b>Delete all surveys</b>.</p>' +

      '<h3 style="margin:14px 0 8px">What leaves the device</h3>' +
      '<p>By default, nothing at all. The camera image is processed in the page and never uploaded; ' +
      'the measurements are calculated on the device. Three things can send data, and only when you ' +
      'trigger them:</p>' +
      '<ul style="margin:0 0 12px 18px;line-height:1.7;color:var(--ink-700)">' +
        '<li><b>Exporting</b> writes a file to your own downloads folder.</li>' +
        '<li><b>AI assistance</b> ' + (aiOn ? 'is <b>on</b>' : 'is off') + '. When used it sends room ' +
          'dimensions and item names — numbers and words, never a photograph — to the provider you ' +
          'chose. Your API key is stored on this device and sent only to that provider.</li>' +
        '<li><b>Detection</b> ' + (spaceOn ? 'is <b>configured</b>' : 'is off') + '. When used it sends ' +
          'one photograph, downscaled to 768 pixels, to the address you configured.</li>' +
      '</ul>' +

      '<h3 style="margin:14px 0 8px">Scanning occupied buildings</h3>' +
      '<p>A floor plan of someone\'s home or ward is information about them. Before scanning a space ' +
      'that is not yours, tell the occupant what you are doing and why. Avoid capturing people in ' +
      'frame. If you turn on detection, remember a photograph of the room goes to a third party — ' +
      'so do not use it in a space where that would not be acceptable.</p>' +

      '<h3 style="margin:14px 0 8px">Before organisational use</h3>' +
      '<p>This app has not been through an information governance review, a data protection impact ' +
      'assessment or an independent accessibility audit. It is built to make those straightforward — ' +
      'no third-party code, no trackers, no analytics, no cookies, no network calls unless you switch ' +
      'them on — but they still have to happen.</p>',
      [{ label: 'Close', primary: true }], true);
  }

  /* Read a logo file, downscale it and keep it as a data URL. Downscaling is
     not cosmetic: localStorage is a few megabytes and a phone photo would fill
     it, taking the surveys with it. */
  function pickLogo() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/svg+xml,image/webp';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 6 * 1024 * 1024) { toast('That image is too large — use one under 6 MB.', 'warn'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var maxW = 520, maxH = 200;
          var k = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var url;
          try { url = canvas.toDataURL('image/jpeg', 0.92); }
          catch (e) { toast('That image could not be read.', 'error'); return; }
          try { Store.saveSettings({ logoDataUrl: url }); }
          catch (e) { toast('There is no room left in this browser to store the logo.', 'error'); return; }
          var box = document.getElementById('st-logo-img');
          if (box) box.outerHTML = '<img id="st-logo-img" src="' + url + '" style="max-width:100%;max-height:100%">';
          toast('Logo set. It will appear in the PDF header.');
        };
        img.onerror = function () { toast('That file is not an image the browser can read.', 'error'); };
        img.src = reader.result;
      };
      reader.onerror = function () { toast('The file could not be read.', 'error'); };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  function saveSettings(silent) {
    Store.saveSettings({
      cameraHeight: Number(document.getElementById('st-height').value) || 1.45,
      fovDeg: Number(document.getElementById('st-fov').value) || 66,
      autoSquare: document.getElementById('st-square').checked,
      aiProvider: document.getElementById('st-provider').value,
      aiModel: document.getElementById('st-model').value,
      aiKey: document.getElementById('st-key').value.trim(),
      consentAI: document.getElementById('st-consent').checked,
      spaceUrl: document.getElementById('st-space').value.trim(),
      orgName: document.getElementById('st-org').value.trim().slice(0, 60)
    });
    if (silent !== true) { closeModal(); toast('Settings saved.'); renderInspector(); }
  }

  /* -- Modals and toasts ------------------------------------------------------------ */

  var modalReturnFocus = null;

  function openModal(title, bodyHtml, buttons, wide) {
    /* Remember what had focus so it can be given back on close — otherwise a
       keyboard or screen-reader user is dropped at the top of the page every
       time a dialog closes. */
    if (!el.modalBackdrop.classList.contains('open')) {
      modalReturnFocus = document.activeElement;
    }
    el.modal.className = 'modal' + (wide ? ' wide' : '');
    el.modal.setAttribute('role', 'dialog');
    el.modal.setAttribute('aria-modal', 'true');
    el.modal.setAttribute('aria-label', title);
    el.modal.innerHTML =
      '<div class="modal-head"><h2>' + escapeHtml(title) + '</h2>' +
      '<button class="btn btn-sm btn-ghost" data-close>Close</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      (buttons && buttons.length ? '<div class="modal-foot">' + buttons.map(function (b, i) {
        return '<button class="btn ' + (b.primary ? 'btn-primary' : (b.ghost ? 'btn-ghost' : '')) +
          '" data-btn="' + i + '">' + escapeHtml(b.label) + '</button>';
      }).join('') + '</div>' : '');
    el.modalBackdrop.classList.add('open');
    el.modal.querySelector('[data-close]').onclick = closeModal;
    (buttons || []).forEach(function (b, i) {
      var node = el.modal.querySelector('[data-btn="' + i + '"]');
      if (!node) return;
      node.onclick = function () {
        var keep = b.action ? b.action() : undefined;
        if (keep !== false) closeModal();
      };
    });
    var first = el.modal.querySelector('input, select, textarea, button');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function closeModal() {
    if (!el.modalBackdrop.classList.contains('open')) return;
    el.modalBackdrop.classList.remove('open');
    if (modalReturnFocus && document.contains(modalReturnFocus)) {
      try { modalReturnFocus.focus(); } catch (e) { /* element went away */ }
    }
    modalReturnFocus = null;
  }

  function modalIsOpen() { return el.modalBackdrop.classList.contains('open'); }

  /* Keep Tab inside an open dialog. Without this, tabbing walks out of the
     dialog into the page behind it, which for a screen-reader user reads as
     the dialog having silently vanished. */
  function trapFocus(e) {
    if (e.key !== 'Tab' || !modalIsOpen()) return;
    var items = el.modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function busy(msg) {
    openModal('Working', '<p>' + escapeHtml(msg) + '</p><div class="level-bar" style="background:var(--surface-3)">' +
      '<i style="width:100%;background:var(--hse-teal-500);animation:none"></i></div>', []);
  }

  function confirmModal(title, body, onYes) {
    openModal(title, '<p>' + escapeHtml(body) + '</p>',
      [{ label: 'Cancel', ghost: true }, { label: 'Delete', primary: true, action: onYes }]);
  }

  function promptModal(title, label, value, onOk) {
    openModal(title, '<label class="field"><span>' + escapeHtml(label) + '</span>' +
      '<input type="text" id="m-prompt" value="' + escapeHtml(value) + '"></label>',
      [{ label: 'Cancel', ghost: true }, {
        label: 'OK', primary: true, action: function () {
          onOk(document.getElementById('m-prompt').value || value);
        }
      }]);
  }

  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s';
      t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, kind === 'error' ? 6000 : 3600);
  }

  /* -- Keyboard --------------------------------------------------------------------- */

  function onKey(e) {
    /* Dialog keys are handled first and everywhere — a dialog you cannot
       dismiss from the keyboard is a trap. */
    trapFocus(e);
    if (modalIsOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      return;
    }
    if (/input|textarea|select/i.test((e.target.tagName || ''))) return;
    if (screen !== 'plan') return;
    var mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); var l = Store.undo(); if (l) toast('Undid: ' + l); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); Store.redo(); return; }
    if (mod) return;

    var map = { v: 'select', d: 'door', w: 'window', o: 'opening', m: 'measure', x: 'delete' };
    if (map[e.key.toLowerCase()]) { Store.setTool(map[e.key.toLowerCase()]); return; }
    if (e.key.toLowerCase() === 'f') { Ed.zoomToFit(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); Ed.deleteSelection(); return; }
    if (e.key === 'Escape') { Store.select(null); Store.setTool('select'); return; }

    var step = e.shiftKey ? 0.5 : 0.05;
    if (e.key === 'ArrowLeft') { e.preventDefault(); Ed.nudge(-step, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); Ed.nudge(step, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); Ed.nudge(0, -step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); Ed.nudge(0, step); }
  }

  /* -- Utilities --------------------------------------------------------------------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function relTime(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d < 86400000) return Math.round(d / 3600000) + ' h ago';
    return new Date(ts).toLocaleDateString('en-IE');
  }

  return {
    init: init, show: show, toast: toast,
    openModal: openModal, closeModal: closeModal,
    newProject: newProject, exportModal: exportModal, settingsModal: settingsModal,
    scaleModal: scaleModal, renderInspector: renderInspector, renderProjects: renderProjects
  };
})();

document.addEventListener('DOMContentLoaded', function () { RS.UI.init(); });
