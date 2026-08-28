# Room Scanner

Stand in the middle of a room, tap each corner where the wall meets the floor,
and get a dimensioned, editable floor plan you can export as SVG, PNG, PDF or
CAD-ready DXF.

Everything is measured on the device and stored on the device. No account, no
build step, no server, no cost.

---

## Why this is not the pipeline in the brief

The brief specifies video → SLAM → COLMAP → point cloud → plane fitting. That is
the textbook route and it is the wrong first move here: structure-from-motion
needs texture, and the plain painted walls this app exists to measure give a
feature detector almost nothing. It also cannot run on a free compute tier.

This build replaces it with **single-station ray casting**. The device already
knows which way it is pointing; a tap is a ray; the floor is a known plane below
you; where they meet is a metric coordinate. No reconstruction, no upload, no
waiting, and the plan appears live as you tap.

The one unknown is how high you are holding the phone — and because every point
scales with it by exactly the same factor, one tape-measured wall corrects the
whole room at once.

Full reasoning, and what SLAM and ML are still for, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Running it

The editor, renderer and all exports work by opening `index.html` straight from
disk. **Scanning does not** — browsers only allow camera and motion access on
`https` or `localhost`.

```bash
py -m http.server 8123 --directory hse-room-scanner
```

Then open `http://localhost:8123`. Or use the launcher:

```bash
hse-room-scanner/serve.cmd
```

There is no build step and no dependency to install. It is plain HTML, CSS and
JavaScript.

### Publishing it on GitHub Pages

**[docs/PUBLISHING.md](docs/PUBLISHING.md) is the click-by-click version** —
GitHub and Hugging Face both, written to be followed with no prior knowledge.
The short version follows.

This is the easiest way to scan from a phone, because Pages gives you https —
which is what the camera and motion sensors require.

```bash
cd hse-room-scanner
git init -b main
git add .
git commit -m "Room Scanner"
git remote add origin https://github.com/YOURNAME/room-scanner.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch → main /
(root) → Save**. A minute later it is live at
`https://YOURNAME.github.io/room-scanner/`.

Things worth knowing before you do it:

- **The repo has to be public** on a free GitHub account. Pages from a private
  repo needs Pro. Publishing the code is safe — there are no keys in it. Your
  API key lives in your browser's localStorage and is never committed.
- **It works from a subdirectory.** Pages project sites live under
  `/repo-name/`, and every path in the app is relative, so nothing has to change.
  This is tested, not assumed.
- **Your surveys do not go with it.** localStorage is per browser and per
  origin, so publishing the app publishes the app, not your data. Scanning on
  the phone stores the survey on the phone.
- `.nojekyll` is included so GitHub serves every file as-is.

Netlify and Cloudflare Pages work the same way — drag the folder in.

### Branding the sheet

A logo chosen in **Settings** is saved in that one browser, on that one device —
which is why it is missing when you open the app on your phone or publish it.

To make it part of the site instead, put it in **[branding/logo.txt](branding/)**
as a base64 data URL, and set `orgName` in `branding/brand.json`. Then it appears
on every device, for everyone, with nothing to set up per device.

You do not have to encode anything by hand: **Settings → Sheet branding → Choose
logo → Save for whole site** downloads a ready-made `logo.txt` to drop into that
folder. [branding/README.md](branding/README.md) has the detail and the terminal
one-liners if you prefer them.

Site branding is the default; a logo chosen in Settings overrides it on that
device only, so an individual surveyor can brand their own exports without
changing the site.

The app deliberately ships no organisation's logo — supply one you are entitled
to use, because a plan carrying a logo reads as a document issued by that
organisation. The header, the green rule and the title block use the HSE palette
from `css/theme.css` either way.

The PDF picks whichever A4 orientation prints the plan **larger**, states the
true scale ratio for that sheet (`1:40`, `1:50` and so on, snapped to a
conventional ratio when it is close to one), and prints the floor area, the
capture method and whether the scale was corrected against a measured wall.

---

## Using it

