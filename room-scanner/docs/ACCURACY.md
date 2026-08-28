# Accuracy — what to claim, and how to prove it

Brief §27 asks for accuracy to be treated as an engineering metric rather than a
marketing adjective. This is the protocol.

## The claim

> Indicative survey for space planning. Wall lengths typically within 1–3%, floor
> area within 2–5%, once the scale has been corrected against one measured wall.
> Not a measured survey.

That sentence is printed on every PDF export. It should not be softened without
new test data, and it should not be strengthened either.

## Where the error comes from, largest first

| Source | Typical | Behaviour | Mitigation in the app |
|---|---|---|---|
| Yaw noise (magnetometer indoors) | 1–3° | Rotates corners about the station; distorts shape, not size | Squaring-up regularisation; corner confidence falls with range |
| Field-of-view estimate | 2–8% if unset | Radial distortion of the polygon | "Solve lens" — one-parameter fit against rectilinearity |
| Camera height | 5–15% if guessed | **Pure scale** — shape is untouched | One tape-measured wall corrects everything |
| Tap precision at the floor line | 5–15 px | Grows with range² / height | Live re-projected markers; reticle; horizon line |
| Non-level floor, thick carpet, skirting | 1–2 cm | Small offset per corner | None — accept it |

The important structural point: **camera height error is a pure scale factor**.
That is why the app asks for one measurement instead of trying to be clever. Any
system that cannot separate scale error from shape error has to fix both at once,
which is much harder.

## Test protocol

1. Pick five rooms with known dimensions — ideally a mix: one plain rectangle,
   one with a chimney breast, one L-shaped, one small (a WC), one large.
2. Measure each wall with a laser or tape to ±5 mm. This is ground truth.
3. Scan each room three times, from three different standing positions.
4. Correct the scale on the longest wall only.
5. Record, per room and per repeat:
   - wall length error, absolute and percentage, per wall
   - floor area error, percentage
   - door and window centre-position error along its wall, in mm
   - largest corner position error, in mm
6. Report the median and the 90th percentile, not the mean. One bad tap
   dominates a mean and tells you nothing about the typical experience.

## Pass criteria before the claim above may be printed

- Median wall-length error ≤ 3%, 90th percentile ≤ 6%
- Median area error ≤ 5%
- Median opening position error ≤ 100 mm
- No room where squaring-up made the error worse

## Regression test that needs no rooms

`RS.Raycast` is deterministic, so the geometry can be tested without a building.
Synthesise device orientations that aim exactly at the known corners of a known
room, feed them through `floorPoint`, and assert the reconstruction. Run this in
the browser console:

```js
const O = RS.Orientation, RC = RS.Raycast, S = RS.Schema;
const opts = { cameraHeight: 1.5, fovDeg: 66, elemWidth: 400, elemHeight: 800,
               videoWidth: 400, videoHeight: 800, mirrored: false };
const centre = { x: 200, y: 400 };
const station = { x: 2, y: 1.5 };                    // standing in a 4 x 3 room
const truth = [[0,0],[4,0],[4,3],[0,3]].map(c => ({ x: c[0]-station.x, y: c[1]-station.y }));

const got = truth.map(pt => {
  const v = { x: pt.x, y: -pt.y, z: -opts.cameraHeight };
  const yaw = Math.atan2(v.x, v.y);
  const pitch = Math.asin(v.z / Math.hypot(v.x, v.y, v.z));
  const orient = {
    matrix: O.matrix({ alpha: ((-yaw*180/Math.PI)%360+360)%360,
                       beta: 90 + pitch*180/Math.PI, gamma: 0 }),
    screenAngle: 0, quality: 1
  };
  return RC.floorPoint(centre, orient, opts);
});

const room = S.newRoom('t');
got.forEach(g => room.points.push(S.newPoint(g.x, g.y, 1)));
S.syncWalls(room);
console.log(S.roomArea(room));      // 12.000 exactly
```

This is checked in and passes: the reconstruction is exact to four decimal
places, and the area comes back as 12.000 m². Any drift here is a bug in the
maths, not a measurement problem — which usefully separates the two.

## What would move the needle

In rough order of value per unit of work:

1. **WebXR hit-test** on Android Chrome. Removes camera height and yaw drift
   entirely; the device does the tracking. Cannot be the base layer because iOS
   Safari has no WebXR AR, but where it exists it should win.
2. **Multi-station capture.** Take the same corners from two standing points and
   triangulate. Removes the height dependency without a tape measure and gives a
   residual to report as a real confidence number.
3. **Vanishing-point yaw correction.** The wall-floor lines in the frame give an
   independent orientation estimate that does not drift the way a magnetometer
   does indoors. Cheap in-browser, and attacks the largest error source.
