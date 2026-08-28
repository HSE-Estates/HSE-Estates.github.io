---
title: Room Scanner Assist
emoji: 📐
colorFrom: green
colorTo: gray
sdk: gradio
sdk_version: 5.9.1
app_file: app.py
pinned: false
---

# Optional detection assist

This Space is **not required**. The Room Scanner app measures rooms entirely in
the browser. This service only shortens the tapping by suggesting furniture from
a single frame, which the surveyor then confirms or deletes.

## Deploy it (free tier)

1. Create a new Space at <https://huggingface.co/new-space> — SDK **Gradio**,
   hardware **CPU basic (free)** or **ZeroGPU** (see below).
2. Upload `app.py` and `requirements.txt` from this folder, or push them with git:

```bash
git clone https://huggingface.co/spaces/<you>/room-scanner-assist
cp app.py requirements.txt room-scanner-assist/
cd room-scanner-assist && git add . && git commit -m "assist service" && git push
```

3. Wait for the build. The first request downloads the two models — expect
   40–90 seconds for that one call, then a few seconds each afterwards.
4. In the app: **Settings → Optional heavy processing**, paste
   `https://<you>-room-scanner-assist.hf.space`.

## What it returns

```json
{
  "objects": [
    { "type": "bed_double", "confidence": 0.91,
      "bearing_deg": -12.4, "ground_v": 0.78, "relative_depth": 0.42,
      "box": { "xmin": 120.0, "ymin": 220.0, "xmax": 480.0, "ymax": 610.0 } }
  ],
  "depth_available": true,
  "image_size": [768, 1024]
}
```

Note what is **not** in there: no room coordinates, no wall positions, no
lengths. The Space sees one photograph and has no idea where the camera was or
how high it was held. Only the browser knows that, so only the browser converts a
bearing plus a ground-contact point into a floor position. That boundary is the
reason a wrong detection can mislabel a sofa but can never move a wall.

## CPU basic or ZeroGPU

`app.py` as shipped runs on **CPU basic**. To run it on **ZeroGPU** instead —
much faster, and free with quota — two changes are needed, and both are already
applied in the deployed copy:

```python
import spaces

@spaces.GPU
def detect(image_data_url, fov_deg=66.0):
    ...
```

Watch for these:

- `import spaces` **only resolves on ZeroGPU hardware**. On CPU basic the Space
  crashes on startup with `ModuleNotFoundError: No module named 'spaces'`. The
  decorator and the import have to come out again if you move it back to CPU.
- The decorated function must be called from the request path, not at import
  time, or the GPU is allocated for the whole session.
- Model loading still happens on first call, so the first request after a sleep
  is slow either way.

A measured round trip against a live ZeroGPU deployment of this file:
**5.8 seconds warm**, depth included.

## Free-tier realities

- Free CPU Spaces **sleep after ~48 h idle**. The first call after a sleep wakes
  it and can take a minute. The client says so rather than hanging silently.
- There is no GPU. Depth Anything V2 Small runs in roughly 2–4 s per 768 px
  frame on 2 vCPU; YOLOS-small in about 1–2 s. Do not send video.
- Free Spaces are public by default. Only ever send a frame you are content to
  have processed on someone else's hardware — which is why the client downscales
  to 768 px and sends one frame, not a stream.

## Swapping the models

`DETECTOR_ID` and `DEPTH_ID` at the top of `app.py` are the only coupling. A
GPU Space can take `IDEA-Research/grounding-dino-base` for open-vocabulary
detection, which handles wardrobes, radiators and shower trays that COCO has no
class for. Keep the return contract identical and the client needs no change.
