/* ---------------------------------------------------------------------------
   Site branding.

   A logo chosen in Settings lives in one browser's localStorage. That is fine
   on the machine you set it on, and absent everywhere else — on your phone, and
   for anyone who opens the published site. So the logo can also live in the
   repository, as base64 in branding/logo.txt, which makes it part of the site
   rather than part of one browser's storage.

   Precedence: the site files are the default; a logo chosen in Settings
   overrides them on that device only.
   --------------------------------------------------------------------------- */
window.RS = window.RS || {};

RS.Brand = (function () {
  'use strict';

  var site = { logoDataUrl: '', orgName: '', loaded: false, source: 'none' };
  var waiters = [];

  /* Both files are optional and both are fetched relative to the page, so this
     works from a subdirectory (GitHub Pages) as well as from the root. Opened
     straight from disk, fetch() is blocked for file:// and we simply carry on
     with no site branding. */
  function load() {
    var jobs = [
      fetchText('branding/logo.txt').then(function (txt) {
        var url = normaliseDataUrl(txt);
        if (url) { site.logoDataUrl = url; site.source = 'site'; }
      }),
      fetchText('branding/brand.json').then(function (txt) {
        if (!txt) return;
        try {
          var json = JSON.parse(txt);
          if (typeof json.orgName === 'string') site.orgName = json.orgName.trim().slice(0, 60);
        } catch (e) { /* a malformed brand file must not break the app */ }
      })
    ];
    return Promise.all(jobs).then(function () {
      site.loaded = true;
      waiters.forEach(function (fn) { try { fn(site); } catch (e) { console.error(e); } });
      waiters.length = 0;
      return site;
    });
  }

  function fetchText(path) {
    try {
      return fetch(path, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .catch(function () { return ''; });
    } catch (e) {
      return Promise.resolve('');
    }
  }

  /* Accept a full data URL, or a bare base64 blob which we assume is a PNG.
     Strip whitespace so a line-wrapped file works. */
  function normaliseDataUrl(txt) {
    if (!txt) return '';
    var s = String(txt).replace(/\s+/g, '');
    if (!s) return '';
    if (/^data:image\/[a-zA-Z+]+;base64,/.test(s)) {
      return s.length > 40 ? s : '';
    }
    /* Bare base64: sanity-check the alphabet before trusting it. */
    if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length > 40) {
      return 'data:image/png;base64,' + s;
    }
    return '';
  }

  function onReady(fn) {
    if (site.loaded) fn(site);
    else waiters.push(fn);
  }

  function get() { return site; }

  /* What the exporter and the settings panel should actually use. */
  function effective() {
    var s = RS.Store.getSettings();
    return {
      logoDataUrl: s.logoDataUrl || site.logoDataUrl || '',
      orgName: s.orgName || site.orgName || '',
      fromSite: !s.logoDataUrl && !!site.logoDataUrl,
      siteHasLogo: !!site.logoDataUrl,
      siteOrgName: site.orgName
    };
  }

  return { load: load, onReady: onReady, get: get, effective: effective, normaliseDataUrl: normaliseDataUrl };
})();
