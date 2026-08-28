"""
Render.com alternative to the Hugging Face Space.

Same job, same contract, different host. Use this if you want a private
endpoint rather than a public Space, or if you would rather pay Render for an
always-warm instance later than fight a free Space's cold starts.

    POST /detect   { "image": "data:image/jpeg;base64,...", "fov_deg": 66 }
    GET  /health

Deploy:
    Build command:  pip install -r requirements.txt
    Start command:  uvicorn main:app --host 0.0.0.0 --port $PORT

Free-tier warning, stated plainly: Render's free web services sleep after 15
minutes of inactivity and get 512 MB of RAM. Torch plus two vision models will
NOT fit in 512 MB. On the free tier run this with DETECTION_ONLY=1, which drops
depth estimation and keeps the footprint under the cap; otherwise use the
Hugging Face Space, which gets 16 GB for free.
"""

import base64
import io
import os
import re

import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

DETECTION_ONLY = os.environ.get("DETECTION_ONLY", "0") == "1"
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")

app = FastAPI(title="Room Scanner assist")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

_detector = None
_depther = None


def detector():
    global _detector
    if _detector is None:
        from transformers import pipeline
        _detector = pipeline("object-detection", model="hustvl/yolos-small")
    return _detector


def depther():
    global _depther
    if DETECTION_ONLY:
        return None
    if _depther is None:
        from transformers import pipeline
        try:
            _depther = pipeline(
                "depth-estimation",
                model="depth-anything/Depth-Anything-V2-Small-hf",
            )
        except Exception:
            _depther = False
    return _depther or None


LABEL_MAP = {
    "bed": "bed_double", "couch": "sofa_3", "chair": "chair",
    "dining table": "dining_table", "tv": "tv", "toilet": "toilet",
    "sink": "basin", "refrigerator": "fridge", "oven": "oven",
    "microwave": "cabinet", "book": "bookshelf", "potted plant": "plant",
}
MIN_SCORE = 0.45
MAX_PIXELS = 1600 * 1600


class DetectRequest(BaseModel):
    image: str
    fov_deg: float = 66.0


@app.get("/health")
def health():
    return {"ok": True, "depth": not DETECTION_ONLY}


@app.post("/detect")
def detect(req: DetectRequest):
    try:
        payload = re.sub(r"^data:image/[a-zA-Z]+;base64,", "", req.image)
        img = Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")
    except Exception as exc:
        return {"objects": [], "depth_available": False, "note": f"bad image: {exc}"}

    if img.width * img.height > MAX_PIXELS:
        return {"objects": [], "depth_available": False, "note": "image too large"}

    w, h = img.size
    results = detector()(img)

    depth_map = None
    dp = depther()
    if dp is not None:
        try:
            depth_map = np.array(dp(img)["depth"], dtype=np.float32)
        except Exception:
            depth_map = None

    objects = []
    half = np.tan(np.radians(req.fov_deg) / 2.0)
    for r in results:
        if r["score"] < MIN_SCORE:
            continue
        mapped = LABEL_MAP.get(r["label"])
        if not mapped:
            continue
        box = r["box"]
        cx = (box["xmin"] + box["xmax"]) / 2.0
        ground_v = box["ymax"]
        nx = (cx / w) * 2.0 - 1.0

        rel_depth = None
        if depth_map is not None:
            y0 = int(np.clip(ground_v - 4, 0, depth_map.shape[0] - 1))
            x0 = int(np.clip(cx, 0, depth_map.shape[1] - 1))
            patch = depth_map[max(0, y0 - 3):y0 + 4, max(0, x0 - 3):x0 + 4]
            if patch.size:
                rel_depth = float(np.median(patch))

        objects.append({
            "type": mapped,
            "label": r["label"],
            "confidence": round(float(r["score"]), 3),
            "bearing_deg": round(float(np.degrees(np.arctan(nx * half))), 2),
            "ground_v": round(float(ground_v) / h, 4),
            "relative_depth": rel_depth,
            "box": {k: round(float(v), 1) for k, v in box.items()},
        })

    objects.sort(key=lambda o: -o["confidence"])
    return {
        "objects": objects[:24],
        "depth_available": depth_map is not None,
        "image_size": [w, h],
    }
