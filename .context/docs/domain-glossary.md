# Domain glossary

> Source-bound index of code identifiers observed directly in the bound sources. This documents implementation vocabulary only — no business/domain meaning is asserted beyond what the source shows.

- **result**: local `const` declared in `scripts/check-node-natives.mjs`, holding the SQLite health-probe row (`database.prepare('select 1 as ok').get()`).
- **runtimeManager**: local variable declared in `src/main/browser/browser-artifact-store.test.ts` inside the `manager()` helper, holding a `new ProjectRuntimeManager(...)` instance.
- **ProjectRuntimeManager**: identifier imported by name in `src/main/browser/browser-artifact-store.test.ts` from the `../runtime/project-runtime-manager` module path and instantiated with `new` in that test file.
