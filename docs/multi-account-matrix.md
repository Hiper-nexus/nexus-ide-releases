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

## Renovação de credencial: quem renova e onde o grant fica

Refresh token rotaciona, então duas cópias dele não sobrevivem juntas: cada linhagem
tem um dono, e o Nexus só grava onde é dono (`docs/SECURITY.md`, "Renovação de
credenciais OAuth"; detalhes por provider em `AGENTS.md`).

| Adapter | Quem renova | Onde o grant renovado fica |
|---------|-------------|----------------------------|
| **claude** | A CLI (login nativo no store nativo; escopo gerenciado no próprio escopo). Na Reserva (só cofre, sem CLI dona), `ensureFreshClaudeSubscription` renova por HTTP um access token vencido com refresh token vivo, se esse refresh token não estiver no login nativo nem em outra linha do cofre (F-639) | No cofre, depois de o token novo provar a conta. O login nativo nunca é renovado por fora (F-645) |
| **codex** | A CLI do pane, uma renovação por conta (`managed-auth-spawn-gate.ts`) | `auth.json` da conta gerenciada |
| **grok** | A CLI; a cota usa ACP com `cached_token` e nunca `grok models` (F-626) | Arquivo de auth da CLI |
| **kimi** | A sonda de cota, no token endpoint do Kimi | Blob `acctcred:<id>` do cofre (`persistKimiRotatedCreds`), nunca o `~/.kimi-code` nativo |
| **agy** | A sonda de cota (OAuth Google) ou a CLI do pane | Conta fixada: blob `acctcred:<id>`. Linha nativa: `~/.gemini/oauth_creds.json`, só numa rotação e só se o arquivo ainda guarda o refresh token usado (`persistGeminiRotatedCreds`) |

Conta Claude na Reserva com access token vencido não some mais da cota nem da Redline
e a sonda não carimba «sessão expirada» com refresh token vivo no cofre: o cofre é
renovado e, quando ele é mais fresco que o escopo gerenciado que falhou, a cota lê o cofre.
A credencial provada limpa a marca de renovação e o cooldown de auth. Conta AGY na Reserva volta ao cofre com
access, expiry e refresh token em vigor, em vez de ficar com o access vencido e um
refresh token que o Google pode ter trocado.

## Fluxos suportados (aceite)

1. **Hot-swap (Orca)**  
   Settings → Providers → “Por assinatura (provider logado)” → label → Salvar.  
   Switcher na bar/rail → ativa conta → materializa managed home / OAuth env.  
   Sessões já abertas mantêm a conta antiga até **↻ reiniciar panes**.
2. **Continuar a mesma conversa (ou a tarefa) após limite**  
   Conta A em cooldown → failover → Conta B do mesmo provedor. O que atravessa
   a troca depende de onde a CLI guarda o histórico (F-1473,
   `nativeResumeAcrossAccounts` em `src/shared/cross-account-resume.ts`):
   - **Claude** (contas com upstream Anthropic): o transcript é por checkout
     (`<userData>/provider-state/claude/<checkoutId>/claude/projects`) e a conta
     é só a credencial. O Main passa a conversa do pane para a Conta B e a CLI
     sobe com `--resume <mesmo id>`; a primeira mensagem é só uma nota curta
     ("conta trocada; continue de onde parou" + o pedido em voo), não o pacote.
     Se a retomada não sobe (conversa não encontrada, erro da CLI no boot), o
     pane cai sozinho em sessão nova + pacote de continuidade.
   - **Codex, AGY, Devin, Kimi, Grok e demais**: sessão NOVA na Conta B, na
     mesma worktree, com o pacote de continuidade (arquivos tocados, diff,
     trecho do terminal, pedido em voo e próximo passo). O rollout do Codex
     também é por checkout, mas não está provado que outra conta ChatGPT aceita
     o histórico (raciocínio cifrado da conta que o gerou); os outros isolam o
     home inteiro por conta.
   Worker de missão num pane do renderer (F-1471): o Main reabre a MESMA tarefa
   na MESMA CLI, fixada na Conta B e com o modelo de antes quando a CLI o
   oferece — no Claude retomando a conversa do pane antigo (F-1473); o recibo
   só sai com o pane novo. Leitor: o pane novo nasce antes de o velho fechar.
   Writer: o checkout é de um writer só, então o velho sai e o novo entra logo
   depois. Se a Conta B não recebe a tarefa, ela segue em outra CLI ou espera a
   conta liberar, com o motivo no recibo. Pane que o Nexus não pode trocar
   sozinho (aberto pelo operador, sem pedido de spawn guardado) recebe recibo
   "não trocado" com o motivo, e o Maestro é avisado. Sem conta irmã com folga,
   a tarefa segue em outra CLI ou espera a conta liberar.
   Vale também para o pane do "+ Pane", o worker de missão headless e o
   orquestrador de missão / pane do operador adotado pela missão da aba
   (F-995): com limite CONFIRMADO (F-249), o Main troca a conta selada do
   orquestrador e religa o MESMO pane na Conta B pela recuperação do
   orquestrador — com a conversa retomada (Claude) ou o pacote de
   continuidade. O recibo da sessão nova diz "troca automática por limite
   confirmado". O resume entre contas é ligado por padrão; desligar é a
   constante `CROSS_ACCOUNT_NATIVE_RESUME` (não há tela de failover).
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

- Continuar a **mesma conversa** de Claude → Codex (cross-provider) ou entre
  contas Codex: segue o pacote de continuidade.
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