**Scan.** Two ways, chosen at the top of the scan screen.

*Record a sweep* (default). Stand in the middle, press **Record**, turn slowly
all the way round, press **Stop**. The app captures about four frames a second,
each one stored with the phone's orientation at that instant. Then you slide
back through the frames and tap the corners on still pictures — no time
pressure, no holding steady, and you can take as long as you like over each one.
The measurement is identical to tapping live, because it is the same ray cast
against the pose recorded with that frame.

*Tap live.* The original: aim and tap while standing still. Faster once you are
used to it, and harder in a cluttered or dark room.

Either way, markers stick to the real corners as you turn or scrub, so a bad tap
is obvious immediately — undo it and tap again.

**Turn on the spot; do not walk.** Every frame in a sweep has to share one
standing position, because the floor intersection is taken from a camera at a
known height above a known point. Walking would need the camera path, which is
the reconstruction problem this app exists to avoid.

**Doors and windows.** Tap one jamb, then the other. Height does not matter for
these: they are placed by bearing against the wall you already measured, so a
window tapped at head height is as accurate as a door tapped at the floor.

**Furniture.** Pick an item and tap the floor at its centre. Sizes come from a
standard catalogue and are adjustable.

**Set the scale.** Measure one wall with a tape and type it in. Everything
rescales. This is the single most valuable thing you can do for accuracy.

**Join it to the floor.** From the second room onwards you are asked which door
you walked through. Pick it and the same door as seen from the previous room, and
the room drops into its true position. The checks panel flags any room still
floating, and any two rooms that ended up on top of each other.

**Edit.** Drag corners, drag the midpoint handles to add a corner, drag doors
along walls, rotate and resize furniture, or type exact wall lengths in the
panel. Everything snaps and everything undoes.

**Export.** SVG and DXF are true vector output generated from the geometry. PNG
and PDF are rendered from the same drawing at 300 dpi. DXF is written in
millimetres on the standard architectural layers — WALLS, DOORS, WINDOWS,
FURNITURE, FIXTURES, DIMENSIONS, TEXT, ROOM_LABELS.

### Keyboard

| Key | Action |
|---|---|
| `V` `D` `W` `O` `M` `X` | select, door, window, opening, measure, delete |
| `F` | zoom to fit |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| arrows | nudge selection (hold shift for 0.5 m) |
| `Delete` | delete selection |
| shift-drag / middle-drag | pan |

---

## The optional extras

Both are **off by default** and the app is complete without either.

### AI — Claude built in, Gemini as an alternative

Settings → Optional AI. Paste an API key; it is stored in this browser and sent
nowhere else. Three actions: classify and label the room, review the plan for
implausibilities, and configure the presentation style for a stated audience.

What it is allowed to do is enforced in code, not just documented:

- It receives **numbers and item names only** — never a photograph of anyone's
  home.
- Style output passes through an allow-list, so a hallucinated `"wall_length":
  4.2` in a response is discarded before it can reach anything.
- Room labelling and styling go through the same store actions a click does,
  which means they land in the undo stack and are reversible.
- Nothing the model returns can set a coordinate, a length or an area.

Claude is the default provider (Sonnet 5, with Opus 5 and Haiku 4.5 selectable).
Gemini 2.5 Flash and Pro are supported behind the same interface — swapping
providers changes one dropdown.

### Heavy processing — Hugging Face or Render

Settings → Optional heavy processing. Point it at a deployed Space and a
"Detect items" button appears during the furniture step: one 768 px frame goes
out, and object suggestions come back as *unconfirmed* items you accept or
delete.

`server/hf-space/` is a ready-to-deploy Gradio Space (Depth Anything V2 Small +
YOLOS-small) with instructions. `server/render/` is the same service as FastAPI
for Render.com. Hugging Face is the better free option — 16 GB of RAM against
Render's 512 MB, which torch plus two vision models will not fit into.

