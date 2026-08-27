/* ---------------------------------------------------------------------------
   Application state, undo/redo and persistence.

   Every change to Layer A goes through do() / begin() + end(), which is what
   makes AI-applied changes indistinguishable from — and as reversible as —
   a user's own edits.

   Persistence is localStorage only. Nothing leaves the device unless the user
   explicitly triggers an export or an optional AI call.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Store = (function () {
  'use strict';

  var KEY_INDEX = 'rs.projects.index';
  var KEY_PROJECT = 'rs.project.';
  var KEY_SETTINGS = 'rs.settings';
  var MAX_UNDO = 80;

  var listeners = [];
  var undoStack = [];
  var redoStack = [];
  var pending = null;          // snapshot captured by begin()

  var state = {
    project: null,
    activeRoomId: null,
    selection: null,           // { kind: 'point'|'wall'|'opening'|'object', index?, id? }
    tool: 'select',
    view: { showIssues: true, snap: true, grid: 0, showFloor: true },
    dirty: false
  };

  var settings = {
    aiProvider: 'none',        // none | claude | gemini
    aiKey: '',
    spaceUrl: '',
    cameraHeight: 1.45,
    fovDeg: 66,
    autoSquare: true,
    consentAI: false,
    /* Sheet branding. The app ships no organisation's mark — the user supplies
       one they are entitled to use, and it never leaves this device except
       inside a PDF they export themselves. */
    orgName: '',
    logoDataUrl: ''
  };

  /* -- events ------------------------------------------------------------- */
  function subscribe(fn) { listeners.push(fn); return function () { off(fn); }; }
  function off(fn) { listeners = listeners.filter(function (f) { return f !== fn; }); }
  function emit(reason) { listeners.forEach(function (f) { try { f(state, reason); } catch (e) { console.error(e); } }); }

  /* -- mutation ----------------------------------------------------------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function begin() {
    if (pending) return;
    pending = clone(state.project);
  }

  function end(label) {
    if (!pending) return;
    var before = pending;
    pending = null;
    if (JSON.stringify(before) === JSON.stringify(state.project)) return;
    undoStack.push({ label: label || 'Edit', project: before });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    touch();
  }

  function cancel() { if (pending) { state.project = pending; pending = null; emit('cancel'); } }

  /* The workhorse: do('Move corner', function (project) { ... }) */
  function doAction(label, fn) {
    begin();
    try { fn(state.project); } catch (e) { console.error(e); cancel(); throw e; }
    end(label);
    emit('change');
  }

  function undo() {
    if (!undoStack.length) return false;
    var entry = undoStack.pop();
    redoStack.push({ label: entry.label, project: clone(state.project) });
    state.project = entry.project;
    state.selection = null;
    touch();
    emit('undo');
    return entry.label;
  }

  function redo() {
    if (!redoStack.length) return false;
    var entry = redoStack.pop();
    undoStack.push({ label: entry.label, project: clone(state.project) });
    state.project = entry.project;
    state.selection = null;
    touch();
    emit('redo');
    return entry.label;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }
  function undoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : null; }

  function touch() {
    if (state.project) state.project.updatedAt = Date.now();
    state.dirty = true;
    scheduleSave();
  }

  /* -- selection and tools ------------------------------------------------ */
  function select(sel) { state.selection = sel; emit('select'); }
  function setTool(t) { state.tool = t; state.selection = null; emit('tool'); }
  function activeRoom() {
    if (!state.project) return null;
    var r = state.project.rooms.filter(function (x) { return x.id === state.activeRoomId; })[0];
    return r || state.project.rooms[0] || null;
  }
  function setActiveRoom(id) { state.activeRoomId = id; state.selection = null; emit('room'); }

  /* -- persistence -------------------------------------------------------- */
  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  function save() {
    if (!state.project) return;
    try {
      localStorage.setItem(KEY_PROJECT + state.project.id, JSON.stringify(state.project));
      var idx = listProjects().filter(function (p) { return p.id !== state.project.id; });
      idx.unshift({
        id: state.project.id,
        name: state.project.name,
        updatedAt: state.project.updatedAt,
        rooms: state.project.rooms.length
      });
      localStorage.setItem(KEY_INDEX, JSON.stringify(idx));
      state.dirty = false;
      emit('saved');
    } catch (e) {
      console.error('Save failed', e);
      emit('save-failed');
    }
  }

  function listProjects() {
    try { return JSON.parse(localStorage.getItem(KEY_INDEX) || '[]'); }
    catch (e) { return []; }
  }

  function loadProject(id) {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY_PROJECT + id));
      if (!raw) return false;
      setProject(RS.Schema.coerceProject(raw));
      return true;
    } catch (e) { console.error(e); return false; }
  }

  function readProject(id) {
    try { return JSON.parse(localStorage.getItem(KEY_PROJECT + id)); }
    catch (e) { return null; }
  }

  function deleteProject(id) {
    localStorage.removeItem(KEY_PROJECT + id);
    localStorage.setItem(KEY_INDEX, JSON.stringify(
      listProjects().filter(function (p) { return p.id !== id; })
    ));
    emit('projects');
  }

  function setProject(p) {
    state.project = p;
    state.activeRoomId = p.rooms.length ? p.rooms[0].id : null;
    state.selection = null;
    undoStack.length = 0;
    redoStack.length = 0;
    pending = null;
    emit('project');
  }

  function createProject(name) {
    var p = RS.Schema.newProject(name);
    var room = RS.Schema.newRoom('Room 1');
    p.rooms.push(room);
    setProject(p);
    save();
    return p;
  }

  /* -- settings ----------------------------------------------------------- */
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}');
      Object.keys(settings).forEach(function (k) {
        if (s[k] !== undefined) settings[k] = s[k];
      });
    } catch (e) { /* defaults stand */ }
    return settings;
  }

  function saveSettings(patch) {
    Object.keys(patch || {}).forEach(function (k) {
      if (k in settings) settings[k] = patch[k];
    });
    try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); } catch (e) { /* ignore */ }
    emit('settings');
    return settings;
  }

  function getSettings() { return settings; }

  return {
    state: state,
    subscribe: subscribe, off: off, emit: emit,
    begin: begin, end: end, cancel: cancel, do: doAction,
    undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo, undoLabel: undoLabel,
    select: select, setTool: setTool, activeRoom: activeRoom, setActiveRoom: setActiveRoom,
    save: save, listProjects: listProjects, loadProject: loadProject, readProject: readProject,
    deleteProject: deleteProject, setProject: setProject, createProject: createProject,
    loadSettings: loadSettings, saveSettings: saveSettings, getSettings: getSettings,
    clone: clone
  };
})();
