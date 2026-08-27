/* ---------------------------------------------------------------------------
   Architectural symbol library (brief §17).

   Every symbol is drawn in the object's LOCAL frame, centred on (0,0),
   spanning -w/2..w/2 in x and -d/2..d/2 in y, in METRES. The renderer places
   it with a single transform, so a symbol never needs to know where it is.

   Stroke widths are metric too (sw ≈ 0.018 m), which is what keeps the drawing
   scale-correct when it is exported to PDF or DXF.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Symbols = (function () {
  'use strict';

  var SW = 0.018;   // default line weight, metres

  function esc(n) { return (Math.round(n * 10000) / 10000); }

  function rect(x, y, w, h, r, extra) {
    return '<rect x="' + esc(x) + '" y="' + esc(y) + '" width="' + esc(w) +
      '" height="' + esc(h) + '"' + (r ? ' rx="' + esc(r) + '"' : '') +
      (extra || '') + '/>';
  }
  function line(x1, y1, x2, y2, extra) {
    return '<line x1="' + esc(x1) + '" y1="' + esc(y1) + '" x2="' + esc(x2) +
      '" y2="' + esc(y2) + '"' + (extra || '') + '/>';
  }
  function circle(cx, cy, r, extra) {
    return '<circle cx="' + esc(cx) + '" cy="' + esc(cy) + '" r="' + esc(r) + '"' + (extra || '') + '/>';
  }
  function ellipse(cx, cy, rx, ry, extra) {
    return '<ellipse cx="' + esc(cx) + '" cy="' + esc(cy) + '" rx="' + esc(rx) +
      '" ry="' + esc(ry) + '"' + (extra || '') + '/>';
  }
  function path(d, extra) { return '<path d="' + d + '"' + (extra || '') + '/>'; }

  /* Each builder receives half-extents for convenience. */
  var BUILD = {

    /* ---- Bedroom ------------------------------------------------------- */
    bed: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var pillow = Math.min(0.32, d * 0.18);
      var s = rect(-hw, -hd, w, d, 0.03);
      s += rect(-hw + 0.05, -hd + 0.04, w - 0.10, pillow, 0.04);
      if (w > 1.15) {
        s += line(0, -hd + 0.04, 0, -hd + 0.04 + pillow);
      }
      s += line(-hw, -hd + pillow + 0.12, hw, -hd + pillow + 0.12);
      s += path('M ' + esc(-hw) + ' ' + esc(hd - 0.28) + ' Q 0 ' + esc(hd - 0.42) + ' ' + esc(hw) + ' ' + esc(hd - 0.28));
      return s;
    },
    wardrobe: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      s += line(-hw, hd - 0.06, hw, hd - 0.06);   // hanging rail
      var leaves = w > 1.0 ? 2 : 1;
      for (var i = 1; i < leaves; i++) s += line(-hw + w * i / leaves, -hd, -hw + w * i / leaves, hd);
      return s;
    },
    drawers: function (w, d, n) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      n = n || 3;
      for (var i = 1; i < n; i++) s += line(-hw + w * i / n, -hd, -hw + w * i / n, hd);
      return s;
    },

    /* ---- Living -------------------------------------------------------- */
    sofa: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var arm = Math.min(0.22, w * 0.14);
      var back = Math.min(0.20, d * 0.26);
      var s = rect(-hw, -hd, w, d, 0.06);
      s += rect(-hw + 0.02, -hd + 0.02, w - 0.04, back, 0.04);   // back
      s += rect(-hw + 0.02, -hd + back, arm, d - back - 0.04, 0.04);
      s += rect(hw - arm - 0.02, -hd + back, arm, d - back - 0.04, 0.04);
      var seats = Math.max(1, Math.round(w / 0.72));
      for (var i = 1; i < seats; i++) {
        var x = -hw + arm + 0.02 + (w - 2 * arm - 0.04) * i / seats;
        s += line(x, -hd + back, x, hd - 0.03);
      }
      return s;
    },
    table: function (w, d, r) {
      return rect(-w / 2, -d / 2, w, d, r == null ? 0.03 : r);
    },
    chair: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd + 0.06, w, d - 0.06, 0.05) +
             line(-hw + 0.04, -hd + 0.03, hw - 0.04, -hd + 0.03);
    },
    tv: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) +
             line(-w * 0.16, hd, w * 0.16, hd) +
             line(0, hd, 0, hd + 0.12);
    },
    shelves: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      var n = Math.max(2, Math.round(w / 0.4));
      for (var i = 1; i < n; i++) s += line(-hw + w * i / n, -hd, -hw + w * i / n, hd);
      return s;
    },
    fireplace: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) +
             rect(-hw + w * 0.18, -hd + 0.04, w * 0.64, d - 0.08) +
             path('M ' + esc(-hw + w * 0.18) + ' ' + esc(hd - 0.04) + ' Q 0 ' + esc(hd - 0.16) + ' ' + esc(hw - w * 0.18) + ' ' + esc(hd - 0.04));
    },

    /* ---- Bathroom ------------------------------------------------------ */
    toilet: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var cist = Math.min(0.20, d * 0.28);
      var s = rect(-hw, -hd, w, cist, 0.02);                       // cistern
      s += ellipse(0, -hd + cist + (d - cist) * 0.52, hw * 0.86, (d - cist) * 0.46);
      s += line(-hw * 0.4, -hd + cist, hw * 0.4, -hd + cist);
      return s;
    },
    basin: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d, 0.05) +
             ellipse(0, 0.02, hw * 0.72, hd * 0.66) +
             circle(0, -hd + 0.07, 0.035);
    },
    vanity: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) +
             ellipse(0, 0.01, Math.min(0.24, w * 0.28), hd * 0.6) +
             circle(0, -hd + 0.07, 0.03);
    },
    shower: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      s += path('M ' + esc(-hw) + ' ' + esc(hd) + ' A ' + esc(w) + ' ' + esc(d) + ' 0 0 0 ' + esc(hw) + ' ' + esc(-hd));
      s += line(-0.06, 0, 0.06, 0);
      s += line(0, -0.06, 0, 0.06);
      return s;
    },
    bath: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d, 0.06) +
             rect(-hw + 0.07, -hd + 0.07, w - 0.14, d - 0.14, 0.10) +
             circle(hw - 0.22, 0, 0.035);
    },
    towelrail: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      var n = Math.max(3, Math.round(w / 0.12));
      for (var i = 1; i < n; i++) s += line(-hw + w * i / n, -hd, -hw + w * i / n, hd);
      return s;
    },

    /* ---- Kitchen ------------------------------------------------------- */
    counter: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) + line(-hw, hd - 0.05, hw, hd - 0.05);
    },
    ksink: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      var bw = (w - 0.12) / 2, bh = d - 0.14;
      s += rect(-hw + 0.04, -hd + 0.09, bw, bh, 0.02);
      s += rect(0.02, -hd + 0.09, bw, bh, 0.02);
      s += circle(0, -hd + 0.05, 0.03);
      return s;
    },
    oven: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) + circle(0, 0, Math.min(hw, hd) * 0.55) +
             line(-hw, hd - 0.07, hw, hd - 0.07);
    },
    hob: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var r = Math.min(w, d) * 0.17;
      return rect(-hw, -hd, w, d, 0.02) +
             circle(-w * 0.22, -d * 0.22, r) + circle(w * 0.22, -d * 0.22, r) +
             circle(-w * 0.22, d * 0.22, r) + circle(w * 0.22, d * 0.22, r);
    },
    appliance: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) + circle(0, 0.02, Math.min(hw, hd) * 0.5) +
             line(-hw, -hd + 0.08, hw, -hd + 0.08);
    },
    fridge: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) + line(-hw + 0.06, -hd, -hw + 0.06, hd) +
             line(hw - 0.05, -d * 0.12, hw - 0.05, d * 0.12);
    },
    cabinet: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) + line(-hw, -hd, hw, hd) + line(hw, -hd, -hw, hd);
    },

    /* ---- Structure and services ---------------------------------------- */
    stairs: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      var n = Math.max(3, Math.round(d / 0.26));
      for (var i = 1; i < n; i++) s += line(-hw, -hd + d * i / n, hw, -hd + d * i / n);
      s += line(0, hd - 0.10, 0, -hd + 0.10, ' marker-end="url(#rs-arrow)"');
      return s;
    },
    radiator: function (w, d) {
      var hw = w / 2, hd = d / 2;
      var s = rect(-hw, -hd, w, d);
      var n = Math.max(4, Math.round(w / 0.09));
      for (var i = 1; i < n; i++) s += line(-hw + w * i / n, -hd, -hw + w * i / n, hd);
      return s;
    },
    boiler: function (w, d) {
      var hw = w / 2, hd = d / 2;
      return rect(-hw, -hd, w, d) + circle(0, 0, Math.min(hw, hd) * 0.42);
    },
    column: function (w, d) {
      return rect(-w / 2, -d / 2, w, d, 0, ' class="rs-solid"');
    },
    plant: function (w, d) {
      var r = Math.min(w, d) / 2;
      var s = circle(0, 0, r);
      for (var i = 0; i < 6; i++) {
        var a = i * Math.PI / 3;
        s += line(0, 0, Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8);
      }
      return s;
    },
    box: function (w, d) { return rect(-w / 2, -d / 2, w, d); }
  };

  /* Map catalogue type → builder. */
  var MAP = {
    bed_single: BUILD.bed, bed_double: BUILD.bed, bed_king: BUILD.bed,
    wardrobe: BUILD.wardrobe,
    bedside: function (w, d) { return BUILD.drawers(w, d, 1); },
    dresser: function (w, d) { return BUILD.drawers(w, d, 3); },

    sofa_2: BUILD.sofa, sofa_3: BUILD.sofa, armchair: BUILD.sofa,
    coffee_table: function (w, d) { return BUILD.table(w, d, 0.05); },
    tv: BUILD.tv, bookshelf: BUILD.shelves, fireplace: BUILD.fireplace,

    dining_table: function (w, d) { return BUILD.table(w, d, 0.04); },
    dining_chair: BUILD.chair, chair: BUILD.chair,
    desk: function (w, d) { return BUILD.table(w, d, 0.02) + BUILD.drawers(Math.min(0.4, w * 0.3), d * 0.9, 2); },

    toilet: BUILD.toilet, basin: BUILD.basin, vanity: BUILD.vanity,
    shower: BUILD.shower, bath: BUILD.bath, towel_rad: BUILD.towelrail,

    counter: BUILD.counter, island: function (w, d) { return BUILD.counter(w, d) + BUILD.table(w - 0.16, d - 0.16, 0.02); },
    ksink: BUILD.ksink, oven: BUILD.oven, hob: BUILD.hob, fridge: BUILD.fridge,
    dishwasher: BUILD.appliance, washer: BUILD.appliance, cabinet: BUILD.cabinet,

    stairs: BUILD.stairs, radiator: BUILD.radiator, boiler: BUILD.boiler,
    column: BUILD.column, plant: BUILD.plant
  };

  /* Body content for an object, in its local metric frame. */
  function draw(type, w, d) {
    var fn = MAP[type] || BUILD.box;
    return fn(w, d);
  }

  /* A standalone SVG for palette buttons and menus. */
  function icon(type, size) {
    var def = (RS.Schema.OBJECTS[type] || { w: 0.6, d: 0.6 });
    var w = def.w, d = def.d;
    var m = Math.max(w, d) * 1.16;
    var body = draw(type, w, d);
    return '<svg viewBox="' + (-m / 2) + ' ' + (-m / 2) + ' ' + m + ' ' + m +
      '" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" ' +
      'stroke-width="' + (m * 0.022) + '" stroke-linejoin="round" vector-effect="non-scaling-stroke">' +
      body + '</svg>';
  }

  /* Marker and pattern definitions the symbols reference. */
  function defs() {
    return '' +
      '<marker id="rs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
        '<path d="M 0 1 L 9 5 L 0 9 z" fill="context-stroke"/>' +
      '</marker>' +
      '<marker id="rs-tick" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto">' +
        '<path d="M 2 8 L 8 2" stroke="context-stroke" stroke-width="1.6" fill="none"/>' +
      '</marker>' +
      '<pattern id="rs-hatch" width="0.14" height="0.14" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
        '<line x1="0" y1="0" x2="0" y2="0.14" stroke="context-stroke" stroke-width="0.02"/>' +
      '</pattern>';
  }

  return { draw: draw, icon: icon, defs: defs, SW: SW, MAP: MAP };
})();
