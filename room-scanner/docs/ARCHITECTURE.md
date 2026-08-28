# Architecture — and why this differs from the brief

## 1. The problem with the brief's Phase 3

The brief specifies: video → feature tracking → visual odometry / SLAM → COLMAP structure-from-motion
→ point cloud → plane fitting → walls.

That is the textbook pipeline. It is also the wrong first move for this product, for four reasons:

1. **Interior walls have no features.** Structure-from-motion needs texture. A painted magnolia wall, a
   white ceiling and a plain carpet give a feature detector almost nothing. COLMAP fails or produces a
   degenerate reconstruction in exactly the rooms this app is for. It works beautifully on cluttered
   rooms and fails on the empty ones you most want to measure.
2. **Monocular SfM has no scale.** You recover geometry up to an unknown scale factor. You then have to
   fix the scale from something anyway — a known object, a user-entered measurement, or IMU
   integration. A user measurement is in the loop regardless.
3. **It is not free at the compute tier we are targeting.** COLMAP on a Hugging Face free CPU Space is
   minutes per room, with a hard timeout. Render's free tier sleeps and gives 512 MB RAM. Neither runs a
   dense reconstruction. You would be buying GPU time within a week.
4. **It is unrecoverable when it goes wrong.** When SLAM drifts, the user gets a bent room and no way to
   reason about why. There is no partial credit.

## 2. The better way: single-station ray casting

Do not reconstruct the camera path. **Stop moving the camera.**

The user stands roughly in the middle of the room and taps each corner where the wall meets the floor.
For each tap we have:

- the device orientation (yaw, pitch, roll) from `DeviceOrientationEvent` or WebXR,
- the tapped pixel, converted to a ray in camera space using the field of view,
- the camera height above the floor, `h`.

The floor is a known plane (`z = 0`). The camera is at `(0, 0, h)`. Intersect the world-space ray with
the floor plane:

```
d_world = R(yaw, pitch, roll) * d_camera
t       = -h / d_world.z          (valid when d_world.z < 0, i.e. pointing downwards)
corner  = (t * d_world.x, t * d_world.y)
```

That is a metric floor coordinate, from one tap, with no reconstruction, no server and no ML.

### Why this is genuinely better here

| | SfM / SLAM path | Single-station ray cast |
|---|---|---|
| Works on blank walls | No | Yes — you tap the corner, texture is irrelevant |
| Compute | Minutes, server, GPU wanted | Sub-millisecond, in the browser |
| Scale | Unknown, must be fixed later | Metric immediately from `h` |
| Failure mode | Bent room, no explanation | One bad tap — drag the corner, fixed |
| Time to a plan | 30 s scan then minutes of processing | ~20 s, the plan appears live as you tap |
| Works offline | No | Yes |

### The scale trick that makes camera height a non-issue

Every captured point scales **linearly** with camera height. If `h` is wrong by 10%, the whole room is
wrong by 10% — but the *shape* is exactly right. So the user never has to measure their phone height
accurately. They tape-measure **one** wall, type it in, and the entire room rescales to correct. This
satisfies brief §13 with one number instead of a calibration procedure.

### Openings use bearing only

For doors and windows we do **not** intersect the floor. The wall is already known, so we intersect the
horizontal bearing of the tap with the wall segment. That is independent of pitch and of `h`, so a
window tapped at head height positions exactly as accurately as a door tapped at floor level.

## 3. What SLAM and ML are actually for

They stay in the design — as **accelerators, not dependencies**. This is the key inversion:

- **Tier 0 — browser, always available, zero cost.** Orientation ray casting, geometry model, editor,
  renderer, SVG / PNG / PDF / DXF export. The product is complete and useful with nothing else switched
  on.
- **Tier 1 — optional free heavy compute (Hugging Face Space, or Render).** Monocular depth
  (Depth Anything V2) and object detection (YOLO / DETR) on a handful of key frames, used to
  *pre-populate* corners and furniture so the user confirms rather than taps. If the Space is asleep,
  slow or wrong, Tier 0 still works.
- **Tier 2 — optional LLM (Claude by default, Gemini as an alternative).** Interpretation and
  presentation only: room classification, labelling, style configuration, plain-English warnings.
  Structured JSON in, structured JSON out. **Never geometry.**

WebXR (`immersive-ar`) is a Tier 0.5 upgrade: on Android Chrome it gives real metric poses and hit-test
against detected planes, which removes the height assumption entirely. iOS Safari does not support it,
so it can never be the base layer — it is detected and used when present.

## 4. Layer A / Layer B (brief §3) is enforced structurally

