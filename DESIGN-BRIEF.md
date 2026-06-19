# DESIGN-BRIEF — NYNM Client Hub

**Date:** 2026-06-17 · **Deliverable:** code · **Surface:** product UI (two vanilla HTML/CSS/JS PWAs, mobile-first / installed iPhone PWA, also opened on desktop) · **Mode:** redesign

> **Amendment — 2026-06-18 (Relay rebrand + Liquid Glass pass).** The product is now **Relay by Not Your Normal Marketing**. The in-app mark is the **Relay wordmark** — an 8-spoke asterisk + "Relay" set in Archivo (the one web font loaded, for the wordmark only) with "by Not Your Normal Marketing" beneath — replacing the NYNM badge in the nav. The exact Apple token set now in `shared/ui.css` (`--label:#000`, `--nav-glass`, `--fill-input`, the radii scale, **plus a full `prefers-color-scheme: dark` block**) is the source of truth and supersedes the light-only values below where they differ; **dark mode is in scope.** The portal request-type picker is a true iOS segmented control (sliding white thumb). Two functional additions: per-request **delete** on the Desk (admin-gated, confirmed), and a tap-to-view **full-image lightbox** for the cropped staged-draft preview and attachment thumbnails. Everything else below still holds.

> **Amendment 2 — 2026-06-18 (Bolder Liquid Glass, owner-directed).** The "no glassmorphism as decoration" ban below is **consciously extended** at the owner's request toward the iOS 26 Liquid Glass language: content **cards** and the **segmented controls** now use translucent frosted material (backdrop-blur + saturate) with **specular edges** (inset top highlight), **layered depth** shadows, and a faint **ambient backdrop** (very low-alpha blue/indigo radial glows) so glass has light to refract. Premium touches added: the primary button gets a top sheen + colored accent glow; inputs get an accent focus glow; the Relay wordmark gets a one-time load **sheen** (overlay glint, text stays solid) and the asterisk a brief glow pulse; buttons use a spring press; the app view does a one-time rise-in. All wrapped in `prefers-reduced-motion`. Text contrast on glass is preserved (cards stay ≥0.55 opacity over their field).

> **Reading order for every later phase:** this brief is law. Where a builder skill's default, the `impeccable` product-register default, or the existing NYNM `shared/ui.css` tokens conflict with what is written here, **this brief wins.** The Apple direction below is a **brand override** (treat the tokens like a client brand profile that beats authority defaults). The one carve-out: the **Not Your Normal Marketing logo stays** as the app mark — the visual *language* is Apple, the *mark* is NYNM.

---

## Taste authority

`impeccable` — Product register. This is task software (a request queue, a review panel, an intake form), not a marketing surface, so design SERVES the task and must "disappear into the task." impeccable supplies the product-UI craft floor (full state vocabulary per control, earned familiarity over novelty, predictable grids, the absolute-bans discipline) and the AI-slop bar. The look itself is not impeccable's house style — it is the LOCKED iOS 17/18 ground truth encoded below, which overrides impeccable's "system fonts / Inter is fine / Restrained-by-reflex" defaults wherever they differ.

## Brand

`~/.claude/brands/nynm/` exists, BUT its print-shop tokens (paper/ink/slate/fog/bone, Archivo + Inter, the "N" `brandmark` tile) are **explicitly overridden for this surface** by the Apple direction below. The current `shared/ui.css` (`--paper #f4f1ea`, `--slate #38424b`, Archivo/Inter `@import`, `.brandmark`, `.tabs`, `.chip`, `.badge`) is the *redesign target*, not the spec to preserve.

What survives from the brand: **the real NYNM logo as the small app mark in the nav** (use `~/.claude/brands/nynm/logos/nynm-stacked-logo.png`, or the badge `nynm-badge.png` where a square mark reads better — never a re-typed wordmark, never an "N" tile). Everything else — type, color, metrics, motion, materials — comes from the locked Apple values below.

## Atmosphere

Calm, native, precise, weightless, trustworthy — **as if Apple themselves shipped it.** A grouped iOS Settings / Reminders surface: soft `#F2F2F7` field, crisp white rounded cards, San Francisco type, hairline separators, one confident blue accent. The reference point is a stock iOS 17/18 system app on iPhone, not a SaaS dashboard and not a print-shop document. If a screen could be mistaken for a third-party "Apple-style" template rather than a first-party Apple app, it has failed.

