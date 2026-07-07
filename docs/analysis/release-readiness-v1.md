# Analise Senior Independente - Prontidao do pipeline Jarvis para v1.0.0

Data da analise: 2026-07-07
Stance: Principal Engineer / Release Auditor independente
Escopo: leitura de reviews, paridade, logs e estado commitado dos worktrees F3/F4/F5/F6. Fixes nao commitados observados nos worktrees de fase foram registrados, mas nao usados como baseline de decisao.

## Executive summary

Verdict: **GO-WITH-CONDITIONS para o plano F3 -> F4 -> F5; NO-GO para cortar v1.0.0 hoje**.

1. A ordem F3 -> F4 -> F5 continua a melhor ordem tecnica, mas somente se cada fase passar pelos gates abaixo antes do merge.
2. O risco textual de merge e moderado: apenas `src/preload/preload.ts` e `src/shared/types.ts` aparecem nas tres fases commitadas.
3. O risco semantico e alto: as sobreposicoes ficam exatamente na API exposta ao renderer e nos tipos compartilhados.
4. F4 e o eixo de seguranca: sem enforcement/audit server-side no MCP HTTP, F3 realtime action e F5 vision ficam perigosos.
5. F3 ja tem commits de fix no HEAD baseline; seus fixes pos-review quase nao cruzam F4/F5, exceto package metadata com F5.
6. F4 e F5 estavam com worktrees sujos durante esta auditoria; esses fixes em andamento devem virar commits revisados antes de qualquer merge.
7. O `main` commitado esta em `0.10.6`, mas o working tree local regredia package/release notes para `0.10.5`/`0.10.0`; release a partir desse working tree e NO-GO.
8. Os tres reviews repetem o mesmo padrao: fronteiras confiando demais no renderer, validacao runtime incompleta, fail-open e lifecycle/race.
9. Recomendacao de versao: usar `v0.11.0` ou `v1.0.0-rc.1` para o trem de integracao; tag `v1.0.0` so apos smoke empacotado e zero CRITICAL/BLOCKER/HIGH aberto.

## Baseline da analise

| Worktree | Branch | HEAD baseline | `main..HEAD` | Diff commitado | Estado do worktree |
|---|---|---:|---:|---:|---|
| `/Users/cleofasrocha/dev/nexus-ide` | `main` | `a789299e18fad97da7c79f21e8ca940709613c71` | N/A | N/A | Sujo antes da auditoria: `CHANGELOG.md`, `package.json`, `package-lock.json`, `src/shared/release-notes.ts`, `.claude/` |
| `/Users/cleofasrocha/dev/nexus-ide-fase3` | `nexus-jarvis-fase3-realtime` | `b59c6915b3bf4fc793293676e8320100a901ba77` | 14 commits | 40 arquivos, +3035/-315 | Limpo |
| `/Users/cleofasrocha/dev/nexus-ide-fase4` | `nexus-jarvis-fase4-agent` | `2a23c360715634e2714d5724e5c99f978ebbfc3d` | 5 commits | 27 arquivos, +3487/-2 | Sujo: fixes F4 nao commitados em `audit-log`, `permissions`, `workspace-path`, e arquivos novos de validacao/dispatch |
| `/Users/cleofasrocha/dev/nexus-ide-fase5` | `nexus-jarvis-fase5-vision` | `050f4ae26d060723be71cb520a129bd89fd56383` | 13 commits | 26 arquivos, +2634/-6 | Sujo: fixes F5 nao commitados em vision/settings e novo `ipc-bridge.test.ts` |
| `/Users/cleofasrocha/dev/nexus-ide-fase6` | `nexus-jarvis-fase6-parity` | `56d2f721340f4aa9503b1fa71749cc91e12a6a5a` | 1 commit | 1 arquivo, +345/-0 | Limpo |

Merge-base usado por F3/F4/F5/F6 contra `main`: `7927f106e4675483589e7f543a16be06e54ac450`.

