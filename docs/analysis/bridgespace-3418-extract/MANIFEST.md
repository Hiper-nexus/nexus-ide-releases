# BridgeSpace 3.4.18 — Extract Manifest

**Data:** 2026-09-03
**Método:** mesmo do dossiê Overclock 1.3.18 (evidência preservada + sondas offline + extração reproduzível)

## Fonte primária

| Item | Valor |
|------|-------|
| App | `/Applications/BridgeSpace.app` (io.bridgemind.bridgespace) |
| Versão | 3.4.18 (latest: pub_date 2026-08-04T12:41:16Z, `downloads.bridgemind.ai/bridgespace/latest/latest.json`) |
| Binário | `Contents/MacOS/bridgespace-tauri` — Mach-O arm64, 33.784.928 bytes |
| SHA256 | `fd82eaacd13764ef72192727715bea0f7a39a2d3e301242c597a5a13842d1691` |
| Stack | Tauri (Rust + WKWebView). Sem asar — assets embutidos no binário |
| Code signing | presente (não verificada neste extract) |

## Fontes mapeadas

1. **Binário Tauri** — frontend JS/CSS/HTML/assets embutidos (carve via `scripts/carve-binary.mjs`)
2. **`~/.bridgespace/`** — harness runtime: agent-hooks, claude-hooks (global/scopes), bridgememory-mcp (server.cjs 22.013 linhas + SKILL.md), bin/ (bs-claude-hook.cjs 312, bs-agent-notify.cjs 545), shell-integration (zsh/bash/pwsh), swarms, skills, history.db, logs
3. **`~/Library/Application Support/io.bridgemind.bridgespace/`** — session.alive.v1.json, mobile-bridge-config.json, shell-integration runtime, device_fingerprint
4. **`~/Library/Application Support/BridgeMindOne/`** — chats.sqlite3 (+shm/wal), archived-chats.json, session.json, auth (estrutura, sem conteúdo sensível)
5. **API** — api.bridgemind.ai / app.bridgemind.ai (Cloudflare) / S3 bridgemind-files-{dev,prod} — secundária

## Estrutura

```
frontend/   assets carved do binário (HTML/JS/CSS/SVG/fontes/imagens)
harness/    cópia integral de ~/.bridgespace
mcp/        bridgememory-mcp + configs de MCP
schemas/    SQLite dumps + session/configs + comandos Tauri (superfície IPC)
visual/     screenshots runtime + tokens capturados
scripts/    scripts de extração reproduzíveis
```

## Nota de licença

BridgeMind é produto comercial fechado. Este extract é para estudo privado e portabilidade pelo dono da licença de uso. O PLANO T1-Tn marca o que exige reinterpretação ao portar para o Nexus.

## Companion apps (fora do escopo)

- BridgeVoice.app 2.8.2 (com.bridgemind.bridgevoice, 126MB) — segunda passada opcional
- BridgeMindOne e io.bridgemind.bridgespace são o mesmo produto (dirs de dados)
