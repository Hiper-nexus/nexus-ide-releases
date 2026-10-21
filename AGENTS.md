# AGENTS.md — NexusIDE

Electron IDE monorepo: multi-agent terminal grid, PTY management, MCP
orchestration, and a React renderer. The backend server and mobile companion
are separate workspaces.

## Project Layout

| Path | Responsibility |
|------|---------------|
| `src/main/` | Electron main process (bootstrap, IPC, orchestration, PTY, sandbox) |
| `src/renderer/` | React renderer (UI, state stores, terminal host) |
| `src/preload/` | Preload bridge (context-isolated IPC surface) |
| `src/shared/` | Cross-process contracts, types, and schemas |
| `server/` | Express backend (auth, billing, cron, sync control-plane) |
| `mobile/` | Expo/React Native companion app |
| `shared/` | Shared contracts between server and client |
| `scripts/` | Build, release, security, and dev-environment scripts |
| `docs/` | Architecture, security, and design documentation |
| `resources/` | Static resources packaged with the app (shell integration, model catalog and ranking, pets, heavy-command and wake helpers, builtin-squad resources) |
| `resources/agent-detection/` | Herdr (Apache-2.0) agent screen-state manifests; evaluated by `src/main/detect/` |
| `assets/skills/` | Bundled skills, one `<name>/SKILL.md` each (`oc-pilot`, `oc-builder`, `oc-scout`, `oc-conveyor`, `stack-advisor`, `superpowers`, …). `scripts/bundle-skills.mjs` turns each into the tracked, generated `src/main/orch/<name>-manifest.ts`: edit the SKILL.md, rerun the script and commit both. `bridgeward` and `bridgesecurity` have no folder; they live in `src/main/orch/bridge-mind-skills.ts` |
| `site/`, `cloud-api/` | Public site and cloud API Workers; independent npm projects (see "Site e API vivem aqui") |
| `native/` | Native C code (darwin-pty-supervisor) |

## Security-Sensitive Core Boundary

The following directories mutate the user's real shared config, escape sandbox
HOME confinement, or manage process isolation. Changes here require a relevant
check before delivery:

| Path | Risk |
|------|------|
| `src/main/orch/` | Orchestration coordinator, MCP server registry, CLI agent spawn, **transactional MCP lease** that writes a bearer token into the user's real `mcp_config.json` |
| `src/main/pty/` | PTY session manager, advisory process sandbox (macOS Seatbelt / Linux Bubblewrap / Windows OCI) |
| `src/main/runtime/` | Process sandbox enforcement, `processHome` escape from macOS Seatbelt HOME confinement |

## Site e API vivem aqui (monorepo, 02/10/2026)

O site público e a API deixaram de ser repositórios locais soltos e moram neste repositório,
com o histórico preservado: `site/` (nexuside.app, Worker `nexus-community-site`, Vite multipágina) e
`cloud-api/` (api.nexuside.app, Worker `nexus-cloud-api`, D1 `nexus-cloud-prod`). Cada um é um projeto
npm INDEPENDENTE (não são workspaces; `npm ci` roda dentro da própria pasta, nunca na raiz) com
o seu runner de teste e o seu `wrangler`; a suíte do app (`vitest.config.ts`) exclui as duas pastas e o
empacotamento do app (`shouldPackageFile`, lista permitida) nunca as leva.

- **Deploy do site:** de uma cópia limpa do commit (`git archive HEAD site | tar -x -C <tmp>`), depois
  `npm ci && npm test && npm run build && npx wrangler deploy` DENTRO da cópia; prove produção por `curl` antes
  e depois (o deploy a partir de base presumida já desfez trabalho de outra sessão uma vez). `npm run deploy`
  atualiza o snapshot de releases antes do build.
- **Deploy da API:** `cd cloud-api && npm test && npx wrangler deploy`; segredos só por `wrangler secret put`.
  Nunca commite `.dev.vars`/`.env`: o histórico importado foi varrido e só tem fixtures de teste.
- **Sem comparação com concorrentes:** o site não nomeia outras ferramentas (decisão do operador, 02/10).
- Ramos de trabalho que ficaram pendentes nos repositórios antigos estão preservados como
  `archive/site/*` e `archive/cloud-api/*` neste remoto (árvore na raiz; use `git subtree`/cherry-pick para trazer).

## Plano Trial: 15 dias, 6 agentes simultâneos (05/10; vagas do leque 15/10)

- **Oferta.** O primeiro login verificado abre um teste de 15 dias com até **6 agentes
  simultâneos** e sem sync na nuvem; depois dele o app exige o Pro (agentes ilimitados). A fonte
  única é o `cloud-api` (`cloud-api/src/access.ts`, `cloud-api/wrangler.jsonc`): `TRIAL_DAYS` (padrão 15),
  `TRIAL_MAX_AGENTS` (padrão 6, de 1 a 20) e `TRIAL_CLOUD_SYNC` (padrão `false`). Assinatura paga e
  admin autorizado saem com `maxAgents: null` (ilimitado); suspenso e inativo, `0`.
- **O desktop não fixa número.** `maxAgents()` (`license-access.ts`) lê `limits.maxAgents` do JWT da
  licença (`null` = ilimitado); `docs/billing-stripe.md` descreve o contrato. O limite era 2 antes de
  05/10 (`148bec5c7c`, "teste com seis agentes"): doc, copy ou teste de produto novo nunca escreve "2
  agentes no teste". O `maxAgents: 2` de `pty-manager.test.ts` e `license-lifecycle.test.tsx` é só fixture.
- **Quem conta.** `license-enforcement.ts` reserva UMA vaga síncrona por filho físico de agente: PTY
  por `spawnAgentSession` e ACP por `AcpClient.spawn`; shell e browser não passam por aí. A vaga só
  solta com a prova física do fim do filho (ou de um spawn que nunca criou filho), e adotar um filho
  warm reaproveita a reserva. A recusa é `license_agent_limit`; `TRIAL_AGENT_LIMIT_COPY`
  (`access-guard.ts`) é só preflight de UX, quem decide é o Main. Os spawns por MCP chamam
  `assertLicensedAgentCapacity` antes (`pane-registry.ts`, `tool-util.ts`).
- **O teste não tem execução remota:** `assertRemoteLicenseAccess`
  (`remote/remote-spawn.ts`, a sessão tmux por SSH) recusa com
  `remote-trial-unavailable` enquanto `access === 'trial'`: «Execuções remotas estão
  disponíveis com o Pro».
- **O leque de helpers reserva 2 vagas.** `parallelHelperBudget` recebe `licenseMaxAgents`
  (`currentParallelHelperBudget`, a camada do Main que lê `maxAgents()`; `pane-admission.ts`
  continua puro e não importa a licença). Com teto, o leque nunca passa de
  `max(1, licenseMaxAgents - LICENSE_RESERVED_AGENT_SEATS)` helpers, com `LICENSE_RESERVED_AGENT_SEATS = 2`:
  uma vaga para o Maestro (e o relive dele) e outra para o revisor independente. Trial 6 → 4 helpers;
  plano ilimitado → sem corte. Sem a reserva a primeira onda ocupava as 6 vagas e a missão travava
  sem lugar para o revisor. O piso 1 só ENCOLHE o leque, nunca o zera (zero continua sendo da máquina:
  memória, swap, guard) e quem recusa por licença segue sendo o gate `license_agent_limit`. O corte
  chega ao Maestro como `limitedBy: 'license'` (`budgetCeilingNote`). O teto vale para a primeira onda
  (só o Maestro vivo); nas reposições o gate da licença é o árbitro.

## Install and Rebuild