The Space returns image-space boxes and bearings, never room coordinates. Only
the browser knows the camera pose, so only the browser converts a detection into
a floor position — through exactly the same ray-cast a human tap goes through. A
detection is a simulated tap, not a second way of measuring.

---

## Accuracy

Typically **1–3% on wall lengths and 2–5% on area** once the scale is corrected.
This is estate-agent and space-planning accuracy, not survey accuracy, and the
app says so on every PDF it produces.

The ray-cast maths is exact and has a deterministic regression test that needs no
building — synthesise device orientations aiming at known corners and check the
reconstruction. It returns the room to four decimal places. The test and the
field protocol are in [docs/ACCURACY.md](docs/ACCURACY.md).

---

## Privacy

Surveys live in `localStorage` on the device. No frame, no measurement and no
project leaves it unless you export a file or explicitly use one of the optional
AI features — each of which names its destination first and sends the minimum.

---

## Layout

```
index.html                 app shell — Surveys / Scan / Plan
css/theme.css              design tokens (the only place colours are defined)
css/app.css                layout and components
js/core/schema.js          LAYER A — the room model. Every measurement lives here
js/core/geometry.js        polygon offset, squaring-up, snapping, scaling
js/core/stitch.js          joining rooms through a shared door, overlap checks
js/core/brand.js           site logo and organisation name from branding/
js/core/store.js           state, undo/redo, localStorage
js/capture/orientation.js  device orientation → rotation matrix
js/capture/sweep.js        record frames with their poses, scrub them afterwards
js/capture/raycast.js      ray→floor, bearing→wall, lens solving, scale correction
js/capture/scan.js         the guided capture flow
js/render/symbols.js       architectural symbol library
js/render/plan.js          LAYER B — geometry → SVG, three styles
js/editor/editor.js        drag, snap, place, measure
js/export/{dxf,pdf,exporters}.js
js/ai/provider.js          optional: Claude / Gemini / detection Space
js/ui/app.js               wiring
branding/                  logo.txt and brand.json for the PDF header
server/hf-space/           optional Hugging Face Space
server/render/             optional Render service
samples/sample-room.json   worked example
docs/                      architecture, accuracy, publishing, deployment
```

## Documentation

| | |
|---|---|
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | Click-by-click GitHub Pages and Hugging Face setup |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why not SLAM, how stitching works, module layout |
| [docs/ACCURACY.md](docs/ACCURACY.md) | Error sources, test protocol, runnable regression test |
| [docs/ORGANISATIONAL-USE.md](docs/ORGANISATIONAL-USE.md) | Accessibility, privacy, what is still needed before deployment |
| [branding/README.md](branding/README.md) | Putting your logo on every device |

## Whole houses, video and moving work between devices

Three questions that come up immediately, answered honestly.

### Can it do a full house?

Yes. Scan each room, capturing the door you walked through, then join the rooms
through that shared door.

**How the joining works.** A doorway seen from both sides is two observations of
one physical object, and that is exactly enough to place a room: it fixes a
position and a direction, which is all three degrees of freedom of a rigid
transform in the plane. Closed form, no SLAM, no optimiser, no residual to tune.

- rotation — turn room B until its outward wall normal at that door faces back
  towards room A
- translation — put B's door centre on A's door centre, pushed across the wall

The one physical subtlety: each room's polygon is the **inner** face of its own
walls, so the two inner faces at a shared door are one wall thickness apart, not
coincident. Both rooms measured that wall independently, so the two figures are
averaged. Get this wrong and the rooms sit 100 mm inside each other — which looks
almost right, and is not.

**Rooms are only joined, never distorted.** The transform is rigid: measured
wall lengths and floor areas are preserved to under a thousandth of a
millimetre. Joining cannot change what you measured.

**The wrong door is caught.** Joining through the wrong door usually puts one
room on top of another, so every join is followed by an overlap test across the
floor, and the checks panel says which two rooms collided. Adjoining rooms
legitimately share a wall line, so the test shrinks one polygon by 40 mm before
comparing — otherwise touching neighbours read as overlapping and, worse, two
rooms stacked along that same shared wall read as fine.

