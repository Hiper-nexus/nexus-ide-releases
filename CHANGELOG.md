# Changelog

## 0.13.0 — Em desenvolvimento

Data: a definir

- Harvest ORCA de confiabilidade de terminal: circuit breaker de renderer,
  protocolo binário de stream, scheduler de output com backpressure e
  worktree removal safety com provenance Nexus (MIT, pin 143c36e).
- Estabilização dos testes de merge queue (coordenação por sinal) e
  diagnóstico rico no doctor.
- Migrations do servidor endurecidas: timestamptz em cron_schedules e reaper
  de soft-delete (30 dias).

## 0.12.0 — Contexto verificável e runtime seguro por projeto

Data: 2026-07-10

Esta versão transforma o Nexus em um ambiente orientado a contexto verificável:
agentes recebem o modelo do projeto antes de codar, efeitos ficam vinculados à
revisão de contexto e a conclusão depende de evidência independente. O runtime
e os dados passam a ser isolados por projeto/checkout, com diagnóstico de
prontidão e fundação explícita para operação em múltiplos computadores.

### Melhorias

- Live Design no browser pane: seleção visual com contexto DOM/framework,
  candidatos `arquivo:linha`, screenshot, envio ao agente de missão, preview
  otimista de estilos, detecção de dev server, breakpoints e clonagem de
  referências externas.
- O motor de write-back visual determinístico inclui edição byte-cirúrgica,
  CSS→Tailwind, undo/redo por hash, journal de recuperação, CAS e cleanup dos
  IDs efêmeros. Na distribuição 0.12 ele permanece fail-closed desativado;
  seleção, preview e envio ao agente continuam disponíveis. A ativação direta
  fica reservada a desenvolvimento até concluir a validação de produção.
- Harness de contexto nativo com ingestão do repositório, conhecimento do
  domínio, contratos congelados, `contextRevision`, sensores, PREVC,
  attestations e Review Council com autor diferente do revisor.
- Efeitos de agentes vinculados a projeto, checkout, missão e revisão de
  contexto; missões não podem virar `done` por um caminho paralelo sem workflow
  completo, evidência e handoff consistente com o diff atual.
- Runtime SQLite separado por projeto, stores escopados por construção e modo
  seguro somente leitura quando a persistência não pode ser garantida.
- Identidade portátil de projeto v2, registro local de checkout, worktrees
  isolados e merge queue com recuperação de crash e validação antes da fusão.
- Nexus Doctor com relatório estruturado de blockers, warnings e remediação
  para Git, manifesto, SQLite, contexto, sensores, sandbox, providers,
  filesystem e backend multi-PC.
- Cron compartilhado com lease fail-closed e contratos de sync otimista/CAS;
  rotas do control plane e guias de implantação ficam prontas para um backend
  externo, sem transformar ausência de infraestrutura em sucesso silencioso.
- Jarvis Live ganhou ownership por janela e escopo, PTT/wake isolados,
  continuidade correlacionada por turno/tool e descarte de callbacks tardios.
- Visão atual usa AX/OCR limitado e redação unificada de segredos antes de
  prompts, narração e resultados MCP; controles sensíveis não viram alvos.
- Release pipeline reproduzível para macOS arm64/x64 e Linux x64, com smoke do
  pacote real, SBOM, checksums e verificação de nativos. Windows permanece como
  preview assinado enquanto não houver sandbox de produção.
- Artefatos macOS incluem app, DMG e ZIP verificados; app/DMG são assinados,
  notarizados e stapled, e o ZIP é validado pela aplicação notarizada interna.

### Correções

- Eventos sintéticos, replay e gerações antigas do picker não provocam
  write-back; conteúdo de página é podado/redigido e chega ao agente como dado
  não confiável, e bytes de controle de terminal são recusados.
- Operações de Git e filesystem bloqueiam configurações locais perigosas,
  traversal, troca por symlink e drift de descritor entre autorização e uso.
- Stores legados de squads/contas deixam de confirmar escrita quando o banco
  está degradado; falhas de persistência entram em modo seguro explícito.
- O renderer não hidrata estado de projeto antes da autorização do workspace e
  descarta respostas atrasadas depois de troca/fechamento de projeto.
- Handoffs carregam IDs de evidência e identidade do diff; uma alteração de
  `baseSha`, `headSha` ou `diffHash` invalida revisão antiga.
