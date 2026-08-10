# Xirp Parity A+B — Persistent Session + Project Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessões de agente sobrevivem ao quit do app (tmux detach/attach) e o Nexus ganha uma superfície Project Overview com flock/minimap e goal box — clean-room vs Xirp, sem copiar código Spotify.

**Architecture:** Flag A envolve o spawn do PTY host com `tmux new-session`/`attach-session` nomeado `nexus-<workspaceHash>-<paneId>`. Quit mata só o client attach (não `kill-session`). Close pane faz `kill-session`. Registry SQLite mapeia pane→tmux. Flag B adiciona destinação `project` na rail, `ProjectOverview` (header + goal + flock) e Cmd+G. MissionEngine permanece autoridade de missão.

**Tech Stack:** Electron, TypeScript, React, Zustand, Zod, better-sqlite3, Vitest, tmux (macOS/Linux PATH).

## Global Constraints

- Clean-room: zero código de `/Applications/Xirp.app`.
- Não extrair daemon WS; não epics/PR watch nesta onda.
- Preservar MissionEngine, seals `persisted-pane`, Seatbelt/Bubblewrap fail-closed.
- Flags default ON em `dev`; kill-switch e Labs override.
- Sem tmux → fallback PTY direto + aviso único; sem crash.
- macOS-first; Linux se `tmux` no PATH; Windows = flag A efetiva off.
- Copy PT-BR; testes co-localizados; `npx vitest run <file.test.ts>` + `npm run typecheck` após mudanças.
- Não commitar a menos que o usuário peça.

## File map

| File | Role |
|------|------|
| `src/shared/feature-flags.ts` | Flags A+B |
| `src/main/pty/persistent-session.ts` | Probe/create/attach/kill/list + nome tmux |
| `src/main/pty/persistent-session.test.ts` | Unit com mock exec |
| `src/main/persistence/persistent-session-store.ts` | SQLite registry |
| `src/main/persistence/db.ts` | Tabela `persistent_pty_sessions` |
| `src/main/pty/pty-manager.ts` | Wire spawn/quit/close |
| `src/shared/pty-persistence.ts` | Tipos IPC de status |
| `src/renderer/state/product-navigation-store.ts` | `openProject` |
| `src/renderer/components/product/WorkspaceRail.tsx` | Item Projeto |
| `src/renderer/components/product/ProjectOverview.tsx` | UI B |
| `src/renderer/App.tsx` | Destinação + Cmd+G |

---

### Task 1: Feature flags A + B

**Files:**
- Modify: `src/shared/feature-flags.ts`
- Test: `src/shared/feature-flags.test.ts` (criar ou estender se existir)

**Interfaces:**
- Produces: `FEATURE_FLAG_IDS.ptyPersistentSession = 'feature.pty.persistentSession'`, `FEATURE_FLAG_IDS.uiProjectOverview = 'feature.ui.projectOverview'`, ambas em `BUILTIN_FEATURE_FLAGS` com `defaultEnabled: true`, `channel: 'dev'`, `createdAt: '2026-08-10'`, `removeAfter: '2027-03-31'`.

- [ ] **Step 1: Add failing assertion** in feature-flags test (or new file) that both IDs resolve default-enabled.

```ts
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FEATURE_FLAGS,
  FEATURE_FLAG_IDS,
  resolveFeatureFlag,
} from './feature-flags';

describe('xirp parity flags', () => {
  it('enables persistent session and project overview by default on dev', () => {
    for (const id of [
      FEATURE_FLAG_IDS.ptyPersistentSession,
      FEATURE_FLAG_IDS.uiProjectOverview,
    ] as const) {
      const def = BUILTIN_FEATURE_FLAGS.find((f) => f.id === id);
      expect(def).toBeDefined();
      expect(
        resolveFeatureFlag(def, { runtimeChannel: 'dev' }).enabled,
      ).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/shared/feature-flags.test.ts` — expect FAIL (IDs missing).

