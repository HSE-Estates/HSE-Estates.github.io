/* ---------------------------------------------------------------------------
   Single-station ray casting — the core measurement of the application.

   World frame : x east, y north, z up. Camera at (0, 0, h), floor at z = 0.
   Plan frame  : x = world x, y = -world y, so north points up the page.

   A tap gives a ray. Intersecting it with the floor plane gives a metric
   coordinate directly — no reconstruction, no server, no scale ambiguity
   beyond the single unknown h, which one tape-measured wall corrects.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Raycast = (function () {
  'use strict';

  var ANGLE_NOISE_RAD = 0.026;   // ~1.5°, typical indoor orientation noise

  /* -- Visible field of view ---------------------------------------------
     The <video> is drawn with object-fit: cover, so part of the sensor frame
     is cropped away. Measuring against the element without accounting for
     that is a silent systematic error, so it is handled explicitly. */
  function visibleTangents(opts) {
    var vw = opts.videoWidth || opts.elemWidth;
    var vh = opts.videoHeight || opts.elemHeight;
    var ew = opts.elemWidth;
    var eh = opts.elemHeight;
    var tanHalfH = Math.tan(deg2rad(opts.fovDeg) / 2);

    if (!vw || !vh || !ew || !eh) {
      return { tx: tanHalfH, ty: tanHalfH * (eh / Math.max(1, ew)) };
    }
    var scale = Math.max(ew / vw, eh / vh);   // object-fit: cover
    var visW = ew / scale;                    // source pixels actually shown
    var visH = eh / scale;
    var tx = tanHalfH * (visW / vw);
    var ty = tanHalfH * (vh / vw) * (visH / vh);
    return { tx: tx, ty: ty };
  }

  /* Screen tap → unit ray in the world frame.
     tap: { x, y } in CSS pixels within the video element. */
  function rayFromTap(tap, orient, opts) {
    var t = visibleTangents(opts);
    var nx = (tap.x / opts.elemWidth) * 2 - 1;
    var ny = (tap.y / opts.elemHeight) * 2 - 1;

    /* Front cameras are mirrored on screen. */
    if (opts.mirrored) nx = -nx;

    var dCam = { x: nx * t.tx, y: -ny * t.ty, z: -1 };
    var dDev = RS.Orientation.rotateForScreen(dCam, orient.screenAngle);
    var dWorld = RS.Orientation.applyMatrix(orient.matrix, dDev);
    var l = Math.hypot(dWorld.x, dWorld.y, dWorld.z) || 1e-12;
    return { x: dWorld.x / l, y: dWorld.y / l, z: dWorld.z / l };
  }

  /* Ray ∩ floor plane. Returns a PLAN coordinate in metres relative to the
     station, or null when the ray is not aimed below the horizon. */
  function floorPoint(tap, orient, opts) {
    var d = rayFromTap(tap, orient, opts);
    if (d.z > -0.02) return null;                 // at or above the horizon
    var h = opts.cameraHeight;
    var t = -h / d.z;
    if (!isFinite(t) || t <= 0 || t > 60) return null;

    var wx = d.x * t;
    var wy = d.y * t;
    var range = Math.hypot(wx, wy);

    /* Error grows with range²/h: a ray one degree off at 6 m from a 1.45 m
       camera height moves the point by a lot more than at 2 m. */
    var relErr = (range / Math.max(0.3, h)) * ANGLE_NOISE_RAD;
    var conf = clamp(1 - relErr * 2.2, 0.05, 1) * clamp(orient.quality, 0.15, 1);

    return {
      x: round(wx, 4),
      y: round(-wy, 4),            // world north → plan up
      range: round(range, 3),
      confidence: round(conf, 3),
      relErr: round(relErr, 4)
    };
  }

  /* Horizontal bearing of a tap, as a plan-frame unit vector. Pitch and
     camera height do not enter, which is why openings are placed this way. */
  function bearingVector(tap, orient, opts) {
    var d = rayFromTap(tap, orient, opts);
    var l = Math.hypot(d.x, d.y);
    if (l < 1e-6) return null;
    return { x: d.x / l, y: -d.y / l };
  }

  /* Intersect a bearing from the station with the room boundary. This is how
     a door or window tapped at any height lands on the right wall at the
     right place. station defaults to the plan origin. */
  function bearingToWall(room, dir, station) {
    var s = station || { x: 0, y: 0 };
    var best = null;
    var n = room.points.length;
    for (var i = 0; i < n; i++) {
      var a = room.points[i];
      var b = room.points[(i + 1) % n];
      var e = { x: b.x - a.x, y: b.y - a.y };
      var den = dir.x * e.y - dir.y * e.x;
      if (Math.abs(den) < 1e-9) continue;
      var diff = { x: a.x - s.x, y: a.y - s.y };
      var t = (diff.x * e.y - diff.y * e.x) / den;      // along the ray
      var u = (diff.x * dir.y - diff.y * dir.x) / den;  // along the wall, 0..1
      if (t <= 0.01 || u < -0.001 || u > 1.001) continue;
      if (!best || t < best.t) {
        var wallLen = Math.hypot(e.x, e.y);
        best = {
          t: t,
          wallIndex: i,
          offset: round(clamp(u, 0, 1) * wallLen, 4),
          point: { x: s.x + dir.x * t, y: s.y + dir.y * t }
        };
      }
    }
    return best;
  }

  /* Two bearings → an opening: the span between them on whichever wall the
     first one hits. Used for "tap the left jamb, tap the right jamb". */
  function openingFromBearings(room, dirA, dirB, station) {
    var a = bearingToWall(room, dirA, station);
    var b = bearingToWall(room, dirB, station);
    if (!a || !b) return null;
    if (a.wallIndex !== b.wallIndex) {
      /* Straddles a corner — keep the wall of the nearer hit and clamp. */
      var wall = a.t <= b.t ? a : b;
      var other = a.t <= b.t ? b : a;
      var wallLen = RS.Schema.wallLength(room, wall.wallIndex);
      other = { offset: other.offset > wall.offset ? wallLen : 0, wallIndex: wall.wallIndex };
      a = wall; b = other;
    }
    var lo = Math.min(a.offset, b.offset);
    var hi = Math.max(a.offset, b.offset);
    return {
      wallIndex: a.wallIndex,
      offset: round((lo + hi) / 2, 4),
      width: round(Math.max(0.15, hi - lo), 4)
    };
  }

  /* -- Auto-calibration of the field of view -------------------------------
     A one-parameter search that exploits the single strongest prior about
     rooms: they are nearly always rectilinear. Reproject the captured taps
     across a range of field-of-view values and keep the one that produces the
     most rectilinear polygon. Costs a few milliseconds and removes the need
     to know the device's optics. */
  function autoCalibrateFov(taps, orientList, opts, range) {
    range = range || { min: 45, max: 95, step: 0.5 };
    if (!taps || taps.length < 4) return null;
    var best = null;
    for (var fov = range.min; fov <= range.max; fov += range.step) {
      var pts = [];
      var ok = true;
      for (var i = 0; i < taps.length; i++) {
        var o = Object.assign({}, opts, { fovDeg: fov });
        var p = floorPoint(taps[i], orientList[i], o);
        if (!p) { ok = false; break; }
        pts.push(p);
      }
      if (!ok || pts.length < 4) continue;
      var cost = rectilinearityCost(pts);
      if (!best || cost < best.cost) best = { fovDeg: round(fov, 2), cost: cost, points: pts };
    }
    return best;
  }

  /* Length-weighted mean angular deviation of each edge from the nearest
     multiple of 90° about the dominant orientation. Lower is more rectilinear. */
  function rectilinearityCost(pts) {
    var theta = RS.Geom.deg(RS.Geom.dominantAngle(pts));
    var total = 0, weight = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      var L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 0.05) continue;
      var ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI - theta;
      var dev = Math.abs(((ang % 90) + 90) % 90);
      dev = Math.min(dev, 90 - dev);
      total += dev * L;
      weight += L;
    }
    return weight ? total / weight : 999;
  }

  /* Rescale a room so that one wall matches a tape measurement. Because every
     captured point is linear in camera height, this single number corrects
     the entire room — and back-solves what the camera height really was. */
  function calibrateFromKnownLength(room, wallIndex, knownMetres) {
    var current = RS.Schema.wallLength(room, wallIndex);
    if (!(current > 0.01) || !(knownMetres > 0.01)) return null;
    var factor = knownMetres / current;
    RS.Geom.scaleRoom(room, factor);
    room.capture.cameraHeight = round(room.capture.cameraHeight * factor, 3);
    room.capture.scaleCorrected = true;
    return { factor: round(factor, 4), impliedHeight: room.capture.cameraHeight };
  }

  function deg2rad(d) { return d * Math.PI / 180; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round(v, dp) { var m = Math.pow(10, dp); return Math.round(v * m) / m; }

  return {
    visibleTangents: visibleTangents,
    rayFromTap: rayFromTap,
    floorPoint: floorPoint,
    bearingVector: bearingVector,
    bearingToWall: bearingToWall,
    openingFromBearings: openingFromBearings,
    autoCalibrateFov: autoCalibrateFov,
    rectilinearityCost: rectilinearityCost,
    calibrateFromKnownLength: calibrateFromKnownLength
  };
})();