- O diagnóstico Realtime só fica verde após o renderer iniciar o playback do
  PCM correlacionado; ACKs velhos, duplicados ou cancelados são descartados.
- A saída de áudio escolhida é aplicada de forma explícita em Classic e Live;
  dispositivo indisponível gera erro visível, sem fallback silencioso.
- O updater seleciona somente o ZIP Squirrel da arquitetura do Mac e fica
  `unsupported` em Linux/Windows enquanto não existir updater próprio, evitando
  instalar payload `darwin-x64` em outra plataforma.
- Wake/PTT, eventos Live, transcript, memória, conversa, custos e uso deixam de
  atravessar janelas, projetos ou checkouts por estado global.

## 0.11.0 — Voz destravada e delegação segura (Fase 0 do refactor Jarvis)

Data: 2026-07-09

Release de estabilidade e segurança da voz: os três críticos documentados morrem
(mute preso, surdez por TCC fantasma, delegação sem confirmação) e o gate de
missão ganha confirmação por voz com hardening completo.

### Melhorias

- Invariante de mute estrutural: o gate de áudio Live reabre em TODA saída de
  turno (finally token-aware) — fim do silêncio permanente pós-degrade.
- Watchdog de status preso: transcribing/routing/speaking têm saída garantida;
  fala longa (Live ou TTS clássico audível) conta como progresso, sem falso idle.
- Grant TCC fantasma do macOS detectado (rms 0 sustentado com permissão OK) com
  recuperação guiada em 1 clique: `tccutil reset` + relançamento + re-Allow.
- Delegação de código (`send_to_pane`) agora confirma por voz ("Confirmo?") e só
  aceita pane de agente/orquestrador — o fallback silencioso pro pane focado morreu.
- Hardening do gate: matcher de confirmação restrito a respostas curtas, paneId
  validado contra pergunta pendente real (main + renderer, incluindo ask_pane),
  pendência sobrevive re-wake e "sim" seco confirma; re-ask quando o eco engole
  a resposta.
- Observabilidade "duas vozes": identidade da instância no boot e início de cada
  playback local registrados no voice.log para atribuição de áudio duplicado.
- Spec + planos do refactor Jarvis (fases 0-4) versionados em docs/superpowers.

## 0.10.35 — Jarvis Live wake e catálogo de modelos

Data: 2026-07-08

Release de paridade operacional Live: wake mais confiável, um único caminho de voz,
catálogo remoto de modelos e ações de workspace/squad.

### Melhorias

- Reset de sync no wake Live e rebuild forçado de socket zumbi no transporte realtime.
- Caminho Live unificado (Charon) com menos corrida contra o Classic STT/brain/TTS.
- Latência de wake, retenção de mic e coalescer de contexto de tela sem corrida no turno.
- Fluxo de confirmação de squad e ações nativas de workspace na Jarvis.
- Catálogo de modelos com refresh remoto (`NEXUS_MODEL_CATALOG_URL`), grok-4.5 e fable api-only.
- Correção de crash de hooks no MissionWizard.

## 0.10.8 — Jarvis mais operacional

Data: 2026-07-07

Hotfix de paridade operacional: a Jarvis ganhou mais controle nativo do app,
limpeza de sessão MCP por turno, fala em uma única voz por resposta e seleção
explícita do transporte realtime.

### Correcoes

- Novos fast-paths sem LLM para abrir configurações, configurações de voz,
  entrar no modo canvas e voltar para a grade.
- O cérebro agora reconhece essas ações nativas no JSON, então a Jarvis não cai
  em `action:none` quando a LLM decide operar a UI.
- O executor renderer abre os painéis reais e alterna canvas/grade diretamente,
  mantendo os resultados no transcript live/tool result.
- Cada turno da Jarvis limpa a sessão MCP ao fim da ação, evitando permissões e
  confirmações reaproveitadas entre comandos.
- A fala da Jarvis voltou a usar uma chamada TTS por resposta, evitando troca de
  timbre entre primeira frase e resto quando um provedor degrada no meio.
- O painel de voz agora permite escolher OpenAI Realtime ou Gemini Live,
  persiste a escolha imediatamente e mostra a credencial correta no diagnóstico.

## 0.10.7 — Jarvis operacional

Data: 2026-07-07

