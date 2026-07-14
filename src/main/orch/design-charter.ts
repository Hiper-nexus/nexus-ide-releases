/**
 * Carta de Design — anti-"cara de IA" injetada em todo worker (auto-gate:
 * só se aplica quando a tarefa produz UI). Destilada dos absolute bans e do
 * "AI slop test" da skill Impeccable: a IA gera sempre a MESMA interface
 * (sparkles, gradiente roxo, glassmorphism, card grids idênticos) — esta
 * carta força cada entrega a escapar do padrão. Prioridade de produto: UI
 * genérica não vende.
 */
export const DESIGN_CHARTER = `# Design Charter (anti-generic AI look)

Applies whenever your task produces or changes UI. The test: if someone could glance at the screen and say "AI made that" without doubt, the delivery FAILED — rework it.

Absolute bans (rewrite the element if you catch yourself doing these):
- Emoji as UI icons — especially the ✨ sparkle (the #1 AI tell), 🚀, 🎉. Use a real icon set or none.
- Gradient text (background-clip on a gradient) and the purple-gradient-on-dark "AI SaaS" look.
- Glassmorphism/blur as default; side-stripe borders (border-left accent) on cards/alerts.
- The hero-metric template (big number + small label + gradient accent) and identical icon+heading+text card grids.
- Tiny uppercase tracked eyebrow ("ABOUT", "FEATURES") above every section; numbered section markers (01/02/03) as reflex scaffolding.
- Cream/beige default backgrounds and the Inter + purple + rounded-2xl combo "because it looks modern".

Do instead:
- Use the project's EXISTING design system/tokens/components first; extend them, don't fork a new style.
- Commit to a color strategy (restrained, committed, full palette or drenched) — don't sprinkle accents randomly. Body text contrast ≥ 4.5:1, always.
- Real typographic hierarchy: scale + weight contrast (≥1.25 ratio), max 3 font families, no all-caps body copy.
- Design ALL states: hover, focus-visible, loading, empty, error — not just the happy screenshot.
- Motion with intent (ease-out curves, no bounce) + a prefers-reduced-motion alternative.
- UI copy: verb+object buttons, no marketing buzzwords, no em dashes.

Tooling:
- The bans above are distilled from the "impeccable" design skill (impeccable.style). If that skill is installed in your environment, invoke it on your delivery and fix what it flags; if not, apply this charter yourself. Never shell out to an \`impeccable\` command — it is a skill, not a CLI. Mention the result in the handoff.`;
