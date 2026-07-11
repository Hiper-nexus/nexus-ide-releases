# Integrações Sprint A–C (Orca-inspired)

## A1 — Drag files → agent
- UI: `AgentDropZone` na Activity Rail
- Core: `src/renderer/lib/agent-attach.ts` → path real ou `saveDropped` + `writeToPane`

## A2 — GitHub PR
- Token: `NEXUS_GITHUB_TOKEN` no secrets vault
- IPC: `integrations:forge.createPr` / `listPrs`
- UI: painel **Forge** (WorkspaceBar) + create PR da branch atual

## A3 — Annotate AI diffs
- UI: **Diff** na bar → `DiffAnnotatePanel`
- Click linha `+` → nota → “Enviar notas ao agent”

## B4 — SSH production transport
- `src/main/integrations/ssh2-transport.ts` + dep `ssh2` (package.json)
- Session manager injectável (mock em testes); smoke: `ssh2-transport.test.ts`

## B5 — Remote worktree
- IPC `integrations:remote.worktreeCreate` (host/user/path/branch via SSH)
- `remoteWorktreeCreate(transport, path, branch?)` unit-tested with MockSshTransport

## B6 — Port forward
- `port-forward.ts` localhost TCP proxy
- UI: Forge panel “Forward + abrir” no browser embutido

## C7 — GitHub Issues no rail
- Secção **Issues** na Activity Rail (quando token existe)

## C8 — Linear
- Token `NEXUS_LINEAR_API_KEY`
- Lista no Forge panel + rail Issues
- Click → wizard agentic com prompt pré-preenchido

## Fase 4 — Multi-missão sem kill (seguro)
- Soft focus se a missão já tem panes vivos
- Merge de panes se o orquestrador entrante **não** partilha login exclusivo (Claude keychain)
- Kill seletivo só de orquestradores Claude em conflito; `forceHard` ainda mata todos
- Código: `mission-auth-conflict.ts`, `mission-reopen.ts`, `mission-launcher.ts`
