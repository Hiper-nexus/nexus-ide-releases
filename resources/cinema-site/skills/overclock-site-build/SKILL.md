---
name: overclock-site-build
description: "Use when a squad worker must BUILD the front-end that CONSUMES a scrub hero's image-sequence — the production canvas scroll→frame engine (preload + loading bar, DPR scaling, cover-fit, mobile 1.3×), Lenis Safari-safe smooth scroll + lerp + requestAnimationFrame ticking, the scroll-length(vh)↔N-frames formula, perf hardening (passive/will-change/direct-DOM), mobile consumption fallback, and optional scroll-synced annotation overlays. Consumes frames/ + manifest from the editor; does NOT generate or encode media. Stack pinned Next 16 / React 19 / Tailwind v4 / Framer Motion / Lenis. Bind to the site builder / executor worker that has Bash + file-write. Triggers: front-end build, scroll-driven site, sticky canvas, frame sequence engine, Lenis smooth scroll, scrollytelling site, hero scrub component, image-sequence consumer, Next.js scroll hero."
---

# overclock-site-build — Front-End Build (consume the image-sequence)

The worker that builds the **site** that plays the scrub. The editor (`overclock-site-encode`) extracted `frames/%04d.jpg` + a manifest from the rendered clips; this skill writes the React/Next code that **consumes** that sequence — a sticky `<canvas>` whose frame index tracks scroll, with smooth scroll, preload, perf hardening, and a mobile fallback. **This is the last leg of the crew: brief → plan → keyframes+motion → encode+frames → site.**

> **Layer split — you do NOT generate or encode.** `overclock-site-scrub` owns generation (keyframes + Kling motion). `overclock-site-encode` owns transcode + **frame extraction** (`frames/` + manifest). This skill owns **only the front-end engine** that reads those frames. If you find yourself reaching for `overclock_image_generate`, `overclock_video_generate`, or ffmpeg, you are in the wrong skill — bounce upstream. You consume; you never produce frames.

---

## What feeds in / what ships out

