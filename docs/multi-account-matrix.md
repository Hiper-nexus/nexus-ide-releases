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
| **agy** | OAuth local | **Managed** (`GEMINI_CLI_HOME`) quando há `oauth_creds.json`/token file capturável | conforme adapter | **Sim** para snapshot capturável | Rail + WorkspaceBar |
| **openclaude** | `openclaude auth login` / `OPENAI_API_KEY` | N contas por API-key; OAuth nativo ainda sem snapshot | `--continue` / `--resume` | Parcial | Rail + WorkspaceBar |
| **muse** | `muse login` | Sessão nativa detectável; credencial Keychain ainda sem snapshot | `resume` | Não | Rail + WorkspaceBar |
| **glm / longcat / …** | Key + routing | API-key / upstream | conforme adapter | Parcial | Rail + WorkspaceBar |

Não existe teto de contas no store. Para qualquer CLI que consome API key, cada
linha guarda uma credencial independente no vault e o spawn recebe somente a
chave do `accountId` escolhido.

## Contrato para Providers e `+ Pane`

O renderer não troca credenciais globais para abrir um pane. O fluxo canônico é:

1. `window.nexus.accounts.list()` devolve `AccountInfo[]` sem segredos; a UI
   agrupa por `adapterId` e oferece A/B/demais.
2. Ao salvar o login atualmente ativo, chama
   `window.nexus.accounts.addActiveSession(adapterId, label)`. Sessões sem
   e-mail continuam salváveis com um label escolhido pelo operador.
3. `window.nexus.providers.authStatus()` devolve `sessionFingerprint` opcional,
   opaco e sem token. A UI usa apenas igualdade para perceber a troca A → B;
   `detail` só inclui e-mail quando a própria credencial contém um claim real.
4. Ao abrir pelo menu `+ Pane`, a UI passa o id escolhido em
   `window.nexus.pty.spawn({ kind: 'cli-agent', adapterId, model, accountId,
   ... })` e persiste o mesmo `accountId` no `PaneModel`.
5. O main valida que a conta pertence ao adapter antes de criar o PTY. Contas
   file-auth recebem homes process-scoped distintos (`CODEX_HOME`, `GROK_HOME`,
   `KIMI_CODE_HOME`, `XDG_DATA_HOME`, `GEMINI_CLI_HOME`); panes concorrentes não
   mudam a credencial uns dos outros.

## Fluxos suportados (aceite)

1. **Hot-swap (Orca)**  
   Settings → Providers → “Por assinatura (provider logado)” → label → Salvar.  
   Switcher na bar/rail → ativa conta → materializa managed home / OAuth env.  
   Sessões já abertas mantêm a conta antiga até **↻ reiniciar panes**.
2. **Continuar na mesma conversa após limite**  
   Conta A em cooldown → failover → Conta B → spawn com resume flags do adapter.
   Vale também para o orquestrador de missão e para o pane do operador adotado
   pela missão da aba (F-995): com limite CONFIRMADO (F-249), o Main troca a
   conta selada do orquestrador e religa o MESMO pane na Conta B pela
   recuperação do orquestrador, com o pacote de continuidade. O recibo da
   sessão nova diz "troca automática por limite confirmado".
3. **Pin de conta no pane**  
   `accountId` na composição da missão; reopen restaura a conta. O pin não
   prende o pane numa conta esgotada: limite confirmado troca para a irmã com
   folga e avisa (F-995).
4. **Escolha de conta (regra de folga)**  
   Folga só entre janelas comparáveis (`compareAccountHeadroom`): a janela
   que limita de fato decide; conta sem leitura de uma janela não tem mais
   folga nela; a ativa lida pela metade cede à irmã que provou folga na janela
   que a ativa não leu (F-995).
5. **Troca manual**  
   WorkspaceBar / Activity Rail → AccountSwitcher → `account:activate`.

## Não suportado (ainda)

- Continuar a **mesma task** de Claude → Codex (cross-provider).
- Fetch de rate-limit em rede estilo Orca (ChatGPT/Claude web APIs) — a UI mostra
  cooldown/lastError do store local (P4 lean).
- Snapshot OAuth do OpenClaude no macOS quando a sessão existe somente no
  Keychain. O adapter segue aceitando N contas por `OPENAI_API_KEY`.
- Snapshot AGY quando a única prova está no Keychain e não existe artefato
  file-auth capturável. Não se fabrica uma identidade nem se promete isolamento
  que a CLI não oferece; `addActiveSession` falha com orientação de novo login.
- Snapshot Muse quando `auth.json` aponta a credencial para o Keychain. A CLI
  ainda não oferece um seletor de storage por pane que permita isolar N sessões.

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
