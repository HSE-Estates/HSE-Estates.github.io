"""
Room Scanner — automatic reconstruction service.

Two endpoints:

    detect       one frame  -> object suggestions            (unchanged)
    reconstruct  N frames   -> a complete room, automatically

`reconstruct` is the one that removes the tapping. The client sends a handful of
frames from a sweep, each with the phone's orientation at the instant it was
taken, and gets back a finished room outline with doors, windows and furniture.

------------------------------------------------------------------------------
HOW IT WORKS, AND WHY IT IS NOT STRUCTURE-FROM-MOTION
------------------------------------------------------------------------------

The hard part of reconstructing a room from pictures is normally working out
where the camera was. Structure-from-motion solves that by matching features
between frames, which fails on plain painted walls — exactly the walls this app
exists to measure.

We do not have to solve it. The phone already knows which way it is pointing,
and the client sends that with every frame. So the camera pose is an INPUT, not
something to be recovered. What is left is a segmentation problem:

  1. Segment each frame (ADE20K classes). Take the FLOOR mask.
  2. For each image column, the topmost floor pixel is the point where the wall
     meets the floor — the same junction a person would tap.
  3. Back-project that pixel through the known camera rotation onto the floor
     plane, a known height below the camera. That yields a metric coordinate.
     This is identical to the client's own ray cast, which reconstructs a test
     room to zero error.
  4. Repeat across every column of every frame. Each frame contributes an
     angular sector; together they cover the room.
  5. Collapse to a polar profile — radius as a function of bearing — because a
     room seen from one standing point is star-shaped. Take a high percentile
     per bearing bin so furniture standing in front of a wall does not pull the
     wall inwards.
  6. Simplify the profile into straight segments. Those are the walls, and
     their intersections are the corners.

Doors and windows come from the same segmentation, projected onto the wall they
sit on by bearing. Furniture comes from the detector, placed by its ground
contact point.

------------------------------------------------------------------------------
WHAT THIS SERVICE NOW RETURNS, AND THE BOUNDARY THAT MOVED
------------------------------------------------------------------------------

The earlier version deliberately returned no geometry, on the grounds that only
the browser knew the camera pose. That reasoning no longer applies: the pose is
sent with every frame, so the geometry can be computed correctly here.

What has NOT changed is that every number is derived, never invented. The
network segments pixels; trigonometry does the measuring. A wrong segmentation
produces a visibly wrong wall, not a plausible fabrication. Everything comes
back with a confidence and lands in an editor where it can be corrected.
"""

import base64
import io
import json
import math
import re

import gradio as gr
import numpy as np
from PIL import Image

try:
    import spaces          # ZeroGPU only; absent on CPU basic
    HAS_ZERO_GPU = True
except ImportError:                                   # pragma: no cover
    HAS_ZERO_GPU = False

    class _Shim:
        @staticmethod
        def GPU(fn=None, **_kw):
            return fn if fn else (lambda f: f)

    spaces = _Shim()

from transformers import pipeline

SEG_ID = "nvidia/segformer-b4-finetuned-ade-512-512"
DETECTOR_ID = "hustvl/yolos-small"
DEPTH_ID = "depth-anything/Depth-Anything-V2-Small-hf"

_seg = None
_detector = None
_depther = None


def segmenter():
    global _seg
    if _seg is None:
        _seg = pipeline("image-segmentation", model=SEG_ID)
    return _seg


def detector():
    global _detector
    if _detector is None:
        _detector = pipeline("object-detection", model=DETECTOR_ID)
    return _detector


def depther():
    global _depther
    if _depther is None:
        try:
            _depther = pipeline("depth-estimation", model=DEPTH_ID)
        except Exception:
            _depther = False
    return _depther


# --------------------------------------------------------------------------
# Label handling. Matching ADE20K by NAME rather than by class index, because
# index order differs between checkpoints and a silent off-by-one would put the
# ceiling where the floor should be.
# --------------------------------------------------------------------------
FLOOR_LABELS = {"floor", "flooring", "rug", "carpet", "mat", "earth", "ground"}
WALL_LABELS = {"wall"}
CEILING_LABELS = {"ceiling"}
DOOR_LABELS = {"door", "double door", "screen door"}
WINDOW_LABELS = {"windowpane", "window", "screen"}

