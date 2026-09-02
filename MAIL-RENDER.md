# MAIL-RENDER.md — Mail Context Rendering: Research & Plan

> **STATUS (2026-09): implemented** — §3/§4/§5 items 1–4 + 6 done in `EmailFrame.tsx`,
> `ViewerPane.tsx`, `index.html`; covered by new `EmailFrame.test.tsx` (44 frontend tests pass).
> Item 5 (persisted preference) deliberately deferred; per-message toggle is component state.
> Also fixed a latent bug found by the new tests: the remote-image blocker used a partial-match
> regex that orphaned `width="…"`/`height="…"` outside the `<img>` tag (corrupting the blocked
> placeholder and leaking stray text); it now rewrites only the `src` attribute and keeps all
> original attributes, with `max-width:100% !important` capping the placeholder on phones.
>
> **Update (v0.1.46, user feedback):** the Fit/原寸 toggle bar was **removed** — wide emails are
> now *always* auto-scaled to pane width (the measured fit size was judged good enough); pinch-zoom
> + wrapper horizontal pan (beyond the 0.45 scale floor) remain as escape hatches.
> **Also (v0.1.45):** removing `user-scalable=no` exposed iOS Safari's focus auto-zoom on <16px
> inputs (whole page zooms on tap of `text-xs` fields). Fixed in `index.css` by forcing
> `input/select/textarea{font-size:16px}` below `md` + `touch-action: manipulation` on buttons/links.
>
> **Update (v0.2.3, real eMPF RFC822 forensics):** eMPF mails are built as **fixed layout
> tables** (cols `width=56/266/416/56` = 794px design, `min-width` classes) with a trailing
> `<td width="100%">` **filler column**. The earlier `table/div/td{max-width:100% !important}`
> clamp + `.email-content{max-width:720px}` *crushed* the 794px design into 720px (columns
> re-wrapped to ribbons, filler column stretched into the visible "empty right side"). Clamps
> removed: content now renders at **natural design width**, `.email-content`'s 720px cap is
> lifted by the parent when content overflows it, then the measured design width (e.g. 866px)
> is scaled to the pane. Verified headless: 375px pane → scale 0.45 (design intact);
> 850px desktop → scale 1, Outlook-faithful. Lesson: *measure at natural width first, never
> reflow-clamp a table's design — Apple/Gmail/Outlook all scale, not squeeze.*


> Issue: HTML emails on mobile render pinned to the **left**, leaving a large **empty area on the
> right**, and never reflow to use the full available width/height. Goal: the mail body should
> **dynamically fill the reading pane on both mobile and desktop**, the way Gmail / Roundcube /
> Apple Mail (iPhone) do.

---

## 1. Root cause (current behaviour)

Rendering happens in one place: `frontend/src/components/mail/EmailFrame.tsx`
(DOMPurify → `srcDoc` sandbox `<iframe>`).