`js/core/schema.js` holds Layer A. Nothing in `js/ai/` may write to it. The AI provider returns a
presentation config and a set of *suggestions*, applied only through the same store actions a human
click uses — so every AI change lands in the undo stack and is reversible. A wall measured at 4.82 m
stays 4.82 m.

## 5. Repository layout

```
hse-room-scanner/
  index.html                 app shell — three screens: Projects / Scan / Plan
  css/theme.css              HSE design tokens
  css/app.css                layout and components
  js/core/schema.js          Layer A: room model, IDs, defaults, validation
  js/core/geometry.js        vector maths, polygon offset, area, snapping, regularisation
  js/core/store.js           state, undo/redo, localStorage persistence
  js/capture/orientation.js  device orientation to rotation matrix (+ iOS permission)
  js/capture/raycast.js      ray-to-floor and bearing-to-wall intersection
  js/capture/scan.js         guided capture controller
  js/render/symbols.js       architectural SVG symbol library
  js/render/plan.js          structured geometry to SVG, three styles
  js/editor/editor.js        select / drag / snap / edit, numeric dimension entry
  js/export/*.js             svg, png, pdf, dxf, json
  js/ai/provider.js          pluggable: none | claude | gemini | hf-space
  js/ui/app.js               wiring
  server/hf-space/           optional Tier 1: Gradio Space (depth + detection)
  server/render/             optional Tier 1: FastAPI equivalent for Render.com
```

## 6. Phasing (replaces brief §26)

| Phase | Content | State |
|---|---|---|
| 1 | Geometry model, SVG renderer, 2D editor | **built** |
| 2 | Single-station capture: corners, openings, objects, scale-from-known-length | **built** |
| 3 | Styles: technical, presentation, 2.5D | **built** |
| 4 | SVG / PNG / PDF / DXF / JSON export | **built** |
| 5 | Optional LLM layer (Claude default, Gemini optional) | **built, off by default** |
| 6 | Tier 1 Space: depth and detection to pre-populate | **client built, Space provided to deploy** |
| 7 | Multi-room: door-graph stitching, storeys, overlap checks | **built** |
| 8 | WebXR hit-test capture on supported devices | designed, not built |
| 9 | Three.js 3D extrusion from the same model | designed, not built |

## 6a. Whole-house stitching

Rooms arrive in unrelated coordinate frames — each scan is centred on wherever
the surveyor stood. Joining them is not a reconstruction problem.

A doorway seen from both sides is **two observations of one physical object**. It
fixes a position and a direction, which is precisely the three degrees of freedom
of a rigid transform in the plane. So the alignment is closed form:

```
rotation     make room B's outward normal at the door the opposite of A's
translation  put B's door centre on A's door centre, offset across the wall
```

`js/core/stitch.js` holds this. Three things in it are worth knowing:

- **The wall offset is not optional.** Each room polygon is the inner face of its
  own walls, so at a shared door the two inner faces are one wall thickness
  apart. Both rooms measured that wall; the two figures are averaged. Omitting
  this puts the rooms 100 mm into each other, which reads as almost right.
- **The transform is rigid, so measurements survive it.** Wall lengths and areas
  are preserved to under a thousandth of a millimetre through a join. Stitching
  can move a room; it can never change what was measured in it. That is Layer A
  discipline applied to placement.
- **Overlap detection has a trap in it.** Adjoining rooms share a wall line, so
  their edges are collinear and every intersection is an endpoint touch. A naive
  crossing test finds nothing — and finds nothing in the broken case too, where
  two rooms are stacked along that same shared wall and lie on top of each other.
  The test therefore shrinks one polygon by 40 mm and tests its vertices against
  the other at full size, which separates a legitimate neighbour from a genuine
  collision.

The door graph is per storey, since a door does not lead between floors.
`restitch()` walks it breadth-first from an anchor room, so editing one room
re-places everything downstream of it.

## 7. Accuracy, honestly (brief §27)

Expected error for the single-station method with a corrected scale, in a normal rectangular room:
**1–3% on wall lengths, 2–5% on area**. Sources of error, largest first: yaw noise from the
magnetometer indoors, the camera field-of-view estimate, tap precision at the floor line, and non-level
floors. `docs/ACCURACY.md` gives the test protocol.

This is estate-agent and space-planning accuracy. It is **not** survey accuracy, and the app must never
say that it is.

## 8. Privacy (brief §35)

Tier 0 sends nothing anywhere. No frame, no measurement and no project leaves the device — projects live
in `localStorage`. Tier 1 and Tier 2 are opt-in per action, name the destination before sending, and
send the minimum: Tier 1 gets a single downscaled JPEG, Tier 2 gets numbers and labels, never an image
of someone's home.
