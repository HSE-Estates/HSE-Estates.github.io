/* ---------------------------------------------------------------------------
   Device orientation → world rotation matrix.

   The W3C deviceorientation angles are an intrinsic Z-X'-Y'' rotation:
       R = Rz(alpha) · Rx(beta) · Ry(gamma)
   which maps a vector in the DEVICE frame (x right, y up the screen,
   z out of the screen towards the user) into the EARTH frame
   (x east, y north, z up).

   The rear camera looks along -z of the device frame, so a screen tap becomes
   a camera-space ray, is rotated into the device frame by the current screen
   orientation, then into the world by R.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Orientation = (function () {
  'use strict';

  var listening = false;
  var supported = ('DeviceOrientationEvent' in window);
  var haveSample = false;
  var lastEventAt = 0;
  var sampleCount = 0;

  var euler = { alpha: 0, beta: 90, gamma: 0 };   // smoothed
  var rawEuler = { alpha: 0, beta: 90, gamma: 0 };
  var absolute = false;
  var jitter = { alpha: 0, beta: 0, gamma: 0 };   // running mean |delta|, a proxy for noise
  var SMOOTH = 0.25;                              // EMA factor on each sample

  var handlers = [];

  function needsPermission() {
    return typeof DeviceOrientationEvent !== 'undefined' &&
           typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  /* iOS 13+ requires this to be called from inside a user gesture. */
  function requestPermission() {
    if (!needsPermission()) return Promise.resolve('granted');
    try {
      return DeviceOrientationEvent.requestPermission()
        .then(function (r) { return r; })
        .catch(function () { return 'denied'; });
    } catch (e) {
      return Promise.resolve('denied');
    }
  }

  function start() {
    if (listening || !supported) return supported;
    window.addEventListener('deviceorientationabsolute', onEvent, true);
    window.addEventListener('deviceorientation', onEvent, true);
    listening = true;
    return true;
  }

  function stop() {
    if (!listening) return;
    window.removeEventListener('deviceorientationabsolute', onEvent, true);
    window.removeEventListener('deviceorientation', onEvent, true);
    listening = false;
  }

  function onEvent(ev) {
    if (ev.alpha == null && ev.beta == null && ev.gamma == null) return;
    lastEventAt = Date.now();
    sampleCount += 1;

    var a = ev.alpha == null ? rawEuler.alpha : ev.alpha;
    /* iOS exposes a true compass heading; it runs the opposite way to alpha. */
    if (typeof ev.webkitCompassHeading === 'number' && !isNaN(ev.webkitCompassHeading)) {
      a = 360 - ev.webkitCompassHeading;
      absolute = true;
    } else if (ev.absolute) {
      absolute = true;
    }

    var b = ev.beta == null ? rawEuler.beta : ev.beta;
    var g = ev.gamma == null ? rawEuler.gamma : ev.gamma;

    jitter.alpha = jitter.alpha * 0.9 + Math.abs(angDelta(a, rawEuler.alpha)) * 0.1;
    jitter.beta = jitter.beta * 0.9 + Math.abs(b - rawEuler.beta) * 0.1;
    jitter.gamma = jitter.gamma * 0.9 + Math.abs(g - rawEuler.gamma) * 0.1;

    rawEuler.alpha = a; rawEuler.beta = b; rawEuler.gamma = g;

    if (!haveSample) {
      euler.alpha = a; euler.beta = b; euler.gamma = g;
      haveSample = true;
    } else {
      euler.alpha = wrap360(euler.alpha + angDelta(a, euler.alpha) * SMOOTH);
      euler.beta = euler.beta + (b - euler.beta) * SMOOTH;
      euler.gamma = euler.gamma + (g - euler.gamma) * SMOOTH;
    }

    handlers.forEach(function (h) { try { h(getState()); } catch (e) { console.error(e); } });
  }

  function onChange(fn) { handlers.push(fn); return function () { handlers = handlers.filter(function (h) { return h !== fn; }); }; }

  function angDelta(a, b) { return ((a - b) % 360 + 540) % 360 - 180; }
  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function rad(d) { return d * Math.PI / 180; }

  /* Rotation matrix, row-major 3x3, device → world. */
  function matrix(e) {
    e = e || euler;
    var a = rad(e.alpha), b = rad(e.beta), g = rad(e.gamma);
    var cA = Math.cos(a), sA = Math.sin(a);
    var cB = Math.cos(b), sB = Math.sin(b);
    var cG = Math.cos(g), sG = Math.sin(g);
    return [
      [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
      [sA * cG + cA * sB * sG,  cA * cB, sA * sG - cA * sB * cG],
      [-cB * sG,                sB,      cB * cG]
    ];
  }

  function applyMatrix(m, v) {
    return {
      x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
      y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
      z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z
    };
  }

  /* The screen may be rotated relative to the device body. Rotating the ray
     about the device z axis by the screen angle puts a screen-space ray into
     the device frame. */
  function screenAngle() {
    if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
      return window.screen.orientation.angle;
    }
    if (typeof window.orientation === 'number') return window.orientation;
    return 0;
  }

  function rotateForScreen(v, angleDeg) {
    var t = rad(angleDeg == null ? screenAngle() : angleDeg);
    var c = Math.cos(t), s = Math.sin(t);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
  }

  /* Pitch below the horizon, in degrees. Negative means aimed downwards,
     which is what a floor tap needs. */
  function cameraPitch() {
    var f = applyMatrix(matrix(), rotateForScreen({ x: 0, y: 0, z: -1 }));
    return Math.asin(RS.Geom ? RS.Geom.clamp(f.z, -1, 1) : Math.max(-1, Math.min(1, f.z))) * 180 / Math.PI;
  }

  /* Compass bearing the camera is pointing along, degrees clockwise from
     world +y (north). */
  function cameraYaw() {
    var f = applyMatrix(matrix(), rotateForScreen({ x: 0, y: 0, z: -1 }));
    return wrap360(Math.atan2(f.x, f.y) * 180 / Math.PI);
  }

  /* Is there a usable orientation reading at all?

     Kept strictly separate from quality() below. quality() falls as the phone
     MOVES, because jitter and genuine rotation are indistinguishable from a
     single sample — so it goes to zero exactly while you are turning. Anything
     that needs to know "do we have a pose" must ask this, not quality(), or it
     will reject every reading taken during a sweep. */
  function hasPose() {
    return haveSample && (Date.now() - lastEventAt) < 1500;
  }

  /* 0..1 steadiness estimate. Indoors the magnetometer is the weak link, so
     alpha jitter dominates. Shown to the user, and stored on each captured
     point as its confidence. Low means "moving or noisy", not "unusable". */
  function quality() {
    if (!haveSample) return 0;
    var age = Date.now() - lastEventAt;
    if (age > 1500) return 0;
    var j = jitter.alpha * 1.5 + jitter.beta + jitter.gamma;
    return Math.max(0, Math.min(1, 1 - j / 6));
  }

  function getState() {
    return {
      supported: supported,
      listening: listening,
      needsPermission: needsPermission(),
      sampleCount: sampleCount,
      live: hasPose(),
      absolute: absolute,
      euler: { alpha: euler.alpha, beta: euler.beta, gamma: euler.gamma },
      quality: quality(),
      screenAngle: screenAngle()
    };
  }

  /* Freeze the current orientation — taken at the moment of a tap so that a
     later frame cannot contaminate the measurement. */
  function snapshot() {
    return {
      euler: { alpha: euler.alpha, beta: euler.beta, gamma: euler.gamma },
      matrix: matrix(),
      screenAngle: screenAngle(),
      quality: quality(),
      at: Date.now()
    };
  }

  return {
    supported: function () { return supported; },
    needsPermission: needsPermission,
    requestPermission: requestPermission,
    start: start, stop: stop, onChange: onChange,
    matrix: matrix, applyMatrix: applyMatrix, rotateForScreen: rotateForScreen,
    screenAngle: screenAngle, cameraPitch: cameraPitch, cameraYaw: cameraYaw,
    quality: quality, hasPose: hasPose, getState: getState, snapshot: snapshot
  };
})();
