# Auditoria profunda Overclock 1.0.0 vs NexusIDE — v2 (varredura independente)

Data: 2026-07-05. Esta auditoria foi feita do zero (bundle, sidecar compilado, estado local, processos, e código do Nexus no working tree atual) e **confronta** o relatório anterior (`2026-07-05-overclock-1.0.0-benchmark.md`) em vez de assumi-lo. As divergências estão na seção 8.

Nota de concorrência: uma sessão paralela está aplicando 8 correções de segurança no Nexus neste momento (autorização por pane nas tools MCP, confirmação de voz para `run_command`, validação de binPath/extraArgs, ErrorBoundary, syncPanes event-driven, entre outras). As recomendações abaixo marcam com **[já em andamento]** o que essa sessão cobre.

---

## 1. Veredito executivo

O Overclock 1.0.0 é um produto Tauri + sidecar Node (monólito de 300 MB) cuja vantagem real está em **quatro sistemas de maturidade operacional**, não na base técnica:

1. **Voz live full-duplex de verdade** (Gemini Live `gemini-3.1-flash-live-preview` via WebSocket BidiGenerateContent) com engenharia de latência e custo séria: buffer de mic pendente, grace reuse de socket, dormant mode, compressão de janela de contexto, e **memória persistente de fatos** com supersede/soft-delete.
2. **Telemetria real de tokens** lida dos transcripts das CLIs (Claude e Codex), com dedupe por `(session_id, message_id)`, persistida em SQLite, com preço por tier de cache — contra a nossa heurística de bytes em memória volátil.
3. **Durabilidade de sessão barata e eficaz**: eles NÃO serializam o buffer do terminal; capturam o **session id real do provider** a partir do transcript (com nível de confiança), persistem metadados por pane + ~30 `lastLines`, autosave de 30s, high-water de pane id, hibernate/wake e recovery de tmux órfão.
4. **Confiabilidade de orquestração**: watchdog de stall (scan 30s, handoff sintético após silêncio prolongado), deny-gate de delegação invisível (`Workflow` bloqueado para chefes), depth-caps, status ricos de handoff (`stalled`, `awaiting_clarification`), clarify broadcast.

O Nexus **não deve trocar a base** — e agora tem mais um motivo: o PTY host isolado em `utilityProcess` (working tree atual) dá ao Nexus isolamento de crash que o sidecar monolítico do Overclock não tem. O Nexus é claramente superior em postura de segurança de segredos (Keychain/safeStorage, nunca-plaintext, env allowlist, zod nas bordas, bearer por sessão no MCP), em enforcement de handoff server-side (hard gate, não só hooks), em roteamento econômico por modelo e em resiliência de voz offline (wake ONNX local keyless, cadeias de fallback STT/TTS).

**Em uma frase:** o Overclock ganha em continuidade (de sessão, de voz, de dados de custo); o Nexus ganha em fundação (segurança, enforcement, isolamento, fallback). Copiar os padrões de continuidade sobre a nossa fundação nos coloca à frente em uso real.

---

## 2. Tabela comparativa

