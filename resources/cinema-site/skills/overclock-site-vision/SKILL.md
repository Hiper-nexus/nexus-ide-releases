---
name: overclock-site-vision
description: "Use when a squad worker must DIRECT a web hero scene creatively — decide what the scene SHOULD BE before any keyframe is planned or any media is generated. Owns the scene-director contract: fights the three observed failures (FROZEN / ONE-EFFECT / LAME), demands continuous motion at every scroll %, real depth layers, and one distinctive central idea, then proposes 1–3 rich concepts behind a human approval gate and hands the chosen vision to the technical director. Bind to the site CREATIVE / scene-director worker — NOT the orchestrator, NOT the DP. Triggers: scene direction, creative direction, hero concept, what should the scene be, the vision, mood board, depth layers, motion plan, distinctive idea, concept gate."
---

# overclock-site-vision — Web Hero Scene Direction

The **creative** skill for a web hero: deciding **what the scene should BE** before anyone plans a keyframe or fires a generation. This runs FIRST — ahead of `overclock-site-scrub` (the technical plan). It owns the VISION; the director owns the keyframe/camera PLAN; the DP owns the prompt STRING. Don't reach downstream — you decide the idea, the layers, the motion intent, the mood. You hand a vision; the technical director must honor it.

> **Why this skill exists — the real pain.** A hero handed straight to the technical director comes back **TOSCA: something frozen, with just one effect.** The pipeline jumped brief → technical plan with nobody DIRECTING the scene. Result: thin, static, generic — a subject + a glow. This skill is the missing director. It does not produce keyframes or prompts; it produces the **vision** the rest of the crew executes against.

---

## The three failures you fight (every concept must defeat all three)

| Failure | What it looks like | The cure this skill enforces |
|---|---|---|
| **FROZEN** | Scene holds; you scroll and almost nothing changes — dead scroll | **Continuous motion at EVERY %.** The scrub must *breathe* from 0→100. Primary motion (the main transformation) AND secondary motion (ambient: particles, parallax, drift, reflection, atmosphere) running at all fractions. Nothing static anywhere. |
| **ONE-EFFECT** | A single element + a single effect (one glow, one fade) | **LAYERS + depth.** Foreground / midground / background, each alive. Secondary/ambient action. A scene, not a sticker — real spatial depth, multiple things moving at different rates. |
| **LAME (tosca)** | Generic, no idea, flat light, no feeling | **A distinctive CENTRAL IDEA** + deliberate light/color/mood + an emotional/narrative arc. "How the scene *should be*", not "the subject + 1 effect." Concrete, branded, intentional. |

> **The smell test:** pause the scene at any random scroll position. If it reads identical to any other moment → FROZEN, redesign. If it's one thing doing one thing → ONE-EFFECT, add layers. If it could be any company's hero → LAME, find the idea.

---

## What a concept MUST contain (the vision spec)

Each concept you propose is a complete scene vision — five parts, all required:

1. **Central idea** — the ONE distinctive thing this scene is *about*. A concrete, branded world with a point of view. Not "a tech hero"; e.g. "a dormant machine waking and assembling itself as you descend into it." If you can't say it in one vivid sentence, it's still LAME.
2. **Depth layers** — name the **foreground**, **midground**, **background**, and what lives/moves in each. This is how you defeat ONE-EFFECT: at least three planes, each with its own life.
3. **Motion plan per %** — for 0 / 25 / 50 / 75 / 100%, name the **primary motion** (the main transformation advancing monotonically) AND the **secondary/ambient motion** (parallax, particles, light drift, reflections) active at that fraction. Every % must have motion in BOTH channels. This is how you defeat FROZEN.
4. **Mood / palette / light** — the emotional register, the color story (cold→warm, night→ignition), the lighting design (rim, volumetric, bloom). Deliberate, not default. This is how you defeat LAME.
5. **Vibe reference** — one line: the feeling/look to aim at (a film, a brand, an Awwwards mood). Reference taste; delegate the fine aesthetic to `frontend-design` / `premium-web-design` — don't duplicate their craft here.

---

## The output: 1–3 concepts → human gate → hand the chosen vision

```
Phase 1 — DIRECT (no tool calls): write 1–3 full concepts (each: idea · layers · motion-per-% · mood/palette/light · vibe ref).
          Run the three-failure check on each. Drop any that can't defeat all three.
Phase 2 — GATE: show the concepts. STOP for the human to PICK one (or merge / redirect). Never proceed on your own judgment.
Phase 3 — HAND OFF: handoff_submit the ONE approved concept in full, framed as "what the scene MUST be" —
          the spec the technical director's keyframe/camera plan must HONOR (layers, motion-at-every-%, the distinctive idea).
          Explicitly: the director must NOT regress to thin/frozen/one-effect.
```

- **1–3, not more.** Each concept is rich, not a one-liner. Three sharp visions beat ten thin ones.
- **The gate is the human's, not yours.** The vision is a product decision; you surface options, the human chooses.
- **You hand a VISION, not a plan or a prompt.** No keyframe count, no camera-move name, no lens, no hex, no shot-size — that's the director and DP. You own idea / layers / motion-intent / mood.

---

## Discipline (stay in your lane)

- You DIRECT, you don't PLAN or GENERATE. Keyframes/camera/aspect → `overclock-site-director` (via `overclock-site-scrub`). Prompt strings & gens → the DP. Encode → editor. Build → builder.
- Reference, don't reinvent, fine aesthetics — pull taste from `frontend-design` / `premium-web-design`, name the vibe, and let those skills own palette/type/shadow craft downstream.
- A concept that fails the three-failure check NEVER reaches the human — redesign it first. Frozen, one-effect, or generic is a process failure at THIS stage, before a credit is ever spent.
