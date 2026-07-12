# Multi-conta / multi-provedor — matriz operacional

Estado de produto (desktop Nexus IDE). Hot-swap = materializar credencial ativa
(estilo Orca) sem re-login. Failover = troca de conta **no mesmo adapter** com resume CLI.

| Adapter | Login / key | Multi-conta vault | Resume args | Failover auto | UI switcher |
|---------|-------------|-------------------|-------------|---------------|-------------|
| **claude** | OAuth Keychain + API key + upstreams | **First-class** (snapshot sub + keys; `CLAUDE_CODE_OAUTH_TOKEN` por pane) | `--resume` | **Sim** | Rail + WorkspaceBar chip |
| **codex** | `codex login` / `OPENAI_API_KEY` | **Managed home** (`CODEX_HOME` em `~/.nexus/managed-accounts/codex/<id>`) + API-key rows | `resume <id>` | **Sim** (limites OpenAI/Codex) | Rail + WorkspaceBar |
| **grok** | `grok login` / `XAI_API_KEY` | **Managed home** (`GROK_HOME`) + API-key | conforme adapter | **Sim** | Rail + WorkspaceBar |
| **kimi** | `kimi login` / API key | **Managed home** (`KIMI_CODE_HOME`) + API-key | conforme adapter | **Sim** | Rail + WorkspaceBar |
| **opencode** | `opencode auth login` / key | **Managed** (`XDG_DATA_HOME`) + API-key | conforme adapter | **Sim** | Rail + WorkspaceBar |
| **agy** | OAuth local | Snapshot de sessão + API-key | conforme adapter | **Sim** | Rail + WorkspaceBar |
| **glm / longcat / …** | Key + routing | API-key / upstream | conforme adapter | Parcial | Rail + WorkspaceBar |

## Fluxos suportados (aceite)

1. **Hot-swap (Orca)**  
   Settings → Providers → “Por assinatura (provider logado)” → label → Salvar.  
   Switcher na bar/rail → ativa conta → materializa managed home / OAuth env.  
   Sessões já abertas mantêm a conta antiga até **↻ reiniciar panes**.
2. **Continuar na mesma conversa após limite**  
   Conta A em cooldown → failover → Conta B → spawn com resume flags do adapter.
3. **Pin de conta no pane**  
   `accountId` na composição da missão; reopen restaura a conta.
4. **Troca manual**  
   WorkspaceBar / Activity Rail → AccountSwitcher → `account:activate`.

## Não suportado (ainda)

- Continuar a **mesma task** de Claude → Codex (cross-provider).
- Fetch de rate-limit em rede estilo Orca (ChatGPT/Claude web APIs) — a UI mostra
  cooldown/lastError do store local (P4 lean).

## Como validar

```bash
npx vitest run \
  src/main/adapters/managed-credentials.test.ts \
  src/main/persistence/account-store-spawn.test.ts \
  src/main/orch/limit-detector.test.ts \
  src/main/orch/failover.test.ts \
  src/main/pty/pty-ipc.test.ts
```

Manual: 2 contas Codex → salvar sessão de cada login → switcher → ↻ panes →
simular 429 no output → toast failover → conversa retoma.