## Typography

San Francisco, served by the OS — **do NOT load a web font; do NOT substitute Inter, Roboto, or Archivo.** On Marshall's Mac/iPhone this stack resolves to real SF (the exact faces apple.com uses). Delete the existing Google Fonts `@import` for Archivo/Inter from `shared/ui.css`.

- **Font stack (display + body, one stack):** `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`
- **iOS type scale** (px / weight / tracking) — encode as named tokens:
  - Large Title — 34 / 700 / -0.4px
  - Title 1 — 28 / 700 / -0.4px
  - Title 2 — 22 / 700 / -0.3px
  - Title 3 — 20 / 600 / -0.2px
  - Headline — 17 / 600 / -0.3px
  - Body — 17 / 400 / -0.2px  ← **base body = 17px**
  - Callout — 16 / 400
  - Subhead — 15 / 400
  - Footnote — 13 / 400
  - Caption — 12 / 400
- **Numbers/counts** (tab counts, request counts, dates, any tabular figure): `font-variant-numeric: tabular-nums`.
- **Section headers** = uppercase **Footnote** (13/400, ~0.06em tracking) in `secondaryLabel` — the iOS Settings group-header style. This replaces the current `.section-label`.
- Body/prose still caps at 65–75ch; the centered content column (below) already enforces this.
- **Banned:** Inter, Roboto, Arial, Archivo, any web-loaded font, any generic `system-ui`-only stack, any display/serif face for headings. Hierarchy comes from the scale + weight, never from a second family.

## Palette

Apple light-mode system colors. These are the ONLY values that may appear in shipped styles. Encode each as a named token (`--label`, `--system-blue`, etc.).

- `systemGroupedBackground` **#F2F2F7** — app background, the field behind all cards (the dominant surface)
- `secondarySystemGroupedBackground` **#FFFFFF** — cards and list rows (the second surface)
- `label` **#1C1C1E** — primary text
- `secondaryLabel` **rgba(60,60,67,0.60)** — secondary text, subtitles, section headers
- `tertiaryLabel` **rgba(60,60,67,0.30)** — placeholder / faint
- `separator` **rgba(60,60,67,0.29)** — hairlines, rendered at **0.5px**
- `systemBlue` **#007AFF** — **the one chromatic accent for interaction:** links, primary buttons, active segment text, switches/toggles, focus ring, selected state
- `systemGreen` **#34C759** — success / Approve / Done (status only)
- `systemOrange` **#FF9500** — warning / Ready to review / Changes asked (status only)
- `systemRed` **#FF3B30** — destructive / error (status only)
- `systemGray` **#8E8E93**, `gray3` **#C7C7CC**, `gray5` **#E5E5EA**, `gray6` **#F2F2F7** — fills, borders, inactive controls
- **Tinted control fills** (Apple convention): accent-colored text on the same accent at **12–16% alpha** background — e.g. blue text on `rgba(0,122,255,0.12)`. All status badges use this pattern.

**Accent rule (non-negotiable):** `systemBlue` is the ONLY chromatic accent for interaction and selection. Green / orange / red are reserved strictly for **status semantics** — never decoration, never a primary action, never an inactive-state color. No off-palette hex anywhere in shipped CSS. No `#000` / `#fff` for text (use `label` / the white card token).

**Status → color map** (drives the request lifecycle `submitted → queued → drafting → ready → approved → shipping → done`, plus `changes`):
- neutral/in-progress (submitted, queued, drafting, shipping) → gray or blue tinted fill
- ready (ready to review) → **orange** tinted fill
- changes (changes asked) → **orange** tinted fill
- approved / done → **green** tinted fill
- error/destructive → **red** tinted fill

## Layout system

**Signature structural pattern: the iOS grouped inset list.** Content lives in rounded **white** cards inset with **16px** side margins on the `#F2F2F7` field; cards group related rows; rows inside a card are divided by 0.5px `separator` hairlines (inset to start at the text, iOS-style). This is THE pattern for both apps — request cards, the review panel, every form, the client list, the history lists.

