---
name: overclock-site-encode
description: "Use when a squad worker must ENCODE a generated clip for web delivery — transcode to mp4 (h264 +faststart) and webm (vp9), extract a poster PNG (first frame), strip audio (muted), make a background loop seamless, and emit hero aspects/sizes (16:9, 21:9, vertical). Bind to the site editor / executor worker that has Bash. Triggers: web encode, mp4 webm, faststart, poster frame, muted video, seamless loop, hero aspect, vp9 h264, ffmpeg web."
---

# overclock-site-encode — Web Delivery Encode (ffmpeg)

The worker that owns ffmpeg for **the web**. The render worker (`overclock-site-scrub`) produces a raw mp4; this skill turns it into the asset a browser actually wants: a small, fast-starting, muted, dual-codec hero with a poster frame. No NLE — raw ffmpeg, every time.

> **Layer split.** `overclock-site-scrub` owns generation (keyframes + Kling/Seedance motion). This skill owns **transcode + delivery**: codecs, faststart, poster, mute, loop seamlessness, aspect/size variants — and, **for a scrub hero, frame extraction into a numbered image sequence** (the scroll→frame-index deliverable; an embedded MP4 scrubbed by `currentTime` lags). It does not generate frames; it conditions the rendered mp4 for `<video>` (loops / hero clips) or extracts it into a sequence (scrub).

---

## What feeds in / what ships out

| In | Source |
|---|---|
| Raw clip mp4 (often with audio, not web-tuned) — **one per SEGMENT (mode 3) or per SHOT (mode 1); single clip for mode 2** | `overclock-site-scrub` via `handoff_submit` |
| Target format(s) | The brief: scrub hero / background loop / hero clip |
| Target aspect + size | The site layout (16:9, 21:9 cinematic, vertical 9:16) |

| Out |
|---|
| `hero.mp4` — h264, `+faststart`, muted (loops / hero clips) |
| `hero.webm` — vp9, muted (smaller; the modern `<source>`) |
| `hero-poster.png` — first frame (shown before the video paints / while it loads) |
| `frames/%04d.jpg` — **numbered image sequence (the scrub-hero deliverable; scroll → frame index)** |
| Optional aspect/size variants |

---

## Job 1 — The canonical web encode (mp4 + webm + poster, muted, faststart)

Run all three for every hero. The `<video>` gets both sources; the browser picks.

```bash
# 1. mp4 — h264, faststart (moov atom at front → starts before fully downloaded), MUTED
ffmpeg -i raw.mp4 \
  -an \
  -c:v libx264 -profile:v high -pix_fmt yuv420p \
  -crf 20 -preset slow \
  -movflags +faststart \
  hero.mp4

# 2. webm — vp9, MUTED (typically 20-40% smaller than the h264 at equal quality)
ffmpeg -i raw.mp4 \
  -an \
  -c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 \
  hero.webm

# 3. poster — first frame as PNG (the <video poster=...> placeholder)
ffmpeg -i raw.mp4 -frames:v 1 -q:v 2 hero-poster.png
```

- **`-an`** — strip audio. Web heroes are muted by contract (browsers block autoplay-with-sound anyway). Non-negotiable.
- **`-movflags +faststart`** — moves the moov atom to the file head so the browser can start playback / **scrubbing** before the whole file arrives. **Mandatory for a scrub hero** — without it, `currentTime` seeks stall waiting on the trailing moov.
- **`-pix_fmt yuv420p`** — the only chroma subsampling Safari/iOS will decode in a `<video>`. Skip it and the clip is black on iPhone.
- **`-crf 20` (h264) / `-crf 32` (vp9)** — visually-lossless-ish at a sane size. Raise CRF (smaller file) for background loops; lower it for a detail-heavy scrub.

The markup it targets:

```html
<video autoplay muted loop playsinline poster="hero-poster.png">
  <source src="hero.webm" type="video/webm">
  <source src="hero.mp4"  type="video/mp4">
</video>
```

> For a **scrub hero** drop `autoplay loop` and wire `currentTime` to scroll in JS; keep `muted playsinline poster` and `+faststart` (faststart matters *more* for scrub — every seek hits the moov).

---

## Job 2 — Seamless background loop

A background loop must not visibly jump at the wrap. Two levers, in order of preference:

**A. The clip was authored to loop** (last frame ≈ first frame — `overclock-site-scrub` did this). Then just encode; the wrap is already invisible. Verify:

```bash
ffmpeg -i raw.mp4 -frames:v 1 -q:v 2 first.png
ffmpeg -sseof -0.1 -i raw.mp4 -frames:v 1 -q:v 2 last.png
# eyeball first.png vs last.png — near-identical → seam is invisible
```