**Floors.** Each room carries a storey, so the ground floor and the first floor
stack rather than tile. The floor selector, the door graph, the overlap checks
and the exports are all storey-aware — a door never leads between storeys.

**The rest of the floor is visible while you work.** Neighbouring rooms are drawn
faded behind the room being edited, so you can see the plan taking shape without
being able to drag a neighbour by accident. Dimension lines that would fall
inside a neighbouring room are dropped, and a shared door is drawn once rather
than once per room.

Edit an anchor room afterwards and **Re-align the whole floor** walks the door
graph and re-places everything downstream of it.

### Can I upload a video?

**Recording a sweep is built** — see *Scan* above. What is not possible is
uploading a video from the camera roll, and the reason is worth knowing:
**an MP4 carries no orientation data.** The device-orientation stream is not
written into the file, so saving or emailing a video throws away the exact thing
that makes the measuring work. Feeding one back in puts you on the
structure-from-motion path, on featureless walls, on a free tier — the route this
build deliberately avoids.

This is also what CubiCasa's app actually does: it records the walkthrough
*together with* the phone's motion data. The video alone was never the input.

Frames rather than a video file, deliberately:

- No codec negotiation. MediaRecorder output differs across iOS and Android, and
  mp4 timestamps drift against a separately logged sensor stream.
- Each frame is paired with its own pose at capture time, so there is no clock to
  synchronise and nothing to interpolate.
- Scrubbing is an array index — exact and instant.

A sweep is capped at 160 frames (about 40 seconds) and held in memory only; the
frames are released when the scan closes.

There is also a route that needs **no pose at all**, worth recording because it
is the only way an emailed video or a stray photograph could ever produce
geometry: indoor scenes are overwhelmingly rectilinear, so the vanishing points
of a single frame give the camera's rotation relative to the room's own axes.
Combined with an assumed camera height that is enough to back-project a tapped
corner onto the floor — the same ray cast, with the rotation recovered from the
picture instead of the sensor. It needs line-segment detection and a RANSAC fit
over line intersections, it degrades on curved or cluttered rooms, and it is
meaningfully less accurate than the sensor. A real project, not an afternoon.


Video keyframes to the detection Space for *furniture suggestions* is a smaller
job — `RS.Scan.runDetection()` already sends one frame, and N frames is a loop.

### Phone to computer

Scanning happens on the phone and the plan is finished on the phone — it renders
live as you tap, and because nothing is uploaded there is nothing to wait for.

Moving it to a computer works today via **Export → Project JSON** on the phone and
**Import JSON** on the desktop. A few KB per room, no infrastructure.

Editing on the phone is supported and tested: the inspector slides over as a
panel, and handles use 48 px touch targets behind an 18 px visible dot.

Real sync is not built. The shape it should take is a **share code**: the phone
POSTs the project JSON and gets a six-character code, the desktop types the code
and pulls it. About sixty lines on Cloudflare Workers with KV — whose free tier
does not sleep, unlike Render's, and does not lose its storage on restart, unlike
a Hugging Face Space.

## What else is not built

In the order I would do it:

1. **WebXR hit-test capture** on Android Chrome — removes camera height and yaw
   drift entirely where the device supports it.
2. **In-app video with a pose log** (above).
3. **Share-code sync** (above).
4. **A building envelope for dimensions.** Dimensions are still per room, so a
   multi-room sheet has no overall width and depth across the outside of the
   building. That needs the union outline of the floor.
5. **Stair alignment between storeys.** Floors currently stack by their own
   coordinates; nothing yet forces the stairwell on the first floor to sit over
   the stairwell on the ground floor.
6. **Three.js 3D view** — the model already carries ceiling heights, sill heights
   and opening heights, so extrusion is a rendering job, not a data job.
7. **True vector PDF** — currently a 300 dpi raster with live text in the title
   block. SVG and DXF are the vector deliverables.
8. **DXF blocks** — furniture exports as its footprint plus a label rather than
   as a symbol block.
