---
name: ui-kit
description: >
  Use before writing ANY UI component by hand. Two kits are installed in
  Nexus — shadcn/ui (free, plus any registry) and BoardUI (free items, Pro
  items need the operator's licence) — with ready blocks, charts, dashboards
  and whole admin assemblies. Ask the catalog, read the source, install the
  item, THEN style it with the project's design contract. Pair with dembrandt
  for the contract and impeccable for the craft.
---

# UI kit — install the component, do not re-type it

A vendor component carries what a hand-written one usually misses: keyboard
handling, focus management, ARIA wiring, disabled/loading/error states, RTL.
Writing `<Button>` from scratch throws all of that away and costs more.

So the order is: **find the item → read it → install it → style it with the
project's design contract.**

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
2. **Ask the catalog.** `nexus_ui_kit_catalog` with `task` set to what you are
   building. It lists items and recipes and returns a recommendation (which
   kit, which item, and whether a kit fits at all). Pass `cachedOnly: true` to
   work offline from what Nexus already downloaded.
3. **Read before installing.** `nexus_ui_kit_source` returns one item's source,
   served from the local cache when fresh. Looking at three candidates is
   cheap; installing the wrong one is not.
4. **Install.** `nexus_ui_kit_add` with the slugs. For a whole back office use
   `nexus_ui_kit_recipe` instead — one call installs shell, sidebar, overview
   with charts, data table, auth and settings.
5. **Style it.** Apply the contract's tokens, then finish the states
   (hover/focus/empty/error) with **impeccable**.

## Which kit

Let the recommendation decide; when you decide yourself:

- **shadcn/ui** — the broad surface: forms, dialogs, tables, sidebars, auth,
  marketing blocks, charts, plus any third-party or private registry. Free, no
  key, ever.
- **BoardUI** — agentic and dashboard surfaces: agent/chat composers, stat
  cards, charts, and full dashboard templates. 45+ items are free; the Pro
  half (most charts, the dashboard templates) needs the operator's licence.

## Pro items and the licence

The free half works with no key at all. When a Pro item is the best match and
no licence is active, the recommendation falls back to a free equivalent and
reports `needsLicense` with the item it wanted. Say that to the operator —
"Finance Dashboard needs your BoardUI licence; I used Stat Cards" — and move
on. Do not stall the task, and do not ask the operator to paste a key into the
conversation: the key belongs in Settings → UI kits, and Nexus injects it from
the vault.

## The rest of the surface

- `nexus_ui_kit_run` — the other shadcn commands: `init` a project, `apply` a
  theme preset, decode/resolve a preset, `view`, `search`, `build` your own
  registry, `docs`, `info`, and the codemods (`cn`, `icons`, `base-color`,
  `rtl`, `radix`).
- `nexus_ui_kit_boardui` — BoardUI's own tools, including `get_usage_examples`,
  `get_theme`, `install_rules` and `install_skill`.

## Hard rules

- **Do not hand-write a primitive the kit has.** Button, input, select, dialog,
  table, sidebar, date picker, pagination: install them.
- **Do not install blind.** Read the source or the usage examples first.
- **Do not ship vendor defaults as finished design.** Tokens from the contract,
  always.
- **Do not ask for `shadcn eject`.** It inlines the stylesheet and the vendor
  documents it as irreversible; it is the operator's call, not an agent's.
- **Do not put a licence key in a tool argument, a prompt or a commit.** It
  lives in the vault.
- **A private registry that answers 401** means its token is not stored, not
  that the item does not exist. Report the namespace from
  `missingRegistryKeys` and point at Settings → UI kits.