**B. Crossfade the wrap** (when the ends don't match). Overlap the tail back onto the head with a short xfade so the loop point dissolves:

```bash
# D = clip duration, X = crossfade seconds (e.g. 0.5). OFF = D - X.
ffmpeg -i raw.mp4 -filter_complex \
  "[0]split[a][b];[b]trim=start=${OFF},setpts=PTS-STARTPTS[tail];\
   [a]trim=end=${OFF},setpts=PTS-STARTPTS[head];\
   [head][tail]xfade=transition=fade:duration=${X}:offset=$(echo "$OFF - $X" | bc)" \
  -an looped.mp4
```

**C. JS fade system** (when the loop plays in `<video>` and the wrap still shows). Instead of an ffmpeg xfade, the *site* cross-fades the loop point: as the clip nears its end, fade opacity out and a second (or restarted) layer in, so the hard cut dissolves in the browser. This is the market's "seamless loop" trick for background video — it lives in the page, not the file:

```js
// seamless background loop — fade the last ~0.4s into the restart
const v = document.querySelector('#bg-loop'), FADE = 0.4;
v.addEventListener('timeupdate', () => {
  const left = v.duration - v.currentTime;
  v.style.opacity = left < FADE ? (left / FADE).toFixed(2) : 1; // fade out tail
});
v.addEventListener('seeked', () => { v.style.opacity = 1; });    // restored on loop restart
```

Prefer A — fix the seam at generation time (`overclock-site-scrub`), not in the edit. B (ffmpeg xfade) bakes it into the file; C (JS fade) is the in-page option when you can't re-render and want the dissolve to live with the site.

---

## Job 3 — Hero aspects & sizes

Heroes ship in a few shapes. Crop/scale from the source rather than re-generating when the content allows it (a center-safe composition crops cleanly).

```bash
# 21:9 cinematic letterbox-crop from 16:9 (crop, don't squash)
ffmpeg -i raw.mp4 -vf "crop=iw:iw*9/21" -an -c:v libx264 -crf 20 -movflags +faststart hero-21x9.mp4

# vertical 9:16 (center-crop a 16:9 source → mobile hero)
ffmpeg -i raw.mp4 -vf "crop=ih*9/16:ih" -an -c:v libx264 -crf 20 -movflags +faststart hero-9x16.mp4

# downscale to a delivery width (e.g. 1920 wide), preserve aspect, even dims for h264
ffmpeg -i raw.mp4 -vf "scale=1920:-2" -an -c:v libx264 -crf 20 -movflags +faststart hero-1920.mp4
```

- **`scale=W:-2`** — `-2` keeps aspect AND forces an even height (h264 requires even dimensions).
- **Crop, don't squash.** Changing aspect by scaling distorts the subject; `crop` keeps geometry. For an off-center subject, add `:x=...:y=...` to the crop.
- Common widths: `1920` (desktop hero), `1280` (tablet), `768` (mobile). Ship the size the layout uses, not a 4K file the browser downscales.

---

## Job 4 — Image-sequence for a scrub hero (scroll → frame index)

**The scrub hero ships as a numbered image sequence, NOT an embedded `<video>`.** A raw MP4 seeked by `currentTime` on every scroll tick stalls and lags in the browser — the market builders all converge on frame-scrubbing instead. Extract numbered frames from the clip(s); the page swaps frames by scroll position. This is the canonical scrub delivery; `<video>` is only for background loops / hero clips that just play.

**Extract numbered frames** from the rendered clip(s):

```bash
# one clip → a numbered sequence (zero-padded, ordered). fps controls frame count.
ffmpeg -i raw.mp4 -vf "fps=30,scale=1920:-2" -q:v 3 frames/%04d.jpg
# → frames/0001.jpg, 0002.jpg, … in strict order. DO NOT rename — the player indexes by number.

# MULTI-CLIP scrub: join per the MODE, THEN extract.

# Mode 3 (continuous oner — DEFAULT): plain concat of chained segments.
# Segments are already chained (end of seg k = start of seg k+1), so boundaries are
# seamless continuations — NO dissolve, NO xfade, NO cut needed.
ffmpeg -i seg0.mp4 -i seg1.mp4 -i seg2.mp4 -i seg3.mp4 \
  -filter_complex "[0][1][2][3]concat=n=4:v=1:a=0[v]" \
  -map "[v]" -an mode3.mp4
ffmpeg -i mode3.mp4 -vf "fps=30,scale=1920:-2" -q:v 3 frames/%04d.jpg
# → one continuous numbered run; scrolling through a boundary is a seamless continuation.

# Mode 1 (hard-cut montage): hard-cut concat (cuts are intended — each cut is a frame boundary).
ffmpeg -i shot0.mp4 -i shot1.mp4 -i shot2.mp4 -i shot3.mp4 -i shot4.mp4 \
  -filter_complex "[0][1][2][3][4]concat=n=5:v=1:a=0[v]" \
  -map "[v]" -an mode1.mp4
ffmpeg -i mode1.mp4 -vf "fps=30,scale=1920:-2" -q:v 3 frames/%04d.jpg
# → each cut is a sharp frame boundary in the numbered sequence.

# Mode 2 (simple oner): single clip — extract directly (nothing to join).
```

- **Frame count = the scrub resolution.** 90–180 frames is a smooth desktop scrub; fewer for mobile. `fps=N` or `-frames:v` sets it.
- **Strict numeric order — never rename.** The player maps scroll → index; a reorder breaks the arc.
- **JPEG, not PNG, for photographic frames** — far smaller; the sequence is the page's biggest payload. `-q:v 3` is visually clean; downscale to the layout width.
- **Emit a manifest** (frame count + path pattern) so the site can preload — the sequence must be fetched/decoded before the scrub is smooth.

**Wiring (scroll position → frame index):**

```js
// N frames at frames/0001.jpg … ; map scroll progress over the hero to a frame.
const N = 120, img = document.querySelector('#hero-seq');
function onScroll() {
  const p = Math.min(1, Math.max(0, scrollProgressOverHero()));   // 0..1
  const i = Math.round(p * (N - 1)) + 1;
  img.src = `frames/${String(i).padStart(4, '0')}.jpg`;
}
```

- **`<img>` swap** — simplest; set `img.src` per scroll frame (preloaded so no flash).
- **`<canvas>` `drawImage`** — smoother for high frame counts; decode once, draw the current frame.
- **Sprite sheet** — pack frames into a grid and shift `background-position`; one HTTP request, no per-frame fetch (good for ≤~60 frames).

> **Why this over `<video currentTime>`:** seeking an MP4 per scroll tick waits on keyframes and the moov atom → visible stall/lag. A decoded image sequence is random-access by index → frame-accurate, no stall. This is the lag fix the market discovered — heavy MP4 on scroll is the anti-pattern; image-sequence is the cure.

## QA before delivery

- [ ] **Muted** — `ffprobe` shows no audio stream (`-an` worked). Web autoplay needs it.
- [ ] **faststart** — moov at the head (`ffprobe -v trace ... 2>&1 | grep -n moov` shows it early); mandatory for scrub.
- [ ] **yuv420p** — `ffprobe ... -show_entries stream=pix_fmt` reads `yuv420p` (iOS playback).
- [ ] **Both codecs** — `hero.mp4` (h264) AND `hero.webm` (vp9) exist; webm is smaller.
- [ ] **Poster matches frame 1** — `hero-poster.png` is the clip's first frame (no flash between poster and play).
- [ ] **Loop seam invisible** (loops only) — first ≈ last frame, or the xfade wraps cleanly.
- [ ] **Even dimensions** — width and height both even (h264 will refuse odd dims).
- [ ] **Scrub sequence contiguous & ordered** (scrub heroes) — `frames/0001.jpg … NNNN.jpg`, no gaps, never renamed; a manifest (count + path pattern) ships for preload.

Quick probe:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,pix_fmt,duration \
  -of default=noprint_wrappers=1 hero.mp4
ffprobe -v error -show_entries stream=codec_type -of csv=p=0 hero.mp4   # must NOT list "audio"
```

## Hand back

Via `handoff_submit`: for loops/hero clips, the encoded paths (`hero.mp4`, `hero.webm`, `hero-poster.png`, any variants), the file sizes, and the `<video>` snippet; **for a scrub hero, the `frames/` sequence (count + path pattern + manifest) and the scroll→frame-index wiring snippet** instead of a `<video>` — and for a multi-clip scrub, note the MODE and join applied (Mode 3: plain concat of chained segments — no dissolve; Mode 1: hard-cut concat). Flag if a source clip wasn't authored to loop and you had to crossfade (re-render upstream is cleaner).

## Capability gaps

- **No HLS/DASH adaptive streaming** — single-file mp4/webm only. A multi-bitrate ladder is out of scope for a hero.
- **Crisp on-screen text is not encoded here** — it composites in code (CSS/Remotion) over the muted video; ffmpeg doesn't fix hallucinated type.
- **Crossfade-loop is a fallback, not a fix** — a seam that needs xfade means the clip wasn't authored to loop; prefer re-rendering with a cyclic motion in `overclock-site-scrub`.
