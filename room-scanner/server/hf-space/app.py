"""
Optional Tier 1 compute — monocular depth + object detection on ONE frame.

Deploy this as a free Hugging Face Space (CPU basic, 2 vCPU / 16 GB). It is
never required: the app measures rooms without it. Its job is to turn a single
photograph into *suggestions* the surveyor confirms, so the tapping gets
shorter — not to become a second, competing source of geometry.

Contract with the browser client (js/ai/provider.js):

    POST {space}/gradio_api/call/detect   {"data": ["data:image/jpeg;base64,..."]}
    -> {"objects": [ {type, confidence, bearing_deg, ground_v, box} ... ],
        "depth_available": bool,
        "note": str}

The Space deliberately returns BEARINGS and image-space ground contact points,
not room coordinates. Only the browser knows the camera pose and height, so only
the browser can turn a detection into a floor position. Keeping that boundary
means a wrong model can misname a sofa but can never move a wall.
"""

import base64
import io
import json
import re

import gradio as gr
import spaces
import numpy as np
from PIL import Image

# --------------------------------------------------------------------------
# Models. Both are small enough for the free CPU tier; first call pays the
# download and warm-up cost, so the client is told to expect a slow first hit.
# --------------------------------------------------------------------------
from transformers import pipeline

DETECTOR_ID = "hustvl/yolos-small"
DEPTH_ID = "depth-anything/Depth-Anything-V2-Small-hf"

_detector = None
_depther = None


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
            _depther = False          # depth is optional; detection still works
    return _depther


# --------------------------------------------------------------------------
# COCO label -> the app's object catalogue (js/core/schema.js OBJECTS).
# Anything not in this map is dropped: an unknown label is worse than silence,
# because the surveyor has to read and reject it.
# --------------------------------------------------------------------------
LABEL_MAP = {
    "bed": "bed_double",
    "couch": "sofa_3",
    "chair": "chair",
    "dining table": "dining_table",
    "tv": "tv",
    "toilet": "toilet",
    "sink": "basin",
    "refrigerator": "fridge",
    "oven": "oven",
    "microwave": "cabinet",
    "book": "bookshelf",
    "potted plant": "plant",
    "vase": "plant",
    "clock": None,
    "person": None,
}

MIN_SCORE = 0.45


def decode(data_url: str) -> Image.Image:
    if not isinstance(data_url, str):
        raise ValueError("expected a data URL")
    payload = re.sub(r"^data:image/[a-zA-Z]+;base64,", "", data_url)
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


@spaces.GPU
def detect(image_data_url, fov_deg=66.0):
    """One frame in, structured suggestions out."""
    try:
        img = decode(image_data_url)
    except Exception as exc:
        return {"objects": [], "depth_available": False, "note": f"bad image: {exc}"}

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
    for r in results:
        if r["score"] < MIN_SCORE:
            continue
        mapped = LABEL_MAP.get(r["label"])
        if not mapped:
            continue

        box = r["box"]
        cx = (box["xmin"] + box["xmax"]) / 2.0
        # The GROUND CONTACT point: the bottom edge of the box is where the
        # object meets the floor, which is the only part of a detection that
        # can be turned into a floor position.
        ground_v = box["ymax"]

        # Horizontal bearing off the optical axis, from the pinhole model.
        # The client re-derives this from its own field of view if it disagrees.
        half = np.tan(np.radians(fov_deg) / 2.0)
        nx = (cx / w) * 2.0 - 1.0
        bearing = float(np.degrees(np.arctan(nx * half)))

        rel_depth = None
        if depth_map is not None:
            y0 = int(max(0, min(depth_map.shape[0] - 1, ground_v - 4)))
            x0 = int(max(0, min(depth_map.shape[1] - 1, cx)))
            patch = depth_map[max(0, y0 - 3):y0 + 4, max(0, x0 - 3):x0 + 4]
            if patch.size:
                rel_depth = float(np.median(patch))

        objects.append({
            "type": mapped,
            "label": r["label"],
            "confidence": round(float(r["score"]), 3),
            "bearing_deg": round(bearing, 2),
            "ground_v": round(float(ground_v) / h, 4),   # normalised 0..1
            "relative_depth": rel_depth,
            "box": {k: round(float(v), 1) for k, v in box.items()},
        })

    objects.sort(key=lambda o: -o["confidence"])
    return {
        "objects": objects[:24],
        "depth_available": depth_map is not None,
        "image_size": [w, h],
        "note": "Bearings and ground-contact points only. The client converts "
                "these to room coordinates using its own camera pose.",
    }


@spaces.GPU
def depth_png(image_data_url):
    """Debug view: the raw relative depth map, for eyeballing a scan."""
    dp = depther()
    if not dp:
        return None
    img = decode(image_data_url)
    d = np.array(dp(img)["depth"], dtype=np.float32)
    d = (d - d.min()) / (d.ptp() + 1e-6)
    return Image.fromarray((d * 255).astype(np.uint8))


with gr.Blocks(title="Room Scanner — assist") as demo:
    gr.Markdown(
        "## Room Scanner — optional detection assist\n"
        "Single frame in, object suggestions out. This service never returns "
        "room geometry: the browser owns the camera pose, so the browser owns "
        "the measurements."
    )
    with gr.Row():
        inp = gr.Textbox(label="Image data URL", lines=3)
        fov = gr.Number(label="Horizontal FOV (deg)", value=66.0)
    out = gr.JSON(label="Detections")
    gr.Button("Detect").click(detect, inputs=[inp, fov], outputs=out, api_name="detect")

    dbg_out = gr.Image(label="Relative depth")
    gr.Button("Depth map").click(depth_png, inputs=[inp], outputs=dbg_out, api_name="depth")

if __name__ == "__main__":
    demo.queue(max_size=8).launch()