Hotfix operacional de voz: a Jarvis agora usa realtime como transcript rapido,
mas fala e executa pelo executor auditavel do Nexus; preserva fala colada ao
wake word, limpa eco da saudacao e mantem tratamento "patrao" tambem nos
caminhos rapidos.

### Correcoes

- Live sem voz dupla: o provedor realtime deixa de falar por fora do executor da
  Jarvis. O transcript rapido volta para o brain/action executor unico, evitando
  troca de timbre e respostas que prometem acao sem operar o app.
- Wake/click mais operacional: o pre-roll e congelado antes da saudacao, o clique
  nao herda audio antigo e a janela de escuta fica aberta tempo suficiente para o
  comando chegar sem fechar no "Pois nao, patrao?".
- Transcript live encerra a captura assim que chega final do usuario, entao o
  modo realtime nao precisa esperar todo o timeout/silencio do WAV classico para
  acionar o executor.
- Wake mic com pre-roll curto: comandos como "Hey Jarvis, abrir terminal" nao
  perdem o inicio da ordem enquanto o wake word e a saudacao acontecem; frames
  semeados agora contam como fala real.
- Filtro de wake/ack: prefixos como "Hey Jarvis" e "Pois nao, patrao?" sao
  removidos antes de chegar ao fast-path/brain; ack puro vazado pelo alto-falante
  e descartado.
- Anti-loop ajustado: quando a Jarvis nao entende depois do wake, ela pode
  reabrir uma vez para correcao; capturas automaticas de resposta nao resetam o
  contador, entao eco/confusao repetida nao entra em loop.
- Fast-paths de acao e estado recebem o `userName` da persona, evitando respostas
  secas nos comandos criticos "abrir terminal" e "que horas sao".
- Drawer de configuracoes corrige o rodape "Fechar" para nao cobrir itens do
  catalogo expandido.
- Nova analise em `docs/analysis/2026-07-07-jarvis-operational-gap.md`
  documenta os gaps operacionais restantes do Nexus.

## 0.10.6 — Jarvis te ouve

Data: 2026-07-07

Correção da causa raiz da "Jarvis surda": o `autoGainControl` do Chromium (ligado por padrão quando qualquer constraint de áudio é pedida) achataba o sinal do microfone USB (fifine) perto de zero — o macOS ouvia o microfone, mas o app recebia frames mudos e nenhuma detecção de "Hey Jarvis" disparava.

### Correções

- Stream do wake word com `echoCancellation`, `noiseSuppression` e `autoGainControl` desligados — o openWakeWord/KWS quer PCM cru; o processamento corrompia as features do modelo. O eco é controlado pela pausa existente (`suppressWakeDetection`) enquanto a JARVIS fala.
- Instrumentação decisiva no wake mic: loga o dispositivo de áudio realmente capturado (`audioTrack.label` + `getSettings()`) e o RMS do primeiro frame — prova se o app pegou o microfone certo e se o sinal chegou, validando o fix no build real.

## 0.10.0 — Billing, times e operação refinada

Data: 2026-07-06

Billing/Team completo de ponta a ponta, checkout real via Stripe, licenças assinadas no app, times com convite/assentos e melhorias de operação no canvas, pipes e perfil de operador.

### Melhorias

- Backend SaaS completo para Billing/Team: checkout Pro/Team, portal Stripe, webhook idempotente, espelho de assinatura, grace `past_due` ancorada, entitlement pessoal vs time e licença JWT com TTL 30d/7d.
- Fluxo de time no app: bloco de Conta mostra owner/member, assentos usados, membros, geração de convite, entrada por código, saída e remoção de membro.
- Checkout Team no app agora envia nome do time e número de assentos ao backend; plano Free não vira checkout Pro por fallback indevido.
- Páginas web mínimas para `/billing/success`, `/billing/cancel` e `/join/<code>`, com código de convite sanitizado.
- Pipes entregam mensagens imediatamente ao criar uma conexão `onIdle`, com logs e badge de entregas na edge.
- Canvas evita drag acidental ao selecionar texto dentro de terminal/browser panes.
- Perfil de operador ganhou atalho e estado vazio mais claro.

### Correções