- **Grid / measure:** single centered column, comfortable max content measure **~640–720px** on desktop (the existing `.wrap` max-width 720px is in range — keep it); full-bleed-to-16px-inset on iPhone.
- **App header:** iOS **Large Title** (34/700) at the top of each app — "Request Desk" (desk) and the client's name (portal) — with the **small NYNM logo as the app mark** in the nav area beside or above it. The large title may shrink/inline into a compact centered nav title on scroll (iOS large-title collapse). This replaces the current `.appbar` + `.brandmark` "N".
- **Section headers:** uppercase Footnote in `secondaryLabel` (iOS Settings style), sitting above each card group with comfortable top spacing.
- **Cards:** corner radius **16–18px** (continuous-corner / squircle feel). One elevation only — a soft, low shadow; never nested cards (impeccable absolute ban), never a card inside a card.
- **Tap targets:** **44pt minimum** on every interactive element (buttons, segments, chips, rows, toggles).
- **Spacing:** **8pt grid** — 8 / 16 / 24 / 32. Vary rhythm between groups; never uniform padding everywhere.
- **The Requests / Events / Clients switch = a real iOS *segmented control*** (this replaces the current `.tabs` button row): track = a `gray5`/secondary fill capsule; the **selected segment is a white capsule with a subtle shadow**; segment radius ~7–9px inside a ~9–11px track; selected label in `label`/`systemBlue` weight-emphasized, unselected in `secondaryLabel`. Counts ride inside each segment in tabular-nums.
- **Stage / client filters** (desk) and **request-type picker** (portal Post / Website fix / Design / Event): iOS-style pill chips or an inline grouped control — selected uses the blue tinted-fill pattern, not the current ink-filled `.chip`.
- **Forms** (add-client on desk; new-request + event on portal): grouped inset list rows — label + field per row, hairline-separated inside one white card, iOS Settings form feel. Inputs are full-width, 17px, with the blue focus ring.
- **Breakpoint collapse:** structural, not fluid type — the column stays centered and simply gains its 16px side gutters on narrow screens. Must render clean with **no horizontal scroll at 390px** (installed iPhone PWA) and **1440px** (desktop). `viewport-fit=cover` is already set; respect the safe-area insets (notch / home indicator) with `env(safe-area-inset-*)` padding on the nav and the bottom of the scroll area.

## Motion philosophy