Commits `main..HEAD` usados para dimensionar blast radius:

- F3: `b59c691`, `62458dc`, `21c884d`, `fa036dc`, `ec76bf3`, `dce1dca`, `801a8f6`, `bcfb858`, `d6a2879`, `b36b9c9`, `7b71818`, `38dd4f2`, `9b05b4f`, `288cd72`.
- F4: `2a23c36`, `2920976`, `95c689a`, `e5a8c55`, `c63bc7a`.
- F5: `050f4ae`, `a2fd9af`, `0e630b7`, `d4ebaaf`, `78379c3`, `b3a4c68`, `f40789e`, `4c49496`, `1ec599b`, `f6ca782`, `284168f`, `db02ed7`, `62ce60c`.
- F6: `56d2f72`.

## 1. Risco cruzado entre fases

### Matriz de intersecao de arquivos

| Arquivo | F3 | F4 | F5 | Risco | Condicao de aceite |
|---|---|---|---|---|---|
| `src/preload/preload.ts` | Voice live/transcript/smoke API | `window.nexus.mcp.*` | `window.nexus.vision.*` | **Alto**. E a superficie exposta ao renderer; conflitos textuais sao provaveis no objeto `api`, e conflitos semanticos podem criar bypass de consentimento/confirmacao. | Revisao manual pos-merge da API exposta; nenhuma API deve conceder permissao, capturar imagem raw ou executar tool sensivel sem mediacao do main. |
| `src/shared/types.ts` | Tipos de voice/live | Tipos de MCP bridge | Tipos de Vision API | **Medio/Alto**. Quebra de contrato TypeScript pode ser detectada por typecheck, mas composicao insegura nao. | `npm run typecheck` limpo e revisao da interface `NexusApi` por dominio: voice, mcp, vision. |
| `src/main/main.ts` | Nao toca | `registerMcpIpc()`, `closeAuditLog()` | `registerVisionIpc()` | **Medio**. Imports/registro IPC no bootstrap podem conflitar e ordem de inicializacao pode importar para audit/vision. | Ambos os registros presentes uma unica vez; shutdown fecha audit log; smoke de boot empacotado passa. |
| `package.json` / `package-lock.json` | F3 restaura `0.10.6` | Nao toca | F5 adiciona `tesseract.js`/`jsdom` | **Medio/Alto**. Alto risco de regredir metadata `0.10.6` ou lockfile ao aplicar F5 apos F3. | Merge preserva versao/release notes corretas; lock regenerado ou resolvido de forma deterministica; `npm ci` passa. |
| `src/renderer/styles/global.css` | Estados/estilos voice | Nao toca | Vision indicator | **Baixo/Medio**. Risco visual/CSS cascade. | Screenshot/QA visual do HUD voice + indicator vision sem sobreposicao. |

Intersecoes calculadas sobre diff commitado `main...HEAD`:

- F3 ∩ F4: `src/preload/preload.ts`, `src/shared/types.ts`.
- F3 ∩ F5: `package-lock.json`, `package.json`, `src/preload/preload.ts`, `src/renderer/styles/global.css`, `src/shared/types.ts`.
- F4 ∩ F5: `src/main/main.ts`, `src/preload/preload.ts`, `src/shared/types.ts`.
- F3 ∩ F4 ∩ F5: `src/preload/preload.ts`, `src/shared/types.ts`.

Os fixes F3 commitados apos o review (`bcfb858..HEAD`) so cruzam F5 em `package.json` e `package-lock.json`. Isso reduz o risco de conflito dos fixes F3, mas nao reduz o risco das features F3/F4/F5 se acumularem na mesma fronteira `preload`/`NexusApi`.

### Riscos especificos de regressao cruzada