| In (from the editor's `handoff_submit`) | |
|---|---|
| `frames/%04d.jpg` — the numbered image sequence (the scrub deliverable) | strict numeric order, never renamed |
| `manifest` — frame count `N` + path pattern (+ optional mobile variant) | drives preload + the scroll→index map |
| The scroll→frame-index wiring snippet | the naive `<img>` swap — you replace it with the production canvas engine |

| Out |
|---|
| The `Hero` (or `ScrubHero`) React component — sticky canvas, scroll→frame, preload+loading bar, DPR, cover-fit, mobile 1.3× |
| The `SmoothScrollProvider` (Lenis, Safari-safe) wrapping the app |
| The page wiring (section height in vh, the hero composed in) |
| Optional: scroll-synced annotation overlays |

**Aesthetics are NOT yours.** Palette, typography, shadows, spacing, the design system — delegate to **`frontend-design`** / **`premium-web-design`** (repo skills). This skill owns the **scroll mechanism + perf + Lenis**, never design tokens. Follow the project's `design-system.md` if one exists (global rule: design-system > skill).

---

## The stack (pinned — Laschuk's decision, do not deviate)

| Layer | Package | Why |
|---|---|---|
| Framework | `next` 16 (App Router, RSC) | route/metadata in server components; `"use client"` on anything with hooks |
| UI | `react` 19 | concurrent |
| Styling | `tailwindcss` v4 | `@import "tailwindcss"` + `@theme inline` (NOT v3 `@tailwind`) |
| Reveals | `framer-motion` | section reveals / springs — NOT the scroll hot-path (CSS transitions there) |
| Smooth scroll | `lenis` | physics smooth scroll, Safari-safe |

> Next 16 has breaking changes vs 13/14 — your training data may be stale. Read `node_modules/next/dist/docs/` before writing a route/metadata/image config. `"use client"` on every component using `useEffect`/`useRef`/`useState`/Framer — the #1 hydration bug is forgetting it.

**The engine is an isolated pure module.** Put the scroll→frame math (`scrollProgress`, `frameIndex`, `coverFit`, `lerp`) in a plain `lib/scrubEngine.ts` with **zero React/Next imports** — testable and portable. The component is a thin `"use client"` shell that wires DOM refs to the pure functions. Framework is pinned; the engine is framework-free.

---

## The production canvas engine (replaces the naive `<img>` swap)

The editor's wiring snippet is `<img>.src = frames/000X.jpg` per scroll tick — it flashes, no preload, no DPR, no RAF. Replace it with a `<canvas>` engine. **Five non-negotiables**, all from the market's proven build:

1. **`<canvas>` + `drawImage`, not `<img>.src`.** Decode once, draw the current frame. Cover-fit centered (manual `object-fit: cover`); on **mobile (≤768px) multiply draw W/H by 1.3** — the subject reads larger on small screens.
2. **RAF + ticking ref.** Never touch the canvas synchronously in the scroll handler. Guard one RAF at a time with `tickingRef.current`; do the draw inside it; clear the flag at the end. One scroll gesture fires 30+ events/frame — without the guard they stack and jank.
3. **Direct DOM on the hot path — zero React state per frame.** Canvas draw, text opacity, transforms — all via refs (`ref.current.style.opacity = …`). React `setState` is ONLY for discrete things that change at thresholds (which annotation card is visible), and only when the set actually changes.
4. **Preload ALL frames + a real loading bar** before enabling the scrub. A frame not yet loaded = blank canvas = broken-looking site. Drive a progress overlay off `loadedCount / N` (read `N` from the manifest). Await every `img.onload` before `loaded = true`.
5. **DPR scaling.** `canvas.width = innerWidth * devicePixelRatio` (internal res); `canvas.style.width = innerWidth + "px"` (display). Skip it → blurry on retina.

```tsx
// ScrubHero.tsx — "use client". The math lives in lib/scrubEngine.ts (pure).
const FRAMES = manifest.count;                          // N from the editor's manifest
const tickingRef = useRef(false), curRef = useRef(0);   // curRef = the LERPED index

const onScroll = () => {                                // passive listener
  if (tickingRef.current) return;
  tickingRef.current = true;
  requestAnimationFrame(() => {
    const target = scrollProgress(sectionRef.current);  // 0..1, pure
    curRef.current += (target * (FRAMES - 1) - curRef.current) * 0.1;  // lerp the index
    drawCoverFit(ctx, framesRef.current[Math.round(curRef.current)]);  // direct DOM
    heroTextRef.current.style.opacity = String(Math.max(0, 1 - target / 0.08)); // direct
    tickingRef.current = false;
  });
};
```

```tsx
// the sticky structure — outer vh section drives scroll, inner pins
<section ref={sectionRef} style={{ height: "var(--hero-vh)" }} className="scrub">
  <div className="sticky top-0 h-screen"
       style={{ willChange: "transform", transform: "translateZ(0)" }}>
    <canvas ref={canvasRef} className="h-full w-full" />
    {/* annotation overlays absolutely positioned here */}
  </div>
</section>
```

`scrollProgress = clamp(-rect.top / (section.offsetHeight - innerHeight), 0, 1)` → `frameIndex = round(progress * (N-1))`. **N frames is the scrub resolution** (90–180 desktop), so every scroll fraction lands on a real authored frame.

---

## Smooth scroll — Lenis + the index lerp (two smoothings, both matter)

Two distinct smoothings. Both ship:

1. **Lenis smooths the scroll POSITION** (physics inertia). Wrap the app in a `SmoothScrollProvider` client component before building the hero — the scroll math *feels different* with Lenis vs native, so get it in first. **Safari/iOS is the trap:** native Lenis defaults stutter on iPhone → bump `lerp` (≈0.1) and disable `syncTouch`. Without this the beautiful scrub janks on mobile Safari.
2. **The index lerp smooths the FRAME number** (the gap the text-only test flagged). Don't snap `frame = round(progress·(N-1))` straight from raw scroll — ease the index toward its target each RAF: `cur += (target - cur) * 0.1; draw(round(cur))`. Kills the per-tick stepping/jitter even when scroll is coarse. Drive the draw **per RAF**, not per scroll event.

```tsx
// SmoothScrollProvider.tsx — "use client"
<ReactLenis root options={{ lerp: 0.1, syncTouch: false /* iOS-safe */ }}>{children}</ReactLenis>
```

> Lenis exposes its own RAF loop; let the scrub's RAF ticking ref ride alongside it — no special bridge needed, just keep the canvas draw inside its own guarded RAF.

---

## Sizing — the scroll-length(vh) ↔ N-frames formula

The two numbers must agree or the scrub steps or drags. `N` comes from the editor (fixed by extraction); you set the **section height** to match — or, if you control extraction density, derive `N` from a chosen height.

- **Scrollable distance:** a `heroVh` section over a `100vh` viewport scrolls `(heroVh − 100)` viewport-heights → `scrollablePx = (heroVh − 100)/100 × innerHeight`.
- **Comfortable pace:** ~1 frame change every **~18px** of scroll (smooth, not steppy, not sluggish). So:

```
N  ≈  scrollablePx / 18                     # frames needed for a given height
heroVh ≈ 100 + (N × 18 / innerHeight) × 100  # height needed for a given N
```

- **Sane band:** **90–180 frames** desktop. At innerHeight ≈ 900: `300vh → ~150 frames`, `400vh → ~200` (cap 180), `200vh → ~90`. The market builds land 106 / 97 / 120 — same range.
- **Given the editor's N, solve for `--hero-vh`** and pin it. Responsive heights shrink the scroll on small screens: `400vh → 350vh (≤1024) → 300vh (≤768)`.

---

## Shots ↔ duration heuristic (how many SHOTS the director should plan)

`S` shots/beats ⇒ keyframes ⇒ Kling clips ⇒ one sequence (mode 3: plain concat of chained segments, no dissolve; mode 1: hard-cut concat; mode 2: single clip). Each shot is 2 keyframes (START+END), never more. This is the director/DP's call, but the builder sanity-checks the scroll length against it:

| Scroll feel (section height) | Recommended S shots |
|---|---|
| Single-object spin (one transformation, ~200–250vh) | 1 (START + END, single clip) |
| Standard scene (~300–400vh) | 3–5 shots |
| Epic / long scroll (~500vh+) | 5–7 shots |

More shots = richer scene but more generation (2 keyframes + 1 clip each). If the editor shipped `N` frames but the scene is really one monotone shot, the scroll drags (nothing changes) — surface it; don't paper over a one-shot arc with a tall section. Richness comes from more SHOTS, never more keyframes per shot.

---

## Perf hardening (the browser side — checklist)

Mirror the market's hot-path rules; this is what separates smooth from janky:

- [ ] **Passive scroll listeners** — `addEventListener("scroll", h, { passive: true })`.
- [ ] **RAF + ticking ref** — one queued callback per frame (above).
- [ ] **Direct DOM via refs on the hot path** — canvas/opacity/transform never through `setState`.
- [ ] **`setState` only when a discrete set changes** — diff the visible-card ids by sorted-string; skip if unchanged (threshold ~0.01 on opacity-like values).
- [ ] **Preload + loading bar** — all `N` frames decoded before the scrub is interactive.
- [ ] **DPR scaling** — internal `×devicePixelRatio`, CSS in px.
- [ ] **`will-change: transform` + `translateZ(0)`** on the sticky container/canvas — own GPU layer. Don't over-apply; each promoted layer costs GPU memory.
- [ ] **CSS transitions > Framer Motion on the scroll hot-path** — annotation cards toggle via `transition-all` classes, not `motion.div` (Framer's loop is heavier when toggling many times/sec). Framer is for one-shot section reveals only.
- [ ] **Production build tested** — `next build && next start`; some scroll bugs only show after build.
- [ ] **Lighthouse** — aim 85+ desktop / 70+ mobile.

---

## Mobile consumption fallback

The editor may ship a smaller mobile frame set; consume it:

- **Shorter section heights** — `350vh` (≤1024) / `300vh` (≤768) via CSS, so the scrub isn't an endless scroll on a tall phone page.
- **1.3× canvas zoom** — subject reads larger on small screens (in `drawCoverFit`).
- **Fewer frames if the manifest offers a mobile variant** — preload the lighter set (the sequence is the page's biggest payload; don't ship a 180-frame desktop set to a phone). If no mobile variant, downscale the desktop frames to the layout width at decode.

---

## Annotation / overlay (optional — scroll-synced storytelling)

Captions/cards that appear at scroll points over the hero (legible copy emerging as you scrub). **All crisp text lives HERE in code** — never in the generation (diffusion hallucinates type; the scrub contract keeps words out of the clip).

- Each card: a `show`/`hide` scroll threshold (`{ show: 0.10, hide: 0.30 }`). Only `setState` the visible set when it actually changes (diff sorted ids) — else you re-render every tick.
- Toggle with **CSS transitions** (`transition-all duration-400`, `translate-y` + opacity), not Framer — hot-path.
- **CSS gradient mask** to fade copy in from the hero: `mask-image: linear-gradient(to bottom, black 60%, transparent)`. (This composition vocabulary is shared with `overclock-site-scrub`; the builder applies it in code.)

---

## Hand off from the editor (the boundary)

The editor's `handoff_submit` gives you: `frames/` path + pattern, the manifest (`count` + pattern, + mobile variant if any), and the naive wiring snippet. You receive frames; you do NOT re-extract or re-encode. If the manifest is **missing or `count` is absent**, SURFACE it — never guess a frame count (a wrong `N` desyncs the whole scrub). Bounce to the editor for the manifest.

## Hand back

Via `handoff_submit`: the component path(s) (`ScrubHero.tsx`, `SmoothScrollProvider.tsx`, `lib/scrubEngine.ts`), the `--hero-vh` you pinned and the `N` it matches, the deps to install (Next 16 / React 19 / Tailwind v4 / framer-motion / lenis), and one line on what's delegated to the design skill (palette/type/shadows). Note any mobile-variant handling. State the dev command (`next dev`) and that a production build (`next build && next start`) was verified if you ran it.

## Capability gaps — surface, don't fake

- **No frame generation or encode here.** Missing/short `frames/` or a thin arc → bounce upstream (`overclock-site-scrub` / `overclock-site-encode`), don't synthesize frames.
- **No manifest → no safe `N`.** Don't guess the count; a wrong `N` breaks the scroll→index map. Require it.
- **Design tokens are not yours.** Palette/type/shadow/spacing → `frontend-design` / `premium-web-design` / the project `design-system.md`. This skill is the scroll engine, not the look.
- **`<video currentTime>` is the wrong consumer.** A scrub is an image sequence wired to a frame index (this engine), NOT an MP4 seeked on scroll (it lags). Background loops / hero clips still ship as `<video>` — but those aren't this skill's job.