| Área | Melhor | Justificativa (evidência) |
|---|---|---|
| Voz live/full-duplex | **Overclock** | Gemini Live WSS bidi, barge-in nativo (`interrupted` do servidor), dormant/grace reuse, pendingMic 160 KB (`GeminiLiveSession.js`) |
| Memória de voz | **Overclock** | `JarvisMemory` SQLite, 1 fato = 1 key slug, supersede chain, soft-delete; Nexus: array em memória de 4 min por janela (`voice-controller.ts:51`) |
| Echo suppression | **Overclock** | Matching por transcript (`isEchoOf`, janela 300 chars, ≥80% palavras) — e é copiável sem capturar áudio do sistema; Nexus só tem AEC do browser + filtro de fantasmas do Whisper |
| Sanitização de fala | Empate | Ambos têm (`voiceSafeText` ↔ `speakable.ts`); Overclock aplica em todo texto injetado na voz, incl. wake messages com linha `human`/`technical` separadas |
| Voz offline/fallback/wake | **Nexus** | Wake ONNX local keyless (openWakeWord), STT Groq→OpenAI→whisper.cpp, TTS OpenAI→Piper→`say`; Overclock é OAuth Claude + Gemini Live (nuvem-dependente) |
| Confirmação de ação por voz | Nexus (após item 4) | Overclock tem a infra (`confirmBeforeTools`) mas **default false e UI removida**; Nexus está implementando confirmação obrigatória na sessão paralela |
| Telemetria de tokens/custo | **Overclock** | Transcript watchers + SQLite `token_usage` dedupado + cache tiers 5m/1h; Nexus: estimativa por bytes, input = output×3, só em memória (`cost-tracker.ts`) |
| Durabilidade de sessão | **Overclock** | Session id real capturado com `confidence`, autosave 30s, pane-seq high-water, hibernate/wake, tmux recovery; Nexus restaura layout + `--resume` genérico |
| Enforcement de handoff | **Nexus** | Stop-gate **server-side** (`evaluateStop`) + hooks client-side + rejeição de summary placeholder; Overclock só hooks client-side |
| Watchdog de stall | **Overclock** | Scan 30s + handoff sintético; Nexus não tem nada |
| Bloqueio de delegação invisível | **Overclock** | `--disallowedTools Task` no spawn (observado em processo vivo) + `writeWorkflowDenyGate` + depth-caps (`leaf` não sobe orquestrador); Nexus depende só de allowlist |
| Gate de comando perigoso | **Overclock** (por ora) | `writeDangerousCommandGate` opt-in com allowlist e modo warn/block; Nexus **[já em andamento]** na sessão paralela |
| Segurança de segredos | **Nexus** | Keychain/safeStorage, nunca-plaintext, arquivos 0600; Overclock: `providers.json` **plaintext admitido em v1**, `session.json` com tokens de auth em **0644** |
| Validação IPC | **Nexus** | zod em todas as bordas; WsHost do Overclock é adapter genérico sobre WSS com token |
| Isolamento de processo | **Nexus** (working tree) | PTY host em `utilityProcess` com re-fork pós-crash; sidecar Overclock é monólito Node único |
| Roteamento econômico | **Nexus** | `nexus_route_task` escolhe o adapter mais barato instalado por tier + `reserveClaude`; Overclock não roteia por custo |
| Superfície de terminal/canvas | **Nexus** | xterm persistente com DOM reparenting, canvas infinito, split grid; Overclock guarda 20 linhas de tail e re-renderiza |
| Harness/playbooks/recipes | **Overclock** | Recipe lint contra catálogo com `gap` explícito, overlay de categorização, stacks, agent spec writer, MCP inject p/ codex/gemini/antigravity |
| UX de prompt do orquestrador | **Overclock** | Playbooks com regra "speak human" (tabela de tradução de jargão interno → fala natural PT) — barato de copiar |
| Remote bridge / phone client | **Overclock** | WSS TLS self-signed, código de 6 dígitos rotativo 5 min, token 32 B com hash SHA-256 + `timingSafeEqual`, expiração 30 dias, rate-limit por IP; Nexus não tem |
| Browser pane / preview server | **Overclock** | `kind:'browser'` + `startPreviewServer(dir)`; Nexus não tem (`webviewTag:false`) |
| Updater/deep link/doc handlers/notarização | **Overclock** | `overclock://`, handlers md/txt/json/ts/js/yaml, Developer ID + ticket stapled; Nexus não tem nenhum |
| Onboarding de CLIs | **Overclock** | `cli:install/login/loginStatus/loginWatch` para 7 CLIs; Nexus só LaunchScreen |
| MCP local auth | **Nexus** | Bearer por sessão de agente; MCP SSE do Overclock em `127.0.0.1:51737` com URL sem token aparente (**incerto** — pode haver auth em header) |
| Buffer serializado em disco | Empate (nenhum) | Overclock expõe `pty:readSerialized` mas persiste só `lastLines`; Nexus carrega `SerializeAddon` e nunca chama `.serialize()` |