# ADE20K label -> the app's object catalogue (js/core/schema.js OBJECTS)
SEG_OBJECTS = {
    "bed": "bed_double",
    "sofa": "sofa_3",
    "armchair": "armchair",
    "chair": "chair",
    "swivel chair": "chair",
    "table": "dining_table",
    "coffee table": "coffee_table",
    "desk": "desk",
    "wardrobe": "wardrobe",
    "closet": "wardrobe",
    "cabinet": "cabinet",
    "chest of drawers": "dresser",
    "shelf": "bookshelf",
    "bookcase": "bookshelf",
    "toilet": "toilet",
    "sink": "basin",
    "bathtub": "bath",
    "shower": "shower",
    "refrigerator": "fridge",
    "oven": "oven",
    "stove": "hob",
    "dishwasher": "dishwasher",
    "washer": "washer",
    "television receiver": "tv",
    "crt screen": "tv",
    "screen door": None,
    "radiator": "radiator",
    "stairs": "stairs",
    "stairway": "stairs",
    "fireplace": "fireplace",
    "countertop": "counter",
    "kitchen island": "island",
    "pot": "plant",
    "plant": "plant",
}

COCO_OBJECTS = {
    "bed": "bed_double", "couch": "sofa_3", "chair": "chair",
    "dining table": "dining_table", "tv": "tv", "toilet": "toilet",
    "sink": "basin", "refrigerator": "fridge", "oven": "oven",
    "potted plant": "plant", "book": "bookshelf",
}

MIN_SCORE = 0.45


