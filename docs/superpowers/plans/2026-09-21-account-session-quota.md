# Account session and quota consistency

**Goal:** Preserve separate logins and make quota, spawn and failover use the correct account's current credential.
**Architecture:** Reuse the existing identity and freshness comparison in a read-only credential selector. Persist renewed credentials through the existing account store. Provider quota failures remain unknown, never borrowed from another identity.
**Stack:** TypeScript, Vitest, SQLite, native CLI credential stores.
**Spec:** User reports two missing Codex quotas, stale Grok authentication, absent AGY quota and duplicated Claude readings; asks to repair login, persistence and account switching.

## Execution

- [x] Add failing regression tests for stale vault versus fresh native/managed Codex and Grok credentials; reject a different subject even with the same email and reject unidentifiable native credentials.
- [x] Implement the shared read-only selector in `src/main/adapters/account-credential-candidates.ts`, consume it from `provider-usage-auth.ts` and account spawn preparation; run focused tests.
- [x] Reproduce AGY credential source and transport mismatch; add regression tests at the boundary before implementing the supported native route.
- [x] Reproduce Claude cache/account mismatch; require matching cache identity and isolate account CLI probes; verify separate-account readings.
- [x] Review and test save-login, explicit reauthentication, durable storage, activation and failover paths. Fix concrete findings with regression tests.
- [x] Run relevant quota/account/login suites, typecheck and renderer-sink guard. Register findings and obtain independent review.
- [x] Verify live read-only provider probes and state precisely which changes require rebuilding/restarting the installed application.

## Constraints

- No tokens, fingerprints or unmasked account identities in logs or evidence.
- Native credentials are read-only; quota probes must not independently rotate Codex/Grok refresh tokens.
- A pinned account cannot borrow a different account's credential or cached usage.
- Preserve the user's running application and panes; no forced shutdown.

## Resultado

556 testes, typecheck, renderer-sinks e package/smoke passaram. Nova build local gerada; não houve publicação nem substituição do app aberto. A consulta real distinguiu a sessão Codex secundária revogada; novo OAuth exige ação humana. Claude permanece sujeito ao 429 observado durante a investigação.

## Fechamento solicitado pelo operador

- [x] Validar as duas contas Claude pelo caminho real de leitura: conta b 12%/75%, conta adm 0%/6%; ambas `cliLoggedIn: true` e sem hint de erro.
- [x] Validar a primeira conta Codex: identidade correta, 4% semanal na consulta direta.
- [x] Concluir a autorização humana da segunda conta Codex no fluxo por dispositivo e validar a identidade antes de materializar: 19% semanal; conta adm 5% semanal.
- [x] Preparar metadados 0.76.67; typecheck, renderer-sinks e testes de autoridade de release passaram.
- [x] Rodar suíte completa: 1.439 arquivos, 15.356 testes passaram, 8 skipped. Excluir somente artefatos extraídos de análise (F-623).
- [ ] Commitar por finding, enviar branch/PR e integrar conforme proteção de main.
- [ ] Tag anotada v0.76.67, build selado com Node22.23.2, gate assinado/notarizado e publicação macOS nos repositórios canônico e público.

A primeira tentativa de login Codex retornou a outra identidade e foi rejeitada antes de salvar. Credenciais nativas preservadas. A segunda conta aguarda login no home isolado `reauth-second`; nenhum segredo faz parte do Git.

## Ampliação solicitada durante a validação

- [x] Codex padrão usa login por dispositivo no pane interno, preservando métodos explicitamente personalizados; helper e regressões adicionados.
- [x] Corrigir o relogin acionado pela linha de cota para preservar e salvar a conta correta (F-359).
- [x] Adicionar `nexus_pr_create` para operador em checkout normal, sem exigir worktree, com autenticação GitHub e políticas existentes.
- [ ] Rodar gates finais e concluir commits/push/release após essas inclusões.

Implementações adicionais: F-359 com 19 testes focados; F-155 com 229 testes em oito suites, typecheck e renderer-sinks verdes. Nenhuma ferramenta remove a exigência de autenticação do GitHub naquele Mac.
