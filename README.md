# NexusIDE

Terminal IDE multi-agente para macOS: um grid de panes de terminal reais rodando
CLIs de IA, canvas infinito arrastável, adapters multi-CLI plugáveis e
orquestração nativa de squads, missões e handoffs — tudo num único ambiente de
desenvolvimento orientado a agentes.

> **Status:** core completo — grid de terminais, canvas infinito, orquestração
> de squads/missões, voz falada e multi-conta com failover. macOS-first
> (Apple Silicon).

## Instalar (usuário)

Baixe o `.dmg` mais recente em **[Releases](https://github.com/cleofasvolarehost/nexus-ide/releases)**,
abra e arraste para Aplicativos. O app é **assinado com Developer ID e
notarizado pela Apple** — abre com um duplo-clique, sem avisos de segurança.

As CLIs de IA que você já tem instaladas no Mac (`claude`, `codex`, `gemini`,
`kimi`, `grok`, `agy`…) são **detectadas automaticamente** — o app lê o PATH do
seu shell de login, então funciona já na primeira execução.

## O que funciona

- **Grid de terminais reais** (PTY + xterm.js) com split, foco e resize; panes
  persistem através de reshapes do grid.
- **Canvas infinito** arrastável (@xyflow) compartilhando as mesmas sessões.
- **Onboarding**: escolher/abrir workspace → nova missão em modo **Livre**
  (N panes, provider por pane) ou **Squad** (preset orquestrado).
- **Multi-CLI declarativo**: claude, codex, gemini, kimi, grok, antigravity,
  aider, opencode — adicionar uma nova é só soltar um JSON.
- **Multi-conta + failover automático**: ao esgotar créditos/limite de uma conta,
  o app troca sozinho para a próxima e retoma a conversa com `--resume`. Suporta
  assinatura Claude (swap de credencial no Keychain) e contas por API key,
  incluindo rota via GLM/z.ai, Sakana Fugu, DeepSeek e OpenRouter pela própria
  CLI do Claude.
- **Auth subscription-first**: assinatura autenticada sempre vence; a API key é
  fallback; keys guardadas no **macOS Keychain** (nunca em plaintext).
- **Orquestração**: servidor MCP embutido no namespace `nexus_*`, squads
  (schema JSON portável), missões, handoffs (SQLite + IPC), skill-gate duplo e
  tools de preview/browser com screenshot.
- **Marketplace real** (catálogo aitmpl: 423 agents + 872 skills, install para
  `~/.claude`), **file explorer** com editor, e **voz Jarvis** (Classic e Live,
  wake/PTT, STT, resposta falada e ações no app).

## Desenvolvimento

```bash
npm install        # deps + runtime do Electron
npm run rebuild    # rebuild dos módulos nativos p/ o ABI do Electron
npm start          # abre a janela
npm run typecheck  # tsc --noEmit ponta a ponta
npm test           # vitest
npm run make       # gera o .dmg em out/make/
```

## Arquitetura

Processo separado, segurança em primeiro lugar: `contextIsolation`,
`nodeIntegration: false`, `sandbox`, fuses de hardening, CSP estrita, IPC tipado
validado com zod em todo boundary do main, e PTYs isolados. Ver
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/orchestration.md`](docs/orchestration.md) e
[`docs/workspace-and-settings.md`](docs/workspace-and-settings.md).

## Stack

Electron + Electron Forge (Vite) · TypeScript · React 18 · `@lydell/node-pty` ·
`@xterm/xterm` · `@xyflow/react` · better-sqlite3 · Zustand · zod.

macOS-only por ora; a base Electron já é multiplataforma (port Windows/Linux no
roadmap).
