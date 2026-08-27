/* ---------------------------------------------------------------------------
   LAYER A — GEOMETRIC TRUTH
   The room model. Every measurement in the application lives here and here
   only. Nothing in js/ai/ is permitted to write to this module's structures
   directly; AI output is applied through store actions, exactly like a click.

   Units: metres and degrees throughout. Plan coordinates are x → right,
   y → down (screen convention), so a polygon wound clockwise on screen has a
   positive shoelace area.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Schema = (function () {
  'use strict';

  var idSeq = 0;
  function uid(prefix) {
    idSeq += 1;
    return (prefix || 'id') + '_' +
      Date.now().toString(36).slice(-5) +
      idSeq.toString(36) +
      Math.random().toString(36).slice(2, 5);
  }

  /* -- Object catalogue --------------------------------------------------
     w = width along the object's local x, d = depth along local y, both in
     metres. These are realistic UK/IE domestic sizes and are used as priors
     when an object is placed by tap or suggested by detection. */
  var OBJECTS = {
    /* Bedroom */
    bed_single:   { label: 'Single bed',    w: 0.90, d: 1.90, group: 'Bedroom' },
    bed_double:   { label: 'Double bed',    w: 1.35, d: 1.90, group: 'Bedroom' },
    bed_king:     { label: 'King bed',      w: 1.50, d: 2.00, group: 'Bedroom' },
    wardrobe:     { label: 'Wardrobe',      w: 1.20, d: 0.60, group: 'Bedroom' },
    bedside:      { label: 'Bedside table', w: 0.45, d: 0.40, group: 'Bedroom' },
    dresser:      { label: 'Dresser',       w: 1.00, d: 0.50, group: 'Bedroom' },

    /* Living */
    sofa_2:       { label: '2-seat sofa',   w: 1.60, d: 0.90, group: 'Living' },
    sofa_3:       { label: '3-seat sofa',   w: 2.10, d: 0.90, group: 'Living' },
    armchair:     { label: 'Armchair',      w: 0.90, d: 0.85, group: 'Living' },
    coffee_table: { label: 'Coffee table',  w: 1.10, d: 0.60, group: 'Living' },
    tv:           { label: 'Television',    w: 1.20, d: 0.12, group: 'Living' },
    bookshelf:    { label: 'Shelving',      w: 0.80, d: 0.30, group: 'Living' },
    fireplace:    { label: 'Fireplace',     w: 1.20, d: 0.30, group: 'Living' },

    /* Dining and office */
    dining_table: { label: 'Dining table',  w: 1.60, d: 0.90, group: 'Dining' },
    dining_chair: { label: 'Dining chair',  w: 0.45, d: 0.45, group: 'Dining' },
    desk:         { label: 'Desk',          w: 1.40, d: 0.70, group: 'Dining' },
    chair:        { label: 'Chair',         w: 0.50, d: 0.50, group: 'Dining' },

    /* Bathroom */
    toilet:       { label: 'WC',            w: 0.40, d: 0.70, group: 'Bathroom' },
    basin:        { label: 'Wash basin',    w: 0.55, d: 0.45, group: 'Bathroom' },
    vanity:       { label: 'Vanity unit',   w: 0.90, d: 0.50, group: 'Bathroom' },
    shower:       { label: 'Shower',        w: 0.90, d: 0.90, group: 'Bathroom' },
    bath:         { label: 'Bath',          w: 1.70, d: 0.70, group: 'Bathroom' },
    towel_rad:    { label: 'Towel rail',    w: 0.60, d: 0.10, group: 'Bathroom' },

    /* Kitchen and utility */
    counter:      { label: 'Worktop run',   w: 2.00, d: 0.60, group: 'Kitchen' },
    island:       { label: 'Island',        w: 1.80, d: 0.90, group: 'Kitchen' },
    ksink:        { label: 'Kitchen sink',  w: 0.80, d: 0.60, group: 'Kitchen' },
    oven:         { label: 'Oven',          w: 0.60, d: 0.60, group: 'Kitchen' },
    hob:          { label: 'Hob',           w: 0.60, d: 0.60, group: 'Kitchen' },
    fridge:       { label: 'Fridge',        w: 0.60, d: 0.65, group: 'Kitchen' },
    dishwasher:   { label: 'Dishwasher',    w: 0.60, d: 0.60, group: 'Kitchen' },
    washer:       { label: 'Washing m/c',   w: 0.60, d: 0.60, group: 'Kitchen' },
    cabinet:      { label: 'Cabinet',       w: 0.60, d: 0.60, group: 'Kitchen' },

    /* Structure and services */
    stairs:       { label: 'Stairs',        w: 1.00, d: 2.60, group: 'Structure' },
    radiator:     { label: 'Radiator',      w: 1.00, d: 0.11, group: 'Structure' },
    boiler:       { label: 'Boiler',        w: 0.45, d: 0.35, group: 'Structure' },
    column:       { label: 'Column',        w: 0.30, d: 0.30, group: 'Structure' },
    plant:        { label: 'Planting',      w: 0.50, d: 0.50, group: 'Structure' }
  };

  var ROOM_TYPES = [
    { id: 'bedroom',  label: 'Bedroom' },
    { id: 'living',   label: 'Living room' },
    { id: 'kitchen',  label: 'Kitchen' },
    { id: 'dining',   label: 'Dining room' },
    { id: 'bathroom', label: 'Bathroom' },
    { id: 'ensuite',  label: 'En suite' },
    { id: 'wc',       label: 'WC' },
    { id: 'office',   label: 'Office' },
    { id: 'hall',     label: 'Hall' },
    { id: 'landing',  label: 'Landing' },
    { id: 'utility',  label: 'Utility' },
    { id: 'store',    label: 'Store' },
    { id: 'garage',   label: 'Garage' },
    { id: 'other',    label: 'Room' }
  ];

  var OPENING_TYPES = {
    door:     { label: 'Door',        width: 0.81, height: 2.00, sill: 0.00 },
    double:   { label: 'Double door', width: 1.50, height: 2.00, sill: 0.00 },
    sliding:  { label: 'Sliding door',width: 1.50, height: 2.00, sill: 0.00 },
    opening:  { label: 'Open span',   width: 1.20, height: 2.10, sill: 0.00 },
    window:   { label: 'Window',      width: 1.20, height: 1.20, sill: 0.90 },
    patio:    { label: 'Patio door',  width: 1.80, height: 2.10, sill: 0.00 }
  };

  /* -- Constructors ------------------------------------------------------ */

  function newProject(name) {
    return {
      id: uid('prj'),
      schema: 1,
      name: name || 'Untitled survey',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      units: 'm',
      rooms: [],
      /* LAYER B — presentation only. Safe for the AI layer to write. */
      presentation: {
        style: 'technical',        // technical | presentation | plan25
        showDimensions: true,
        showAreas: true,
        showLabels: true,
        showFurniture: true,
        showNorth: true,
        showGrid: false,
        dimensionUnits: 'm',       // m | mm | ftin
        accent: '#006354'
      }
    };
  }

  function newRoom(name, type) {
    return {
      id: uid('room'),
      name: name || 'Room 1',
      type: type || 'other',
      /* Boundary polygon, inner face of the walls, metres, clockwise. */
      points: [],
      /* Per-edge wall properties. walls[i] belongs to the edge from
         points[i] to points[(i + 1) % n]. Kept index-aligned by
         insertPoint / removePoint below. */
      walls: [],
      openings: [],
      objects: [],
      ceilingHeight: 2.40,
      /* Which floor of the building. Rooms are only ever drawn, stitched or
         checked for overlap against others on the same storey. */
      storey: 0,
      /* True once this room has been positioned against another room through a
         shared door, rather than parked wherever the scan left it. */
      placed: false,
      rotation: 0,
      capture: {
        method: 'manual',          // manual | station | xr | detected
        cameraHeight: 1.45,
        fovDeg: 66,
        scaleCorrected: false,
        capturedAt: null
      },
      notes: ''
    };
  }

  function newWall(exterior) {
    return {
      id: uid('wall'),
      thickness: exterior ? 0.30 : 0.10,
      exterior: !!exterior,
      confidence: 1
    };
  }

  function newPoint(x, y, confidence) {
    return {
      id: uid('pt'),
      x: round(x, 4),
      y: round(y, 4),
      confidence: confidence == null ? 1 : confidence
    };
  }

  function newOpening(type, wallIndex, offset) {
    var def = OPENING_TYPES[type] || OPENING_TYPES.door;
    return {
      id: uid('op'),
      type: type,
      wallIndex: wallIndex,
      offset: offset,            // metres from the wall start to the CENTRE
      width: def.width,
      height: def.height,
      sill: def.sill,
      hinge: 'start',            // start | end   (which jamb the leaf hangs on)
      swing: 'in',               // in | out
      /* The same physical doorway seen from the room on the other side.
         { roomId, openingId }, written symmetrically on both. This is the edge
         of the door graph that whole-house stitching walks. */
      link: null,
      confidence: 1
    };
  }

  function newObject(type, x, y, rot) {
    var def = OBJECTS[type] || { w: 0.6, d: 0.6, label: type };
    return {
      id: uid('obj'),
      type: type,
      label: '',
      x: round(x, 4),
      y: round(y, 4),
      w: def.w,
      d: def.d,
      rot: rot || 0,
      confidence: 1,
      locked: false
    };
  }

  /* -- Wall/point index maintenance --------------------------------------
     Openings reference a wall by index, so any change to the point list has
     to shift those references. These two helpers are the only sanctioned way
     to add or remove a corner. */

  function insertPoint(room, afterIndex, pt) {
    var n = room.points.length;
    var at = (afterIndex + 1) % (n + 1);
    room.points.splice(at, 0, pt);
    /* The edge that was split inherits its properties; the new edge is a
       clone so the two halves start out identical. */
    var src = room.walls[afterIndex] || newWall(false);
    var clone = newWall(src.exterior);
    clone.thickness = src.thickness;
    room.walls.splice(at, 0, clone);
    room.openings.forEach(function (o) {
      if (o.wallIndex >= at) o.wallIndex += 1;
    });
    return at;
  }

  function removePoint(room, index) {
    if (room.points.length <= 3) return false;
    room.points.splice(index, 1);
    room.walls.splice(index, 1);
    /* Openings on the removed edge go with it; later edges shift down. */
    room.openings = room.openings.filter(function (o) { return o.wallIndex !== index; });
    room.openings.forEach(function (o) { if (o.wallIndex > index) o.wallIndex -= 1; });
    return true;
  }

  function syncWalls(room) {
    while (room.walls.length < room.points.length) room.walls.push(newWall(true));
    room.walls.length = room.points.length;
    room.openings = room.openings.filter(function (o) {
      return o.wallIndex >= 0 && o.wallIndex < room.points.length;
    });
    return room;
  }

  /* -- Derived geometry --------------------------------------------------- */

  function wallSegment(room, i) {
    var n = room.points.length;
    var a = room.points[i];
    var b = room.points[(i + 1) % n];
    return { a: a, b: b, index: i, wall: room.walls[i] };
  }

  function wallLength(room, i) {
    var s = wallSegment(room, i);
    return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  }

  function roomArea(room) {
    var p = room.points, n = p.length, s = 0, i;
    if (n < 3) return 0;
    for (i = 0; i < n; i++) {
      var q = p[(i + 1) % n];
      s += p[i].x * q.y - q.x * p[i].y;
    }
    return Math.abs(s) / 2;
  }

  function roomPerimeter(room) {
    var t = 0;
    for (var i = 0; i < room.points.length; i++) t += wallLength(room, i);
    return t;
  }

  function bounds(room) {
    if (!room.points.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1, w: 1, h: 1 };
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    room.points.forEach(function (p) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
  }

  /* -- Validation and intelligent error detection (brief §33) -------------- */

  function validate(room) {
    var issues = [];
    var n = room.points.length;

    if (n < 3) {
      issues.push({ level: 'error', text: 'The room needs at least three corners.', target: null });
      return issues;
    }

    for (var i = 0; i < n; i++) {
      var len = wallLength(room, i);
      if (len < 0.15) {
        issues.push({
          level: 'error',
          text: 'Wall ' + (i + 1) + ' is only ' + (len * 1000).toFixed(0) + ' mm long — probably a duplicated corner.',
          target: { kind: 'wall', index: i }
        });
      }
      if (len > 30) {
        issues.push({
          level: 'warn',
          text: 'Wall ' + (i + 1) + ' is ' + len.toFixed(1) + ' m — check the scale is right.',
          target: { kind: 'wall', index: i }
        });
      }
    }

    if (selfIntersects(room.points)) {
      issues.push({
        level: 'error',
        text: 'The outline crosses itself. Drag the corners back into order.',
        target: null
      });
    }

    room.openings.forEach(function (o) {
      var len = wallLength(room, o.wallIndex);
      var half = o.width / 2;
      if (o.offset - half < -0.02 || o.offset + half > len + 0.02) {
        issues.push({
          level: 'warn',
          text: (OPENING_TYPES[o.type] || {}).label + ' overhangs the end of its wall.',
          target: { kind: 'opening', id: o.id }
        });
      }
      if (o.width > len) {
        issues.push({
          level: 'error',
          text: 'An opening is wider than the wall it sits on.',
          target: { kind: 'opening', id: o.id }
        });
      }
    });

    room.objects.forEach(function (ob) {
      if (!pointInPolygon(ob, room.points)) {
        issues.push({
          level: 'warn',
          text: (OBJECTS[ob.type] || {}).label + ' sits outside the room outline.',
          target: { kind: 'object', id: ob.id }
        });
      }
      if (ob.confidence < 0.55) {
        issues.push({
          level: 'warn',
          text: 'Low confidence on ' + ((OBJECTS[ob.type] || {}).label || ob.type) + ' — confirm or delete it.',
          target: { kind: 'object', id: ob.id }
        });
      }
    });

    room.points.forEach(function (p, idx) {
      if (p.confidence < 0.55) {
        issues.push({
          level: 'warn',
          text: 'Corner ' + (idx + 1) + ' was captured with low confidence.',
          target: { kind: 'point', index: idx }
        });
      }
    });

    if (room.capture.method === 'station' && !room.capture.scaleCorrected) {
      issues.push({
        level: 'warn',
        text: 'Scale is estimated from the camera height. Measure one wall and enter it to correct the whole room.',
        target: null
      });
    }

    return issues;
  }

  function pointInPolygon(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) &&
          (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }

  function selfIntersects(pts) {
    var n = pts.length;
    if (n < 4) return false;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (i === j || (i + 1) % n === j || (j + 1) % n === i) continue;
        if (segIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
      }
    }
    return false;
  }

  function segIntersect(p1, p2, p3, p4) {
    function d(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
    var d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function round(v, dp) {
    var m = Math.pow(10, dp == null ? 3 : dp);
    return Math.round(v * m) / m;
  }

  /* -- Import guard -------------------------------------------------------
     Anything arriving from a file, an AI response or a Space is coerced back
     onto the schema before it can touch the store. */
  function coerceProject(raw) {
    var p = newProject(typeof raw.name === 'string' ? raw.name : 'Imported survey');
    if (raw.id) p.id = String(raw.id);
    if (raw.createdAt) p.createdAt = Number(raw.createdAt) || Date.now();
    if (raw.presentation) {
      Object.keys(p.presentation).forEach(function (k) {
        if (raw.presentation[k] !== undefined) p.presentation[k] = raw.presentation[k];
      });
    }
    (Array.isArray(raw.rooms) ? raw.rooms : []).forEach(function (r) {
      var room = newRoom(r.name, r.type);
      if (r.id) room.id = String(r.id);
      room.ceilingHeight = num(r.ceilingHeight, 2.4);
      room.notes = typeof r.notes === 'string' ? r.notes : '';
      room.storey = Math.round(clamp(num(r.storey, 0), -3, 20));
      room.placed = !!r.placed;
      if (r.capture) {
        room.capture.method = r.capture.method || 'manual';
        room.capture.cameraHeight = num(r.capture.cameraHeight, 1.45);
        room.capture.fovDeg = num(r.capture.fovDeg, 66);
        room.capture.scaleCorrected = !!r.capture.scaleCorrected;
        room.capture.capturedAt = r.capture.capturedAt || null;
      }
      (Array.isArray(r.points) ? r.points : []).forEach(function (pt) {
        room.points.push(newPoint(num(pt.x, 0), num(pt.y, 0), num(pt.confidence, 1)));
      });
      (Array.isArray(r.walls) ? r.walls : []).forEach(function (w, i) {
        var wall = newWall(!!w.exterior);
        wall.thickness = clamp(num(w.thickness, 0.1), 0.02, 1);
        wall.confidence = num(w.confidence, 1);
        room.walls[i] = wall;
      });
      syncWalls(room);
      (Array.isArray(r.openings) ? r.openings : []).forEach(function (o) {
        if (!OPENING_TYPES[o.type]) return;
        var idx = Math.floor(num(o.wallIndex, -1));
        if (idx < 0 || idx >= room.points.length) return;
        var op = newOpening(o.type, idx, num(o.offset, 0));
        op.width = clamp(num(o.width, op.width), 0.2, 6);
        op.height = clamp(num(o.height, op.height), 0.2, 4);
        op.sill = clamp(num(o.sill, op.sill), 0, 3);
        op.hinge = o.hinge === 'end' ? 'end' : 'start';
        op.swing = o.swing === 'out' ? 'out' : 'in';
        op.confidence = num(o.confidence, 1);
        if (o.id) op.id = String(o.id);
        if (o.link && o.link.roomId && o.link.openingId) {
          op.link = { roomId: String(o.link.roomId), openingId: String(o.link.openingId) };
        }
        room.openings.push(op);
      });
      (Array.isArray(r.objects) ? r.objects : []).forEach(function (ob) {
        if (!OBJECTS[ob.type]) return;
        var o2 = newObject(ob.type, num(ob.x, 0), num(ob.y, 0), num(ob.rot, 0));
        o2.w = clamp(num(ob.w, o2.w), 0.05, 20);
        o2.d = clamp(num(ob.d, o2.d), 0.05, 20);
        o2.label = typeof ob.label === 'string' ? ob.label.slice(0, 60) : '';
        o2.confidence = clamp(num(ob.confidence, 1), 0, 1);
        room.objects.push(o2);
      });
      p.rooms.push(room);
    });
    if (!p.rooms.length) p.rooms.push(newRoom('Room 1'));
    pruneLinks(p);
    return p;
  }

  /* -- Door graph --------------------------------------------------------- */

  function findRoom(project, roomId) {
    return project.rooms.filter(function (r) { return r.id === roomId; })[0] || null;
  }

  function findOpening(project, roomId, openingId) {
    var room = findRoom(project, roomId);
    if (!room) return null;
    return room.openings.filter(function (o) { return o.id === openingId; })[0] || null;
  }

  /* A link is only real if both ends exist and point back at each other.
     Anything else is dropped — a half-link would silently break stitching. */
  function pruneLinks(project) {
    project.rooms.forEach(function (room) {
      room.openings.forEach(function (op) {
        if (!op.link) return;
        var other = findOpening(project, op.link.roomId, op.link.openingId);
        if (!other || !other.link || other.link.openingId !== op.id) op.link = null;
      });
    });
    return project;
  }

  function linkOpenings(project, roomA, openingA, roomB, openingB) {
    unlinkOpening(project, openingA);
    unlinkOpening(project, openingB);
    openingA.link = { roomId: roomB.id, openingId: openingB.id };
    openingB.link = { roomId: roomA.id, openingId: openingA.id };
  }

  function unlinkOpening(project, opening) {
    if (!opening || !opening.link) return;
    var other = findOpening(project, opening.link.roomId, opening.link.openingId);
    if (other) other.link = null;
    opening.link = null;
  }

  function storeys(project) {
    var seen = {};
    project.rooms.forEach(function (r) { seen[r.storey || 0] = true; });
    var list = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    return list.length ? list : [0];
  }

  function roomsOnStorey(project, storey) {
    return project.rooms.filter(function (r) { return (r.storey || 0) === storey; });
  }

  function storeyName(n) {
    if (n === 0) return 'Ground floor';
    if (n === 1) return 'First floor';
    if (n === 2) return 'Second floor';
    if (n === 3) return 'Third floor';
    if (n < 0) return 'Basement' + (n < -1 ? ' ' + (-n) : '');
    return 'Floor ' + n;
  }

  function num(v, dflt) { var n = Number(v); return isFinite(n) ? n : dflt; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  return {
    uid: uid,
    OBJECTS: OBJECTS,
    ROOM_TYPES: ROOM_TYPES,
    OPENING_TYPES: OPENING_TYPES,
    newProject: newProject,
    newRoom: newRoom,
    newWall: newWall,
    newPoint: newPoint,
    newOpening: newOpening,
    newObject: newObject,
    insertPoint: insertPoint,
    removePoint: removePoint,
    syncWalls: syncWalls,
    wallSegment: wallSegment,
    wallLength: wallLength,
    roomArea: roomArea,
    roomPerimeter: roomPerimeter,
    bounds: bounds,
    validate: validate,
    pointInPolygon: pointInPolygon,
    selfIntersects: selfIntersects,
    coerceProject: coerceProject,
    findRoom: findRoom, findOpening: findOpening, pruneLinks: pruneLinks,
    linkOpenings: linkOpenings, unlinkOpening: unlinkOpening,
    storeys: storeys, roomsOnStorey: roomsOnStorey, storeyName: storeyName,
    round: round,
    clamp: clamp
  };
})();