- Webhook Stripe reprocessa eventos não concluídos sem duplicar eventos já processados.
- Checkout Team reutiliza time pendente do owner e o reaper remove órfãos antigos, evitando travar o usuário quando o pagamento falha.
- Join de time usa advisory lock e guarda de assentos para corrida no último assento.
- LGPD: owner com assinatura de time viva não consegue apagar a conta antes de cancelar o time.
- UI de Conta não renderiza CTA de checkout inválido para Free e mostra erro retornado pelo backend.

## 0.9.0 — Auto-update & missões confiáveis

Data: 2026-07-06

Auto-update visível de ponta a ponta + conserto completo do ciclo de vida de missões + fim do spam de handoff fantasma.

### Melhorias

- Auto-update com UI: checagem no boot e a cada 6h via `gh` autenticado (repo privado; `NEXUS_UPDATE_FEED` tem precedência quando existir), badge ⇪ na WorkspaceBar (disponível/baixando/pronto/erro) e painel com atual→nova, notas do release e ações por fase. Download servido em feed Squirrel localhost — assinatura validada e swap seguro pelo Squirrel.Mac.
- Registro de missão nasce no lançamento (IPC `orch:missions.create`, orquestrador incluso na composição) — a missão nova aparece na hora no rail/board; kickoff instrui `nexus_mission_set_status` na missão já criada.
- Missões deslocadas por um novo lançamento viram "travada" (visíveis com Retomar) em vez de "rodando" fantasma.
- Retomar com resume direcionado: o `paneId` original persiste na composição (coluna `pane_id`, migração aditiva) e é reusado no reopen — cada pane volta à SUA conversa, não à mais recente do cwd.

### Correções

- Spam de handoff fantasma: o eco/repaint do bloco-exemplo do contrato de kickoff era parseado como entrega real e drenado em loop para o orquestrador (mesmo após fechar o terminal do worker). Caminho legacy agora aplica a régua anti-placeholder da tool MCP + dedupe por repaint (10min).
- `paneMissions` append-only: bindings de panes mortos marcavam a missão deslocada como "aberta" para sempre (clique no-op, sem Retomar). Prune por panes vivos a cada mudança de layout.
- Pane do orquestrador nunca era vinculado à própria missão (bind no-op com `undefined`) — a missão viva oferecia Retomar e o clique matava/recriava ela mesma. Bind por `orchestratorSessionId` + guarda de missão-já-aberta no painel.

## 0.8.2 — JARVIS operacional

Data: 2026-07-06

Refatoração sênior de confiabilidade da JARVIS + HUD flexível, guiada por análise de causa raiz e benchmark interno (benchmark de voz em tempo real, benchmark de ditado/benchmark de workspace).

### Melhorias

- Deadline duro em toda borda do pipeline de voz (STT cloud 12s, TTS 15s, cérebro 15s, whisper local 30s, piper 20s) com erro falado — fim do busy travado que deixava a JARVIS surda para sempre.
- Microfone do wake resiliente: `track.onended` + watchdog de frames (8s) + reconstrução com backoff (1s/3s/8s) + resume de AudioContext suspenso; esgotou → aviso visível.
- Retomada de turno preso: um novo "Hey Jarvis" após 20s de turno travado derruba o turno e atende.
- Wake-lock por PID (`~/.nexus/jarvis-wake.lock`): instâncias dev + empacotada não disputam mais o "Hey Jarvis".
- HUD da JARVIS compacto (300px) e flexível: arrastável pelo cabeçalho com snap de canto, redimensionável, modo mini (pill) e modo só-áudio (zero visual, voz segue); prefs persistidas + seletor nas configurações de voz.
- Novas ações de voz: `close_pane` ("fecha esse terminal") e `open_board` ("abre o quadro"); `run_command` avisa em voz que a confirmação está na tela.
- Ícones pixel refinados no toolbar/deck/board (grade 10px), botão visível do Ops Board e estados do quadro (fundação `--accent-strong`).
- Servidor: fundação do billing + team (schema subscriptions/teams/invites/stripe_events + migration).

### Correções

- Filtro anti-alucinação do Whisper consciente de contexto: "valeu/oi/tchau" em conversa ativa são resposta legítima, não lixo descartado.
- Barge-in agora mata a fala do fallback `say` no processo principal — sem vozes sobrepostas.
- Acks/fillers ("Sim?", "Deixa comigo.") fora da janela anti-eco — não censuram mais a resposta curta seguinte do usuário.
- whisper.cpp/piper deixaram de rodar síncronos no main (congelavam todo o app durante transcrição/síntese local).
- Captura de voz com deadline por timer: mic morto no meio da fala fecha o turno em vez de pendurar a escuta.