---

## 3. Avaliação específica do Voice/Jarvis

**Confirmado: o Jarvis deles está hoje melhor que o nosso em conversa contínua — mas por razões específicas e replicáveis, e com fraquezas claras.**

### Arquitetura deles (duas camadas)

- **Camada de voz** = `GeminiLiveSession` (Gemini Live, `models/gemini-3.1-flash-live-preview`, WSS BidiGenerateContent, PCM 16 kHz in, áudio out, `languageCode: 'pt-BR'`, `temperature: 0.3` para estabilizar prosódia). Ela tem 8 tools "grossas" (`delegar`, `consultar`, `ler`, `navegar`, `encerrar`, `comandar`, `restaurar`, `perguntar`), das quais **só `delegar` passa pelo cérebro LLM** — as demais respondem direto do estado do app (fast-path sem LLM = latência percebida baixíssima).
- **Camada cérebro** = `JarvisService` sobre `@anthropic-ai/claude-agent-sdk` (OAuth do `~/.claude`, sem API key), com 10 tools MCP in-process.

### O que os torna bons (e o custo de cada ideia)

| Técnica | O que faz | Custo de copiar |
|---|---|---|
| `pendingMic` (160 KB) | Instância criada sincronamente; primeira frase bufferizada até `setupComplete` — nada se perde na conexão | Baixo |
| Grace reuse (90 s) | `stopLive()` mantém o socket quente; re-toggle rápido reusa a MESMA conexão (voz não muda de timbre) | Médio |
| Dormant mode (5 min idle) | Sessão fecha de verdade (billing zera) mas o modo fica armado; próxima fala religa transparente (~1 s) | Médio |
| `contextWindowCompression: slidingWindow` | Sem isso, sessão de horas chegou a ~12,9 M tokens/noite (94% da fatura) — comentário deles | Trivial (1 campo) |
| Echo por transcript (`isEchoOf`) | Janela de 300 chars do que o TTS falou, normalizada; input que é substring ou ≥80% de palavras → descartado | **Baixo — não precisa capturar áudio do sistema** |
| Contexto de tela debounced (1,5 s) | Renderer manda tela/panes/missão coalescido para não gerar N turnos rebillados | Baixo |
| `JarvisMemory` | SQLite, key slug estável, supersede sem duplicar, soft-delete ressuscitável, bloco de fatos injetado no prompt | Baixo-médio |
| Narração proativa | Polls de perguntas/handoffs dos panes (8 s / 1,5 s) com TTL e dedupe — o Jarvis avisa quando um worker pergunta algo | Médio |
| Disjuntores | `SETUP_TIMEOUT_MS` 10 s, `TURN_MAX_MS` 15 s, budget de 600 k tokens, `maxReconnectAttempts` 3, singleton anti-"duas vozes" | Baixo |

### Fraquezas deles

1. **Nuvem-only**: sem Gemini + sem OAuth Claude, o Jarvis deles morre. O nosso funciona com `say` + whisper.cpp em um Mac sem nenhuma chave.
2. **Confirmação de tool desativada por default e UI removida** — `comandar` digita Enter num pane vivo sem confirmação. Nosso item 4 (sessão paralela) nos coloca à frente em segurança de voz.
3. **Wake word**: dependem do orb/mic contínuo do app; nosso "Hey Jarvis" ONNX local é melhor UX de mãos livres.
4. O `Info.plist` pede permissão de captura de áudio do sistema para eco, mas o sidecar faz eco por transcript — ou a captura vive no shell Tauri, ou é permissão pedida além do necessário.

### Estratégia recomendada (mantém o veredito do relatório anterior, agora com espec concreta)

