/* ---------------------------------------------------------------------------
   DXF export (brief §21, §39).

   Generated from the structured model, never from an image. Everything lands
   on the conventional architectural layers so it can be turned on and off in
   AutoCAD, BricsCAD, LibreCAD or QCAD.

   Format is AutoCAD R12 ASCII: the most widely readable DXF there is, and it
   only needs LINE, ARC, CIRCLE and TEXT — no block table to get wrong.
   Drawing units default to millimetres, which is the norm for building work
   in Ireland and the UK.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.DXF = (function () {
  'use strict';

  var G = RS.Geom, S = RS.Schema;

  var LAYERS = [
    { name: 'WALLS',       color: 7 },
    { name: 'DOORS',       color: 3 },
    { name: 'WINDOWS',     color: 5 },
    { name: 'FURNITURE',   color: 8 },
    { name: 'FIXTURES',    color: 6 },
    { name: 'DIMENSIONS',  color: 1 },
    { name: 'TEXT',        color: 2 },
    { name: 'ROOM_LABELS', color: 4 }
  ];

  var FIXTURE_TYPES = {
    toilet: 1, basin: 1, vanity: 1, shower: 1, bath: 1, towel_rad: 1,
    ksink: 1, oven: 1, hob: 1, fridge: 1, dishwasher: 1, washer: 1,
    counter: 1, island: 1, radiator: 1, boiler: 1, stairs: 1
  };

  function build(project, options) {
    var opt = Object.assign({ units: 'mm', rooms: null }, options || {});
    var k = opt.units === 'm' ? 1 : 1000;          // model metres → drawing units
    var rooms = opt.rooms || project.rooms;
    var out = [];

    /* The DXF group-code format: every value is preceded by its code, one per
       line. Keeping it to one helper avoids the classic off-by-one bugs. */
    function g(code, value) { out.push(String(code)); out.push(String(value)); }

    /* -- HEADER ---------------------------------------------------------- */
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$INSUNITS'); g(70, opt.units === 'm' ? 6 : 4);   // 6 = metres, 4 = mm
    g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(30, 0);
    g(9, '$EXTMAX'); g(10, 100 * k); g(20, 100 * k); g(30, 0);
    g(0, 'ENDSEC');

    /* -- TABLES ---------------------------------------------------------- */
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, LAYERS.length);
    LAYERS.forEach(function (l) {
      g(0, 'LAYER'); g(2, l.name); g(70, 0); g(62, l.color); g(6, 'CONTINUOUS');
    });
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    /* -- ENTITIES -------------------------------------------------------- */
    g(0, 'SECTION'); g(2, 'ENTITIES');

    function line(layer, x1, y1, x2, y2) {
      g(0, 'LINE'); g(8, layer);
      g(10, nx(x1)); g(20, ny(y1)); g(30, 0);
      g(11, nx(x2)); g(21, ny(y2)); g(31, 0);
    }
    function circle(layer, cx, cy, r) {
      g(0, 'CIRCLE'); g(8, layer);
      g(10, nx(cx)); g(20, ny(cy)); g(30, 0); g(40, num(r * k));
    }
    function arc(layer, cx, cy, r, a0, a1) {
      g(0, 'ARC'); g(8, layer);
      g(10, nx(cx)); g(20, ny(cy)); g(30, 0); g(40, num(r * k));
      g(50, num(a0)); g(51, num(a1));
    }
    function text(layer, str, x, y, height, rotation, justify) {
      g(0, 'TEXT'); g(8, layer);
      g(10, nx(x)); g(20, ny(y)); g(30, 0);
      g(40, num(height * k));
      g(1, String(str).replace(/[\r\n]+/g, ' '));
      g(50, num(rotation || 0));
      if (justify) {
        g(72, 1);                                   // centred horizontally
        g(11, nx(x)); g(21, ny(y)); g(31, 0);
      }
    }
    function polyline(layer, pts, close) {
      for (var i = 0; i + 1 < pts.length; i++) {
        line(layer, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      }
      if (close && pts.length > 2) {
        line(layer, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y);
      }
    }

    /* Plan y runs down the page; DXF y runs up. Flip on the way out. */
    function nx(v) { return num(v * k); }
    function ny(v) { return num(-v * k); }
    function num(v) { return (Math.round(v * 1000) / 1000).toFixed(3); }

    rooms.forEach(function (room) {
      if (room.points.length < 3) return;
      S.syncWalls(room);
      var thick = room.walls.map(function (w) { return w.thickness; });
      var outer = G.offsetPolygon(room.points, thick);

      /* Walls: inner face, outer face, and a cap across each opening. */
      polyline('WALLS', room.points, true);
      polyline('WALLS', outer, true);

      room.openings.forEach(function (op) {
        var layer = (op.type === 'window' || op.type === 'patio') ? 'WINDOWS' : 'DOORS';
        var geom = openingGeometry(room, op);
        if (!geom) return;

        /* Jambs across the wall thickness. */
        line(layer, geom.p0.x, geom.p0.y, geom.o0.x, geom.o0.y);
        line(layer, geom.p1.x, geom.p1.y, geom.o1.x, geom.o1.y);

        if (layer === 'WINDOWS') {
          line(layer, geom.g0a.x, geom.g0a.y, geom.g1a.x, geom.g1a.y);
          line(layer, geom.g0b.x, geom.g0b.y, geom.g1b.x, geom.g1b.y);
        } else if (op.type === 'door' || op.type === 'double') {
          /* Leaf and swing arc — real geometry, so it stays editable. */
          var hinge = op.hinge === 'end' ? geom.p1 : geom.p0;
          var lead = op.hinge === 'end' ? geom.p0 : geom.p1;
          var r = op.width;
          var swing = op.swing === 'out'
            ? { x: -geom.inward.x, y: -geom.inward.y } : geom.inward;
          var open = { x: hinge.x + swing.x * r, y: hinge.y + swing.y * r };
          line(layer, hinge.x, hinge.y, open.x, open.y);
          var a0 = Math.atan2(-(lead.y - hinge.y), lead.x - hinge.x) * 180 / Math.PI;
          var a1 = Math.atan2(-(open.y - hinge.y), open.x - hinge.x) * 180 / Math.PI;
          var lo = ((a0 % 360) + 360) % 360, hi = ((a1 % 360) + 360) % 360;
          if (((hi - lo + 360) % 360) > 180) { var t = lo; lo = hi; hi = t; }
          arc(layer, hinge.x, hinge.y, r, lo, hi);
        } else {
          line(layer, geom.p0.x, geom.p0.y, geom.p1.x, geom.p1.y);
        }
      });

      /* Furniture and fixtures. Symbols are exported as their footprint
         rectangle plus a label — a placeholder a draughtsperson can swap for
         their own block, which is what the layer separation is for. */
      room.objects.forEach(function (ob) {
        var layer = FIXTURE_TYPES[ob.type] ? 'FIXTURES' : 'FURNITURE';
        var corners = objectCorners(ob);
        polyline(layer, corners, true);
        if (ob.type === 'bath' || ob.type === 'shower') {
          var inset = objectCorners({ x: ob.x, y: ob.y, w: Math.max(0.1, ob.w - 0.14), d: Math.max(0.1, ob.d - 0.14), rot: ob.rot });
          polyline(layer, inset, true);
        }
        if (ob.type === 'toilet' || ob.type === 'basin' || ob.type === 'ksink') {
          circle(layer, ob.x, ob.y, Math.min(ob.w, ob.d) * 0.3);
        }
        var label = (S.OBJECTS[ob.type] || {}).label || ob.type;
        text('TEXT', label, ob.x, ob.y, 0.11, -ob.rot, true);
      });

      /* Dimensions as lines and text — R12 DIMENSION entities need a block
         definition per dimension, which is fragile across readers. */
      for (var i = 0; i < room.points.length; i++) {
        var d = dimGeometry(room, i);
        if (!d) continue;
        line('DIMENSIONS', d.A.x, d.A.y, d.B.x, d.B.y);
        line('DIMENSIONS', d.a.x, d.a.y, d.Aext.x, d.Aext.y);
        line('DIMENSIONS', d.b.x, d.b.y, d.Bext.x, d.Bext.y);
        text('DIMENSIONS', d.label, d.mid.x, d.mid.y, 0.14, d.angle, true);
      }

      /* Room label and area. */
      var anchor = RS.Plan.labelAnchor(room);
      text('ROOM_LABELS', (room.name || 'Room').toUpperCase(), anchor.x, anchor.y - 0.10, 0.24, 0, true);
      text('ROOM_LABELS', S.roomArea(room).toFixed(2) + ' sq m', anchor.x, anchor.y + 0.22, 0.16, 0, true);
    });

    g(0, 'ENDSEC');
    g(0, 'EOF');
    return out.join('\r\n') + '\r\n';

    /* -- local helpers ---------------------------------------------------- */

    function openingGeometry(room, op) {
      var n = room.points.length;
      if (op.wallIndex >= n) return null;
      var a = room.points[op.wallIndex];
      var b = room.points[(op.wallIndex + 1) % n];
      var dir = G.norm(G.sub(b, a));
      var inward = G.wallNormal(room, op.wallIndex);
      var outward = { x: -inward.x, y: -inward.y };
      var th = room.walls[op.wallIndex].thickness;
      var half = op.width / 2;
      var p0 = { x: a.x + dir.x * (op.offset - half), y: a.y + dir.y * (op.offset - half) };
      var p1 = { x: a.x + dir.x * (op.offset + half), y: a.y + dir.y * (op.offset + half) };
      function off(p, m) { return { x: p.x + outward.x * m, y: p.y + outward.y * m }; }
      return {
        p0: p0, p1: p1, dir: dir, inward: inward, th: th,
        o0: off(p0, th), o1: off(p1, th),
        g0a: off(p0, th * 0.22), g1a: off(p1, th * 0.22),
        g0b: off(p0, th * 0.78), g1b: off(p1, th * 0.78)
      };
    }

    function objectCorners(ob) {
      var t = ob.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      var hw = ob.w / 2, hd = ob.d / 2;
      return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(function (p) {
        return { x: ob.x + p[0] * c - p[1] * s, y: ob.y + p[0] * s + p[1] * c };
      });
    }

    function dimGeometry(room, i) {
      var n = room.points.length;
      var a = room.points[i], b = room.points[(i + 1) % n];
      var L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 0.25) return null;
      var dir = G.norm(G.sub(b, a));
      var inward = G.wallNormal(room, i);
      var out2 = { x: -inward.x, y: -inward.y };
      var off = room.walls[i].thickness + RS.Plan.DIM_OFFSET;
      var ang = Math.atan2(-dir.y, dir.x) * 180 / Math.PI;
      if (ang > 90 || ang < -90) ang += 180;
      return {
        A: { x: a.x + out2.x * off, y: a.y + out2.y * off },
        B: { x: b.x + out2.x * off, y: b.y + out2.y * off },
        a: { x: a.x + out2.x * (room.walls[i].thickness + 0.06), y: a.y + out2.y * (room.walls[i].thickness + 0.06) },
        b: { x: b.x + out2.x * (room.walls[i].thickness + 0.06), y: b.y + out2.y * (room.walls[i].thickness + 0.06) },
        Aext: { x: a.x + out2.x * (off + 0.12), y: a.y + out2.y * (off + 0.12) },
        Bext: { x: b.x + out2.x * (off + 0.12), y: b.y + out2.y * (off + 0.12) },
        mid: { x: (a.x + b.x) / 2 + out2.x * (off + 0.13), y: (a.y + b.y) / 2 + out2.y * (off + 0.13) },
        angle: ang,
        label: (opt.units === 'm' ? L.toFixed(2) : Math.round(L * 1000) + '')
      };
    }
  }

  return { build: build, LAYERS: LAYERS };
})();
