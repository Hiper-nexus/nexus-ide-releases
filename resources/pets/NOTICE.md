# Pet library (bundled)

This folder ships a **starter pack of 15 Codex v2 spritesheets** so Nexus IDE
users can try diverse desk pets offline without importing one-by-one from the
community gallery.

## Source

Sheets were curated from the public petdex / codex-pets gallery install
endpoints (`petdex.dev/install/<slug>`), then resized and re-encoded as WebP
for package size. Each entry keeps its original community slug in
`manifest.json`.

## Rights

Artwork is owned by the people who published it on the gallery. Nexus only
redistributes a compressed sample pack for product convenience.

- Prefer pets you have rights to use in demos/screenshots.
- Users can still import any other gallery pet or local Codex sheet.
- To remove the pack from builds, delete `resources/pets` and the
  `extraResource` entry in `forge.config.ts`.