# --------------------------------------------------------------------------
# Geometry. Deliberately mirrors js/capture/raycast.js and
# js/capture/orientation.js so both sides agree to the last decimal.
# --------------------------------------------------------------------------
def rotation_matrix(alpha, beta, gamma):
    """W3C deviceorientation Z-X'-Y'' intrinsic rotation, device -> world."""
    a, b, g = math.radians(alpha), math.radians(beta), math.radians(gamma)
    cA, sA = math.cos(a), math.sin(a)
    cB, sB = math.cos(b), math.sin(b)
    cG, sG = math.cos(g), math.sin(g)
    return np.array([
        [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
        [sA * cG + cA * sB * sG,  cA * cB, sA * sG - cA * sB * cG],
        [-cB * sG,                sB,      cB * cG],
    ])


def screen_rotation(angle_deg):
    """The screen may be rotated relative to the device body."""
    t = math.radians(angle_deg)
    c, s = math.cos(t), math.sin(t)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def floor_points(px, py, width, height, pose, camera_height, fov_deg):
    """Image pixels -> metric plan coordinates on the floor.

    px, py are arrays of pixel coordinates. Returns (xy, valid) where xy is
    (N, 2) in the plan frame: x right, y down the page, metres, relative to
    where the surveyor stood.
    """
    tan_h = math.tan(math.radians(fov_deg) / 2.0)
    tan_v = tan_h * (height / float(width))

    nx = (px / float(width)) * 2.0 - 1.0
    ny = (py / float(height)) * 2.0 - 1.0

    # Ray in the screen-camera frame; the rear camera looks along -z.
    d_cam = np.stack([nx * tan_h, -ny * tan_v, -np.ones_like(nx)], axis=1)

    R = rotation_matrix(pose["alpha"], pose["beta"], pose["gamma"])
    Rs = screen_rotation(pose.get("screenAngle", 0.0))
    d_world = (R @ Rs @ d_cam.T).T

    dz = d_world[:, 2]
    valid = dz < -0.02                      # must point below the horizon
    t = np.where(valid, -camera_height / np.where(valid, dz, -1.0), 0.0)

    wx = d_world[:, 0] * t
    wy = d_world[:, 1] * t
    rng = np.hypot(wx, wy)
    valid &= (t > 0) & (rng < 30.0)         # 30 m is beyond any room

    return np.stack([wx, -wy], axis=1), valid


def decode(data_url):
    payload = re.sub(r"^data:image/[a-zA-Z+]+;base64,", "", data_url or "")
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


def masks_by_label(seg_result):
    """pipeline output -> {label: bool array}, merged across duplicate labels."""
    out = {}
    for item in seg_result:
        label = str(item.get("label", "")).lower().strip()
        m = np.array(item["mask"]) > 127
        out[label] = out[label] | m if label in out else m
    return out


def union(masks, wanted):
    got = None
    for label, m in masks.items():
        if label in wanted:
            got = m if got is None else (got | m)
    return got


# --------------------------------------------------------------------------
# The reconstruction itself
# --------------------------------------------------------------------------
def wall_floor_points(floor_mask, wall_mask, pose, camera_height, fov_deg, step=6):
    """Find the wall-floor junction and back-project it.

    For each image column the topmost floor pixel is the junction — the same
    place a person is told to tap. Columns where a wall does not actually sit
    above the floor are dropped: that guards against a table top or a doorway
    through to another room being read as the edge of this one.
    """
    h, w = floor_mask.shape
    cols, rows = [], []

    for x in range(0, w, step):
        col = floor_mask[:, x]
        ys = np.flatnonzero(col)
        if ys.size < 4:
            continue
        y = int(ys.min())
        if y <= 1:
            continue                       # floor runs off the top: no junction
        if wall_mask is not None:
            above = wall_mask[max(0, y - 12):y, x]
            if above.size and above.mean() < 0.34:
                continue                   # nothing wall-like above it
        cols.append(x)
        rows.append(y)

    if not cols:
        return np.zeros((0, 2)), np.zeros(0)

    xy, valid = floor_points(
        np.array(cols, dtype=float) + step / 2.0,
        np.array(rows, dtype=float),
        w, h, pose, camera_height, fov_deg,
    )
    return xy[valid], np.hypot(xy[valid][:, 0], xy[valid][:, 1])


def wall_ceiling_points(ceiling_mask, wall_mask, pose, drop, fov_deg, step=6):
    """The wall-CEILING junction, back-projected onto the ceiling plane.

    This is what rescues a room with furniture in it. A sofa against a wall can
    hide that wall's base completely from where you are standing — and what was
    never in shot cannot be recovered from the floor, at any percentile, with
    any amount of extra sweeping.

    But the wall is still perfectly visible above the sofa. Nothing stands in
    front of the ceiling. So the same ray cast, aimed upward at a plane `drop`
    metres above the camera instead of `camera_height` below it, measures the
    same wall at a height no furniture reaches.
    """
    h, w = ceiling_mask.shape
    cols, rows = [], []

    for x in range(0, w, step):
        col = ceiling_mask[:, x]
        ys = np.flatnonzero(col)
        if ys.size < 4:
            continue
        y = int(ys.max())                  # lowest ceiling pixel = the junction
        if y >= h - 2:
            continue
        if wall_mask is not None:
            below = wall_mask[y + 1:min(h, y + 13), x]
            if below.size and below.mean() < 0.34:
                continue
        cols.append(x)
        rows.append(y)

    if not cols:
        return np.zeros((0, 2))

    # Identical maths to the floor cast, with the plane above rather than below:
    # the ray must point UP, and the plane sits +drop away.
    tan_h = math.tan(math.radians(fov_deg) / 2.0)
    tan_v = tan_h * (h / float(w))
    nx = (np.array(cols, dtype=float) + step / 2.0) / float(w) * 2.0 - 1.0
    ny = (np.array(rows, dtype=float)) / float(h) * 2.0 - 1.0
    d_cam = np.stack([nx * tan_h, -ny * tan_v, -np.ones_like(nx)], axis=1)

    R = rotation_matrix(pose["alpha"], pose["beta"], pose["gamma"])
    Rs = screen_rotation(pose.get("screenAngle", 0.0))
    d_world = (R @ Rs @ d_cam.T).T

    dz = d_world[:, 2]
    valid = dz > 0.02
    t = np.where(valid, drop / np.where(valid, dz, 1.0), 0.0)
    wx = d_world[:, 0] * t
    wy = d_world[:, 1] * t
    valid &= (t > 0) & (np.hypot(wx, wy) < 30.0)

    return np.stack([wx, -wy], axis=1)[valid]


def solve_ceiling_drop(floor_profile, ceiling_profile, assumed_drop):
    """How far above the camera the ceiling really is.

    Everything measured against the ceiling plane scales linearly with that
    height, exactly as the floor scales with camera height. So where a bearing
    shows BOTH the floor and the ceiling, the two must report the same wall —
    and the ratio between them gives the true drop. No tape measure, no guess.
    """
    fmap = {round(a, 4): r for a, r, _ in floor_profile}
    ratios = []
    for a, r_c, _ in ceiling_profile:
        r_f = fmap.get(round(a, 4))
        if r_f and r_c > 0.3 and r_f > 0.3:
            ratios.append(r_f / r_c)
    if len(ratios) < 8:
        return assumed_drop, None
    k = float(np.median(ratios))
    if not (0.4 < k < 2.5):
        return assumed_drop, None
    return assumed_drop * k, round(k, 4)


def polar_profile(points, bin_deg=2.0, percentile=80.0, min_hits=2):
    """Collapse a cloud of boundary points into radius per bearing.

    A room seen from one standing position is star-shaped, so radius as a
    function of bearing is the natural description and it removes the ordering
    problem entirely.

    The percentile is the important parameter. Furniture in front of a wall
    produces short radii in that direction; the wall itself produces the long
    ones. Taking a high percentile rather than the median biases towards the
    wall, which is what we are trying to measure.
    """
    if len(points) == 0:
        return []

    bearings = (np.degrees(np.arctan2(points[:, 0], -points[:, 1])) + 360.0) % 360.0
    radii = np.hypot(points[:, 0], points[:, 1])

    nbins = int(round(360.0 / bin_deg))
    idx = np.minimum((bearings / bin_deg).astype(int), nbins - 1)

    profile = []
    for b in range(nbins):
        sel = radii[idx == b]
        if sel.size < min_hits:
            continue
        r = float(np.percentile(sel, percentile))
        ang = math.radians((b + 0.5) * bin_deg)
        profile.append((ang, r, int(sel.size)))
    return profile


def profile_to_polygon(profile, tolerance=0.12):
    """Simplify the polar profile straight into a polygon.

    Fast and accurate on an empty room, but it traces whatever it sees — so a
    sofa against a wall becomes part of the outline. fit_walls() is preferred;
    this is the fallback when too few walls can be fitted.
    """
    if len(profile) < 8:
        return []

    pts = [(r * math.sin(a), -r * math.cos(a)) for a, r, _ in profile]
    simplified = douglas_peucker(pts, tolerance, closed=True)

    cleaned = []
    for i, p in enumerate(simplified):
        a = simplified[i - 1]
        b = simplified[(i + 1) % len(simplified)]
        v1 = (p[0] - a[0], p[1] - a[1])
        v2 = (b[0] - p[0], b[1] - p[1])
        n1 = math.hypot(*v1)
        n2 = math.hypot(*v2)
        if n1 < 1e-6 or n2 < 1e-6:
            continue
        cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
        if cos > 0.985 and n1 > 0.25 and n2 > 0.25:
            continue
        cleaned.append(p)

    return cleaned if len(cleaned) >= 3 else simplified


# --------------------------------------------------------------------------
# Wall fitting
#
# The reason this exists rather than just simplifying the profile: furniture.
# A sofa against a wall hides that wall in every single frame, so no percentile
# and no amount of extra sweeping recovers it — the outline simply gets traced
# around the sofa and the room comes out too small.
#
# The fix is a prior that is almost always true indoors: a wall is straight,
# and it is the OUTERMOST thing in its direction. So instead of tracing the
# profile, break it into straight runs, fit a line to each, and where two runs
# lie along the same line keep the one further from where you stood. The wall
# visible on either side of the sofa then defines the wall behind it.
# --------------------------------------------------------------------------
def _segment_runs(pts, tol):
    """Split an ordered point sequence into runs that lie on a straight line."""
    runs = []
    n = len(pts)
    start = 0
    while start < n - 1:
        end = start + 1
        while end < n - 1 and _max_deviation(pts[start:end + 2]) <= tol:
            end += 1
        runs.append((start, end))
        start = end
    return runs


def _max_deviation(seq):
    if len(seq) < 3:
        return 0.0
    x1, y1 = seq[0]
    x2, y2 = seq[-1]
    dx, dy = x2 - x1, y2 - y1
    den = math.hypot(dx, dy)
    if den < 1e-9:
        return 1e9
    worst = 0.0
    for px, py in seq[1:-1]:
        d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / den
        worst = max(worst, d)
    return worst


def _fit_line(seq):
    """Total least squares. Returns (centroid, unit direction)."""
    arr = np.asarray(seq, dtype=float)
    c = arr.mean(axis=0)
    u, s, vt = np.linalg.svd(arr - c, full_matrices=False)
    d = vt[0]
    return c, d / (np.linalg.norm(d) or 1.0)


def fit_walls(profile, tol=0.085, min_points=5, min_length=0.45):
    """Polar profile -> polygon, via straight walls rather than a traced outline."""
    if len(profile) < 14:
        return []

    pts = [(r * math.sin(a), -r * math.cos(a)) for a, r, _ in profile]
    runs = _segment_runs(pts, tol)

    walls = []
    for a, b in runs:
        seq = pts[a:b + 1]
        if len(seq) < min_points:
            continue
        length = math.hypot(seq[-1][0] - seq[0][0], seq[-1][1] - seq[0][1])
        if length < min_length:
            continue
        c, d = _fit_line(seq)
        # Signed distance from the standing point to the line.
        normal = np.array([-d[1], d[0]])
        offset = float(np.dot(c, normal))
        mid_bearing = math.degrees(math.atan2(
            (seq[0][0] + seq[-1][0]) / 2.0, -(seq[0][1] + seq[-1][1]) / 2.0)) % 360.0
        walls.append({
            "c": c, "d": d, "normal": normal, "offset": offset,
            "length": length, "n": len(seq), "bearing": mid_bearing,
            "seq": seq,
        })

    if len(walls) < 3:
        return []

    # Merge runs that lie on the SAME line. The profile starts at due north, so
    # a wall straddling that bearing always arrives as two pieces — and trying
    # to intersect two halves of one wall yields no corner at all, which is why
    # this has to happen before anything else.
    walls = _merge_collinear(walls)
    if len(walls) < 3:
        return []

    # Drop a wall that lies along the same line as a longer one but nearer the
    # standing point: that is furniture in front of the real wall.
    kept = []
    for w in sorted(walls, key=lambda z: -z["length"]):
        occluded = False
        for k in kept:
            parallel = abs(float(np.dot(w["d"], k["d"]))) > 0.985
            if not parallel:
                continue
            gap = abs(abs(w["offset"]) - abs(k["offset"]))
            bearing_gap = abs(((w["bearing"] - k["bearing"]) % 360 + 540) % 360 - 180)
            # Same direction, roughly the same part of the room, but closer in.
            if bearing_gap < 55 and 0.05 < gap < 1.6 and abs(w["offset"]) < abs(k["offset"]):
                occluded = True
                break
        if not occluded:
            kept.append(w)

    if len(kept) < 3:
        return []

    kept.sort(key=lambda z: z["bearing"])

    # Corners are where consecutive walls meet.
    poly = []
    for i in range(len(kept)):
        w1 = kept[i]
        w2 = kept[(i + 1) % len(kept)]
        p = _intersect(w1, w2)
        if p is None:
            return []
        # A corner implausibly far away means two near-parallel walls were
        # intersected; the traced outline is safer than a spike to infinity.
        if math.hypot(p[0], p[1]) > 25.0:
            return []
        poly.append(p)

    return poly if len(poly) >= 3 else []


def _merge_collinear(walls, offset_tol=0.14):
    """Combine runs that lie along one line, and refit from all their points."""
    merged = []
    for w in sorted(walls, key=lambda z: -z["length"]):
        target = None
        for m in merged:
            if abs(float(np.dot(w["d"], m["d"]))) <= 0.985:
                continue
            if abs(abs(w["offset"]) - abs(m["offset"])) > offset_tol:
                continue
            # Same line, but check the normals agree in sign — two opposite
            # walls of a narrow room are parallel and equidistant, and must not
            # be fused into one.
            if float(np.dot(w["normal"], m["normal"])) * w["offset"] * m["offset"] < 0:
                continue
            target = m
            break
        if target is None:
            merged.append(dict(w))
            continue
        seq = target["seq"] + w["seq"]
        c, d = _fit_line(seq)
        normal = np.array([-d[1], d[0]])
        xs = [p[0] for p in seq]
        ys = [p[1] for p in seq]
        target.update({
            "c": c, "d": d, "normal": normal,
            "offset": float(np.dot(c, normal)),
            "length": math.hypot(max(xs) - min(xs), max(ys) - min(ys)),
            "n": len(seq), "seq": seq,
            "bearing": math.degrees(math.atan2(c[0], -c[1])) % 360.0,
        })
    return merged


def _intersect(w1, w2):
    d1, d2 = w1["d"], w2["d"]
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 0.06:                    # too close to parallel to trust
        return None
    diff = w2["c"] - w1["c"]
    t = (diff[0] * d2[1] - diff[1] * d2[0]) / den
    p = w1["c"] + d1 * t
    return (float(p[0]), float(p[1]))


def douglas_peucker(points, epsilon, closed=False):
    pts = list(points)
    if closed and len(pts) > 2:
        pts = pts + [pts[0]]
    keep = _dp(pts, epsilon)
    if closed and len(keep) > 1 and keep[0] == keep[-1]:
        keep = keep[:-1]
    return keep


def _dp(pts, epsilon):
    if len(pts) < 3:
        return list(pts)
    start, end = pts[0], pts[-1]
    dx, dy = end[0] - start[0], end[1] - start[1]
    den = math.hypot(dx, dy)
    worst, index = 0.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        if den < 1e-9:
            d = math.hypot(px - start[0], py - start[1])
        else:
            d = abs(dy * px - dx * py + end[0] * start[1] - end[1] * start[0]) / den
        if d > worst:
            worst, index = d, i
    if worst <= epsilon:
        return [start, end]
    left = _dp(pts[:index + 1], epsilon)
    right = _dp(pts[index:], epsilon)
    return left[:-1] + right


def squarish(points, tol_deg=14.0, iterations=60):
    """Pull near-axis walls onto the dominant grid. Mirrors RS.Geom.squareUp."""
    n = len(points)
    if n < 3:
        return points

    # Length-weighted dominant orientation, modulo 90 degrees.
    best_ang, best_score = 0.0, -1.0
    for cand in np.arange(0.0, 90.0, 0.5):
        score = 0.0
        for i in range(n):
            a, b = points[i], points[(i + 1) % n]
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            if L < 0.05:
                continue
            ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) - cand
            dev = abs(((ang % 90.0) + 90.0) % 90.0)
            dev = min(dev, 90.0 - dev)
            score += L * max(0.0, 1.0 - dev / tol_deg)
        if score > best_score:
            best_ang, best_score = cand, score

    t = math.radians(-best_ang)
    c, s = math.cos(t), math.sin(t)
    work = [[p[0] * c - p[1] * s, p[0] * s + p[1] * c] for p in points]

    locked = []
    for i in range(n):
        a, b = work[i], work[(i + 1) % n]
        ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        nearest = round(ang / 90.0) * 90.0
        dev = abs(((ang - nearest) % 360.0 + 540.0) % 360.0 - 180.0)
        if dev <= tol_deg:
            locked.append("h" if abs(((nearest % 180) + 180) % 180) < 45 else "v")
        else:
            locked.append(None)

    for _ in range(iterations):
        for e in range(n):
            kind = locked[e]
            if not kind:
                continue
            a, b = work[e], work[(e + 1) % n]
            if kind == "h":
                m = (a[1] + b[1]) / 2.0
                a[1] = b[1] = m
            else:
                m = (a[0] + b[0]) / 2.0
                a[0] = b[0] = m

    t = math.radians(best_ang)
    c, s = math.cos(t), math.sin(t)
    return [(p[0] * c - p[1] * s, p[0] * s + p[1] * c) for p in work]


