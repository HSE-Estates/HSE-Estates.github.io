/* ---------------------------------------------------------------------------
   Whole-house stitching.

   Each scan comes back centred on wherever the surveyor was standing, so a set
   of rooms is a set of correct shapes in unrelated coordinate frames. Joining
   them does NOT need SLAM, a point cloud or an optimiser.

   A doorway seen from both sides is two observations of one physical object.
   That gives a position and a direction shared between the two frames, which is
   exactly enough to determine a rigid transform in the plane — three degrees of
   freedom, closed form, no iteration and no residual to tune:

     rotation     make room B's outward normal at the door face back towards A
     translation  put B's door centre on A's door centre, pushed across the wall

   The one physical subtlety: each room's polygon is the INNER face of its own
   walls, so the two inner faces at a shared door are a wall thickness apart,
   not coincident. Getting that wrong puts the rooms a hundred millimetres into
   each other, which looks almost right and is wrong.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Stitch = (function () {
  'use strict';

  var G = RS.Geom, S = RS.Schema;

  /* Where an opening sits in its room's own coordinates: the centre point on
     the inner wall face, the wall direction, and the outward normal. */
  function openingFrame(room, opening) {
    var n = room.points.length;
    if (!n || opening.wallIndex >= n) return null;
    var a = room.points[opening.wallIndex];
    var b = room.points[(opening.wallIndex + 1) % n];
    var dir = G.norm(G.sub(b, a));
    var inward = G.wallNormal(room, opening.wallIndex);
    return {
      centre: { x: a.x + dir.x * opening.offset, y: a.y + dir.y * opening.offset },
      dir: dir,
      outward: { x: -inward.x, y: -inward.y },
      thickness: room.walls[opening.wallIndex].thickness,
      width: opening.width
    };
  }

  /* Move `room` so that `opening` coincides with `anchorOpening` in
     `anchorRoom`, which stays exactly where it is. Returns a report; performs
     no store bookkeeping of its own. */
  function align(anchorRoom, anchorOpening, room, opening) {
    var A = openingFrame(anchorRoom, anchorOpening);
    var B = openingFrame(room, opening);
    if (!A || !B) return { ok: false, reason: 'One of those openings is not on a wall any more.' };

    /* Rotation: B's outward normal must end up pointing back at A, i.e. become
       the opposite of A's outward normal. */
    var targetNormal = { x: -A.outward.x, y: -A.outward.y };
    var theta = Math.atan2(targetNormal.y, targetNormal.x) - Math.atan2(B.outward.y, B.outward.x);
    var degrees = G.deg(theta);

    G.rotateRoom(room, degrees, B.centre);

    /* Rotation was about B's own door centre, so that point has not moved.
       Now slide it onto A's door centre, offset across the shared wall.
       The two rooms model the same wall independently; average the two. */
    var wall = (A.thickness + B.thickness) / 2;
    var target = {
      x: A.centre.x + A.outward.x * wall,
      y: A.centre.y + A.outward.y * wall
    };
    G.translateRoom(room, target.x - B.centre.x, target.y - B.centre.y);

    room.storey = anchorRoom.storey || 0;
    room.placed = true;

    /* The two independent measurements of the same doorway are a free accuracy
       check — the kind of number that is worth showing rather than hiding. */
    var widthMismatch = Math.abs(A.width - B.width);

    return {
      ok: true,
      rotatedBy: G.round(((degrees % 360) + 540) % 360 - 180, 1),
      wallThickness: G.round(wall, 3),
      widthMismatch: G.round(widthMismatch, 3),
      warning: widthMismatch > 0.12
        ? 'The two rooms measured this doorway ' + Math.round(widthMismatch * 1000) +
          ' mm apart. Check which one is right before trusting the join.'
        : null
    };
  }

  /* Align and record the link, as one undoable action. */
  function connect(project, anchorRoom, anchorOpening, room, opening) {
    var res = align(anchorRoom, anchorOpening, room, opening);
    if (!res.ok) return res;
    S.linkOpenings(project, anchorRoom, anchorOpening, room, opening);
    res.overlap = overlapWith(project, room);
    return res;
  }

  /* Re-apply every link, breadth-first from the rooms already placed. Used
     after a room's shape is edited, so the rest of the floor follows it. */
  function restitch(project, rootRoomId) {
    if (!project.rooms.length) return { moved: 0, unreached: 0 };
    var root = rootRoomId ? S.findRoom(project, rootRoomId) : null;
    if (!root) root = project.rooms.filter(function (r) { return r.points.length >= 3; })[0];
    if (!root) return { moved: 0, unreached: 0 };
    /* A door graph lives on one floor. Counting the upstairs bedrooms as
       "unreached" would be true and useless. */
    var rooms = S.roomsOnStorey(project, root.storey || 0);

    var done = {};
    done[root.id] = true;
    var queue = [root];
    var moved = 0;
    var guard = 0;

    while (queue.length && guard++ < 500) {
      var current = queue.shift();
      current.openings.forEach(function (op) {
        if (!op.link) return;
        var other = S.findRoom(project, op.link.roomId);
        if (!other || done[other.id]) return;
        var otherOpening = S.findOpening(project, op.link.roomId, op.link.openingId);
        if (!otherOpening) return;
        var r = align(current, op, other, otherOpening);
        if (r.ok) moved += 1;
        done[other.id] = true;
        queue.push(other);
      });
    }
    return { moved: moved, unreached: rooms.filter(function (r) { return !done[r.id]; }).length };
  }

  /* -- Overlap detection ---------------------------------------------------
     Two rooms on one storey must not occupy the same floor. This is the check
     that catches a join made through the wrong door, which otherwise produces a
     confident-looking and completely wrong plan. */
  function overlapWith(project, room) {
    var others = S.roomsOnStorey(project, room.storey || 0)
      .filter(function (r) { return r.id !== room.id && r.points.length >= 3; });
    for (var i = 0; i < others.length; i++) {
      if (polygonsOverlap(room.points, others[i].points)) {
        return { roomId: others[i].id, name: others[i].name };
      }
    }
    return null;
  }

  var EPS = 0.04;   // metres — smaller than any real wall, larger than rounding

  /* Do two rooms occupy the same floor?

     The subtlety that makes the naive version wrong: adjoining rooms SHARE a
     wall line, so their edges are collinear and every intersection is an
     endpoint touch. A crossing test finds nothing — and it finds nothing in
     the genuinely broken case too, where two rooms are stacked along that same
     shared wall and lie right on top of each other.

     The fix is to shrink one polygon by a hair and test its vertices against
     the other at full size. Shrinking breaks the collinearity: a legitimate
     neighbour's vertices move away from the shared wall and land outside,
     while an overlapping room's vertices stay firmly inside. */
  function polygonsOverlap(a, b) {
    var ba = bbox(a), bb = bbox(b);
    if (ba.maxX - EPS <= bb.minX || bb.maxX - EPS <= ba.minX) return false;
    if (ba.maxY - EPS <= bb.minY || bb.maxY - EPS <= ba.minY) return false;

    var sa = shrink(a), sb = shrink(b);

    if (sa.some(function (p) { return S.pointInPolygon(p, b); })) return true;
    if (sb.some(function (p) { return S.pointInPolygon(p, a); })) return true;

    /* Neither contains a vertex of the other in cross-shaped overlaps, so the
       shrunk edges still have to be checked for a true crossing. */
    for (var i = 0; i < sa.length; i++) {
      for (var j = 0; j < sb.length; j++) {
        if (segmentsCross(sa[i], sa[(i + 1) % sa.length], sb[j], sb[(j + 1) % sb.length])) return true;
      }
    }
    return false;
  }

  /* Pull a polygon in by EPS. Falls back to the original if the offset turns
     the shape inside out, which a room smaller than 80 mm would do. */
  function shrink(pts) {
    if (pts.length < 3) return pts;
    var before = G.signedArea(pts);
    var out = G.offsetPolygon(pts, -EPS);
    var after = G.signedArea(out);
    if (!isFinite(after) || after === 0 || (after > 0) !== (before > 0)) return pts;
    if (Math.abs(after) > Math.abs(before)) return pts;   // offset went the wrong way
    return out;
  }

  function segmentsCross(p1, p2, p3, p4) {
    function d(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
    var d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
           ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  }

  function bbox(pts) {
    var r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    pts.forEach(function (p) {
      r.minX = Math.min(r.minX, p.x); r.maxX = Math.max(r.maxX, p.x);
      r.minY = Math.min(r.minY, p.y); r.maxY = Math.max(r.maxY, p.y);
    });
    return r;
  }

  /* -- Candidate suggestion -------------------------------------------------
     Which door in another room is this door most likely to be? Doors of a
     similar width are far more likely to be the same doorway, and a door
     already linked is out of the running. */
  function candidates(project, room, opening) {
    var out = [];
    S.roomsOnStorey(project, room.storey || 0).forEach(function (other) {
      if (other.id === room.id || other.points.length < 3) return;
      other.openings.forEach(function (op) {
        if (op.link) return;
        if (op.type === 'window' || op.type === 'patio') return;   // not a way through
        out.push({
          roomId: other.id,
          roomName: other.name,
          openingId: op.id,
          type: op.type,
          width: op.width,
          widthDelta: Math.abs(op.width - opening.width)
        });
      });
    });
    out.sort(function (a, b) { return a.widthDelta - b.widthDelta; });
    return out;
  }

  /* Doors a surveyor still has to account for: unlinked internal doors are
     either a way into a room that has not been scanned, or a missed join. */
  function danglingDoors(project, storey) {
    var out = [];
    S.roomsOnStorey(project, storey).forEach(function (room) {
      room.openings.forEach(function (op) {
        if (op.link) return;
        if (op.type === 'window' || op.type === 'patio') return;
        out.push({ roomId: room.id, roomName: room.name, openingId: op.id, type: op.type });
      });
    });
    return out;
  }

  /* Project-level checks, separate from the per-room ones in schema.validate. */
  function validateBuilding(project, storey) {
    var issues = [];
    var rooms = S.roomsOnStorey(project, storey).filter(function (r) { return r.points.length >= 3; });

    for (var i = 0; i < rooms.length; i++) {
      for (var j = i + 1; j < rooms.length; j++) {
        if (polygonsOverlap(rooms[i].points, rooms[j].points)) {
          issues.push({
            level: 'error',
            text: '"' + rooms[i].name + '" and "' + rooms[j].name + '" overlap. They are probably joined through the wrong door.',
            target: { kind: 'room', id: rooms[j].id }
          });
        }
      }
    }

    var unplaced = rooms.filter(function (r) { return !r.placed && rooms.length > 1; });
    if (unplaced.length && rooms.length > 1) {
      issues.push({
        level: 'warn',
        text: unplaced.length + ' room' + (unplaced.length === 1 ? ' has' : 's have') +
          ' not been joined to the rest of the floor yet.',
        target: unplaced[0] ? { kind: 'room', id: unplaced[0].id } : null
      });
    }

    return issues;
  }

  return {
    openingFrame: openingFrame,
    align: align,
    connect: connect,
    restitch: restitch,
    candidates: candidates,
    danglingDoors: danglingDoors,
    overlapWith: overlapWith,
    polygonsOverlap: polygonsOverlap,
    validateBuilding: validateBuilding
  };
})();