- **Engine:** CSS only (these are vanilla PWAs; no Motion/GSAP).
- **Easing:** standard = `cubic-bezier(0.32, 0.72, 0, 1)` (Apple's confident ease-out, used on apple.com). Spring-for-taps = `cubic-bezier(0.34, 1.56, 0.64, 1)`. No bounce/elastic beyond that tap spring.
- **Durations:** micro / controls **180–240ms**; standard transitions **300–400ms**; larger reveals up to **500ms**. Frequent interactions stay subtle and short.
- **Specific moves:**
  - Button / chip / row press → `scale(0.97)` + slight dim, ~150ms with the tap spring.
  - Segmented-control selection → the white capsule **slides** under the active segment (or cross-fades) over **300ms** on the standard ease; label colors cross-fade with it.
  - Card / panel reveal (e.g. the staged-draft review panel expanding, a new request appearing) → opacity + small translate, 300–400ms standard ease.
  - Toast → fade/slide in, already present; keep it iOS-subtle.
- **transform/opacity only** — never animate layout properties (width/height/top/left/margin). (impeccable absolute ban.)
- **`prefers-reduced-motion`:** remove movement entirely; opacity/color cross-fades may remain.

## Imagery plan

**No decorative imagery.** This is task UI — the only "images" are functional content, treated the Apple way:
- **NYNM logo** as the app mark in the nav (real logo asset, per Brand above).
- **Per-client brand avatars:** each client/brand on the hub shows its own logo inside an **Apple-style rounded "squircle" avatar** (continuous-corner, ~`gray6` placeholder ring). When no logo asset exists, fall back to a **clean SF monogram** (client initials, `label` on a `gray5`/tinted fill) — never an empty box, never an AI-generated graphic.
- **User-attached request photos** (portal upload, desk thumbnails): the existing `.thumb` pattern, restyled to iOS — rounded `gray6` tile, `object-fit: cover`, optional count overlay. Real user content only.
- Do **not** call `/imagery` or generate any texture/anchor/motif. No hero images, no illustrations.

## Banned patterns

Merged: global AI-tells + impeccable product bans + this project's specifics.

- **No web-loaded fonts.** No Inter, Roboto, Arial, Archivo, generic `system-ui`-only stack, or any `@import`/`<link>` font (delete the existing Archivo/Inter import). SF via the OS stack only.
- **No off-palette color.** No hex outside the Apple system tokens above; no `#000`/`#fff` for text; green/orange/red never used as accent or decoration.
- **No "N" tile / re-typed wordmark** for the brand mark — the real NYNM logo art only. No "A New Day" or any other client's brand baked into the chrome.
- **No side-stripe borders** (`border-left/right` >1px as a colored accent) on cards, rows, badges, or callouts — full hairline borders / tinted fills only. (impeccable absolute ban.)
- **No gradient text, no `background-clip: text`.** Solid `label`/`systemBlue` only; emphasis via weight/size.
- **No glassmorphism as decoration** — the ONE sanctioned vibrancy is the top nav material (below); nowhere else.
- **No hero-metric template** (big number + small label + gradient). No identical icon-card grids repeated endlessly. No modal as first thought — prefer inline / progressive disclosure for the review panel, the add-client form, and request detail (modals only if a true iOS sheet is genuinely the right affordance).
- **No reinvented affordances** — the switch is a *real* iOS segmented control, toggles are iOS switches, the form is an iOS grouped list. No custom scrollbars, no novelty controls.
- **No decorative motion**, no orchestrated page-load sequence — motion conveys state only, and the app loads straight into the task.
- **No em dashes in UI copy** (or `--`); use commas, colons, semicolons, periods, parentheses. No restated headings, no placeholder "Jane Doe" data, no meta-labels like "SECTION 01."

## Materials

The **top nav bar uses Apple vibrancy:** `backdrop-filter: saturate(180%) blur(20px)` over `rgba(255,255,255,0.72)`, with a **0.5px** bottom `separator` hairline. (This upgrades the current `.appbar`'s `blur(8px)` over paper.) The bar is sticky, respects the top safe-area inset, and is the **only** place blur/translucency appears in either app.

## Verifier checklist

Every item is objectively checkable on the rendered artifact (render + look, or grep). Phase 5 and auto-improve both grade against THIS list.

- [ ] Only San Francisco appears — computed `font-family` resolves through `-apple-system`/`BlinkMacSystemFont`; **no** web-font `@import` or `<link>`, and no Inter/Roboto/Arial/Archivo in any shipped CSS (grep).
- [ ] H1 (Large Title, 34/700) renders ≤3 lines at 1440px wide.
- [ ] Palette tokens only — every color in shipped CSS is one of the Apple system tokens above; no off-palette hex, no `#000`/`#fff` for text (grep).
- [ ] Every interactive element (buttons, segments, chips, rows, inputs, toggles) has visible default, hover, focus, active, and disabled states; focus uses the `systemBlue` ring.
- [ ] Body text contrast ≥ 4.5:1 (`label #1C1C1E` on white passes; verify any secondaryLabel text used at body size).
- [ ] Animations use transform/opacity only; durations sit in the 180–500ms bands with the specified easing curves.
- [ ] `prefers-reduced-motion` removes movement (opacity/color may remain).
- [ ] Renders clean at **390px** and **1440px** — no horizontal scrollbar, no overlap; safe-area insets respected (nav + bottom).
- [ ] Zero banned patterns present (no side-stripes, gradient text, decorative glass, hero-metric block, "N" tile, em dashes).
- [ ] **The Requests / Events / Clients switch is a true iOS segmented control** — a white selected capsule (with subtle shadow) sliding on a gray track, not a row of buttons or underlined tabs.
- [ ] **Each client row shows its brand-logo avatar in a rounded squircle; an SF monogram (initials on a tinted fill) is the fallback when no logo asset exists** — never an empty box.
- [ ] **The NYNM logo is present as the app mark in the nav of both PWAs** (real logo art, not an "N" tile); no "A New Day" or any other client brand in the chrome.
- [ ] **Status badges use the Apple tinted-fill style** — semantic-color text on the same color at 12–16% alpha (e.g. orange "Ready to review", green "Done"), and the status→color map is honored (ready/changes = orange, approved/done = green, errors = red, neutral/in-progress = gray/blue).
- [ ] The top nav (and only the top nav) uses the vibrancy material: `backdrop-filter: saturate(180%) blur(20px)` over `rgba(255,255,255,0.72)` with a 0.5px bottom separator.