def openings_from_masks(masks, pose, fov_deg, width, height, kind_labels, op_type):
    """Doors and windows as bearing spans.

    Deliberately bearing only. The horizontal extent of a door is accurate
    regardless of how high up the frame it appears, whereas its distance is not
    — so the client places it by intersecting the bearing with the wall it has
    already measured.
    """
    mask = union(masks, kind_labels)
    if mask is None:
        return []

    tan_h = math.tan(math.radians(fov_deg) / 2.0)
    out = []
    cols = np.flatnonzero(mask.any(axis=0))
    if cols.size == 0:
        return []

    # Split into runs of adjacent columns: one run per opening.
    breaks = np.flatnonzero(np.diff(cols) > 12)
    groups = np.split(cols, breaks + 1)

    R = rotation_matrix(pose["alpha"], pose["beta"], pose["gamma"])
    Rs = screen_rotation(pose.get("screenAngle", 0.0))

    for g in groups:
        if g.size < max(8, width * 0.02):
            continue
        span = []
        for x in (int(g.min()), int(g.max())):
            nx = (x / float(width)) * 2.0 - 1.0
            d = np.array([nx * tan_h, 0.0, -1.0])
            dw = R @ Rs @ d
            span.append(math.degrees(math.atan2(dw[0], dw[1])) % 360.0)
        cover = float(mask[:, g].mean())
        out.append({
            "type": op_type,
            "bearing_from": round(span[0], 2),
            "bearing_to": round(span[1], 2),
            "confidence": round(min(0.7, 0.3 + cover), 3),
        })
    return out