## 0.8.1 — Ops Board & identidade pixel

Data: 2026-07-06

Glow-up visual completo + novo ícone do app, em cima da fundação de contas.

### Melhorias

- Ops Board: pipeline espacial de missões (a fazer → executando → review → pronto → cancelado), trilho colorido por status, drag = planejamento, "retomar" restaura os panes. Atalho ⌘B.
- Icon set pixel unificado (NexusMark) substituindo emojis e glyphs Unicode no toolbar, deck e board.
- Novo ícone do app: diamante-nó pixel com core aceso sobre o console navy, no lugar do gradiente genérico.
- Escalas de token (`--space`/`--text`/`--radius`/`--shadow`) — espaçamento e acabamento consistentes em toda a UI.
- Orb do Jarvis reage à amplitude real do microfone (visualizador de verdade, respeitando reduced-motion).
- Settings reagrupado por intenção (Conta · Operação · Arsenal · Catálogo) + campo de busca.
- Logomark pixel (NexusMark) substitui o placeholder `◈` nas telas de entrada.

### Correções

- About mostrava a versão `0.7.1` fixa; agora acompanha o pacote.
- `textDim` revertia para um cinza que falha WCAG AA; corrigido no tema.
- Cores Material cruas no toolbar e vermelho semântico nos presets "Originals" trocados por tokens da paleta.
- Botão de fechar unificado (fim do `x` minúsculo e das 4 variantes).
- PT-BR no seletor de agente, nas fases do HUD de voz e no teste de voz.

## 0.8.0 — Contas, gamificação e glow-up

Data: 2026-07-06

Fundação de contas (OAuth) + gamificação de operador + início do glow-up visual. Saiu assinada e notarizada; changelog consolidado aqui por ter ficado para trás.

### Melhorias

- Backend de auth: login Google/GitHub (PKCE), exchange por código, sessão + rotação de refresh com detecção de reuso, licença Ed25519, `/me` e `DELETE /me` (LGPD), rate-limit por IP.
- `auth-client` no app: code → tokens no Keychain + licença; botões "Entrar com Google/GitHub"; deep-link `nexus://auth`.
- Gamificação power-scaling: XP por valor entregue (nunca consumo), tiers, prestígio, streak, conquistas, skins, mascote pixel no HUD e modo sóbrio.
- Hardening da voz Jarvis e da prontidão de providers.

## 0.7.0 — Squad CLI sync

Data: 2026-07-06

Release focada em deixar squads, providers e contas previsíveis.

### Melhorias

- AGY substitui Gemini CLI nos defaults, built-ins, squads, roteamento e remote spawn.
- Orquestrador de squad permanece no Claude; workers são distribuídos entre as CLIs instaladas.
- Providers iniciam em modo hands-free por padrão: YOLO quando suportado, senão Bypass.
- Contas novas passam a ser ativadas imediatamente.
- Contas Claude por assinatura restauram a credencial salva no Keychain antes de marcar “em uso”.
- Tela de contas mostra login local, conta em uso, cooldown, credencial ausente e ação de sincronizar.
- Review de squad foi reorganizado para evitar texto sobreposto e melhorar leitura dos controles.
- Workers Codex, AGY, Kimi e Grok preservam o `HOME` real do Mac, mantendo logins locais sincronizados dentro dos panes.
- Skills instaladas agora são espelhadas para os namespaces de Claude, Codex, AGY, Kimi e Grok; o Nexus também cria a skill `ponytail` a partir da regra interna.
- Prompts de confiança de workspace agora são tratados pelo harness: AGY é confirmado automaticamente quando mostra o diálogo conhecido, e Grok já abre com `--trust-folder`.

### Compatibilidade

- Squads antigos com `providerId: gemini-cli` passam a normalizar para `agy` quando `cli` não está explícito.

### Correções

- AGY usa `--dangerously-skip-permissions` como modo hands-free; `--yolo` não existe na CLI instalada e fazia o pane sair em `code 2`.
- AGY e Grok deixam de ficar bloqueados esperando confirmação manual de confiança do workspace/pasta em panes criados pelo Nexus.