- **F4 MCP IPC vs F3 voice-controller:** F4 review aponta que `mcp-bridge.ts` nao esta realmente ligado ao executor de voz. Com F3 `REALTIME_ACTION_BRIDGE_ENABLED=false`, comandos action-capable continuam na rota Classic. Isso e aceitavel como mitigacao temporaria, mas invalida qualquer promessa de "realtime tool-use" ate F4 HIGH-04 estar fechado.
- **F5 vision tools vs F4 audit/permission funnel:** Vision introduz leitura de tela e OCR; F4 introduz execucao mutante. A combinacao "ver -> decidir -> agir" so e aceitavel se F4 auditar/confirmar as acoes e F5 nao expuser imagem raw por renderer.
- **F3 realtime state vs F5 indicator:** Ambos afetam UX de estado sensivel. O usuario precisa distinguir listening/thinking/acting/speaking/capturing; estilos globais e HUD devem ser verificados juntos.
- **Package metadata:** O `main` commitado ja contem hotfix `0.10.6`; qualquer merge que traga `0.10.5`/`0.10.0` de volta e bloqueio de release.

## 2. Ordem de merge

A ordem **F3 -> F4 -> F5** e a melhor ordem disponivel, com condicoes.

**Por que F3 primeiro:** F3 estabiliza a camada de voz/realtime e ja adotou a decisao de manter `REALTIME_ACTION_BRIDGE_ENABLED=false`, deixando actions em batch/classic ate F4. O blast radius e maior em quantidade, mas os fixes pos-review sao relativamente isolados e incluem preservacao de metadata `0.10.6`, wake raw PCM, reconnect, transcript rotation e timer Gemini stale.

**Por que F4 segundo:** F4 e a base de seguranca para tool-use. Sem F4 corrigida, F3 nao deve ligar actions realtime e F5 nao deve alimentar workflows que podem agir. F4 deve entrar antes de F5 para que audit, confirmacao, path boundary e schema runtime sejam o funil unico de execucao.

**Por que F5 terceiro:** Vision aumenta a sensibilidade de dados. Ela deve pousar depois da camada de acao/confirmacao estar server-side e auditavel. Merging F5 antes de F4 aumentaria a chance de criar um canal de pixels/AX/OCR sem a politica de acao final.

Alternativas rejeitadas:

- **F4 -> F3 -> F5:** so faria sentido se realtime action fosse requisito imediato. Como F3 esta explicitamente com action bridge desligada, nao compensa atrasar os fixes de wake/realtime e versionamento.
- **F3 -> F5 -> F4:** rejeitado. Vision sem F4 segura cria risco de "renderer ve demais" antes de existir um funil confiavel de tool-use/audit.
- **F5 isolada para v1.0:** rejeitado se a promessa incluir Jarvis "ver e agir"; sem F4, Vision deve ficar atras de feature flag ou fora do release.

Condicao critica: F4 HIGH-04 precisa ser resolvido ou explicitamente aceito no posicionamento. Se Jarvis voice actions continuarem fora do MCP/audit, o release nao pode prometer "Jarvis realtime com tools reais"; no maximo pode prometer "Jarvis in-app com acoes classic confirmadas".

## 3. Gaps sistemicos

Os reviews F3/F4/F5 apontam padroes repetidos, nao bugs isolados.

