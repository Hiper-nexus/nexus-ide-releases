# NOTICE — nexus-video

`SKILL.md` and `scripts/timeline-to-clips.mjs` are part of NexusIDE.

The guides under `hyperframes/` come from HyperFrames by HeyGen
(https://github.com/heygen-com/hyperframes), tag `v0.8.177`, commit
`2a2a1d2d902aa837c5fc68b4ab28d5e747033a8e` (19/10/2026), licensed under the
Apache License, Version 2.0. A copy of the license is in
`LICENSE-hyperframes.txt`. Copyright HeyGen and the HyperFrames contributors.

Changes made by NexusIDE (Apache-2.0 §4(b)):

- `skills/hyperframes-core/SKILL.md` → `hyperframes/core/core.md`,
  `skills/hyperframes-cli/SKILL.md` → `hyperframes/cli/cli.md`,
  `skills/hyperframes-audio/SKILL.md` → `hyperframes/audio/audio.md`: renamed
  so agent CLIs do not load them as separate skills. Text unchanged.
- `skills/hyperframes-core/references/*`, `skills/hyperframes-audio/references/*`,
  `skills/product-launch-video/references/*` (→ `hyperframes/product-launch/references/`)
  and seven files of `skills/hyperframes-cli/references/`: copied unchanged.
- Not included: the CLI references `cloud.md`, `lambda.md` and `cloudrun.md`
  (remote rendering outside the Nexus), every `scripts/` folder and test, the
  `product-launch-video` workflow `SKILL.md` and sub-agents, and the other
  HyperFrames skills (`hyperframes`, `media-use`, `hyperframes-animation`,
  `hyperframes-creative`, `hyperframes-registry`, workflows). Links in the
  bundled guides that point to them do not resolve here.
- `SKILL.md` of this folder states the rules that take precedence over the
  bundled guides inside the Nexus (pinned version, no HeyGen cloud, Nexus
  voice/music/render/export tools).

HyperFrames' own credits acknowledge Remotion as prior art; HyperFrames is not
affiliated with Remotion, and neither is NexusIDE.
