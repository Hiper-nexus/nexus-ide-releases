---
name: ui-kit
description: >
  Use before writing ANY UI component by hand. Two kits are installed in
  Nexus — shadcn/ui (free, plus any registry) and BoardUI (free items plus Pro
  components and templates, unlocked by the licence that ships with Nexus) —
  with ready blocks, charts, dashboards and whole admin assemblies. Describe
  the need to nexus_ui_kit_add({task}) and let Nexus pick, THEN style it with
  the project's design contract. Pair with dembrandt for the contract and
  impeccable for the craft.
---

# UI kit — install the component, do not re-type it

A vendor component carries what a hand-written one usually misses: keyboard
handling, focus management, ARIA wiring, disabled/loading/error states, RTL.
Writing `<Button>` from scratch throws all of that away and costs more.

So the order is: **describe the need → Nexus picks and installs → style it
with the project's design contract.**

## The one rule that is easy to get backwards

The house rules say never to ship "default Tailwind/shadcn" UI. That is about
the LOOK, not the code.

- **Take the kit's code.** Behaviour, a11y and states are the whole point.
- **Reject the kit's look.** Paint it with the project's `DESIGN.md` /
  `.context/docs/design-system.md` tokens — colour, type scale, spacing,
  radius, motion.

A shadcn component painted with the project's contract is not a template. An
unmodified default card grid with a purple gradient is, and still gets
rejected.

## Flow

1. **Contract first.** If there is no `DESIGN.md` or
   `.context/docs/design-system.md`, get one with **dembrandt** before you
   build. Without it the output is the model's default styling.
2. **Don't know the slug? Describe the need.** `nexus_ui_kit_add({task})`
   with what you are building. Nexus picks the kit and the item against the
   live catalog — the Jev decides when it is available — and installs it. The
   receipt's `pick` says what was chosen and by whom (`kitDecidedBy`,
   `itemDecidedBy`) and `files` lists what was actually written.
3. **Know the slug?** `nexus_ui_kit_add({items: [...]})`. For a whole surface
   (back office, dashboard, auth) use `nexus_ui_kit_recipe` — one call installs
   shell, sidebar, overview with charts, data table, auth and settings.
4. **Browsing is a read, not a decision.** `nexus_ui_kit_catalog` LISTS items
   and recipes offline (its `recommendation` is the offline rule only);
   `nexus_ui_kit_source` shows one item's code from the local cache. Use them
   to look, then install through step 2 or 3.
5. **Style it.** Apply the contract's tokens, then finish the states
   (hover/focus/empty/error) with **impeccable**.

### When the receipt says nothing was written

- `alreadyPresent`: the files existed and were NOT overwritten. Use them, or
  pass `overwrite: true` if you mean to replace them.
- `refusal: "components_json_missing"`: the project has no shadcn setup yet.
  Run `nexus_ui_kit_run { command: 'init' }` (non-interactive) or install from
  BoardUI with `kit: 'boardui'`.
- `PROJECT_BUSY`: another kit install is still running in this project. Wait,
  check the files it wrote, retry only what is missing.

## Which kit

Let the recommendation decide; when you decide yourself:

- **shadcn/ui** — the broad surface: forms, dialogs, tables, sidebars, auth,
  marketing blocks, charts, plus any third-party or private registry. Free, no
  key, ever.
- **BoardUI** — agentic and dashboard surfaces: agent/chat composers, stat
  cards, charts, and full dashboard templates. 69 items are free; the Pro
  half (30 components, mostly charts, and 10 full-page templates such as
  `template-home-dashboard` and `template-finance`) is unlocked by the licence
  that ships with Nexus.

## Pro items and the licence

BoardUI Pro is unlocked on every machine by the licence that ships with
Nexus; nothing to configure. If a machine cannot confirm it (vendor
unreachable, a machine with its own expired licence), a Pro pick falls back to
a free equivalent and reports `needsLicense` with the item it wanted. Say that
to the operator — "Finance Dashboard Template could not be confirmed; I used
Stat Cards" — and move on. Do not stall the task, and do not ask the operator
to paste a key into the conversation: a key of their own belongs in
Configurações › Biblioteca › Kits de UI, and Nexus injects it from the vault.

## The rest of the surface

- `nexus_ui_kit_run` — the other shadcn commands: `init` a project, `apply` a
  theme preset, decode/resolve a preset, `view`, `search`, `build` your own
  registry, `docs`, `info`, and the codemods (`cn`, `icons`, `base-color`,
  `rtl`, `radix`).
- `nexus_ui_kit_boardui` — BoardUI's own tools, including `get_usage_examples`,
  `get_theme`, `install_rules` and `install_skill`. `init_boardui` and
  `install_rules` write the vendor's agent rules into the project
  (`AGENTS.md`, `.claude/skills`): say so in the handoff.

## Hard rules

- **Do not hand-write a primitive the kit has.** Button, input, select, dialog,
  table, sidebar, date picker, pagination: install them.
- **Do not install blind when you choose by slug.** Read the source or the
  usage examples first; with `task`, read the receipt's `pick`.
- **Do not ship vendor defaults as finished design.** Tokens from the contract,
  always.
- **Do not ask for `shadcn eject`.** It inlines the stylesheet and the vendor
  documents it as irreversible; it is the operator's call, not an agent's.
- **Do not put a licence key in a tool argument, a prompt or a commit.** It
  lives in the vault.
- **Verify in the browser through the Nexus preview.** Build, then
  `nexus_preview_start({dir})`, `nexus_browser_open(url)` and
  `nexus_browser_responsive`. The Nexus browser refuses a dev server's
  `localhost` and `file://`; do not run `npm run dev` to check the result.
- **A private registry that answers 401** means its token is not stored, not
  that the item does not exist. Report the namespace from
  `missingRegistryKeys` and point at Configurações › Biblioteca › Kits de UI.
