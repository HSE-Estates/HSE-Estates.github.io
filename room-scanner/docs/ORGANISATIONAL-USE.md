# Readiness for organisational use

What the app already does, and what it still needs before a public sector body
could deploy it. Written for the HSE case, but nothing here is HSE-specific.

## Done

**No third-party code.** No frameworks, no CDN links, no analytics, no trackers,
no cookies, no fonts fetched from anyone. The whole app is the files in this
repository. Nothing to review for supply-chain risk because there is no supply
chain.

**No network calls by default.** Scanning, measuring, editing and exporting all
happen in the page. A freshly installed copy makes exactly one kind of request:
loading its own files. The two optional features that do reach out are off until
switched on, name their destination first, and are described in the in-app
privacy notice.

**Data stays on the device.** Surveys live in the browser's local storage. There
is no account, no server and no database, so there is no central store of floor
plans of people's homes or wards to secure, breach or subject-access. Deletion is
immediate and complete.

**Accessibility (WCAG 2.1 AA, self-assessed).**
- Every interactive control is keyboard operable and shows a visible focus ring,
  including the icon-only toolbar.
- Dialogs are real dialogs: `role="dialog"`, `aria-modal`, labelled, focus moves
  in on open, Tab is trapped inside, Escape closes, and focus returns to the
  control that opened them.
- The floor plan is not silent to a screen reader. It carries `role="img"` and a
  generated description: room names, floor areas, dimensions, opening counts and
  item counts.
- Body text meets 4.5:1 against its background; the secondary grey was darkened
  to 4.6:1 for this.
- `prefers-reduced-motion` is honoured.
- Windows high-contrast mode keeps the toolbar legible.

**Honest output.** Every PDF states the capture method, whether the scale was
corrected against a measured wall, and that it is an indicative survey rather
than a measured one. The app does not let a plan leave looking more authoritative
than the data behind it.

**Branding is explicit and owned by you.** No organisation's logo ships with the
app. One is supplied through `branding/logo.txt`, which is a deliberate decision
point: a floor plan carrying a logo reads as a document issued by that
organisation.

## Still required before deployment

These are organisational tasks, not code, and none of them can be done from here.

1. **Data Protection Impact Assessment.** Scanning occupied buildings captures
   information about the people in them. Even with everything held locally, the
   DPIA is what establishes lawful basis, retention and the position on exported
   files once they leave the app.
2. **Independent accessibility audit and a published accessibility statement.**
   The self-assessment above is a starting point, not a substitute. Public sector
   bodies must publish a statement under the EU Web Accessibility Directive
   (S.I. No. 358/2020).
3. **Information governance review** of the two optional features. Sending a
   photograph of a clinical space to a third-party inference service is a
   decision for IG, not for a surveyor mid-scan. Consider shipping with them
   removed rather than merely off — deleting `js/ai/provider.js` and its script
   tag disables both, and the app is fully functional without it.
4. **Accuracy validation against known rooms.** `docs/ACCURACY.md` gives the
   protocol and the pass criteria. The claim printed on the PDF should not be
   relied on organisationally until it has been tested on real rooms and the
   results recorded.
5. **Hosting decision.** GitHub Pages is public. That is fine for the app itself
   — it contains no data — but an organisation may want it on its own domain
   with its own certificate.
6. **Browser support statement.** Scanning needs `DeviceOrientationEvent` and
   `getUserMedia` on `https`. It works on current iOS Safari and Android Chrome.
   It does not work in a desktop browser with no motion sensor, where the app
   falls back to drawing by hand. Managed devices with locked-down browsers need
   checking before rollout.

## Deliberately not done

**No telemetry of any kind.** Tempting for a rollout, and it would mean the app
starts sending data about buildings and the people surveying them. If usage data
is genuinely needed, add it as an explicit, reviewable feature — not quietly.

**No cloud sync.** Every option would mean floor plans of occupied buildings
sitting on someone's server, which changes the DPIA from straightforward to
substantial. Export and import JSON does the same job with no stored copy.

**No claim of survey accuracy.** Camera-only reconstruction is approximate. The
app is built to say so on every sheet it produces.