| Padrao repetido | Evidencia nos reviews | Risco fora do escopo revisado | Candidatos concretos para auditoria adicional |
|---|---|---|---|
| Confianca excessiva no renderer | F4 `mcp.confirm` self-service; F5 `vision.capture()`/`onCaptured()` raw; F3 actions ainda no renderer | XSS/local renderer compromised chama capacidades sensiveis sem user intent confiavel | `src/preload/preload.ts` completo; `src/main/pty/pty-ipc.ts`; `src/main/orch/orch-ipc.ts`; `src/main/remote/remote-ipc.ts` |
| Fail-open ou enforcement dividido | F4 audit fail-open e HTTP MCP bypass; F3 provider close deixa estado mentir; F5 captura fallback "qualquer janela" | Controles parecem existir, mas nao estao no ponto real de execucao | `src/main/orch/mcp-server.ts`, `src/main/orch/mcp-protocol.ts`, `src/main/orch/gate.ts`, `src/main/orch/hooks-gen.ts` |
| Validacao runtime/limites incompletos | F4 args sem schema/size/depth; F5 OCR sem limite/timeout; F3 transcript sem retencao inicial | DoS local, crash do main, logs enormes e payloads ciclicos | IPCs em `src/main/orch/*-ipc.ts`, `src/main/media/media-generation.ts`, `src/main/remote/remote-bridge.ts` |
| Path/cwd boundary inconsistente | F4 reimplementa check lexical em vez de `realpath`; `files-ipc` ja tem padrao melhor | Symlink escape pode existir em novas tools que nao reutilizam helper canonico | `src/main/orch/tools-*`, `src/main/media/media-providers.ts` (`resolveOutPath` aceita absoluto), `src/main/orch/preview-server.ts` |
| Dados locais para cloud sem politica unica | F5 screenshot raw; transcripts; media image-to-image le arquivo local para provider | Vazamento de screenshot/imagem/audio/log fora do consentimento esperado | `src/main/media/media-generation.ts`, `src/main/voice/stt-service.ts`, `src/main/voice/tts-service.ts`, transcript/log stores |
| Lifecycle/race em recursos longos | F3 VAD/reconnect; F5 rate limiter nao atomico; F4 grants sem TTL | Estado UI verde com backend morto, grants reutilizados, rajadas paralelas | `src/main/voice/live-transport-controller.ts`, `src/main/voice/gemini-live-transport.ts`, `src/main/remote/remote-bridge.ts` |

Auditoria adicional recomendada antes de `v1.0.0`:

1. **Preload/NexusApi capability audit:** enumerar toda funcao `window.nexus.*`, classificar read/write/network/process/capture/secret, e exigir schema + main-mediated consent para high-risk.
2. **MCP/orch core audit:** garantir que allowlists, gates, audit e permission tokens sao enforceados no caminho HTTP MCP real, nao apenas em hooks ou IPC renderer.
3. **Remote bridge audit:** confirmar que WSS local/network, pairing, tokens, pane input e close/resize sao auditaveis e adequados para release publico.
4. **Media/vision privacy audit conjunto:** consolidar regras para imagem local, screenshot, OCR, AX tree, retention, logs e envio a provedores cloud.
5. **Hot-zone release audit:** `wake-mic.ts`, `pcm-processor.js`, `wake-rearm*`, `voice-logger*`, `wake-health*` devem estar sem diff nao revisado no commit final; smoke de mic deve rodar no app empacotado.

## 4. Checklist GO/NO-GO por fase

### Gate comum para qualquer fase

- [ ] Worktree da fase limpo antes do merge (`git status --short` sem modificacoes nao commitadas).
- [ ] Branch rebased/merged sobre o `main` correto, preservando metadata hotfix `0.10.6` ou uma versao seguinte decidida explicitamente.
- [ ] `npm ci`, `npm run typecheck`, `npm test` passam no branch final da fase.
- [ ] `git diff --check main...HEAD` limpo.
- [ ] Nenhum arquivo de zona quente foi alterado sem review explicito.
- [ ] Review senior atualizado ou addendum documenta os fixes para cada BLOCKER/CRITICAL/HIGH.

### F3 - GO/NO-GO

GO somente se:

- [ ] BLOCKER wake mic fechado: constraints raw `echoCancellation:false`, `noiseSuppression:false`, `autoGainControl:false`, instrumentacao de device/RMS restaurada e teste de constraints presente.
- [ ] BLOCKER metadata fechado: package, lock, changelog e release notes nao regrediram `0.10.6`.
- [ ] BLOCKER realtime actions fechado pela opcao A: `REALTIME_ACTION_BRIDGE_ENABLED=false`, realtime so audio, actions continuam batch/classic ate F4; UI/copy nao promete action-capable realtime.
- [ ] HIGH VAD/manual turn fechado: uma unica politica de turno, sem corrida server VAD + manual commit.
- [ ] HIGH close/reconnect fechado: provider close pos-ready derruba estado live, limpa buffers e aciona reconnect/fallback.
- [ ] HIGH transcript fechado: limite, rotacao, retencao e consolidacao de deltas testados.
- [ ] HIGH Gemini timer fechado: timers stale cancelados por teardown/novo connect e token de geracao testado.
- [ ] Testes especificos passam: realtime provider/controller fallback, wake constraints, transcript rotation, Gemini stale reconnect, metrics/lifecycle.

NO-GO se a rota realtime disser ao usuario que executa tools reais antes de F4 provar esse caminho.

### F4 - GO/NO-GO

GO somente se:

- [ ] BLOCKER HTTP MCP bypass fechado: guardrails, permission, confirmation e audit rodam no wrapper server-side comum usado por IPC renderer e MCP HTTP.
- [ ] BLOCKER renderer self-confirm fechado: renderer nao concede permissao; confirmacao high-risk e dialog/main-mediated, single-use, TTL curto, vinculada a args canonicos, workspace, WebContents e turno.
- [ ] BLOCKER symlink fechado: workspace root e targets usam `realpath`; writes para paths novos validam o pai existente; cwd de terminal/git nao escapa.
- [ ] BLOCKER git push fechado: remote/branch/refspec/pathspec validados; leading dash, `+ref`, `:ref` e options perigosas rejeitadas ou exigem API/confirmacao separada.
- [ ] HIGH permission scope fechado: grants incluem workspace/window/session/mission e expiram automaticamente.
- [ ] HIGH audit fechado: mutating/external tools falham fechadas se audit nao persistir; redaction cobre `text`, command/env secrets e tamanho maximo.
- [ ] HIGH terminal fechado: env allowlist/disclosure, output hard cap streaming/kill, timeout/concurrency/rate limit.
- [ ] HIGH voice bridge fechado ou escopo ajustado: Jarvis actions integradas ao MCP seguro ou release nao promete audit MCP completo para voz.
- [ ] HIGH schema/size fechado: zod/safe stringify/limites de depth, keys, array, string e request size nos boundaries IPC e MCP.
- [ ] Testes negativos existem para HTTP MCP bypass, self-confirm, symlink, git refspec, audit failure, oversized/cyclic args, terminal output/env e cross-workspace grants.

NO-GO se qualquer tool mutante (`terminal_run`, file/editor writes, git mutante) puder ser chamada por agente HTTP MCP sem confirmacao/audit server-side.

### F5 - GO/NO-GO

GO somente se:

- [ ] CRITICAL raw screenshot fechado: `vision:captured` emite somente metadata; `vision.capture()` removida da API publica ou exige consent token main-owned; `context({ allowCloudImage:false })` nao vaza `imageBase64` por retorno, evento ou cache acessivel.
- [ ] CRITICAL janela errada fechado: captura falha fechada sem match positivo da BrowserWindow Nexus; sem fallback para "qualquer janela".
- [ ] HIGH rate limiter fechado: `tryAcquire()` atomico antes de `await`, falhas consomem limite ou entram em singleflight.
- [ ] HIGH OCR fechado: valida base64/PNG, limite de bytes, timeout/cancelamento e `terminate()` garantido.
- [ ] MEDIUM AX fechado ou aceito: filtros para password/OTP/secret-like, live/status/log com politica dedicada.
- [ ] MEDIUM erro AX fechado: classificacao de permission-denied preservada com `cause`/name.
- [ ] MEDIUM retention fechado: screenshot bruto sem cache publico ou com TTL curto e clear.
- [ ] Entitlement `NSScreenCaptureUsageDescription` validado no app empacotado e prompt macOS testado.
- [ ] Testes IPC cobrem consentimento, raw event metadata-only, window mismatch, concurrency, OCR timeout/payload e AX sensitive fields.