| # | Problem | Where |
|---|---------|-------|
| 1 | Most marketing/notification emails are built with **fixed-width tables** (`width="600"`, spacer GIFs). Viewport is ~360–430px on phones → intrinsic width exceeds the frame. Body CSS falls back to `overflow-x:auto`, so the email keeps its 600px+ canvas: user sees only the **left column**, and blocked remote images keep their **original `width`/`height` placeholders** (deliberately preserved at `EmailFrame.tsx:195-217`), which produces the "left-aligned + huge empty right side" effect. | `EmailFrame.tsx` (injected `body{overflow-x:auto}`, `table{max-width:100% !important}` can't shrink tables whose *children* have hard px widths) |
| 2 | `.email-content { max-width:720px; margin:0 auto }` centres on desktop but on mobile the overflowing fixed-width content breaks the centreing (overflow always starts at the left edge). | `EmailFrame.tsx:108/250` |
| 3 | The iframe cannot be **measured**: `sandbox="allow-popups allow-popups-to-escape-sandbox"` makes it an *opaque origin*, so the parent can't read `contentDocument.scrollWidth/scrollHeight`. No fit-to-width or auto-height logic is therefore possible today. | `EmailFrame.tsx:335-340` |
| 4 | Iframe height is flex-filled; the email scrolls *inside* the iframe (double scrollbars on mobile, header/attachments compete for space). | `ViewerPane.tsx:444`, `EmailFrame.tsx:275` |
| 5 | `<meta name="viewport">` is **absent from the srcDoc** (and mobile browsers ignore viewport meta inside iframes anyway — so Apple's shrink-to-fit trick is not directly available to a web app). | `EmailFrame.tsx` |
| 6 | App shell sets `user-scalable=no, maximum-scale=1.0` — users **cannot pinch-zoom** to compensate for small/overflowing text (also a WCAG failure). | `frontend/index.html:7` |

### 1.1 Field examples (real mails, iPhone Safari, 2026-09)

Two live captures confirm both failure modes are the ones listed above:

**Case A — MPF "Notification to Member – Completion of Contribution Allocation"**
(`no-reply@osc.empf.org.hk`, contact / remote images already allowed)

- Symptom: body occupies only the **left ~55%** of the screen; a tall **empty white band**
  under the logo; the "Trustee Name / Scheme Name / Member…" table hugs the left edge with a
  wide dead area to its right.
- Diagnosis: email's wrapper table is a fixed ~**600–634px** two-column layout overflowing the
  ~390px layout viewport → **left-pinning + empty right side** = causes #1/#2. The empty band is
  the banner header image area whose **original pixel height is still reserved** (blocked/failed
  remote image placeholder keeps `width`/`height` — cause #1).
- Expected after fix: measured `W ≈ 634 > A` → Auto = Fit, scale ≈ `A/W` (~0.6) — the full design
  spans edge-to-edge, no empty right strip, single scrollbar (design intact, like Apple Mail).

**Case B — 中旅 "香港中旅證件服務預約辦理服務提醒"** (`edp-noreply@ctg.cn`)

- Symptom: renders **too big** — the large-font blue heading and the 編號/地點/地址 lines run
  past the right edge and are **clipped** (user must scroll sideways for every line).
- Diagnosis: percentage-width single column with a **large font-size + long nowrap lines**
  (address, 項目) → intrinsic width > viewport → same overflow path (cause #1), and there is
  **no shrink-to-fit** at all today — the app offers neither auto-zoom (§4.1 Fit) nor pinch-zoom
  (cause #6), which is exactly what iPhone Mail/Gmail would do here.
- Expected after fix: same Auto→Fit detection zooms the whole message out to the screen width
  (title + all fields fully visible), with the Fit/100% toggle for users who prefer larger text
  + horizontal scroll; pinch-zoom restored as a fallback.

> Note: Case A and B are **different emails of the same class** — "intrinsic width > pane width".
> Case A shows the *empty-right-side* variant (fixed table), Case B the *clipped/too-big*
> variant (big font, long lines). One measurement + one Fit mode (§4.1) covers both.

---

## 2. How the industry does it (research summary)

### Apple Mail (iPhone / iPad)
- Renders each message in its **own WKWebView** sized to the screen, then applies
  **automatic "scale-to-fit"**: WebKit detects fixed-width content wider than the viewport
  and zooms the *layout viewport* out so the whole design is visible, no horizontal scroll.
- Confirmed mechanism (`email-bugs #18`, Apple Dev Forums): equivalent to injecting
  `<meta name="viewport" content="width=<intrinsicWidth>">` — the browser scales
  `width` px of CSS content into the device width. (Apple dropped `shrink-to-fit=YES` in
  iOS 9.3; the supported path is a viewport width equal to the rendered content width.)
- Users can still pinch-zoom and switch to double-tap reflow.
- **Key take-away:** render once → measure intrinsic width → rescale to viewport. Preserves the
  designer's layout; small screens get proportionally smaller (but complete) rendering.

### Gmail (web + mobile apps)
- Renders HTML in an **iframe**; message length is synced with the parent via a tiny
  in-frame script + `postMessage`, so the whole inbox scrolls as one page (auto-height iframe).
- **Mobile "wide message" handling:** Gmail detects content wider than the screen and offers a
  toggle (the ↔ / "wide email" button): *fit* (reflow/shrink to screen) vs *original size*
  (horizontal scroll). iOS Gmail additionally applies a font-size bump heuristic
  (up to +50%) when tables are wider than the screen (css-tricks: "Override Gmail's Mobile
  Optimized Emails").
- On desktop, wide emails simply get horizontal scrolling inside the message pane.
- **Key take-away:** *detect wide content → give the user an explicit Fit | Original toggle*,
  default to the mode that fills the screen.

### Roundcube (Elastic skin)
- Same-origin iframe per message; a "message width" control in the mail toolbar
  ("enlarge / shrink the message to adjust the browser width") toggles the iframe body between
  the email's original fixed width (with horizontal scroll) and window-width reflow
  (`html.iframe` overflow rules in `skins/elastic/styles/layout.less`).
- Auto-resizes the iframe height to the content (`slimframe`-style JS) so the page scrolls once.
- **Key take-away:** same pattern — measure, toggle, auto-height; done entirely from the parent
  page (no scripts inside the email).

**Common denominator (all three):**
1. Detect the email's *intrinsic* rendered width.
2. If wider than the available pane → **scale-to-fit by default**, with a one-tap escape hatch to
   view at 100% (horizontal scroll), like a PDF "fit page / actual size".
3. Iframe height always auto-fits content (one scrollbar).
4. Never disable pinch-zoom.

---

## 3. Can this app do the same? Yes — with one enabler

The scaling/fit itself needs **no scripts inside the email** (we strip `<script>` and never will
allow them). It only needs the parent to be able to *measure and style* the iframe document.
That requires the parent and the srcDoc to share an origin.

**Enabler:** add `allow-same-origin` to the iframe sandbox and keep `allow-scripts` **off**.
Security model remains sound because:
- `srcDoc` content is DOMPurified (no `on*` handlers, no `<script>`, `<object>`, `<embed>`);
- without `allow-scripts`, the document cannot execute JS — the dangerous sandbox combination is
  `allow-scripts` + `allow-same-origin`, which we explicitly avoid;
- the parent only *reads* geometry and *injects* its own `<style>` into the child.
(Secondary hardening: a response-header `Content-Security-Policy` on `/api/attachment` + keep
DOMPurify config as is.)

Everything below is standard web-platform work (transform/zoom measurement), the same class of
solution Roundcube ships.

---

## 4. Design

### 4.1 Rendering modes (per message, "Auto" by default)

```
            measure intrinsic width W (after srcDoc load + image load)
                       │
        W ≤ available A │ (normal email)      W > A (wide email)
                       ▼                        ▼
               render at 100%            ┌─────────────────┐
               (fills pane naturally)    │  Auto (default)  │ → Fit-to-width: scale = A/W
                                         └─────────────────┘   design intact, uses 100% of
                                                                width & auto height
                                         User toggle (toolbar):
                                           • Fit   (A/W scale — "Apple Mail" look)
                                           • 100%  (original, horizontal scroll — "Gmail wide" look)
```

- **Fit** implementation (no email-side scripts): wrapper div `overflow:hidden`, iframe given
  CSS width `A/scale`, `transform: scale(scale)`, `transform-origin: top left`, and height set to
  measured `contentHeight × scale`. This is the proven "scaled iframe" technique; text stays
  crisp (it's layout-scaled, not a bitmap zoom) on all engines.
  (On desktop Chrome/Safari ≥26, plain `zoom` on the iframe now propagates into same-origin
  sub-frames per the 2024 csswg resolution — we keep `transform` as the portable baseline.)
- **Auto height:** after load (and on `ResizeObserver` of the child `<body>` / `images ready`),
  set iframe height to `scrollHeight` so the outer reading pane owns scrolling — one scrollbar,
  correct pull-to-refresh behaviour on mobile.
- On **desktop** wide emails: same logic; `Fit` caps at scale 1 (never upscale beyond 100%), so
  normal emails are unaffected; 720px measure-based centring keeps long-form text readable
  while *wide* emails use the full `max-w-4xl` card.
- **Threshold:** only engage Fit automatically when `W > A + 40px` (avoid jitter on
  near-fitting emails); remember the user's per-message choice in component state.

### 4.2 Reflow assist (injected CSS improvements, both modes)

Add to the srcDoc stylesheet (in `EmailFrame.tsx`):
- `<meta name="viewport" content="width=device-width, initial-scale=1">` inside srcDoc
  (harmless, helps engines that honour it for iframes);
- `body { margin:0; width:100%; }` and drop the fixed `.email-content{max-width:720px}`
  in favour of a *measure-then-center* approach (center via auto margins only when content
  actually fits);
- gentler reflow rules for `100%`/`Fit` mode fallbacks: `td, th { max-width:100% }` retained;
  remove `table-layout:auto` override (let the design keep `fixed` layout in Fit mode);
- when remote images are **blocked**, don't reserve original width on very large placeholders
  (cap placeholder width to viewport) — this alone removes a big chunk of the "empty right side";
- `img { height:auto }` already present — keep.

### 4.3 Accessibility / gestures
- `frontend/index.html`: remove `maximum-scale=1.0, user-scalable=no` (pinch-zoom restored).
- Toggle button must be touch-friendly (≥44px target), placed in the viewer toolbar next to the
  existing "Show images" button; visible only when the message is detected wide.

### 4.4 UX parity table (goal)

| Behaviour | Gmail | Apple Mail | Roundcube | This app (after) |
|---|---|---|---|---|
| Wide email shrinks to screen by default | (toggle) | ✅ auto | (toggle) | ✅ Auto→Fit |
| One-tap original size + h-scroll | ✅ | pinch | ✅ | ✅ toggle |
| Body auto-height (single scrollbar) | ✅ | ✅ | ✅ | ✅ |
| Text/plain rendered fluid, no left-pinning | ✅ | ✅ | ✅ | ✅ (already, verify) |
| Pinch-zoom | ✅ | ✅ | browser | ✅ (fix #6) |

---

## 5. Implementation steps

1. **`EmailFrame.tsx` — measurement & modes**
   - sandbox → `allow-same-origin allow-popups allow-popups-to-escape-sandbox`;
   - add `useEffect` post-load: read `iframe.contentDocument` → `documentElement.scrollWidth`,
     attach `ResizeObserver` on child `body`, listen to child `img.onload`;
   - store `intrinsicWidth`, `contentHeight`; render Fit wrapper with computed scale
     (`ResizeObserver` on the pane also re-runs on rotate/resize);
   - expose small segmented control (`Fit | 100%`) when `intrinsicWidth > paneWidth + 40`.
2. **`EmailFrame.tsx` — srcDoc CSS** per §4.2 (viewport meta, margin reset, capped blocked-img
   placeholders, centering only when it fits).
3. **`ViewerPane.tsx`** — let the outer pane scroll (`overflow-y-auto` on the body container),
   iframe height = measured content height instead of flex-fill; keep `max-w-4xl` card.
4. **`index.html`** — fix viewport meta (restore pinch-zoom).
5. **Preferences (small)** — `useMailStore`/local settings: `emailWidthMode: 'auto'|'fit'|'original'`
   as global default; per-message override is state-only for now.
6. **Tests (Vitest, currently zero coverage here)** — new `EmailFrame.test.tsx`:
   - wide-table fixture (600px) on 375px container → Fit scale ≈ A/W applied, toggle rendered;
   - narrow fixture → no scaling, no toggle;
   - blocked-remote-image fixture → placeholder capped, `data-blocked-src` preserved;
   - text/plain fixture → fluid, pre-wrap preserved; sandbox keeps `allow-same-origin`
     *without* `allow-scripts` (assert as security regression guard).
7. **Manual QA matrix** (per AGENTS.md responsive rule): iPhone SE 375px, Pixel 412px, iPad,
   desktop 1440px; fixture emails: 600px fixed table, 700px nested table + remote images blocked
   & allowed, wide data table (invoice), pure text, long CJK/Big5 sample.

## 6. Non-goals / risks
- **No** enabling of `allow-scripts` in the mail iframe, ever (sanitized static rendering only).
- No full DOM rewriting (removing `width=` attributes) in v1 — Apple-style scaling preserves
  design intent better than aggressive reflow, and reflow can destroy multi-column layouts.
  (Aggressive reflow can be a later `Reflow` mode if Fit's small text proves unpopular —
  it's an easy CSS add-on once measurement plumbing exists.)
- Scaled text at ~0.55× on a 320px phone can get small (≈8px effective for 14px text) — hence the
  prominent Fit/100% toggle + restored pinch-zoom, matching Gmail/Apple UX expectations.
- `allow-same-origin` + DOMPurified, script-less srcDoc is acceptable; keep DOMPurify
  `FORBID_TAGS` including `form`/`base` and revisit config when bumping DOMPurify.

## 7. References
- Apple Dev Forums — WKWebView viewport shrink-to-fit / `width=<contentWidth>` technique
- github.com/hteumeuleu/email-bugs #18 — Apple Mail auto-scale behaviour
- css-tricks.com/override-gmail-mobile-optimized-email — Gmail mobile font-bump/wide detection
- roundcube/roundcubemail `skins/elastic` — iframe-wrapper + message width adjust, auto-height
- budavariam.github.io "Iframe zoom" — transform-scale technique for iframes
- w3c/csswg-drafts #9644 — `zoom` now applies to same-origin iframes (Chrome/Safari 2024+)
