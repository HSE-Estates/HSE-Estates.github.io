/* ---------------------------------------------------------------------------
   Geometry operations on the Layer A model. Pure functions — no DOM, no state.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Geom = (function () {
  'use strict';

  var TAU = Math.PI * 2;

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function mul(a, k) { return { x: a.x * k, y: a.y * k }; }
  function len(a) { return Math.hypot(a.x, a.y); }
  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function cross(a, b) { return a.x * b.y - a.y * b.x; }
  function norm(a) { var l = len(a) || 1e-12; return { x: a.x / l, y: a.y / l }; }
  function deg(r) { return r * 180 / Math.PI; }
  function rad(d) { return d * Math.PI / 180; }

  function signedArea(pts) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return s / 2;
  }

  function centroid(pts) {
    if (!pts.length) return { x: 0, y: 0 };
    var a = signedArea(pts);
    if (Math.abs(a) < 1e-9) {
      var sx = 0, sy = 0;
      pts.forEach(function (p) { sx += p.x; sy += p.y; });
      return { x: sx / pts.length, y: sy / pts.length };
    }
    var cx = 0, cy = 0;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      var f = pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      cx += (pts[i].x + pts[j].x) * f;
      cy += (pts[i].y + pts[j].y) * f;
    }
    return { x: cx / (6 * a), y: cy / (6 * a) };
  }

  /* -- Polygon offset -----------------------------------------------------
     Offsets each edge outward by its own distance (so walls can have
     different thicknesses) and re-intersects neighbouring edges with a mitre
     join. This is what turns the boundary polyline into a drawable wall band.
     dists: array, one per edge, in metres. Positive is outward. */
  function offsetPolygon(pts, dists) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    var outward = signedArea(pts) > 0 ? 1 : -1;
    var lines = [];
    for (var i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var d = norm(sub(b, a));
      var nm = { x: d.y * outward, y: -d.x * outward };
      var off = (typeof dists === 'number' ? dists : (dists[i] || 0));
      lines.push({ p: { x: a.x + nm.x * off, y: a.y + nm.y * off }, d: d });
    }
    var out = [];
    for (var k = 0; k < n; k++) {
      var prev = lines[(k - 1 + n) % n];
      var cur = lines[k];
      var hit = intersectLines(prev.p, prev.d, cur.p, cur.d);
      if (!hit) hit = { x: cur.p.x, y: cur.p.y };
      /* Clamp runaway mitres on very sharp corners. */
      if (dist(hit, pts[k]) > 4 * Math.max(0.2, Math.abs(typeof dists === 'number' ? dists : (dists[k] || 0.1)) * 8)) {
        hit = { x: cur.p.x, y: cur.p.y };
      }
      out.push(hit);
    }
    return out;
  }

  function intersectLines(p1, d1, p2, d2) {
    var den = cross(d1, d2);
    if (Math.abs(den) < 1e-9) return null;
    var t = cross(sub(p2, p1), d2) / den;
    return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
  }

  /* Closest point on a segment, plus the parametric position along it. */
  function closestOnSegment(p, a, b) {
    var ab = sub(b, a);
    var l2 = dot(ab, ab);
    var t = l2 < 1e-12 ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
    var q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    return { point: q, t: t, dist: dist(p, q), along: t * Math.sqrt(l2) };
  }

  /* Which wall is this plan point nearest, and how far along it?
     Used by the editor to drop doors and windows and by the capture module
     to place bearing-derived openings. */
  function projectOntoWalls(room, p) {
    var best = null;
    for (var i = 0; i < room.points.length; i++) {
      var a = room.points[i];
      var b = room.points[(i + 1) % room.points.length];
      var r = closestOnSegment(p, a, b);
      if (!best || r.dist < best.dist) {
        best = { wallIndex: i, offset: r.along, dist: r.dist, point: r.point, t: r.t };
      }
    }
    return best;
  }

  /* -- Regularisation -----------------------------------------------------
     Real rooms are overwhelmingly rectilinear, and tap capture is noisy by a
     degree or two. This finds the dominant orientation, then runs a few
     Gauss-Seidel passes pulling near-axis edges onto the axis, moving both
     endpoints by half the correction each so the shape does not drift.
     Edges that are genuinely off-axis (a bay, a splay) are left alone. */
  function squareUp(pts, tolDeg, iterations) {
    tolDeg = tolDeg == null ? 12 : tolDeg;
    iterations = iterations || 60;
    var n = pts.length;
    if (n < 3) return pts;

    var theta = dominantAngle(pts);
    var c = Math.cos(-theta), s = Math.sin(-theta);
    var work = pts.map(function (p) {
      return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, id: p.id, confidence: p.confidence };
    });

    var locked = [];
    for (var i = 0; i < n; i++) {
      var a = work[i], b = work[(i + 1) % n];
      var ang = deg(Math.atan2(b.y - a.y, b.x - a.x));
      var nearest = Math.round(ang / 90) * 90;
      var delta = Math.abs(angDiff(ang, nearest));
      locked.push(delta <= tolDeg ? (Math.abs(((nearest % 180) + 180) % 180) < 45 ? 'h' : 'v') : null);
    }

    for (var it = 0; it < iterations; it++) {
      for (var e = 0; e < n; e++) {
        var kind = locked[e];
        if (!kind) continue;
        var pa = work[e], pb = work[(e + 1) % n];
        if (kind === 'h') {
          var my = (pa.y + pb.y) / 2;
          pa.y = my; pb.y = my;
        } else {
          var mx = (pa.x + pb.x) / 2;
          pa.x = mx; pb.x = mx;
        }
      }
    }

    var c2 = Math.cos(theta), s2 = Math.sin(theta);
    return work.map(function (p, i) {
      return {
        id: pts[i].id,
        confidence: pts[i].confidence,
        x: round(p.x * c2 - p.y * s2, 4),
        y: round(p.x * s2 + p.y * c2, 4)
      };
    });
  }

  /* Length-weighted histogram of edge directions modulo 90 degrees. */
  function dominantAngle(pts) {
    var bins = new Array(90).fill(0);
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      var l = dist(a, b);
      if (l < 1e-6) continue;
      var ang = deg(Math.atan2(b.y - a.y, b.x - a.x));
      var m = ((ang % 90) + 90) % 90;
      bins[Math.floor(m) % 90] += l;
    }
    var bi = 0;
    for (var k = 1; k < 90; k++) if (bins[k] > bins[bi]) bi = k;
    /* Refine within the winning bin by a weighted mean. */
    var sum = 0, wsum = 0;
    for (var j = 0; j < pts.length; j++) {
      var p1 = pts[j], p2 = pts[(j + 1) % pts.length];
      var L = dist(p1, p2);
      if (L < 1e-6) continue;
      var an = ((deg(Math.atan2(p2.y - p1.y, p2.x - p1.x)) % 90) + 90) % 90;
      if (Math.abs(angDiff(an, bi + 0.5)) < 6) { sum += an * L; wsum += L; }
    }
    return rad(wsum ? sum / wsum : bi);
  }

  function angDiff(a, b) {
    var d = ((a - b) % 360 + 540) % 360 - 180;
    return d;
  }

  /* -- Scale --------------------------------------------------------------
     The whole point of the single-station method: the shape is right, only
     the scale is uncertain. Multiplying every measured quantity by one factor
     corrects the room. Catalogue furniture sizes are NOT scaled — they are
     already real-world dimensions, not measurements. */
  function scaleRoom(room, factor, about) {
    var c = about || centroid(room.points);
    room.points.forEach(function (p) {
      p.x = round(c.x + (p.x - c.x) * factor, 4);
      p.y = round(c.y + (p.y - c.y) * factor, 4);
    });
    room.openings.forEach(function (o) {
      o.offset = round(o.offset * factor, 4);
      if (o.measured) o.width = round(o.width * factor, 4);
    });
    room.objects.forEach(function (ob) {
      ob.x = round(c.x + (ob.x - c.x) * factor, 4);
      ob.y = round(c.y + (ob.y - c.y) * factor, 4);
      if (ob.measured) { ob.w = round(ob.w * factor, 4); ob.d = round(ob.d * factor, 4); }
    });
    return room;
  }

  function translateRoom(room, dx, dy) {
    room.points.forEach(function (p) { p.x = round(p.x + dx, 4); p.y = round(p.y + dy, 4); });
    room.objects.forEach(function (o) { o.x = round(o.x + dx, 4); o.y = round(o.y + dy, 4); });
    return room;
  }

  function rotateRoom(room, degrees, about) {
    var c = about || centroid(room.points);
    var t = rad(degrees), co = Math.cos(t), si = Math.sin(t);
    function rot(p) {
      var dx = p.x - c.x, dy = p.y - c.y;
      p.x = round(c.x + dx * co - dy * si, 4);
      p.y = round(c.y + dx * si + dy * co, 4);
    }
    room.points.forEach(rot);
    room.objects.forEach(function (o) { rot(o); o.rot = (o.rot + degrees) % 360; });
    return room;
  }

  /* Move the room so its bounding box starts at the origin plus a margin. */
  function normalise(room, margin) {
    var m = margin == null ? 0 : margin;
    if (!room.points.length) return room;
    var minX = Infinity, minY = Infinity;
    room.points.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); });
    return translateRoom(room, m - minX, m - minY);
  }

  /* -- Editor snapping ----------------------------------------------------- */

  function snapCorner(room, index, p, opts) {
    opts = opts || {};
    var tol = opts.tol || 0.12;          // metres, converted from pixels by caller
    var out = { x: p.x, y: p.y, guides: [] };
    if (opts.grid) {
      out.x = Math.round(out.x / opts.grid) * opts.grid;
      out.y = Math.round(out.y / opts.grid) * opts.grid;
    }
    if (opts.align !== false) {
      /* Align to the x or y of any other corner — this is what keeps
         rectilinear rooms actually rectilinear while dragging. */
      var bestX = null, bestY = null;
      room.points.forEach(function (q, i) {
        if (i === index) return;
        if (Math.abs(q.x - out.x) < tol && (!bestX || Math.abs(q.x - out.x) < Math.abs(bestX.x - out.x))) bestX = q;
        if (Math.abs(q.y - out.y) < tol && (!bestY || Math.abs(q.y - out.y) < Math.abs(bestY.y - out.y))) bestY = q;
      });
      if (bestX) { out.x = bestX.x; out.guides.push({ kind: 'v', x: bestX.x }); }
      if (bestY) { out.y = bestY.y; out.guides.push({ kind: 'h', y: bestY.y }); }
    }
    return out;
  }

  /* Snap a free-standing object to the nearest wall: rotate it to the wall
     direction and set its back edge against the inner face. */
  function snapObjectToWall(room, obj, tol) {
    tol = tol == null ? 0.45 : tol;
    var hit = projectOntoWalls(room, { x: obj.x, y: obj.y });
    if (!hit || hit.dist > tol) return null;
    var a = room.points[hit.wallIndex];
    var b = room.points[(hit.wallIndex + 1) % room.points.length];
    var d = norm(sub(b, a));
    var inward = signedArea(room.points) > 0
      ? { x: -d.y, y: d.x }
      : { x: d.y, y: -d.x };
    var angle = deg(Math.atan2(d.y, d.x));
    return {
      x: round(hit.point.x + inward.x * obj.d / 2, 4),
      y: round(hit.point.y + inward.y * obj.d / 2, 4),
      rot: round(angle, 1),
      wallIndex: hit.wallIndex
    };
  }

  /* Inward unit normal of a wall — used by the renderer for door swings. */
  function wallNormal(room, i) {
    var n = room.points.length;
    var a = room.points[i], b = room.points[(i + 1) % n];
    var d = norm(sub(b, a));
    return signedArea(room.points) > 0 ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round(v, dp) { var m = Math.pow(10, dp == null ? 3 : dp); return Math.round(v * m) / m; }

  /* -- Formatting ---------------------------------------------------------- */
  function formatLength(metres, units) {
    if (units === 'mm') return Math.round(metres * 1000) + '';
    if (units === 'ftin') {
      var totalIn = metres * 39.3700787;
      var ft = Math.floor(totalIn / 12);
      var inch = Math.round(totalIn - ft * 12);
      if (inch === 12) { ft += 1; inch = 0; }
      return ft + "'" + inch + '"';
    }
    return metres.toFixed(2);
  }

  function formatArea(sqm, units) {
    if (units === 'ftin') return (sqm * 10.7639).toFixed(0) + ' sq ft';
    return sqm.toFixed(2) + ' m²';
  }

  return {
    sub: sub, add: add, mul: mul, len: len, dist: dist, dot: dot, cross: cross, norm: norm,
    deg: deg, rad: rad, TAU: TAU,
    signedArea: signedArea, centroid: centroid,
    offsetPolygon: offsetPolygon, intersectLines: intersectLines,
    closestOnSegment: closestOnSegment, projectOntoWalls: projectOntoWalls,
    squareUp: squareUp, dominantAngle: dominantAngle,
    scaleRoom: scaleRoom, translateRoom: translateRoom, rotateRoom: rotateRoom, normalise: normalise,
    snapCorner: snapCorner, snapObjectToWall: snapObjectToWall, wallNormal: wallNormal,
    clamp: clamp, round: round,
    formatLength: formatLength, formatArea: formatArea
  };
})();
