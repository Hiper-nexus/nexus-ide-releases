# Changelog

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

Refatoração sênior de confiabilidade da JARVIS + HUD flexível, guiada por análise de causa raiz e teardown competitivo (Overclock, BridgeVoice/BridgeSpace).

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
