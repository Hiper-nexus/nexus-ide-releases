# Multi-conta / multi-provedor — matriz operacional

Estado de produto (desktop Nexus IDE). Failover = troca de conta **no mesmo adapter** com resume CLI.

| Adapter | Login / key | Multi-conta vault | Resume args | Failover auto | UI switcher |
|---------|-------------|-------------------|-------------|---------------|-------------|
| **claude** | OAuth sub + API key + upstreams (GLM, DeepSeek, …) | **First-class** (snapshot sub + keys) | `--resume` | **Sim** (regex limite/quota) | Rail footer + Config |
| **codex** | `OPENAI_API_KEY` / `codex login` | API-key rows | `resume <id>` | Parcial (mensagens OpenAI) | Rail footer (se cadastrada) |
| **grok** | API / CLI login | API-key rows | `--continue` / resume | Parcial | Rail footer |
| **kimi / glm / longcat / …** | Key + routing | API-key / upstream | conforme adapter | Parcial | Rail footer |

## Fluxos suportados (aceite)

1. **Continuar na mesma conversa após limite**  
   Conta A em cooldown → failover → Conta B → spawn com resume flags do adapter.
2. **Pin de conta no pane**  
   `accountId` na composição da missão; reopen restaura a conta.
3. **Troca manual**  
   Activity Rail → AccountSwitcher → `account:activate`.

## Não suportado (ainda)

- Continuar a **mesma task** de Claude → Codex (cross-provider).
- Multi-subscription profunda para Codex/Grok no estilo Claude Max snapshot.
- Switcher global na bar com menu completo (há chip + rail; gestão em Config).

## Como validar

```bash
npx vitest run src/main/orch/failover.test.ts src/main/pty/pty-ipc.test.ts
```

Manual: 2 contas Claude → simular 429 no output → toast failover → conversa retoma.