- [ ] **Step 3: Implement IDs + BUILTIN entries** in `feature-flags.ts`.

- [ ] **Step 4: Run tests — PASS.** `npm run typecheck`.

---

### Task 2: persistent-session backend (pure)

**Files:**
- Create: `src/main/pty/persistent-session.ts`
- Create: `src/main/pty/persistent-session.test.ts`

**Interfaces:**
- Consumes: `child_process.execFile` (injetável)
- Produces:

```ts
export function tmuxSessionName(workspaceId: string, paneId: string): string;
export type TmuxRunner = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;
export function createPersistentSessionBackend(runner?: TmuxRunner): {
  probeAvailable(): Promise<boolean>;
  hasSession(name: string): Promise<boolean>;
  ensureSession(input: {
    name: string;
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }): Promise<'created' | 'exists'>;
  attachArgs(name: string): { file: string; args: string[] };
  killSession(name: string): Promise<void>;
  listNexusSessions(): Promise<string[]>;
};
```

- Nome: sanitize `workspaceId`+`paneId` → `[a-zA-Z0-9_-]`, max 80 chars, prefix `nexus-`.
- `ensureSession`: se `has-session` → `'exists'`; senão `new-session -d -s name -c cwd command args...`.
- `attachArgs`: `{ file: 'tmux', args: ['attach-session', '-t', name] }`.
- Windows (`process.platform === 'win32'`): `probeAvailable` → false.

- [ ] **Step 1: Write failing tests** for name sanitize, probe false on win32, ensure create vs exists, kill.

- [ ] **Step 2: Run** `npx vitest run src/main/pty/persistent-session.test.ts` — FAIL.

- [ ] **Step 3: Implement backend.**

- [ ] **Step 4: Tests PASS.**

---

### Task 3: SQLite registry

**Files:**
- Modify: `src/main/persistence/db.ts` — add table to `SCHEMA`
- Create: `src/main/persistence/persistent-session-store.ts`
- Create: `src/main/persistence/persistent-session-store.test.ts`

**Interfaces:**

```ts
export interface PersistentPtyRecord {
  workspaceId: string;
  paneId: string;
  tmuxName: string;
  cwd: string;
  createdAt: number;
}
export function upsertPersistentPty(record: PersistentPtyRecord): boolean;
export function getPersistentPty(workspaceId: string, paneId: string): PersistentPtyRecord | null;
export function listPersistentPtys(workspaceId: string): PersistentPtyRecord[];
export function deletePersistentPty(workspaceId: string, paneId: string): void;
```

Table:

```sql
CREATE TABLE IF NOT EXISTS persistent_pty_sessions (
  workspace_id TEXT NOT NULL,
  pane_id      TEXT NOT NULL,
  tmux_name    TEXT NOT NULL UNIQUE,
  cwd          TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, pane_id)
);
```

- [ ] **Step 1: Failing store tests** with in-memory/temp better-sqlite3 (padrão do repo).

- [ ] **Step 2: Implement schema + store.**

- [ ] **Step 3: Tests PASS.**

---

### Task 4: Wire A into pty-manager

**Files:**
- Modify: `src/main/pty/pty-manager.ts` (spawn path + `terminateAllSessions` / close)
- Modify: `src/main/pty/pty-manager.test.ts`
- Create if needed: `src/shared/pty-persistence.ts` for status type
- Optionally expose list via existing orch/pty IPC

**Behavior:**
1. Antes do spawn físico: se flag A ON e `probeAvailable()` e `paneId` presente → `ensureSession` com file/args/cwd/env resolvidos; trocar spawn spec para `attachArgs(name)`; `upsertPersistentPty`.
2. Se probe falha: spawn direto; log uma vez `[pty] persistentSession unavailable: tmux missing`.
3. `killSession` / close pane: se registry hit → `killSession(tmuxName)` + `deletePersistentPty`, depois terminate PTY.
4. `terminateAllSessions` (app quit): para sessões no registry, **não** chamar `tmux kill-session`; apenas terminate o client attach (PTY). Registry permanece. Sessões sem registry: comportamento atual (kill tree).
5. Reopen/resume: se registry + `hasSession` → attach; senão delete registry stale + spawn fresco.

