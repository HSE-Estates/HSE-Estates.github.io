/* ---------------------------------------------------------------------------
   Interactive 2D plan editor (brief §15, §30, §31).

   Everything the user can do here writes through RS.Store.do(), so every edit
   is undoable and every AI suggestion has to travel the same road.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Editor = (function () {
  'use strict';

  var G = RS.Geom, S = RS.Schema, Store = RS.Store;

  var host = null;
  var svg = null;
  var view = { x: -2, y: -2, w: 10, h: 8 };
  var drag = null;
  var placing = null;             // object type queued by the palette
  var measurePts = [];
  var guides = [];
  var rafPending = false;
  var onChangeCb = null;

  function mount(el, opts) {
    host = el;
    onChangeCb = (opts || {}).onChange || null;
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    Store.subscribe(function (st, reason) {
      if (reason === 'project' || reason === 'room') { requestRender(); zoomToFit(); }
      else requestRender();
    });
    render();
    zoomToFit();
  }

  /* -- Render -------------------------------------------------------------- */

  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; render(); });
  }

  function render() {
    if (!host || !Store.state.project) return;
    var room = Store.activeRoom();
    /* Handles are sized in pixels and converted to metres, so they stay the
       same size on screen at any zoom. Coarse pointers get a much larger
       invisible hit target — a fingertip is about 9 mm across, which at a
       typical room zoom is several hundred millimetres of floor. */
    var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var mpp = metresPerPixel();
    var markup = RS.Plan.render(Store.state.project, {
      interactive: true,
      room: room,
      rooms: visibleRooms(room),
      activeRoomId: room.id,
      selection: Store.state.selection,
      showStation: true,
      margin: 0.6,
      handleR: mpp * (touch ? 9 : 7),
      hitR: mpp * (touch ? 24 : 12)
    });
    host.innerHTML = markup + overlayMarkup();
    svg = host.querySelector('svg.rs-plan');
    if (!svg) return;
    svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.cursor = cursorForTool();
    if (onChangeCb) onChangeCb();
  }

  /* The rest of the floor, drawn as faded context behind the room being
     edited. Only the active room is interactive, so a neighbour can never be
     dragged by accident. */
  function visibleRooms(room) {
    if (Store.state.view.showFloor === false) return [room];
    var list = S.roomsOnStorey(Store.state.project, room.storey || 0)
      .filter(function (r) { return r.id === room.id || r.points.length >= 3; });
    return list.length ? list : [room];
  }

  /* Guides, the live measure tool and the in-progress hint live in a second
     SVG stacked over the plan so they never end up in an export. */
  function overlayMarkup() {
    if (!guides.length && measurePts.length === 0) return '';
    var s = '<svg class="rs-overlay-svg" xmlns="http://www.w3.org/2000/svg" viewBox="' +
      view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h +
      '" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">';
    guides.forEach(function (g2) {
      if (g2.kind === 'v') {
        s += '<line x1="' + g2.x + '" y1="' + view.y + '" x2="' + g2.x + '" y2="' + (view.y + view.h) +
          '" stroke="#00a499" stroke-width="' + (view.w * 0.0015) + '" stroke-dasharray="' + (view.w * 0.008) + ' ' + (view.w * 0.006) + '"/>';
      } else {
        s += '<line x1="' + view.x + '" y1="' + g2.y + '" x2="' + (view.x + view.w) + '" y2="' + g2.y +
          '" stroke="#00a499" stroke-width="' + (view.w * 0.0015) + '" stroke-dasharray="' + (view.w * 0.008) + ' ' + (view.w * 0.006) + '"/>';
      }
    });
    if (measurePts.length) {
      measurePts.forEach(function (p) {
        s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (view.w * 0.006) + '" fill="#c8102e"/>';
      });
      if (measurePts.length === 2) {
        var a = measurePts[0], b = measurePts[1];
        var d = Math.hypot(b.x - a.x, b.y - a.y);
        var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        s += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
          '" stroke="#c8102e" stroke-width="' + (view.w * 0.002) + '"/>';
        s += '<text x="' + mid.x + '" y="' + (mid.y - view.w * 0.012) + '" font-size="' + (view.w * 0.028) +
          '" fill="#c8102e" stroke="#fff" stroke-width="' + (view.w * 0.008) + '" paint-order="stroke" ' +
          'text-anchor="middle" font-weight="700" font-family="Lato, Segoe UI, Arial, sans-serif">' +
          d.toFixed(2) + ' m</text>';
      }
    }
    return s + '</svg>';
  }

  function cursorForTool() {
    switch (Store.state.tool) {
      case 'door': case 'window': case 'opening': return 'copy';
      case 'object': return 'crosshair';
      case 'measure': return 'crosshair';
      case 'delete': return 'not-allowed';
      case 'pan': return 'grab';
      default: return 'default';
    }
  }

  /* -- Coordinate conversion ------------------------------------------------ */

  function toModel(ev) {
    if (!svg) return { x: 0, y: 0 };
    var rect = svg.getBoundingClientRect();
    /* preserveAspectRatio="xMidYMid meet": work out the letterboxing. */
    var scale = Math.min(rect.width / view.w, rect.height / view.h);
    var offX = (rect.width - view.w * scale) / 2;
    var offY = (rect.height - view.h * scale) / 2;
    return {
      x: view.x + (ev.clientX - rect.left - offX) / scale,
      y: view.y + (ev.clientY - rect.top - offY) / scale
    };
  }

  function pixelsToMetres(px) {
    return px * metresPerPixel();
  }

  /* Model metres per screen pixel at the current zoom. Reads the host rather
     than the SVG so it is valid before the first render too. */
  function metresPerPixel() {
    var rect = (svg || host).getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return view.w / 800;
    var scale = Math.min(rect.width / view.w, rect.height / view.h);
    return 1 / Math.max(1e-6, scale);
  }

  /* -- Pointer handling ----------------------------------------------------- */

  function onPointerDown(ev) {
    if (!Store.state.project) return;
    var room = Store.activeRoom();
    if (!room) return;
    var p = toModel(ev);
    var tool = Store.state.tool;
    var target = ev.target.closest ? ev.target.closest('[data-point],[data-midwall],[data-openinghandle],[data-object],[data-rotate],[data-resize],[data-opening]') : null;

    /* Middle button, space or the pan tool always pans. */
    if (ev.button === 1 || tool === 'pan' || ev.shiftKey) {
      startPan(ev);
      return;
    }

    if (tool === 'measure') {
      if (measurePts.length >= 2) measurePts = [];
      measurePts.push(p);
      requestRender();
      return;
    }

    if (tool === 'door' || tool === 'window' || tool === 'opening') {
      placeOpening(room, p, tool === 'window' ? 'window' : (tool === 'opening' ? 'opening' : 'door'));
      return;
    }

    if (tool === 'object' && placing) {
      placeObject(room, p, placing);
      return;
    }

    if (tool === 'delete') {
      deleteAt(room, target);
      return;
    }

    /* Select tool ---------------------------------------------------------- */
    if (!target) {
      Store.select(null);
      startPan(ev);
      return;
    }

    if (target.hasAttribute('data-point')) {
      var idx = Number(target.getAttribute('data-point'));
      Store.select({ kind: 'point', index: idx });
      startDrag(ev, { type: 'point', index: idx });
    } else if (target.hasAttribute('data-midwall')) {
      var wi = Number(target.getAttribute('data-midwall'));
      var a = room.points[wi], b = room.points[(wi + 1) % room.points.length];
      var newIndex = -1;
      Store.do('Add corner', function () {
        newIndex = S.insertPoint(room, wi, S.newPoint((a.x + b.x) / 2, (a.y + b.y) / 2, 1));
      });
      Store.select({ kind: 'point', index: newIndex });
      startDrag(ev, { type: 'point', index: newIndex });
    } else if (target.hasAttribute('data-openinghandle') || target.hasAttribute('data-opening')) {
      var oid = target.getAttribute('data-openinghandle') || target.getAttribute('data-opening');
      Store.select({ kind: 'opening', id: oid });
      startDrag(ev, { type: 'opening', id: oid });
    } else if (target.hasAttribute('data-rotate')) {
      Store.select({ kind: 'object', id: target.getAttribute('data-rotate') });
      startDrag(ev, { type: 'rotate', id: target.getAttribute('data-rotate') });
    } else if (target.hasAttribute('data-resize')) {
      Store.select({ kind: 'object', id: target.getAttribute('data-resize') });
      startDrag(ev, { type: 'resize', id: target.getAttribute('data-resize') });
    } else if (target.hasAttribute('data-object')) {
      var id = target.getAttribute('data-object');
      Store.select({ kind: 'object', id: id });
      var ob = findObject(room, id);
      startDrag(ev, { type: 'object', id: id, grab: { x: p.x - ob.x, y: p.y - ob.y } });
    }
  }

  function startDrag(ev, info) {
    drag = info;
    drag.moved = false;
    drag.start = toModel(ev);
    Store.begin();
    /* Capture keeps the drag alive if the finger leaves the element. It throws
       for a pointer id that is no longer active, which must not abort the
       drag — the move/up listeners below work without it. */
    try { host.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
    host.addEventListener('pointermove', onDragMove);
    host.addEventListener('pointerup', onDragEnd);
    host.addEventListener('pointercancel', onDragEnd);
    ev.preventDefault();
  }

  function onDragMove(ev) {
    if (!drag) return;
    var room = Store.activeRoom();
    var p = toModel(ev);
    drag.moved = true;
    guides = [];

    if (drag.type === 'point') {
      var snapped = Store.state.view.snap
        ? G.snapCorner(room, drag.index, p, { tol: pixelsToMetres(10), grid: Store.state.view.grid || 0 })
        : { x: p.x, y: p.y, guides: [] };
      guides = snapped.guides || [];
      room.points[drag.index].x = G.round(snapped.x, 4);
      room.points[drag.index].y = G.round(snapped.y, 4);
      room.points[drag.index].confidence = 1;   // a human placed it
    } else if (drag.type === 'object') {
      var ob = findObject(room, drag.id);
      if (!ob || ob.locked) return;
      ob.x = G.round(p.x - drag.grab.x, 4);
      ob.y = G.round(p.y - drag.grab.y, 4);
      if (Store.state.view.snap) {
        var snapWall = G.snapObjectToWall(room, ob, 0.35);
        if (snapWall) { ob.x = snapWall.x; ob.y = snapWall.y; ob.rot = snapWall.rot; }
      }
    } else if (drag.type === 'opening') {
      var op = findOpening(room, drag.id);
      if (!op) return;
      var hit = G.projectOntoWalls(room, p);
      if (hit) {
        op.wallIndex = hit.wallIndex;
        var len = S.wallLength(room, hit.wallIndex);
        op.offset = G.round(G.clamp(hit.offset, op.width / 2, Math.max(op.width / 2, len - op.width / 2)), 3);
      }
    } else if (drag.type === 'rotate') {
      var o2 = findObject(room, drag.id);
      if (!o2) return;
      var ang = Math.atan2(p.y - o2.y, p.x - o2.x) * 180 / Math.PI + 90;
      if (Store.state.view.snap && !ev.altKey) ang = Math.round(ang / 15) * 15;
      o2.rot = G.round(((ang % 360) + 360) % 360, 1);
    } else if (drag.type === 'resize') {
      var o3 = findObject(room, drag.id);
      if (!o3) return;
      var t = -o3.rot * Math.PI / 180;
      var dx = p.x - o3.x, dy = p.y - o3.y;
      var lx = dx * Math.cos(t) - dy * Math.sin(t);
      var ly = dx * Math.sin(t) + dy * Math.cos(t);
      o3.w = G.round(Math.max(0.1, Math.abs(lx) * 2), 3);
      o3.d = G.round(Math.max(0.1, Math.abs(ly) * 2), 3);
      o3.measured = true;
    }
    requestRender();
  }

  function onDragEnd() {
    host.removeEventListener('pointermove', onDragMove);
    host.removeEventListener('pointerup', onDragEnd);
    host.removeEventListener('pointercancel', onDragEnd);
    guides = [];
    if (drag && drag.moved) {
      Store.end(dragLabel(drag.type));
      Store.emit('change');
    } else {
      Store.cancel();
    }
    drag = null;
    requestRender();
  }

  function dragLabel(t) {
    return { point: 'Move corner', object: 'Move object', opening: 'Move opening',
             rotate: 'Rotate object', resize: 'Resize object' }[t] || 'Edit';
  }

  /* -- Pan and zoom --------------------------------------------------------- */

  function startPan(ev) {
    var start = { x: ev.clientX, y: ev.clientY };
    var v0 = { x: view.x, y: view.y };
    var rect = svg ? svg.getBoundingClientRect() : host.getBoundingClientRect();
    var scale = Math.min(rect.width / view.w, rect.height / view.h);
    function move(e) {
      view.x = v0.x - (e.clientX - start.x) / scale;
      view.y = v0.y - (e.clientY - start.y) / scale;
      applyView();
    }
    function up() {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
    }
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
  }

  function applyView() {
    if (svg) svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
    var ov = host.querySelector('.rs-overlay-svg');
    if (ov) ov.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
  }

  function onWheel(ev) {
    ev.preventDefault();
    var factor = Math.exp((ev.deltaY > 0 ? 1 : -1) * 0.14);
    zoomAt(toModel(ev), factor);
  }

  function zoomAt(centre, factor) {
    var nw = G.clamp(view.w * factor, 0.6, 250);
    var f = nw / view.w;
    view.x = centre.x - (centre.x - view.x) * f;
    view.y = centre.y - (centre.y - view.y) * f;
    view.w *= f;
    view.h *= f;
    applyView();
  }

  function zoomBy(factor) {
    zoomAt({ x: view.x + view.w / 2, y: view.y + view.h / 2 }, factor);
  }

  function zoomToFit(wholeFloor) {
    var room = Store.activeRoom();
    if (!room || !room.points.length) { view = { x: -3, y: -3, w: 10, h: 8 }; applyView(); return; }
    var target = wholeFloor ? visibleRooms(room) : [room];
    var b = RS.Plan.sheetBounds(target, Store.state.project.presentation, { margin: 0.4 });
    var rect = host.getBoundingClientRect();
    /* The plan screen may still be hidden when this fires, in which case the
       host has no size and every derived number is Infinity. Come back once it
       has been laid out. */
    if (rect.width < 2 || rect.height < 2) {
      requestAnimationFrame(function () {
        var r2 = host.getBoundingClientRect();
        if (r2.width >= 2 && r2.height >= 2) zoomToFit();
      });
      return;
    }
    var aspect = rect.width / rect.height;
    var w = b.w, h = b.h;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    view = { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w: w, h: h };
    applyView();
  }

  /* -- Placement ------------------------------------------------------------ */

  function placeOpening(room, p, type) {
    var hit = G.projectOntoWalls(room, p);
    if (!hit) return;
    var len = S.wallLength(room, hit.wallIndex);
    var def = S.OPENING_TYPES[type];
    if (len < def.width + 0.05) {
      toast('That wall is too short for a ' + def.label.toLowerCase() + '.', 'warn');
      return;
    }
    var op;
    Store.do('Add ' + def.label.toLowerCase(), function () {
      op = S.newOpening(type, hit.wallIndex, G.clamp(hit.offset, def.width / 2, len - def.width / 2));
      room.openings.push(op);
    });
    Store.select({ kind: 'opening', id: op.id });
    Store.setTool('select');
  }

  function placeObject(room, p, type) {
    var ob;
    Store.do('Add ' + (S.OBJECTS[type] || {}).label, function () {
      ob = S.newObject(type, p.x, p.y, 0);
      var snap = G.snapObjectToWall(room, ob, 0.6);
      if (snap && Store.state.view.snap) { ob.x = snap.x; ob.y = snap.y; ob.rot = snap.rot; }
      room.objects.push(ob);
    });
    Store.select({ kind: 'object', id: ob.id });
    placing = null;
    Store.setTool('select');
  }

  function deleteAt(room, target) {
    if (!target) return;
    if (target.hasAttribute('data-object')) {
      var id = target.getAttribute('data-object');
      Store.do('Delete object', function () {
        room.objects = room.objects.filter(function (o) { return o.id !== id; });
      });
    } else if (target.hasAttribute('data-opening') || target.hasAttribute('data-openinghandle')) {
      var oid = target.getAttribute('data-opening') || target.getAttribute('data-openinghandle');
      Store.do('Delete opening', function () {
        room.openings = room.openings.filter(function (o) { return o.id !== oid; });
      });
    } else if (target.hasAttribute('data-point')) {
      var idx = Number(target.getAttribute('data-point'));
      if (room.points.length <= 3) { toast('A room needs at least three corners.', 'warn'); return; }
      Store.do('Delete corner', function () { S.removePoint(room, idx); });
    }
    Store.select(null);
  }

  /* -- Commands used by the inspector and keyboard -------------------------- */

  function deleteSelection() {
    var room = Store.activeRoom();
    var sel = Store.state.selection;
    if (!room || !sel) return;
    if (sel.kind === 'object') {
      Store.do('Delete object', function () {
        room.objects = room.objects.filter(function (o) { return o.id !== sel.id; });
      });
    } else if (sel.kind === 'opening') {
      Store.do('Delete opening', function () {
        room.openings = room.openings.filter(function (o) { return o.id !== sel.id; });
      });
    } else if (sel.kind === 'point') {
      if (room.points.length <= 3) { toast('A room needs at least three corners.', 'warn'); return; }
      Store.do('Delete corner', function () { S.removePoint(room, sel.index); });
    }
    Store.select(null);
  }

  function nudge(dx, dy) {
    var room = Store.activeRoom();
    var sel = Store.state.selection;
    if (!room || !sel) return;
    Store.do('Nudge', function () {
      if (sel.kind === 'point') {
        room.points[sel.index].x = G.round(room.points[sel.index].x + dx, 4);
        room.points[sel.index].y = G.round(room.points[sel.index].y + dy, 4);
      } else if (sel.kind === 'object') {
        var ob = findObject(room, sel.id);
        if (ob) { ob.x = G.round(ob.x + dx, 4); ob.y = G.round(ob.y + dy, 4); }
      }
    });
  }

  /* Set an exact wall length by moving the far end along the wall direction,
     and carrying the rest of the polygon with it. This is how a tape
     measurement becomes the truth. */
  function setWallLength(wallIndex, metres) {
    var room = Store.activeRoom();
    if (!room) return;
    var nPts = room.points.length;
    var a = room.points[wallIndex];
    var b = room.points[(wallIndex + 1) % nPts];
    var cur = Math.hypot(b.x - a.x, b.y - a.y);
    if (cur < 1e-4 || !(metres > 0.05)) return;
    var dir = G.norm(G.sub(b, a));
    var delta = metres - cur;
    Store.do('Set wall length', function () {
      /* Move the end point and everything after it, up to the start point,
         so the shape of the rest of the room is preserved. */
      var moved = {};
      var idx = (wallIndex + 1) % nPts;
      for (var k = 0; k < nPts - 1; k++) {
        var i = (idx + k) % nPts;
        if (i === wallIndex) break;
        if (moved[i]) continue;
        room.points[i].x = G.round(room.points[i].x + dir.x * delta, 4);
        room.points[i].y = G.round(room.points[i].y + dir.y * delta, 4);
        moved[i] = true;
      }
    });
  }

  function squareUpRoom() {
    var room = Store.activeRoom();
    if (!room) return;
    Store.do('Square up outline', function () {
      var squared = G.squareUp(room.points, 14, 80);
      squared.forEach(function (p, i) { room.points[i].x = p.x; room.points[i].y = p.y; });
    });
    toast('Outline squared to the dominant orientation.');
  }

  function setPlacing(type) {
    placing = type;
    Store.setTool('object');
  }

  function findObject(room, id) {
    return room.objects.filter(function (o) { return o.id === id; })[0];
  }
  function findOpening(room, id) {
    return room.openings.filter(function (o) { return o.id === id; })[0];
  }

  function focusOn(target) {
    var room = Store.activeRoom();
    if (!room || !target) return;
    if (target.kind === 'object') {
      var ob = findObject(room, target.id);
      if (ob) { centreOn(ob); Store.select({ kind: 'object', id: ob.id }); }
    } else if (target.kind === 'opening') {
      var op = findOpening(room, target.id);
      if (op) { centreOn(RS.Plan.openingCentre(room, op)); Store.select({ kind: 'opening', id: op.id }); }
    } else if (target.kind === 'point') {
      centreOn(room.points[target.index]);
      Store.select({ kind: 'point', index: target.index });
    } else if (target.kind === 'room') {
      Store.setActiveRoom(target.id);
      zoomToFit();
    } else if (target.kind === 'wall') {
      var a = room.points[target.index];
      var b = room.points[(target.index + 1) % room.points.length];
      centreOn({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  }

  function centreOn(p) {
    if (!p) return;
    view.x = p.x - view.w / 2;
    view.y = p.y - view.h / 2;
    applyView();
  }

  function toast(msg, kind) {
    if (RS.UI && RS.UI.toast) RS.UI.toast(msg, kind);
  }

  function getSvg() { return svg; }
  function getView() { return view; }
  function clearMeasure() { measurePts = []; requestRender(); }

  return {
    mount: mount, render: render, requestRender: requestRender,
    zoomToFit: zoomToFit, zoomBy: zoomBy,
    setPlacing: setPlacing,
    deleteSelection: deleteSelection, nudge: nudge,
    setWallLength: setWallLength, squareUpRoom: squareUpRoom,
    focusOn: focusOn, clearMeasure: clearMeasure,
    getSvg: getSvg, getView: getView,
    toModel: toModel
  };
})();
