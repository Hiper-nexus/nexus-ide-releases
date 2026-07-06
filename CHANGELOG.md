# Changelog

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
