/* ---------------------------------------------------------------------------
   Automatic reconstruction.

   Sends a sweep — frames plus the camera pose recorded with each one — to the
   Hugging Face Space, and turns what comes back into a room. No tapping.

   The pose is what makes this work without structure-from-motion. The Space
   segments the floor in each frame, back-projects the wall-floor line through
   the pose we supplied, and returns a finished outline. The client's job is to
   choose which frames to send, keep the upload small, and coerce the answer
   onto the schema so nothing malformed can reach the model.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Reconstruct = (function () {
  'use strict';

  var S = RS.Schema, G = RS.Geom;

  var MAX_FRAMES = 18;      // enough to cover a full turn; keeps the upload sane
  var FRAME_PX = 512;       // segmentation gains nothing from more than this

  /* Pick frames spread evenly around the turn rather than evenly in time.
     Someone who lingers on one wall and rushes another would otherwise send
     fifteen pictures of the same corner. */
  function chooseFrames(frames, limit) {
    if (frames.length <= limit) return frames.slice();

    var byYaw = frames.map(function (f, i) { return { f: f, i: i, yaw: f.yaw }; });
    var picked = [];
    var step = 360 / limit;
    for (var k = 0; k < limit; k++) {
      var target = (byYaw[0].yaw + k * step) % 360;
      var best = null, bestD = 1e9;
      byYaw.forEach(function (c) {
        if (picked.indexOf(c.f) >= 0) return;
        var d = Math.abs(((c.yaw - target) % 360 + 540) % 360 - 180);
        if (d < bestD) { bestD = d; best = c; }
      });
      if (best) picked.push(best.f);
    }
    return picked;
  }

  /* Downscale a captured frame and pair it with its pose. */
  function encodeFrame(frame) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var k = Math.min(1, FRAME_PX / Math.max(img.naturalWidth, img.naturalHeight));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve({
            image: canvas.toDataURL('image/jpeg', 0.78),
            alpha: frame.orient.euler.alpha,
            beta: frame.orient.euler.beta,
            gamma: frame.orient.euler.gamma,
            screenAngle: frame.orient.screenAngle || 0
          });
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = frame.url;
    });
  }

  /* Gradio's queue protocol, as used elsewhere in the app. Reconstruction is
     slower than detection, so this waits longer before giving up. */
  function callSpace(fnName, data, timeoutMs) {
    var base = String(RS.Store.getSettings().spaceUrl || '').replace(/\/+$/, '');
    if (!base) return Promise.reject(new Error('No Space URL is set. Add one in Settings.'));
    var url = base + '/gradio_api/call/' + fnName;

    var guard = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error('The Space did not answer within ' + Math.round(timeoutMs / 1000) +
          ' seconds. If it was asleep it may still be waking — try again in a minute.'));
      }, timeoutMs);
    });

    var work = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: data })
    }).then(function (r) {
      if (!r.ok) {
        throw new Error('The Space rejected the request (' + r.status +
          '). Check the URL in Settings, and that the Space is Running.');
      }
      return r.json();
    }).then(function (j) {
      var id = j.event_id || j.hash;
      if (!id) throw new Error('The Space returned no job id.');
      return fetch(url + '/' + id);
    }).then(function (r) { return r.text(); })
      .then(function (text) {
        var lines = text.split('\n');
        var last = null;
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('data: ') === 0) {
            try { last = JSON.parse(lines[i].slice(6)); } catch (e) { /* partial */ }
          }
        }
        if (last == null) throw new Error('The Space returned no result.');
        return Array.isArray(last) ? last[0] : last;
      });

    return Promise.race([work, guard]);
  }

  /* Run the whole thing. onProgress gets short status strings for the UI. */
  function run(frames, opts, onProgress) {
    function say(msg) { if (onProgress) onProgress(msg); }

    if (!frames || !frames.length) {
      return Promise.reject(new Error('Record a sweep first.'));
    }
    if (!RS.AI.spaceEnabled()) {
      return Promise.reject(new Error('No Space is configured. Add its address in Settings.'));
    }

    var chosen = chooseFrames(frames, MAX_FRAMES);
    say('Preparing ' + chosen.length + ' frames…');

    return Promise.all(chosen.map(encodeFrame)).then(function (encoded) {
      var payload = encoded.filter(Boolean);
      if (!payload.length) throw new Error('None of the frames could be read.');

      var bytes = payload.reduce(function (t, f) { return t + f.image.length; }, 0);
      say('Sending ' + payload.length + ' frames (' + Math.round(bytes / 1024) + ' KB)…');

      return callSpace('reconstruct',
        [JSON.stringify(payload), opts.cameraHeight, opts.fovDeg], 240000);
    }).then(function (res) {
      if (!res || res.ok === false) {
        var err = new Error((res && res.error) || 'Reconstruction failed.');
        err.diagnostics = res && res.diagnostics;
        throw err;
      }
      say('Building the plan…');
      return res;
    });
  }

  /* Space result -> a room on the schema. Every number is re-validated here;
     nothing from the network is trusted straight into the model. */
  function toRoom(res, name, type, opts) {
    var room = S.newRoom(name || 'Scanned room', type || 'other');
    room.capture.method = 'detected';
    room.capture.cameraHeight = opts.cameraHeight;
    room.capture.fovDeg = opts.fovDeg;
    room.capture.capturedAt = Date.now();

    var pts = (res.points || []).filter(function (p) {
      return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]);
    });
    if (pts.length < 3) throw new Error('The result had no usable outline.');

    var conf = Math.max(0.15, Math.min(0.75, Number(res.confidence) || 0.4));
    pts.forEach(function (p) { room.points.push(S.newPoint(p[0], p[1], conf)); });
    S.syncWalls(room);

    /* Openings arrive as bearing spans from the standing position, which is the
       plan origin. Intersecting a bearing with the outline puts each one on the
       right wall at the right place — the same route a tapped jamb takes. */
    (res.openings || []).forEach(function (o) {
      if (!S.OPENING_TYPES[o.type]) return;
      var a = bearingVector(o.bearing_from);
      var b = bearingVector(o.bearing_to);
      if (!a || !b) return;
      var span = RS.Raycast.openingFromBearings(room, a, b);
      if (!span) return;
      var wallLen = S.wallLength(room, span.wallIndex);
      var width = G.clamp(span.width, 0.4, Math.max(0.4, wallLen - 0.05));
      var op = S.newOpening(o.type, span.wallIndex,
        G.clamp(span.offset, width / 2, Math.max(width / 2, wallLen - width / 2)));
      op.width = width;
      op.confidence = Math.max(0.15, Math.min(0.6, Number(o.confidence) || 0.35));
      room.openings.push(op);
    });

    (res.objects || []).forEach(function (o) {
      if (!S.OBJECTS[o.type]) return;
      if (!isFinite(o.x) || !isFinite(o.y)) return;
      var ob = S.newObject(o.type, o.x, o.y, 0);
      ob.confidence = Math.max(0.15, Math.min(0.5, Number(o.confidence) || 0.3));
      if (!S.pointInPolygon(ob, room.points)) return;   // outside the room it found
      var snap = G.snapObjectToWall(room, ob, 0.7);
      if (snap) { ob.x = snap.x; ob.y = snap.y; ob.rot = snap.rot; }
      room.objects.push(ob);
    });

    return room;
  }

  function bearingVector(deg) {
    if (!isFinite(deg)) return null;
    var t = deg * Math.PI / 180;
    /* Plan frame: x right, y down the page, bearing measured clockwise from up. */
    return { x: Math.sin(t), y: -Math.cos(t) };
  }

  return {
    run: run,
    toRoom: toRoom,
    chooseFrames: chooseFrames,
    MAX_FRAMES: MAX_FRAMES
  };
})();