NO-GO se qualquer renderer puder obter screenshot raw sem consentimento explicito confiavel.

## 5. Smoke test empacotado pos-merge

O smoke existente em HEAD (`--smoke-test`) valida boot/renderer load. Ele deve continuar, mas nao cobre Jarvis. Roteiro minimo pos-merge:

### Preparacao

1. Criar branch de integracao limpo: merge F3, depois F4, depois F5; resolver conflitos manualmente.
2. Rodar:

```bash
npm ci
npm run typecheck
npm test
npm run make
APP="$(find /Users/cleofasrocha/dev/nexus-ide/out -path '*/NexusIDE.app' -type d | head -1)"
NEXUS_USER_DATA_DIR="$(mktemp -d)" "$APP/Contents/MacOS/NexusIDE" --smoke-test
codesign -dv --verbose=4 "$APP"
spctl -a -vv "$APP"
```

3. Para o smoke funcional interativo, usar maquina/usuario de QA ou workspace descartavel. O `NEXUS_USER_DATA_DIR` em app empacotado hoje so vale para `--smoke-test`; se a equipe quiser isolamento completo para smoke interativo, precisa adicionar um modo QA explicito antes do release.

### Roteiro funcional minimo

| Passo | Acao | Esperado |
|---:|---|---|
| 1 | Abrir o `.app` empacotado e confirmar que a UI carrega sem crash. | App abre, versao/release notes nao regredidas, logs sem uncaught exception. |
| 2 | Configurar chaves de provider de teste e abrir workspace descartavel com um arquivo contendo `NEXUS_SMOKE_VISION_20260707`. | Settings persistem; workspace visivel. |
| 3 | Habilitar wake/PTT e fazer teste de mic. Se wake estiver habilitado, dizer "Jarvis"; caso contrario usar PTT. | Estado muda para listening; RMS/diagnostico mostram audio nao nulo; nenhum reset de wake. |
| 4 | Dizer: "Jarvis, voce me ouviu? Responda curto." | Realtime audio/transcript aparece; resposta falada inicia; sem resposta duplicada por VAD/manual commit. |
| 5 | Durante TTS, interromper com PTT/wake e dizer: "pare". | Barge-in/interrupt para audio atual; estado volta para listening/thinking corretamente. |
| 6 | Dizer: "Abra um terminal e rode `pwd`." | Native confirmation aparece com comando, cwd e risco; se negar, nada e escrito/executado e audit denied existe; ao aceitar, comando roda no terminal certo. |
| 7 | Dizer: "Com minha permissao, capture apenas a janela Nexus e leia o texto visivel." | macOS Screen Recording e solicitado se necessario; indicador de vision aparece; captura falha se janela Nexus nao for identificada; OCR/AX encontra `NEXUS_SMOKE_VISION_20260707`. |
| 8 | Repetir Vision sem consentimento cloud/raw. | Nenhum `imageBase64` aparece no retorno/evento/log/audit; renderer recebe metadata ou contexto redigido. |
| 9 | Fechar/reabrir app empacotado. | Sem crash; permissoes/estado recuperam; nenhuma sessao realtime fica presa. |

Pass/fail obrigatorio:

- **PASS**: boot smoke 0, typecheck/test 0, wake/PTT -> realtime audio, tool confirm native funciona nos caminhos deny/allow, vision captura somente Nexus com consentimento, sem raw leak quando consentimento falso.
- **FAIL**: qualquer crash, metadata regressiva, tool mutante sem confirmacao/audit, screenshot raw sem consentimento, captura de janela errada, ou estado live "ready" apos provider desconectado.

## 6. v1.0.0 vs v0.11

