/* ---------------------------------------------------------------------------
   OPTIONAL AI LAYER (brief §6, §19, §38)

   Two independent, optional tiers:

     Tier 1  a Hugging Face Space (or a Render service) doing the heavy CV —
             monocular depth and object detection on a single frame.
     Tier 2  a language model doing interpretation and presentation only:
             room classification, labels, style configuration, plain-English
             review of the plan.

   Hard rules enforced here, not just documented:
     • No response may set a coordinate, a length, a wall position or an area.
       applyStyle() has an allow-list; applyReview() produces advisory text
       only; applyDetections() creates objects at LOW confidence so they are
       flagged for confirmation.
     • Nothing is sent anywhere unless the user has switched a provider on and
       consented. Tier 2 receives numbers and labels — never a photograph.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.AI = (function () {
  'use strict';

  var S = RS.Schema, Store = RS.Store;

  var MODELS = {
    claude: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (recommended)' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cheapest)' }
    ],
    gemini: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }
    ]
  };

  function settings() { return Store.getSettings(); }
  function enabled() {
    var s = settings();
    return s.aiProvider !== 'none' && !!s.aiKey && !!s.consentAI;
  }
  function spaceEnabled() { return !!settings().spaceUrl; }

  /* -- What the model is allowed to see ------------------------------------
     A compact numeric description. No image, no address, no filenames. */
  function summarise(room) {
    var walls = [];
    for (var i = 0; i < room.points.length; i++) {
      walls.push({
        index: i,
        length_m: +S.wallLength(room, i).toFixed(2),
        openings: room.openings.filter(function (o) { return o.wallIndex === i; })
          .map(function (o) { return { type: o.type, width_m: +o.width.toFixed(2) }; })
      });
    }
    var b = S.bounds(room);
    return {
      name: room.name,
      declared_type: room.type,
      area_sqm: +S.roomArea(room).toFixed(2),
      bounding_box_m: { width: +b.w.toFixed(2), depth: +b.h.toFixed(2) },
      ceiling_height_m: room.ceilingHeight,
      corner_count: room.points.length,
      walls: walls,
      objects: room.objects.map(function (o) {
        return {
          type: o.type,
          size_m: [+o.w.toFixed(2), +o.d.toFixed(2)],
          confidence: +o.confidence.toFixed(2)
        };
      }),
      capture_method: room.capture.method,
      scale_corrected: room.capture.scaleCorrected
    };
  }

  /* -- Task definitions ------------------------------------------------------
     Each is a tool schema; both providers are steered to return exactly this
     shape, so parsing is the same either way. */
  var TASKS = {
    classify: {
      name: 'classify_room',
      description: 'Classify a surveyed room and give it a sensible plan label.',
      instruction:
        'You are labelling a measured floor plan. Using only the geometry and the ' +
        'detected items, classify the room and propose a short label as it would ' +
        'appear on an architectural drawing. Do not invent objects. Do not comment ' +
        'on dimensions you were not given.',
      schema: {
        type: 'object',
        properties: {
          room_type: { type: 'string', enum: S.ROOM_TYPES.map(function (t) { return t.id; }) },
          label: { type: 'string', description: 'Short plan label, e.g. "Bedroom 2" or "En suite".' },
          confidence: { type: 'number', description: '0 to 1.' },
          reasoning: { type: 'string', description: 'One sentence.' }
        },
        required: ['room_type', 'label', 'confidence', 'reasoning']
      }
    },

    review: {
      name: 'review_plan',
      description: 'Review a surveyed room for things that look wrong or missing.',
      instruction:
        'You are checking a measured floor plan for plausibility. Flag anything that ' +
        'looks physically implausible or obviously missing — a bathroom with no door, ' +
        'a bedroom too small for the bed shown, a wall length inconsistent with the ' +
        'rest. You must NOT propose corrected measurements: the geometry is measured ' +
        'and you are not. Say what looks wrong and what the surveyor should re-check.',
      schema: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: ['info', 'warn', 'error'] },
                text: { type: 'string', description: 'One sentence, plain English.' },
                recheck: { type: 'string', description: 'What to physically re-check, if anything.' }
              },
              required: ['severity', 'text']
            }
          },
          summary: { type: 'string' }
        },
        required: ['findings', 'summary']
      }
    },

    style: {
      name: 'presentation_config',
      description: 'Choose presentation settings for the plan. Presentation only.',
      instruction:
        'You are configuring how a measured floor plan is PRESENTED. You are changing ' +
        'appearance only — you cannot move, resize or relabel any measured geometry. ' +
        'Pick the style and toggles that suit the stated audience.',
      schema: {
        type: 'object',
        properties: {
          style: { type: 'string', enum: ['technical', 'presentation', 'plan25'] },
          showDimensions: { type: 'boolean' },
          showAreas: { type: 'boolean' },
          showLabels: { type: 'boolean' },
          showFurniture: { type: 'boolean' },
          showNorth: { type: 'boolean' },
          showGrid: { type: 'boolean' },
          dimensionUnits: { type: 'string', enum: ['m', 'mm', 'ftin'] },
          rationale: { type: 'string' }
        },
        required: ['style', 'rationale']
      }
    }
  };

  /* -- Provider calls --------------------------------------------------------- */

  function run(taskId, payload, extra) {
    var task = TASKS[taskId];
    if (!task) return Promise.reject(new Error('Unknown task: ' + taskId));
    if (!enabled()) return Promise.reject(new Error('No AI provider is switched on.'));
    var s = settings();
    var body = JSON.stringify(payload);
    var userText = (extra ? extra + '\n\n' : '') + 'Room data (JSON):\n' + body;
    return (s.aiProvider === 'gemini' ? callGemini : callClaude)(task, userText, s);
  }

  function callClaude(task, userText, s) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.aiKey,
        'anthropic-version': '2023-06-01',
        /* Required for calls made straight from a browser page. */
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: s.aiModel || 'claude-sonnet-5',
        max_tokens: 1200,
        system: task.instruction,
        tools: [{
          name: task.name,
          description: task.description,
          input_schema: task.schema
        }],
        /* Forcing the tool is what turns free text into a parsed object. */
        tool_choice: { type: 'tool', name: task.name },
        messages: [{ role: 'user', content: userText }]
      })
    }).then(readJson).then(function (data) {
      var block = (data.content || []).filter(function (c) { return c.type === 'tool_use'; })[0];
      if (!block) throw new Error('The model returned no structured result.');
      return block.input;
    });
  }

  function callGemini(task, userText, s) {
    var model = s.aiModel && s.aiModel.indexOf('gemini') === 0 ? s.aiModel : 'gemini-2.5-flash';
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(s.aiKey);
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: task.instruction }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(task.schema),
          temperature: 0.2
        }
      })
    }).then(readJson).then(function (data) {
      var txt = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
        .map(function (p) { return p.text || ''; }).join('');
      if (!txt) throw new Error('The model returned no structured result.');
      return JSON.parse(txt);
    });
  }

  /* Gemini's schema dialect does not accept every JSON Schema keyword. */
  function toGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    var out = {};
    Object.keys(schema).forEach(function (k) {
      if (k === 'additionalProperties') return;
      if (k === 'type') { out.type = String(schema.type).toUpperCase(); return; }
      if (k === 'properties') {
        out.properties = {};
        Object.keys(schema.properties).forEach(function (p) {
          out.properties[p] = toGeminiSchema(schema.properties[p]);
        });
        return;
      }
      if (k === 'items') { out.items = toGeminiSchema(schema.items); return; }
      out[k] = schema[k];
    });
    return out;
  }

  function readJson(res) {
    return res.text().then(function (t) {
      var data;
      try { data = JSON.parse(t); } catch (e) { data = null; }
      if (!res.ok) {
        var msg = (data && (data.error && (data.error.message || data.error.type))) || res.statusText;
        if (res.status === 401 || res.status === 403) msg = 'The API key was rejected.';
        if (res.status === 429) msg = 'Rate limited by the provider — try again shortly.';
        throw new Error(msg || ('Request failed (' + res.status + ')'));
      }
      if (!data) throw new Error('The provider returned an unreadable response.');
      return data;
    });
  }

  /* -- Applying results — the only route back into the model ----------------- */

  function applyClassification(room, result) {
    var valid = S.ROOM_TYPES.some(function (t) { return t.id === result.room_type; });
    if (!valid) throw new Error('The model returned an unknown room type.');
    Store.do('AI: label room', function () {
      room.type = result.room_type;
      if (typeof result.label === 'string' && result.label.trim()) {
        room.name = result.label.trim().slice(0, 40);
      }
    });
  }

  /* Allow-list. Anything outside it is discarded, so a hallucinated
     "wall_length": 4.2 in the response can never reach the geometry. */
  var STYLE_KEYS = ['style', 'showDimensions', 'showAreas', 'showLabels',
                    'showFurniture', 'showNorth', 'showGrid', 'dimensionUnits'];

  function applyStyle(project, result) {
    Store.do('AI: presentation', function (p) {
      STYLE_KEYS.forEach(function (k) {
        if (result[k] === undefined) return;
        if (k === 'style' && !RS.Plan.STYLES[result[k]]) return;
        if (k === 'dimensionUnits' && ['m', 'mm', 'ftin'].indexOf(result[k]) < 0) return;
        p.presentation[k] = result[k];
      });
    });
    void project;
  }

  /* -- Tier 1: heavy CV on a free Space -------------------------------------- */

  /* Grab a downscaled frame. Downscaling is not only for speed — it is the
     privacy floor: 768 px is plenty for detection and useless for recognising
     the people who live there. */
  function frameFromVideo(video, maxDim) {
    maxDim = maxDim || 768;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error('No camera frame is available.');
    var scale = Math.min(1, maxDim / Math.max(vw, vh));
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  /* Gradio 4/5 queue protocol: POST returns an event id, GET streams results. */
  function callSpace(fnName, data) {
    var base = String(settings().spaceUrl || '').replace(/\/+$/, '');
    if (!base) return Promise.reject(new Error('No Space URL is configured.'));
    var url = base + '/gradio_api/call/' + fnName;
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: data })
    }).then(function (r) {
      if (!r.ok) throw new Error('The Space rejected the request (' + r.status + '). It may be asleep — open it once in a tab to wake it.');
      return r.json();
    }).then(function (j) {
      var id = j.event_id || j.hash;
      if (!id) throw new Error('The Space returned no event id.');
      return fetch(url + '/' + id);
    }).then(function (r) { return r.text(); })
      .then(function (text) {
        /* The stream is server-sent events; the last complete data line wins. */
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
  }

  function detectObjects(dataUrl, fovDeg) {
    return callSpace('detect', [dataUrl, fovDeg || 66]).then(function (res) {
      if (!res || !Array.isArray(res.objects)) throw new Error('Unexpected response from the Space.');
      return res;
    });
  }

  /* The Space returns image-space boxes, because it cannot know where the
     camera was. Turning one into a floor position is done HERE, with the pose
     captured at the moment the frame was grabbed, through exactly the same
     ray-cast the user's own taps go through. A detection is therefore never a
     second way of measuring — it is a simulated tap. */
  function detectionsToPlacements(result, orient, opts) {
    var size = result.image_size || [opts.elemWidth, opts.elemHeight];
    var sx = opts.elemWidth / Math.max(1, size[0]);
    var sy = opts.elemHeight / Math.max(1, size[1]);
    var out = [];
    (result.objects || []).forEach(function (d) {
      if (!S.OBJECTS[d.type] || !d.box) return;
      /* Bottom-centre of the box is where the item meets the floor. */
      var tap = {
        x: ((d.box.xmin + d.box.xmax) / 2) * sx,
        y: d.box.ymax * sy
      };
      var p = RS.Raycast.floorPoint(tap, orient, opts);
      if (!p) return;
      out.push({
        type: d.type,
        x: p.x,
        y: p.y,
        /* Detector confidence and geometric confidence are different things;
           the item is only as trustworthy as the weaker of the two. */
        confidence: Math.min(0.5, (Number(d.confidence) || 0.3) * p.confidence)
      });
    });
    return out;
  }

  /* Placed at LOW confidence deliberately, so the renderer flags every one of
     them and the checks panel asks the user to confirm or delete (brief §14). */
  function applyDetections(room, placements, station) {
    var added = 0;
    Store.do('AI: add detected items', function () {
      placements.forEach(function (d) {
        if (!S.OBJECTS[d.type]) return;
        if (!isFinite(d.x) || !isFinite(d.y)) return;
        var ob = S.newObject(d.type, d.x + (station ? station.x : 0), d.y + (station ? station.y : 0), 0);
        ob.confidence = Math.max(0.15, Math.min(0.5, d.confidence || 0.3));
        var snap = RS.Geom.snapObjectToWall(room, ob, 0.7);
        if (snap) { ob.x = snap.x; ob.y = snap.y; ob.rot = snap.rot; }
        room.objects.push(ob);
        added += 1;
      });
    });
    return added;
  }

  function testConnection() {
    if (!enabled()) return Promise.reject(new Error('Switch a provider on and enter a key first.'));
    return run('classify', {
      name: 'Test', declared_type: 'other', area_sqm: 12.5,
      bounding_box_m: { width: 5, depth: 2.5 }, ceiling_height_m: 2.4, corner_count: 4,
      walls: [{ index: 0, length_m: 5, openings: [{ type: 'door', width_m: 0.81 }] }],
      objects: [{ type: 'bed_double', size_m: [1.35, 1.9], confidence: 1 }],
      capture_method: 'station', scale_corrected: true
    });
  }

  return {
    MODELS: MODELS, TASKS: TASKS,
    enabled: enabled, spaceEnabled: spaceEnabled,
    summarise: summarise, run: run,
    applyClassification: applyClassification, applyStyle: applyStyle,
    frameFromVideo: frameFromVideo, callSpace: callSpace,
    detectObjects: detectObjects, detectionsToPlacements: detectionsToPlacements,
    applyDetections: applyDetections,
    testConnection: testConnection
  };
})();