def objects_from_masks(masks, pose, camera_height, fov_deg, width, height):
    """Furniture placed at its ground contact point — the bottom of its mask."""
    out = []
    for label, mask in masks.items():
        mapped = SEG_OBJECTS.get(label)
        if not mapped:
            continue
        ys, xs = np.nonzero(mask)
        if xs.size < (width * height) * 0.002:
            continue
        cx = float(np.median(xs))
        base = float(np.percentile(ys, 98))     # bottom edge, robust to specks
        xy, valid = floor_points(
            np.array([cx]), np.array([base]), width, height,
            pose, camera_height, fov_deg,
        )
        if not valid[0]:
            continue
        out.append({
            "type": mapped,
            "label": label,
            "x": round(float(xy[0, 0]), 3),
            "y": round(float(xy[0, 1]), 3),
            "confidence": round(min(0.5, 0.2 + xs.size / float(width * height)), 3),
        })
    return out


@spaces.GPU(duration=110)
def reconstruct(frames_json, camera_height=1.45, fov_deg=66.0):
    """N posed frames -> one finished room. This is the automatic path."""
    try:
        frames = json.loads(frames_json) if isinstance(frames_json, str) else frames_json
    except Exception as exc:
        return {"ok": False, "error": "Could not read the frames: %s" % exc}

    if not frames:
        return {"ok": False, "error": "No frames were sent."}

    camera_height = float(camera_height or 1.45)
    fov_deg = float(fov_deg or 66.0)

    seg = segmenter()
    assumed_drop = max(0.4, 2.4 - camera_height)   # a 2.4 m ceiling, refined below
    all_boundary = []
    all_ceiling = []
    openings, objects = [], []
    diagnostics = {"frames": len(frames), "used": 0, "no_floor": 0, "columns": 0}

    for fr in frames[:24]:                      # a sweep needs no more than this
        try:
            img = decode(fr.get("image"))
        except Exception:
            continue
        w, h = img.size
        pose = {
            "alpha": float(fr.get("alpha", 0.0)),
            "beta": float(fr.get("beta", 90.0)),
            "gamma": float(fr.get("gamma", 0.0)),
            "screenAngle": float(fr.get("screenAngle", 0.0)),
        }

        try:
            masks = masks_by_label(seg(img))
        except Exception:
            continue

        floor = union(masks, FLOOR_LABELS)
        wall = union(masks, WALL_LABELS)
        ceiling = union(masks, CEILING_LABELS)
        if ceiling is not None and ceiling.mean() > 0.005:
            cpts = wall_ceiling_points(ceiling, wall, pose, assumed_drop, fov_deg)
            if len(cpts):
                all_ceiling.append(cpts)
        if floor is None or floor.mean() < 0.01:
            diagnostics["no_floor"] += 1
            continue

        pts, _ = wall_floor_points(floor, wall, pose, camera_height, fov_deg)
        if len(pts):
            all_boundary.append(pts)
            diagnostics["columns"] += len(pts)
            diagnostics["used"] += 1

        openings += openings_from_masks(masks, pose, fov_deg, w, h, DOOR_LABELS, "door")
        openings += openings_from_masks(masks, pose, fov_deg, w, h, WINDOW_LABELS, "window")
        objects += objects_from_masks(masks, pose, camera_height, fov_deg, w, h)

    if not all_boundary:
        return {
            "ok": False,
            "error": "No floor could be found in any frame. Point the camera lower so the "
                     "bottom of the walls is in shot, and make sure the room is well lit.",
            "diagnostics": diagnostics,
        }

    cloud = np.concatenate(all_boundary, axis=0)
    floor_profile = polar_profile(cloud)

    # Prefer the ceiling junction wherever it exists: nothing stands in front of
    # the ceiling, so it measures walls that furniture hides at floor level.
    profile = floor_profile
    ceiling_profile = []
    if all_ceiling:
        ceiling_cloud = np.concatenate(all_ceiling, axis=0)
        raw_ceiling = polar_profile(ceiling_cloud)
        true_drop, k = solve_ceiling_drop(floor_profile, raw_ceiling, assumed_drop)
        diagnostics["ceiling_scale"] = k
        diagnostics["ceiling_height_m"] = round(camera_height + true_drop, 2)
        if k:
            ceiling_profile = [(a, r * k, n) for a, r, n in raw_ceiling]
            cmap = {round(a, 4): (r, n) for a, r, n in ceiling_profile}
            fmap = {round(a, 4): (r, n) for a, r, n in floor_profile}
            merged_profile = []
            for key in sorted(set(list(cmap.keys()) + list(fmap.keys()))):
                c = cmap.get(key)
                f = fmap.get(key)
                # Ceiling wins where both exist, and it is the only reading in
                # the directions that matter most — the ones with a sofa in them.
                use = c if c else f
                merged_profile.append((key, use[0], use[1]))
            profile = merged_profile

    diagnostics["floor_bins"] = len(floor_profile)
    diagnostics["ceiling_bins"] = len(ceiling_profile)
    diagnostics["profile_bins"] = len(profile)
    diagnostics["coverage_deg"] = round(len(profile) * 2.0, 1)

    # Wall fitting first, because it sees past furniture. Fall back to tracing
    # the profile only if too few walls could be fitted to close a room.
    polygon = fit_walls(profile)
    method = "wall-fit"
    if len(polygon) < 3:
        polygon = profile_to_polygon(profile)
        method = "traced"
    if len(polygon) < 3:
        return {
            "ok": False,
            "error": "The floor was found but its outline could not be resolved into walls. "
                     "Try turning more slowly, all the way round.",
            "diagnostics": diagnostics,
        }

    polygon = squarish(polygon)
    diagnostics["method"] = method

    # De-duplicate furniture: the same sofa appears in several frames.
    merged = []
    for o in sorted(objects, key=lambda z: -z["confidence"]):
        if any(o["type"] == m["type"] and math.hypot(o["x"] - m["x"], o["y"] - m["y"]) < 0.9
               for m in merged):
            continue
        merged.append(o)

    # And likewise for openings, which are bearing spans.
    merged_ops = []
    for o in sorted(openings, key=lambda z: -z["confidence"]):
        mid = ((o["bearing_from"] + o["bearing_to"]) / 2.0) % 360.0
        if any(abs(((mid - ((m["bearing_from"] + m["bearing_to"]) / 2.0)) % 360 + 540) % 360 - 180) < 8.0
               and o["type"] == m["type"] for m in merged_ops):
            continue
        merged_ops.append(o)

    area = 0.0
    for i in range(len(polygon)):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % len(polygon)]
        area += x1 * y2 - x2 * y1
    area = abs(area) / 2.0

    # Coverage is the honest confidence signal: a sweep that only saw 200
    # degrees cannot have found the whole room, whatever the polygon looks like.
    coverage = min(1.0, (len(profile) * 2.0) / 360.0)

    return {
        "ok": True,
        "points": [[round(float(x), 3), round(float(y), 3)] for x, y in polygon],
        "openings": merged_ops[:12],
        "objects": merged[:20],
        "area_sqm": round(area, 2),
        "coverage": round(coverage, 3),
        "confidence": round(min(0.75, coverage * 0.8), 3),
        "diagnostics": diagnostics,
        "note": "Automatic reconstruction from segmented floor boundary and recorded "
                "camera poses. Scale depends on the camera height supplied; correct it "
                "against one measured wall.",
    }