```bash
npm install                    # runs postinstall: electron install + node-pty patch
npm run rebuild:electron       # rebuild native modules for Electron
npm run rebuild:node           # rebuild native modules for Node (CI/tests)
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript typecheck (`tsc --noEmit`) |
| `npm test` | Full vitest suite |
| `npm run test:changed` | Only tests affected by changed files (git-based) |
| `npm run test:mission-e2e` | Missão inteira de ponta a ponta (Main real, PTY real, CLI falsa); fora de pane; roda no `release:candidate` — [docs/MISSION-E2E.md](docs/MISSION-E2E.md) |
| `npm run security:renderer-sinks` | Static check for unsafe renderer IPC sinks |
| `npm run lint` | `lint:main-sync` + oxlint (quiet) + `tsc --noEmit` |
| `npm run lint:main-sync` | Static ratchet for synchronous process execution (`spawnSync`/`execSync`/`execFileSync`) in Main (F-764) |
| `npm run lint:oxlint` | oxlint over `src server scripts` (`lint:oxlint:ratchet` caps the warning count) |
| `npm run test:perf` | Performance-budget tests (terminal output scheduler, PTY wire, pane grid render, pane output digest) |
| `node scripts/bundle-skills.mjs` | Regenerate `src/main/orch/*-manifest.ts` from `assets/skills/` (`premake` and `prepackage` also run it) |
| `npm run start` | Dev server (hot reload) |
| `npm run make` | Build and package with Electron Forge |
| `npm run release:candidate` | Gate do candidato (assinatura, staple, smoke do ZIP, receipt) |
| `npm run release:security` | Security gate (renderer sinks + audit) |

## Windows: Authenticode só pelo YubiKey (19/10/2026; eSigner fora desde 05/10)

- O eSigner da SSL.com saiu do fluxo em 05/10 por decisão do operador: cobrava por
  assinatura, a build assina dezenas de arquivos e a build automática gerou
  faturas de excesso. Não religue eSigner, CKA nem `WINDOWS_CERTIFICATE_SHA1`;
  `NEXUS_WINDOWS_RELEASE_SIGNING` é recusada em qualquer valor.
- Em 19/10 o operador decidiu que um YubiKey 5C NFC FIPS (série 25700086)
  substitui o eSigner: chave ECC P-384 gerada no slot PIV 9a, atestação aceita no
  pedido `co-f01l53ldh43`. O único caminho de assinatura é
  `NEXUS_WINDOWS_YUBIKEY_SIGNING=1` (`build/windows-token-signing.ts`): o
  certificado da loja do USUÁRIO e, antes de empacotar
  (`prePackage`/`preMake`), checagem do certificado contra
  `build/windows-signing-identity.json` (thumbprint, SHA-256 do SPKI da chave do
  slot 9a, CN da HIPERSEND, EKU de assinatura de código, validade, chave do
  cartão). O modo recusa `WINDOWS_CERTIFICATE_FILE/PASSWORD`, `WINDOWS_SIGNTOOL_PATH`,
  `WINDOWS_SIGN_HOOK_MODULE_PATH`, `WINDOWS_SIGN_WITH_PARAMS` e
  `NEXUS_WINDOWS_SIGNER_DIR`: o `@electron/windows-sign` os lê do ambiente por
  baixo das opções do Forge.
- **Um PIN por agente, não por executável (19/10, `scripts/windows-signer/`).** O
  Windows pede o PIN a cada processo que usa a chave e o Squirrel abria um
  signtool por executável: eram 5 janelas por build, e uma escondida derrubava o
  make. Nenhum SignTool roda mais: o hook `client.cjs` (packager e o signtool
  falso do Squirrel) pede cada assinatura ao agente por usuário (`agent.cjs` +
  `engine.cs` num `powershell.exe` 5.1, `SignerSignEx2`), que abre a janela de PIN
  do próprio Windows uma vez e vive `NEXUS_WINDOWS_SIGNER_HOURS` (24 h padrão, 0 =
  só este build, até 168). O operador pediu "uma vez por dia ou por semana":
  builds seguintes reaproveitam o agente SEM PIN. Ele morre no prazo, no
  `npm run windows-signer -- stop` e quando o YubiKey perde o PIN (sonda
  silenciosa antes de cada assinatura: nunca abre janela escondida). Só assina
  .exe/.dll/.node do `out\` de checkout que fixa este certificado em
  `build/windows-signing-identity.json`, da `src-tauri\target\release` de checkout
  do Nexus Shot que o fixa em `src-tauri/windows-signing-identity.json`, da
  SquirrelTemp e do staging do packager, e anota o SHA-256 de tudo em
  `%LOCALAPPDATA%\NexusIDE\windows-signer\signed.ndjson`. Enquanto vive, qualquer
  processo do usuário que leia o `agent.json` pode pedir assinatura: é o preço do
  prazo, dito no runbook. O `@electron/windows-sign` engole erro de hook; o hook
  marca saída 1 e o `postPackage` confere cada executável pelo agente. Não volte a
  passar `signWithParams`/SignTool ao Forge.
- **Zero PIN nesta máquina (decisão do operador, 19/10, risco aceito por
  escrito).** `npm run windows-signer -- save-pin` abre a janela do motor, o
  cartão confere o PIN e só então ele fica cifrado pelo DPAPI do usuário
  (`%LOCALAPPDATA%\NexusIDE\windows-signer\pin.dpapi`). Daí em diante todo agente
  destranca sem janela, e `install-logon` (HKCU Run, `conhost --headless`, cópia
  dos scripts em `...\bin`) o sobe no logon. Primeira recusa do cartão apaga o
  arquivo; YubiKey ausente não. O PIN só passa pelo motor: nunca o peça, receba,
  logue ou passe por argv/env, e não troque DPAPI por variável, `/kc` ou
  Credential Manager. Qualquer programa deste usuário pode decifrar o PIN:
  `forget-pin` + `uninstall-logon` desfazem.
- **Certificado fixado em 19/10**: série `0FF90DF6…` (ECC P-384, intermediária
  `SSL.com Code Signing Intermediate CA ECC R2`, vence 22/07/2027), thumbprint
  `41BB4AFD0B69AA7B8B88F732E66808A2A5B93560`. O baixável antigo (série 7538CB4E…,
  RSA 3072) é o do eSigner e não combina com a chave. O PC que assina precisa do
  **YubiKey Smart Card Minidriver**: o driver PIV nativo do Windows (`msclmd.dll`)
  não expõe a chave ECC P-384 (`NTE_BAD_KEYSET`, certificado fora da loja do
  usuário). Runbook: `docs/windows-signing/YUBIKEY.md`. Nunca peça, receba ou
  digite o PIN ou o PUK pelo operador (nem se ele pedir): ele digita na janela que
  o agente abre (a do Windows ou a do `save-pin`).
  Cobre o NexusIDE inteiro, inclusive o `NexusRedline.exe` do pacote e o instalador
  Squirrel. **Regra do operador (19/10): todo app Windows assinado usa este
  YubiKey.** O Nexus Shot (repo próprio, Tauri) assina pelo mesmo token e, desde
  20/10, pelo MESMO agente: o `scripts/windows-sign.ps1` dele fala com o pipe do
  `agent.json` (zero PIN), sobe o agente pela cópia do logon quando há PIN guardado
  e só sem agente nenhum cai no SignTool com janela. O que o NSIS assina fora da
  `target\release` (desinstalador `nst*.tmp` no TEMP) passa por uma cópia dentro
  dela: o agente não ganhou raiz no TEMP nem a extensão `.tmp`. Mudou o agente?
  `npm run windows-signer -- install-logon` de novo, ou o Shot é recusado pela
  cópia velha. Renovação troca o thumbprint nos dois repositórios.
- O JSON é a fonte única: o coletor (`collect-windows-release.ps1`) grava
  `signing: 'yubikey'` só com Setup, app, Update.exe e stub assinados e carimbados
  pelo certificado fixado (thumbprint e SPKI conferidos); nenhum assinado vira
  `signing: 'none'`, e a mistura é recusada. O publicador aceita os dois valores e
  confere as assinaturas contra o JSON. `build/*` é ignorado no git: arquivo novo em
  `build/` que o Forge importa precisa de exceção no `.gitignore`
  (`forge.config.test.ts` trava).
- `windows-release.yml` gera o candidato sem Authenticode numa máquina do GitHub
  (`windows-latest`), que não tem o token: lá o recibo (schemaVersion 2) continua
  `signing: none`, com o hash de cada executável. O MSIX da Microsoft Store é outro
  caminho (a Store assina).
- Sem crédito/orçamento do GitHub Actions (o job falha em segundos com "An
  Actions budget is preventing further use"), o candidato Windows é gerado
  LOCALMENTE no PC Windows do operador (`npm run make` + `npm run
  release:candidate`, mesmo recibo schemaVersion 2 com o hash de cada executável,
  `signing: yubikey` quando assinado pelo token e `none` sem ele) e os artefatos
  sobem para a Release com `gh release upload`.
  Com orçamento, o caminho padrão continua sendo o `windows-release.yml`.

## Authoritative Owners

- **Visual design tokens and component styles**: `DESIGN.md`
- **Architecture and module boundaries**: `docs/ARCHITECTURE.md`
- **Security boundaries and threat model**: `docs/SECURITY.md` holds the
  fail-closed contract and the ownership table. The substantive analysis lives
  in `docs/security-audit-2026-07-16.md` (threat model and findings),
  `docs/security/OWASP-ASVS-L2-PROFILE.md` (control profile), and
  `docs/security-best-practices-report.md`. Read those before changing anything
  under `src/main/orch/`, `src/main/pty/`, `src/main/runtime/`, or
  `src/main/remote/`.
- **QA bug workflow**: `docs/QA-PROTOCOL.md`
- **Release readiness gate**: `docs/RELEASE-CHECKLIST.md`
- **Co-located tests**: every source file has a `.test.ts` sibling — run it
  after editing the source.

## QA and Release Process (from Overclock adaptation)

- Register bugs as `docs/qa/items/F-XXX.md` using the format in
  `docs/QA-PROTOCOL.md`. 1 bug = 1 file, never append to a single ledger.
- Validate fixes with `npx tsc --noEmit` and `npx vitest run path/to/file.test.ts`
  before marking `corrigido`.
- For renderer or IPC changes, also run `npm run security:renderer-sinks`.
- Use `git add` per finding, never `git add -A` or `git add .`.
- Before declaring a release ready, walk through `docs/RELEASE-CHECKLIST.md`.

## Resolução de Travamentos e Paridade Overclock

- `src/main/usage/usage-service.ts`: telemetry agora absorve erros de scope
  identity collision (`snapshot`, `notifyMediaGenerated`, `#onSessionDictated`)
  em vez de propagar exceções que travam a UI de quota/custo.
- `worker-handoff-ttl.ts` (opt-in) espelha Overclock 1.2.4: workers idle com
  handoffs consumidos são encerrados após ~30s, liberando panes e contexto.
- Para diagnóstico no app Overclock empacotado, use o script local
  `~/.overclock-app/overclock-doctor.mjs` (report/limpeza de marcadores órfãos
  e missões travadas).

## Multi-conta: o que prova um login novo

Quem tocar em Providers, no menu "+ Pane" ou no terminal de login precisa
saber isto antes de mexer:

- **Uma CLI guarda UMA sessão por vez.** Entrar na 2ª conta sem guardar a 1ª a
  perde para sempre. Por isso `AccountsManager` preserva a sessão atual
  (`addActiveSession`) ANTES de abrir o login de cadastro. O motor deduplica
  por subject/blob e mantém o rótulo da linha existente, então preservar é
  idempotente.
- **Fechar o terminal, estourar o tempo ou reencontrar `authReady` não provam
  login nenhum.** A prova é `cliLoginProvedNewSession(baseline, atual)` em
  `src/renderer/components/settings/cli-login-terminal.ts`: sonda `ok` mais
  identidade de sessão que surgiu ou mudou em relação ao baseline colhido
  ANTES de abrir o terminal. Sem prova, a UI diz que não deu — nunca grava uma
  conta que talvez seja a mesma.
- **A identidade é `AdapterAuthStatus.sessionFingerprint` (opaco, só
  igualdade), com o e-mail da sonda como segundo caminho.** Nunca exiba,
  registre nem persista o fingerprint. É ele que distingue A de B em CLI sem
  e-mail (Kimi, OpenCode) e prova reautenticação da mesma conta.
- **Conta sem e-mail é conta.** `addActiveSession` aceita rótulo e devolve
  `id`; use o `id` para selecionar a conta, nunca o nome.
- **Sem `supportsSnapshot` não há duas sessões nativas em paralelo.** Diga
  isso na interface e aponte a API key; não prometa isolamento que o adapter
  não implementa.
- A ação administrativa do "+ Pane" vive na decoração local
  (`withAccountActions`), fora de `buildPanePickerEntries` — aquele catálogo é
  compartilhado com a grade de terminais, onde cada linha é um terminal.
- **Recibo da escolha de conta** (`account-choice-receipts.ts`): a regra de
  folga decide (Jev NÃO escolhe conta — comparar cota medida é aritmética);
  `prepareProviderSpawn` devolve `overrides.accountChoice`, registrado por
  sessionId no spawn e devolvido em `nexus_pane_spawn` (`harness.account`) e
  `nexus_pane_whoami`. Rótulos sempre mascarados (`maskAccountLabel`); nunca
  id, fingerprint ou token.
- **O recibo da escolha de conta também aparece no cabeçalho do pane** (chip
  por último no meta do `PaneToolbar`; `accountChoice:get` →
  `accountChoiceChipView` em `shared/account-choice-display.ts`), com a mesma
  máscara. O IPC devolve o recibo já saneado (`parseAccountChoiceReceipt`, lista
  de permissão); o tooltip é o `title` nativo, porque o `::after` do `data-tip`
  é cortado pelo overflow do toolbar. Só diz o que o recibo traz: `pinned` e
  `native` não listam alternativas (não concorreram), `legacy` não tem chip.
- **A conta ativa fica até a cota medida zerar.** `chooseAccount` não entrega
  o pane à irmã só porque ela tem mais folga. Troca quando a ativa está fora
  da lista (cooldown, sem credencial, excluída pelo hit) ou quando a
  disponibilidade medida é 0. Cota desconhecida mantém a ativa. Sem conta
  ativa, a mais livre vence.
- **Folga só entre janelas comparáveis (F-995).** Com o snapshot, a regra de
  folga recebe as janelas por conta (`quotaByAccountId`) e decide por
  `compareAccountHeadroom` (`src/main/quota/account-headroom.ts`): esgotada
  perde; janelas medidas nas duas contas decidem pela mais apertada (a que
  limita de fato, com reset no recibo); janela que só uma conta leu dá a
  vantagem a quem a leu, da mais curta (5 Horas) para a mais longa. **Sem
  leitura não é folga**: ativa lida pela metade (Semanal sim, 5 Horas não)
  cede à irmã que PROVOU folga na janela que a ativa não leu. Ativa sem
  leitura nenhuma continua (cota fora do ar não é evidência). O escore
  escalar (`quotaAvailabilityScore`) não compara contas entre si.
- **Recibo diz a verdade (F-995).** `pinned`/`native` não concorreram: as
  irmãs saem como `not-compared`; sob "ativa mantida" a irmã com MAIS folga
  sai como `active-kept`; `less-headroom` só quando ela tinha menos. O pane
  Claude do "+ Pane" não é mais fixado na ativa pelo renderer
  (`shouldAutoPinPaneAccount`): o Main escolhe pela regra de folga e o
  renderer persiste a conta que o Main devolveu.
- **Limite confirmado troca até conta fixada e o pane do operador (F-995).**
  O pin não prende ninguém num pane parado: quando a conta fixada ESGOTA com
  limite confirmado (F-249 intacto), o failover troca para a irmã com folga e
  avisa. O orquestrador de missão que mora num pane do renderer (inclusive o
  pane do operador adotado pela missão da aba) é religado PELO MAIN
  (`switchRendererOrchestratorAccount` → `rebindPaneAccount` + 
  `requestMissionPaneRecovery`): o renderer não religa pane de missão viva
  nem mata sessão de missão, e a cerca do spawn persistido exige a conta
  selada. Mesmo pane, sessão nova com o pacote de continuidade; `switched`
  e o trace `account-failover` só saem depois do religamento, e o recibo da
  sessão nova traz a nota "troca automática por limite confirmado". Conversa
  nativa entre contas continua fora (ids de sessão são da conta).
- **A conta que É o login nativo não ganha escopo gerenciado (F-645).**
  Refresh token rotaciona: duas cópias dele (o store nativo e um
  `managed-accounts/claude/<id>/auth` semeado do vault) não sobrevivem juntas —
  quem renova primeiro mata a outra, e se for o pane ou a sonda de cota, cai o
  login do operador. `claudeAccountIsNativeLogin` decide (dono do token vence
  e-mail antigo); o pane dessa conta usa o store nativo (`{}` ou access token
  por env em HOME isolado) e a cota lê só o perfil nativo. Não volte a
  materializar escopo nem rodar `claude /usage` em escopo para ela.
- **Fora do macOS o login nativo é gravado no lugar (F-646).** A CLI regrava
  `.credentials.json` por temporário + rename, então link ou cópia no overlay
  vira segunda linhagem na primeira renovação. Pane direto com login nativo
  recebe `CLAUDE_SECURESTORAGE_CONFIG_DIR=<~/.claude real>` e o overlay não
  recebe o arquivo (`nativeCredentialsInPlace`).
- **Token de acesso vencido não é sessão perdida (F-639).** Com refresh token,
  o spawn deixa a própria CLI renovar (um run no store que o pane vai usar) e
  prova a identidade no token novo; "entre novamente" só se nem ela conseguiu.
  Na Reserva (só cofre, sem CLI dona), `ensureFreshClaudeSubscription` renova
  por HTTP sem prova prévia apenas se o refresh token não estiver no login
  nativo nem em outra linha do cofre, e o token novo prova a conta antes de
  entrar no cofre. Escopo gerenciado vencido com OUTRA linhagem, mais velha
  que o cofre, não bloqueia essa cura (a cota cai para o passo 3); com a
  mesma linhagem, a CLI continua sendo a única que renova.
- **«Entrar novamente» da mesma conta abre o login mesmo se o snapshot vivo
  falhar.** O aviso «Não consegui guardar a conta atual» continua quando o
  cadastro de uma segunda conta não consegue gravar a primeira, e quando o
  e-mail da sessão viva é de outra conta. Sessão `missing` não tem o que
  guardar e não bloqueia o login.
- **O `codex login` revoga o login que encontra (medido no 0.162).** Antes do
  device flow ele faz POST em `auth.openai.com/oauth/revoke` com o token do
  `auth.json` e apaga o arquivo, mesmo se o login for cancelado; `codex
  logout` e o `/logout` do pane também revogam. O terminal de login roda no
  `~/.codex` nativo, onde mora a mesma linhagem que o Nexus guardou da conta
  atual: entrar na conta B matava a conta A. Contrato do login Codex
  (`openCliLoginTerminal` + `prepareCodexNativeLogin`/`restoreCodexNativeLogin`):
  - **Um login por vez.** `prepareCodexLogin` recusa um segundo enquanto houver
    um pendente com menos de 16 min ("Já há um login do Codex em andamento");
    pendente mais velho é terminal abandonado (o device code vence em 15 min):
    a sessão dele volta e o novo login segue.
  - **Nada sai da vaga sem dono.** Sessão usável sem conta dona vira conta
    (`addActiveSessionAccount`) antes; sem conseguir salvar, a vaga fica e o
    login não abre. Cofre ilegível diz qual conta travou e o login não abre.
  - **Saída atômica.** A vaga sai por `rename` para um temporário no próprio
    `~/.codex`; a conta dona recebe a cópia movida (uma renovação que caia
    nesse instante vai junto); qualquer falha devolve a vaga como estava. A
    leitura é só de arquivo comum até 1 MB, num descritor `O_NONBLOCK`
    (`readRegularFileCapped`): FIFO e `/dev/zero` travavam o Main.
  - **O pane morre com a CLI.** No POSIX o login é digitado como
    `exec env -u CODEX_HOME codex login --device-auth`: ↑ + Enter no mesmo pane
    rodaria outro `codex login` e revogaria a conta recém-salva, e um
    CODEX_HOME do rc do shell desviaria a gravação para fora da vaga. A morte do
    pane é desfecho final (Ctrl+C devolve a sessão na hora). Windows não tem
    `exec`: o pane fecha quando o watcher solta, e CODEX_HOME do perfil do
    shell não é limpo (limitação conhecida).
  - **Devolução em todo desfecho.** O renderer chama `restoreCodexLogin` ao
    soltar, verificado ou não: vaga ocupada por login novo só encerra o
    pendente; vaga vazia recebe a cópia mais fresca (0600, `wx`, link volta
    link). Falha mantém a cópia no Main e vira aviso (toast); se o comando nem
    foi digitado, a sessão volta antes de o pane fechar. O shutdown do Main
    também devolve. Sem a ponte de preparo no preload, o login falha fechado.
  - Nunca oriente logout para trocar de conta; o `/logout` do menu do Codex
    avisa que revoga a sessão da conta no provedor.
- **Identidade Codex = workspace + pessoa.** O subject é o `tokens.account_id`
  (workspace): duas pessoas de um workspace Team/Business o compartilham. Com
  o mesmo subject, o `chatgpt_user_id`/`user_id` do claim
  `https://api.openai.com/auth` (id_token, depois access_token) separa as
  pessoas; o e-mail só decide quando nenhum dos dois lados traz user id, porque
  uma renovação da mesma linhagem pode trazer outro e-mail
  (`compareAuthBlobIdentity`, fingerprint da sessão, candidatos de read-back).
- **Limite não confirmado não troca o pane (F-249).** Texto de PTY citado
  (handoff, `cat` de log, narração do Maestro) casa no detector de limite —
  `⎿ usage limit reached` não é prova de que a CONTA do pane atingiu nada.
  Sonda de cota sem resposta ⇒ cooldown capado de 15 min na conta + pane
  segue na MESMA conta + `scheduleUnconfirmedLimitRetry` re-sonda no fim:
  refutado limpa o cooldown sem tocar o pane; confirmado/sem-dados troca lá.
  E `switched:true` só sai DEPOIS do religamento real (pane main-owned faz o
  respawn antes de emitir); toda decisão sai no trace `account-failover`.
  Nunca volte a trocar pane ou a emitir sucesso por texto não confirmado.
- **Estrangulamento que a própria CLI administra não é limite (F-718).** O
  enxame do Kimi Code re-enfileira subagentes no 429 de concorrência e mostra
  "Rate limited…"; o tower pausa spawns por segundos. `detectLimit` tira essas
  frases exatas (`CLI_SELF_MANAGED_THROTTLE`) antes dos padrões. CLI nova com
  rótulo de fila/backoff próprio entra ali com a string exata do bundle, nunca
  afrouxando o padrão de "rate limit" para todo mundo.
- **O pacote de continuidade é seguro por construção (F-999).**
  `buildContinuityPack` (shared, Main e renderer) redige segredos
  (`redactTerminalText`: chave partida pela quebra da TUI, cauda cortada no
  meio de um token, PEM) e neutraliza sinais de limite em TODO campo do
  chamador; não monte pack à mão nem dependa do chamador para limpar. A tabela
  de sinais do detector, a linha F-511 e `CLI_SELF_MANAGED_THROTTLE` moram em
  `src/shared/limit-signal-patterns.ts`: padrão novo entra lá, detector e
  neutralização seguem juntos. Sinal de MODELO lido no terminal até 120 s
  depois do pack (eco ou colagem) só vale na 2ª ocorrência; o observer da CLI
  vale na hora.

## Perfil de Operador: entrada sempre visível (F-1521)

- O perfil só abria por "Meu perfil" no rodapé das Configurações e por Ctrl/⌘+Shift+O: o
  HUD saiu do chrome em 10/08 (`ceeece469`) e do rodapé das Configurações em
  05/09 (`b6e9a3a0c`). `OperatorHud` mora numa faixa PRÓPRIA do rodapé da rail (fora de
  `.workspace-rail__utilities`, que o modo foco esconde). Não monte o HUD dentro
  das utilidades da rail. Em modo sóbrio o HUD some; o perfil segue por
  "Meu perfil" nas Configurações e por Ctrl/⌘+Shift+O.
- F-1542: o XP que o operador VÊ é global (patente, poder, próximo marco e XP de
  hoje = soma dos projetos); o que GANHA continua gravado por projeto. O nexus-ide
  mostrava RECRUTA ao lado do HiperGO com 6.886 eventos. `GlobalXpLedger`
  (`<userData>/gamification/global-xp.json`, escrita atômica) guarda só valor
  absoluto, rótulo curto (pasta), chave em hash e dia, nunca caminho; cada serviço
  de escopo informa o PRÓPRIO valor, nenhum lê o banco de outro projeto. A soma só
  conhece projetos abertos desde esta versão: diga isso na UI, não prometa total
  histórico. Conquistas, quests, sequência e prestígio seguem por projeto
  (`withGlobalXp` troca só poder/patente/marco/hoje).
- O HUD só conta e celebra ganho do MESMO escopo (`rootRealPath`): trocar de
  projeto ou hidratar o snapshot não é XP novo.
- `operator-profile-style.test.ts` trava hex literal, animação em loop,
  eyebrow em caixa-alta e opacidade em conquista travada no CSS do perfil.

## Uso e custos no registro do T3 e gasto mensal real em USD (15/10)

- **Painel.** `UsageSnapshot.analytics` (opcional: Main antigo e snapshot vazio
  não trazem, e a tela some com o painel em vez de mostrar zero) carrega a série
  diária por provedor (até 90 dias) e, para as janelas de 7, 30 (padrão) e 90 dias
  locais, o agregado por provedor (sessões distintas, custo, % do custo, tokens),
  por modelo e os totais detalhados (processados, cache, sem cache, output,
  economia de cache). O rollup mora em `ScopedUsageStore.analytics`; o
  `UsageTelemetryService` o guarda por 1 min (`ANALYTICS_TTL_MS`) ou até virar o
  dia, porque o broadcast sai a cada segundo, e falha no rollup não derruba o
  snapshot. `UsageOverview` e `MonthlySpendCard` entram em `UsageQuotaSection`;
  as cores de série são os tokens `--series-1..6` (`base.css`, DESIGN.md §17).
- **`costUsd` do painel é o equivalente de API pública**, não fatura nem débito
  do plano. Só os leitores de transcrito de `claude`, `codex` e `mimo-code`
  gravam tokens (`usage-service.ts`); CLI sem leitor próprio não aparece no
  gráfico, e isso não é gasto zero.
- **Gasto mensal real.** `settings.spend` (`~/.nexus/settings.json`) guarda
  `entries[]`: `id` (`plan:<linha de cota>` para conta detectada, `custom-…`
  para avulsa), `label`, `kind` (`subscription` ou `api`), `provider` (logo),
  `monthlyUsd` (0 a 100.000) e `active`. O preço de plano que o Nexus detecta é
  preço de LISTA (`account-plan.ts`: só claude, codex e agy; Team/Enterprise e
  tier novo ficam sem preço); o valor salvo é o que a pessoa paga e VENCE o
  detectado. Máximo de 64 linhas; na leitura uma linha corrompida cai sozinha e
  id repetido fica com a primeira.
- **IPC.** `settings:spend:get`, `settings:spend:set` e `settings:spend:changed`
  (`handleTrusted`). O renderer manda a lista INTEIRA, que substitui a salva
  (duas abas não mesclam linhas); patch inválido (valor negativo, acima do teto,
  id repetido) devolve a lista que já estava salva. No preload são
  `settings.spendGet/spendSet/onSpendChanged`.
- **Conta.** `shared/monthly-spend.ts` é puro: `computeMonthlySpend` soma as linhas
  ativas (assinaturas + API), conta `unpricedCount` (total incompleto enquanto
  houver linha ativa sem preço) e calcula a economia contra o equivalente de API
  dos últimos 30 dias de TODOS os projetos (`recentApiEquivalentUsd`, do
  `usage:history`); sem leitura a economia é `null`, nunca inventada, e negativa
  quer dizer que a pessoa pagou mais do que a API custaria. Os atalhos do cartão
  são US$ 20, 100, 200 e 500, e `PLAN_PRESETS` só tem plano com preço de lista
  conhecido (Claude Pro/Max 5×/Max 20×, ChatGPT Plus/Pro): Cursor, Grok, GLM e Gemini
  entram como linha livre. `parseUsdInput` aceita `$20`, `20,50` e `1.200,50`.

## Rail em lista plana, um grupo por projeto (15/10)

- O rail é uma lista plana (DESIGN.md §16; guard em `workspace-rail-style.test.ts`):
  projeto = cabeçalho de texto, missão = UMA linha com glifo de estado, agente =
  linha aninhada. Não volte a cartão, borda em repouso, selo em caixa-alta,
  listra lateral de acento nem hex no CSS do rail; o único movimento que repete
  é o pulso `state-breathe` de "ao vivo", e só nas folhas.
- "Em andamento" lista, ao mesmo tempo, todo projeto com trabalho vivo
  (`projectRailWorkspaces`: o aberto + vizinhos com missão running/blocked/
  recovering, relidos a cada 60 s por `hydrateCrossWorkspace`). O renderer só
  tem os panes do projeto aberto: vizinho mostra missões, nunca contagem de
  agentes; panes soltos de outro projeto não aparecem (vivem em `parkedHosts`,
  dentro do `terminal-host.ts`, sem assinatura para o rail).
- "Recentes" nasce recolhido e só abre sozinho com o grupo de cima vazio (sem
  projeto aberto; o aberto conta como "acima" mesmo ocioso, grupo "Projeto
  atual"). A escolha da pessoa vive em `loadRecentWorkspacesOpen` (tri-state:
  `null` = sem escolha). A seleção nunca some atrás do recolher.
- A palavra do estado da missão só ganha linha própria quando ela pede algo da
  pessoa (`missionNeedsWord`); nas demais o estado vive no glifo, no `aria-label`
  e no `title`. Teste novo de estado de missão confere o `aria-label`, não o
  `textContent`.
- Alvo e contraste (revisão independente de `de645e3d1`):
  `workspace-rail-style.test.ts` trava o piso de 32px (44px no toque) dos
  controles da lista `TARGETS` (linhas, disclosures, ações de linha, atalhos em
  ícone) e 4,5:1 do texto de hierarquia sobre `--bg-bar` nos 7 `PALETTES`. NÃO
  chegam a 32px, fora do guard: cabeçalho do card de Cotas (~14px), "Abrir uso e
  cotas" (~22px) e "Reportar bug" (~22px); não escreva que todo controle do rail
  tem 32px. O `--text-faint` do `nexus-light` media 4,36:1 sobre a barra porque
  só `--bg` e `--bg-elevated` eram conferidos; a causa era a paleta (`base.css` e
  `ui-theme.ts` guardam o mesmo valor e `ui-theme.test.ts` confere que andam
  juntos), não os seletores.
- Linha selecionada do rail: tinta de acento de 6% (a 12% eram 7 pares abaixo de
  4,5:1; teto medido 7,3% no `nexus-light`/`--text-dim`, 9,1% no
  `solarized-dark`/`--text`), o hover guarda a mesma tinta, e dentro de
  `.workspace-rail__row--selected` o `--text-faint` é reapontado para
  `--text-dim` (o faint do `nexus-light` dá 4,27 sobre a tinta). O guard exige
  4,5:1 de text/dim/faint nos 7 temas sobre essa linha, em repouso e no hover,
  sem catraca de dívida. Tinta maior ou o reapontamento removido reprovam lá.
- Abrir projeto no rail (16/10): "Abrir projeto existente" é uma LINHA com texto
  logo abaixo do Novo pedido (`.workspace-rail__actions`, coluna única), não
  mais um ícone de pasta sem rótulo ao lado dele (ninguém o achava). Nome,
  tooltip e atalho vêm de `WORKSPACE_OPEN_ACTION` (`lib/action-names.ts`), o
  registro do Início, onde "Trocar pasta" leva o mesmo `title`. Pegadinhas:
  "Abrir pasta" já é "mostrar no Finder" (toast de captura, `AccessBoundary`) e
  "Abrir Projeto" é a visão geral do projeto, então nenhum dos dois serve de
  rótulo e o nome acessível não pode colidir (`WorkspaceRail.test.tsx`). O
  tooltip promete "pasta nova" porque o seletor do main usa `createDirectory`
  (`workspace-store.ts`; `action-names.test.ts` lê o fonte). O seletor não é
  modal no Windows (`owned-open-dialog.ts`) e `pickWorkspace` do App não tem
  guarda de clique duplo: dois cliques rápidos podem abrir dois diálogos.

## Conventions

- Co-located tests: `foo.ts` → `foo.test.ts` in the same directory.
- Run the focused test before delivery: `npx vitest run path/to/file.test.ts`.
- Run `npm run typecheck` after any source change.
- The build chain (`premake` / `prepackage`) enforces typecheck, renderer-sink
  security, and native checks before build or package.

## Project Skills

- **Landing page / marketing UI**: Whenever a request involves landing pages,
  marketing sites, web UI, page sections, components, prototypes, or UI copy,
  invoke the `landing-page-design` skill from `.devin/skills/landing-page-design/SKILL.md`
  before designing or writing a single line of code. Do not ask the user to point
  to it manually.

## Via Rápida: escritores isolados

- `nexus_pane_spawn({ isolatedWriter: true })` sem contrato congelado cria
  uma worktree por spawn pelo `WorktreeManager` (GitRunner + CoW opcional).
  Leitor (`readOnly` explícito ou herdado) sem `isolatedWriter` não aloca
  worktree nem disputa a vez do checkout. F-1318: `isolatedWriter: true`
  explícito vence o rótulo `readOnly` (no Autopilot ele é consultivo; o
  "leitor" que pede worktree é writer e nasce `isolated_worktree`).
- Writer comum que colidiria com outro ativo no mesmo checkout é auto-isolado
  (`reason: auto-isolado: …`), na mão do operador e na missão, em vez de
  recusado. Se o auto-isolamento falha (ex.: HEAD solto no checkout de
  coordenação), o writer fica no checkout com o claim síncrono (F-981) e o
  recibo traz `isolationFallback {reason, blockedBy}` com `executionMode:
  same_checkout` e o contrato de checkout compartilhado, sem a promessa de
  "único writer". Só o pedido explícito (`isolatedWriter: true`) recusa.
  `isolatedWriter: false` explícito não auto-isola, e a colisão vira recusa
  clara (`isolatedWriterDisabledRefusal`).
- O recibo do spawn diz o que integrar: `isolatedWorktree {branch,
  worktreePath, baseSha, note}` (mais `reason` e `cwdDiscarded` quando houver).
  Não há merge automático: o Maestro integra as branches na ordem de
  dependência, depois de ler o diff e rodar a prova.
- Salvaguarda do writer (F-794): alteração sem commit na worktree vira um
  commit filho do HEAD em `refs/nexus-salvage/<branch>/<carimbo>` quando o
  writer entrega o handoff, quando o pane sai ou fecha e, como último recurso,
  quando o escopo do projeto reabre depois de um encerramento do app
  (`isolated-writer-salvage.ts`). Usa índice privado, nunca `git stash`, e não
  toca branch, índice real nem arquivos; é idempotente e fica fora de
  `refs/heads`. O writer declara no handoff que houve salvaguarda.
- Registros `ownerKind: 'pane'` usam um taskId técnico, sem criar task de plano;
  a varredura de tasks órfãs deve preservá-los. Branches usam hashes curtos dos
  ids de missão/worker, derivados por `worktreeBranchRef` nos validadores também.
- A base é HEAD do escopo; WIP do checkout de coordenação não é copiado nem
  exige limpeza. O caminho selado mantém a exigência de checkout limpo.
- Antes de congelar a base, `WorktreeManager.create()` refresca o upstream da
  raiz de coordenação (`refreshUpstreamDriftAsync`): `fetch --prune origin`
  (só toca `refs/remotes/origin/*`, fail-open em falha de rede, no máximo um
  fetch bem-sucedido por raiz a cada 60 s — cache em memória no manager) e
  `merge --ff-only @{upstream}` SÓ com a branch rastreando origin/*, a árvore
  comprovadamente limpa (rastreados) e o histórico estritamente atrás. Branch
  sem upstream origin/* (ex.: a branch de feature do operador) é medida contra
  `origin/HEAD`/`origin/main` SÓ para o aviso de atraso, sem ff e sem tocar na
  branch. Nunca destrói WIP.
- `isolated-writer-worktree.ts` libera a reserva por `markFailed` no tap de
  saída física do PTY, inclusive fechamento/teardown de missão, ou em falha
  de spawn sem pane vivo. ACK pendente mantém a reserva de worktree.
  Recovery no registry libera reservas de pane de um processo anterior.
  Branch e diretório ficam preservados para integração manual pelo Maestro;
  liberar a reserva não autoriza apagar commits ou WIP não integrados.

## Handoff sem missão (F-565)

- `nexus_pane_spawn` guarda `operatorParentSessionId` no metadado do Main para
  filhos do operador sem missão. Esse vínculo não vem dos argumentos MCP nem
  do renderer; panes existentes sem vínculo não ganham um pai por inferência.
- O handoff de workspace usa o ledger atual com `mission_id = NULL` no banco
  do checkout. `list({ missionId: null })` seleciona somente essas linhas;
  `undefined` preserva a consulta de auditoria do store.
- A entrega ao pai usa `injectPrompt` (mesmo transporte de `nexus_pane_write`),
  revalidando sessão, checkout e ausência de missão/contexto obsoleto durante
  a operação. Falha de transporte mantém a linha `queued` e retorna
  `delivered: false` com `deliveryError`; o operador ainda pode listar a linha.
- Esse caminho nunca emite evidência/recibo de missão, ACK, avanço de task ou
  conclusão. A auditoria MCP continua no dispatcher; o handoff é `unverified`.
- **F-239: handoff em rodadas** — recibo mais recente entregue + payload novo
  = rodada nova (handoff novo, recibo novo); entrega ainda pendente =
  replay/recusa. A transição de dispatch só quando o dispatch está `running`;
  `handoff_ready` e além seguem pelo caminho de replay puro.
- **A devolução abre a próxima rodada (F-782/F-1319/F-1388/F-1409).**
  `nexus_handoff_ack({ handoffId, verdict, note })` é só do orquestrador físico
  da missão (`accepted` é o padrão; `accept`/`approve`/`ok` = aceito,
  `reject`/`redo` = `rework`). Com `rework` e `note`, o Nexus entrega
  `[NEXUS_REWORK] …` ao MESMO writer: digitado no PTY se o pane vive; senão o
  writer é reaberto com `resume` na própria worktree e a nota é o prompt; sem
  conversa retomável nasce um pane novo na mesma worktree com o brief, a nota e
  os commits já feitos (`resume.mode: 'fresh-in-worktree'`). Writer sem
  worktree própria devolve `reworkDelivered: false` com o motivo, e o Maestro
  abre outro writer com a nota. O novo `nexus_handoff_submit` do writer é a
  rodada seguinte e pede outro ACK. O veredito vira rótulo: a revisão de
  evidência é marcada certa ou errada e o `rework` conta como falha na taxa de
  sucesso da CLI/modelo que a rota usa. ACK aceito de entrega não-success fecha
  o worker armado; `rework` mantém o pane vivo para a nota. O ACK não conclui a
  missão sozinho, mas a conclusão verificada exige o recibo.
- O handoff sem missão não tem ACK: o pai (o agente do operador que abriu o
  helper) recebe a entrega como mensagem `unverified` e verifica por conta
  própria. As skills `oc-pilot`, `oc-builder`, `oc-scout` e `oc-conveyor`
  (`assets/skills/`) descrevem esse contrato para os agentes; mudou o contrato
  aqui, mude a skill e rode `node scripts/bundle-skills.mjs`.

## Uma missão nunca mistura workspace (F-634/F-635)

- A árvore de layout do renderer é UMA só. Ao trocar de projeto, o que está
  nela quando a troca começa é do workspace que SAI (`outgoingPaneIds` em
  `switchWorkspaceLayout`): `hydrate` nunca carrega esses panes para o alvo,
  nem os de missão. Só a missão que aterrissou durante a leitura sobrevive.
- Todo caminho que espera (settle do layout, IPC, STT, cópia de anexo) e só
  depois monta ou digita num pane confere o escopo de novo:
  `isPresentationScopeCurrent` na recovery/apresentação, workspace no
  `reopenMission`. Digitação do renderer (`writeToPane`, `submitPromptToPane*`)
  recusa host estacionado — a sessão continua viva, mas é de outro projeto.
- Em Autopilot a missão criada pela mão do operador (`nexus_mission_create`,
  role `user`) nasce `running` com contrato aprovado e despachado em modo
  livre (`freeAgentChoice`) e sem squad, salvo `squadId` explícito (F-649).
  Sem contrato todo worker voltava `approval_required`; com o `nexus-fullstack`
  imposto vinham `squad_binding_violation` e `route_reservation_required`.
  Validar "a missão nasce rodando" só no intent gate não prova nada — o spawn
  real exige contrato. Hardened mantém squad padrão e despacho na interface.
- Missão `done`/`failed` devolve a mão do operador ao pane que ela promoveu
  (`returnOperatorHandFromEndedMission`, no `dispatchToolCall`, F-650).
  `blocked` mantém o vínculo: é a espera pela resposta do operador. O Nexus
  opera pelo "+ Pane" E por missão; missão nunca deixa o pane do operador estéril.
- Missão parada tem saída na mão do próprio pane (F-651): ele retoma a `blocked`
  (`running`, `operatorHand` no intent gate) e toda recusa de intenção traz o
  `hint` com a chamada exata. Recusa nunca manda pedir "despacho" ao operador —
  missão criada pelo MCP não tem botão de despacho. A invariante em
  `mcp-dispatch-security.test.ts` percorre todo status; trava nova no caminho
  do pane do operador precisa passar nela.
- F-738: o selo `runtime-closed` só prova "encerrada pelo operador" se for o
  veredito MAIS RECENTE da descrição (`wasMissionRuntimeClosedByOperator`;
  `leftover-parked` não o substitui). O bloqueio que o Maestro declara por
  `set_status` (`withAgentStatusVerdict`) tira selo velho e veredito anterior.
  `blocked_user` sem pergunta REGISTRADA (o Maestro perguntou no chat e o
  reconciliador o encerrou) sai por `resume`, com remount do operador. Só
  pergunta registrada (`resolveOpenMissionQuestion`) exige answer-question.
- F-245: `blocked_technical` oferece `resume` (remount do operador com nota de
  continuidade, qualquer causa — inclusive chef-idle sem marcador de dispatch);
  `retry-kickoff` com Maestro dispensado lança `orchestrator_operator_dismissed`
  (erro visível) em vez do skip silencioso do remount automático.

## Abas dos Terminais: aba = feature (23/09)

- F-231: "+ Pane" numa aba que hospeda missão viva abre um passo de destino —
  "Nesta missão" (worker `operatorOpened` via `missionSpawnOperatorPane`
  Main-owned: entra no Quadro/ledger, roda na worktree da missão, mas só a
  mão do operador o fecha; mortalidade/TTL/teardown o ignoram e no fim ele
  volta a `user`), "Nesta aba (solto)" (spawn normal + `homeScopeKey`
  persistido — sem ele o efeito foco-segue mandava o pane para "Terminais")
  ou "Nova aba". Shell/browser nunca viram participantes.
- `WorkspaceTabs` substituiu o rack de cartões (`MissionLaneBar`), os pinos
  A/B e o "Todos". Uma aba por escopo de `listPaneScopes`; visão geral é
  `ALL_SCOPES_KEY`; "ver ao lado" é `sideScopeKey` e desenha duas `PaneGrid`
  (a secundária com `primary={false}`, que não atende o `pendingOpen` do
  picker — senão dois menus abririam juntos).
- Missão começada por um pane do operador mora na aba DELE: a adoção em
  `reflectMissionLeader` carimba `missionHost` (persistido no layout) e
  `missionHomeScopeKeys` manda missão e workers para o escopo do anfitrião.
  Missão do assistente não tem anfitrião e mantém a aba própria. Classifique
  vários panes com `paneScopeResolver`, nunca com `paneScopeKey` solto (sem
  as casas, a missão hospedada iria para uma aba que não existe).
- Aba com missão viva não fecha pelo ×: encerrar é no Quadro. "Terminais"
  (panes sem espaço) renomeada vira um espaço (`nameLooseSpace`).
- F-162 (26/09): novas abas (+, Montar meus terminais e wizard) têm worktree
  durável fora da raiz, criada de HEAD sem copiar WIP. Abas/missões legadas
  não migram. `workspaceBinding` Main-owned entra no hash da review; a adoção
  conserva a pasta do pane escolhido. `mission-execution-scope.ts` resolve
  a pasta física; bancos/eventos/hub MCP continuam no scope de coordenação.
  Retomada não recria worktree perdida; fechar aba não remove WIP/branch.
- F-1006: `OwnedAgentSessionInfo.scope` é a EXECUÇÃO (worktree do writer/aba);
  quando difere, `coordinationScope` traz o checkout dos stores. Quadro de
  entregas, conclusão da missão e qualquer `getProjectDomainStores` de uma
  sessão usam a coordenação (`agent.coordinationScope ?? ctx.scope`, ou
  `PaneRuntimeAuthority.scope`) — nunca `executionScope`. A guarda
  "project store scope identity collision" fica como está: ela é o alarme.
- Primeira onda, retomada, sensores mecânicos, revisão, artefatos e push usam
  a execução da missão. Mtime do checkout novo não prova entrega: use o
  SHA-base da aba. PREVC mutável/sensores congelados ainda são recusados
  explicitamente na aba; jamais caia em main. Estado e limites
  em `docs/analysis/2026-09-23-abas-feature-worktree.md`. Não crie worktree
  dentro da raiz do projeto.
- F-980: `isolatedWriter` (e o auto-isolamento do 2º writer) na pasta isolada
  da aba nasce do HEAD da ABA (`baseRootRealPath` → `baseSha`), sem o WIP dela;
  o registro fica no escopo do checkout (raiz/integrationRef únicas) e a GC
  aceita branch contida no HEAD da aba. Aba sem prova de identidade recusa com
  a saída escrita. F-981: `cwd` na raiz de outra worktree ligada ao repo vira
  `executionScope` próprio (serializa só contra writers dela); o worker de
  missão nunca descarta `cwd` em silêncio; o claim do writer só cai quando o
  pane tem sessão e saiu de `spawning`/`unknown`.
- F-654: o Git para Windows recusa `git worktree add` com `<worktree>\.git`
  acima de 220 caracteres (`'$GIT_DIR' too big`; `core.longpaths` não ajuda),
  e o runtime do checkout em `%APPDATA%` já tem ~219. Por isso, no win32,
  worktrees e candidatos de merge moram em `<project-runtime>\wt` e `\mc` com
  nomes compactos. Todo caminho físico de worktree sai de
  `managed-worktree-layout.ts` (criação, validação, recuperação, fila de
  merge). Linux mantém o layout histórico byte a byte. No macOS, somente novas
  worktrees e candidatos usam raízes `.noindex` (exceção autorizada pelo operador
  em 03/10, N13); caminhos e WIP existentes são preservados e continuam aceitos.
  Não monte esse caminho à mão em outro lugar.

## Várias missões pelo "+ Pane" (F-198/F-373/F-374)

- Maestro vivo e ocioso é missão viva. `projectMissionEngineSnapshotView`
  conta a sessão `idle` do líder provado em `orchestratorLive` e marca
  `orchestratorIdle`; sem pane `working|waiting|blocked`, `projectState`
  projeta `running` com o motivo `awaiting-instruction` (rail e abas:
  "Aguardando"; Quadro: "Aguardando sua instrução", com a orientação liberada).
  "Dormindo" fica para missão sem processo. Não volte a exigir `busy|spawning`
  para liveness: o Maestro parado no prompt é o estado normal da missão da aba,
  logo depois de "Tornar orquestrador" e entre um pedido e outro.
- "Tornar orquestrador" só entra na missão da aba que tem
  `hasCurrentDispatchAuthority`, a mesma régua do Main. Entre várias vivas, a
  da aba é a de `workspaceBinding.tabKey` igual à chave da aba. Missão
  dormindo, parada pelo operador ou esperando resposta continua listada, mas o
  pane novo abre outra missão em vez de receber `mission_unavailable`.
- Aba cuja missão está Dormindo/Parou (`session-sleeping`/`runtime-closed`)
  volta a oferecer "Criar missão desta aba" e fecha pelo ×; `session-dead`
  (row `running` sem runtime) ainda segura a aba. "Criar missão desta aba" só
  coroa pane com sessão viva (`pickTabMissionLeader`).
- Com o líder da missão da aba VIVO em outro pane, "Tornar orquestrador"
  pergunta: "Nova missão deste painel" (`createPaneMission` com
  `ownGroup: true`: missão separada, sem `tabKey`) ou "Assumir a liderança" (a
  troca de coroa). Missão nova com nome já usado ganha sufixo " 2", " 3"…
  dentro do teto de 120 caracteres do Main.
- **Revisor nunca vira orquestrador (F-996).** `promoteOrchestratorFromRenderer`
  recusa (`pane_read_only`) pane somente leitura — ficha PTY, gate ou
  composição — antes de qualquer escrita; só o líder que já é desta missão
  (Maestro delegate-only nascido readOnly) é reconfirmado. No renderer,
  `pickTabMissionLeader` nunca escolhe worker de missão (`role: 'worker'`) no
  lugar do orquestrador: foco não é designação. Sem orquestrador nem pane do
  operador vivo, a resposta é `null` e o operador é avisado — a missão fica
  sem líder vivo em vez de ser re-hospedada num revisor.

## Portão de regressão: config do runner e falha de carga (F-199)

- Projeto sem config do Jest/Vitest na raiz do pacote costuma declará-la em
  cada script (`jest --config tests/jest.config.js`). `detectRegressionRunner`
  lê esse `--config`/`-c` dos scripts do próprio runner (arquivo real dentro
  da raiz) e o portão o repassa. Sem isso o `ts-jest` não carrega e todo teste
  TypeScript "quebra" — foi o que recusou todos os writers do saasbarbearia.
- Suíte que nem carrega ("Test suite failed to run" com erro de parse) não é
  regressão por si: só barra quando o arquivo acusado está no diff ou o diff
  tocou config de runner/transform. Acusado fora do diff vira "não
  verificado"; acusado que não dá para extrair continua barrando. Os caminhos
  das worktrees isoladas no macOS têm espaço (`Application Support`): a
  extração do caminho precisa aceitar espaço.
- F-246: falha pré-existente não é do diff. Com `base.sha` conhecida, os
  arquivos que falharam e existem na base rodam de novo num worktree
  temporário dela (`git worktree add --detach` em tmp privado, removido em
  `finally`; `node_modules` = link para o do `trustedDependencyRoot`, mesmo
  destino que `externalDependencyReads` valida). O que reproduz na base vai
  para `preexistingFailures` com aviso "não conta contra você" e sai do
  veredito; base inatingível/sem prazo não reclassifica, só avisa.
  Cache key não mudou — a comparação depende só de (diffHash, base).

- Seatbelt do portão: `/bin/ps` é setuid e o Seatbelt recusa exec setuid
  (`spawn EPERM`), então a sonda real de cwd (`listProcessCwds`, F-908) falha
  fechada e prova de "fora de uso" nunca sai lá dentro. Teste que exige essa
  PROVA chama `skipIfCwdProbeDeniedBySandbox(context)`
  (`src/test/cwd-probe-sandbox.ts`): pula com motivo `AMBIENTE-SANDBOX` só com
  ps em EPERM e exec comum funcionando, lidos crus do SO (nunca pela sonda sob
  teste). Fora do sandbox nada pula; sonda quebrada continua falhando.

## Orquestração automática e modelo por tarefa (F-200/F-214)

- Todo pedido digitado num pane do "+ Pane" passa pelo Jev de delegação
  (`/hook/delegate`). Com `divisible ≥ 0,6` e 2+ partes o agente recebe a
  dica; com `≥ 0,7` em Autopilot o Nexus adota o pane pela missão sob demanda
  da aba (`adoptThroughOperatorTabMission`, o mesmo provedor do 1º helper) e
  a dica vira diretiva de abrir os helpers. Hardened só dá a dica. O critério
  `divisible` conta "a mesma mudança em apps/superfícies separadas" (nativo e
  web/PWA): foi o que faltou no pedido real de 29/09 (0,52 → 0,84 na
  avaliação com o Jev). Mude a régua só com avaliação em pedidos reais.
- O hook não julga o que não foi o operador que escreveu: `<task-notification>`,
  entrega de handoff (mesmo dentro de `<pasted_content>`), "Stop hook
  feedback", corpo de skill, avisos `[Nexus]` e o pack de failover voltam `{}`.
- Variante por tier na `DEFAULT_ROUTING_TABLE`: Flash/mini/Luna/Haiku no
  rotineiro, Pro/Sol/Opus no hard. Revisão em hard/critical e todo o critical
  levam o topo (`FRONTIER_ORDER`) à frente de qualquer CLI depois do
  multi-score; hard sem revisão segue distribuindo entre todas as LLMs.
  DeepSWE, TB2.1 e SWE-bench Verified saturaram: modelo barato empata com o
  topo neles, e só o TB4 os separa.
- F-700: o GPT-6 Astra é caso raro (regra do operador, 30/09). Não está em
  nenhuma tabela nem na `FRONTIER_ORDER`; entra só pelo nome ("com o GPT-6
  Astra", `mentionedRoute`) ou por escolha do operador. Com o Maestro Claude,
  `reserveClaude` tira Opus/Fable dos workers, e com o Astra no topo ele virou
  1 de cada 4 workers num dia. Não o devolva à rota automática; a regra do
  "mais novo da linha" também não o traz (`gpt-6.1-astra` continua fora).
- F-701: o Maestro recebe a doutrina de delegar em três lugares. O kickoff,
  as `instructions` do MCP (`MAESTRO_STANDING_DOCTRINE` via
  `maestroStandingContext`: prompt de sistema, sobrevive à compactação) e o
  hook do prompt (`MAESTRO_TURN_REMINDER` a cada 30 min, inclusive na entrega
  de um worker; o Codex recebe a doutrina inteira). Execução direta e
  pergunta aos panes não recebem: a doutrina delas diz o contrário. F-708:
  pedido digitado pelo operador no Maestro passa pelo Jev de delegação e, com
  2+ partes, vira "abra N workers" no lugar do lembrete.
- F-714: vigia de esteira (`mission-momentum-watchdog.ts`, no laço do
  `delegation-supervisor`): missão `running` que delega, Maestro vivo e zero
  workers por 20 min → handoff de supervisor `[momentum:…]` (no máximo 1/h)
  mandando adiantar as próximas unidades em workers durante o gate longo.
  Comando pesado local (validador, `make verify`, suíte) continua um por vez —
  a regra é não deixar trabalho de LLM esperando CPU. Na noite de 30/09 a
  missão do HiperGO gastou 7h30 em validações em fila única, sem worker.
- F-744: delegar é UMA chamada — `nexus_pane_spawn({task, prompt})` sem
  `adapterId` já roteia com reserva dentro da missão (`missionAutoRoute`). A
  doutrina do kickoff e a descrição da `nexus_route_task` mandavam rotear
  antes, e o Maestro Codex gastava uma rodada inteira do modelo (~60 s) só
  para isso. `nexus_route_task` é para inspecionar uma rota (juiz,
  alternativas, custo). Medido e ainda aberto no Windows: o Codex roda cada
  hook pelo PowerShell (o nosso abre outro PowerShell com
  `Invoke-WebRequest`), ~1–2 s por chamada de ferramenta, e serializa as
  chamadas MCP (`supports_parallel_tool_calls` falso por padrão). Hook
  `async` reordena o status contra o `Stop` — o portão de regressão devolve
  o turno sem prompt novo —, então precisa de outro desenho.
- F-242: worker `working` sem atividade por 20 min com PTY parado = travado
  → handoff `stalled` [travado] acorda o Maestro (renotifica a cada 60 min);
  não bloqueia a missão. F-243: o Maestro Claude de missão recebe
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000` (workers/operador inalterados;
  adapters host-Claude já definem a janela).
- F-702: worker nunca pergunta ao humano (`request_user_input_async` do
  Codex, AskUserQuestion): ninguém responde e o pane trava. Brief que
  contraria a autoridade de execução (clone próprio, push, outra branch)
  perde para o Nexus e volta como bloqueio no handoff. `features.multi_agent`
  e `default_mode_request_user_input` do Codex não removem a ferramenta; a
  regra vive no contrato (`withHandoffContract`). No Autopilot todo papel —
  orquestrador, helper, worker e revisor — usa subagentes nativos (`Task` /
  `spawn_agent`) dentro da autoridade do pane (doutrina "agentes sem amarras",
  F-1157). Só o modo Hardened, escolha explícita do operador, corta o `Task` no
  spawn (`native-subagent-policy.ts`). Não acrescentar bloqueio estático de Task
  ao adapter nem reintroduzir o corte por papel sem pedido do dono.
- Modelo mais novo sempre (regra do operador, F-691/F-217/F-218): dentro de
  uma linha (`modelLineOf` em `src/shared/model-line.ts`: só os números
  mudam), a versão mais nova que a CLI oferece substitui a velha na rota, no
  padrão do pane, no `model` explícito do `nexus_pane_spawn`, no template de
  squad e no modelo citado no texto. Sem benchmark, herda a nota da versão
  anterior; versão nova de modelo de topo continua topo. Não sobem: roster
  selado, reserva de rota já emitida, resume e o "+ Pane" do renderer.

## Worktree rápida e tamanho do PTY (F-215/F-216)

- A worktree de writer isolado, a da aba nova e o candidato de merge clonam
  o `node_modules` com `clonefile(2)` no diretório inteiro, via
  `/usr/bin/osascript -l JavaScript` (script constante, caminhos só como
  argv). `cp -cR` copia entrada por entrada: 32 s contra ~4-6 s num
  node_modules de 331 mil entradas. Symlink, falha ou
  `NEXUS_COW_DIRECTORY_CLONE=0` voltam ao `cp -cR`. `node_modules` aninhado
  (profundidade 1-2, ao lado de `package.json`) só entra se o git o ignora:
  sem isso a worktree nasceria suja.
- O renderer reafirma o tamanho do PTY no foco e na volta de visibilidade
  (`resize` com `assert`); winsize igual não gera SIGWINCH. O Main grava
  `pty-grid-drift` quando o PTY estava em outro tamanho e
  `pty-resize-dropped` quando descarta resize de sessão de outro dono. Os
  panes Claude/GLM do operador usam o renderizador fullscreen
  (`"tui": "fullscreen"`), em que todo resize redesenha a tela inteira.
- F-248: a grade pode mudar enquanto `pty.spawn` espera o Main. O spawn
  captura `spawnGrid` ANTES do await, grava-a como `reportedGrid` no
  `setHostSession` e chama `propagateHostSize` logo depois — sem isso o PTY
  fica na winsize velha até um "Redesenhar". O assert do resize manda
  `reported` junto e o trace `pty-grid-drift` grava `reportedCols/Rows`:
  `reported ≠ pty` = renderer nunca mandou; `reported == cols` = Main perdeu.

## Conversas Grok/Kimi por checkout (F-566)

- Os overlays recebem `userDataPath` e `checkoutId` da autoridade do Main e
  ligam suas conversas a `<userData>/provider-state/<adapter>/<checkoutId>/`.
  Nunca volte a ligar `sessions`/históricos/índices ao perfil nativo: um CLI
  externo no mesmo cwd pode retomar a conversa viva do pane.
- Auth e extensões seguem a política existente do perfil. O sandbox governado
  precisa conceder tanto o perfil quanto o diretório durável exato do checkout.
- As entradas de conversa ficam excluídas do sync-back ao perfil real, inclusive
  quando o CLI substitui um link de arquivo por rename atômico. Limpar overlays
  não apaga sessões duráveis. Sessões antigas no perfil nativo ficam intactas;
  não são importadas automaticamente para o Nexus.

## Redline na barra depois de atualizar o Nexus (F-612)

- O `swiftc` do companheiro leva `-target arm64-apple-macosx14.0`, o mesmo piso de `LSMinimumSystemVersion`. Sem esse alvo o linker carimba `minos` com a versão do SDK (0.76.75 saiu `minos 27.2` num Mac 27.0) e o Launch Services recusa o app com «Você não pode usar esta versão do aplicativo» (F-628). O build confere o `minos` com `vtool` e falha se não for 14.0.
- Quem já instalou o companheiro em `/Applications` precisa de
  `syncInstalledRedline` no boot: se o binário empacotado diferir, substitui e
  relança. A oferta one-time não cobre update. `open` num LSUIElement já
  rodando não reconstrói o extra — "Abrir Redline" mata e abre de novo.
- A faixa só pinta contas com `usedRatio` (`statusBarEntryIds`, teto 6).
  Unknown (`·····`) fica no painel, senão o extra some no overflow do macOS.
- F-029 mudou a anatomia: o clique abre um `NSPopover` com lista vertical e
  rolagem (`QuotaPanelController`), não mais um `NSMenu` — `statusItem.menu`
  foi embora e as ações são botões de verdade fora da área rolável.
- A faixa virou UM resumo: `<glyph> <barra 5 blocos> <pct>` da pior janela
  entre as contas de `statusBarEntryIds` (`entriesForBar`). Um segmento por
  conta media ~930pt com 6 contas; o teto da spec é 100pt e não cabe
  cronômetro no título — o reset fica na linha da janela no painel.
- `urgencyColor` é NSColor dinâmica resolvida pela aparência da superfície
  que desenha, com hexes fixos nos DOIS temas (não mais "tons do sistema no
  escuro"): a barra pode ser clara sob papel de parede claro mesmo com o
  macOS em dark mode.
- O PAINEL é superfície Nexus escura SEMPRE (`.darkAqua` no root e no popover;
  `#111013` cabeçalho/rodapé, `#0d0b0f` lista, fios branco a 8%). Seguir a
  aparência do sistema foi o defeito que reabriu o F-029: no tema claro o painel
  virava folha branca, contra o dark-first do `DESIGN.md`. Não use cor dinâmica
  do sistema (`labelColor`, `windowBackgroundColor`) dentro do painel — o spec
  percorre todo label renderizado e reprova o que não limpar 4,5:1 contra a
  superfície, e mede a tinta de cada botão contra o próprio preenchimento.
  `urgencyColor` é da FAIXA (segue o tema do menu bar); o painel tem paleta
  estática própria. O medidor é view desenhada, não bloco `▮`.
- Logo de provider no companheiro NÃO é SVG. O AppKit lê mal os SVGs de
  `src/renderer/assets/provider-logos/`: reporta `size 1x1` e o
  `gemini-color.svg` desenha 14 de 1024 pixels — some na prática.
  `scripts/build-redline-logos.mjs` rasteriza por Chromium (Electron, já
  dependência) para PNG 48px em `native/menubar-redline/assets/provider-logos/`
  com manifesto e guarda de cobertura ≥5%; rode à mão quando um logo mudar.
  `scripts/build-redline-logos.test.ts` acusa deriva contra `ProviderLogo.tsx`.
  Marca `mono` exige `isTemplate` + tinta clara, senão preto sobre near-black
  desaparece; o `NOTICE.md` de procedência viaja com elas para o bundle.

- F-759: o painel do Mac tem "Ampliar"/"Reduzir". Ampliado, as contas vão em 2–4
  colunas de 360pt (`column-plan.swift`, mínimo de colunas que cabe na altura da
  tela; sem caber, volta à rolagem sem cortar conta), o popover vira
  `.applicationDefined` (a captura de tela não o fecha) e reabrir é sempre
  compacto. Fio de separação desenhado pelos limites da view: na captura de
  tela o fio por `draw(_:)` pintava o painel inteiro.
- F-758: no app, o card "Cotas" da barra lateral (`RailQuotaCard.tsx`) expande para
  todas as contas com um clique (preferência em `rail-quota-prefs.ts`); com ≤4 contas
  o cabeçalho abre o uso. Coluna da grade em `minmax(0, 1fr)`: nome longo corta.

## Redline no Linux: bandeja dentro do app (feature, sem F-id)

- No Linux não há companheiro à parte: o Redline é um `Tray` + `Menu` do
  Electron (StatusNotifierItem: KDE, GNOME com AppIndicator, XFCE,
  Waybar/Hyprland), em `src/main/redline/redline-linux.ts`. Sem toolchain
  nativa nova; viaja nos DEB/RPM/ZIP. "Instalar" no IPC = LIGAR a bandeja
  (`redline:install`), `redline:hide` = desligar. A escolha é um booleano em
  `<userData>/redline-linux.json` (padrão LIGADO quando o arquivo não existe);
  não entra no `settings.json` compartilhado. Sem diálogo nativo (só grava em
  userData) e sem oferta one-time no boot. F-739: sem escolha salva a bandeja
  LIGA (só a ausência do arquivo liga; arquivo presente segue com leitura
  estrita). O operador não achava o Redline: o botão ficava em Uso e cotas,
  atrás do login. "Ocultar da bandeja" grava `false` e vale para sempre.
- Limites honestos, ditos na UI: o ícone vive só enquanto o NexusIDE está
  aberto (Mac/Windows continuam depois de fechar o app); Wayland não deixa a
  bandeja posicionar um painel, então o painel escuro 400×600 vira uma lista
  de menu nativa; o Electron não diz se algum host está exibindo o ícone —
  `running` quer dizer "o Tray foi criado". Tray que lança vira `unavailable`
  com motivo (log único) e NÃO persiste o "ligado".
- Toda decisão e formatação mora em `redline-tray-model.ts` (PURO: snapshot →
  descrição do menu; mesmas regras de `redline-model.cc`: 60%/85%, pior janela
  da faixa, barra de 5 blocos, desconhecido = «—», nunca 0%). Dado velho (>10
  min) diz «leitura desatualizada», não «Nexus offline»: aqui o Nexus está
  rodando. A lista mostra as contas de `statusBarEntryIds` (teto 6, ordem do
  snapshot) com a recomendada marcada; o resto vai para o submenu «Outras
  contas» (teto 25).
- O arquivo NUNCA é confiado. A leitura (`redline-safe-read.ts`) abre UMA vez
  com `O_NONBLOCK` e confere no descritor (regular, ≤ 1 MiB): um FIFO ou
  `/dev/zero` plantado no lugar não pendura o Main. `redline-snapshot-parse.ts`
  é o único ponto de entrada dos bytes (`formatVersion` exatamente 1, campo
  desconhecido descartado, texto sem controle/bidi, e-mail inteiro que escape
  do contrato — inclusive em `adapterId` — é re-mascarado). O texto é CORTADO
  antes de qualquer regex e as regex têm quantificador limitado: a versão
  ingênua do e-mail era quadrática (80 mil caracteres ≈ 6 s, 1 MiB ≈ minutos de
  Main travado a cada boot). Read-only: o único efeito é o
  `redline-refresh.request` ("Atualizar agora", `O_NOFOLLOW`, 0600), que o sink
  já consome.
  "Abrir cotas no Nexus" usa `openQuotaInMainWindow` (o mesmo caminho do
  `nexus://quota`). O ícone é gerado em código (`redline-tray-icon.ts`, PNG
  próprio, placa clara + losango da marca + ponto de urgência; dado velho
  vaza o ponto) — não há asset de bandeja nem variante «template» no Linux.
- `&` em rótulo de menu do Electron é acelerador: todo texto passa por
  `escapeMenuLabel`. Republicar o menu o fecha em vários hosts: sem arquivo
  novo, ícone que vira ou dado que envelhece, ele só é refeito a cada 5 min
  (`REDLINE_LINUX_MENU_REFRESH_MS`; o tooltip anda livre). Não destrua o Tray
  de dentro do clique do próprio menu (o "Ocultar" roda no turno seguinte).
- Validado no Omarchy/Hyprland 0.56 em 02/10 PELO BARRAMENTO (a tela estava
  bloqueada): item registrado no `org.kde.StatusNotifierWatcher` do quickshell,
  tooltip, menu `com.canonical.dbusmenu` com as contas, atualização ao gravar
  um snapshot novo, "Atualizar agora" consumido e "Ocultar da bandeja"
  persistindo. Falta ver a olho o ícone na barra e o clique do mouse. Para
  repetir sem mouse: `busctl --user call <serviço> /org/chromium/DbusMenu
  com.canonical.dbusmenu GetLayout iias -- 0 -1 0` e `Event isvu -- <id>
  clicked s "" 0` (os ids mudam a cada republicação do menu).
- Ainda NÃO validado: GNOME (precisa da extensão AppIndicator), KDE Plasma e
  XFCE. Antes de prometer esses desktops a um cliente, rode neles e confira
  ícone, tooltip, clique e atualização.
- **Omarchy 4 não é Waybar e esconde o ícone (F-934).** A barra é o quickshell
  (`/usr/share/omarchy/shell`, config em `~/.config/omarchy/shell.json`) e todo
  StatusNotifierItem vai para uma gaveta atrás da seta `<`: o Redline estava
  ativo, com tooltip e menu certos, e ninguém o via ("não mostra nada"). A
  leitura sempre visível é um módulo `command` da barra (`type`, `exec`,
  `interval`, `onClick`; saída em texto ou no JSON do Waybar; só a classe
  `active` destaca). `redline-bar.ts` (puro) monta esse JSON a partir de
  `redline-tray-model.ts`: `▮▮▮▮▯ 87%`, `?` quando o dado passou de 10 min,
  `percentage` AUSENTE sem leitura (nunca 0%).
- **`nexus-ide --redline-status` roda no próprio binário e sai** (a flag
  `RunAsNode` do Electron está desligada, não dá para ser script solto).
  `redline-cli-boot` DEVE ser o primeiro import de `main.ts` (teste trava):
  mede ~340 ms e não abre janela nem toma o lock de instância única. Usa a
  mesma leitura segura e o mesmo parse do ícone (`readRegularFileCapped` +
  `parseRedlineSnapshot`); nunca confie no arquivo, FIFO ou arquivo enorme não
  pendura a barra, e erro vira JSON neutro com código 0. Nunca use
  `execFileSync` ali (o ratchet do F-764 recusa): o recarregar do shell é
  `spawn` solto (`requestShellReload`). O resto do Main continua sendo
  carregado em chunks antes do boot (o Rolldown os eleva); o custo medido já
  inclui isso.
- **`--redline-bar-install` é a ÚNICA parte do Redline que escreve na
  configuração do operador.** Só por comando explícito (nunca no boot): backup
  `shell.json.bak.nexus-redline.<epoch>` antes de cada mudança, idempotente,
  preserva os ajustes do operador no módulo (só corrige `exec`), segue symlink
  de dotfiles (edita o alvo), recusa JSON inválido/ilegível/grande sem tocar em
  nada, grava com chaves ordenadas como o `jq -S` do Omarchy e manda
  `omarchy-shell shell reloadConfig`. `--redline-bar-uninstall` desfaz;
  `--redline-bar-snippet` só imprime (inclui o módulo `custom` do Waybar para
  quem não usa o quickshell); `--app <caminho>` fixa o executável.
- Visto a olho: só a seta `<` na barra (captura `grim`). NÃO visto a olho: o
  módulo desenhado na barra (tela bloqueada em 05/10); só se provou que o
  quickshell chama o comando a cada 30 s. O log dele mostra `TypeError: Cannot
  assign to read-only property "moduleName"` em `Bar.qml[2004]` ao criar
  QUALQUER módulo `command` (injeção de propriedades do Omarchy 4.0.4 numa
  propriedade `readonly`); confirme com a tela desbloqueada antes de anunciar.

## Linux: identidade de desktop, login e cofre (F-728, F-729, F-731)

- `desktopName` do `package.json` (`nexus-ide.desktop`) é a identidade do app
  no Linux: app_id do Wayland, classe da janela no X11 e alvo de
  `app.setAsDefaultProtocolClient`. Sem ele o Electron 43 usa o slug do nome
  (`nexuside.desktop`), que nenhum pacote instala: o `nexus://` do login não é
  registrado e a janela fica sem ícone. Não renomeie o executável, o pacote ou
  a entrada sem mexer nos três juntos (`linux-desktop-entry.test.ts` trava).
- O handler de `nexus://` no Linux É a entrada `.desktop`. DEB/RPM a instalam
  (`mimeType` em `forge.config.ts`); o ZIP portátil escreve a própria em
  `$XDG_DATA_HOME/applications` (`src/main/linux-desktop-entry.ts`), ANTES de
  registrar o protocolo.
- Definir o padrão não basta: o portal do desktop (por onde o Chrome abre
  `nexus://`) e o GIO só oferecem apps REGISTRADOS, e o registro vem do índice
  `mimeinfo.cache`, não do `MimeType=` da entrada. Sem a linha o login termina
  em "Open With… No Apps available" (F-740). O ZIP portátil confere o índice
  a cada boot (`ensureMimeIndex`: `update-desktop-database`, senão mescla a
  própria linha); DEB/RPM dependem de `desktop-file-utils`, cujo gatilho faz
  isso na instalação. Testar deep link só com `xdg-open` engana: ele lê o
  padrão direto. Teste pelo portal:
  `gdbus call --session --dest org.freedesktop.portal.Desktop --object-path
  /org/freedesktop/portal/desktop --method
  org.freedesktop.portal.OpenURI.OpenURI "" "nexus://quota" "{}"`, e confira
  `gio mime x-scheme-handler/nexus` (precisa listar "Registered applications").
- O `Exec` da entrada portátil vai SEM aspas. O `xdg-open` genérico (Hyprland,
  sway, qualquer desktop fora de GNOME/KDE/XFCE) trata `"/caminho/nexus-ide"`
  com as aspas como nome do comando, não acha, e entrega o link ao `$BROWSER`
  — o login voltava para uma aba em branco. Caminho com espaço ("Área de
  Trabalho") passa por um symlink de nome simples em
  `$XDG_DATA_HOME/nexus-ide/nexus-ide`.
- Nunca trate um deep link DENTRO do evento `second-instance`. A segunda
  instância espera a confirmação desse evento por 20 s e, sem ela, o Chromium
  mata o app em execução e sobe no lugar. O diálogo nativo de `open`/`license`
  é síncrono; por isso o link é agendado com `setImmediate`.
- No Wayland, diálogo nativo preso a janela ainda não exibida derruba o app
  (`zxdg_exporter_v2: surface must be an xdg_toplevel`). Use
  `nativeDialogParent` (`native-confirm.ts`) em diálogo que possa abrir antes
  do `ready-to-show`.
- Fora de GNOME/KDE o Chromium escolhe o backend `basic_text` para o
  `safeStorage`, que o cofre recusa. `linux-secret-store.ts` pede
  `gnome-libsecret` antes do `ready`. O próprio Omarchy lança o Chromium com
  `--password-store=gnome-libsecret` pelo mesmo motivo.
- Atualização no Linux é canal `manual` (F-751): `UpdateManager` consulta o
  espelho público sem `gh` e `parseLinuxReleases` só aceita versão com os TRÊS
  pacotes (`.deb`, `.rpm`, `.zip`), o mesmo crivo do catálogo do site e do
  `install.sh`. O app só avisa e mostra o comando; não baixa nem troca nada.
  Não reaproveite `parseGhReleases` (procura o ZIP do Squirrel do Mac).
- O clique esquerdo no ícone do Redline abre Uso e cotas (F-750). Painel
  flutuante próprio no Linux exige uma terceira `BrowserWindow`, e o Main
  assume que só existem a principal e a do mascote (`isPetWindow`): alvo de
  spawn dos panes em `browser-window-created`, `window-all-closed` e vários
  `getAllWindows()[0]`. Não crie janela nova sem auditar esses pontos.
- O smoke empacotado não enxerga nada disto: abre o binário direto, com HOME
  isolado, sem menu, navegador ou keyring. Mudança em identidade, deep link ou
  cofre pede teste num desktop real (roteiro e resultado de 02/10 em
  `docs/RELEASE.md`, "Validação em desktop real").
- Para testar sem tocar no perfil do operador, isole `HOME`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME` e `XDG_STATE_HOME` (a sessão do Omarchy
  exporta os XDG com o caminho real) e rode com `BROWSER` vazio: assim uma
  falha do handler aparece como erro, em vez de abrir o navegador do operador.
  Não use `--user-data-dir` nesse teste: a segunda instância lançada pela
  entrada de menu não recebe a flag e deixa de ser "segunda instância".

## Linux se atualiza sozinho: pacote portátil, assinado (F-940)

- O ZIP do `install.sh` (modo `linux-self` em `updater.ts`) baixa, confere e troca a própria pasta. DEB/RPM (`/usr/…`,
  `/opt/…`) continuam `manual`: `detectLinuxInstall` decide pelo caminho real do executável e pela escrita na pasta.
- A confiança é a chave Ed25519 de `linux-update-signing.ts`, não o GitHub: o `.sig` de cada versão assina o
  `SHA256SUMS-linux-x64.txt` e o app só confia no ZIP listado nele. **Versão Linux publicada sem `.sig` não se atualiza
  sozinha.** Assine no host com `scripts/sign-linux-update.mjs` e suba o `.sig` nos DOIS repositórios (docs/RELEASE.md).
  A privada (`~/.config/nexus-release/`) nunca entra no repositório, no container nem em log.
- O app monta as URLs de download; não use URL vinda do JSON da API. Extração só por `linux-zip-extract.ts`; troca só pelo
  `APPLY_SCRIPT` constante. Não afrouxe nenhum dos dois sem teste novo de ataque.
- O site no Linux nasce em movimento calmo (`site/src/calm-motion.js`, F-941); `?movimento=total` desfaz.

## Overlay Kimi leva o catálogo de modelos (F-611)

- `$KIMI_CODE_HOME` do pane é o overlay efêmero, não `~/.kimi-code`. Sem
  `models`/`providers` no `config.toml` do overlay, `kimi --model kimi-code/k3`
  cai em `config.invalid` mesmo com o catálogo nativo intacto.
- `prepareKimiMcpSession` projeta `models`, `providers`, `services` e
  `default_model` do perfil nativo (segue symlink de conta gerenciada) para a
  cópia privada do overlay, junto dos hooks de status. Não deixe o merge de
  hooks falhar em silêncio e nascer overlay sem catálogo.
- A TUI do Kimi pode substituir o `config.toml` do overlay (rename atômico) e
  apagar o catálogo. O guarda no overlay reescreve modelos/providers nativos e
  preserva o `default_model` que a TUI escolheu. Nunca sync-back desse arquivo.

## Qwen Code: fork do Gemini CLI, auth por settings (F-238)

- O adapter `qwen` é `cli-pty` sobre o binário `qwen` (Qwen Code). Não existe
  `qwen auth`: a credencial vive em `~/.qwen/settings.json`
  (`env.BAILIAN_TOKEN_PLAN_API_KEY`, `modelProviders.*[].envKey`) ou nas envs
  `BAILIAN_TOKEN_PLAN_API_KEY`/`DASHSCOPE_API_KEY` — conta como `present` sem
  nunca copiar o segredo.
- O catálogo vivo vem de `modelProviders.*[].id` do settings (só ids `qwen*`;
  `deepseek-*` no mesmo settings é de outro provider). Exceção F-724: com a
  auth OpenAI-compatible no Alibaba Token Plan entram o `deepseek-v4-pro`
  e o `deepseek-v4.1-flash-1017` (e só eles). Um `OPENAI_API_KEY` solto só vale para qwen com
  `OPENAI_BASE_URL` em `*.aliyuncs.com` — mesmo gate de host do ANTHROPIC_*.
- **F-1567: a env `BAILIAN_TOKEN_PLAN_API_KEY` sozinha NÃO autentica.** A CLI
  (0.25.2) só a lê quando um `modelProviders.openai[]` aponta para ela via
  `envKey`; `security.auth.apiKey` embutido no settings VENCE a env (medido
  com servidor local). Por isso, quando o Nexus injeta a chave (cofre ou conta
  pinada), o spawn leva `qwenSettingsInjection` {baseUrl, models, tokenPlanKey,
  envKey}: a chave segue na env `NEXUS_QWEN_KEY_<32 hex aleatórios>`, nome novo a
  cada spawn (a CLI interpola `$VAR` em qualquer string de qualquer settings, então
  um nome fixo era alcançável por um settings reescrito). O overlay grava um
  settings.json MESCLADO em vez de ligar o arquivo: os campos do operador, SEM as
  credenciais Alibaba dele (`security.auth.apiKey`, `env.BAILIAN_*`/`DASHSCOPE_*`:
  a injetada é a única do pane e nada velho fica em disco, nem para um modelo
  fora de `models`) e com as entradas `modelProviders` geradas, que só
  referenciam a env. A interpolação descarta só a ENTRADA (variável de `env`,
  linha do catálogo, campo da auth), nunca o bloco; linha do operador com
  `envKey` legada/própria fica, exceto a legada de um modelo que o Nexus cobre
  (ela leria a variável que a cópia esvaziou e sombrearia a nossa): essa é religada
  à nossa variável, com os campos do operador. A cópia é 0600, efêmera,
  apagada no teardown e no boot (`purgeStaleCliMcpSessions` cobre `qwen`);
  sync-back continua off (escritas da TUI nela não voltam ao perfil real). Sem
  injeção, o link de sempre. O settings do operador é lido só onde alguém
  precisa dele (a mescla e o MCP ambiente de pane não-governado; worker
  governado sem injeção só liga o arquivo) e por `readQwenOperatorSettings`,
  que tolera o que a CLI aceita (BOM, comentários, vírgula final) e vira `{}`
  em qualquer falha (EACCES, JSON inválido…).
- **F-1567: o layer de SISTEMA é um arquivo à parte, nunca a cópia do operador.**
  Na CLI (0.25.2, `mergeSettings`) a ordem é systemDefaults < user < workspace <
  system; apontar `QWEN_CODE_SYSTEM_SETTINGS_PATH` para a cópia inteira
  invertia user<workspace e, como `system-defaults.json` é derivado do dirname
  do arquivo de sistema, derrubava a política do admin (medido com a CLI real).
  O overlay grava `settings.json` (usuário, saneado) e `system-settings.json`
  (`mergeQwenSystemSettingsForInjection`): o settings de sistema REAL do admin
  (`qwenSystemSettingsPaths`: env do pane, senão o padrão da plataforma; ausente
  é `{}`, ilegível/inválido LANÇA como a CLI nativa) por baixo, e por cima SÓ o
  que o Nexus impõe — o catálogo `modelProviders.openai` (as listas por protocolo
  são substituídas pelo layer mais alto, então ele leva as linhas do admin, ou as
  do operador já saneadas, mais as geradas), `security.auth` fixada em `openai`
  com `apiKey` vazia e `env.OPENAI_API_KEY` vazia (um workspace não abastece o
  caminho de modelo fora do catálogo, nem sabendo o nome da variável). Também
  exporta `QWEN_CODE_SYSTEM_DEFAULTS_PATH` com o caminho que a CLI usaria. Custo
  assumido: `OPENAI_API_KEY=` vazia no ambiente do pane e dos filhos quando o
  operador não a exportou (ferramenta que lê `.env` com dotenv, sem override, não
  a preenche). NÃO aplicados, medidos: `security.folderTrust.enabled` faz a CLI
  ignorar o `.qwen/settings.json` do projeto (pelo código, o `.env` também);
  `disableAllHooks` desliga os hooks do próprio operador. Hook de workspace, MCP
  do operador e qualquer filho veem a env (classe de execução de código, fora da
  garantia declarativa). Prova repetível com a CLI real e SAFE/EVIL em loopback:
  `docs/qa/evidence/2026-10-18-qwen-key-isolation/` (README).
- **A chave do cofre só vai a host conhecido ou ao que o operador escolheu.**
  `resolveQwenInjectionBaseUrl`: campo "Base URL da API" (Providers › Qwen ›
  Avançado; https sem usuário/senha, salvo normalizado por `new URL().href`,
  mudança sensível com confirmação nativa; URL recusada aparece como erro junto
  do campo e, se o Main a descartar, também como diálogo nativo) ›
  base URL do settings do operador SÓ se o host for conhecido (DashScope em
  qualquer região, planos Alibaba, `api.deepseek.com`; nunca "qualquer
  `*.aliyuncs.com`", onde OSS e Function Compute de cliente também vivem) ›
  URL do Token Plan (Singapura) para chave `sk-sp-` › padrão DashScope. Chave
  `sk-sp-` só aceita host de PLANO (`token-plan.<região>.maas`, `coding[-intl].
  dashscope`): a URL regional válida (Pequim, Coding Plan) fica; DashScope
  padrão (o 401 do incidente) e DeepSeek direta não. O mesmo vale para toda
  linha do operador alimentada pela NOSSA env (`envKey` igual) em qualquer
  `modelProviders.*`: host fora disso vira a base URL resolvida (linha OpenAI)
  ou a linha sai (outro protocolo). Qualquer outro destino (proxy da empresa)
  só pelo campo, nunca pelo settings (a URL do settings que não serviu deixa
  um `console.warn` com o host, sem a URL inteira). A sonda do Testar resolve o
  MESMO par chave+base URL (`setQwenProbeConfiguredBaseUrlLookup`); o 401 dela
  diz "chave inválida ou base URL incompatível", nunca limite/cota.
- O toast "Credencial recusada… base URL… sk-sp-" e a redação "recusa de
  credencial" do failover são só do Qwen (`fromAdapterId === 'qwen'`;
  `emitNoSwitch` agora leva o `fromAdapterId`). Claude/Codex/AGY com login
  expirado mantêm "Sessão expirada… Entre novamente". A frase "Invalid API-key"
  com hífen NÃO é sinal de limite: o erro real do Qwen já casa pela moldura
  "Error: 401", e a frase solta aparece em prosa, log e `cat` do código (F-249).

## DeepSeek: API direta ou Alibaba Token Plan (F-724)

- Providers › DeepSeek tem "Provedor do DeepSeek", persistido como `upstream`
  do adapter `deepseek`: `deepseek` (API direta, o padrão) ou
  `deepseek-token-plan` (Claude Code em
  `token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`). O setConfig
  recusa qualquer outro valor para o DeepSeek. A rota do plano tem
  `scopedTo: 'deepseek'` e nenhuma outra CLI a escolhe. Lógica pura em
  `src/main/adapters/deepseek-provider.ts`.
- As fontes de chave são disjuntas (`resolveDeepseekProviderKey`). A API
  direta usa o cofre `deepseek`, o `deepseek=` do launcher (só sem
  `deepseek-base-url` de outro host), `DEEPSEEK_API_KEY` e o token com BASE_URL
  na DeepSeek. Chave `sk-sp-` nunca vai para api.deepseek.com. O plano usa a
  chave do Qwen Code: cofre `qwen`, `qwen`/`dashscope`/`bailian` do launcher,
  `BAILIAN_TOKEN_PLAN_API_KEY`/`DASHSCOPE_API_KEY` e o token com BASE_URL no
  Token Plan. Nunca usa a chave da DeepSeek nem copia o `~/.qwen/settings.json`.
  `resolveRuntimeApiKey('deepseek')` (o intent router, que fala com
  api.deepseek.com) devolve só a chave da API direta.
- **Flash do plano (20/10/2026).** Em 02/10 a sonda deu `deepseek-v4-flash` 403 e
  o plano só servia o `deepseek-v4-pro`. A lista do console do plano em 20/10
  traz `deepseek-v4.1-flash-1017` (New), `deepseek-v4.1-flash`,
  `deepseek-v4-pro-0813`, `deepseek-v4-pro` e `deepseek-v4-flash-0731`: o flash do
  plano é o `deepseek-v4.1-flash-1017` (`DEEPSEEK_TOKEN_PLAN_FLASH_MODEL`; ainda
  NÃO provado com chamada ao endpoint Anthropic do plano, só pela lista do
  console). Slots `ANTHROPIC_DEFAULT_*`: haiku no flash 1017, sonnet/opus no
  `deepseek-v4-pro`. `modelAliases` troca os genéricos
  `deepseek-flash`/`deepseek-v4-flash` por `deepseek-v4.1-flash-1017` na rota
  (task-router, `servido pelo provedor escolhido`), no default salvo e no
  `--model` do spawn (pty-manager); nome inteiro pedido pela pessoa
  (`deepseek-v4.1-flash`, `-v4-flash-0731`) segue como está. O catálogo do plano
  (`deepseekModelsForProvider`) oferece v4-pro e v4.1-flash-1017. O Qwen Code no
  mesmo plano usa as mesmas trocas (`QWEN_TOKEN_PLAN_*`, apelidos dos mesmos
  valores).
- **Na API direta `deepseek-v4.1-flash-1017` NÃO é id de API.** A doc oficial
  (api-docs.deepseek.com/quick_start/pricing, 20/10/2026) lista só `deepseek-flash`
  (hoje servido pelo DeepSeek-V4.1-Flash-1017) e `deepseek-v4-pro` (V4-Pro-0813);
  `deepseek-v4-flash` e `deepseek-v4-flash-vision-exp` são aliases aposentados
  que caem no mesmo flash; id desconhecido volta 400. Ou seja, o Claude Code com
  a chave da DeepSeek já roda o 1017 pelo `deepseek-flash`, sem mudança. Quem pedir
  o nome de versão na API direta recebe `deepseek-flash`
  (`DEEPSEEK_DIRECT_MODEL_ALIASES`, no spawn e no catálogo). Não invente id.
  `migrateModelId`/`modelLineOf` não reescrevem o id (versão `[4,1,1017]`).
- No plano as contas DeepSeek (chaves da API direta) não entram: o pane sem
  conta usa a chave do plano e o pane com conta fixada é recusado.
- O Qwen 3.8 fica só no Qwen Code. Nenhuma linha de rota põe modelo `qwen*` no
  adapter `deepseek`.
- MCP do Nexus chega por `--mcp-config <arquivo por sessão>` +
  `--allowed-mcp-server-names`; worker de missão fica restrito ao `nexus`+hub
  (o MCP ambiente do operador, ex.: blender, não entra). `QWEN_HOME` aponta
  o overlay da sessão: `settings.json` ligado (nunca copiado) quando o Nexus
  não injeta chave — com injeção (F-1567) é a cópia mesclada acima, mais o
  `system-settings.json` —, conversas em `<userData>/provider-state/qwen/<checkoutId>`.

## HOME efêmero da família Claude: o pane escreve como o operador (F-579/F-580)

- O overlay `~/.nexus/ephemeral/<tok>` isola CONVERSA e auth Claude (F-567),
  não é fronteira de segurança: pane Claude gravável nunca é confinado pelo
  kernel (Seatbelt só em lane readOnly e Codex). Por isso `prepareEphemeralHome`
  projeta a identidade do operador em dois tiers, ambos fail-closed por default:
  `carryDeveloperIdentity` (`.gitconfig`, `.git-credentials`, `.netrc`,
  `_netrc`, `.ssh`, `.gnupg`, `.config/git`, `.config/gh`) para toda lane
  gravável, e `carryNativeHome` (POSIX; todo o topo do HOME real menos
  `.claude`, `.claude.json*`, `.nexus`, `Library`, `.Trash`) só para a lane
  sem gate hooks (`!gateHome`). Desde o F-1157 `readOnly` é rótulo fora do
  Hardened: a lane recebe a identidade como as demais; só a lane somente-leitura
  do modo Hardened (que o kernel pode confinar) não recebe nada.
- `Library` fica fora do tier 2 de propósito: o keychain entra arquivo a
  arquivo pela política do F-575 (só `carryNativeClaudeAuth && gateHooks
  false`); third-party (GLM/LongCat) nunca vê keychain nem `.claude.json`.
- Links são symlinks (win32: junction/hardlink) e o teardown (`fs.rmSync`) não
  os segue — teste em `hooks-gen.developer-identity.test.ts` confere o HOME
  real depois do `cleanupSessionArtifacts`. Não substitua por cópia.
- `ProcessGitRunner` (Main) HONRA config global e de sistema do git: é ela que
  carrega o credential helper (`gh auth git-credential`, osxkeychain, GCM) e
  `user.name/email`. Não volte a setar `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`
  — o modelo de ameaça desconfia do conteúdo do REPO (`assertSafeLocalGitConfig`
  + `-c` pinados), não do `~/.gitconfig` do usuário.
- `nexus_git_sync` (fast-forward verificado) é alcançável pela mão do operador
  em vibe; só `ui_action` mantém autoridade de origem renderer (F-581).

## Colar/arrastar mídia no pane (F-582)

- O pane aceita QUALQUER tipo de arquivo (vídeo incluído) — o whitelist de
  `classifyMissionAttachment` vale só para wizard/App; no terminal,
  `filesFromClipboardData(data, { anyKind: true })` classifica o resto como
  `file` e nomes genéricos viram `print`/`audio`/`documento`/`anexo-<stamp>`.
- O paste espelha o drop, nesta ordem: `files` → `text/uri-list`/`DownloadURL`
  → imagem embutida no `text/html` → pasteboard do sistema via Main
  (`clipboardFileUris`: macOS `public.file-url`, win32 `FileNameW` UTF-16LE,
  linux `text/uri-list`). `text/plain` NUNCA é interceptado — URL ou caminho
  colado como texto segue digitado no terminal (a assimetria drop/paste é
  deliberada; `pasteUrisFromClipboard` não tem o fallback `text/plain` do
  `resolveDropUris`).
- File com caminho real é path-first: dentro do projeto injeta o relativo;
  fora, faz stream pelo Main (`importDroppedUri` →
  `importWorkspaceMissionAttachmentFromFile`, blocos de 1 MiB) até 256 MiB.
  Blob sem caminho (base64) e downloads http(s) ficam em 14 MiB. Sem nada
  aproveitável, o toast "Nada foi colado no terminal" explica — WhatsApp sem
  arquivo materializado pede para salvar e copiar/arrastar do Finder.

- F-760: anexo que o MAIN grava (drop sem `File`, `File` fora do projeto, blob base64)
  vive na RAIZ do projeto, que em aba com worktree NÃO é o cwd do pane. O Main
  devolve `absolutePath` (realpath verificado) e o pane digita ESSE
  (`injectMainStagedPath`); sem ele resolve contra a raiz do projeto ativo e só
  então contra o cwd. Arquivo que já está na pasta do pane segue relativo a ela.
  Nunca junte um caminho relativo-à-raiz ao cwd do pane. `MissionAttachment` não
  ganhou campo (viaja para missões): use `stageMissionAttachmentWithLocation`.

## Muse pane imprime `--help` e sai code 2 (F-596)

- Muse Code (`muse`) **não** é Claude: não tem `--mcp-config` / `--settings` /
  `--strict-mcp-config`. Marcá-lo `mcpAutoload: true` / `nexusMcp: autoload`
  faz o spawn injetar essas flags; o binário 1.3 recusa, dumpa o help
  (incluindo `--subagent-worktree-isolation`) e sai 2.
- Adapter `muse`: CLI própria (`bin: muse`, `mcpAutoload: false`,
  `nexusMcp: muse`). `spawn.extraArgs` inclui `--trust-workspace`. F-696: o
  Muse Code 1.4+ lê `mcpServers` do `settings.json` (`$XDG_CONFIG_HOME/muse`,
  padrão `~/.config/muse`); o Nexus
  registra UMA vez `mcpServers.nexus` → a mesma ponte stdio do MiniMax, com
  URL/sessão no `env` da entrada (F-1338: o 1.4.4 NÃO repassa o ambiente do
  processo ao servidor — sem o `env` a ponte responde zero ferramentas; arquivo em 0600).
  `bearer_token_env_var` e `${VAR}` em `headers` não funcionam no 1.4.1
  (testado com `muse exec`). Muse < 1.4 não tem o arquivo
  tocado; o handoff cai no fallback PTY/nx-mail.
- Opcional `muse-claude`: Claude Code apontado a `https://api.meta.ai`
  (Muse Spark). Key `ANTHROPIC_AUTH_TOKEN` (Model API da Meta). Não mistura
  com a sessão Anthropic nativa (família terceiro + HOME isolado).
- Lei do binário: `--mcp-config`/`--settings` só no argv de `claude` e
  `openclaude`. Copiar `mcpAutoload: true` no adapter `muse` não injeta
  flags Claude.

## Codex pane: `url is not supported for stdio` em mcp_servers (F-594)

- Pane direto do operador (`preserveUserMcp`) copia o `config.toml` real,
  inclusive `[mcp_servers.supabase] command = …` (stdio). O hub do workspace
  pode declarar o mesmo id como `streamable-http` (`url`).
- `codexHubMcpArgs` injeta `-c mcp_servers.<id>.url=…` por cima. O Codex
  recusa a mistura no load (`Error loading config.toml: url is not supported
  for stdio in mcp_servers.supabase`) e o pane sai com code 1.
- Fix: no spawn da mão do operador, pular chaves do hub que já existem no
  config preservado. Workers (overlay sem ambient MCP) continuam recebendo
  o hub inteiro. Export do hub (`mergeCodexToml`) também não grava url+command
  no mesmo bloco.

## Paste/drop no pane já morto mente sobre "cópia falhou" (F-593)

- `injectDroppedFile`/`injectDroppedUri` (`terminal-host.ts`) copiam o
  arquivo/URI para `.nexus/attachments/mission-context/` (`importDroppedUri`)
  e só DEPOIS chamam `injectStagedPath`, que escreve no PTY via
  `host.sessionId`. Quando o PTY já saiu (Codex/CLI morto), `setHostSession`
  zera `host.sessionId` e `injectStagedPath` faz early-return em silêncio.
- Bug: o código tratava esse caso como se a cópia tivesse falhado —
  `droppedFileRejectionMessage` ("não pôde ser copiado para a missão") saía
  no toast mesmo com o arquivo já staged com sucesso no disco. O operador via
  um erro de cópia mentiroso quando o problema real era pane sem processo.
- Fix: checar `host.sessionId` no momento de injetar, não só no de copiar.
  Se `result.ok` mas sessão morta → toast "Pane sem sessão ativa" dizendo que
  o arquivo FOI copiado e pedindo para reabrir o agente — nunca reusar a
  mensagem de recusa de intake para esse caso.

## Nexus Shot Bridge: arquivos do app de captura (F-1054/F-1135, `target: null` 15/10)

- O Nexus Shot (app de captura separado, repositório próprio) entrega arquivos ao
  IDE por um endpoint HTTP loopback do Main (`src/main/shot-bridge/shot-bridge-server.ts`,
  contrato em `src/shared/shot-bridge.ts`). Bind só em `127.0.0.1`, porta
  efêmera, token aleatório por sessão no header `x-nexus-shot-token`; o Shot
  descobre `{ port, token }` em `<userData>/shot-bridge/endpoint.json` (0600).
  Rotas: `POST /shot/ingest` e `GET /shot/targets`.
- A fronteira é o caminho: absoluto, com realpath sob as raízes do Shot (`~/Pictures/Nexus Shot`
  e `~/Movies/Nexus Shot`; no Windows `Pictures` e `Videos\Nexus Shot`; no Linux
  `~/Videos/Nexus Shot`; mais pastas conhecidas redirecionadas, como OneDrive e
  XDG; UNC é recusado), arquivo regular de até 512 MB, no máximo 320 arquivos e corpo de
  até 64 KB. O arquivo não é copiado: o renderer recebe só os metadados em
  `shot:files-received`.
- **Destino.** Opcional: `{ "targetPaneId": "…" }` ou `{ "target": { "paneId": "…" } }`.
  Alvo explícito indisponível é recusado (`target-unavailable`) e nunca cai no pane
  padrão; sem alvo vale o foco padrão. O Main valida o destino e monta o
  `ShotTargetBinding` (`paneId`, `sessionId`, `workspacePath`) antes de enfileirar o
  evento (F-1135); esse binding é interno e nunca vem do pedido.
- **`"target": null` é «nenhum pane escolhido».** O Shot o envia sempre que o seletor
  fica sem pane. O schema tinha `target` só `.optional()`, então o `null` dava 400
  `invalid-shape` e o Shot mostrava «O NexusIDE recusou os arquivos (fora das
  pastas do Nexus Shot)» para uma captura válida e dentro das pastas. Agora
  `target` é `.nullish()` e `null` equivale a ausente (entrega padrão, sem pane nem
  binding inventados); `targetPaneId` segue estrito (ausente ou id válido, `null` ali
  continua recusado) e `target` segue `.strict()` com `paneId` opaco.
- Para diagnosticar uma recusa, rode `shotDestinationSchema` e
  `validateShotIngestFiles` por tsx. Não faça POST na ponte viva: ela entrega os
  arquivos ao pane do operador. Slugs estáveis do ack: `unauthorized`,
  `invalid-json`, `invalid-shape`, `target-unavailable`, `too-many-files`,
  `path-not-absolute`, `path-outside-allowed`, `path-not-found`, `not-a-file`,
  `file-too-large`, `body-too-large`, `not-found`.

## Política de Git do fan-out isolado (F-563)

- No MCP, writers com `executionScope` distinto usam apenas Git
  add/commit/status/diff/log na worktree e branch do registro do Main; HEAD
  destacado, branch trocada e repo aninhado são recusados.
- `nexus_terminal_run` desses writers não executa shell: traduz somente argv
  Git literal para os mesmos handlers protegidos. Chains, subshells, scripts e
  `nexus_bg_run` são recusados. Não substitua isso por regex ou wrapper de PATH.
- Caminho explícito (`parseIsolatedWriterGitCommand`, `isolated-writer-policy.ts`):
  `git add [--] <caminhos>` recusa argumento que comece com `-` ou `:` (então
  nada de `-A`, `-u`, `-p` nem pathspec mágico), e cada caminho tem de resolver
  dentro do escopo; `git commit` aceita SÓ `-m`/`--message <mensagem>`, sem
  pathspec, `-a` nem `--amend`; `status` aceita `--short`/`--branch`, `diff` só
  `--cached`/`--staged` e `log` só `--oneline` e `-n <1..100>`. O que foi staged
  é exatamente o que entra no commit: o writer faz `add` dos arquivos que
  mudou, nunca `.` (o padrão sem caminho do guard é `.`, e a regra de nunca usá-lo
  vive na skill `oc-builder`). `nexus_git_add` e `nexus_git_commit` ficam
  recusados para pane `readOnly` na worktree isolada. A branch tem de estar em
  `refs/heads/nexus/…`, nunca main/master.
- Essa proteção cobre os processos lançados pelo MCP. A execução interna dos
  CLIs depende de seus próprios hooks/perfis; Autopilot não implica sandbox
  de kernel. Não declare que um guard MCP confina todas as ferramentas nativas.
- Worker→worker write/close exige a mesma `executionScope.rootRealPath`.
  Read/wait continuam disponíveis dentro da missão. O handoff do writer deve
  listar arquivos tocados e diff; branches isoladas não têm merge automático.

## Revisão informativa e portão formal (F-817/F-1477)

- **Portão formal.** Push, merge e conclusão só aceitam `nexus_review_verdict`
  com `approve` de juiz de ponta (Fable/Opus/Sonnet/Sol 6.1/Astra), no HEAD
  exato e com a árvore limpa; é o `satisfiesGate` da resposta. `reject`
  também fica registrado e bloqueia até o HEAD andar. `worktree`, `branch` ou
  `headSha` amarram o commit revisado quando o cwd do pane é outro checkout
  (F-1423); a ferramenta exige pane de missão (orquestrador ou worker). Numa
  missão de segurança crítica (a classificação do roteador sobre o texto dela,
  `securityCriticalGateJudge`) só Claude/Codex satisfazem o portão (F-817).
- **Revisão informativa.** Spawn somente leitura e sem worktree de escrita
  (`spawnRouteAuthority`: `isolatedWriter` vence `readOnly`, F-1318) usa a lane
  de julgamento inteira, Argon/Grok incluídos, em tarefa de segurança crítica,
  o que espalha o uso entre as CLIs. Quando a rota o põe fora de Claude/Codex
  (`informativeReviewSeat`: tier `critical`, specialty `security`, adapter
  fora dos dois), o spawn nasce marcado `informativeReview` e o
  `nexus_review_verdict` dele fica registrado com `frontier: false` e
  `satisfiesGate: false`, com a dica «veredito registrado como informativo».
  O approve dele nunca vira portão, seja qual for a missão; o Maestro abre o
  juiz por `nexus_route_task` "revisão" ou julga.
- **A marca é do Main.** Ela nasce em `tools-panes.ts` a partir da rota provada
  no spawn e viaja no metadado do pane e no token do gate
  (`AgentGateContext.informativeReview`, `mintToken`). Nunca vem de argumento
  MCP nem do texto do prompt. Revisor que não nasceu informativo segue as
  regras de juiz de sempre.

## Checkpoint oculto do writer (ORC-03)

- Todo handoff de worker escritor de missão (MCP e PTY/turn-end) fotografa a
  raiz de execução dele (worktree isolada ou da aba, nunca a de coordenação) em
  `refs/nexus-checkpoint/<32 hex do escopo missão+raiz>/ordinal/<n>` e grava a
  ref no artifact `nexus.checkpoint` do próprio handoff (`src/main/git/hidden-checkpoint.ts`).
- A captura não move HEAD, não cria branch e não escreve o índice real (índice
  privado em tmp + write-tree + commit-tree com identidade fixa do Nexus).
  Mesma árvore sobre o mesmo HEAD reaproveita o ordinal (replay do handoff dá
  o mesmo artifact). Sparse checkout é recusado com erro visível no artifact.
- Ref de 0 byte (rename sem fsync) é ignorada e apagada na captura e na listagem.
- Restaurar é só explícito: `nexus_checkpoint_list` (leitura; com `ref`, prévia
  do que sobrescreve/cria) e `nexus_checkpoint_restore` (execution-effect). A
  restauração guarda o estado atual como checkpoint novo, escreve só arquivos do
  checkpoint, nunca apaga nada e recusa ref fora das raízes da missão.
- Restauração: raiz SELADA (caminho real = autorizado, nunca a coordenação por
  caminho, inode ou git-dir), todos os destinos pelas guardas de `.context`
  (autoridade de workflow), `.agents`/`.codex` e plano ANTES de escrever, e
  autoridade + raiz + writer ocioso conferidos antes do backup, depois dele e
  antes de cada `checkout-index`. Writer ocupado na árvore recusa com mensagem.
- A captura no handoff tem prazo global de 10 s (`HANDOFF_CHECKPOINT_DEADLINE_MS`):
  estourou, o artifact diz `{ ok: false, reason: 'timeout' }`, nada é publicado
  depois e o trace `handoff-checkpoint` registra `elapsedMs`.

## Atualização de CLI pelo npm 12 não pode deixar stub (F-1571)

- O npm 12 bloqueia scripts de instalação por padrão e sai com código 0. O
  Claude Code npm depende do `postinstall` (copia o binário nativo sobre
  `bin/claude.exe`): sem ele fica um stub de 500 bytes que sai com 1, e todo
  pane morre no boot. O próprio `claude update` ainda diz "Successfully
  updated" (provado em prefixo temporário em 19/10).
- Toda receita npm leva `--allow-scripts=<pacote da CLI>` (só ele, pacote por
  último); o ramo npm da atualização preserva as flags da receita. O `claude
  update` de instalação npm recebe `npm_config_allow_scripts` no ambiente: o
  updater da Anthropic continua dono do canal (F-360).
- A atualização nunca deixa a CLI pior: lançador que parou de responder é
  reinstalado na hora pela receita npm do mesmo prefixo
  (`selectCliRepairRecipe`); sem reparo vira `broke-cli` no painel. CLI que já
  passou numa checagem e hoje não responde ganha UMA reinstalação npm por
  sessão do app; a que nunca respondeu não é reinstalada às cegas.
- Maestro de missão que sai sozinho grava a última tela pelo tap de saída
  (`recordMissionOrchestratorExitScreen`). Quadro sem tela não diz mais
  "build anterior".

## Grok: não spawna `grok models` (ciclo 5)

- O binário `grok models` faz silent refresh e rotaciona o refresh token a
  cada invocação. O poll antigo (5 min) + TTL 5 min caía a cada ~10 min.
- Descoberta de modelos do Grok lê `~/.grok/models_cache.json` (e o catálogo
  bundled). Nunca `execFile('grok', ['models'])`. Cota usa
  `GET cli-chat-proxy.grok.com/v1/billing` com o JWT já em `auth.json`.
- `MODEL_DISCOVERY_POLL_MS` / `MODEL_DISCOVERY_TTL_MS` ≥ 1 h para o restante
  das CLIs com comando list.

## Grok: cota renova pela CLI, sem pedir login por access token vencido (F-626)

- O fallback de cota usa ACP `grok agent --no-leader stdio`, apenas
  `initialize` e `authenticate` com `cached_token`; nunca `session/new`, prompt
  ou `grok models`. A CLI continua dona da renovação e do arquivo de auth.
- Panes e sondas do Main compartilham o gate da família de refresh, inclusive
  cópias native/managed. Revalidar subject, issuer, client e team e recusar
  arquivo alterado enquanto espera. CLI externo não participa desse gate.
- Uma leitura provider-api real pode refutar cooldown de autenticação; presença
  de arquivo/e-mail não pode. Preservar quota global e por tier, e publicar ao
  Redline as contas relidas após a cura. Falha em persistir a cura não apaga a cota.

## Codex: um refresh OAuth por conta gerenciada (ciclo 5 addendum)

- O binário Codex (não o Nexus) rotaciona o refresh token do ChatGPT ao
  boot quando o access JWT está velho. `auth.json` é o mesmo inode em todos
  os panes da conta (`managed-accounts/codex/<acct>/home/auth.json` ou
  `~/.codex/auth.json`, linkado no overlay).
- `mcp-oauth-locks/file-store.lock` no overlay é lock do *MCP OAuth store*
  da CLI, um por CODEX_HOME privado. Não serializa o ChatGPT `auth.json`.
- Gate em `managed-auth-spawn-gate.ts` (chamado de `pty-ipc` antes do spawn):
  token fresco → todos passam; token velho → um leader spawna, os outros
  esperam o arquivo reescrito (lock `auth.json.nexus-spawn.lock`, timeout
  12s) e reusam o token. Sem git-lock no overlay.
- Mitigante de operador: contas Codex distintas em spawn paralelo evitam
  a família; o picker já tem uma linha por conta.
- A conta que É o login nativo tem duas cópias da mesma linhagem
  (`~/.codex/auth.json` e o home gerenciado). O gate de família
  (`withGrokAuthFamilyGate`) também casa blobs do Codex: subject = `user_id`
  do id_token e o escopo inclui o `account_id` (mesmo usuário em outro
  workspace nunca é copiado). Ele lembra cada cópia que entrou na família:
  cópia velha que ia liderar a renovação adota antes a irmã que já girou o
  refresh token (pane que renovou no meio da sessão), em vez de apresentar um
  token consumido. A CLI externa (terminal do operador, app Codex) segue fora
  do gate. O login pelo Nexus tira a conta anterior da vaga nativa.

## AGY/Gemini: o grant renovado volta para a linhagem da conta

- `refreshGeminiAccessToken` (`quota/agy-usage.ts`) devolve um
  `GeminiRefreshedGrant`: access token, `refreshToken` rotacionado (só quando o
  Google o trocou), `expiryDate` (de `expires_in`) e `idToken`. Antes ele
  devolvia só o access token e descartava o resto: a conta AGY na Reserva
  ficava no cofre com o access vencido e um refresh token que o Google podia
  ter trocado.
- A sonda de cota (`fetchAgyUsageWindows`, que só renova com `allowRefresh`)
  entrega o grant a `persistRefreshed`, ligado no `quota-service` a
  `persistGeminiRotatedCreds` (`quota/provider-usage-auth.ts`), o mesmo desenho
  do Kimi (`persistKimiRotatedCreds`). É best-effort: falha de gravação nunca
  derruba a leitura de cota daquele ciclo.
- **Conta fixada:** o blob do cofre `acctcred:<id>` recebe access, expiry,
  `id_token` (se já existia) e o refresh token em vigor (o rotacionado ou o
  usado), preservando o resto (e-mail, o envelope Go `{token:{expiry RFC 3339}}`
  do AGY). Snapshot de diretório, blob sem token e conta de outro provider são
  ignorados.
- **Linha nativa:** `~/.gemini/oauth_creds.json` é da CLI. Só uma ROTAÇÃO volta
  para lá, e só se o arquivo ainda guarda o refresh token usado (outro login ou
  o refresh da própria CLI no meio do caminho vencem). A escrita é atômica, modo
  0600 (`writeJsonAtomic`). A vaga `gemini:antigravity` do keyring do Windows é
  lida de forma assíncrona e nunca escrita.
- O `id_token` novo substitui o velho: `adapters/auth-freshness` compara o
  `iat`, e um id_token velho ao lado do access novo faria o blob parecer mais
  antigo que a cópia do managed home, e a cópia velha voltaria ao cofre.
- `resolveGeminiOauthCreds(accountId)` é assíncrona e usa
  `accountCredentialCandidates`: o managed home que a CLI do pane renovou vence o
  cofre da mesma identidade, senão o refresh daqui usaria um refresh token já
  trocado. No Claude a Reserva tem o desenho próprio do F-639
  (`ensureFreshClaudeSubscription`), descrito na seção "Multi-conta".

## Devin spawn: colagem depois do boot (ciclo 5)

- `spawn.initialPrompt` é `paste` (como Kimi). Posicional `-- <PROMPT>` nascia
  antes do trust e o pane morria com "agent pane did not start after prompt
  delivery".
- Trust interativo ("Do you trust the authors of this directory?") é
  `cliPromptAutoResponder` (`devin-workspace-trust`). `--respect-workspace-trust
  false` só existe no headless; extraArgs interativo continua vazio.
- Brief só depois do composer "Ask Devin to build". Auth: TOML em
  `~/.local/share/devin/credentials.toml`.
- F-698: o Devin TEM o MCP do Nexus (`nexusMcp: devin`).
  `ensureDevinNexusMcpRegistration` registra `nexus` → a ponte stdio do F-678
  pela própria CLI, sempre `devin mcp add --scope user` (o escopo padrão é
  `local`, dentro do repositório — nunca grave lá), idempotente via
  `devin mcp list`. URL/bearer só por ENV, que o Devin repassa ao stdio
  (provado com `devin -p` no 3000.11.1). Registro falho em worker de missão
  derruba o spawn. Orquestrador declarado (coroável à mão), não verificado.
- F-743: o Devin recebe o brief CRU (`NO_BRACKETED_PASTE_ADAPTERS`) e, sob
  carga, lê colagem e Enter no mesmo lote — o Enter vira quebra de linha e o
  brief fica `[Pasted text #1 +117 lines]` no composer. Sem hooks, a
  repintura conta como aceite e ninguém reenvia. `paste-ingest.ts` espera o
  marcador antes do Enter a partir de 20 linhas (3000.11.1: 20+ linhas →
  marcador em ~150 ms; 10 linhas ou uma linha de 3.000 caracteres, nunca).

## Panes: quem abre, fecha (F-572)

- Um pane de agente custa ~0,5–1 GB (CLI + servidores MCP filhos). Em 16/09,
  33 spawns / 6 closes num orquestrador sem missão deixaram 22 panes parados
  e congelaram um Mac de 24 GB. Orquestrador/operador: ao ler o resultado de
  um helper, feche o pane (`nexus_pane_close`) ou nasça-o com
  `autoCloseOnHandoff: true`. Reabrir depois é `resume`, não custo perdido.
- O guardian fecha sozinho pane ocioso sem dono (worker sem missão, helper
  aberto pela mão do operador) após 30 min; nunca orquestrador, worker de
  missão, pane aberto pelo humano no renderer ou pane com `expect` armado.
- F-150: a elegibilidade mais ampla de estacionamento só vale sob pressão
  real, nunca como fallback do TTL. `isSessionIdleForCleanup` veta `working`
  mesmo antigo; receber um handoff (`isSessionInjectableIdle`) não é prova
  de que se pode encerrar o processo.
- `spawnAgentSession` NÃO trava o spawn: o gate de admissão AVISA (teto de
  panes 4–12 conforme a RAM, e memória disponível abaixo de 15 %) e a decisão
  de abrir é da mão do operador — doutrina "menos travas", decisão de 16/09.
  Trava dura só como opt-in explícito (`NEXUS_PANE_CAP_HARD=1`) ou
  `NEXUS_PANE_GUARD=off` para desligar tudo. **Swap em uso não é sinal de
  pressão**: no macOS ele guarda o pico, não o agora (medido: 8 GB de swap com
  o kernel em NORMAL), no Windows o campo do Electron é commit, e cada máquina
  tem a sua medida — lido como pressão, virou trava permanente até o reboot
  (0.76.44) e reaper em loop. O gate de swap só existe armado por máquina
  (`NEXUS_PANE_MAX_SWAP_MB`); não o ligue por default. Sob pressão real o
  guardian ESTACIONA um pane ocioso elegível por minuto sem esperar o TTL: o
  CLI é encerrado, o pane e o scrollback ficam, "Acordar" retoma a mesma
  conversa por resume. Ajuste por env (`NEXUS_PANE_CAP`,
  `NEXUS_PANE_MIN_FREE_MB`, `NEXUS_PANE_GUARD`). Não crie outro caminho de
  spawn que não passe por `spawnAgentSession`.
- Workers e orquestradores NÃO herdam o perfil MCP global do usuário
  (`~/.claude.json`); só a mão do operador (`role user`) herda. Quem precisa
  de um servidor MCP extra declara por allowlist.

## Freio de emergência: pressão CRÍTICA é a única trava sem opt-in (19/10)

Incidente do cliente (iMac M5, 16 GB): abriu ~2 panes, depois vários mais, com
terminais próprios fora do Nexus, e o macOS travou inteiro. Medido neste
repositório: num Mac de 16 GB `limitsForMachine` dá teto 4 e reserva de
2.458 MB, mas as DUAS defesas eram inertes justamente no cenário que mata a
máquina — e os testes de pressão só cobriam panes OCIOSOS.

- **O reaper não via pane ocupado.** `listIdleSessions()` filtra
  `getSessionState === 'idle'` e o tap de status apaga de `idleSince` quem sai
  do idle. Com 8 panes OCUPADOS e pressão crítica por 10 varreduras, o
  guardião recuperava ZERO: a RAM está nos panes que trabalham. Os lotes de
  2/4/6 por tick estacionavam um conjunto vazio por construção.
- **A mão do operador nunca era recusada.** `hardBlocks` nasce `false`, então
  o teto e a memória baixa só AVISAM; o 9º pane entrava com 500 MB livres.
- **A reação levava até 60 s** (`PANE_GUARDIAN_SWEEP_INTERVAL_MS`), sem nada
  entre ticks.
- **O footprint por pane era só telemetria**: `pane-footprint.ts` mede o RSS
  da árvore por sessão, o badge do PaneToolbar o mostra, e nenhuma decisão o
  usava.

O que mudou — e o que NÃO mudou:

- **A doutrina "menos travas" segue valendo para contagem, moderada e severa:
  elas avisam.** A exceção é estreita e medida: livre abaixo de **30 % da
  reserva** (`isCriticalFreeMemory`, `CRITICAL_PRESSURE_FREE_RATIO`) recusa o
  spawn mesmo sem `hardBlocks` — é a leitura literal de "bloqueio só por
  pressão real". A recusa diz que é RAM física (não limite do plano), nomeia o
  dano (travar o sistema inteiro) e o caminho.
- **Swap continua FORA da recusa dura**, de propósito: o gate nasce desarmado
  e, mesmo armado por uma máquina, é advisory por decisão do operador (no
  macOS o número guarda o pico). Por isso há dois predicados:
  `isCriticalFreeMemory` (só livre — é o da admissão) e
  `isCriticalMemoryPressureSample` (livre + swap armado — é o do guardião, com
  a semântica que ele já tinha). A suíte pegou essa diferença: não as una.
- **Na pressão CRÍTICA o guardião também estaciona pane OCUPADO**
  (`paneIsSalvageableUnderCriticalPressure` + `drainBusyPanesUnderCriticalPressure`),
  até `CRITICAL_BUSY_DRAIN_PARKS_PER_TICK` (3) por tick, remedindo a pressão a
  cada park — assim que a folga volta, para. A fila é
  `criticalDrainOrder`: worker/helper antes do pane que o humano abriu no
  "+ Pane", e dentro do tier o **maior footprint medido primeiro** (footprint
  não medido vai ao fim do tier; ausência de dado não é 0 MB). Os vetos de
  sempre continuam: orquestrador, entrega armada, pane que fez pergunta ao
  operador e carência de quem acabou de acordar. Estacionar preserva pane,
  scrollback e "Acordar" por resume; adapter sem resume devolve `false` e nada
  é perdido.
- **O guardião mede o footprint ele mesmo** (`refreshPaneFootprints`, uma vez
  por tick crítico): o push do badge só roda com um renderer assinando, então
  o freio não pode depender dele.
- **Cadência curta sob pressão**: `PRESSURE_FAST_SWEEP_INTERVAL_MS` (5 s)
  dispara a varredura enquanto a pressão é severa/crítica, com guarda de
  sobreposição (`sweepInFlight`); fora disso continua 60 s e não há `ps` extra.
- **O aviso no pane não pode parecer crash**: na pressão o texto diz
  "estacionado para a máquina não travar (memória crítica) … Digite para
  retomar a conversa".
- **A recusa crítica é uniforme**: worker automático, helper, pane do operador
  E orquestrador. Consequência assumida: a remontagem de um orquestrador
  (F-245/F-721) espera a folga voltar — na beira do freeze um pane novo de
  ~1,25 GB levaria o sistema inteiro, e o freio de emergência está drenando em
  paralelo a cada 5 s. Quem recusa diz o caminho; o retry existente reabre.
- As válvulas de escape continuam desligando TUDO, inclusive a recusa crítica:
  `NEXUS_PANE_GUARD=off` e `NEXUS_PANE_MIN_FREE_MB=0`.

## Pane solto tem que começar (F-723)

- Regra do operador (02/10): o Nexus solta um pane e confere se ele está
  executando; se não está, corrige ali ou manda para outro. Campo: o Qwen do
  Maestro morreu no spawn ("modelo selado ... não entrou no argv") e ficou
  parado 30 min (`ORCH_SPAWN_GRANT_TTL_MS`) sem ninguém saber.
- Todo `nexus_pane_spawn` com briefing e ACK pendente (worker de missão ou
  helper do operador) ganha a ficha de `pane-start-watchdog.ts`; os efeitos
  rodam no `delegation-supervisor` (varredura de 15 s + chute imediato em
  falha provada). Orquestrador e o pane do próprio operador nunca são vigiados.
- Falha provada não espera prazo: PTY recusado num grant pendente
  reivindicado (`pty-ipc` → `reportPendingSpawnStartFailure`, que liquida a
  tentativa na hora e recusa bind tardio), saída SOZINHA no boot (tap de
  terminação sem origem pedida, fora de one-shot, < 90 s) e brief de colagem
  recusado. Encerramento pedido, one-shot que terminou e morte tardia não são
  falha de início. Missão encerrada/selo trocado e chamador revogado também não.
- Começou = UserPromptSubmit (`getAgentTurnStartSequence > 0`), status
  semântico working/completed/error, entrega do brief comprovada ou handoff da
  sessão. Sessão VIVA só é julgada em CLI com prova de turno (família Claude,
  `requiresClaudeFamilyTurnProof`); nas outras, viva = sem veredito (F-242 e
  mortalidade de worker cuidam). Ficha sem veredito sai em 30 min.
- Passo 1 (`START_GRACE_MS` = 90 s, sessão ociosa sem turno): reenvia o
  briefing UMA vez pela entrega comprovada do próprio spawn (argv:
  `ensureNativeArgvPromptAccepted`; colagem: `deliverAgentPrompt`). Passo 2
  (falha provada, nenhuma sessão em 90 s, ou ainda sem turno 90 s depois do
  reenvio): revoga a tentativa sem sessão (`abandonPendingOrchSpawn`), fecha o
  pane (nunca `operatorOpened`, F-231), `adapterCircuitBreakers.recordFailure`
  e reabre o MESMO pedido pelo handler do `nexus_pane_spawn` com a autoridade
  ATUAL de quem pediu (`getContextBySession`) e a CLI que falhou em
  `excludeAdapterIds` (agente de roster: `selectSpawnFailSuccessor`). Pin,
  `routeReservationId` e `resume` não viajam: a rota cria e consome reserva nova.
- No máximo UM reenvio por pedido (`rerouted`). CLI pedida pelo operador,
  retomada de conversa, segunda tentativa ou nenhuma alternativa → só avisa.
- O aviso sai em todo desfecho: `[nao-iniciou:<paneId>] ...`, status
  `progress` (`stalled` é diagnóstico e não chega ao PTY), ao Maestro pelo
  handoff do supervisor e ao pane pai do helper pela entrega sem missão
  (F-565). Só ids, adapter e motivo por categoria; nunca erro bruto, argv ou
  brief. Trace: `pane-start-redeliver` e `pane-not-started`.
- F-734: na família Claude, turno aberto ainda não é "começou". O Claude Code
  dispara `StopFailure` NO LUGAR do `Stop` quando um erro de API encerra o
  turno; ele vai a `/hook/status` como `stop-failure` e chega ao Main só como
  categoria da allowlist (`shared/agent-stop-failure.ts`). `error_details` e
  `last_assistant_message` são texto do provedor (sufixo de chave): nunca
  saem do parser nem viram handoff `[auto]`. A ficha espera o desfecho do
  turno do brief (só ele é julgado): ferramenta, handoff ou Stop normal provam
  o início; StopFailure de credencial, conta ou pedido sem trabalho é falha
  provada (passo 2, motivo por categoria, trace `pane-start-rejected`). Limite
  de uso e erro transitório ficam com o failover (F-249/F-718). Credencial
  recusada sem conta gerenciada abre o disjuntor do adapter por 15 min
  (`trip`); com conta, a pausa é por conta (F-676) e o adapter só conta.

## Terminais: geometria e retomada (F-356)

- F-356 (terminal): `fitHostGrid` mede com `proposeDimensions`, aplica o piso
  de colunas e só então faz um único resize. `fit.fit()` antes do clamp apaga
  texto no ciclo estreita→alarga. Enquanto `gridReady` for falso, saída antiga
  E nova ficam retidas; visibilidade sozinha não autoriza drenar o PTY.

## Navegador do pane não pinta sobre popover, menu ou modal (16/10)

- A `WebContentsView` do navegador é irmã nativa do renderer: pinta acima de
  QUALQUER DOM e `z-index` não a alcança. O `+ Pane` e o menu "Ações do painel"
  abertos sobre um navegador ficavam atrás da página e sem clique. Só os modais
  da store (`hardOverlayOpen` em `App.tsx`) escondiam a view.
- `browser-host.ts` esconde só a view CRUZADA (`setBounds({ visible: false })`,
  o mesmo contrato da supressão global) e a devolve quando a superfície some.
  `browser-occlusion.ts` detecta pelo contrato de acessibilidade, sem registro
  por componente: `role` `dialog`/`alertdialog`/`menu`/`listbox` ou
  `aria-modal="true"` (modal cobre todas as views). Um `MutationObserver`
  reavalia no mesmo tick em que a superfície monta, cresce ou sai.
- Popover novo: dê o `role` certo e ele já é coberto; sem role volta a ficar
  atrás do navegador. Superfície só-CSS (`display`/`class` sem montar nem trocar
  `hidden`) só é vista no próximo sync de bounds. Toast (`role="status"`) não
  esconde a view de propósito (piscaria a cada aviso). Pane de agente escondido
  segue estacionado fora da tela, como já fazia.
- Prova: `browser-host-bounds.test.ts` (host) e `BrowserPane.overlays.test.tsx`
  (picker, menu Ações e modal portalado, componentes reais).

## Velocidade de geração por LLM (tok/s + TTFT)

- Três medidores, três perguntas — não os confunda: `cost-tracker` diz QUANTO
  custou, `usage` (transcript) diz QUANTOS tokens o provider cobrou, e
  `token-speed` diz QUÃO RÁPIDO o modelo respondeu a rodada.
- O motor é PURO (`src/main/usage/token-speed-meter.ts`): o relógio entra por
  parâmetro em toda chamada, sem timer nem estado global. O plumbing (taps,
  escopo, throttle) fica em `src/main/orch/token-speed-tracker.ts`, particionado
  pela MESMA autoridade imutável do PTY que o cost-tracker usa.
- **Métrica ausente vai `null`, nunca 0.** Rodada curta demais, submit não
  observado ou zero token não sustentam um número; a UI imprime "—". Zero falso
  num medidor de velocidade é pior que métrica faltando.
- **Janela do tok/s depende da origem da contagem (23/09).** Estimativa pela
  tela: tokens vistos / tempo do 1º ao último texto visível. Contagem REAL do
  transcript: inclui pensamento e tool calls gerados no silêncio ANTES do 1º
  texto, então a janela vai do submit ao último token — dividi-la pela janela
  da tela dava 35 mil tok/s num pane parado. Real sem submit visto não tem
  janela honesta: `null`. A amostra expõe a janela usada em `rateWindowMs`
  (a UI mostra ela, não `generationMs`). Acima de
  `MAX_PLAUSIBLE_TOKENS_PER_SECOND` (6.000, guarda de sanidade acima de
  Cerebras/Groq) a taxa vira `null`. Tudo passa por `#rateFor`; não calcule
  tok/s em outro lugar.
- **Ao vivo é a rodada ABERTA.** `liveTokensPerSecond` = tokens até agora /
  tempo desde o 1º token (relógio `now`); quando o uso real já chegou na
  rodada, vale a regra acima (do submit). O chip/painel usam isso enquanto
  `streaming`; a última fechada só aparece em repouso. Sem 1º token (TTFT) o
  live fica `null` — não recicla o número da rodada anterior.
- **`flushIdle` NUNCA fecha rodada que ainda espera o 1º token.** O silêncio
  entre submit e 1º token É o TTFT, e passa dos segundos em qualquer modelo
  real — fechá-la destruiria a métrica principal. Só o próximo submit ou o fim
  do pane a encerram.
- A fronteira do silêncio mora em `#isSilent` e vale para os três usos (flush,
  corte de rodada obsoleta, indicador de streaming): intervalo de EXATAMENTE
  `idleCloseMs` já encerra. Teste com gap igual ao limiar parte a rodada em
  duas — calibre fixtures abaixo dele.
- A chave de agregação por LLM é o modelo REGISTRADO NA AMOSTRA, não o modelo
  atual do pane: quem troca de modelo no meio da sessão alimenta as duas linhas
  sem reescrever o passado. Pico do modelo é sobre todo o histórico retido, não
  sobre a janela recente — o teto observado de uma LLM não deve evaporar.
- `tapSessionInput` em `pty-manager` é observador read-only: não altera a
  escrita, e um tap que lança não derruba o terminal. Consumidores não podem
  persistir, logar nem encaminhar o payload. O prompt só fica em memória
  volátil até o 1º token, para separar eco de TUI de token do modelo — nenhum
  conteúdo entra no snapshot nem no IPC.
- Correção pelo transcript é idempotente por `sessionId:messageId`: o provider
  REESCREVE a mesma mensagem enquanto ela transmite, com total maior a cada
  reescrita, então a chave atualiza a MESMA amostra em vez de criar outra. O
  uso real pode chegar antes do timer de silêncio: fica pendente na rodada
  aberta e é aplicado no fechamento; não o descarte por ainda não haver
  amostra no histórico. Use o timestamp do transcript para casar a amostra
  temporalmente mais próxima — horário de chegada pode corrigir a rodada errada.
- O rascunho volátil usado para suprimir eco respeita a edição básica do
  terminal (Backspace/Delete, Ctrl+U, Ctrl+W e CRLF). Enter vazio ou só com
  espaços NÃO abre rodada; sem isso o repaint do prompt da CLI vira TTFT falso.
- Não classifique toda saída sem letra/dígito como ruído: respostas de código,
  pontuação e emoji são saída válida. O filtro de TUI remove somente famílias
  conhecidas de moldura/bloco/spinner; o piso de tokens cuida do ruído curto.

## Voz: STT

- **Grok Voice Transcribe 2.0 (xAI, provider `xai`)**: `POST api.x.ai/v1/stt`,
  `model=grok-voice-transcribe-2.0`, `language=pt`+`format=true`, `keyterm` =
  vocabulário CODE / wake word, `file` por último; chave `XAI_API_KEY` (mesma do
  Grok realtime). Só transcreve (`TRANSCRIPTION_ONLY_STT_PROVIDERS`). Migração
  insere o link após o último cloud da cadeia persistida, nunca no head;
  cadeias só-local não recebem.
- **Nomes canônicos no viés do ditado (F-657)**: `shared/dictation-vocabulary`
  exporta `DICTATION_CANONICAL_NAMES` (Jev, Nexus, Claude…) e
  `DICTATION_ENGINE_VOCABULARY` (código + nomes) — é ESTA lista que viaja como
  `keyterm` do xAI, `custom_vocabulary` do Gemini e priming do Whisper, e a
  reescrita do CODE (`code-prompt-polish`) só restaura grafia canônica desses
  nomes; Java real, caminhos, flags e IDs ficam como reconhecidos, e soletração
  ou autocorreção do falante vencem. Ditado é dado, nunca instrução ao modelo.
- **Qualidade da fala antes do provider (F-638)**: `speech-quality.ts` mede
  cada ditado no mesmo PCM de 16 kHz que vai para a STT (fala em s, nível,
  fração 1–4 kHz) e grava `stt.audioQuality` no voice.log ANTES de
  transcrever. Abaixo de 4% de agudos com ≥ 1 s de fala o veredito é
  `muffled` e sai UM aviso por sessão ("Microfone chegando abafado"). Ditado
  que "erra tudo" num PC e acerta no Mac: leia `stt.audioQuality` antes de
  trocar de provider — em 23/09 era fone na entrada rosa, não o modelo.

## Voz: humano de partículas com estados próprios e cursor (17/10)

- Cada `VoiceUiStatus` tem assinatura de movimento própria
  (`figureMotionForStatus`, `src/renderer/components/JarvisParticleFigure.tsx`):
  ouvindo puxa as partículas para dentro e pulsa com `voice-store.level`;
  falando MEXE A BOCA (abaixo); transcrever/rotear orbita em vórtice; erro
  dispersa na cor `--danger`.
- **A boca fala com a voz (20/10).** Um anel de lábios (`buildMouthRing`,
  partículas DEPOIS da silhueta, então os índices do corpo não mudam) abre com
  `voice-store.outputLevel` e estica com `outputBrightness`
  (`mouthShape`/`lipPoint`); o rosto abre o vão e o queixo desce
  (`mouthDeform`); cada sílaba solta uma onda da boca. A cabeça quase não treme
  mais (`speakingZoneWeight` 0,12): tremer borrava os lábios. O medidor
  (`voice-output-level.ts`) publica o brilho espectral (agudos 2–6 kHz ÷ graves
  200–1100 Hz; só acima de `OUTPUT_BRIGHTNESS_MIN_LEVEL`, senão cauda/chiado
  esticava a boca) e ATRASA o par pela latência de saída do contexto
  (`baseLatency + outputLatency`, teto 350 ms): o analisador lê a amostra antes
  do alto-falante e a boca andava à frente da voz. Silêncio depois de voz
  medida é pausa (boca fecha); sílabas sintéticas (~4/s) só sem medidor e
  depois de `SYNTHETIC_MOUTH_GRACE_S`. Validado com fala real (SAPI pt-BR)
  tocando pelo medidor numa bancada: em 220 px a boca abre com nível ≥ 0,4 e
  fecha na pausa.
- **Ocioso = silhueta reconhecível, nunca nuvem.** Antes a coesão ia só até
  ~0,31 e a figura jamais se formava (no Chrome só ~40% dos pixels acesos
  ficavam perto do corpo). Agora `idleCohesion` cicla de ~0,91 (pico) a ~0,61
  (vale parcial) em ~9 s e a dissolução é LOCAL (`FigureMotion.calm`): o
  núcleo (cabeça/tronco, `tip` 0) só fica poroso e mãos/pés (`tip` → 1,
  gerado em `buildHumanSilhouette`) se soltam em poeira e se refazem
  (`idleParticleCohesion`/`idleScatter`/`restPoint`), com a respiração
  coerente do peito (`breathingOffset`). Os demais estados continuam indo à
  nuvem global (`calm` 0). Régua de ajuste: no Chrome, ≥ 99,9% dos pixels
  perto da silhueta nos 16 quadros do ciclo e as duas pernas seguem duas no
  vale; o pior ponto do ciclo é ~0,6 s DEPOIS do vale do núcleo (a ponta
  atrasa), então amostre o ciclo inteiro, não só o `c` mínimo.
- Cursor: repulsão com queda quadrática (`cursorForce`), olhar da cabeça com
  easing (`gazeOffset`) e parallax por profundidade (`parallaxOffset`). O
  canvas continua decorativo (`pointer-events: none`): o mouse é ouvido em
  `window` (`pointermove` passivo com teste geométrico de retângulo), então o
  clique do botão e o arraste do HUD nunca são roubados e um arraste que sai
  da figura não deixa estado preso.
- Toda a física é função pura exportada e testada em
  `JarvisParticleFigure.test.tsx`; o loop é rAF imperativo (efeito com deps
  `[]`, status via ref — sem re-render nem re-dispersão por frame/estado),
  pausa em `visibilitychange`, trava dpr em [1,2] e o `ResizeObserver`
  reescala sem re-dispersar as partículas. Física (`step`) e pincel (`paint`)
  são separados; o teste monta o componente num canvas 2D simulado com
  relógio manual e mede a silhueta pintada de verdade.
- **Movimento reduzido**: sem loop. `paintStatic` põe cada partícula na posição
  de repouso (silhueta FORMADA, não a nuvem aleatória do nascimento) e o
  quadro é repintado na troca de estado (`repaintRef`, erro em `--danger`) e
  no resize. `applySize` re-seta `globalCompositeOperation = 'lighter'`:
  mudar `canvas.width/height` zera o estado do contexto e a figura perdia o
  brilho aditivo depois de qualquer resize.
- **Layout**: o canvas preenche o botão `.voice-figure` (quadrado que segue a
  largura do HUD, teto 220px), sem `vw`; a linha de chão fica em `top: 97%`
  desse mesmo quadrado (os pés fecham em y = 0,96). Validar com o
  `VoiceHud` real num Chrome (hit-test do centro da figura = o botão, clique
  acorda, só a alça arrasta), não só com teste de CSS.

## Voz: ferramentas realtime respondem sempre e leem o estado vivo (20/10)

- **Um `response.create` por lote, depois do `done`.** `OpenAIRealtimeProvider`
  (OpenAI e Grok) manda o `function_call_output` na hora, mas só pede a resposta
  de seguimento quando a resposta que FEZ as chamadas terminou e TODAS as
  chamadas paralelas dela têm resultado (doc da xAI). Antes saía um
  `response.create` por resultado, e o síncrono do Main (`consultar`, recusas)
  batia em `conversation_already_has_active_response`: turno mudo. Lote lento
  não segura outro lote; `sendText` com resposta ativa espera o `done`; esse
  erro vira `responseBusy` (adiado, nunca falha de sessão); sem `done` em
  `DEFERRED_RESPONSE_MAX_MS` (10 s) o pedido sai assim mesmo.
  `responseInFlight` diz ao controller que o `done` era da resposta que chamou
  a ferramenta: o turno de ferramenta só fecha no `done` do seguimento (senão a
  narração local "Feito." passava por cima da resposta de verdade).
- **Nada espera 120 s em silêncio.** O schema do resultado aceita toda ação de
  `SAFE_REALTIME_ACTIONS` (faltava `open_agent`) e CORTA o resumo em 1000
  caracteres em vez de recusar; resultado recusado ainda fecha a chamada com
  `invalid_tool_result` e loga `live.toolResultRejected` (só os caminhos dos
  campos). Jarvis desligada responde `jarvis_powered_off`. A `hint` do
  despachante MCP vai ao modelo (`McpInvokeResult.hint`) para ele seguir o
  caminho certo em vez de repetir a chamada recusada.
- **Leitura viva.** `ler` ganhou scopes `panes`, `missoes`, `cotas`, `git` e
  `saude` (`systemReadToolForScope` → `nexus_pane_list`, `nexus_mission_list`,
  `nexus_quota_status`, `nexus_git_status`, `nexus_system_doctor`, todas
  somente leitura). `consultar` só conhece o resumo da tela e diz isso.
- **`perguntar` devolve a resposta.** `ask_pane` usa `nexus_pane_ask` (digita,
  espera o pane ficar ocioso, devolve só o texto novo; 45 s, prazo da ação
  55 s); o resumo diz se o pane respondeu, ainda trabalha ou é one-shot. Antes
  era `nexus_pane_write` e o modelo narrava "mandei" como se fosse resposta.
- `system.en.md` e os adendos de `factory.ts` agora batem com o código: sync de
  repositório é `sync_repo_via_pane` (pane de CLI), voz não tem missão (efeito
  de missão → `delegar`), enviado não é concluído.

## Voz: relato de handoff e atalho global (17/10)

- **Relato com TTS lenta não pode virar laço de re-síntese.** A TTS local leva
  14-28 s com o HUD em `speaking` e sem áudio audível; o watchdog de status
  preso (6 s) forçava `idle` no meio e, como a posse da voz exigia
  `status === 'speaking'`, o relato voltava à fila e era sintetizado de novo,
  sem nunca falar (um evento `dormant` do Live também zera o HUD sem takeover).
  Hoje (`src/renderer/voice/narration-queue.ts`): (1) a síntese conta como
  progresso para o watchdog (`narrationSynthesizing` em
  `speakingHasAudioProgress`) e passa por `speakSegment` (deadline de 40 s);
  (2) `narrationStillOwnsVoice` compara o token do turno
  (`turnExecution.currentToken`) e os sinais de turno, NUNCA o `status` do HUD;
  (3) `NarrationQueue` limita as tentativas por relato (3) e descarta com
  `onDrop`. O `play` mora em `createNarrationPlayer` (testável; o controller
  só injeta as dependências).
- **O `stop` do atalho global NÃO recupera a janela.** No modo hold o `onStop`
  é o keyup da tecla em QUALQUER app (uiohook): recuperar a janela nele puxava
  o Nexus à frente a cada espaço digitado fora dele. `sendPttAction` só
  recupera em start/toggle (`restoreSingleAuthorizedPttTarget`), confere
  visível + desminimizada + focada depois de `focus()` (no macOS um app em
  segundo plano só ganha foco com `app.focus({ steal })`, que é tentado uma
  vez) e registra `voice.pttWindowRecovered` / `voice.pttWindowRecoveryFailed`
  no voice.log. Janela que não ficou focada descarta o gesto: o `stop`
  correspondente só acha a janela focada e nunca alcançaria uma escondida.

## Voz: Jarvis operacional e Grok Voice em tempo real (15/10)

- **Mic full-duplex em todo transporte realtime**: `isFullDuplexTransport`
  (`src/main/jarvis/realtime/live-mic-gate.ts`) vale para `gemini-live`,
  `grok-realtime` e `openai-realtime`. Antes só o Gemini contava e, com Grok (o
  default), `micIn` segurava os frames enquanto a Jarvis falava: o VAD do
  servidor nunca ouvia o barge-in. O eco segue tratado na origem (AEC do
  Chromium + `liveMicFullDuplex` no renderer).
- **Wake reaproveita o socket quente quando o provider prova a vida dele**
  (`LiveTransportController.reuseHotSocketOrReconnect`). `probeLiveness`
  (OpenAI/Grok) reenvia um `session.update` idempotente e aceita QUALQUER frame
  do servidor em `HOT_SOCKET_PROBE_MS` (800 ms); o mic fica no buffer durante a
  sonda. Zumbi: `hardStop` + reconexão com o áudio retido. Provider sem
  `probeLiveness` (Gemini Live) continua reconectando a cada wake (guarda de
  13/07, `live-grace-lifecycle.test.ts`). Ping/pong NÃO prova nada: o proxy de
  borda responde pong com a origem morta.
- **Transcrição do usuário no Grok**: a superfície da xAI é
  `session.audio.input.transcription` com `language_hint` (variante regional:
  `pt-BR`, o `pt` cru é ignorado) e `keyterms` (até 100 termos de até 50
  caracteres). `input_audio_transcription: { model: 'whisper-…' }` é campo da
  OpenAI e não existe na xAI: não mande. A xAI não emite
  `conversation.item.done` e renomeia o delta para
  `…transcription.updated` (cumulativo; só com `model: "grok-transcribe"`)
  — docs.x.ai/docs/guides/voice/agent, conferido em 15/10/2026, sem sessão
  real contra a API. `parseOpenAIRealtimeEvent` aceita a fala do usuário em
  `conversation.item.created/added/done` SÓ por `content[].transcript` (nunca
  `text`: é o `input_text` que o próprio Nexus injeta via `sendText`) e
  deduplica por `item_id`.
- **Resposta que o `server_vad` começa antes do fim da captura é evidência do
  turno**: `markTurnAudioBaseline()` (`beginListening`, `voice-session-state.ts`)
  e `waitForTranscriptOrProviderAnswer` (`live-answer-evidence.ts`). Tool nativa
  encerra a espera do transcript na hora; áudio do provider dá 450 ms de
  carência ao transcript. Sem evidência a janela inteira corre e o mute segue
  degradando para o Classic (ANTI-MUTE intacto).
- **Mãos livres da Jarvis**: `requiresConfirmation(tool, args, { handsFree: true })`
  (`requiresJarvisConfirmation`, `src/main/jarvis/guardrails.ts`). Só as origens
  `ipc-renderer` e `jarvis-voice` do dispatcher a recebem
  (`isJarvisVoiceDispatch`, `mcp-consent-policy.ts`); agentes CLI,
  `remote_spawn` e `agent_spec_write` seguem na política por efeito. Lista
  explícita `JARVIS_HANDS_FREE_TOOLS`, default-deny. `terminal_run`/`bg_run`
  decidem pelo comando (`requiresVoiceCommandConfirmation`; `sandboxProfile:
  'yolo'` confirma); texto destrutivo em PTY (`paneInputTexts`) confirma. Push,
  PR, catálogo, cron, `ui_action`, `computer_do`, mídia paga e `remote_*`
  seguem confirmando. Tool nova do registro precisa de decisão em
  `guardrails-hands-free.test.ts` (contrato com o registro real).
- **Tirar o modal não bastava**: o dispatcher barrava quase todo efeito vindo
  do renderer com `mission effect blocked` ANTES do modal (o renderer IPC não
  tem missão). `permitsJarvisOperatorEffect` (`mcp-consent-policy.ts`, usado em
  `permitsUnboundEffect` e `bindEffectAuthority` de `mcp-dispatch.ts`) dá à
  Jarvis (origem `ipc-renderer`/`jarvis-voice`, papel `user`, sem missão) a
  "mão do operador" SÓ para chamadas da lista mãos-livres que não pedem
  confirmação. Fica de fora e continua preso à missão: `terminal_run`/`bg_run`
  (comando = `run_command` ou `send_to_pane` com alvo terminal; a saída se lê
  com `nexus_pane_read`), push/PR, `cron`, `ui_action` e texto destrutivo em
  PTY. Mesma doutrina do modo vibe dos panes do operador, com menos poder que
  ele. Provas: `src/main/jarvis/__tests__/mcp-ipc-hands-free.test.ts`
  (despachante e handlers reais) e `src/main/orch/__tests__/mcp-ipc.test.ts`
  (fail-closed, inalterado). Mudança de autoridade: Security revisa.
- **`send_to_pane` endereça qualquer pane**: `sanitizeNexusActionArgs` só
  descarta `paneId` ilegível; `resolveSendToPaneTarget(..., { allowTerminal: true })`
  aceita shell como alvo EXPLÍCITO (`terminal: true`): uma linha e
  `confirmCommand` (só destrutivo/deploy abre diálogo). `ask_pane` e
  `sync_repo_via_pane` seguem só com agentes; navegador nunca recebe texto.

## TypeSafe / Jev (skill `typesafe-ai`)

- Jev é um modelo de **julgamento tipado**, não de geração: `POST
  api.typesafe.ai/v1/systemone` recebe um `state` (texto/JSON) e perguntas
  `noul` (probabilidade de sim), `choice` (uma opção + distribuição +
  confiança) e `score` (níveis ordenados). Use quando um passo
  "prompt-e-parse" pode virar decisão estruturada (triagem, roteamento,
  ranking, verificação). Regra conhecida, cálculo e lookup ficam em código.
- Skill instalada globalmente em `~/.agents/skills/typesafe-ai` (`npx skills
  add typesafe-ai/skills --skill typesafe-ai -g`). O `skill-mirror` lê
  `~/.agents/skills` (`defaultSourceDirs`) e copia para cada CLI em panes
  diretos; em squads governados a skill só entra por `allowedSkills:
  ['typesafe-ai']`. Leia a SKILL.md e os docs vivos antes de integrar.
- Chave: `TYPESAFE_API_KEY` vive em `~/.config/typesafe/env` (modo 600),
  sourçado por `~/.zshenv`. Panes recebem só o `ENV_ALLOWLIST` de
  `pty-manager.ts`: a chave chega pelo shell do usuário, nunca pelo
  `process.env` do Main. Não a persista em settings, logs ou no repo.
- Terminal: `~/.local/bin/jev` (`jev --help`) lê o `state` do stdin, imprime
  JSON quando o stdout é pipe e sai com 0/1 (`--gate`), 2 (`--min-confidence`),
  3 (uso) ou 4 (API). Serve para triagem de saída de testes, gate semântico em
  diff e classificação de itens de QA.
- Todo `state` sai para um terceiro. Não envie segredos, tokens nem conteúdo
  de cliente sem consentimento. Integração no produto (Main/renderer) é egress
  de dados e passa pela revisão de `docs/SECURITY.md`. No produto já existe:
  chave em Ajustes → Chaves de API (cofre `jev-env:TYPESAFE_API_KEY`, fallback
  env); `src/main/jev/jev-client.ts` fail-open com `redactState`; revisão de
  evidência dos handoffs em `src/main/orch/jev-handoff-review.ts` (1 devolução,
  depois `[evidência fraca]` + artifact `nexus.jevReview`; F-707: só devolve
  resumo genérico e código mudado sem verificação ou sem dizer onde — achado
  de revisor e pendência admitida entram marcados; rubrica medida com o Jev
  real nas 105 entregas do HiperGO, reavalie no mesmo conjunto se mudar o
  texto); tool `nexus_judge`
  (read-only, alcançável por todo agente, 30/min/sessão, state ≤ 32 KB); toggle
  `orch.jevAutopilot` / `NEXUS_JEV_AUTOPILOT=0`; skill `typesafe-ai` bundled e
  concedida aos roles `clean-code`.
- Sem credencial utilizável para a rota: `nexus_judge`/`nexus_rank`/
  `nexus_tool_pick`/`nexus_browser_do`/`nexus_computer_do` somem do
  `tools/list` (`McpToolDef.available` = `hasDecisionCredential(surface)`) e a
  skill bundled não é espelhada (`bundledSkillFilter` no `skill-mirror`); nada
  mais muda — o cliente vê um Nexus 100% clássico. "Credencial utilizável"
  depende do modo (`orch.decisionModels.mode`: `jev` padrão, `auto`, `clef`),
  não só da chave TypeSafe: a rota sai de `src/main/decision-models/`
  (`resolveDecisionRoute`), e em "Somente Clef" sem token + Account ID as tools
  somem do mesmo jeito (a UI avisa). `dispatchGuard`, `handoffReview`,
  `memoryDistill`, `computerTool` e `browserTool` (texto) ficam FIXOS no Jev
  (`JEV_PINNED_SURFACES`): sem chave Jev não têm rota, nem em "Somente Clef",
  e o guard vira `skipped`. Novo egress: texto redigido e, só com a visão ligada
  pelo operador, imagens mascaradas de abas isoladas do navegador vão à
  Cloudflare (Clef) — token só no cofre (`clef-env:CLOUDFLARE_API_TOKEN`), env
  próprio `NEXUS_CLEF_API_TOKEN`/`NEXUS_CLEF_ACCOUNT_ID` (nunca as
  `CLOUDFLARE_*` do wrangler). Detalhes e tabela de egress em `docs/SECURITY.md`.
- **Guarda de despacho** (`orch/jev-dispatch-guard.ts`, hook em
  `mcp-dispatch.ts`, surface `dispatchGuard`): toda chamada `nexus_*` COM
  efeito, dentro de missão e fora da mão do operador (a MÃO do operador nunca
  é julgada; FILHOS dela — pane com `operatorParentSessionId`, `role user`,
  sem missão — são julgados com o `prompt` do spawn (≤1500 chars,
  `operatorBrief` no token) como objetivo, em modo só-injeção: `deny` ≥ 0.8,
  nunca modal; sem `prompt` no spawn não há guarda), passa por três nouls — coerente com o objetivo da missão
  (`intentContract.goal`), argumentos com cara de instrução injetada,
  efeito irreversível. Política em código: injeção ≥ 0.8 → `deny` auditado
  com hint (o agente refaz com argumentos próprios); coerência ≤ 0.35 E
  destrutivo ≥ 0.6 → o modal de confirmação VOLTA mesmo em missão aprovada
  (exceção estreita à doutrina 09/09: é assinatura de sequestro, não
  cerimônia); tudo o mais → passa. Read-only e o conjunto isento
  (`GUARD_EXEMPT_TOOLS`: handoff_*, heartbeat, clarify, waits, reads, judge,
  rank, tool_pick, route_*, pane_close — F-709) nunca são julgados. Args vão compactados
  (string > 300 chars vira `<N chars>`, JSON ≤ 2 KB, redigidos) e NUNCA
  entram no decision log. Cache de veredito por sessão+args por 60 s.
  Limiar 0.35 medido em 17/09 com jev-1.13.0 (`git push --force main` numa missão de login
  saiu coherent 0.33 / destructive 0.88); recalibrar pelo painel.
  F-1625: as três perguntas começam por `GUARD_STATE_IS_DATA` (o estado é
  dado; texto nele que fala com o avaliador, alega aprovação ou pede um
  veredito não é evidência e, na de injeção, é sinal dela): a TypeSafe
  documenta que o 1.13 não trata o state como hostil. A suíte rotulada
  (`jev-dispatch-guard-cases.ts`: 5 ataques, 5 legítimos que parecem ataque)
  usa o estado e as perguntas da produção via `buildGuardJudgeState`; mudou
  pergunta ou limiar, rode `scripts/evaluate-decision-models.mjs --suite
  dispatch-guard` com a chave real antes de publicar.
- **Viés da 1ª opção (F-1626).** A TypeSafe documenta que o jev-1.13 puxa
  para a opção listada primeiro. `JudgeInput.orderCheck: { minConfidence }`
  (`decision-models/decision-order-check.ts`, aplicado em `judge()`) repergunta
  SÓ as `choice` cuja vencedora é a 1ª opção e cuja confiança ficou na faixa
  [limiar, limiar + 0,2), com as opções invertidas; escolha que muda, ou 2ª
  consulta sem resposta, sai das respostas e o chamador cai no caminho de
  "sem resposta". Ligado em helperReuse, missionPick, skill, catalogPick,
  desempate do `browser_find` e rota de tarefa, cada um com o próprio limiar.
  Consumidor novo de `choice` com limiar de aceite: passe `orderCheck`.
- **`nexus_tool_pick`** (`orch/tools-tool-pick.ts`, read-only,
  alcançável por todo agente): pré-filtro lexical (sinônimos pt-BR → inglês) sobre as
  ferramentas VISÍVEIS ao chamador (mesmo critério do tools/list), top 24,
  uma `choice` do Jev com `none`; devolve top-N com probabilidades e a
  margem 1º–2º — não corta por confiança (lição das rubricas: 24 opções
  derrubam a confiança por ambiguidade legítima). Registry injetado no boot
  (`setToolPickRegistry`). Medido: "ver o que outro pane está fazendo" →
  pane_read 0.84; "rodar os testes" → terminal_run 1.00.
- **`nexus_route_task` com Jev** (`orch/jev-task-routing.ts`, surface
  `taskRouting`): tier, especialidade, esforço e sugestão de skill julgados no
  mesmo lote (skill só quando há catálogo permitido), cada campo
  aceito só com confiança ≥ 0.6 (senão a heurística de palavras-chave, por
  campo); `tier` passado pelo chamador continua mandando na complexidade/modelo;
  o esforço é uma decisão independente sobre a tarefa, sem piso por especialidade.
  Pin humano/roster continua prevalecendo; esforço automático respeita a CLI;
  `specialtyOverride` é seam aditivo do `RouteContext` (política/benchmark/
  catálogo/reserva intocados). Resultado ganha `classifierSource`
  (`jev|heuristic|mixed`) e `escalate` (0..1) — informação para o Maestro,
  nunca decisão do router.
- **Recibo da rota: confiança e contrafactual** (`confidence` + `ruleChoice`;
  `nexus_route_task`, `route` do `nexus_pane_spawn`, chip "Jev" do pane via
  `SpawnRouteInfo`, `nexus_route_log`). `confidence` = `{tier?, specialty?,
  effort?}` (0..1, 2 casas) SÓ das dimensões que o Jev decidiu: as aceitas pelo
  limiar 0,6 — tier do chamador, dimensão da heurística e tier elevado pelo
  piso de revisão de código ficam sem número. `ruleChoice` = o que heurística +
  tabela escolheriam sem o Jev: `'same'` quando concorda, `{adapterId, model?,
  effort?}` quando difere, AUSENTE quando o Jev não influenciou (a regra nem é
  recalculada). É uma 2ª chamada em memória ao `routeTask` com o `ruleContext`
  de `routeTaskForCaller` (sem `specialtyOverride`/`effortOverride`; tier só o do
  chamador; mesmo roster selado aplicado aos dois lados). Nunca reaproveite os
  overrides do Jev ali e nunca grave reserva, proveniência (`recordRouteDecision`)
  ou log com a escolha da regra: ela abriria o gate de spawn ad-hoc para um
  modelo que ninguém roteou. Só ids e números saem (`parseSpawnRouteConfidence`/
  `parseSpawnRuleChoice`); nunca texto da tarefa, `reason`, conta, fingerprint
  ou token. Recálculo que lança = fail-open (rota igual, sem `ruleChoice`).
  Não validado contra o Jev real: os testes injetam a classificação.
- `nexus_browser_do` ("Jev decide, Nexus executa"): UMA confirmação humana
  por objetivo; ação irreversível/custosa sempre para em `needs_confirmation`
  e devolve a proposta; trava de origem (`left_origin`); textos digitados são
  só os `values` fornecidos (Jev escolhe o label); cap de passos
  (`maxSteps ≤ 40`); uma entrada no decision log por passo.
- **Browser de workers**: um worker abre e dirige as abas da PRÓPRIA missão, na
  janela de origem e no escopo exato. As abas do operador e as de outra missão
  continuam fora do alcance dele e do orquestrador (só a mão do operador e o
  orquestrador promovido a partir dela alcançam a aba do operador). A janela de
  origem é derivada no Main da sessão física: PTY e ACP são comprovados pelos
  respectivos runtimes; headless exige um único coordenador vivo da missão.
  Nunca escolher a última janela como fallback. A mão do operador no renderer
  (Jarvis/`mcp:invoke`, role `user` sem sessão PTY) não tem janela derivada e
  mantém o alcance do operador, limitado ao escopo exato.
  `nexus_browser_press` fornece `event.code` e `holdMs` opcional (0–1000 ms)
  para controles por código e movimento entre frames; cancelar/navegar impede
  keyup no documento substituído. Não confundir build com validação visual.
- **Browser do agente**: toda ação devolve `after`/`changed` (Main, cobre
  navegação entre documentos); `read: true` embute a página; `nexus_browser_find`
  e `click/fill` por `text` (nome acessível, nunca CSS; ambíguo devolve
  candidatos; Jev desempata só com 2–5 candidatos e confiança ≥ 0.7);
  `viewport`/`atBottom`; `format: 'compact'` no read. Cada ação e o read
  devolvem `errors` (console/HTTP ≥ 400/falha de carga desde a ação anterior)
  e o read traz `alerts` da página (role=alert, aria-invalid, allowlist de
  classes de erro — árvores sensíveis excluídas). Navigate, click, fill e
  press anexam por padrão um julgamento Jev da página (erro visível, bloqueio
  humano, carregando, tipo de página; `judge: false` desliga), com teto de
  ~1,5 s: estourado, sai `judgmentSkipped: 'budget-exceeded'` e a resposta
  não espera. Só o TEXTO redigido vai sem pedido; imagem continua exigindo a
  visão ligada e o consentimento. `nexus_browser_extract` extrai
  campos tipados: o código levanta candidatos (JSON-LD, tabelas, label→valor,
  tokens) e o Jev só escolhe entre eles — `null` quando nada confiável;
  extract usa UMA chamada Jev para todos os campos (fan-out); booleano
  indeciso (0,4–0,6) vira null.
- **Skill suggestion** (`jev-skill-suggestion.ts`, surface `taskRouting`):
  uma `choice` entre as skills bundled permitidas (+`none`) para a tarefa,
  incluída na chamada de classificação do `nexus_route_task`;
  `nexus_route_task` devolve `skillSuggestion`, o auto-route do `pane_spawn`
  acrescenta uma linha ao prompt do filho só com confiança ≥ 0.7 e skill
  permitida. Cookbook oficial 'skill suggestion'. F-753: as skills instaladas
  no projeto (`.claude/skills`, `.nexus/skills` da pasta de execução, pelo
  leitor do painel Skills, relido no máximo 1×/min) vão numa pergunta PRÓPRIA
  (`projectSkill`) no mesmo lote. Misturadas às bundled, a confiança se
  espalhava: em 60 tarefas reais do hipergo, as escolhas ≥ 0,7 foram 12 só
  bundled, 8 misturado e 21 em duas perguntas. Vence a mais confiante, e o
  empate fica com a do projeto, que leva `path` (SKILL.md relativo, formato
  validado antes do brief). O pedido do "+ Pane" também ganha a dica (≥ 0,7,
  1× a cada 30 min por pane e skill). Mudou a pergunta? Reavalie no mesmo
  conjunto. A consulta do hook tem o teto TOTAL do conselho de delegação
  (`DELEGATE_TIMEOUT_MS` + `AbortSignal`): o hook do Claude corta em 5 s.
- **Recomendações do Marketplace** (F-757, `catalog-recommend.ts`, surface
  `catalogPick`): o código lê as áreas da stack nos arquivos do projeto (até 3
  níveis, sem link, sem `node_modules`; package.json do workspace,
  go.mod/go.work, *.tf, compose…) e, por área e tipo, os itens do catálogo
  cujo NOME casa com ela (máx. 12, os que começam pela área primeiro). Uma
  `choice` por (área, tipo) num lote só; aceite ≥ 0,7. Ao modelo vão só os
  rótulos das áreas e nome + categoria dos candidatos. Instalar continua nos
  dois diálogos nativos: nunca instale por recomendação. Cache de 24 h por
  raiz + commit do catálogo + candidatos; "Recalcular" ignora o cache.
  Avaliado com o Jev real em 7 projetos locais: 1 a 11 itens por projeto. O
  `Gemfile` do fastlane de app mobile virava "Ruby" (`notBeside`): regra nova
  de área precisa de projeto real que a prove e de um que não deve casar.
- **Missão falada** (`jev-mission-pick.ts`, surface `missionPick`): "abre a
  missão X" no voice executor passa por `resolveMissionByName`
  (`shared/mission-name-match.ts`): nada casa → diz que não achou e lista as
  missões (nunca `missions[0]`); um título igual ou um único que casa → abre;
  vários → UMA `choice` do Jev entre os candidatos (+`none`, por posição
  `m1…m5`, título redigido, state ≤ 2 KB, IPC `jev:missionPick` com
  `handleTrusted` e schema estrito). Só vale com confiança ≥ 0,7 E margem ≥ 0,15
  sobre a 2ª opção; sem decisão (sem chave, desligado, erro) a voz pergunta
  "Qual delas?" e não abre nada. Nada casou e há 1–8 missões (nome mal
  reconhecido pelo STT): o Jev lê a fala contra TODAS (`kind: 'noMatch'`, 9+
  não consulta), piso mais rígido (confiança ≥ 0,90, margem ≥ 0,30) e a voz diz
  "Entendi assim o que você disse"; sem aceite segue o "não achei". O diário
  prefixa `noMatch:`. Rota de texto comum (não fixa no Jev).
- `nexus_computer_do` (macOS, "Jev decide, Nexus executa no desktop"):
  exige permissão de Acessibilidade (`permission_required` aponta o caminho
  dos Ajustes); só a mão do operador ou o orquestrador chamam — worker nunca
  dirige o desktop (um worker pode ter sido injetado por conteúdo web; em
  missão aprovada não há modal por objetivo, então a trava de papel é a
  barreira); trava de app (`focus_lost`); lê a árvore AX do app e, se
  ela vier pobre, OCR local da janela (pixels nunca saem da máquina — ao Jev
  vão só rótulos de elementos e labels de `values`); campos sensíveis
  (`AXSecureTextField`, password/senha) nunca têm valor lido nem recebem
  texto; irreversível sempre para em `needs_confirmation` (best-effort: uma
  captura da janela em `userData/jev/computer/<runId>/confirm.png`, só nesse
  caminho); detector de travamento (3 passos iguais); cap de passos; log por
  passo (surface `computerTool`).
- **Fan-out do operador sem missão** (`tools-panes.ts`): filho ad-hoc herda
  o allowlist do operador (`attenuateTools(ctx.allowedTools, null)`) em
  Autopilot — em Hardened continua `[]`. Filho do operador sempre recebe
  `--strict-mcp-config` (Claude) / `preserveUserMcp: false` (Codex): F-572,
  um helper nunca carrega o perfil MCP global. `nexus_pane_spawn` sem
  `adapterId` na mão do operador roteia `task ?? prompt` pelo mesmo motor do
  `nexus_route_task` (Jev tier/especialidade + tabela) — receipt
  `harness.source: 'auto-route'` + `route`. **Não despachar N helpers no
  mesmo adapter** (três Sonnet, três Claude) só porque o Codex está
  indisponível: misturar CLIs vivas (Codex/Claude/Grok/Kimi/AGY/GLM). O
  título OSC da tarefa não é a identidade do pane (F-597).
- **Handoff sem missão** passa pela mesma revisão Jev do handoff de missão
  (`reviewMissionHandoff`): 1 devolução, depois `[evidência fraca]` no resumo
  que chega ao pane pai + artifact `nexus.jevReview`. Continua correspondência
  `unverified`.
- **Memória do projeto pelo Jev** (F-703): as linhas automáticas nascem de
  cinco trilhos. O aceite de tarefa do plano selado, o ACK físico do Maestro à
  entrega avulsa (`nexus_handoff_ack` → `#retainAcknowledgedHandoffMemory`),
  o fim de sessão com evidência verificada, o merge aprovado e a preferência
  digitada no "+ Pane". Na missão da aba só o ACK roda: sem ele, dois dias de
  HiperGO deram zero memórias. Texto de agente só entra destilado pelo Jev
  (sem diretiva, vale lembrar); descartado não grava. A memória é local da
  máquina (`userData/agent-memory`): o Mac e o Windows não compartilham.
- **Triagem de Bash nativo** (Claude): hook `PostToolUseFailure` com matcher
  `Bash` → `POST /hook/triage` (mesmo bearer do gate) → `triageCommandFailure`
  → `hookSpecificOutput.additionalContext` de volta ao agente. O hook nunca
  bloqueia (`-sf … || true`, `{}` quando a superfície está off).
- **Consumo do Jev** (`jev-decision-log.ts`): além das decisões, o diário
  grava consultas SEM resposta (`kind: 'no-answer'`, motivo categórico,
  nunca texto) — `judge()` registra centralmente quando o chamador informa
  `surface`. O painel Decisões do Jev mostra Hoje/30 dias/desde sempre
  (consultas · custo estimado · sem resposta) e, por superfície,
  `pelo Jev · pela regra`; custo = tokens de entrada × US$ 0,042/M (preço
  público TypeSafe, chamada direta, sem OpenRouter).

## Xiaomi MiMo Code (F-627)

- Adapter `mimo-code`, binário oficial `mimo` (`@mimo-ai/cli`), não OpenCode
  nem Claude. `--trust` pertence à TUI, nunca a `mimo run` headless.
- Auth oficial: XDG `mimocode/auth.json`, ou `$MIMOCODE_HOME/data/auth.json`;
  preservar somente `xiaomi` nas contas gerenciadas. UID + endpoint identifica
  o perfil: API e Token Plan da mesma pessoa não devem se sobrescrever.
  A configuração inline precisa fixar chave por referência de ENV e endpoint
  da conta selecionada: opções nativas `provider.xiaomi.options` prevalecem
  sobre auth.json na CLI e poderiam faturar outra conta.
- Desktop Membership NÃO é Token Plan. Token Plan usa endpoint regional e
  inclui V2.6 Pro/Flash; UltraSpeed exige API pay-as-you-go separada. Não
  reutilizar cache genérico de login para elegibilidade de modelo. Benchmarks
  automáticos exigem chave `sk-`, nunca o plano `tp-` de ferramentas interativas.
- O catálogo remoto da CLI pode atrasar: projetar `MIMO_CLI_MODELS` no inline
  config de panes/benchmarks; não inventar limites, esforços ou resultados.
  Modelos sem medição devem aparecer como não avaliados na comparação.
- Conversas ficam no provider-state do checkout, não no DB nativo. Hook privado
  usa porta/bearer e nonce por spawn em ENV; Main valida raiz/cwd/conta antes
  de aceitar sessionID. Retomada usa ID exato, jamais a última conversa alheia.
  Login nativo sem accountId recebe owner opaco por UID/endpoint (hash da key
  se UID ausente), validado antes do argv e na cópia para outro pane. O ledger
  por sessão preserva esse dono mesmo após `/new`; não usar só a última sessão
  do pane como prova de propriedade.
- Cota Token Plan é outra autorização: janela explícita do console em sessão
  Electron própria; compara userId ao UID da CLI antes/depois da consulta.
  Consentimento persistido contém apenas hashes. Sem cookies autorizados,
  cota fica indisponível; isso não prova logout da CLI. Não extrair cookies
  de navegadores externos nem tratar expiração do plano como reset da quota.
- Tokens do SQLite: input exclui cache; output exclui reasoning (somar uma vez).
  Reescrita da mensagem atualiza uma linha. Custo reportado pela CLI é estimativa,
  não fatura do Token Plan. Nenhum texto de prompt entra na telemetria.
- F-742: com `--dangerously-skip-permissions` e stdin TTY o MiMo (0.1.15) abre
  "Bypass Permissions mode" a CADA boot, com "No, exit" marcado e sem memória
  do aceite; aceitar só liga `MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS=1`
  (superfície oficial da doc do MiMo). O spawn troca a flag pela variável
  (`mimo-skip-permissions.ts`, no pty-manager antes do sandbox/launcher). Não
  volte a passar a flag: na retomada o brief é colado depois do boot, e o
  `\n` dele confirmava a saída do diálogo (worker morto em 5 s). A colagem no
  MiMo espera o rodapé `tab switch mode` (`MIMO_COMPOSER_READY`).

## MiniMax Code (F-655)

- Adapter `minimax-code`, binário oficial `mcode` (`@minimax-ai/code`), não o
  Claude no endpoint da MiniMax — essa rota continua sendo o upstream
  `minimax` do launcher (`api.minimax.io/anthropic`, `MiniMax-M3[1m]`).
- Instalação exige os scripts nativos: `--allow-scripts=@minimax-ai/code,better-sqlite3`
  (o npm 12 bloqueia por padrão e o SQLite da CLI quebra). Atualização é
  `mcode update`, nunca o `npm install -g --prefix` genérico, que perde as flags.
- Login: `mcode login --region global` (China: `--region cn`) ou chave própria
  da CLI (`mcode provider set-minimax-key`). A prova de sessão lê só
  `~/.minimax/auth/prod/<en|cn>/mcode-public/auth-state.json` (status público,
  sem token) ou a linha `minimaxModelSource: minimax_api_key` do `config.yaml`.
  Nunca ler `auth.json` (access/refresh). Sem multi-conta: uma sessão nativa.
- F-678: o pane PTY TEM o MCP do Nexus (`nexusMcp: minimax-code`). A TUI e
  o `exec` leem servidores de `<dataDir>/mcp.json` ("User-configured"), do
  `.mcp.json` do projeto e de plugins locais — o `config.yaml` não declara
  MCP. O Nexus registra UMA vez `mcpServers.nexus` (stdio → ponte
  `~/.nexus/mcp-bridge/nexus-mcp-bridge.cjs`) em `~/.minimax/mcp.json`, por
  mescla idempotente; URL e bearer da sessão chegam só por ENV
  (`NEXUS_MCP_URL`/`NEXUS_MCP_TOKEN`, que o stdio herda). Sem ENV a ponte
  responde zero ferramentas. Nunca use `MINIMAX_DATA_DIR` como overlay: a
  credencial é chaveada pelo caminho do data dir e o login some. O harness ACP
  (`mcode acp`) continua recebendo `mcpServers` no `session/new`.
- A TUI não tem flag nem ENV de permissão nem de esforço: vêm do `config.yaml`
  (`permissionMode`, `defaultModelThinking.effort`); `MCODE_CONFIG_DIR` é só das
  ferramentas de sandbox. F-692: todo pane MiniMax gravável roda livre como as
  outras CLIs — `ensureMinimaxFullAccess` grava `permissionMode:
  bypassPermissions` no `~/.minimax/config.yaml` antes do spawn (edição textual
  da linha de topo, idempotente). Lane somente leitura não é liberada. O Jev
  roteia sem `effort`.
- Prompt inicial posicional depois de `--` (commander lê `-x` como opção).
  Resume só por id exato (`--session <id>`); sem hooks não há id capturado,
  então `--continue` (última sessão do cwd) fica proibido.
- Cota Token Plan: `GET /v1/token_plan/remains` com a Subscription Key (a mesma
  chave do upstream `minimax`, cofre/launcher, ou `MINIMAX_API_KEY`). Região
  preferida = região do `mcode login`; chave recusada tenta a outra uma vez.
  `*_usage_count` é o RESTANTE (igual ao cliente oficial). Nunca usar o
  endpoint privado `coding_plan/remains` nem os headers assinados do cliente.
- Benchmark headless: `mcode exec --output-format text --model {{MODEL}} -- {{PROMPT}}`,
  sem `--permission` (padrão smart). Modelos entram NÃO avaliados.

## Helpers do operador sem missão (F-156/F-157)

- O handoff de workspace só fecha um helper armado após `markSubmitted` confirmar
  a entrega ao pai e somente com status `success`. Se a entrega ficou `queued`,
  o pane permanece vivo para retry. O braço de auto-close é consumido pelo mesmo
  helper usado no handoff de missão; o fechamento roda após a resposta MCP.
- A rota automática desse spawn exige `canUseNexusMcp(adapter)`: sem missão não
  há shim de nx-mail. Se a tabela/Jev escolher uma CLI sem MCP do Nexus, o
  resolver exclui essa CLI, tenta a próxima e expõe o descarte no recibo.
- F-697: o AGY TEM o MCP do Nexus (`nexusMcp: agy`). Ele ignora a projeção de
  HOME privado, mas lê o perfil nativo: `ensureAgyNexusMcpRegistration`
  registra `nexus` → a ponte stdio do F-678 pela própria CLI (`agy mcp add`,
  idempotente via `agy mcp list`, memorizado por processo); URL/bearer só por
  ENV, que o AGY repassa ao stdio (provado com `agy -p` no 1.2.14). Registro
  falho num worker de missão derruba o spawn — nunca um worker esperando um
  handoff que não pode entregar. Fora do Nexus a ponte fica muda.
- F-219: teste que chama `prepareAgentSpawnDecoration` para AGY, Devin ou Muse
  mocka `ensureAgyNexusMcpRegistration`, `ensureDevinNexusMcpRegistration` e
  `prepareMuseMcpSession` (modelo em `mcp-server-governed-profile.test.ts`).
  Sem o mock a suíte roda o `agy mcp add` de verdade e grava o `nexus` no
  perfil real de quem roda os testes (Mac, 30/09).
- F-658: a missão leve da aba (0.76.110) leva os helpers seguintes do "+ Pane"
  à rota de MISSÃO. Ali o pane promovido (`promotedFromUserSession`) mantém a
  mesma regra: `excludeAdapterIds` com as CLIs sem MCP, numa chamada só (sem
  reserva órfã). O uso da missão soma os panes vivos da missão que ainda não
  têm linha em `mission_panes` (`liveMissionAdapterIds`) — sem isso a
  diversidade do rerank não via os irmãos e três helpers caíram no mesmo AGY,
  mudo no `--print` até terminar. Rota nova de spawn: repasse as duas coisas.
- Primeiro uso do AGY pode mostrar esquema de cores e Termos antes do composer.
  Consentimento sobre Termos cabe ao operador; nunca marcar aceite por ele.
- F-662: a regra "helper só em CLI com MCP do Nexus" vale para a MISSÃO da
  aba (`isOperatorTabMission`), não para quem pergunta: o orquestrador retomado
  não é `promotedFromUserSession` e o `nexus_route_task` direto não passava
  pelo auto-route do spawn. Pane one-shot (`OwnedAgentSessionInfo.oneShot`,
  AGY `--print`/OpenCode `run`) não lê o terminal: `nexus_pane_ask` responde
  `state: 'oneshot'` sem digitar nada e `nexus_pane_write` avisa no recibo.
- F-1272: one-shot com a raiz viva conta como ATIVO. Essas CLIs trabalham de
  tela muda: a detecção cai no fallback de idle do avaliador e o PTY apaga por
  silêncio. O predicado é `isOneShotSessionRunning` (pty-manager: sessão no
  mapa + `oneShot` + sem voo de término físico) e o `PaneSnapshot` carrega
  `oneShotAlive`. Todo consumidor de "pane idle" (watchdog de zero entrega,
  reuso de helper, cleanup/park do guardian, conclusão civil) respeita a
  marca; o fallback de idle do avaliador para CLIs interativos continua
  intacto.
- F-247: `selectHubServersForSpawn` filtra o hub MCP por papel. Worker de
  missão e filho do operador recebem só os servidores pedidos em
  `allowedTools` (`mcp__<server>__*`; sem pedido, nenhum — os 16 stdio e os
  remotos OAuth do hub não entram mais no worker). Orquestrador recebe stdio
  + remotos com `headers` (autenticados); remoto sem headers (OAuth
  interativo) fica fora. Pane do operador (`user`/sem papel) recebe o hub
  inteiro. O arg `allowedTools` de `nexus_pane_spawn` só estreita o que o
  chamador e o roster já permitem (`attenuateTools` duas vezes); o trace
  `mcp-hub-filtered` registra só as chaves descartadas.
- Codex no Windows ≥ 0.157 lança `codex-code-mode-host.exe` a partir do
  próprio pacote npm. No prefixo do Node do WinGet o caminho passa de 260
  caracteres e toda ferramenta do Codex falha com `failed to spawn code-mode
  host … (os error 3)` — dentro e fora do Nexus (o `logs_2.sqlite` do
  provider-state mostra). Não é bug do pane: instale o Codex num prefixo curto
  (`npm i -g --prefix %USERPROFILE%\.local\bin @openai/codex`).

## Windows: o encerramento do PTY precisa se provar (F-659/F-660/F-661)

- O `node-pty` do Windows lança `Signals not supported on windows` para
  QUALQUER `kill(sinal)`. Toda morte de raiz de PTY passa por `killPtyRoot`
  (`pty-descendant-termination.ts`): sem sinal no win32, com sinal em POSIX.
  Chamar `proc.kill('SIGTERM')` direto deixa a sessão presa no voo de
  encerramento — entrada recusada, saída descartada, "Retomar"/"Pedir ajuste"
  esperando para sempre, e o reconciliador de 1 s repete a tentativa.
- **F-1617: o `kill()` do ConPTY não é idempotente.** Cada chamada repete o
  `ClosePseudoConsole` no mesmo HPCON; a 2ª antes do `onExit` derruba o PTY
  host com `0xC0000374` e TODOS os panes caem juntos (reproduzido com o
  node-pty real). `killPtyRoot` fecha o console só no 1º pedido e a escalada
  `SIGKILL` termina a raiz pelo PID. Nunca chame `proc.kill()` de um PTY
  fora dele, nem «tente de novo» um encerramento chamando `kill()` outra vez.
- Pane `idle` não é "orquestrador terminou". Maestro parado numa pergunta ao
  operador (hook `awaiting-input` ou notificação, rodada ainda aberta) é
  `isAgentAwaitingOperator` e conta como ocupado no `orchestratorBusy` da
  entrega civil e do "pronto". Só o `Stop`/erro do hook fecha a rodada.
- Missão da aba (sem `squadId`, com `workspaceBinding.adoptedPaneId`) retoma a
  CONVERSA de quem a liderava: `operatorTabMissionResumeSpec` escolhe o último
  orquestrador da composição e o respawn usa `resume: true` +
  `resumeFromPaneId` com a CLI, o modelo e a conta desse pane. Não volte a
  subir o Maestro do squad padrão para ela: vira um Claude vazio.

## Windows: env do usuário, folga de memória e ConPTY (15/10)

- **`HKCU\Environment` chega ao pane e ao hub MCP.** O env do pane nasce de um
  allowlist fechado sobre o `process.env` do Main, que no Windows é congelado
  no boot: variável criada ou editada no painel do Windows ou com `setx` nunca
  chegava ao pane nem ao backend de um MCP stdio (um MCP de `~/.claude.json`
  que depende de `MARGEM_MCP_READ_URL`/`MARGEM_MCP_READ_TOKEN` subia sem elas,
  sem o operador ter como descobrir a causa). `src/main/pty/windows-user-env.ts`
  lê `HKCU\Environment` por `%SystemRoot%\System32\reg.exe query` (caminho
  absoluto, argv fixo, sem shell, timeout de 2 s, cache de 5 s;
  `refreshWindowsUserEnvironment()` o descarta) e `mergeWindowsUserEnvironment`
  só PREENCHE lacunas. Entram `REG_SZ` e `REG_EXPAND_SZ` (o `%VAR%` é expandido;
  desconhecida ou em ciclo fica literal, com profundidade máxima 4); chave já
  presente, em qualquer caixa, nunca é sobrescrita; `Path` entra por merge
  aditivo de diretórios novos. Ficam recusados os prefixos `DYLD_`, `LD_`,
  `NODE_OPTIONS`, `ELECTRON_`, o namespace `NEXUS_` e as chaves de identidade
  (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `COMSPEC`,
  `TEMP`…). O merge roda em `baseChildEnv()` (`pty-manager.ts`, o ponto mais cedo
  do env: `suppressEnv`/`envRemove` do spawn continuam vencendo) e em
  `backendEnv()` (`mcp-hub/mcp-stdio-bridge.ts`: o `env` do descriptor continua
  vencendo). É no-op fora do win32, e falha de leitura vira `{}`, nunca lança
  no spawn. **Não amplie a herança de `process.env`**: o Main carrega chaves de
  adapter de CLI e isso quebraria a fronteira de segurança.
- **Standby List e folga de memória.** Num cliente Windows de 32 GB com 2 panes
  vivos o 3º worker automático era recusado com «Memória sem folga», por três
  causas: o `free` do Electron no win32 ignora a Standby List (cache reutilizável
  na hora), a reserva de 15 % crescia sem teto (4,9 GB em 32 GB, 9,8 GB em 64 GB)
  e panes cuja inicialização terminava dentro da janela assíncrona da amostra
  eram debitados em dobro (1.280 MB cada). Agora `sampleSystemMemory` no win32
  usa o MAIOR entre `info.free`, `os.freemem()` (`ullAvailPhys`, que inclui a
  standby) e `info.available`, ou seja `Math.max(free, os.freemem(), available)`;
  `limitsForMachine(totalMB, platform)` limita a reserva `minFreeMB` a 4 GB
  (15 % da RAM, piso de 1 GB; a referência de 24 GB segue em 15 %) e, no win32, a
  8 % com teto de 2 GB, onde o sinal medido ainda é o mais pessimista;
  `refreshSystemMemorySample` conta `allocatedAgents` como o maior entre antes e
  depois da leitura. A recusa de memória (`pane_admission_memory`, `reason:
  'memory'`) agora diz os MB livres medidos contra a reserva e que é memória RAM da
  máquina, não limite do plano (o limite do plano é o `license_agent_limit`, ver
  "Plano Trial").
- **ConPTY: título do console host e resize sincronizado.** O ConPTY escreve
  sozinho um OSC 0/2 com o executável do console host
  (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
  `C:\WINDOWS\system32\cmd.exe - agy.cmd`, com prefixo `Administrator:` ou
  `Administrador:`, ou o título padrão `Windows PowerShell`/`Prompt de comando`).
  `windowsConsoleHostName` e `isWindowsConsoleHostTitle` (`renderer/lib/pane-title.ts`)
  o reconhecem: `cliPaneDisplayTitle` devolve só a família ("AGY") e limpa
  títulos já gravados no layout ("AGY · C:\Windows\…"); no `terminal-host.ts` o
  pane de agente ignora esse OSC e o de shell grava só o nome do executável. O
  ConPTY mantém buffer próprio e rola uma linha ao encolher, então o
  `bouncePtyGrid` no Windows espelha o par `rows-1`/`rows` no xterm junto do PTY (a
  heurística `windowsPty` do xterm roda com a do ConPTY); `attachHost` não repete o
  bounce quando `propagateHostSize` já mandou a grade real; e a adoção num ConPTY
  faz um único `pty.resize` na grade real e NÃO regrava a fita headless de 120
  colunas (pane ainda vazio: bounce espelhado).

## Disjuntor do adapter: sucesso é início provado (F-736)

- PTY gravável não prova que a CLI funciona: o Qwen chegava ao writer-ready e
  morria no boot 3 s depois, e o `recordSuccess` dali zerava a contagem a cada
  spawn — a rota o escolheu 7 vezes em 8 min. O sucesso do adapter é o início
  provado do turno (pane-start watchdog). Não volte a registrar sucesso no
  spawn.
- Janela de 10 min (3 mortes abrem, mesmo espaçadas) e recuo exponencial a
  cada sonda half-open que falha: 30 s → 2 min → 8 min → 30 min (teto),
  partindo do último período aberto (depois de um `trip` de 15 min, 30 min).

## Colagem no Codex: Enter só depois do marcador (F-735)

- No Windows o ConPTY não repassa o bracketed paste ao crossterm: o Codex
  recebe a colagem como teclas soltas e a ingere a ~0,5 ms por caractere
  (Codex 0.160, máquina ociosa). Enter que chega antes vira quebra de linha
  DENTRO da colagem, e cada retentativa colava outra cópia
  (`[Pasted Content 4531 chars] #2`).
- A partir de 1.000 caracteres o Codex só mostra `[Pasted Content N chars]`
  quando aceitou tudo. `paste-ingest.ts` arma a espera por esse marcador
  ANTES de escrever (só a saída nova conta; a regex tolera espaços
  desenhados por movimento de cursor) e o 1º Enter sai depois dele, com teto
  de 2 s + 1,5 ms/caractere. Vale para a entrega de handoff
  (`idle-delivery`) e para `injectPrompt`/`injectPastedPrompt`/
  `injectWithBusyProof`. Caminho novo que cola e aperta Enter num pane passa
  pelo mesmo plano (`pasteIngestPlanForSession`).
- O `UserPromptSubmit` nativo prova o aceite também fora da família Claude.
- F-1006: rajada de handoffs ao mesmo Maestro sai numa colagem só (uma linha,
  um CR; até `MAX_DELIVERY_BATCH`/`MAX_DELIVERY_BATCH_CHARS`), cada handoff
  com a própria tentativa e o próprio CAS. `nexus_handoff_ack` que chega antes
  da borda busy adota a tentativa colada (não abre outra pelo pull), e CAS
  perdido no aceite é resolvido pelo ledger — nunca lança de dentro do tap.

## Remoção recursiva nunca segue link (F-663)

- O `fs.rm`/`fs.rmSync` recursivo do Node 24 (Electron 43) ATRAVESSA junctions
  no Windows e apaga o conteúdo do alvo. O Node 22 do terminal e do vitest não
  faz isso — teste que só confere "o alvo sobreviveu" passa no código errado.
- Overlays de pane ligam por junction as conversas do provider-state, perfis
  de CLI e a identidade do operador. Toda remoção recursiva no Main usa
  `removeTreeSync`/`removeTree` (`src/main/util/remove-tree.ts`): tira cada
  link da árvore primeiro e só então apaga o resto. Não chame `fs.rmSync(…,
  { recursive: true })` direto em código novo.
- Para provar um caso real no runtime do app:
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe script.js`.
- F-664: a retomada da missão da aba move a linha do orquestrador para o pane
  novo (`moveOrchestratorPane`) — `missionPanes.record` deduplica pela
  identidade e nunca troca `pane_id`.
- F-721: a retomada da aba é a ÚNICA dona do líder. `respawnFastLaneOrchestrator`
  reserva a transferência (`beginOperatorTabResumeTransfer`) antes da varredura;
  enquanto ela vale, o renderer não religa o pane antigo (restore e limite do
  spawn recusam) e outra retomada da missão é recusada. O pendente usa o
  `resume` selado pelo Main (virava `false`: conversa vazia em Claude e Codex),
  o lookup recebe a raiz selada do spawn e, com conversa copiada
  (`exactResumeRequired`), o spawn retoma ou falha — nunca `fresh-context` nem
  fallback headless. Spawn que retoma não leva brief no argv: ele é colado.
- F-665: "Pedir um ajuste" deixa `<!-- nexus:awaiting-adjustment:<ts> -->`
  até a missão pedir conclusão. Na retomada da conversa da aba só o ajuste
  dos últimos 5 min (`operatorTabResumeAwaitsAdjustment`) prepende "AGUARDE O
  OPERADOR"; senão a nota manda resumir onde parou e continuar. O hold do
  Pronto continua lendo o marcador inteiro.
- F-666: o Codex 0.157 abre "Folder access" (Open restricted / Quit) para
  pasta `trust_level = "untrusted"` — o perfil governado marca a worktree assim.
  A assinatura `codex-folder-access-restricted` responde "Open restricted"
  lendo a tela; nunca "Trust and continue". No Windows o perfil governado liga
  `features.code_mode_host` (`codexGovernedCodeModeHost`): o Codex instalado
  roda toda ferramenta por ele. O macOS governa o binário fixado e mantém off.
- F-668: nunca entregue argv a um `.cmd` do npm no Windows — o `cmd.exe` corta
  o argumento na 1ª quebra de linha (o brief chegava como "## Nexus execution
  authority"), expande `%VAR%` e limita a 8K. O spawn direto usa
  `windowsNpmShimSpawn` (pacote verificado → `.exe` ou `node.exe` + script,
  `node` ao lado do atalho ou do PATH) para toda CLI embutida.
- F-669: no Windows a linha de comando inteira tem 32.767 caracteres; brief
  acima de `WINDOWS_NATIVE_PROMPT_MAX_CHARS` (20K) não vai no argv —
  `nativeArgvPromptFits` decide no pty-manager, no tool-util e na Via Rápida,
  que colam o brief depois do boot.
- F-672: escolha explícita de CLI no `nexus_pane_spawn` é respeitada, mas o
  recibo traz `diversity` quando a CLI já tem 2+ helpers vivos na missão
  (`sameAdapterDiversityHint`): omitir `adapterId`/`model` devolve a rota ao Jev.
- F-670/F-671: a decisão final do brief no argv do Windows é do pty-manager,
  que conhece executável e argv finais: `.cmd`/`.bat` ou linha acima de 32.000
  (`windowsArgvPromptPlacement`, aspas do MSVCRT) tiram o brief do argv e o
  gancho `setDeferredInitialPromptHook` (mcp-server → `deliverAgentPrompt`) cola
  depois do boot. Canal one-shot recusa com erro claro.
- F-673: no Windows o xterm nasce com `windowsPty: { backend: 'conpty', buildNumber }`
  (`xtermWindowsPty`, build via `window.nexus.windowsBuild`). Sem isso ele puxa o
  histórico ao ganhar linhas enquanto o ConPTY repinta: texto sobreposto.
- F-674: na missão da aba, `adapterId` fixado pelo orquestrador numa CLI com 2+
  helpers vivos é redistribuído (`route.redistributed`); `operatorChoice: true`
  preserva a CLI que o operador pediu.

## Rotação de contas e roteamento com dados públicos (F-675/F-676/F-677)

- F-675: sem avaliação `nexus-eval`, a qualidade do candidato no
  `route-pipeline` vem de `orch/published-benchmarks.ts` — números OFICIAIS
  do fabricante (DeepSWE v1.1, Terminal-Bench 2.1, SWE-bench Verified), cada
  um com URL da fonte. Terminal-Bench de outra versão não entra (não é
  comparável). Variante só herda (`sameModelAs`) quando o fabricante diz que é
  o mesmo modelo; sem número publicado não há nota. Linha nova na tabela de
  rota precisa de nota ou de entrada em `UNPUBLISHED_ROUTE_MODELS` no teste.
- F-189 (uso geral): no `scoreRouteCandidate` a nota de qualidade pesa em
  dobro e modelo sem benchmark publicado recebe `NEUTRAL_UNPUBLISHED_QUALITY`
  (15), nunca o piso; a posição na tabela é só desempate e a distância de tier
  pesa −10 por degrau. A heurística de especialidade não prefere provider
  (`HEURISTIC_SPECIALTY_ADAPTERS` vazio; só o piso de esforço). No
  `nexus_route_task`, `preferAdapters` prioriza uma CLI pronta do mesmo tier
  (F-1313), preservando critical/security, julgamento e ranking medido;
  `exclude` do chamador só vale para CLI doente (circuito aberto, contas em cooldown, worker morto na
  missão) — exclusão de CLI saudável é ignorada e aparece no `reason`.
- F-676: frota de 10–100 contas. O disjuntor de morte instantânea é POR CONTA
  (2 mortes da mesma), e o provider só trava com 5 contas distintas mortas na
  janela. `performSwitch` percorre até 12 contas (`excludeIds` no
  `pickAvailableForFailover`) e tira a que não prepara da frente por 5 min.
  Sondagem de cota: no máximo `QUOTA_PROBE_CONCURRENCY` (6) contas em voo; a
  confirmação de limite usa `refreshForLimitHit(hitAt)`, que divide só a
  leitura forçada que saiu DEPOIS do hit — leitura anterior nunca refuta.
- F-677: o AGY 1.2 do Windows autentica pela vaga ÚNICA `gemini:antigravity`
  do Gerenciador de Credenciais; HOME/USERPROFILE/GEMINI_CLI_HOME isolados e
  `*_APP_DATA_DIR` não mudam a vaga, e o refresh passa pelo servidor do Google
  (ADC por pane não serve). `captureNativeAuth('agy')` lê a vaga quando não há
  arquivo; `prepareProviderSpawnAuthoritative` grava a conta escolhida na vaga
  (`activateAgyAccountForSpawn`): guarda antes a sessão que estava lá
  (`preserveAgyKeyringSession`, nunca mexe em cooldown/ativa), grava, relê a
  identidade e, entre contas diferentes, espera `AGY_KEYRING_SETTLE_MS` para o
  AGY recém-aberto ler a vaga. Pane sem conta fixada nasce na dona da vaga
  (`agyKeyringSlotAccount`) ou, se ela esgotou, na irmã da regra de folga. O
  segredo viaja por stdin em base64; teste nunca toca a vaga real (só com
  `exec` injetado). Conta AGY por chave de API não passa pela vaga.

## Fair-share, lanes de topo e hosts Claude (F-232/F-233/F-234/F-235/F-236/F-237)

- F-232: `globalUseCounts` (reservas consumidas em 7d por adapter,
  `consumedCountsByAdapterSince` no ledger / `consumedRouteCountsByAdapterSince`
  no store) troca o líder da rota quando ele passa `FAIR_SHARE_GAP` (2) do
  menos usado do pool do tier — só se a rotação por missão não disparou, com
  as mesmas exclusões dela (critical, frontier, benchmark, especialidade, menção).
- F-233: cross-review virou lane (`JUDGE_FRONTIER_LANE`: Fable → Opus → Sonnet →
  Sol 6.1 → Astra) via `applyFrontierLane` compartilhada com a visual; sinais
  novos de auditoria/veredito em `REVIEW_SIGNALS`. Sem assento disponível,
  `judgeUnavailable` + hint — o Maestro julga no próprio pane; modelo barato
  nunca julga código.
- F-235 → F-1401: o limite "um pane Claude por conta" caiu — panes da mesma
  conta compartilham UMA linhagem de credencial (escopo por conta,
  `managedClaudeAuthDirectory(accountId)`; a dona da rotação é a CLI via
  `.oauth_refresh.lock`). `excludeAccountIds` e `liveClaudeMissionAccountIds`
  foram removidos: quem prepara o spawn prova a identidade
  (`verifyManagedClaudeAccountForSpawn`) e fixa o blob (`expectedClaudeBlob`);
  se outro pane renovou o token no meio, o prepare refaz verify+prepare até 2
  vezes (`retryClaudeSpawnOnCredentialChange`) em vez de falhar.
- F-236: adapters host-Claude (glm, glm-flash, longcat, deepseek) aparecem
  juntos em `CLAUDE_FAMILY_ADAPTERS`, `CLAUDE_FAMILY_TURN_PROOF_ADAPTERS`,
  subscription-auth e seat-auth. Token Anthropic genérico do env
  (`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`) só é credencial do provider com
  `ANTHROPIC_BASE_URL` no host dele (`anthropicHostForProvider`, que também
  mapeia muse-claude→api.meta.ai). DeepSeek usa
  os ids reais `deepseek-v4-pro`/`deepseek-flash` (API /models, 01/10); os da
  era api-provider migram em `RETIRED_MODEL_MIGRATIONS`.
- F-237: doutrina `JULGAMENTO`/`CUSTO` em `orchestrator-doctrine.ts` — escreve
  barato e diverso, julga caro (veredito de ponta antes de integrar/push).
  O `DOCTRINE_BASE` tem teto de 2 KB testado: bullet novo exige comprimir os
  vizinhos SEM tocar nas frases que os testes fixam.
- **O Maestro verifica, não confia (regra do operador, 02/10).** `VERIFIQUE:`
  na doutrina base (kickoff), `7. Verifique` nas instruções permanentes e uma
  frase no `MAESTRO_TURN_REMINDER`: handoff é alegação, não prova — antes de
  aceitar ou integrar, o Maestro lê o diff e roda o teste que prova a correção;
  sem isso, "não verificado". É doutrina (o modelo cumpre), não portão: o portão
  mecânico é o veredito de ponta (F-234) e a revisão do Jev. A base ficou em 2046
  bytes (teto 2048, testado): bullet novo exige comprimir os vizinhos sem tocar
  nas frases que os testes fixam (`inclusive uma pergunta trivial`, `ESTEIRA`…).
- F-234: o veredito de ponta virou enforcement. `mission_review_verdicts`
  (migração 039) grava cada veredito atado ao HEAD EXATO + `tree_dirty`;
  `nexus_review_verdict` registra com identidade medida pelo Main
  (`ctx.providerId` + `getAgentSessionInfo(sessionId).model`) e
  `isFrontierReviewer` casa por linha com `JUDGE_FRONTIER_LANE` (opus-5-6 vale
  pela linha do 5-5; sem modelo ou GLM nunca é ponta).
  `assertIntegrationReviewed` é o ponto único: `nexus_git_push` de missão,
  o `pushAfterDone` (sem veredito → status muda, push não roda,
  `pushSkipped: 'review_required'`) e o hook `POST /hook/integration`
  (PreToolUse/Bash: `git push`, `gh pr create|merge`, `git merge … main` —
  `--dry-run` e cwd fora do checkout cobertos; pane sem missão sem portão)
  só passam com `approve` de ponta para o HEAD atual e árvore limpa.
  `review_reports` é do council PREVC — não reutilizar.

## Jev enxugando a orquestração (F-194/F-195/F-196/F-197)

- Jev 1.14 (14/10): docs oficiais `https://docs.typesafe.ai/models` expõem
  `jev-1.14.0`; `jev-preview` aponta para ele, `jev-latest` ainda para 1.13.0.
  Seleção em Chaves de API → Modelos de decisão (`decisionModels.jevModel`);
  NEXUS_JEV_MODEL prevalece. F-1624: sem escolha o padrão é o id FIXO da
  versão calibrada (`JEV_CALIBRATED_MODEL` = `jev-1.13.0`, `shared/decision-models.ts`),
  não o alias `jev-latest`, que troca de modelo quando a TypeSafe lança versão
  (os docs mandam fixar o id em que os limiares foram medidos). `jev-latest`,
  1.14 e preview são opt-in; modelo recusado tenta `jev-latest` uma vez, sem
  trocar de provedor. Recalibrou numa versão nova? Troque a constante junto.
  O limiar 0.35 e as rubricas de tier/esforço são calibrações históricas de
  1.13.0; precisam de reavaliação no MESMO conjunto antes de migrar o padrão.
  A fixture real de 01/10 continua histórica, nunca rebatizada como 1.14.
  O conjunto sintético `scripts/fixtures/decision-models/nexus-cases.json`
  não substitui as 78 tarefas de audit_events nem a calibração de 17/09.

- F-194: o rubric de tier do `jev-task-routing.ts` foi avaliado com o Jev real
  sobre 78 tarefas delegadas (`audit_events`): texto antigo 60 hard, novo 32
  hard / 39 medium. Mudou o texto? Reavalie no mesmo conjunto antes de
  publicar. Um rubric de esforço novo SUBIU o esforço e foi descartado. No
  `scoreRouteCandidate`, `hard` pesa custo ×1,5 (igual medium); `critical` ×0,5.
- F-195: `adapterId` explícito sem pedido do operador vira `preferAdapterIds`
  (preferência leve) para orquestrador de qualquer missão e pin do pane do
  operador. Literal só com `operatorChoice`, `resume`, reserva de rota, roster
  ou CLI digitada no próprio pane nos últimos 15 min (`operator-cli-mentions.ts`,
  input humano só em RAM — nunca persistir, logar nem encaminhar).
- F-196: `nexus_pane_read`/`read_many` padrão `digest` para o orquestrador
  (`pane-output-digest.ts` + `classifyPaneTailForDigest`); `mode:'full'` é o
  texto cru. `nexus_handoff_list` compacta artifacts de entregues antigos (fora
  das 5 mais recentes/não entregues/`ids`); `detail:'full'` desliga.
- F-197: `idle-helper-reuse.ts` — reuso de helper parado (mesmo dono, mesma
  CLI, mesmo modo, ≥20 s parado pelo status semântico) só no pane do operador
  e na missão da aba; o Jev (`helperReuse`) escolhe ou `none`, aceita ≥ 0,7.
  Título do pane entra no critério só como caminho do state, nunca como texto.

## Missão que morre e volta: o que o trace mostra (F-187/F-211/F-212/F-213)

- `main.trace.ndjson` registra `agent-pty-terminate` (origem estável de todo
  término pedido pelo Nexus) e `agent-pty-exit` (código, sinal, tempo de vida
  e `terminationOrigin`; `null` = o processo saiu sozinho) para todo PTY de
  CLI-agente, inclusive o pane direto do operador. Chamada nova de
  `orchTerminateSession`/kill precisa passar `origin`; sem ela o trace diz
  `unlabeled`. Nunca grave argv, ambiente ou texto nesses eventos.
- `pane-spawn-timing` mede cada nascimento de pane (renderer: `rendererWaitMs`
  e fases do main; MCP: rota, isolamento, credencial, alocação, prompt).
  `rendererWaitMs` é telemetria: clampado em 0–600000 e nunca pode reprovar um
  spawn.
- Conversas Codex moram em `<userData>/provider-state/codex/<checkoutId>/
  sessions` (F-566). O `CodexUsageScanner` lê essas raízes
  (`codexSessionsDirsFor`) e o vínculo de rollout novo a exatamente um launch
  grava `provider_pane_sessions` com a conta do launch — é o que permite
  `codex resume <id>` no religamento de pane com conta fixada.
- Remount automático (`retry-kickoff`, ressurreição do escopo) adota uma sessão
  de orquestrador registrada e viva (`orchestrator-live-adopted`) quando
  `liveOrchestratorSessionId` não a reconhece; só o Retomar do operador pode
  encerrar e substituir um Maestro vivo.


## Conclusão de código e validadores Main (06/10)

- Missão `standard`, inclusive sem squad/+Pane, pede verificação por `done`;
  `completionRequested` não prova conclusão. `mission-code-completion.ts` emite
  a certificação Main vinculada à missão e ao candidato atual; nota, scanner
  isolado e handoff do próprio autor não substituem o juiz independente.
- A base nasce antes da missão (`mission-code-baseline-ledger.ts`). Sem base
  conhecida, a leitura cobre o estado atual e não atribui autoria do WIP.
  Artefatos existentes declarados também entram no fingerprint. Leitura
  truncada, paths protegidos ou cobertura desconhecida nunca viram aprovação.
- O reviewer frontier nasce em leitura, registra o veredito do candidato exato
  e entrega seu relatório antes de fechar. Achados voltam ao Maestro para
  correção; candidato alterado exige nova revisão. Council congelado conserva
  seu fluxo próprio. Conclusão humana explícita e entregas textuais comprovadas
  mantêm suas autoridades existentes.
- `owned-check-exec.ts` compartilha a reserva de RAM/comando pesado com os
  workers. Prazo lógico pode terminar antes da árvore física: reserva, HOME e
  worktree de comparação só são liberados com prova de saída. Fila/cancelamento
  recuperável não consome orçamento de reparo de código. Typecheck e auditoria
  pesados são sequenciais na conclusão; metadados leves podem ser paralelos.
- Ausência de compilador/sandbox não é teste aprovado. Ausência comprovada de
  teste aplicável também não é obrigação de inventar testes. O runner reconhece
  JS/Python e suítes nativas Go/Rust; sucesso de compilação Cargo não prova teste.
  Falha Rust sem identidade inequívoca do alvo não recebe dispensa F-246 pelo
  nome do caso. GoWork só inclui módulos comprovados dentro do escopo.
- Toolchains nativas usam cache privado e grants restritos ao SDK; nunca dar
  leitura do HOME inteiro por um prefixo de instalação. Rustup de descoberta
  usa `RUSTUP_AUTO_INSTALL=0`. Windows usa ferramentas da imagem OCI configurada;
  não tenta executar launchers `.cmd` nem nomes da imagem no host Windows.