Parecer: **nao cortar `v1.0.0` imediatamente apos os merges**. O volume de seguranca encontrado justifica um trem intermediario: `v0.11.0` ou `v1.0.0-rc.1`.

Justificativa:

- Foram encontrados 9 BLOCKER/CRITICAL entre F3/F4/F5 nos reviews originais.
- Os problemas nao sao cosmeticos; sao fronteiras de seguranca: execucao de shell/git/files, renderer self-confirm, symlink escape, screen capture raw, janela errada, OCR unbounded.
- Mesmo assumindo fixes bem-sucedidos, o risco residual e integracao cruzada: `preload`, `NexusApi`, MCP HTTP, voice actions, vision consent e packaging.
- A matriz F6 torna `v1.0.0` viavel se o posicionamento for "AI IDE com Jarvis in-app", mas isso pressupoe smoke empacotado e zero bloqueadores abertos.

Recomendacao operacional:

1. Mergear F3/F4/F5 atras de gates objetivos.
2. Publicar `v0.11.0` interno/beta ou `v1.0.0-rc.1` com release notes francas.
3. Rodar smoke empacotado em app assinado/notarizado, incluindo permissoes macOS.
4. So promover para `v1.0.0` apos uma janela curta sem CRITICAL/HIGH regressivo e com evidencia de audit/consentimento.

Se o negocio exigir `v1.0.0` agora, o escopo de marketing deve ser reduzido: "Jarvis in Nexus com voz, MCP e Vision sob consentimento", nao "assistente universal", nao "benchmark de ditado replacement", e nao "realtime tool-use" sem prova F3+F4.

## 7. Top 5 riscos residuais pos-fix

Assumindo que os fixes dos reviews sejam implementados e os testes passem:

| Rank | Risco residual | Probabilidade | Impacto | Motivo | Mitigacao minima |
|---:|---|---|---|---|---|
| 1 | Enforcement de actions continuar inconsistente entre voice, renderer IPC e MCP HTTP | Media/Alta | Critico | F3/F4 ja mostram caminhos paralelos; e facil corrigir um funnel e esquecer outro. | Um dispatcher unico server-side para tools mutantes, com audit/confirm em todos os entrypoints. |
| 2 | Superficie `preload` crescer e reabrir bypass por renderer | Alta | Alto/Critico | As tres fases adicionam APIs no mesmo objeto `window.nexus`. | Capability audit de `NexusApi`, testes de "compromised renderer cannot..." e reducao de APIs raw. |
| 3 | Privacidade de vision/media/transcripts vazar por edge case | Media | Critico | Dados sensiveis agora incluem audio, transcript, AX tree, screenshot, imagem local e OCR. | Politica unica no-store/redaction/consent token + testes que buscam `imageBase64`/secrets em eventos/logs/audit. |
| 4 | App empacotado divergir de dev por entitlements, permissoes ou working tree sujo | Media/Alta | Alto | Ja ha dirty metadata no `main`, e F5 depende de Screen Recording macOS. | Release so de commit limpo; smoke no `.app` assinado/notarizado; checagem de versao/package/release notes. |
| 5 | Realtime/wake regressar em hardware real | Media | Alto | Zona quente continua sensivel e outra LLM estava editando arquivos relacionados. | Teste empacotado com mic real, constraints snapshot, watchdog/reconnect metrics e freeze da zona quente antes da tag. |

## Conclusao

O plano sequencial e defensavel, mas nao esta pronto para release final no estado observado. A ordem F3 -> F4 -> F5 deve ser mantida porque minimiza risco de acoplar Vision a actions antes do funil de seguranca e preserva os fixes de voz/versionamento primeiro.

O gate real para `v1.0.0` nao e "os merges aplicam sem conflito". O gate e: nenhum BLOCKER/CRITICAL/HIGH aberto, branch final limpo, metadata correta, MCP/tool-use server-side auditavel, Vision sem raw leak, e smoke empacotado provando wake -> realtime audio -> tool confirm -> vision consent.