- [ ] **Step 1: Add unit tests** mocking backend + flag for quit-does-not-kill-tmux and close-does-kill-tmux.

- [ ] **Step 2: Implement wire-up minimally** (prefer helper functions extracted to keep pty-manager readable).

- [ ] **Step 3: Run** `npx vitest run src/main/pty/pty-manager.test.ts src/main/pty/persistent-session.test.ts` + typecheck.

**Security note:** sandbox path — se Darwin seal/profile rejeitar file=`tmux`, catch e fallback direto + delete registry attempt. Não enfraquecer fail-closed do seal.

---

### Task 5: Navigation `project` + rail

**Files:**
- Modify: `src/renderer/state/product-navigation-store.ts`
- Modify: `src/renderer/state/product-navigation-store.test.ts`
- Modify: `src/renderer/components/product/WorkspaceRail.tsx` (+ test)
- Modify: `src/renderer/App.tsx` (selection + switch + props)

**Interfaces:**
- `ProductDestination |= { kind: 'project' }`
- `openProject(): void`
- `WorkspaceRailSelection |= { kind: 'project' }`
- Props: `onOpenProject?: () => void`, `projectEnabled?: boolean` — item fixo "Projeto" acima de Quadro quando `projectEnabled`.

- [ ] **Step 1: Failing nav + rail tests.**

- [ ] **Step 2: Implement store + rail + App wiring** (`productFlags[FEATURE_FLAG_IDS.uiProjectOverview]`).

- [ ] **Step 3: Tests PASS.** Flag OFF: sem botão; se destino `project` órfão → `openTerminal()`.

---

### Task 6: ProjectOverview UI + Cmd+G + goal box

**Files:**
- Create: `src/renderer/components/product/ProjectOverview.tsx`
- Create: `src/renderer/components/product/ProjectOverview.test.tsx`
- Modify: `src/renderer/App.tsx` — case `project`, Cmd+G
- CSS: estender styles existentes do produto (sem skin nova)

**UI contract:**
- Header: `workspace.name` + branch se `window.nexus` git API já exposta; senão só nome.
- Goal box: textarea + botão "Abrir sessão" → `openTerminal()` + split/spawn via path já usado pelo CommandPalette/terminal (reusar helper existente; não inventar MissionEngine).
- Flock: `listPanes(layout.root)` + `useSessionStateStore` display state; click → `openTerminal` + `layout.focus(paneId)`; botão fechar → `requestPaneClose`.
- Badge `aliveOutsideApp` quando main reportar (Task 4 IPC); se IPC ainda não existir, omitir badge (não fake).
- Cmd+G (meta/ctrl+g, sem shift/alt): `openProject()` se flag ON.

- [ ] **Step 1: Failing component tests** (render N panes, click focus, Cmd+G).

- [ ] **Step 2: Implement UI + App case.**

- [ ] **Step 3: Tests + typecheck.**

---

### Task 7: Acceptância e docs

- [ ] Marcar critérios do spec §8 no próprio spec (`Status: implementado` parcial/completo).
- [ ] `npm run typecheck`
- [ ] `npx vitest run` nos testes tocados
- [ ] Atualizar `docs/ARCHITECTURE.md` com 1 parágrafo: persistent PTY opt-in + project destination (só se implementação A estiver wired).

---

## Spec coverage check

| Spec § | Task |
|--------|------|
| Flags A+B | 1 |
| Backend tmux | 2 |
| Registry SQLite | 3 |
| Quit detach / close kill / reopen attach | 4 |
| Destinação project + rail | 5 |
| Overview + goal + minimap + Cmd+G | 6 |
| Aceite / arch note | 7 |
| Fora de escopo C/D | — (não há task) |

## Execution

Após o plano: execução **inline** nesta sessão (usuário pediu “siga”), task a task, TDD.