@spaces.GPU(duration=60)
def detect(image_data_url, fov_deg=66.0):
    """One frame in, object suggestions out. Unchanged contract."""
    try:
        img = decode(image_data_url)
    except Exception as exc:
        return {"objects": [], "depth_available": False, "note": "bad image: %s" % exc}

    w, h = img.size
    results = detector()(img)

    depth_map = None
    dp = depther()
    if dp:
        try:
            depth_map = np.array(dp(img)["depth"], dtype=np.float32)
        except Exception:
            depth_map = None

    objects = []
    half = math.tan(math.radians(fov_deg) / 2.0)
    for r in results:
        if r["score"] < MIN_SCORE:
            continue
        mapped = COCO_OBJECTS.get(r["label"])
        if not mapped:
            continue
        box = r["box"]
        cx = (box["xmin"] + box["xmax"]) / 2.0
        nx = (cx / w) * 2.0 - 1.0
        rel_depth = None
        if depth_map is not None:
            y0 = int(np.clip(box["ymax"] - 4, 0, depth_map.shape[0] - 1))
            x0 = int(np.clip(cx, 0, depth_map.shape[1] - 1))
            patch = depth_map[max(0, y0 - 3):y0 + 4, max(0, x0 - 3):x0 + 4]
            if patch.size:
                rel_depth = float(np.median(patch))
        objects.append({
            "type": mapped,
            "label": r["label"],
            "confidence": round(float(r["score"]), 3),
            "bearing_deg": round(math.degrees(math.atan(nx * half)), 2),
            "ground_v": round(float(box["ymax"]) / h, 4),
            "relative_depth": rel_depth,
            "box": {k: round(float(v), 1) for k, v in box.items()},
        })

    objects.sort(key=lambda o: -o["confidence"])
    return {
        "objects": objects[:24],
        "depth_available": depth_map is not None,
        "image_size": [w, h],
    }