`Jarvis Classic` (atual) + `Jarvis Live` opcional. Mas o caminho mais barato para fechar 70% do gap **não é** montar a stack live primeiro — é portar para o Classic: memória persistente, echo por transcript, fast-path de tools sem LLM, narração proativa de handoffs e os disjuntores. Tudo isso é independente de protocolo live. Critérios de aceite do relatório anterior permanecem válidos (barge-in < 200 ms, 1ª resposta < 800 ms quente, código nunca falado, fallback sem perder intenção).

---

## 4. O que implementar no Nexus (P0/P1/P2)

### P0 — agora

1. **[já em andamento — sessão paralela]** Confirmação de voz para `run_command`/`send_to_pane`; autorização por missão/owner/role nas tools MCP de pane; validação de binPath/extraArgs; ErrorBoundary; syncPanes event-driven. *Não duplicar.*
2. **Telemetria real de tokens** (`usage-real-telemetry`): watcher do transcript Claude (`~/.claude/projects/<slug>/*.jsonl`, campo `usage` por turno do assistant) e Codex (`~/.codex/sessions/…/rollout-*.jsonl`, `last_token_usage` — usar o LAST, não o total). Ditar `--session-id` no spawn (como já fazemos com resume flags) para atribuição determinística ao pane. SQLite `token_usage` com UNIQUE `(session_id, message_id)` e upsert last-wins (o CLI regrava a mesma mensagem por content block). Preços com cache tiers 5m/1h. UI marca `real | estimated | mixed`; manter `cost-tracker` como fallback. **Persistir em disco** — hoje tudo morre com o app.
3. **Sessões duráveis v1 — desenho corrigido** (ver seção 8, discordância #1): capturar session id real do provider a partir do transcript com `confidence` (`source: 'transcript-file'`), persistir por pane: adapter, model, effort, cwd, role, agentName, missionId, args, env controlado, `permissionMode`, + `lastLines` (~30) para preencher o terminal no restore. Autosave 30 s + save em create/close/before-quit. Pane-seq high-water persistido (`{seq}` que só sobe). `SerializeAddon.serialize()` fica para v2 se ainda fizer sentido.
4. **Watchdog de stall**: scan de 30 s; worker com `requireHandoff` sem output por N min (10–20) → handoff sintético `stalled` acordando o orquestrador via idle-delivery existente. Adicionar status `stalled` e `awaiting_clarification` ao handoff + broadcast de clarify para a UI.
5. **Bloqueio explícito de subagente invisível**: spawn de worker Claude com `--disallowedTools Task` (é literalmente um argv a mais no adapter) + equivalentes nos demais CLIs quando houver flag.

### P1 — próxima camada

6. **Jarvis Classic upgrades** (pré-requisito do Live, valor imediato): `JarvisMemory` persistente (SQLite: key slug, supersede, soft-delete, bloco de fatos no prompt com cap de chars); echo suppression por transcript (`isEchoOf` sobre o que nosso TTS falou); fast-path de intents que não precisam de LLM (listar panes/missões/squads → responder direto); narração proativa de handoff/pergunta de worker; disjuntor de turno (15 s) e budget.
7. **Jarvis Live v1** (opcional, sobre o Classic): sessão full-duplex (Gemini Live ou OpenAI Realtime — decidir por custo/idioma), com as alavancas obrigatórias de custo/latência da tabela da seção 3 (sliding window, dormant, grace reuse, pendingMic, singleton). IPC: `voice:live:start/stop/mic/endTurn` + eventos `live_state/live_transcript/tool_call/interrupted`.
8. **Browser/preview pane**: pane `kind:'browser'` + `startPreviewServer(dir)` estático + tools `nexus_browser_open/navigate`, `nexus_preview_start`.
9. **Playbooks/harness**: recipe lint contra catálogo com `gap` explícito (rejeitar nome inexistente sem gap declarado); overlay de categorização por workspace; "speak human" nos `orchestratorInstructions` dos squads builtin (custo ~zero, ganho de UX imediato); agent spec writer (editar frontmatter tools/model/effort).
10. **Hibernate/wake de pane** + `perf:snapshot` (congelar workers antigos mantendo config+buffer para liberar memória).

### P2 — acabamento

11. **Remote bridge** copiando o desenho de segurança deles (código 6 dígitos rotativo 5 min → token 32 B, armazenar só hash SHA-256, `timingSafeEqual`, expiração, rate-limit por IP, TLS self-signed, **única rota de escrita = pane input**) — e melhorando: exigir confirmação no Mac para spawn remoto.
12. **Updater + deep link `nexus://` + document handlers + notarização stapled.**
13. **Onboarding de CLIs** (`cli:install/login/loginWatch` para os CLIs suportados) com checklist de vitórias persistente.
14. **Discord Rich Presence opt-in** (o deles mostra só "Using overclock.sh" — sem vazar projeto; se fizermos, copiar essa contenção).

---

## 5. O que NÃO copiar

1. **Migração para Tauri** — nosso PTY host isolado + Electron endurecido entrega o benefício de robustez sem reescrever a base.
2. **Sidecar monolítico** — um processo Node com voz+PTY+bridge+telemetria é um single point of failure; nossa direção (utilityProcess por domínio) é melhor.
3. **Plaintext para provider keys** (`providers.json` v1 deles) e **degradar keystore para plaintext sem master key** — manter nossa regra "sem Keychain, não persiste".
4. **`session.json` de auth com 0644** — qualquer arquivo com token nosso continua 0600.
5. **Confirmação de tool default OFF / UI de confirmação removida** — fazer o oposto (default ON para ações que escrevem em pane/shell).
6. **Live-only voice** — manter fallback keyless como identidade do produto.
7. **Leaderboard/telemetria compartilhada por default** — deles já é opt-out (`shareTokens:false`), o nosso, se existir, nasce opt-in.
8. **Poluir o workspace com squads de fábrica** — catálogo instalável, HomeDeck limpo.
9. **MCP SSE local sem bearer aparente** — manter nosso token por sessão.

---

## 6. Riscos técnicos e de segurança

**Do Overclock (contexto competitivo, sem expor valores):**
- `~/.overclock-app/session.json` contém accessToken/refreshToken de auth **em plaintext com permissão 0644** (world-readable). Risco alto local.
- `providers.json` (keys de provider) em plaintext admitido no 1.0.0; `service-keys.json` de mídia é AES-GCM com master key via stdin do shell Tauri (bom), mas degrada para plaintext sem a master key.
- MCP SSE em `127.0.0.1:51737` com URLs de config sem token visível (`missionId`/`callerPaneId` na query) — se não houver auth em header, qualquer processo local pode dirigir as tools. Não confirmado (incerto).
- `keystore.key` e `tls.json` corretamente 0600; tokens do remote bridge corretamente armazenados como hash SHA-256 com `timingSafeEqual` e expiração.

**Para o Nexus ao adotar as ideias:**
- **Jarvis Live**: custo é o risco nº 1 — a própria evidência deles registra ~12,9 M tokens/noite sem compressão de contexto. Sliding window + dormant + budget são pré-requisitos de lançamento, não polish.
- **Transcript watchers**: leem diretórios de outra ferramenta (`~/.claude`, `~/.codex`) — formatos mudam sem aviso; parsear com tolerância, nunca crashar o main por linha malformada, e tratar offsets por bytes com serialização de ingest por arquivo.
- **Remote bridge**: é a maior superfície nova de ataque do roadmap; adotar o desenho deles como piso (hash+expiry+rate-limit) e adicionar confirmação no host para spawn.
- **Deep link/document handlers**: validação estrita de URL/caminho antes de abrir (vetor clássico de RCE em Electron).
- **Watchdog de stall**: cuidado com falso positivo em tarefas longas legítimas (builds); o handoff sintético deve ser informativo (`no output > N min`), nunca matar o worker.

---

## 7. Evidências locais usadas (sem segredos)

**Overclock:**
- Bundle: `/Applications/Overclock.app/Contents/Info.plist` (URL scheme `overclock://`, doc handlers, usage descriptions de mic/áudio em PT-BR); `codesign`/`spctl` (Developer ID Guilherme Laschuk T4BPBR7L76, notarização stapled, arm64).
- Sidecar: `/Applications/Overclock.app/Contents/Resources/sidecar/dist/*.{js,d.ts}` — em especial `GeminiLiveSession`, `JarvisService`, `JarvisMemory`, `jarvisLivePrompt`, `voiceSafeText`, `JarvisWakeLock`, `WsHost`, `core.js`, `ClaudeTranscriptWatcher`, `CodexTranscriptWatcher`, `db`, `spawnHelpers`, `squadPersistFields`, `handoffWakeMessage`, `clarifyBroadcast`, `navigateResolver`, `catalogStore`, `harnessAssistant`, `agentSpecWriter`, `mcpCliInject`, `remoteBridge`, `remoteSpawn`, `previewServer`, `wireOnboarding`, `discordRichPresence`; `sidecar/package.json` (Agent SDK, ws, selfsigned, discord-rpc).
- Templates: `Contents/Resources/resources/{squad-former,qa-swarm,qa-vision,cinema,cinema-site,absurd-landing}/PLAYBOOK.md` + `agents/`.
- Estado local: `~/.overclock-app/{config,missions,workspaces,pane-seq,mcp-config.sidecar,mcp-pane-pane-5}.json`, `messages.db` (schema `catalog_items`), permissões de `session.json`/`keystore.key`/`remote-bridge/tls.json`; `~/Overclock/Meu Primeiro Projeto/.overclock-app/{panes,session}.json` (estrutura, valores redigidos), `messages.db` (schema `token_usage`, `activity_log_v2`).
- Processos vivos: `overclock` → `node sidecar/dist/index.js --token=<redigido>` → `claude --session-id … --permission-mode auto --mcp-config … --disallowedTools Task --allowedTools …`.

**Nexus (repo em `fea2685` + working tree):**
- `src/main/voice/{wake-engine,stt-service,tts-service,jarvis-brain,speakable,voice-ipc,voice-config-store,voice-secrets}.ts`, `src/renderer/voice/{voice-controller,voice-capture,wake-mic}.ts`
- `src/main/orch/{mcp-server,tools,tools-panes,tools-domain,gate,hooks-gen,task-router,idle-delivery,mission-store,squad-store,catalog}.ts`
- `src/main/pty/{pty-manager,pty-ipc}.ts` + novos `pty-host-{core,client,entry}.ts`
- `src/main/cost-tracker.ts`, `pricing.ts`, `secrets-store.ts`, `layout-store.ts`
- `src/renderer/{App.tsx,terminal/terminal-host.ts,state/layout-store.ts}`
- `docs/{ARCHITECTURE.md,voice.md,workspace-and-settings.md}`, `README.md`, `PRODUCT.md`

---

## 8. Onde esta auditoria discorda do relatório anterior

1. **"Sessões duráveis = buffers serializados" — superdimensionado.** O relatório anterior lista `serialized buffers` como ponto forte do Overclock e põe `SerializeAddon` no P0. Em disco, o Overclock persiste **apenas ~23–30 `lastLines` por pane**; a continuidade real vem do **session id do provider capturado do transcript** (`confidence: high`, `source: transcript-file`) + `--resume`. `pty:readSerialized` existe para o remote bridge ler scrollback **vivo**, não para persistência. Consequência prática: nosso P0 de durabilidade fica mais barato — session-id capture + metadados + lastLines; serialização integral vira v2 opcional. (Curiosidade: nosso `terminal-host.ts` já carrega `SerializeAddon` sem nunca chamar `.serialize()` — resto de uma tentativa abandonada.)
2. **Echo suppression era tratada como mágica de áudio — é matching de texto.** O `Info.plist` pede captura de áudio do sistema, mas o sidecar implementa eco por **transcript matching** (`isEchoOf`: janela normalizada de 300 chars, substring ou ≥80% de palavras). Implicação: dá para portar para o Jarvis Classic em um dia, sem tocar em CoreAudio.
3. **"Tool confirmation opcional antes de ações" listada como força deles — na prática está desligada.** `confirmBeforeTools` default `false` e a UI de confirmação foi **removida**. Com o item 4 da sessão paralela, o Nexus fica na frente nesse quesito, não atrás.
4. **Segurança do provider store deles é pior do que "pendência de criptografia".** `providers.json` é plaintext admitido em comentário ("keystone fase posterior"), o keystore degrada para plaintext sem master key, e `session.json` de auth está 0644. A vantagem do Nexus aqui é maior do que o relatório anterior descreve.
5. **Ordem de implementação mudou por causa da sessão paralela.** O anterior recomendava `orchestration-gates-v2` primeiro; gates + confirmação de voz + autorização de pane **já estão sendo feitos agora**. A próxima frente vira telemetria real + sessões duráveis (com o desenho corrigido do item 1).
6. **Voz "provavelmente melhor" → confirmado e quantificado.** Agora sabemos o stack (Gemini Live 3.1 flash preview), os números (setup 10 s, turn cap 15 s, grace 90 s, dormant 5 min, budget 600 k) e o custo real de operar sem compressão (~12,9 M tokens/noite). Também sabemos o que o relatório anterior não viu: **fast-path de tools sem LLM** (`consultar/ler/navegar` respondem direto do estado) — provavelmente a maior contribuição individual para a latência percebida deles.
7. **Watchdog: números concretos.** Scan de 30 s e threshold de 10–20 min com handoff sintético — o anterior citava o conceito sem parâmetros.
8. **Contagem de tools**: são 25, não 24 (docs/comentários corrigidos nesta auditoria).
9. **Um ponto a favor do Nexus que o anterior não tinha como saber:** o PTY host em `utilityProcess` (working tree) inverte a comparação de robustez de processo — o Overclock roda tudo num sidecar único; nós isolamos o addon nativo mais instável.

---

## 9. Ordem recomendada de implementação

1. **Terminar e mergear o que está em voo** — PTY host isolado + as 8 correções de segurança da sessão paralela (elas cobrem o antigo `orchestration-gates-v2` parcial + confirmação de voz).
2. **`usage-real-telemetry`** — transcript watchers + SQLite persistido + `--session-id` ditado no spawn (esse session-id ditado é também o alicerce do item 3).
3. **`durable-sessions` (desenho v2)** — session-id capture com confidence, metadados por pane, lastLines, autosave 30 s, pane-seq high-water.
4. **`orchestration-reliability`** — watchdog de stall + status `stalled`/`awaiting_clarification` + clarify broadcast + `--disallowedTools Task` nos spawns.
5. **`jarvis-classic-upgrades`** — memória persistente, echo por transcript, fast-path sem LLM, narração proativa, disjuntores. (Independe de stack live e melhora o produto imediatamente.)
6. **`jarvis-live`** — full-duplex opcional com as alavancas de custo/latência como requisito de lançamento.
7. **`browser-preview-pane`**.
8. **`playbooks-harness`** — recipe lint com gaps, overlay, "speak human" nos builtin squads, agent spec writer.
9. **`hibernate-perf`**.
10. **`remote-bridge`** (com confirmação no host).
11. **`native-product-polish`** — updater, `nexus://`, document handlers, notarização, onboarding de CLIs, Rich Presence opt-in.

Racional da ordem: 2→3 compartilham o mesmo alicerce técnico (session-id ditado + watcher de transcript); 4 e 5 são as duas maiores alavancas de confiança percebida (orquestração que não trava em silêncio; Jarvis que lembra e não se auto-escuta); 6+ são diferenciais que só valem sobre uma base que não perde sessão nem mente sobre custo.
