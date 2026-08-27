/* ---------------------------------------------------------------------------
   Structured geometry → SVG floor plan (brief §16).

   The drawing is produced from the Layer A model every time. There is no
   intermediate image, no AI-generated artwork and no second source of truth,
   which is what lets the same geometry drive the screen, the PDF and the DXF.

   The SVG user unit IS the metre. Line weights and text sizes are therefore
   metric constants, and the drawing is scale-correct at any zoom or paper size.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Plan = (function () {
  'use strict';

  var G = RS.Geom, S = RS.Schema;

  /* Style presets. Layer B only — none of this can change a measurement. */
  var STYLES = {
    technical: {
      paper: '#ffffff',
      floor: 'none',
      wall: '#16211f',
      wallStroke: '#16211f',
      wallStrokeW: 0.012,
      line: '#16211f',
      lineW: 0.016,
      object: '#3d4b48',
      objectFill: 'none',
      objectW: 0.014,
      dim: '#006354',
      dimW: 0.008,
      label: '#16211f',
      sub: '#3d4b48',
      shadow: false,
      grid: '#e7ecea'
    },
    presentation: {
      paper: '#ffffff',
      floor: '#f2f5f3',
      wall: '#2b3a37',
      wallStroke: '#2b3a37',
      wallStrokeW: 0.010,
      line: '#2b3a37',
      lineW: 0.014,
      object: '#5d6d69',
      objectFill: '#ffffff',
      objectW: 0.013,
      dim: '#006354',
      dimW: 0.008,
      label: '#16211f',
      sub: '#6b7a76',
      shadow: false,
      grid: '#eef2f0'
    },
    plan25: {
      paper: '#ffffff',
      floor: '#eef3f1',
      wall: '#243330',
      wallStroke: '#1a2523',
      wallStrokeW: 0.010,
      line: '#243330',
      lineW: 0.014,
      object: '#54645f',
      objectFill: '#ffffff',
      objectW: 0.013,
      dim: '#006354',
      dimW: 0.008,
      label: '#16211f',
      sub: '#6b7a76',
      shadow: true,
      grid: '#eef2f0'
    }
  };

  var TEXT = { name: 0.30, area: 0.20, dim: 0.15, small: 0.13 };
  var DIM_OFFSET = 0.55;      // metres beyond the outer wall face
  var HANDLE_R = 0.085;

  function n(v) { return Math.round(v * 10000) / 10000; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* -- Public entry ------------------------------------------------------- */

  function render(project, opts) {
    opts = opts || {};
    var pres = Object.assign({}, project.presentation, opts.presentation || {});
    var st = STYLES[pres.style] || STYLES.technical;
    var rooms = opts.rooms || project.rooms;
    var box = sheetBounds(rooms, pres, opts);

    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" ' +
      'viewBox="' + n(box.x) + ' ' + n(box.y) + ' ' + n(box.w) + ' ' + n(box.h) + '" ' +
      'width="' + n(box.w * 100) + 'mm" height="' + n(box.h * 100) + 'mm" ' +
      'preserveAspectRatio="xMidYMid meet" class="rs-plan" data-style="' + esc(pres.style) + '" ' +
      /* A floor plan is pure graphics to a screen reader without this. The
         description carries the numbers that matter: rooms, sizes, areas. */
      'role="img" aria-label="' + esc(describe(rooms, pres)) + '">');
    out.push('<title>' + esc(describe(rooms, pres)) + '</title>');
    out.push(defs(st));
    out.push('<rect x="' + n(box.x) + '" y="' + n(box.y) + '" width="' + n(box.w) +
      '" height="' + n(box.h) + '" fill="' + st.paper + '" class="rs-paper"/>');

    if (pres.showGrid) out.push(grid(box, st));

    /* Context rooms — the rest of the floor — are drawn faded and without
       dimensions, so the active room stays legible while its neighbours give
       it somewhere to belong. */
    rooms.forEach(function (room) {
      var isContext = opts.activeRoomId && room.id !== opts.activeRoomId;
      if (!isContext) return;
      var quiet = Object.assign({}, pres, {
        showDimensions: false, showAreas: false, showGrid: false
      });
      out.push('<g class="rs-context" opacity="0.42" pointer-events="none">' +
        renderRoom(room, quiet, st, { selection: null, siblings: rooms }) + '</g>');
    });
    rooms.forEach(function (room) {
      if (opts.activeRoomId && room.id !== opts.activeRoomId) return;
      out.push(renderRoom(room, pres, st, Object.assign({}, opts, { siblings: rooms })));
    });

    if (pres.showNorth) out.push(northArrow(box, st));
    out.push(scaleBar(box, st, pres));

    if (opts.interactive) out.push(handles(opts.room || rooms[0], opts, st));

    out.push('</svg>');
    return out.join('');
  }

  /* A sentence a screen reader can actually read out, and a useful <title>
     tooltip besides. */
  function describe(rooms, pres) {
    var drawn = rooms.filter(function (r) { return r.points.length >= 3; });
    if (!drawn.length) return 'Empty floor plan.';
    var units = pres.dimensionUnits;
    var parts = drawn.map(function (r) {
      var b = S.bounds(r);
      var openings = r.openings.length;
      return (r.name || 'Room') + ', ' +
        G.formatArea(S.roomArea(r), units) + ', ' +
        G.formatLength(b.w, units) + ' by ' + G.formatLength(b.h, units) +
        (units === 'm' ? ' metres' : '') +
        (openings ? ', ' + openings + ' door or window opening' + (openings === 1 ? '' : 's') : '') +
        (r.objects.length ? ', ' + r.objects.length + ' item' + (r.objects.length === 1 ? '' : 's') : '');
    });
    var total = drawn.reduce(function (t, r) { return t + S.roomArea(r); }, 0);
    return 'Floor plan. ' + drawn.length + ' room' + (drawn.length === 1 ? '' : 's') +
      ', total floor area ' + G.formatArea(total, units) + '. ' + parts.join('. ') + '.';
  }

  function renderRoom(room, pres, st, opts) {
    opts = opts || {};
    S.syncWalls(room);
    if (room.points.length < 3) return '';

    var pts = room.points;
    var thick = room.walls.map(function (w) { return w.thickness; });
    var outer = G.offsetPolygon(pts, thick);

    var g = ['<g class="rs-room" data-room="' + esc(room.id) + '">'];

    /* 2.5D drop shadow. It has to go down FIRST: it is cast by the wall band
       onto the sheet, so the floor and the walls both paint over it. */
    if (st.shadow) {
      g.push('<path class="rs-shadow" d="' + polyPath(outer) + '" fill="rgba(22,33,31,.22)" ' +
        'transform="translate(0.07 0.09)" filter="url(#rs-blur)"/>');
    }

    /* Floor -------------------------------------------------------------- */
    if (st.floor !== 'none') {
      g.push('<path class="rs-floor" d="' + polyPath(pts) + '" fill="' + st.floor + '"/>');
    }

    /* Wall band: outer ring minus inner ring, even-odd ------------------- */
    g.push('<path class="rs-walls" fill-rule="evenodd" fill="' + st.wall + '" ' +
      'stroke="' + st.wallStroke + '" stroke-width="' + st.wallStrokeW + '" ' +
      'stroke-linejoin="round" d="' + polyPath(outer) + ' ' + polyPath(pts.slice().reverse()) + '"/>');

    if (st.shadow) {
      /* A lighter inner face reads as wall thickness catching the light. */
      g.push('<path class="rs-wall-top" d="' + polyPath(pts) + '" fill="none" ' +
        'stroke="rgba(255,255,255,.30)" stroke-width="0.03"/>');
    }

    /* Openings ------------------------------------------------------------ */
    g.push('<g class="rs-openings">');
    room.openings.forEach(function (op) {
      g.push(renderOpening(room, op, st, opts));
    });
    g.push('</g>');

    /* Objects ------------------------------------------------------------- */
    if (pres.showFurniture) {
      g.push('<g class="rs-objects">');
      room.objects.forEach(function (ob) {
        var sel = isSelected(opts, 'object', ob.id);
        g.push('<g class="rs-object' + (sel ? ' is-selected' : '') + '" data-object="' + esc(ob.id) + '" ' +
          'transform="translate(' + n(ob.x) + ' ' + n(ob.y) + ') rotate(' + n(ob.rot) + ')" ' +
          'fill="' + st.objectFill + '" stroke="' + (sel ? '#00a499' : st.object) + '" ' +
          'stroke-width="' + (sel ? st.objectW * 1.8 : st.objectW) + '" stroke-linejoin="round">');
        g.push(RS.Symbols.draw(ob.type, ob.w, ob.d));
        if (ob.confidence < 0.55) {
          g.push('<rect x="' + n(-ob.w / 2 - 0.04) + '" y="' + n(-ob.d / 2 - 0.04) + '" width="' + n(ob.w + 0.08) +
            '" height="' + n(ob.d + 0.08) + '" fill="none" stroke="#c8102e" stroke-width="0.012" stroke-dasharray="0.08 0.06"/>');
        }
        g.push('</g>');
      });
      g.push('</g>');
    }

    /* Labels -------------------------------------------------------------- */
    if (pres.showLabels || pres.showAreas) {
      var c = labelAnchor(room);
      var name = room.name || (S.ROOM_TYPES.filter(function (t) { return t.id === room.type; })[0] || {}).label || 'Room';
      var area = S.roomArea(room);
      g.push('<g class="rs-label" text-anchor="middle" font-family="Lato, Segoe UI, Helvetica, Arial, sans-serif">');
      if (pres.showLabels) {
        g.push(text(name.toUpperCase(), c.x, c.y - (pres.showAreas ? 0.06 : -0.06), TEXT.name, st.label, st.paper, 700, 0.07));
      }
      if (pres.showAreas) {
        var dims = S.bounds(room);
        var sub = G.formatArea(area, pres.dimensionUnits) + '  ·  ' +
          G.formatLength(dims.w, pres.dimensionUnits) + ' × ' + G.formatLength(dims.h, pres.dimensionUnits) +
          (pres.dimensionUnits === 'm' ? ' m' : '');
        g.push(text(sub, c.x, c.y + (pres.showLabels ? 0.30 : 0.10), TEXT.area, st.sub, st.paper, 400, 0.055));
      }
      g.push('</g>');
    }

    /* Dimensions ---------------------------------------------------------- */
    if (pres.showDimensions) {
      var others = (opts.siblings || []).filter(function (r) {
        return r.id !== room.id && r.points.length >= 3;
      });
      g.push('<g class="rs-dims" stroke="' + st.dim + '" stroke-width="' + st.dimW + '" fill="none">');
      for (var i = 0; i < pts.length; i++) {
        /* On a multi-room sheet a dimension is drawn outwards, which for an
           internal wall means straight into the neighbouring room. Those are
           the ones to drop: the room's own size is already on its label, and
           an unattributed "2.50" floating inside the hall is worse than no
           dimension at all. */
        if (others.length && dimensionFallsInsideAnother(room, i, others)) continue;
        g.push(dimension(room, i, pres, st));
      }
      g.push('</g>');
    }

    g.push('</g>');
    return g.join('');
  }

  /* -- Openings ------------------------------------------------------------ */

  function renderOpening(room, op, st, opts) {
    var nPts = room.points.length;
    var a = room.points[op.wallIndex];
    var b = room.points[(op.wallIndex + 1) % nPts];
    var dir = G.norm(G.sub(b, a));
    var inward = G.wallNormal(room, op.wallIndex);
    var outward = { x: -inward.x, y: -inward.y };
    var th = room.walls[op.wallIndex].thickness;

    var half = op.width / 2;
    var wallLen = Math.hypot(b.x - a.x, b.y - a.y);
    var centre = G.clamp(op.offset, half, Math.max(half, wallLen - half));
    var p0 = { x: a.x + dir.x * (centre - half), y: a.y + dir.y * (centre - half) };
    var p1 = { x: a.x + dir.x * (centre + half), y: a.y + dir.y * (centre + half) };

    var eps = 0.006;
    var q0 = { x: p0.x + outward.x * (th + eps), y: p0.y + outward.y * (th + eps) };
    var q1 = { x: p1.x + outward.x * (th + eps), y: p1.y + outward.y * (th + eps) };
    var i0 = { x: p0.x - outward.x * eps, y: p0.y - outward.y * eps };
    var i1 = { x: p1.x - outward.x * eps, y: p1.y - outward.y * eps };

    var sel = isSelected(opts, 'opening', op.id);
    var stroke = sel ? '#00a499' : st.line;
    var sw = sel ? st.lineW * 1.7 : st.lineW;

    var g = ['<g class="rs-opening' + (sel ? ' is-selected' : '') + '" data-opening="' + esc(op.id) + '">'];

    /* Cut the wall band away across the opening. */
    g.push('<path d="M ' + n(i0.x) + ' ' + n(i0.y) + ' L ' + n(q0.x) + ' ' + n(q0.y) +
      ' L ' + n(q1.x) + ' ' + n(q1.y) + ' L ' + n(i1.x) + ' ' + n(i1.y) + ' Z" fill="' + st.paper + '"/>');

    /* Jambs. */
    g.push('<path d="M ' + n(p0.x) + ' ' + n(p0.y) + ' L ' + n(p0.x + outward.x * th) + ' ' + n(p0.y + outward.y * th) +
      ' M ' + n(p1.x) + ' ' + n(p1.y) + ' L ' + n(p1.x + outward.x * th) + ' ' + n(p1.y + outward.y * th) +
      '" stroke="' + stroke + '" stroke-width="' + sw + '" fill="none"/>');

    if (op.type === 'window' || op.type === 'patio') {
      var mid = th / 2;
      var glassOff = th * 0.28;
      g.push('<path d="' +
        'M ' + n(p0.x + outward.x * (mid - glassOff)) + ' ' + n(p0.y + outward.y * (mid - glassOff)) +
        ' L ' + n(p1.x + outward.x * (mid - glassOff)) + ' ' + n(p1.y + outward.y * (mid - glassOff)) +
        ' M ' + n(p0.x + outward.x * (mid + glassOff)) + ' ' + n(p0.y + outward.y * (mid + glassOff)) +
        ' L ' + n(p1.x + outward.x * (mid + glassOff)) + ' ' + n(p1.y + outward.y * (mid + glassOff)) +
        '" stroke="' + stroke + '" stroke-width="' + sw + '" fill="none"/>');
    } else if (op.type === 'sliding') {
      var o1 = th * 0.30, o2 = th * 0.66;
      g.push('<path d="' +
        'M ' + n(p0.x + outward.x * o1) + ' ' + n(p0.y + outward.y * o1) +
        ' L ' + n(midPt(p0, p1, 0.55).x + outward.x * o1) + ' ' + n(midPt(p0, p1, 0.55).y + outward.y * o1) +
        ' M ' + n(midPt(p0, p1, 0.45).x + outward.x * o2) + ' ' + n(midPt(p0, p1, 0.45).y + outward.y * o2) +
        ' L ' + n(p1.x + outward.x * o2) + ' ' + n(p1.y + outward.y * o2) +
        '" stroke="' + stroke + '" stroke-width="' + sw * 1.4 + '" fill="none"/>');
    } else if (op.type === 'door' || op.type === 'double') {
      /* A joined door is one physical door held in two rooms' models, and both
         would draw a leaf — two arcs crossing in the same doorway. Draw it from
         one side only, chosen deterministically so it does not flicker between
         renders or differ between the screen and the export. */
      var duplicate = op.link && String(op.id) > String(op.link.openingId);
      if (!duplicate) {
        g.push(doorLeaf(p0, p1, dir, inward, op, stroke, sw, op.type === 'double'));
      }
    }
    /* 'opening' draws jambs only — a plain structural opening. */

    g.push('</g>');
    return g.join('');
  }

  function doorLeaf(p0, p1, dir, inward, op, stroke, sw, isDouble) {
    var swingN = op.swing === 'out' ? { x: -inward.x, y: -inward.y } : inward;
    var out = [];

    function leaf(hingePt, leafDir, r) {
      var tip = { x: hingePt.x + leafDir.x * r, y: hingePt.y + leafDir.y * r };
      var open = { x: hingePt.x + swingN.x * r, y: hingePt.y + swingN.y * r };
      var sweep = (leafDir.x * swingN.y - leafDir.y * swingN.x) > 0 ? 1 : 0;
      out.push('<path d="M ' + n(tip.x) + ' ' + n(tip.y) +
        ' A ' + n(r) + ' ' + n(r) + ' 0 0 ' + sweep + ' ' + n(open.x) + ' ' + n(open.y) +
        '" stroke="' + stroke + '" stroke-width="' + (sw * 0.7) + '" fill="none" stroke-dasharray="none" opacity=".75"/>');
      out.push('<path d="M ' + n(hingePt.x) + ' ' + n(hingePt.y) + ' L ' + n(open.x) + ' ' + n(open.y) +
        '" stroke="' + stroke + '" stroke-width="' + sw + '" fill="none"/>');
    }

    var w = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (isDouble) {
      var mid = midPt(p0, p1, 0.5);
      leaf(p0, dir, w / 2);
      leaf(p1, { x: -dir.x, y: -dir.y }, w / 2);
      void mid;
    } else if (op.hinge === 'end') {
      leaf(p1, { x: -dir.x, y: -dir.y }, w);
    } else {
      leaf(p0, dir, w);
    }
    return out.join('');
  }

  function midPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  /* -- Dimensions ---------------------------------------------------------- */

  function dimension(room, i, pres, st) {
    var nPts = room.points.length;
    var a = room.points[i];
    var b = room.points[(i + 1) % nPts];
    var L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 0.25) return '';

    var dir = G.norm(G.sub(b, a));
    var inward = G.wallNormal(room, i);
    var out = { x: -inward.x, y: -inward.y };
    var off = room.walls[i].thickness + DIM_OFFSET;

    var A = { x: a.x + out.x * off, y: a.y + out.y * off };
    var B = { x: b.x + out.x * off, y: b.y + out.y * off };
    var ext = 0.12;

    var s = '<g class="rs-dim" data-wall="' + i + '">';
    /* Witness lines back to the wall face. */
    s += '<path d="M ' + n(a.x + out.x * (room.walls[i].thickness + 0.08)) + ' ' + n(a.y + out.y * (room.walls[i].thickness + 0.08)) +
      ' L ' + n(A.x + out.x * ext) + ' ' + n(A.y + out.y * ext) +
      ' M ' + n(b.x + out.x * (room.walls[i].thickness + 0.08)) + ' ' + n(b.y + out.y * (room.walls[i].thickness + 0.08)) +
      ' L ' + n(B.x + out.x * ext) + ' ' + n(B.y + out.y * ext) + '" opacity=".7"/>';
    /* Dimension line with 45° architectural ticks. */
    s += '<path d="M ' + n(A.x) + ' ' + n(A.y) + ' L ' + n(B.x) + ' ' + n(B.y) + '"/>';
    s += tick(A, dir, out) + tick(B, dir, out);

    var mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    var ang = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
    if (ang > 90 || ang < -90) ang += 180;
    var label = G.formatLength(L, pres.dimensionUnits);

    s += '<g transform="translate(' + n(mid.x) + ' ' + n(mid.y) + ') rotate(' + n(ang) + ')">' +
      text(label, 0, -0.07, TEXT.dim, st.dim, st.paper, 700, 0.045) + '</g>';
    s += '</g>';
    return s;
  }

  /* Would this wall's dimension line land inside one of the other rooms? */
  function dimensionFallsInsideAnother(room, i, others) {
    var n = room.points.length;
    var a = room.points[i], b = room.points[(i + 1) % n];
    var inward = G.wallNormal(room, i);
    var off = room.walls[i].thickness + DIM_OFFSET;
    var mid = {
      x: (a.x + b.x) / 2 - inward.x * off,
      y: (a.y + b.y) / 2 - inward.y * off
    };
    return others.some(function (r) { return S.pointInPolygon(mid, r.points); });
  }

  function tick(p, dir, out) {
    var t = 0.09;
    var v = G.norm({ x: dir.x + out.x, y: dir.y + out.y });
    return '<path d="M ' + n(p.x - v.x * t) + ' ' + n(p.y - v.y * t) +
      ' L ' + n(p.x + v.x * t) + ' ' + n(p.y + v.y * t) + '"/>';
  }

  /* -- Text with a paper halo so it stays legible over any linework -------- */
  function text(str, x, y, size, fill, halo, weight, haloW) {
    return '<text x="' + n(x) + '" y="' + n(y) + '" font-size="' + n(size) +
      '" font-weight="' + (weight || 400) + '" fill="' + fill + '" ' +
      'stroke="' + halo + '" stroke-width="' + (haloW || 0.03) + '" paint-order="stroke" ' +
      'stroke-linejoin="round" text-anchor="middle" dominant-baseline="middle" ' +
      'font-family="Lato, Segoe UI, Helvetica, Arial, sans-serif">' + esc(str) + '</text>';
  }

  /* -- Label placement -----------------------------------------------------
     The centroid is the natural home for a room label, but in a furnished
     plan it lands on top of the bed as often as not, and in an L-shaped room
     it can fall outside the room altogether. Score a coarse grid instead:
     reward clearance from the walls, penalise landing on furniture heavily,
     and pull gently back towards the centroid so the label does not wander
     into a corner. */
  function labelAnchor(room) {
    var c = G.centroid(room.points);
    var bb = S.bounds(room);
    var step = G.clamp(Math.min(bb.w, bb.h) / 20, 0.08, 0.30);
    var best = null, bestScore = -Infinity;

    for (var x = bb.minX + step; x <= bb.maxX; x += step) {
      for (var y = bb.minY + step; y <= bb.maxY; y += step) {
        var p = { x: x, y: y };
        if (!S.pointInPolygon(p, room.points)) continue;
        var clear = minEdgeDistance(p, room.points);
        if (clear < 0.30) continue;
        var score = clear * 0.6 - G.dist(p, c) * 0.5;
        if (overlapsObject(room, p)) score -= 4;
        if (score > bestScore) { bestScore = score; best = p; }
      }
    }
    return best || (S.pointInPolygon(c, room.points) ? c : { x: bb.minX + bb.w / 2, y: bb.minY + bb.h / 2 });
  }

  /* Is this point inside any furniture footprint, inflated a little so the
     label never touches an edge? Works in the object's own rotated frame. */
  function overlapsObject(room, p) {
    var pad = 0.22;
    for (var i = 0; i < room.objects.length; i++) {
      var o = room.objects[i];
      var t = -o.rot * Math.PI / 180;
      var dx = p.x - o.x, dy = p.y - o.y;
      var lx = dx * Math.cos(t) - dy * Math.sin(t);
      var ly = dx * Math.sin(t) + dy * Math.cos(t);
      if (Math.abs(lx) <= o.w / 2 + pad && Math.abs(ly) <= o.d / 2 + pad) return true;
    }
    return false;
  }

  function minEdgeDistance(p, pts) {
    var m = Infinity;
    for (var i = 0; i < pts.length; i++) {
      m = Math.min(m, G.closestOnSegment(p, pts[i], pts[(i + 1) % pts.length]).dist);
    }
    return m;
  }

  /* -- Sheet furniture ------------------------------------------------------ */

  function northArrow(box, st) {
    var r = Math.min(box.w, box.h) * 0.045;
    r = G.clamp(r, 0.22, 0.5);
    var cx = box.x + box.w - r * 2.0;
    var cy = box.y + r * 2.0;
    return '<g class="rs-north" fill="' + st.label + '" stroke="' + st.label + '" stroke-width="' + (r * 0.06) + '">' +
      '<path d="M ' + n(cx) + ' ' + n(cy - r) + ' L ' + n(cx + r * 0.42) + ' ' + n(cy + r * 0.72) +
      ' L ' + n(cx) + ' ' + n(cy + r * 0.34) + ' L ' + n(cx - r * 0.42) + ' ' + n(cy + r * 0.72) + ' Z"/>' +
      '<text x="' + n(cx) + '" y="' + n(cy + r * 1.5) + '" font-size="' + n(r * 0.62) +
      '" text-anchor="middle" stroke="none" font-weight="700" ' +
      'font-family="Lato, Segoe UI, Helvetica, Arial, sans-serif">N</text></g>';
  }

  function scaleBar(box, st, pres) {
    var target = box.w * 0.16;
    var steps = [0.5, 1, 2, 5, 10];
    var unit = steps[0];
    for (var i = 0; i < steps.length; i++) if (steps[i] <= target) unit = steps[i];
    var x = box.x + box.w * 0.035;
    var y = box.y + box.h - box.h * 0.035;
    var h = G.clamp(box.h * 0.008, 0.03, 0.07);
    var s = '<g class="rs-scalebar" font-family="Lato, Segoe UI, Helvetica, Arial, sans-serif">';
    for (var k = 0; k < 4; k++) {
      s += '<rect x="' + n(x + unit * k / 2) + '" y="' + n(y) + '" width="' + n(unit / 2) + '" height="' + n(h) +
        '" fill="' + (k % 2 ? st.paper : st.label) + '" stroke="' + st.label + '" stroke-width="' + n(h * 0.14) + '"/>';
    }
    s += '<text x="' + n(x) + '" y="' + n(y - h * 0.8) + '" font-size="' + n(TEXT.small) +
      '" fill="' + st.sub + '" font-family="Lato, Segoe UI, Helvetica, Arial, sans-serif">0</text>';
    s += '<text x="' + n(x + unit * 2) + '" y="' + n(y - h * 0.8) + '" font-size="' + n(TEXT.small) +
      '" fill="' + st.sub + '" text-anchor="end" font-family="Lato, Segoe UI, Helvetica, Arial, sans-serif">' +
      G.formatLength(unit * 2, pres.dimensionUnits) + (pres.dimensionUnits === 'm' ? ' m' : '') + '</text>';
    s += '</g>';
    return s;
  }

  function grid(box, st) {
    return '<g class="rs-grid" stroke="' + st.grid + '" stroke-width="0.006">' +
      '<rect x="' + n(box.x) + '" y="' + n(box.y) + '" width="' + n(box.w) + '" height="' + n(box.h) +
      '" fill="url(#rs-grid-pattern)" stroke="none"/></g>';
  }

  /* -- Interactive handles -------------------------------------------------- */

  function handles(room, opts, st) {
    if (!room || room.points.length < 2) return '';
    var g = ['<g class="rs-handles">'];

    /* Handle sizes arrive in METRES from the editor, which converts them from
       a fixed pixel size at the current zoom. Without that, a handle is a
       constant size in the room rather than on the screen — fine on a desktop
       at 1:50, and about seven pixels across on a phone. The visible dot stays
       small; an invisible disc behind it carries the touch target. */
    var hr = opts.handleR || HANDLE_R;
    var hit = Math.max(hr, opts.hitR || hr);
    var sw = hr * 0.26;

    function grip(cls, attr, id, x, y, r, fill, stroke, strokeW) {
      return '<circle class="rs-hit" ' + attr + '="' + id + '" cx="' + n(x) + '" cy="' + n(y) +
             '" r="' + n(hit) + '" fill="transparent" stroke="none"/>' +
             '<circle class="' + cls + '" ' + attr + '="' + id + '" cx="' + n(x) + '" cy="' + n(y) +
             '" r="' + n(r) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + n(strokeW) + '"/>';
    }

    /* Corner handles. */
    room.points.forEach(function (p, i) {
      var sel = isSelected(opts, 'point', null, i);
      g.push(grip('rs-handle rs-handle-point' + (sel ? ' is-selected' : ''), 'data-point', i,
        p.x, p.y, hr, sel ? '#00a499' : '#ffffff', '#006354', sw));
    });

    /* Midpoint handles insert a new corner. */
    for (var i = 0; i < room.points.length; i++) {
      var a = room.points[i], b = room.points[(i + 1) % room.points.length];
      /* Skip walls too short to hold a midpoint grip without covering both ends. */
      if (Math.hypot(b.x - a.x, b.y - a.y) < hit * 4) continue;
      g.push(grip('rs-handle rs-handle-mid', 'data-midwall', i,
        (a.x + b.x) / 2, (a.y + b.y) / 2, hr * 0.62, '#ffffff', '#a9b5b1', sw * 0.8));
    }

    /* Opening handles sit on the wall centreline. */
    room.openings.forEach(function (op) {
      var pos = openingCentre(room, op);
      if (!pos) return;
      var sel = isSelected(opts, 'opening', op.id);
      g.push(grip('rs-handle rs-handle-opening' + (sel ? ' is-selected' : ''), 'data-openinghandle',
        esc(op.id), pos.x, pos.y, hr * 0.8, sel ? '#00a499' : '#ffffff', '#006354', sw));
    });

    /* Selected object gets a bounding box and a rotate grip. */
    if (opts.selection && opts.selection.kind === 'object') {
      var ob = room.objects.filter(function (o) { return o.id === opts.selection.id; })[0];
      if (ob) {
        g.push('<g transform="translate(' + n(ob.x) + ' ' + n(ob.y) + ') rotate(' + n(ob.rot) + ')">');
        g.push('<rect x="' + n(-ob.w / 2) + '" y="' + n(-ob.d / 2) + '" width="' + n(ob.w) + '" height="' + n(ob.d) +
          '" fill="none" stroke="#00a499" stroke-width="0.016" stroke-dasharray="0.07 0.05"/>');
        var arm = Math.max(0.32, hit * 1.6);
        g.push('<line x1="0" y1="' + n(-ob.d / 2) + '" x2="0" y2="' + n(-ob.d / 2 - arm) + '" stroke="#00a499" stroke-width="0.016"/>');
        g.push(grip('rs-handle rs-handle-rotate', 'data-rotate', esc(ob.id),
          0, -ob.d / 2 - arm, hr * 0.8, '#ffffff', '#00a499', sw));
        g.push(grip('rs-handle rs-handle-resize', 'data-resize', esc(ob.id),
          ob.w / 2, ob.d / 2, hr * 0.7, '#ffffff', '#00a499', sw));
        g.push('</g>');
      }
    }

    /* Capture station marker, when the room came from a scan. */
    if (room.capture && room.capture.method === 'station' && opts.showStation) {
      /* Decoration only — it must never swallow a tap meant for the corner
         handle it can sit directly on top of. */
      g.push('<g class="rs-station" opacity=".55" pointer-events="none">' +
        '<circle cx="0" cy="0" r="0.11" fill="none" stroke="#006354" stroke-width="0.018"/>' +
        '<circle cx="0" cy="0" r="0.03" fill="#006354"/></g>');
    }

    g.push('</g>');
    void st;
    return g.join('');
  }

  function openingCentre(room, op) {
    var nPts = room.points.length;
    if (op.wallIndex >= nPts) return null;
    var a = room.points[op.wallIndex];
    var b = room.points[(op.wallIndex + 1) % nPts];
    var dir = G.norm(G.sub(b, a));
    var out = G.wallNormal(room, op.wallIndex);
    var th = room.walls[op.wallIndex].thickness;
    return {
      x: a.x + dir.x * op.offset - out.x * th / 2,
      y: a.y + dir.y * op.offset - out.y * th / 2
    };
  }

  function isSelected(opts, kind, id, index) {
    var s = opts && opts.selection;
    if (!s || s.kind !== kind) return false;
    if (id != null) return s.id === id;
    return s.index === index;
  }

  /* -- Helpers -------------------------------------------------------------- */

  function polyPath(pts) {
    if (!pts.length) return '';
    var d = 'M ' + n(pts[0].x) + ' ' + n(pts[0].y);
    for (var i = 1; i < pts.length; i++) d += ' L ' + n(pts[i].x) + ' ' + n(pts[i].y);
    return d + ' Z';
  }

  function sheetBounds(rooms, pres, opts) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var any = false;
    rooms.forEach(function (room) {
      if (!room.points.length) return;
      any = true;
      var pad = 0;
      room.walls.forEach(function (w) { pad = Math.max(pad, w.thickness); });
      pad += pres.showDimensions ? DIM_OFFSET + 0.45 : 0.25;
      room.points.forEach(function (p) {
        minX = Math.min(minX, p.x - pad); minY = Math.min(minY, p.y - pad);
        maxX = Math.max(maxX, p.x + pad); maxY = Math.max(maxY, p.y + pad);
      });
    });
    if (!any) return { x: -2, y: -2, w: 6, h: 5 };
    var margin = (opts && opts.margin != null) ? opts.margin : 0.35;
    minX -= margin; minY -= margin; maxX += margin; maxY += margin;
    return { x: minX, y: minY, w: Math.max(0.5, maxX - minX), h: Math.max(0.5, maxY - minY) };
  }

  function defs(st) {
    return '<defs>' +
      '<filter id="rs-blur" x="-20%" y="-20%" width="140%" height="140%">' +
        '<feGaussianBlur stdDeviation="0.05"/></filter>' +
      '<pattern id="rs-grid-pattern" width="1" height="1" patternUnits="userSpaceOnUse">' +
        '<path d="M 1 0 L 0 0 0 1" fill="none" stroke="' + st.grid + '" stroke-width="0.008"/></pattern>' +
      '<marker id="rs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
        '<path d="M 0 1 L 9 5 L 0 9 z" fill="' + st.object + '"/></marker>' +
      '</defs>';
  }

  return {
    render: render,
    renderRoom: renderRoom,
    describe: describe,
    sheetBounds: sheetBounds,
    labelAnchor: labelAnchor,
    openingCentre: openingCentre,
    STYLES: STYLES,
    TEXT: TEXT,
    DIM_OFFSET: DIM_OFFSET
  };
})();
