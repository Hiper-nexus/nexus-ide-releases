---
name: overclock-site-scrub
description: "Use when a squad worker must PLAN and GENERATE a scroll-driven web hero — a scrub clip the user plays by scrolling, a seamless background loop, or a short hero clip for a site. Owns the scrub contract (one continuous take, zero stillness, constant pace), the 2-KEYFRAME KLING technique (start_image + end_image interpolation via overclock_video_generate's endImageUrl) for a deliberate landing state, real-subject face-ref via imageUrl, and the web-motion anti-patterns. Bind to the site DP / director worker — NOT the orchestrator. Triggers: scrub hero, scroll-driven, scrollytelling, scrubbable, background loop, hero clip, web motion, scroll = time, keyframe interpolation, start/end frame, Kling."
---

# overclock-site-scrub — Scroll-Driven Web Motion

The craft skill for **web motion**: heroes the visitor plays by *scrolling*, seamless background loops, and short hero clips. This is a different animal from narrative video — there are no cuts, no scene arc, no stillness bookends. Scroll position IS the timeline. Every frame must earn its scroll distance.

> **Decide the MODE first (see the three-modes table below).** A scrub is either HARD-CUT (mode 1: separate clips, edited cuts) or CONTINUOUS (mode 2: one simple transformation; mode 3: a continuous take through several different beats). The rich default for a brand scene is **mode 3 — a continuous oner that travels through N genuinely different beats** (room → hands → pour → cup → crema), no cut, no dissolve, held together by one flowing camera journey. ZERO stillness throughout. The two failures to avoid: (a) slicing ONE transformation into N "shots" (= "5 frames of the same shot"); (b) inventing a cross-dissolve — it's neither cut nor continuity, it doesn't exist here.

---

## What a scrub hero IS

A **scrub hero** is a **numbered image sequence wired to scroll**: scroll position maps to a *frame index* (`frameIndex = round(scrollFraction * (N - 1))`) and the page swaps `frames/0042.jpg` into an `<img>`/canvas as you scroll. **It is NOT an MP4 embedded in `<video>` with `currentTime` driven by scroll** — a raw clip seeking on every scroll tick stalls and lags in the browser (the market builders all hit this and all converge on image-sequence; see `overclock-site-encode`). The clip(s) you generate are an *intermediate* you extract frames FROM; the web deliverable is the numbered sequence. It is consumed **frame-by-frame**, so:

- **Every position on the timeline must show a different, meaningful frame.** Each scroll fraction lands on a real, ordered frame in the sequence.
- **Mode 3 (default) = continuous oner through N different beats.** N beat-keyframes (each a genuinely different framing/subject/scale), connected by ONE flowing camera journey; Kling chains the segments (beat k → beat k+1) so the boundary is a seamless continuation, not a cut or dissolve. (Mode 1 = hard cuts between separate clips; mode 2 = one simple transformation, 2 keyframes.)
- **ZERO stillness — throughout.** A held pose or "nice tableau" is dead scroll. The camera/subject advances frame-to-frame the whole length; no stillness bookends (that's a narrative-cut habit, wrong for scroll).
- **Constant velocity.** Scroll distance feels linear, so motion advances at roughly constant pace across the whole take. No pause, no return-to-start, no loop, no ease that stalls mid-beat.

> **Scrub failure smell:** "tosca, parada, sem ação" — a lame static scene. If the reviewer can pause anywhere and it reads identical to any other moment, it cannot be scrubbed. A clip described as "she stands in the server room, lights glowing" is **one frame stretched to N seconds** — re-plan as a continuous progressive motion before generating.

### The three web-motion formats

**A scrub hero is ONE of THREE modes. The director picks by ONE question: hard cut, or continuity?**

| Mode | Cut? | Wiring / realization | Keyframes |
|---|---|---|---|
| **1 — Cut montage** | HARD cuts | N **independent** clips, hard-cut in the edit, extracted into one numbered sequence (each cut is a frame boundary) | each shot = 2 keyframes (START+END), N shots ⇒ 2N keyframes, N clips |
| **2 — Simple oner** | no — continuity | ONE continuous transformation of one subject; 1 clip, Kling interpolates START→END | **2** (START + END) |
| **3 — Multi-beat oner (DEFAULT for a rich scene)** | no — continuity | ONE continuous take traveling through N **different** beats; N beat-keyframes (each img2img ← the scene-key for grade), N−1 Kling segments **CHAINED** (end of seg k = start of seg k+1 = the shared keyframe), concatenated with NO dissolve, NO cut → one continuous journey | **N** beats (kf1…kfN) |
| **Background loop** | n/a | `loop muted autoplay playsinline` | seamless: last ≈ first |
| **Hero clip** | n/a | `autoplay muted playsinline` (plays once) | one sustained motion |

All scrub wiring = numbered image sequence (`frame = round(scrollFraction·(N−1))` → `<img>`/canvas swap). The **decision rule:**
- **Hard cut wanted?** → Mode 1 (separate clips, edited cuts).
- **Continuity, one simple transformation?** (café from bean to glowing) → Mode 2 (2 keyframes).
- **Continuity, several different beats?** (a continuous camera journey: shoulder → flying → landing; or café: room → hands → pour → cup → crema) → **Mode 3** — the rich default for a brand scene.

> **There is NO cross-dissolve mode.** A scrub is either HARD-CUT (mode 1) or CONTINUOUS (modes 2/3). Cross-dissolve is neither — do not introduce it.

This skill plans and generates all of these. The **encode** for web — mp4+webm + poster (muted, faststart) for loops/hero clips, and **frame extraction → numbered image sequence** for the scrub — is `overclock-site-encode`.

---

## WRITE THE EXECUTION PROMPT FIRST (Layer-2) — before any generate call

> **The #1 process failure.** A scrub goes from brief straight to `overclock_image_generate` with a thin one-line prompt → weak keyframes → a lame, static-feeling hero. **Never fire a media tool with a one-liner. You author the full cinematic execution prompt first, show it, THEN generate.** This mirrors the cinema crew's Layer-2 discipline: Layer-1 is the prose brief ("a notebook opening into a living code world"); **Layer-2 is the shot-grade execution prompt** — and the gen tool only ever receives Layer-2.

The craft vocabulary for Layer-2 is **`overclock-cinema-shot`** — its camera-move catalog (~70 named moves), lens / shot-size ladders, lighting vocabulary, color-grade table, and the lint gate. Pull from it. Do not reinvent prompt craft; this skill owns the *web-motion contract*, cinema-shot owns the *prompt string*.

**Before generating ANYTHING, write and SHOW three execution prompts:**

1. **START keyframe prompt (the 0% state).** Full image prompt: shot size + angle + subject + setting + lighting + color grade. Concrete, branded, no cliché.
2. **END keyframe prompt (the 100% state).** Written as an img2img edit off START — name only what has *changed/advanced* (camera pushed through, light risen, world ignited). Same world, dramatically later.
3. **MOTION prompt (the video).** The transition only: the **named camera move** (from cinema-shot's catalog), lens/shot-size note, what advances monotonically between the two frames, color grade. NO re-description of the static composition (the keyframes pin it).

Each prompt names, explicitly: **camera move (named)** · **lens / shot-size** · **lighting** · **composition** · **color grade** · and for the pair, **the START↔END arc in one line**. Run the cinema-shot **lint gate** on every prompt before firing.

```
Phase 1a — AUTHOR (no tool calls): for EACH shot write its START prompt, END prompt, MOTION prompt
           (+ the scene-key prompt for a montage). Show them all. Lint each.
Phase 1b — GENERATE: [montage] scene-key first; then per shot: kf_start (img2img ← scene-key),
           kf_end (img2img ← kf_start).  [1-shot] kf_start (fresh/anchored), kf_end (img2img ← kf_start).
           Exactly 2 keyframes per shot — never 5. STOP for human approval of all keyframes.
Phase 2  — MOTION: on approval, ONE Kling clip per shot:
           overclock_video_generate(imageUrl=kf_start, endImageUrl=kf_end, prompt=MOTION). N shots ⇒ N clips.
```

**Hard rule: never dispatch `overclock_image_generate` / `overclock_video_generate` with a 1-line prompt. Write the cinematic execution prompt (Layer-2) first, show it, lint it, then fire.**

---

## THE ARC MUST BE A TRANSFORMATION — start ≠ end (the dramatic-arc rule)

A scrub where 0% and 100% read as the *same shot slightly adjusted* (e.g. "a notebook, lid a bit more open") is a **failed arc** — there is nothing to scrub. START and END must be **visibly, dramatically distinct**: a different lighting state, a different scale, a different world revealed. The viewer scrubbing from top to bottom must feel a real cinematic *transformation*, and one **marked camera move** must carry it.

**The arc needs BOTH:**
1. **A visual transformation** — the END is a different visual state, not a different angle. Light: dark → blazing. Scale: exterior object → inside it. State: dormant → alive/ignited/assembled.
2. **A marked camera move** that does the traveling — pick ONE, named (cinema-shot catalog): **push-through into the screen** (`Through Object In`), **crash-zoom** onto the core, **crane reveal** rising over the world, **dolly through the gap/seam of light**. Not a timid "slow push-in" — a move with a destination.

**Three strong-arc examples (use as templates):**

| 0% (START) | Camera move | 100% (END) |
|---|---|---|
| A closed dark laptop on a desk, single cold rim of light along the lid seam, near-black frame | **Dolly through the seam of light** (`Through Object In`) — camera dives into the widening crack | Camera has plunged *through* the screen into a vast living world of warm flowing code-light; the dark desk is gone |
| Extreme-wide: a tiny figure at the mouth of a black server corridor, one distant cyan glow | **Crash-zoom + crane down** the corridor toward the glow | Tight on the glowing core, the corridor walls now blazing data-streams rushing past — scale collapsed from EWS to CU |
| A single dormant component on matte concrete, flat overcast light | **Push-through / macro dive** into the component | Inside an intricate luminous machine mid-assembly, parts locking together, light building cold→warm |

Each START↔END is a genuine transformation, not a lid angle. The camera move is the spine; the world-change is the payload. Pin both endpoints as keyframes (2-keyframe Kling below) so the dramatic landing is authored, not hoped for.

---

## HOW EACH MODE IS REALIZED (the spine)

> **DECIDE THE MODE FIRST — hard cut, or continuity?** (full table at the top.) Then NEVER slice ONE transformation into N "shots": a concept that is one continuous transformation of one subject (espresso pouring; a bean dissolving; a logo forming) is **mode 2 — 1 shot, 2 keyframes**, and Kling interpolates it. Cutting it into "5 shots" makes 5 near-identical frames = **"5 frames pro mesmo shot"** (the café "O Rito" failure). Several **genuinely different** beats (room → hands → pour → cup → crema) = mode 1 (cut) or **mode 3 (continuous oner)**. **Distinctness test: if two beats could be frames of the same continuous zoom, they are the same beat.**

> **CARDINAL RULE — a render is never more than 2 generations from the scene-key, and you scale by adding BEATS/SHOTS, never keyframes-per-shot.** Mode 2 = 2 renders. Mode 1 = 2 keyframes × N shots. Mode 3 = N beat-keyframes. Rendering 5 stills of ONE shot is the wasteful drift-prone mistake.

**The scene-key fixes the GRADE (every mode).** Generate it FIRST (`overclock_image_generate`, fresh; real face → anchor to the real photo via `imageUrl`): subject identity, palette, lighting language, aspect. Every keyframe is img2img **off the scene-key** (depth ≤ 2; for an END frame in mode 1/2, off its own START). **NEVER daisy-chain a keyframe off another beat's frame** — that's the drift that collapsed the café into AI-slop. The scene-key is what makes N different beats read as ONE world.

### Mode 3 — multi-beat continuous oner (the rich default)

```
scene-key                         (fresh — grade: identity, palette, light, aspect)
  ├─ kf1 = img2img ← scene-key    (beat 1 framing — e.g. WIDE room)
  ├─ kf2 = img2img ← scene-key    (beat 2 framing — e.g. MEDIUM hands)   ← each beat off the scene-key, NOT off kf1
  ├─ …
  └─ kfN = img2img ← scene-key    (beat N framing)
segments (CHAINED, continuity): seg_k = Kling(imageUrl=kf_k, endImageUrl=kf_{k+1})
  → end frame of seg_k = start of seg_{k+1} = the shared keyframe kf_{k+1} (the continuity bridge)
```

1. **Order the beats so the camera can physically TRAVEL between them** (room → push to counter → down to the pour → up to the cup → down onto the crema). Consecutive beats must be camera-connectable — that's what makes Kling's interpolation read as one believable journey, not a morph.
2. **Generate N beat-keyframes, each img2img off the scene-key** — different framing/subject/scale per beat, same grade. (Depth 1 from the scene-key — even safer than mode 1's depth 2.)
3. **Chain N−1 Kling segments.** `seg_k = overclock_video_generate(imageUrl=kf_k, endImageUrl=kf_{k+1}, prompt="<the camera move that CONNECTS beat k → k+1>")`. The shared keyframe is the continuity bridge — seg_k lands exactly where seg_{k+1} starts.
4. **Editor concatenates the segments with NO dissolve and NO cut** (`overclock-site-encode`) — because the bridges already align, it's plain concat → one continuous numbered run `0000.jpg … NNNN.jpg`.
5. **Wire scroll → frame index.** `frameIndex = round(scrollFraction * (N-1))`; swap the `<img>`/canvas. The whole scroll is one continuous camera flight through the brand world.

### Mode 1 — cut montage (separate clips)

Each shot is independent: `shot_start` (img2img ← scene-key) + `shot_end` (img2img ← its own `shot_start`) + ONE Kling clip per shot. The editor HARD-CUTS the clips in sequence (each cut is a frame boundary) and extracts one numbered run. Use when a punchy, edited feel is wanted over continuity.

### Mode 2 — simple oner (one transformation)

`kf_start` (fresh or img2img ← scene-key) + `kf_end` (img2img ← kf_start) + ONE Kling clip. Kling interpolates START→END. The honest execution of a single continuous transformation — 2 renders, never 5.

> **Why this kills the old bugs:** every keyframe is ≤ 2 generations from the scene-key (no cumulative drift → no AI-slop collapse), beats are genuinely different (no "5 frames of the same shot"), and continuity (mode 3) is generated by Kling's chained interpolation, not faked by a dissolve.

---

## THE 2-KEYFRAME KLING TECHNIQUE (controlled motion for ONE shot)

This is how you generate the controlled motion for **one shot/beat** — the in-between frames between its START and END keyframes. ONE clip per shot/beat; a multi-shot scrub chains N of these, joined per MODE by the editor (mode 3: plain concat of the chained segments, no dissolve; mode 1: hard-cut concat). It is **possible** because `overclock_video_generate` has an `endImageUrl` param.

> `overclock_video_generate(prompt, imageUrl, endImageUrl, outPath)`
>
> Kling models (`kwaivgi/kling-v3-video`, `kling-v3-omni`, `kling-v2.1`) accept **start_image + end_image** and interpolate a **controlled** motion from the start frame to the end frame. Pass BOTH `imageUrl` (START) and `endImageUrl` (END) and the model lands on a **deliberate** final state — no drift, no pop-in, no random ending. `endImageUrl` is **ignored by non-Kling models**.

**The flow (use this for any scrub or hero you care about):**

```
1. Generate keyframe START  → overclock_image_generate → start.png   (the 0% state)
2. Generate keyframe END    → overclock_image_generate(imageUrl=start.png, ...)  → end.png
       img2img FROM the start so look/identity/framing carry → the END is the SAME world, advanced
3. Generate the motion      → overclock_video_generate(
                                  imageUrl=start.png,
                                  endImageUrl=end.png,
                                  prompt="<ONLY what MOVES between the two frames>")
```

**Why end.png is img2img of start.png, not a fresh gen.** The two keyframes must be the *same world* in two states — same subject, same palette, same lens, same set, advanced. Generating END fresh (text-to-image) re-rolls identity and framing, and the interpolation then morphs across two different worlds. Anchor END to START with `imageUrl=start.png` and change only the one thing that progresses (the camera has pushed in; the machine has assembled; the light has risen; the logo has formed).

**The prompt describes only the MOVEMENT.** Both endpoints are already pinned by the keyframes. The prompt is the *transition* — "slow continuous push-in; the structure assembles piece by piece; light builds from cold to warm." Do NOT re-describe the static composition of either frame — that fights the keyframes and causes the model to restage.

> **Result:** a clip that starts at a frame you chose, ends at a frame you chose, and moves between them in a controlled, monotonic arc — ONE realized shot/beat. For a mode-2 spin, that single clip IS the whole scrub. For mode 3, generate one segment per beat-pair (kf_k→kf_{k+1}) and the editor plain-concats the chained segments into one numbered sequence (no dissolve — the bridges already align); for mode 1, the editor hard-cut-concats the per-shot clips. That extraction, not a single embedded MP4, is the web deliverable.

**When you only have a start (no defined end):** pass `imageUrl` alone with a strong continuous-motion prompt. You get a monotonic arc but the landing is the model's choice — acceptable for a background loop, risky for a scrub where the final frame matters. Prefer two keyframes whenever the end state is load-bearing.

---

## Real subjects — face via imageUrl, video via Kling

When the hero features a **real person** (a founder, a face from a photo):

1. **Anchor the face.** Pass the real photo (or a generated character still) as `imageUrl` — the START keyframe carries the identity. Never describe a real face in text-to-video and hope; it will not be that person.
2. **Video provider = Kling.** Kling animates a real face cleanly. **Seedance moderates real faces and returns E005** ("content moderation" / face rejection) — do not route a real-subject clip to Seedance. (Seedance is fine for object/product/abstract heroes with no face.)
3. **Identity stays in the keyframes, motion stays in the prompt.** Same split as the cinema crew: the PNG carries the face; the prompt carries only what moves. Re-reading face descriptors mid-clip morphs the face.

| Subject in the hero | Image provider for keyframes | Video provider |
|---|---|---|
| Real person / real face | `openai-image` or `google-image` for the still, anchored to the real photo via `imageUrl` | **Kling** (`replicate-video`) — animates real faces, no E005 |
| Product / object / abstract / type / UI | either image provider by look | Seedance OR Kling (Kling if you want 2-keyframe control) |

> The squad's configured `videoProvider` is `replicate-video`; **Kling is the model you select within it.** **CHECK the real model before flagging anything: call `overclock_media_providers` and read the video provider's `selectedModel` + `enabledModels` (real model ids — never guess the code default).** If a Kling model is already enabled, there is NO gap — state it to the render worker so `endImageUrl` is honored, and shoot. **Use only enabled models — only SURFACE a gap when the enabled model genuinely can't do the shot (e.g. you need `endImageUrl` 2-keyframe interp but no Kling is enabled); never silently substitute a different Kling version (or any other model).** "Available" ≠ "enabled", and "enabled Kling already present" ≠ "blocker": don't invent a "switch your model" gap against a model you never checked.

---

## Camera = ONE continuous movement that never stops

The camera is the spine of scrub legibility. **One** smooth, continuous move, constant speed, never parking:

- **push-in / dolly-in** — depth builds as you scroll.
- **dolly / truck (lateral)** — the world slides past.
- **parallax push-through** — foreground and background separate at different rates (reads as the strongest "scroll = travel").
- **slow orbit / arc** — reveals a subject's form around a continuous angle.
- **crane up / down** — vertical reveal.

Never stack moves (no "push-in then whip-pan") — that's two takes pretending to be one, and it breaks the constant-velocity feel. Never let the camera stop — a parked camera mid-scrub is dead scroll.

The **subject motion** (if any) builds monotonically alongside the camera: assembly, reveal, transformation, approach, ignition, growth. It only ever advances; it never returns to start.

---

## Anti-patterns (these are process failures for web, kick them back)

| Anti-pattern | Why it's wrong for web | Fix |
|---|---|---|
| **Static / "nice tableau" scene** | Nothing to scrub — dead scroll the whole length | Re-plan as a continuous progressive motion (camera + subject both advancing) |
| **Weak arc — START ≈ END** (e.g. "lid opens a bit more") | Same shot lightly nudged → no transformation to scrub | Make 0% and 100% dramatically distinct (light/scale/world change) + ONE marked camera move — see the dramatic-arc rule |
| **Thin one-line prompt fired at the tool** | Brief→gen with no Layer-2 → weak keyframes, flat hero | Author the full execution prompt (camera move named, lens, lighting, composition, color grade) FIRST, show it, lint it, THEN generate |
| **Slicing ONE transformation into N "shots"** | 5 stills of the same subject/move = "5 frames pro mesmo shot" — flat, monotone, AND daisy-chains to AI-slop (the café "O Rito" failure) | One transformation = mode 2 (1 shot, 2 keyframes). For richness use DIFFERENT beats (mode 3), never N slices of one |
| **Daisy-chain across renders (a beat ← another beat's frame)** | Drift accumulates; by the 4th–5th generation the world pops to a different style/aspect (café KF4 → abstract glitter) | Depth ≤ 2: every keyframe ← the scene-key (an END ← its own START). No beat is generated off another beat |
| **Cross-dissolve between shots** | A dissolve is neither a hard cut nor true continuity — it's a fake that doesn't exist in this model | Mode 1 = HARD cut (separate clips). Mode 3 = CONTINUOUS (chained Kling segments, no dissolve). Pick one |
| **Beats that aren't camera-connectable (mode 3)** | If consecutive beats can't be joined by a believable camera move, Kling morphs instead of travels | Order beats as a physical camera journey (room → counter → pour → cup → crema); each pair connectable |
| **One monotone take for a brand SCENE** | A single push on one subject can't carry a story; reads cheap | Mode 3: a continuous oner through several DIFFERENT beats. One-take (mode 2) only for a literal single transformation |
| **MP4 embedded in `<video>` scrubbed by `currentTime`** | Raw clip seeks on every scroll tick → stall/lag in browser | Web output = numbered image sequence (scroll → frame index); the MP4 is an extraction intermediate |
| **Pop-in of discrete elements** | Elements blink into existence → reads broken, not authored | Use 2-keyframe Kling so elements are present/forming in both frames and interpolate smoothly |
| **Hacker-hoodie / Matrix-rain / generic "tech" cliché** | Templated AI-slop look; signals low effort | Brief a specific, concrete, branded world — real set, real light, real subject |
| **t2v with no anchor (text-to-video, no imageUrl)** | Subject drifts; a real face won't be the person; the end is random | Always anchor: `imageUrl` start (+ `endImageUrl` end for control) |
| **Stillness bookends (cinema habit)** | Held start/end = dead scroll range at the most-seen scrub positions | Motion frame 1 → last frame; zero held moments |
| **Loop that returns to start mid-clip** | Scrub jumps backward; reads as a glitch | Monotonic arc only; for a *background* loop, make last frame ≈ first frame via gentle cyclic motion, not a hard return |
| **Wrong join for the mode** | Mixing modes (a dissolve, or a cut inside a continuous oner) breaks the read | Mode 1 = hard cuts (intended). Mode 3 = continuous, chained segments, NO cut and NO dissolve. Never blend the two |

---

## Self-check before you fire (the scrub lint)

Before spending a generation, confirm:

- [ ] **Execution prompt written first** — the full Layer-2 prompt (camera move named, lens/shot-size, lighting, composition, color grade) is authored and shown BEFORE the tool call. No one-liners.
- [ ] **Dramatic arc** — START and END are visibly distinct (light/scale/world change), not the same shot nudged. One marked camera move carries the transformation.
- [ ] **Mode chosen (1/2/3)** — hard cut (mode 1), simple oner (mode 2), or multi-beat continuous oner (mode 3, the rich default). NOT a cross-dissolve (doesn't exist here).
- [ ] **Right keyframe count for the mode** — mode 2 = 2 keyframes; mode 1 = 2 per shot (2N); mode 3 = N beat-keyframes. NEVER 5 stills of one shot.
- [ ] **Distinct beats (mode 1/3)** — beats are genuinely different (framing/subject/scale); the distinctness test passes (two beats can't be frames of the same zoom). For mode 3, consecutive beats are camera-connectable.
- [ ] **Anchor depth ≤ 2 (no daisy-chain)** — every keyframe = img2img off the **scene-key's path** (an END off its own START). No keyframe is generated off another beat's frame. If it was, regenerate off the scene-key.
- [ ] **Web output = image-sequence (not embedded MP4)** — the scrub deliverable wired to scroll is a numbered frame sequence (`frame = round(scrollFraction·(N−1))` → `<img>`/canvas swap), NOT an MP4 in `<video>` with `currentTime` on scroll. The MP4(s) are intermediates to extract frames from.
- [ ] **One camera move, never parked** — a single named continuous move at constant speed.
- [ ] **Monotonic** — nothing returns to its start; the arc only advances.
- [ ] **Anchored** — `imageUrl` set (real face → the real photo); for a load-bearing landing, `endImageUrl` set too (img2img of start).
- [ ] **Right video provider** — real face → Kling (Seedance = E005); object → either.
- [ ] **Prompt = motion only** — no re-description of the static composition the keyframes already pin.
- [ ] **No crisp on-screen text** — no wordmark, headline, or number (e.g. "R$1M ARR") anywhere in the START / END / MOTION prompt. Diffusion hallucinates type; ALL crisp copy composites in code (CSS/Remotion) over the muted clip. If the brief carries copy, keep it OUT of the generation.
- [ ] **Aspect pinned to the declared target** — the START keyframe is generated at the director's declared aspect (e.g. 16:9). If it returns another ratio (portrait/square), regenerate at the right aspect BEFORE the END and the video — never carry a wrong aspect into the expensive motion gen.
- [ ] **No cliché** — no hoodie/Matrix-rain/generic-tech; a concrete branded world.
- [ ] **Muted by design** — web heroes are silent; no audio plan here (encode strips it anyway).

---

## Web-motion composition vocabulary (in-code, over the hero — no new generation)

Beyond the scrub itself, the market hero look is finished with cheap **code composition** over the muted clip/sequence — no extra gens, applied by the editor. Know these and call them out in the plan:

- **CSS gradient mask on the hero** — the bottom of the hero fades solid→transparent and the overlaid copy "emerges from nothing" as you scroll (fake-3D depth + legibility). `mask-image: linear-gradient(to bottom, black 60%, transparent)`. This is also **where crisp text lives** (diffusion can't render type) — headline/wordmark/ARR counter composite in code over the masked hero, never in the generation.
- **Hover reveal mask (spotlight)** — a second video/sequence sits under a radial mask that follows the cursor (`mask: radial-gradient(circle at var(--mx) var(--my), black 0 120px, transparent 121px)`), revealing a hidden state under the pointer. A web-motion *format* beyond scrub — brief it explicitly when the hero wants interactive reveal.
- **Seamless loop via JS fade** — for a *background loop* whose wrap still shows, the site fades the tail into the restart (no hard cut). The technique lives in `overclock-site-encode` (Job 2, option C) — name it in the plan; the editor wires it.

> All three are **composition, not generation** — they cost no credits and run over what's already rendered. The DP plans them; the editor applies them. Keep ALL crisp text in this layer.

## Hand back

Via `handoff_submit`: the MODE (1/2/3), the mp4 path(s) in order, the scene-key PNG + all keyframe PNG paths (in shot/beat order), the final motion prompt(s), the video model used (Kling vs Seedance) and why, and one line per shot/beat (framing + move + what advances). The **encode to web formats** — and for a scrub, the **per-MODE concat (mode 3: plain concat of chained segments, no dissolve; mode 1: hard-cut concat) + frame extraction into a numbered image sequence** (the scroll→frame-index deliverable) — is the next worker's job — see `overclock-site-encode`.

## Capability gaps — surface, don't fake

- **`endImageUrl` is Kling-only.** A Seedance render silently ignores it — you get start-anchor-only drift. If you need a controlled landing, you MUST use a Kling model.
- **Seedance rejects real faces (E005).** Not a prompt problem — a moderation gate. Route real-subject clips to Kling; don't retry Seedance.
- **Image providers are text-to-image / img2img** — `imageUrl` is the only image input. There is no inpaint/mask call; refine a keyframe by re-prompting (tighten one clause, regenerate).
- **No crisp on-screen text in the clip.** Diffusion hallucinates type. A scrub with a wordmark/headline composites the text in code (CSS/Remotion) over the muted clip — keep words out of the generation.
- **A scrub's web output is a numbered image sequence, not a `<video>`.** Embedding the MP4 and scrubbing `currentTime` lags/stalls in the browser; extract frames (`overclock-site-encode`) and wire scroll→frame index. The MP4(s) are intermediates. (Background loops / hero clips still ship as `<video>` — only the scrub is a sequence.)