with gr.Blocks(title="Room Scanner — reconstruction") as demo:
    gr.Markdown(
        "## Room Scanner\n"
        "**reconstruct** — posed frames from a sweep become a finished room, "
        "automatically. **detect** — one frame becomes object suggestions.\n\n"
        "The camera pose arrives with every frame, so no structure-from-motion "
        "is needed: segmentation finds the wall-floor line and trigonometry "
        "does the measuring."
    )
    with gr.Tab("Reconstruct"):
        frames_in = gr.Textbox(
            label='Frames JSON — [{"image": "data:image/jpeg;base64,...", '
                  '"alpha": 0, "beta": 90, "gamma": 0, "screenAngle": 0}]',
            lines=4,
        )
        with gr.Row():
            h_in = gr.Number(label="Camera height (m)", value=1.45)
            fov_in = gr.Number(label="Horizontal FOV (deg)", value=66.0)
        room_out = gr.JSON(label="Room")
        gr.Button("Reconstruct", variant="primary").click(
            reconstruct, inputs=[frames_in, h_in, fov_in],
            outputs=room_out, api_name="reconstruct",
        )
    with gr.Tab("Detect"):
        img_in = gr.Textbox(label="Image data URL", lines=3)
        fov2 = gr.Number(label="Horizontal FOV (deg)", value=66.0)
        det_out = gr.JSON(label="Detections")
        gr.Button("Detect").click(
            detect, inputs=[img_in, fov2], outputs=det_out, api_name="detect",
        )

if __name__ == "__main__":
    demo.queue(max_size=4).launch()
