/* ---------------------------------------------------------------------------
   Sweep capture — record first, tap afterwards.

   Tapping corners live is the accurate part of this app and the unpleasant part
   of using it: you have to hold the phone steady, aim at a wall-floor junction
   and hit it with your thumb, all at once, standing in the middle of a room.

   This records a sweep instead. You press record, turn slowly on the spot, and
   press stop. Then you scrub back through the captured frames, and tap the
   corners on a still picture with as long as you like and as much zoom as you
   want. The measurement is identical — it is the same ray cast — because every
   frame is stored together with the phone's orientation at the instant it was
   taken.

   Frames rather than a video file, deliberately:

     • No codec negotiation. MediaRecorder output differs across iOS and
       Android, and mp4 timestamps drift against a separate sensor log.
     • Each frame is paired with its own pose at capture time, so there is no
       clock to synchronise and nothing to interpolate.
     • Scrubbing is an array index, which is exact and instant.

   The consequence, and it matters: TURN ON THE SPOT, do not walk. Every frame
   has to share one standing position, because the floor intersection is taken
   from a camera at a known height above a known point. Walking would need the
   camera path, which is the reconstruction problem this app exists to avoid.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Sweep = (function () {
  'use strict';

  var O = RS.Orientation;

  var MAX_FRAMES = 160;
  var INTERVAL_MS = 260;        // ~4 frames a second
  var MAX_DIM = 1280;           // long edge; plenty for tapping a corner

  var frames = [];              // { url, w, h, orient, at, yaw }
  var state = 'idle';           // idle | recording | review
  var timer = null;
  var index = 0;
  var listeners = [];
  var startedAt = 0;
  var lastYaw = null;
  var sweptDeg = 0;
  /* Why frames were dropped, so a failed sweep can say what actually went
     wrong instead of guessing at permissions. */
  var skipped = { noVideo: 0, noPose: 0, encodeFailed: 0 };

  function on(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }
  function emit() { listeners.forEach(function (f) { try { f(status()); } catch (e) { console.error(e); } }); }

  function status() {
    return {
      state: state,
      count: frames.length,
      index: index,
      seconds: state === 'recording' ? (Date.now() - startedAt) / 1000 : 0,
      swept: Math.round(sweptDeg),
      full: frames.length >= MAX_FRAMES,
      skipped: { noVideo: skipped.noVideo, noPose: skipped.noPose, encodeFailed: skipped.encodeFailed }
    };
  }

  /* -- Recording ----------------------------------------------------------- */

  function start(videoEl) {
    if (state === 'recording') return;
    reset();
    state = 'recording';
    startedAt = Date.now();
    lastYaw = null;
    sweptDeg = 0;
    emit();

    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');

    timer = setInterval(function () {
      if (state !== 'recording') return;
      if (frames.length >= MAX_FRAMES) { stop(); return; }
      grab(videoEl, canvas, ctx);
    }, INTERVAL_MS);

    /* Take one immediately so the first frame is not a quarter second late. */
    grab(videoEl, canvas, ctx);
  }

  function grab(videoEl, canvas, ctx) {
    var vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) { skipped.noVideo += 1; return; }

    /* hasPose(), NOT quality(). quality falls as the phone moves and hits zero
       exactly while you are turning — gating on it threw away every frame of
       the sweep and reported it as a permissions problem. A moving frame is
       still perfectly measurable; its steadiness is recorded and carried into
       the corner's confidence instead. */
    if (!O.hasPose()) { skipped.noPose += 1; return; }
    var orient = O.snapshot();

    var k = Math.min(1, MAX_DIM / Math.max(vw, vh));
    var w = Math.round(vw * k), h = Math.round(vh * k);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(videoEl, 0, 0, w, h);

    /* Track how far round the room the sweep has gone, so the user can be told
       when they have covered enough rather than guessing. */
    var yaw = O.cameraYaw();
    if (lastYaw !== null) {
      var d = ((yaw - lastYaw) % 360 + 540) % 360 - 180;
      sweptDeg += Math.abs(d);
    }
    lastYaw = yaw;

    canvas.toBlob(function (blob) {
      if (!blob) { skipped.encodeFailed += 1; emit(); return; }
      if (state === 'idle') return;
      frames.push({
        url: URL.createObjectURL(blob),
        w: w,
        h: h,
        orient: orient,
        at: Date.now() - startedAt,
        yaw: yaw
      });
      emit();
    }, 'image/jpeg', 0.82);
  }

  /* toBlob is asynchronous, so the last frames grabbed are still encoding when
     Stop is pressed. Settling briefly before judging the sweep avoids
     announcing "nothing was captured" while frames are still arriving. */
  function stop(done) {
    if (state !== 'recording') { if (done) done(status()); return; }
    if (timer) { clearInterval(timer); timer = null; }
    setTimeout(function () {
      state = frames.length ? 'review' : 'idle';
      index = 0;
      emit();
      if (done) done(status());
    }, 350);
  }

  /* -- Review -------------------------------------------------------------- */

  function seek(i) {
    if (!frames.length) return null;
    index = Math.max(0, Math.min(frames.length - 1, Math.round(i)));
    emit();
    return frames[index];
  }

  function step(delta) { return seek(index + delta); }
  function current() { return frames[index] || null; }

  /* The pose that goes with the frame on screen. This is what makes tapping a
     still picture identical to tapping the live view. */
  function currentOrient() {
    var f = frames[index];
    return f ? f.orient : null;
  }

  /* Jump to whichever frame was pointing most directly at a given plan bearing,
     so "show me the corner I just placed" works. */
  function frameNearestYaw(targetYaw) {
    if (!frames.length) return -1;
    var best = 0, bestD = 999;
    frames.forEach(function (f, i) {
      var d = Math.abs(((f.yaw - targetYaw) % 360 + 540) % 360 - 180);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function reset() {
    if (timer) { clearInterval(timer); timer = null; }
    frames.forEach(function (f) {
      try { URL.revokeObjectURL(f.url); } catch (e) { /* already gone */ }
    });
    frames = [];
    index = 0;
    sweptDeg = 0;
    lastYaw = null;
    skipped = { noVideo: 0, noPose: 0, encodeFailed: 0 };
    state = 'idle';
    emit();
  }

  /* Rough memory held by the captured frames, so the UI can warn rather than
     let a long sweep quietly exhaust a phone. */
  function approxBytes() { return frames.length * 90 * 1024; }

  return {
    start: start, stop: stop, reset: reset,
    seek: seek, step: step, current: current, currentOrient: currentOrient,
    frameNearestYaw: frameNearestYaw,
    status: status, on: on, approxBytes: approxBytes,
    get frames() { return frames; },
    get state() { return state; },
    MAX_FRAMES: MAX_FRAMES
  };
})();
