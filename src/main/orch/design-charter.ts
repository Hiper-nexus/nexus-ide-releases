/**
 * Carta de Design — anti-"cara de IA" injetada em todo worker (auto-gate:
 * só se aplica quando a tarefa produz UI). Destilada dos absolute bans e do
 * "AI slop test" da skill Impeccable: a IA gera sempre a MESMA interface
 * (sparkles, gradiente roxo, glassmorphism, card grids idênticos) — esta
 * carta força cada entrega a escapar do padrão. Prioridade de produto: UI
 * genérica não vende.
 */
/**
 * How an agent reaches the kit, in ONE sentence shared by the charter, the
 * short brief line and the MCP instructions — they used to drift.
 *
 * The order matters. The skill and this charter sent agents to
 * `nexus_ui_kit_catalog({task})` first, which is read-only and answers with
 * the OFFLINE rule only; the one door where the Jev decides is
 * `nexus_ui_kit_add({task})`, so the judge never ran in a real mission.
 */
export const UI_KIT_TOOL_LINE =
  "Don't know the slug? \`nexus_ui_kit_add({task})\` — Nexus picks the kit and the item against the live catalog (the Jev decides when available) and installs it; the receipt says what it chose and why. Know the slug: \`nexus_ui_kit_add({items})\`. A whole surface (admin, dashboard, auth): \`nexus_ui_kit_recipe\` in ONE call.";

/**
 * The kit in two sentences, for workers whose brief carries no design charter
 * (Design Pro off): the kit is a capability, not a design opinion, and
 * switching the opinion off used to switch the capability off with it.
 */
export const UI_KIT_BRIEF_LINE =
  `UI kit (shadcn/ui and BoardUI ship with Nexus, Pro unlocked): install a component instead of re-typing it. ${UI_KIT_TOOL_LINE} Style it with the project's design tokens, not the vendor defaults.`;

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
- Install the component, don't re-type it. Two kits ship with Nexus — shadcn/ui (free) and BoardUI (free items plus Pro components and templates, unlocked by the licence that ships with Nexus) — and a vendor item carries the keyboard handling, focus management, ARIA and the disabled/loading/error states a hand-written one loses.
- Commit to a color strategy (restrained, committed, full palette or drenched) — don't sprinkle accents randomly. Body text contrast ≥ 4.5:1, always.
- Real typographic hierarchy: scale + weight contrast (≥1.25 ratio), max 3 font families, no all-caps body copy.
- Design ALL states: hover, focus-visible, loading, empty, error — not just the happy screenshot.
- Motion with intent (ease-out curves, no bounce) + a prefers-reduced-motion alternative.
- UI copy: verb+object buttons, no marketing buzzwords, no em dashes.

Tooling:
- UI kit: ${UI_KIT_TOOL_LINE} \`nexus_ui_kit_source\` shows an item's code before you commit to it, and \`nexus_ui_kit_catalog\` only LISTS (offline). Never hand-write a button, input, select, dialog, table, sidebar, date picker, pagination, chart or dashboard shell the kit already ships.
- Take the kit's CODE and reject its LOOK. "No default shadcn" is about the visual: paint the installed component with the tokens above and it is not a template. When a machine cannot confirm the licence, a Pro pick falls back to a free equivalent and says which one it wanted — report that in the handoff and keep going; the free half needs no key.
- The bans above are distilled from the "impeccable" design skill (impeccable.style). If that skill is installed in your environment, invoke it on your delivery and fix what it flags; if not, apply this charter yourself. Never shell out to an \`impeccable\` command — it is a skill, not a CLI. Mention the result in the handoff.`;
