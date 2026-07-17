# Changelog

## 0.19.15 — Login sem Terminal

Data: 2026-07-17

- **Login OAuth de assinaturas direto no painel OMP·RPC**: a nova seção
  Contas lista os provedores que o omp suporta (Claude Pro/Max, ChatGPT,
  Gemini CLI, Copilot…) com status de conexão e botão Conectar — a URL de
  autorização abre no navegador pelo app e a credencial grava no cofre do
  omp, sem abrir terminal. Antes, só `zai/glm` aparecia (única API key
  herdada do vault) e o login exigia rodar `omp auth-broker login` na mão.
- **Dropdown de modelos atualiza na hora**: ao concluir o login, o painel
  re-busca os modelos disponíveis sem reiniciar a sessão.
- **Mais API keys do vault chegam ao omp**: OPENAI, GEMINI, XAI, GROQ,
  CEREBRAS e MISTRAL agora são injetadas a partir do providers.conf.

## 0.19.14 — Sem Freio de Mão

Data: 2026-07-17

- **Fim do teto sintético de tokens**: missões travavam com "12k tokens de
  execução esgotados" ainda no bootstrap — mas esses tokens eram FICTÍCIOS
  (100-400 estimados por tool, nunca a conta real do provider). O ledger de
  steps/tokens vira telemetria pura: registra, nunca bloqueia. Missões já
  travadas por orçamento destravam sozinhas no próximo passo.
- Proteções reais permanecem: mission driver (iterações/tempo), PREVC e
  limite de workers vivos.

## 0.19.13 — Missão com Nome Próprio

Data: 2026-07-17

- **Missão agêntica não veste mais a identidade do squad reusado**: o modo
  agêntico continua honrando o roster salvo, mas a missão agora nasce com o
  título do SEU objetivo (não "Clone Overclock" numa missão de dashboards) e
  as instruções do squad são reapontadas para o objetivo vigente — o
  orquestrador não recebe mais duas missões concorrentes no kickoff.
- **Modelo escolhido na revisão persiste até o spawn**: eventos de
  adapters/providers (quota, install-check) resetavam o roster editado — o
  Fable escolhido para o orquestrador voltava silenciosamente a opus-4-8.
  O roster agora só recarrega quando o squad muda de verdade.
- **Notas internas de release sincronizadas**: a tela "O que há de novo"
  estava parada na 0.19.7; versões de server e lockfile realinhadas.

## 0.19.12 — Instala de Verdade

Data: 2026-07-17

- **Instalador de CLIs com cascata de canais**: quando o canal primário não
  funciona na máquina (sem Node/npm, sem Homebrew, ou o clássico erro de
  permissão do npm -g), o instalador cai automaticamente para o canal oficial
  alternativo — Claude usa o instalador nativo da Anthropic, Codex cai para o
  brew, Kimi e opencode tentam brew e npm. Sem nenhum canal utilizável, o
  resumo diz exatamente o que falta ("instale Node OU Homebrew") em vez de
  falhar em silêncio.
- **omp instala em máquina sem Homebrew**: o oh-my-pi ganhou o instalador
  oficial do projeto (omp.sh/install) como fallback — era brew-only e ficava
  sem rota nenhuma em máquina fresca.
- **Instalador acha o brew/npm mesmo com PATH incompleto**: app aberto pelo
  Finder pode não herdar o PATH do terminal; a seleção e a execução dos
  instaladores agora procuram também nos diretórios padrão (/opt/homebrew/bin,
  /usr/local/bin, ~/.local/bin) — fim do "sem Homebrew" com o brew instalado.

## 0.19.11 — Rota Livre

Data: 2026-07-17

- **Fim do loop de respawn**: pane que continua morrendo após 3 respawns
  consecutivos leva a missão a um estado terminal com causa acionável
  ("verifique login/credencial do adapter e use Retomar no rail") em vez de
  churnar para sempre — era o bloqueio nº 1 nas missões reais auditadas.
- **Drift de contexto deixou de ser morte**: nova tool
  nexus_mission_refreeze_contract re-congela o contrato após mudanças no
  contexto (.context/, attestations, policy) preservando objetivo, critérios
  e escopo; o workflow recomeça na rota para revalidar evidência e o rigor
  nunca é rebaixado. A mensagem de drift agora aponta a cura em vez de um
  "not ready" vazio.

Com esta release, os sete becos sem saída da família "missão travada"
mapeados na auditoria de 17/07 estão fechados.

## 0.19.10 — Máquina Nova

Data: 2026-07-17

- **Piloto automático de máquina nova**: no primeiro boot com CLIs
  ausentes, um diálogo nativo lista os comandos exatos e instala tudo em
  sequência ao aceitar — do DMG ao cockpit operacional em minutos.
- **Provisionador de CLIs**: botão único no hub de Providers instala TODAS as
  CLIs ausentes em sequência (instaladores oficiais, uma confirmação nativa
  por CLI mostrando o comando exato) — máquina fresca fica operacional sem
  caçar botão por painel.
- **Permissão de tela sem calvário**: "Pedir permissão ao macOS" registra o
  NexusIDE na lista de Gravação de Tela na hora (o macOS só lista o app após
  a primeira tentativa de captura — agora o Nexus tenta por você e o prompt
  nativo aparece). Nos Ajustes é só virar a chave, sem "+" nem buscar pasta;
  o fluxo guiado em 3 passos fica na própria tela Vision.

## 0.19.9 — Sem Fantasmas

Data: 2026-07-17

- **Login 401 do Claude morto de vez**: conta pinada que é o login nativo do
  Keychain spawna sem token env (a linhagem que o CLI mantém fresca); contas
  secundárias ganham renovação automática do OAuth no vault a cada 15min —
  respawn de failover nunca mais encontra token expirado.
- **Cooldown fantasma se auto-limpa**: leitura fresca da API do provider com
  janelas saudáveis refuta cooldown persistido (resíduo da cascata) e a conta
  volta ao pool; cooldown maior que 5h agora pinta a barra Semanal — nunca
  mais "5 Horas 100%" com reset de 10 horas.
- **Missão antiga não ressuscita sozinha**: o driver só dirige missões com
  atividade na sessão atual do app; retomar uma antiga voltou a ser decisão
  sua.
- **Nova Missão com "Planejar · PRD"**: quarto card pula direto para o squad
  de planejamento BMAD (lê o código, entrevista, entrega PRD + arquitetura
  com diagrama + stories).
- **Updates sem gh CLI**: o updater ganhou fallback para um espelho público
  de releases via API anônima — máquinas de terceiros atualizam sozinhas
  (espelho a ativar).
- **Uso e cotas**: cards com barras, percentuais e resets alinhados.

## 0.19.8 — Destrava Geral

Data: 2026-07-17

- **Fim da cascata de limite fantasma**: o detector de failover não relê mais o
  próprio continuity pack injetado na conta nova — acabou o efeito dominó que
  derrubava conta por conta até a frota inteira entrar em cooldown com cota
  sobrando. Segunda camada: leitura fresca da API do provider refuta limite
  falso antes de trocar de conta. Painel Integrações virou modal focado.
- **Terminal fluido**: contextos WebGL alugados por recência de foco (o
  terminal que você olha renderiza acelerado mesmo com 10+ panes), o zoom e a
  troca de monitor reajustam a grade na hora, e Alt+roda rola 5x.
- **Missões destravadas**: o freeze do contrato não trava mais com WIP fora da
  superfície de evidência (.context/ + docs de raiz); o limite de workers
  conta só workers VIVOS (worker morto não segura slot para sempre); o erro de
  contexto chega com remediação por blocker; e o terminal do orquestrador
  ganhou autoridade para commit, git push e merge.
- **Oh My Pi operacional**: o /login OAuth completa dentro do painel (botão
  "Abrir no navegador"), e o omp entrou no roster de todos os squads builtin.
- **Planejamento estilo BMAD**: squads novos "Planejamento & PRD" (lê o
  sistema real → entrevista você com a skill grilling → PRD e arquitetura com
  templates/checklists reais do BMAD → stories) e "Implementação por Stories"
  (SM → Dev → QA com Definition of Done). Skills archify (diagramas HTML),
  grilling e bmad-templates embutidas para todas as CLIs.
- **UI sem garimpo**: configurações numa lista plana com tudo visível
  (Companion mobile a 1 clique), botão desligar da Jarvis desliga de verdade,
  browser sem tela branca no load (fundo escuro + barra de progresso) e erros
  honestos no proxy, nas licenças e no Vision.

## 0.19.7 — Chaves Herdadas

Data: 2026-07-16

- **omp herda as API keys do Nexus**: as chaves que você já salvou (GLM/z.ai,
  Moonshot/Kimi, DeepSeek, MiniMax, Qwen, OpenRouter, Anthropic por key) são
  injetadas automaticamente na sessão do omp com os nomes que ele reconhece —
  esses providers funcionam sem nenhum login extra. Só entram chaves que
  existem no vault; nada vaza do ambiente.
- Assinaturas (Claude Max, plano Codex, GLM coding plan) continuam pelo
  /login do próprio omp — 1 clique de autorização no navegador, por design
  dos providers (token por aplicativo, revogável e dentro dos termos).

## 0.19.6 — Pet Obediente

Data: 2026-07-16

- **Pet não gruda mais no mouse**: soltar o botão fora da janelinha (ou o OS
  roubar o ponteiro) encerra o arrasto na hora via lostpointercapture; o
  watchdog de resgate caiu de 30s para 10s.
- **Pet não some mais em fullscreen**: entrar/sair do fullscreen nativo
  re-afirma o pin de all-workspaces (visibleOnFullScreen), garante
  visibilidade e reclampa o pet para a área visível.

## 0.19.5 — Frota Completa

Data: 2026-07-16

### Orquestração

- **omp em operação de background**: entra na tabela de roteamento (tiers
  medium/hard, agregando os providers logados no próprio omp) e ganha o
  assento Reviewer D no squad builtin Review P0–P3 — o pipeline é um port do
  review do próprio oh-my-pi, agora ele participa do próprio rito.
- **Editor de squad vira modal centralizado**: abria inline no fim da lista
  (fora da viewport, exigia rolagem). Agora: dialog no meio da tela com
  scrim, Esc/clique-fora, foco no primeiro campo e scroll interno.
- **Polish do painel**: painel mais largo com respiro, tab ativa com âncora
  de acento, toolbar sticky, cards com hover, campos do editor com focus
  ring e roster em cartões.

## 0.19.4 — Paridade Viva

Data: 2026-07-16

### Modo Design

- **Emulação mobile real**: o breakpoint 📱 ≤480px agora troca user agent e
  métricas de tela (com reload) — o site serve o layout mobile de verdade
  (menu hambúrguer, media queries), não só a largura estreitada. Voltar para
  ▯/🖥/⛶ restaura o navegador normal.

### Forge (GitHub/GitLab)

- **GitLab MR ligado**: criar PR/MR usa a camada forge com autorização
  explícita (escopo + expiração) e auditoria para GitHub E GitLab — token via
  NEXUS_GITLAB_TOKEN ou sessão do glab CLI.
- **"PR desta branch"**: o painel de integrações mostra o PR/MR aberto da
  branch atual, clicável — read-side getReviewForBranch finalmente com UI.

### Instalador de CLIs

- **agy, kimi e grok** entram no 1-clique com canais oficiais verificados:
  kimi via brew kimi-code / npm @moonshot-ai/kimi-code; grok via npm
  @xai-official/grok; agy pelo instalador oficial de antigravity.google,
  baixado por HTTPS e executado sem pipe de shell. 8 das 9 CLIs instalam
  pelo app.

### UX

- **Ferramentas da barra fecham as Configurações**: painéis não abrem mais
  atrás do drawer (parecia clique morto).
- **OMP RPC diz por que morreu**: saída prematura mostra o motivo real
  (ex.: falta de /login) e oferece "Abrir omp no terminal (/login)".

## 0.19.3 — Operacional para o Cliente

Data: 2026-07-16

Lote de correções guiado por bugs de operador no 0.19.2 — cada fricção
reportada virou fluxo funcional, com foco em máquina de cliente fresca.

### Contas e providers

- **Conta por login dispara o fluxo de auth** (P0): "Entrar com nova conta"
  (e "Fazer login agora" no status Login necessário) abre um terminal já
  rodando o login da própria CLI — `claude /login`, `codex login`,
  `grok login`, `kimi login`, `opencode auth login`, `agy` — e o CLI abre o
  navegador na URL do provider. Nada de URL hardcodeada; GLM/LongCat (token)
  ficam de fora por design.
- **Instalador 1-clique de CLIs**: provider ausente ganha "Instalar
  automaticamente" (e o painel OMP, "Instalar omp automaticamente" com retry).
  Receitas em código de fontes oficiais confirmadas (claude/codex/gemini via
  npm; opencode e omp via brew), confirmação NATIVA mostrando o comando exato,
  pré-check do runner com instrução honesta.
- **GitHub sem setup**: sem PAT, o Nexus usa a sessão do `gh` CLI
  (`gh auth token`, cache 60s, nunca persistido) — PRs/issues funcionam na
  hora em máquina com gh logado.
- **Kimi K3 + descoberta viva de modelos**: K3 e highspeed no catálogo, e o
  "Atualizar modelos" agora pergunta à própria CLI o que ela conhece
  (`kimi provider list --json`) — modelo novo aparece sem esperar release.

### Modo Design

- **Desligar nunca mais falha**: SPA ocupada que não confirmava o
  design_disable deixava a barra presa em "ON + erro"; o desligamento local
  virou autoridade.
- **Erros legíveis**: o wrapper cru do Electron ("Error invoking remote
  method 'br…'") vira texto curto e acionável, com tooltip da mensagem
  completa; erros de lifecycle benigno resetam a barra em silêncio.
- **Preview mobile sempre visível**: 📱 375 / ▯ 768 / 🖥 1440 / ⛶ saem de trás
  do toggle do Design e vivem na barra do browser pane, com rótulos.

### Infra de release

- CURRENT_RELEASE (notas internas) e server/package.json passam a acompanhar
  a versão — invariante que o bump 0.19.2 tinha furado (achado da suíte).

## 0.19.2 — Orquestração Destravada

Data: 2026-07-16

Auditoria senior sobre o runtime real do operador encontrou e corrigiu a
cadeia inteira que fazia toda missão morrer no bootstrap, o falso "não logado"
nos panes do Claude, o bloqueio permanente de workspace no `workspace:pick` —
e entregou o restyle visual que estava preso fora do main.

### Orquestração — bootstrap de contexto convergindo (PR #34)

- **Reviewer independente destravado** (P0): o gate MCP negava
  `nexus_context_draft_review` de panes sem missão — mas drafts de projeto têm
  missionId nulo e o reviewer é spawnado sem vínculo por design. Todo draft
  ficava `proposed` para sempre e nenhum contrato congelava. Exención estreita
  por nome (precedente `memory_retain`); a autoridade real segue no handler
  (reviewer ≠ autor, provider distinto, re-hash de fontes).
- **Fim do `sourceHash` incomputável** (P0): agentes hospedados não têm tool
  de hash; o Nexus agora computa o sha256 das fontes no propose (e re-verifica
  em review/apply). `expectedTargetHash` omitido vincula ao estado atual.
- **Review em andamento não é falha** (P0): `context_draft_review_run` devolvia
  "timed out" após 2 min com o pane revisor ainda vivo; agora responde
  `pending` com instrução de poll via `context_draft_get`.
- **`missing-structured-invariants` tem caminho** (P1): hint do autopilot e
  remediação do doctor ensinam o movimento sancionado — invariante OBSERVADA de
  fontes reais em `.context/nexus/invariants/*.json` + revisão independente.
- **`nexus_git_status` em raiz não-git** (ex.: workspace multi-projeto) devolve
  `{isRepo:false}` com nota, em vez de "Git executable-config inspection
  failed".

### Auth e identidade

- **Pane do Claude não pede mais /login com a máquina logada** (P0): o HOME
  efêmero de panes gated ganhava um `.claude.json` stub sem `oauthAccount`
  (a identidade é file-backed; o Keychain guarda só o segredo). O adapter
  Claude nativo projeta a identidade no overlay (+link de `.credentials.json`)
  e o teardown resgata login fresco feito dentro do pane. GLM/LongCat nunca
  recebem a identidade nativa.
- **`workspace:pick` não trava mais o workspace** (P0): pasta apagada e
  recriada no mesmo path deixava o registro em "checkout id collision" para
  sempre; mesma-path agora se auto-cura, paths diferentes seguem fail-closed.

### Visual e produto

- **Restyle `ui/mission-rail-polish` entregue**: onboarding Bridge-inspired
  centrado (hero, trail de steps, featured cards) reconciliado com a camada
  endorfinada (pet, saudação); MissionRail com chips de meta (ativas/aqui/
  budget compacto); MissionWizard com cards de modo badge/CTA.
- **GitHub de primeira classe**: botão inline na workspace bar (saiu do menu
  ⋯) + aviso claro de que "Entrar com GitHub" (conta Nexus) não configura a
  API — o PAT vive no painel de integrações.
- **Inbox de notificações sem corte**: nome do agente usa a largura livre com
  tooltip; rótulo "Login do CLI" virou "Contas reserva".
- **Router com gpt-5.6/gpt-5.6-sol** no catálogo e nos tiers hard/critical.

### Backend SaaS

- **Assinaturas Pro em BRL** (frente paralela): tier Free permanente + Pro
  mensal com Stripe Checkout, portal, webhooks assinados e cloud sync
  Pro-only; deploy Railway, migrações e runbooks de produção.

## 0.19.1 — Cockpit Endurecido

Data: 2026-07-16

Correções de um review senior adversarial (2 frentes) sobre o pacote Labs +
inbox de agentes recém-integrado à 0.19, com todos os achados até LOW fechados
e teste de regressão por achado.

### Inbox de notificações de agentes

- **Fim do "CONCLUÍDO" falso no respawn** (HIGH): a época de atividade passa a
  registrar sua origem — só um turno real (idle→busy) pode concluir; boot e
  respawn (spawning→busy) nunca contam. Reabrir um workspace com N agentes não
  gera mais N avisos fantasmas.
- **Painel volta a aparecer** (HIGH): a zona de status da barra é
  `overflow:hidden` e recortava 100% do popover; ele passa a `position:fixed`
  ancorado ao sino, escapando do clip.
- **Alinhado ao que a tela mostra** (MEDIUM): o bridge consome `displayStates`
  (hold de ~1,4 s), então um gap silencioso no meio de um turno não emite
  "concluído" prematuro.
- a11y: foco devolvido ao sino ao fechar; `role="status"`/`aria-live` anuncia
  avisos novos; `Esc`/`Tab` não vazam para overlays por baixo
  (`stopImmediatePropagation`); ícone de sino próprio (era o raio duplicado); os
  botões de ação carregam o nome do agente. Jump lê o layout vivo. Fecha ao
  abrir qualquer drawer maior. Teste de componente novo.

### Labs / feature flags

- **Desligar a flag do companion derruba o relay ativo** (HIGH): antes, desligar
  `feature.remote.relayTransport` com sessão aberta era fail-open (o celular
  seguia conectado); agora o override encerra o transporte, e a seção Companion
  mostra o controle **Parar** quando há sessão viva mesmo com a flag off.
- **Persistência robusta** (MEDIUM/LOW): rollback do estado vivo quando o disco
  falha (main nunca diverge do arquivo); o modo de força de dogfood
  (`NEXUS_FORCE_ALL_FLAGS`) virou camada efêmera e não vaza mais para o arquivo
  de overrides; overrides de flags que o build não conhece sobrevivem a
  downgrade→upgrade.
- **Só a janela do app altera flags** (MEDIUM): os canais de flag passam a
  validar o sender — um WebContentsView de pane de browser não muta mais o
  estado global.
- LOW: `Labs` promovido à navegação primária (o painel de descoberta não podia
  viver atrás do "Avançado"); precedência de resolução corrigida na copy
  (kill switch > canal > override > default); hints atualizados (memória tem
  painel; relay abre a seção Companion); pending por-id (Set) no toggle; uma
  única resolução por flag no list; painel de Memória re-busca ao mudar a flag.

## Não lançado — Mobile em tempo real com sessão persistente

Fecha os dois últimos degraus operacionais do companion no device (dossiê
2026-07-15 §7): o thin client deixava de parear a cada reload e fazia poll de
2,5 s num `<pre>` enquanto o stream binário existia server-side sem uso.

- **Push de terminal em tempo real**: a bridge assina `tapSessionData` e
  empurra `pane.stream.data` (terminal-stream-protocol, mesmo domínio de seq
  do `pane.read`) para os sockets autenticados que abriram
  `pane.stream.open`. Backpressure derruba frames em vez de acumular buffer
  (fail-safe ≤256 KiB por socket); o gap de seq resultante é detectado pelo
  cliente e curado com um `pane.read` de reconciliação.
- **Thin client streaming**: decodifica os frames no browser (header de 16
  bytes, opcode Output), acompanha seq, aparo de cauda para memória de
  celular, e rebaixa o poll para reconciliação de 15 s (2,5 s permanece como
  fallback em bridge antiga sem push).
- **Sessão persistente**: token guardado em `localStorage` da origem HTTPS da
  própria bridge — reload não re-pareia; revogação/expiração no desktop
  derruba o auth server-side e o cliente volta sozinho à tela de pareamento
  com o motivo.
- Compatibilidade: `handleAuthedMessage` ganha `pushTarget` opcional — o
  caminho do relay (companion-relay-transport) segue request/response
  intacto. TDD: push só para inscritos + seq monotônica + isolamento de
  sessão não relacionada; suíte remota 109/109; `tsc` limpo.
- Endurecido pela rodada de review (Codex + CodeRabbit, 7 achados):
  **remote-output-bus** unifica o tap de PTY entre bridge WS e relay do
  companion (UM encode por chunk — bridge+relay simultâneos não criam gaps
  falsos entre si); **cursor de push dedicado** (`pushSeq`) imune aos encodes
  de resposta de `pane.read`/`pane.input` (sem tempestade de resync entre
  clientes); negociação explícita `pushAvailable` (bridge antiga mantém poll
  2,5 s); inscrição única por socket + `pane.stream.close` (pane antigo não
  enche o buffer); debounce de reconciliação por gap; revogação AO VIVO
  derruba o cliente para a tela de pareamento; token só é apagado em rejeição
  explícita do auth (queda de rede preserva a sessão).

## 0.19.0 — Oh My Pi na tela

Segunda leva do crossover [oh-my-pi](https://github.com/can1357/oh-my-pi): as
capacidades que só viviam no backend/MCP ganham UI de primeira classe. Reconciliada
sobre a 0.18.0 (Cockpit Ligado).

### Adicionado

- **Painel de Memória** do workspace: stats por tipo/escopo + recall FTS5 com
  debounce, navegação por teclado, AA e estados vazio/desligado. IPC read-only
  `memory:*` escopado por gate.
- **Inventário de configs**: painel do que cada CLI enxerga no workspace
  (MCP/rules/skills/commands) por ecossistema, com shadowing destacado.
- **Preço/janela no seletor de modelo**: `ModelMetaBadge` no wizard de missão via
  IPC read-only `model:richMetadata`.
- **Companion mobile na tela**: seção de Settings inicia/para o relay E2E, exibe
  QR e links full/view com aviso de segurança; push de PTY ligado ao pty-manager.
- **Exclusividade de drawer direito** (orquestração/omp/memória), **registry de
  buffers** do editor (hashline modo buffer), botões de Memória e Configs na
  WorkspaceBar.

### Corrigido

- Reconciliação com a 0.18.0: adotado o toggle de flags `Labs` da main (canal
  único `product:flags.setOverride`), removida a implementação duplicada do
  crossover para evitar handler IPC em conflito.
- `ModelMetaBadge` tolera `window.nexus` ausente (ambiente de teste).
- Release metadata realinhada em 0.19.0.

## 0.18.0 — Cockpit Ligado

Data: 2026-07-16

Fase de operador único: capability pronta atrás de flag invisível não é
maturidade, é estoque. A 0.18.0 liga por default tudo que tem superfície
pronta, entrega o painel Labs para operar flags pela UI, resgata o inbox de
notificações de agentes (PR #20) e consolida o que estava "não lançado":
perfil de design no motor automático e anotações do Design Mode. Inclui
também todo o crossover Oh My Pi da 0.17.0 (nunca tagueada).

### Labs + superfícies ligadas por default

- **Configurações → Sistema → Labs**: painel com TODAS as feature flags do
  produto — estado real resolvido pelo main (kill switch > override > canal >
  default), descrição PT-BR, switch persistido e "Restaurar padrão" quando há
  override. Antes, o único caminho era editar `feature-flags.json` à mão no
  userData; agora é um clique, com push ao vivo para a UI gateada
  (`product:flags.setOverride` + broadcast `product:flags.changed`).
- **Default-ON** (9 flips, decisão revisada pinada em teste): blocos de
  comando do terminal (OSC 133), journal de eventos de missão, busca
  unificada, onboarding progressivo, painel contextual, editor de workspace
  (caminho textarea + guarda de hash), catálogo de skills, memória Markdown
  `.nexus-memory/` e memória agentic por workspace (FTS5).
- **Continuam default-OFF, agora ligáveis pelo Labs**: MCP Hub sync (escreve
  configs de outras ferramentas no HOME — ligar é decisão deliberada), relay
  E2E do companion (exige relay hospedado + URL `wss://` explícita) e perfis
  de autonomia (sem consumidor na UI ainda).
- Registry ganha `clearOverride` (voltar ao default) e o hook
  `useProductFlags` passa a reagir ao push de mudanças sem reiniciar o app.
- TDD: override aplicado/limpo/persistido e fail-closed para id desconhecido
  (3), contrato de defaults por flag re-pinado (shared + registry), hook com
  defaults novos, seção Labs (5: render, toggle, restaurar, kill switch,
  reasons). `tsc` limpo.
- **MCP Hub também default-ON** (pedido do operador): toda escrita em
  config de terceiros segue click-gated — dry-run → confirmação → backup;
  fill-gaps nunca deleta. Ficam OFF só relay E2E (exige relay hospedado +
  URL `wss://`) e perfis de autonomia (sem consumidor na UI) — ligá-los
  hoje seria no-op; ambos alternáveis no Labs.

### Inbox de notificações de agentes (resgate do PR #20)

- Sininho na workspace bar com CONCLUÍDO / ENCERRADO por pane de agente:
  "concluído" só após busy sustentado (≥1,5s) — idle curto não spamma;
  "Ir ao pane" foca o agente e valida se o pane ainda existe (toast quando
  não); marcar lida, marcar todas, limpar; teto de 40 itens; focus trap +
  Esc no painel.
- Bridge de transições vive fora do session-state-store (sem side-effects
  no store), é idempotente e desliga limpo no teardown do orch-bridge.
- Reimplantado sobre a main atual a partir da stack revisada do PR #20
  (#19 → #20 fechados); domínio puro + bridge com testes (8) verdes.

### Perfil de design no motor automático

- O motor que injeta a Carta de Design nos workers de UI ganha um **perfil de
  design** configurável em Configurações → Squads: **direção estética**
  (Auto / Minimalista / Brutalista / Soft) e três **dials 1–10** — ousadia de
  layout, intensidade de motion e densidade visual (conceito adaptado do
  taste-skill, MIT — ver `THIRD_PARTY_NOTICES.md`; texto injetado é nosso).
- Frugal por construção: direção Auto + dials na banda neutra (4–7) injetam a
  carta pura, byte a byte — o recurso não custa nada no prompt de quem não o
  usa. Só dials extremos (1–3 / 8–10) e direções explícitas viram linhas.
- As proibições anti-genérico da carta continuam absolutas: o perfil modula o
  gosto dentro delas (o bloco injetado declara isso ao agente), e valores fora
  da faixa em settings antigos são clampados em vez de quebrar o spawn.

### Anotações de Design (paridade Orca Design Mode)

- Design Mode ganha **anotações**: com um elemento selecionado, "＋ anotar" abre
  um composer próprio (comentário + intenção corrigir/mudar/pergunta/aprovado;
  Enter no composer anota — nunca envia nada ao agente) e fixa a nota no
  elemento — badge numerado aparece na própria página. Os badges seguem o
  elemento VIVO pelo selector (sobrevivem a reflow, breakpoints da própria
  design bar e sticky), com fallback para a geometria congelada. Teto de 20
  por página.
- Tray "📝 N" na design bar lista as anotações (excluir uma, limpar todas),
  **copia** o feedback consolidado (funciona sem nenhum agente aberto — dry
  run não exige alvo) ou **envia tudo de uma vez** pro agente: um prompt único
  numerado igual aos badges, com os dados da página no envelope não confiável
  padrão e DESIGN.md anexado como contexto confiável quando existir. As notas
  do usuário NUNCA são cortadas pelo orçamento do prompt — envelope e
  DESIGN.md encolhem primeiro (com `omittedEntries` explícito). Itens
  [pergunta] pedem resposta; [aprovado] são registro.
- Anotações sobrevivem ao toggle do modo Design (dá pra navegar a página e
  enviar depois) e morrem com o documento — por UM caminho único de
  invalidação que cobre navegação real, **rota SPA (pushState)**, crash do
  renderer da página e destruição do pane (troca de workspace): main, badges
  na página e renderer resetam juntos via evento `navigation` sintetizado
  (antes a design bar ficava "ON" fantasma após reload). Saltos só de hash
  preservam as anotações.
- O sync dos badges é enfileirado e nunca bloqueia a resposta das ações do
  tray (a página ocupada não congela mais o "＋ anotar" por até 7s).
- O store é main-owned: o renderer só envia a nota digitada; o contexto do
  elemento é o snapshot da seleção já validada por Zod. Os badges na página
  recebem SÓ geometria — comentários nunca chegam ao lado da página.
- `nexus_design_selection_get` passa a listar as anotações da página (e
  continua respondendo quando só há anotações, com o picker desligado).
- Origem: adaptado do Design Mode do Orca (stablyai/orca @ 5e10091, MIT) —
  viewport-bridge de badges, modelo de anotação e formato do feedback — com
  provenance em `third_party/provenance/orca-5e1009.json` e notas em
  `THIRD_PARTY_NOTICES.md`. Fecha o terceiro alvo do transplante Orca
  (mobile QR ✓, forge-registry ✓, design mode ✓).
- TDD: marcadores do preload (9), picker rectPage/isFixed (+1), sessão de
  anotações no main (+6), formatter (4), envio em lote (+4), tool MCP (+3),
  UI da design bar (+6). `tsc` limpo.

## 0.17.0 — Oh My Pi

Crossover com o coding agent open-source [oh-my-pi](https://github.com/can1357/oh-my-pi)
(MIT): peças maduras vendoradas e integradas ao cockpit, não reescritas do zero.
Provenance em `third_party/provenance/oh-my-pi-03c48d0.json`; análise senior em
`docs/analysis/2026-07-15-oh-my-pi-crossover-senior.md`.

### Adicionado

- **Pane omp de primeira classe** via `omp --mode rpc-ui` (NDJSON tipado sobre
  pipes): estado determinístico (sem PTY-scraping), streaming, custo/contexto ao
  vivo, troca de modelo cross-provider mid-session. Aprovações sempre no host com
  auditoria fail-closed; host tools roteadas pelo skill-gate real; spawn sempre
  com `--approval-mode always-ask`. Adapter `omp` no grid com injeção MCP por
  HOME-overlay privado por sessão.
- **hashline** vendorado como patch bus do editor (tool `nexus_editor_apply_patch`):
  edição ancorada em hash de conteúdo, all-or-nothing multi-arquivo, rejeição de
  âncora obsoleta, recuperação fail-closed. xxHash32 reimplementado em TS puro
  (paridade de bytes provada por vetores canônicos).
- **Companion mobile E2E**: relay cego + AES-256-GCM (pi-wire), chave no fragmento
  do QR, view-only vs controle por posse de write-token, endurecimentos
  multi-tenant (cap de salas/peers, rate-limit, origin, TTL). Atrás da flag
  `feature.remote.relayTransport` (default off).
- **Memória agentic por workspace** (`nexus_memory_retain/recall/stats`) sobre
  SQLite FTS5, banco por workspace + global do usuário, redação de segredo e
  dedupe. Atrás da flag `feature.memory.workspaceMemory` (default off).
- **Cooldown de failover por tier**: bloco escopado por família de modelo não tira
  a conta do pool para outros modelos; espera-pela-irmã em vez da janela longa;
  probe-after e restauração automática.
- **Catálogo rico de modelos** (preço/MTok, janela, capacidades) vendorado do omp,
  com re-sync pinável; **descoberta universal de configs** de `.claude`/`.cursor`/
  `.codex`/`AGENTS.md`/`GEMINI.md`; **squad builtin Review P0–P3** com findings
  tipados; **classificadores de rate-limit** (quota vs transitório, multilíngues).

### Corrigido

- Companion: guest view-only não derruba mais a sessão do host com um frame
  indecifrável (host descarta o quadro; fatal só para o próprio guest).
- Pane omp: caracteres multibyte (pt-BR/emoji) partidos no limite de chunk do pipe
  são remontados via StringDecoder, sem corromper texto nem argumentos de tool.
- PREVC: o gate de mutação extrai os paths de dentro do patch hashline e aplica o
  invariante `.context/` read-only a cada seção.
- Descoberta de configs não materializa segredo do ambiente no inventário
  read-only (mantém `${VAR}` literal).
- Release metadata realinhada em 0.17.0 (package/server/lockfile/changelog/notas).

## 0.16.6 — Live sem Silêncio

Data: 2026-07-15

- O caminho de transcrição final do Gemini Live não assume mais que o provider
  respondeu: ele espera evidência real de áudio ou tool-call antes de encerrar o
  turno como realtime.
- Se o prazo termina sem evidência, o mesmo texto segue para cérebro e TTS
  Classic, com Live silenciado e quiescido antes da fala para evitar silêncio ou
  duas respostas concorrentes.
- A janela de evidência considera áudio recebido desde o início do turno, não só
  depois do transcript final; uma resposta curta que já tocou não dispara um
  segundo fallback por engano.
- Turnos superseded continuam abortando, e tools nativas preservam ownership e a
  continuidade do socket Live.
- O atualizador direto da 0.16.5 continua ativo: instalações 0.15 ou 0.16.x
  selecionam a 0.16.6 em uma única atualização, com asset da arquitetura atual.
- Suíte completa validada: 665 arquivos de teste e 4.649 testes passando.
- Package, server, lockfile, changelog e release notes ficam alinhados em
  `0.16.6`.

## 0.16.5 — Atualização Direta

Data: 2026-07-15

- O fallback autenticado do atualizador consulta a lista de releases e escolhe
  a maior versão semântica estável com ZIP compatível, sem depender da ordem da
  API nem do marcador `latest` do GitHub.
- Drafts, prereleases, tags inválidas e artefatos de outra arquitetura/versão
  são ignorados; Apple Silicon recebe arm64 e Mac Intel recebe x64.
- Antes de baixar, o app revalida a oferta. Se `0.16.1` ficou aberta e `0.16.5`
  foi publicada depois, o mesmo clique passa a baixar `0.16.5`, evitando duas
  instalações em sequência.
- Cobertura de regressão reproduz o fluxo `0.15.0 → 0.16.1` cacheado e confirma
  que o download final usa somente o release mais novo.
- O watchdog da janela não reinicia mais uma navegação ainda ativa após três
  segundos. Cargas lentas — inclusive no build Intel sob Rosetta — podem
  concluir sem entrar em ciclo de `ERR_ABORTED` e piscar a interface.
- Estado visual de terminal usa histerese curta e elimina reemissões idênticas;
  bordas, toolbar e contagem da frota deixam de piscar entre pausas breves de
  output, sem atrasar o estado real usado pela orquestração.
- Objetivos, anexos, chaves de voz, anotações de diff, seleção de agente e
  navegação de Settings sobrevivem a fechamento acidental/Jarvis. Cancelar ou
  concluir continua descartando explicitamente o rascunho.
- A fala de espera por prints/áudios agora vence respostas otimistas quando a
  missão realmente está aguardando evidência; anexos já presentes liberam o
  fluxo sem falso bloqueio.
- Quando o Live aceita uma transcrição local de resgate mas não produz áudio
  nem tool-call no prazo, o turno autorizado passa para o cérebro/TTS Classic
  em vez de terminar em silêncio; turnos superseded continuam abortando.
- Suíte completa validada: 665 arquivos de teste e 4.648 testes passando.
- Package, server, lockfile, changelog e release notes ficam alinhados em
  `0.16.5`.

## 0.16.4 — Dock Persistente com Pet

Data: 2026-07-15

- Causa 1 (classificação): o companion chamava `setVisibleOnAllWorkspaces(true)`
  e o Electron transformava o processo em `UIElementApplication`. Agora usa
  `skipTransformProcessType: true` e permanece `Foreground`.
- Causa 2 (tile fantasma): vários `dock.show()` no thrash deixavam um item
  "NexusIDE" no Dock com tamanho AX `12×0` — listado, mas **invisível** até
  `killall Dock`. Agora o app aplica o ícone do bundle (`dock.setIcon`) e só
  chama `show()` se o Dock estiver escondido.
- O pet não chama `dock.show()` no hot path (evita loop de foco/piscar).
- A janela principal continua oculta durante retries recuperáveis do protocolo.

## 0.16.3 — Dock em Primeiro Plano

Data: 2026-07-15

- Corrige o desaparecimento do NexusIDE do Dock no macOS: a política `regular`
  agora é aplicada pelo bootstrap mínimo antes do runtime pesado/native ser
  carregado.
- Três rechecagens curtas de boot confirmam a política e a presença do Dock sem
  roubar foco nem recompor a janela continuamente.
- Testado em app empacotado Apple Silicon: macOS reporta `Foreground` durante
  todo o boot, em vez de `UIElement`.

## 0.16.2 — Evidências e Squads Afinados

Data: 2026-07-15

- Objetivos que dizem que prints, capturas ou áudios serão enviados depois ficam
  aguardando evidências e não geram handoff, pane ou especialistas antes da hora.
- Jarvis, wizard e o preflight principal revalidam o gate; remover os anexos
  antes de começar também bloqueia o dispatch.
- Squads aceitam prints e áudios no objetivo, com limites de quantidade/tamanho
  e caminhos injetados no kickoff para o time investigar os arquivos reais.
- Grok usa `grok-4.5` e AGY/Gemini usa `gemini-3.5-flash-high` como padrão em
  squads embutidos, persistidos, importados e novos; escolhas manuais continuam
  preservadas.
- Suíte completa validada: 660 arquivos de teste e 4610 testes passando.

## 0.16.1 — Scheduler Operacional e Merge Fail-Closed

Data: 2026-07-14

- Scheduler paralelo passa a operar após o bootstrap de orquestração: a cada
  cinco segundos e em mudanças de missão/task, ele cria worktrees e panes reais
  para tasks prontas, disjuntas e autorizadas.
- A flag `orch.parallelScheduler` fica ligada na release, mas continua protegida
  por contrato aprovado, plano selado, orçamento de workers e kill switch.
- Tasks concluídas entram automaticamente na MergeQueue serial já existente, com
  validação de contexto, sensores, revisão independente e finalização durável.
- Ownership de diretório cobre arquivos descendentes; self-dependencies,
  dependências desconhecidas e ciclos passam a falhar fechados em vez de travar.
- Metadata de package, server, lockfile, changelog e release notes é alinhada em
  `0.16.1`.

## 0.16.0 — Scheduler Paralelo (dormente), Impeccable Nativa e Auth Portável

Data: 2026-07-14

- Scheduler de tasks paralelo determinístico (ondas prontas+disjuntas por
  worktree, MergeQueue serial, enforcement de ownership fail-closed) entra no
  código atrás da flag `orch.parallelScheduler`, que permanece
  `defaultEnabled=false`: o runtime de fan-out ainda não é acionado e o gate de
  disjunção/DAG tem lacunas conhecidas a fechar antes de ligar.
- Skill Impeccable passa a ser distribuída por padrão — a árvore completa é
  bundlada como asset gerado e espelhada em toda CLI, então agentes têm a skill
  de design em qualquer máquina, sem instalação manual (Apache-2.0,
  pbakaus/impeccable).
- A Design Charter deixa de mandar rodar `impeccable detect` (Impeccable é skill,
  não CLI): invoca a skill se instalada, senão aplica a carta destilada.
- GLM e LongCat rodam o binário do Claude num HOME isolado (`~/.nexus/homes`),
  parando de corromper a sessão OAuth da assinatura Claude (que pedia /login do
  nada).
- Login de kimi/grok/agy feito dentro do pane agora persiste: o overlay efêmero
  faz sync-back das credenciais novas pro HOME real antes de ser purgado.
- Detecção de conta gerenciada do AGY via `GEMINI_CLI_HOME`; homes custom de
  Codex, Grok, Kimi e OpenCode; e PATH de login-shell com segmentos vazios
  filtrados — Nexus enxerga CLIs instaladas out-of-the-box em Macs variados.
- Status do pane não pisca mais entre Pronto/Trabalho (watchdog do hook busy) e o
  botão Instalar espera a sessão PTY viva antes de escrever o comando.
- AGY passa a usar `gemini-3.5-flash-high` e Grok `grok-4.5` como modelo padrão.
- Suíte completa validada: 656 arquivos de teste e 4585 testes passando.

## 0.15.17 — Across Tools e Cockpit Vivo

Data: 2026-07-14

- MCP Across Tools observa configs locais de Nexus, Cursor, Claude Code, Codex,
  OpenCode e Cline, mostrando presença real de servers por ferramenta sem
  retornar segredos.
- Sync fill-gaps nasce fail-closed: dry-run, confirmação, backup antes de write,
  escrita atômica, nada apagado e nada inventado para configs ambíguas.
- `feature.mcp.hub` permanece `defaultEnabled=false`; observe read-only fica
  disponível, mas import/export exige override explícito.
- Settings foi reorganizado em pilares Você, App, Agentes e Sistema, deixando
  Providers, MCPs, Tools, Squads e diagnóstico mais fáceis de achar.
- Home, rail, picker e orquestração ganharam estados vazios narrativos e feedback
  visual leve de missão, respeitando modo sóbrio e reduced motion.
- Contratos compartilhados foram decompostos: ProductApi, identidade de projeto,
  payloads de superfície e IPC de MCP sync saíram do arquivo gigante de tipos.
- Suíte completa validada: 645 arquivos de teste e 4520 testes passando.

## 0.15.16 — Orquestração Enxuta e Voz Reprodutível

Data: 2026-07-14

- Lane de consulta somente leitura completa: escolha no wizard, propagação por
  IPC, gate de ferramentas mutáveis e conclusão condicionada a aprendizado
  durável.
- Encerramento PREVC-safe, estado bloqueado acionável e recuperação com
  `markSubmitted`, sync para pane livre e confirmação de entrega.
- O kickoff permanece proporcional ao objetivo, com proveniência de voz/issue,
  rail glanceable e revisão humana encaminhada ao orquestrador.
- Sync de repositório via pane CLI e correções de dual-audio evitam TTS Classic
  e Gemini falando juntos após uma tool; recovery do orquestrador não faz spam
  no PTY.
- Pet Nico incluído no catálogo embutido; spritesheet validado abaixo de 2,5 MB.
- Pipeline reproduzível de treino de wake PT-BR, testes e documentação de
  arquitetura de voz versionados sem substituir o modelo ativo.
- Painel Source Control contextual com operações Git reais, smoke de workspace
  e scrollbars legíveis; a caixa de notificações permite saltar diretamente ao
  pane que precisa de atenção.
- Onboarding de workspace e presença visual do pet foram polidos com progresso
  explícito, CTA primário e estados online/calibrando, respeitando reduced motion.
- Smoke de release corrigido para os artefatos reais do `node-pty` no Linux e
  para o filtro de caminhos Windows do Forge, evitando pacotes sem o bundle
  principal.

## 0.15.15 — Travas de Autonomia e Revisão Humana de Missão

Data: 2026-07-14

- Trava de autonomia pinada por teste: `defaultDriveConfig` nasce em shadow
  (fail-safe sem settings), congelado e com budgets finitos; a ativação do
  driver continua decisão de runtime via `missionDriverActiveMode`.
- TOCTOU residual do orçamento de workers fechado: a reserva de slot só é
  liberada depois que o worker está durável em `missionPanes` — caso contrário
  permanece retida (fail-safe) com aviso.
- Política "soak antes de default-on" codificada em `docs/OPERATIONS.md`,
  destilada das classes de defeito da wave intent-first de 2026-07-13.
- Rail glanceable: pill entende espera humana ("Aguarda você", "Sem objetivo",
  "Pronta") em vez de esconder tudo como "Na fila"; meta fala "agentes"
  em vez de "panes" e mostra há quanto tempo a missão roda.
- Missão nascida de issue agora é auditável: cliques em issues (rail e painel
  de integrações) fluem `source: 'imported-issue'` até o contrato de intenção;
  objetivos por voz fluem `source: 'voice'`.
- Revisão humana de diff vira entrada de orquestração: as anotações do
  DiffAnnotatePanel são submetidas (paste + Enter) ao ORQUESTRADOR da missão
  ativa — não mais escritas sem envio no worker focado.

## 0.15.14 — Missão Enxuta: Prompt Proporcional e Start em Um Clique

Data: 2026-07-14

- Kickoff intent-first sem duplicação: a memória compacta só entra quando a
  missão tem progresso real, e o critério auto-derivado deixa de reencenar o
  objetivo — missão curta deixa de repetir o goal até 3× no mesmo prompt.
- Cartas de worker em camadas por papel/tarefa: scout/architect não pagam
  cartas de build (~8 KB), reviewer dispensa a escada de diff e a carta de
  design só acompanha tarefas com sinal de UI. Toggles de Configurações
  continuam sendo o gate externo; PREVC, budgets e gates intactos.
- Missão de risco normal inicia em um clique: "Começar missão" compila e
  despacha direto de `ready_to_start`; "Revisar plano" preserva a revisão em
  duas etapas e aprovação sensível/destrutiva permanece obrigatória.
- Wizard fala humano: o estado da fila vira "Processando o objetivo…" em vez
  de `exec=goal_compile:running`, e some quando não há nada em andamento.
- Kickoff legado não trava mais em mapa frio: o warm de orientação tem teto de
  4 s e cai no fallback "mapa aquecendo" (doctor recupera sob demanda).
- Playbook com proporcionalidade explícita: missão pequena é UMA tarefa e UM
  especialista.

## 0.15.13 — Dock-First Keychain-Safe Launch

Data: 2026-07-14

- Remove a consulta síncrona ao macOS Keychain do caminho de boot.
- `safeStorage` continua sendo usado e falha fechado para operações reais de
  credencial, mas não pode mais congelar o thread principal antes de o Dock e
  a janela aparecerem.

## 0.15.12 — Dock-First Visible Launch

Data: 2026-07-14

- Define política de ativação regular no macOS, mostra o Dock e chama
  `win.show()` explicitamente no lançamento.
- A janela deixa de depender do estado de ativação herdado de helpers, deep
  links ou locks de instância antigos.

## 0.15.11 — Dock-First Zero-Block Launch

Data: 2026-07-14

- Move a criação da janela para a primeira operação do callback `app.whenReady`.
- Nem o serviço de energia nem IPC de hooks podem bloquear o ícone do Dock ou a
  janela principal durante o lançamento.

## 0.15.10 — Dock-First Native Window Hardening

Data: 2026-07-14

- Instancia o `BrowserWindow` antes de registrar IPC externo e CSP.
- Falhas de integrações opcionais agora são registradas e não impedem a
  existência da janela nativa e do ícone do Dock.

## 0.15.9 — Dock-First Production Hardening

Data: 2026-07-14

- Endurece o hotfix do Dock: a janela principal é criada como primeira
  operação após `app.whenReady()`, antes de hooks, adapters, banco, keychain ou
  qualquer outra inicialização síncrona.
- Evita que qualquer atraso de bootstrap classifique o app como UIElement sem
  janela visível.

## 0.15.8 — Dock-First Production Hotfix

Data: 2026-07-14

- Corrige o lançamento no macOS: a janela principal e o ícone do Dock são
  criados antes do servidor opcional de hooks de agentes.
- Atrasos, portas ocupadas ou processos auxiliares presos agora degradam em
  segundo plano sem esconder o Nexus ou impedir o uso do aplicativo.

## 0.15.7 — Intent-First Production

Data: 2026-07-14

Esta release reúne o runtime intent-first, as proteções de orçamento e handoff,
o produto wave validado, e as correções de Jarvis, Git, pets e wake que já
estavam na `main`.

Data: 2026-07-13

### Packaged functional smoke
- Probes: `intent-first-settings`, `intent-arm` (awaiting_goal, 0 panes),
  `product-flags` (killSwitch authority visible), `search-mixer-ipc`.
- Checklist: `docs/analysis/2026-07-13-production-confidence-checklist.md`.

### Multi-workspace isolation tests
- Unit gate for SearchMixer-per-root and pane recovery scope filtering
  (stand-in until Playwright multi-window E2E).

### Product wave — shipped behind explicit flags

Data: 2026-07-13

### Shell UX
- Progressive onboarding with **open without AI** default; ModeLauncher
  (Terminal/Missions/Swarm/Board/Memory/Skills); ContextualPanel tabs.
- Progressive launch plan stash/apply after workspace hydrate.

### Editor / Search / MCP / Skills / Memory / Autonomy
- Secure editor model path (CM6 formal eval deferred — docs/EDITOR-CODEMIRROR-EVAL.md).
- SearchMixer live IPC with workspace-bound projectRoot + ripgrep fallback.
- MCP hub backup/drift/mask/rollback; skills lock + symlink-safe catalog;
  `.nexus-memory/` wikilinks; autonomy profiles; agent reap finished-only.

### Security
- Unified scoped-workspace-fs; no startsWith(path.resolve) containment gate.


### Product foundations — shipped behind explicit flags

Data: 2026-07-13

### Product flags remain default OFF
- All product-wave flags (`commandBlocks`, `eventJournal`, `searchMixer`,
  `progressiveOnboarding`, `contextualPanel`, `codemirrorEditor`, `mcpHub`,
  `skillsCatalog`, `nexusMemory`, `autonomyProfiles`) ship with
  `channel=dev` + `defaultEnabled=false` on every runtime channel.
- Explicit persisted overrides may opt in; kill switches still force off.

### Wired end-to-end
- `registerProductWaveIpc` — memory / skills / MCP hub / autonomy / editor / flags.
- Preload + `window.nexus.product` surface.
- App shell: **ModeLauncher** + **ContextualPanel** with Search / Skills /
  Memory / Editor / MCP bodies.
- SearchMixer: ripgrep + skills + mission notes + shallow workspace providers.
- Shell OSC 133 env + bootstrap inject on shell spawn when commandBlocks on.
- Mission driver journal emit with stable logical-tick idempotency.
- Terminal CommandBlock actions IPC + spawn session bind meta.

### Domain contracts
- **CommandBlock** semantic model + OSC 133 scanner + redaction + SQLite store.
- **Mission event journal** append/replay/cursor/ACK.
- **SearchMixer** multi-source cancel/generation/ranking.
- Optional shell integration snippets under `resources/shell-integration/`.

### Docs
- `docs/analysis/2026-07-13-warp-bridgemind-phase0-diagnosis.md`
- `docs/TERMINAL-BLOCKS.md`, `docs/MISSION-EVENTS.md`, `docs/SEARCH-MIXER.md`
- SECURITY, OPERATIONS, MCP-HUB, SKILLS, MEMORY, EDITOR.

### Shell polish (follow-up)
- App body layout restored: mission-rail / files / grid as **direct**
  `.app__body` children so home-deck z-index and flex growth work again;
  ContextualPanel is a flex sibling on the right.
- **Progressive onboarding** mounted as default launch (no workspace); skip
  falls back to classic LaunchScreen; plan applies pane count / mode after
  layout hydrate.

### CommandBlock terminal UI
- Pane toolbar **Cmds** menu lists recent OSC 133 blocks (in-memory tracker).
- Actions: copy command, copy cwd, re-run (via `writeSession` policy).
- IPC `terminal-block:list` + preload `nexus.terminalBlock.list`.

### Mission journal consumer
- IPC `orch:missionEvents.{recent,replay,ack,cursor}` + preload/orch API.
- ContextualPanel **Mission** tab: select mission, list events, ACK cursor.

### Deferred (honest)
- CodeMirror 6 package install; MCP OAuth/SSE live clients; autonomy enforce
  in mcp-dispatch; worktree provider on block actions.

## 0.15.6 — Direct Operations, Voice & Pet Reliability

Data: 2026-07-13

### Jarvis e Git
- “Atualizar/sincronizar/puxar o repositório local com GitHub/origin” agora é
  uma operação direta, sem Doctor, contrato de missão, squad, pane ou terminal.
- A operação valida branch/upstream e arquivos rastreados, faz `fetch --prune`
  e somente aplica `merge --ff-only` quando o checkout pode avançar sem risco.
- Histórico divergente, commits locais, alterações rastreadas, upstream ausente
  ou possível colisão local bloqueiam com recibo claro, sem stage, commit,
  rebase, push ou sobrescrita.
- Missões, preferências do rail e restauração de panes agora são estritamente
  delimitadas pelo workspace atual; uma sessão de outro projeto não volta à tela
  ativa por engano.

### Voz em produção
- O processador PCM de wake e captura passa a ser carregado por `blob:`
  compatível com a CSP do app empacotado. Isso elimina a queda silenciosa para
  ScriptProcessor causada pelo `data:` URL do Vite e registra qualquer fallback
  real no log de voz.
- OpenAI Realtime recebe as mesmas ferramentas curtas de consulta/leitura da
  rota Gemini, para responder estado da tela sem inventar uma ação de UI.
- Quando uma chamada realtime chega durante handoff/encerramento da sessão, a
  Jarvis devolve um resultado explícito ao modelo em vez de deixá-lo esperando
  indefinidamente.

### Integridade
- A rota direta só está disponível à ação iniciada pelo usuário no renderer;
  agentes MCP continuam sujeitos à autoridade de missão.
- Metadados de release e o teste de roteamento da Jarvis foram alinhados com o
  comportamento atual para impedir uma distribuição com testes divergentes.

### Pets
- Avisos do pet não desaparecem mais por tempo: permanecem até uma ação
  explícita no balão ou no próprio pet, e a fila preserva os avisos seguintes.
- Os pets locais aprovados `Nexo` e `Nico Code` agora acompanham a biblioteca
  offline do artefato de release; os pacotes em `~/.codex/pets` continuam
  persistentes entre atualizações.
- Pets criados em spritesheet v2 ganham escala de desktop 20% maior, preservando
  a margem segura do atlas sem ocupar a tela em excesso.

## 0.15.4 — Jarvis Wake Safety

Data: 2026-07-13

### Jarvis em tempo real
- O pre-roll de áudio encaminha apenas a fala contígua ao wake, eliminando o
  contexto ambiente anterior que fazia a Jarvis interpretar televisão ou
  conversa alheia como comando.
- Detectar a palavra de ativação não inicia nem retoma missão: a mudança de
  estado exige um comando explícito do usuário pela rota auditada da Jarvis.
- Comandos de terminal em PT-BR continuam sendo classificados como shell mesmo
  quando trazem acentos nos argumentos. Entradas com quebra de linha são
  bloqueadas antes de qualquer confirmação ou envio ao pane.

### Release
- A distribuição usa a versão `0.15.4`, com os artefatos macOS assinados e
  notarizados no perfil local de produção.

## 0.15.3 — Reliable Orchestration

Data: 2026-07-13

### Ralph Loop, Doctor e panes
- O Mission Driver persiste orçamento, tentativas e receipts PREVC; uma missão
  só termina quando todos os marcos possuem evidência Nexus atual e confiável.
- Sensores e revisão final do autopilot viram handoff idempotente na revisão
  correta. Cada marco consome uma evidência própria, sem reutilização circular.
- Panes mortos são recuperados por identidade estável e CAS. O recap é entregue
  e confirmado na sessão nova antes do rebind, sem matar uma sessão vencedora.
- O Doctor deixa de anunciar travamento por silêncio normal e não encerra panes
  vivos. Timeouts de renderer e main são finitos e auditáveis.

### Jarvis em tempo real
- Wake, seleção de squad e respostas a perguntas de agentes enviam briefing com
  Enter real ao pane correto. Texto natural não é mais tratado como shell.
- O socket Live quente é reconstruído no wake para evitar o estado zumbi visto
  nos logs; áudio pendente atravessa a reconexão e o fallback permanece finito.
- Gemini 3.1 fixa fala em pt-BR e a janela de evidência de áudio acompanha o
  tamanho da resposta antes de recorrer ao TTS Classic.
- Confirmação nativa fica restrita a ações destrutivas ou de publicação; trabalho
  rotineiro dentro do projeto segue diretamente para o squad autorizado.

### Wake PT-BR, pets e release
- `ei-jarvis-ptbr.onnx` segue embutido e agora também é instalado como
  `~/.nexus/models/wake/custom.onnx` para todo cliente, com SHA-256 e escrita
  atômica; um modelo customizado pelo usuário é preservado.
- A release inclui as correções já integradas de preview/compactação da galeria,
  Pet Studio com dependências disponíveis e o alinhamento final do Home Deck.
- App, servidor, lockfile, changelog e notas internas avançam juntos para
  `0.15.3`.

## 0.15.2 — Squad Continuity

Data: 2026-07-13

### Orquestração e Doctor
- O orquestrador conserva uma autoridade estreita de delegação antes do
  contrato congelado. Quando a missão depende do WIP atual, workers operam no
  modo `same_checkout`, sem stash/reset/troca de branch e com apenas um escritor
  ativo por checkout.
- Missões de squad entram em `running` ao serem materializadas. Bloqueio e
  recuperação continuam disponíveis quando o Git impede o freeze, sem liberar
  shell ou edição direta ao coordenador.
- O Context Doctor deixa de esconder falha de commit/binding e retorna a causa
  estruturada. O supervisor conta panes vivos, respeita atividade do
  orquestrador e só classifica o segundo incidente como travamento.
- A primeira recuperação de delegação é não terminal e silenciosa; a Jarvis não
  anuncia mais que o agente sintético de supervisão está travado.

### Jarvis e squads
- “Abrir modo squad” abre o seletor de squads existentes. O passo visível do
  wizard e os nomes salvos entram no contexto de tela para a Jarvis perguntar e
  agir sobre opções reais, sem confundir seleção com criação de squad.
- Comandos já reconhecidos pelo wake/STT seguem direto para o turno Live ou para
  o fallback Classic, eliminando a segunda captura vazia e a resposta tardia.
- Transcrições duplicadas entre realtime e wake passivo são descartadas. Uma
  confirmação pendente ganha autoridade imediata, portanto “sim” e “não” são
  roteados ao gate correto e não somem no filtro acústico genérico.

### Interface e release
- Home Deck alinha títulos, ações e linhas de squad; os chips de frota, cota e
  custo compartilham altura e permanecem em uma única linha.
- O modelo treinado `ei-jarvis-ptbr.onnx` permanece obrigatório e padrão no
  pacote, com manifesto e SHA-256 verificados pelo smoke de produção.
- App, servidor, lockfile, changelog e notas internas avançam juntos para
  `0.15.2`.

## 0.15.1 — Supervision Handoff

Data: 2026-07-13

### Doctor, panes e handoff
- Revisões de contexto usam uma única passagem de até dois minutos, preservam
  o pane quando há timeout e não criam outro revisor enquanto a sessão anterior
  ainda pode ser recuperada.
- O contexto de orientação ignora artefatos internos, lockfiles e saídas de
  runtime, recarrega fontes reais e rejeita rascunhos contaminados antes de
  qualquer aplicação.
- Missões e panes expõem recuperação explícita em vez de fechar ou reenviar
  trabalho automaticamente; o Doctor continua a missão pelo orquestrador após
  as correções, sem ciclos paralelos duplicados.
- Contratos emitidos por orquestradores antigos aceitam o alias `description`
  e normalizam rótulos humanos de artefatos. Drafts aplicados substituídos são
  migrados para `superseded`, evitando loops de commit por atestação obsoleta;
  um Doctor posterior conclui automaticamente o commit quando o Git está limpo.

### Jarvis em tempo real
- “Abrir modo squad” sem nome agora pergunta qual squad salvo deve subir e
  apresenta nomes reais do catálogo; criar/desenhar um squad novo permanece uma
  intenção distinta.
- O contexto estruturado da tela, workspaces e squads é atualizado de forma
  contínua e deduplicada durante a sessão Live. O follow-up permanece autorizado
  por 60 segundos para permitir respostas naturais sem repetir a wake word.
- Cancelamento do provider, interrupção pelo usuário e barge-in antes de efeitos
  não são mais registrados como incidentes. Isso elimina o falso toast do Doctor
  e o anúncio repetido de “supervisão travada”.

### Providers e acessibilidade
- Hub de Providers reorganizado em CLIs, modelos e remotos, com detecção,
  atualização de catálogo e estados operacionais mais claros.
- Tabs mantêm foco por teclado e uma relação ARIA estável com o painel ativo.

### Galeria de pets
- A galeria mostra uma pré-visualização animada antes de aplicar qualquer pet;
  a importação só acontece após confirmação explícita no card selecionado.
- Sheets petdex `8×9` e Codex v2 `8×11` são detectados pelas dimensões reais.
  Assets acima do teto das preferências são compactados mantendo a malha, com
  limite de rede independente de 12 MB.

### Wake PT-BR e release
- `ei-jarvis-ptbr.onnx` passa a ser o wake model padrão de todos os clientes.
  Manifesto com SHA-256 é empacotado junto e o build falha fechado se modelo,
  manifesto ou hash divergirem.
- Versões do app, servidor, lockfile, changelog e notas internas avançam juntas
  para `0.15.1`; dependências nativas opcionais necessárias ao SSH têm scripts
  de instalação explicitamente permitidos.

## 0.15.0 — Autopilot Fleet

Data: 2026-07-13

### Piloto automático e terminais
- Modo autônomo passa a usar a flag nativa correta de cada CLI em todos os
  squads e serviços. O usuário só recebe confirmações interativas quando opta
  explicitamente pelo modo seguro.
- O terminal acompanha a saída em tempo real sem arrancar o usuário de uma
  posição de scroll manual.
- Retomada de panes preserva a sessão e o dono da missão, evita sessões
  obsoletas e não reenvia o mesmo comando.
- O Doctor mede atividade real do PTY, emite um único alerta de travamento e
  nunca fecha, reinicia ou duplica trabalho que continua produzindo saída.

### Pet Studio e desktop pet
- Squad fixo `Pet Studio`, com um único Pet Maker e somente a skill de criação
  de pet, substitui o pipeline de desenvolvimento para missões de imagem.
- A criação usa a imagem anexada, valida o contrato Codex v2 e só conclui a
  missão quando existe um pacote íntegro em `~/.codex/pets`.
- Pets gerados aparecem em `Meus pets`, com preview, aplicação explícita e
  exclusão local segura. O pet em uso nunca é trocado automaticamente.
- Recuperação de missão finalizada encontra pacotes válidos criados durante
  uma interrupção e evita concluir quando a autoria é ambígua.
- O companion atual avisa conclusão, falha e pedidos de intervenção. Eventos
  ocorridos antes do renderer estar pronto ficam em fila e são confirmados
  somente depois de o balão aparecer.
- Posição livre, múltiplos monitores, visibilidade no boot e click-through foram
  estabilizados para o pet não cobrir o trabalho nem sumir da tela.

### Operação da frota
- Uso e cotas reais para Claude, Codex, Gemini/AGY, GLM, Grok, Kimi e demais
  CLIs compatíveis, com janelas normalizadas e estado desconhecido honesto.
- Failover multi-conta preserva o contexto do terminal e escolhe apenas contas
  compatíveis, sem expor credenciais entre providers.
- Mission rail, Ops Board, toolbars, contas, rankings e estados vazios foram
  reorganizados com hierarquia operacional, ações visíveis e navegação por
  teclado.
- Jarvis ganhou continuidade de wake/follow-up, autoridade acústica e painel de
  voz mais legível, sem loops de áudio passivo.

### Confiabilidade e release
- O boot não consulta o Keychain de forma síncrona quando ainda não há sessão
  de autenticação em memória, evitando inicialização aparentemente travada.
- Metadados de versão, lockfile, changelog e notas internas voltaram a avançar
  juntos; o gate impede publicar uma versão com notas divergentes.
- Build macOS mantém retry controlado do timestamp da Apple e verificação
  independente de assinatura, notarização, ticket stapled, fuses e smoke do
  aplicativo extraído do DMG e do ZIP.

## 0.14.3 — Pet Operacional Completo

Data: 2026-07-12

### Desktop pet
- Aviso de intervenção por AGENTE: quando um hook reporta waiting/blocked
  (pedido de permissão/input do Claude/Codex), o pet mostra balão âmbar
  "Um agente precisa de você" com a pose waiting — fecha o ciclo
  terminou/falhou/preciso-de-você por missão E por agente.

- Galeria navegável dentro do app: "Ver galeria…" lista os pets
  publicados no petdex (sitemap ao vivo, cache de 10 min) com filtro e
  import em um clique; URLs com hash (#/pets/slug) agora resolvem e o
  domínio canônico petdex.dev virou a base primária (codex-pets.net
  respondia 404 nos installs).
- Balão no formato Codex: título em negrito + detalhe (nome da missão),
  com clamp de 2 linhas.
- Pet maior (janela 300×270; sheet 152px, pixel 128px) — dá para ver do
  outro lado da sala.
- "Importar spritesheet do Codex…" abre o dialog nativo já em
  ~/.codex/pets (mac/win/linux) com filtro de extensões.
- Pet de imagem: grade 32×32 (muito mais detalhe), feedback de sucesso
  ao criar, e botão × para remover pet criado/importado.

### Teclado
- Cheatsheet de atalhos (⌘/ e entrada "Atalhos do teclado" no ⌘K): todos
  os aceleradores num overlay, sem sair do fluxo.

### Biblioteca embutida (sessão paralela)
- Starter pack offline com 15 sprites Codex v2 em resources/pets,
  aplicáveis com um clique (NOTICE com origem/remoção; arte pertence aos
  autores da comunidade — regularização em andamento).

### Voz e mídia (sessões paralelas)
- Modelo de wake PT-BR calibrado promovido a padrão.
- Catálogo de mídia: Seedream 5.0 Pro, Veo e recuperação de jobs via
  Replicate.

### Build
- Wrapper de retry do codesign versionado em
  scripts/codesign-with-retry.sh + receita no build/notarize.md (o TSA da
  Apple derruba rajadas de --timestamp com muitos nativos unpacked).
- Release `v0.14.3` assinada e notarizada com o perfil `nexus-notary`.

## 0.14.2 — Galeria de Pets

Data: 2026-07-12

### Desktop pet
- Importar da galeria petdex (codex-pets.net / petdex.dev) por slug ou
  URL, direto no Settings → Aparência: o main baixa o spritesheet com
  Referer da galeria, tetos de tamanho/MIME e validação da malha 8×11;
  a arte é por submissão e o import mostra o autor do lado da escolha.
  Testado ao vivo contra a galeria (slug `navi`).
- Arrastar o pet agora mostra a CORRIDA do contrato v2 (linhas
  running-right/left, cadência própria), na direção do movimento — como
  no Codex.
- Pet pixel (Operador e variantes) com muito mais presença: upscale
  nítido sem blur de retina (image-rendering: pixelated), cores mais
  acesas, sombra de assentamento e tamanho maior (112px).

### Build
- Release `v0.14.2` assinada e notarizada localmente com o perfil
  `nexus-notary`.

## 0.14.1 — Navi Segue o Cursor

Data: 2026-07-12

### Desktop pet
- Look mechanics do contrato Codex v2: o pet olha para o cursor na tela
  (16 direções em passos de 22,5°, linhas 9/10 do spritesheet), volta a
  digitar quando o mouse para ou chega perto, e olha neutro dormindo ou
  durante o arrasto. Verificação visual dos estados (look, balões,
  sono) contra o bundle real.

### Build
- Release `v0.14.1` assinada e notarizada localmente com o perfil
  `nexus-notary`.

## 0.14.0 — Mission Control Vivo

Data: 2026-07-12

### Identidade visual
- Nova identidade "mission control": acento ciano operacional (#45d7ff),
  fundo azul-negro mais profundo, grade pixel sutil no Launch/Home e VT323
  nos eyebrows/badges operacionais — a linguagem pixel agora aparece no
  default, não só no modo pixel.
- Novo ícone do app e NexusMark: nó-nexus com núcleo aceso, retícula de
  radar e satélites orbitais (a frota convergindo ao nexo).
- Doutrina de cor aviônica unificada: tokens `--state-*` únicos para
  rail, Ops Board, orch panel, toolbar e borda de pane — trabalhando pulsa
  em ciano, pronto/feito em verde, bloqueado em âmbar, falha em vermelho.
- Derivados do acento (`--accent-soft/strong/hover/glow`) via `color-mix`:
  Dracula/Solarized/light herdam hovers e brilhos corretos; superfícies
  escuras hardcoded convertidas para tokens (tema claro legível em Voice
  Settings, Perfil do Operador e Settings).
- Boot screen com a marca pulsando; toasts, wizard e confirm no mesmo
  dialeto de raio; celebração de tier-up não captura mais o ponteiro.

### Frota visível
- Chip de frota na barra: trabalhando · prontos · dormindo · mortos num
  relance, clique foca quem precisa de atenção (morto primeiro).
- Borda do pane fala: agente ocupado respira ciano, morto tinge de
  vermelho, hibernado fica tracejado — visão periférica de verdade.

### Desktop pet (novo)
- Companion pixel flutuante sobre o desktop: sempre no topo, click-through
  fora do sprite, arrastável com snap de canto e posição persistida.
- Avisa em balão quando missão conclui/falha ou um agente morre; celebra
  quando o trabalho termina; dorme quando você quiser (sem balões).
- Presets do Operador (Ouro, Chama, Centurião, Prestígio), pet
  personalizado pixelizado localmente de qualquer imagem, e suporte a
  spritesheets Codex v2 (8×11) — o pet criado no Codex/hatch-pet funciona
  direto, incluindo os da galeria codex-pets.net.
- Opt-in em Settings → Aparência; fundo sólido para Linux sem compositor.

### Teclado primeiro
- ⌘K command palette: panes, missões e ações com busca sem acento.
- ⌘N nova missão, ⌘1-9 foca o N-ésimo pane; atalhos visíveis nos tooltips
  e no rodapé do Home.

### UX
- Dieta da workspace bar: só Terminal inline + ⋯; OperatorHud (XP) mudou
  para o rodapé do rail — a zona de status é só sinal operacional.
- `window.confirm` nativo eliminado: confirm da casa modal de verdade
  (fila serializada, Esc não vaza para o overlay de baixo, focus trap),
  com rótulos verbo+objeto.
- Resume dirigido por sessão de provider com feedback exact/latest no
  terminal; botão da Jarvis em "mudo" abre os controles em vez de acordar
  sem áudio.

### Correções
- Detector de rate-limit reconhece `rate_limit_exceeded` e
  `RateLimitError` sem recasar prosa de instruções de squad.
- Terminal e janela pré-paint casados com os novos tokens (sem hex-drift).

### Build
- Release `v0.14.0` assinada e notarizada localmente com o perfil
  `nexus-notary` (upload manual — Actions sem créditos).

## 0.13.13 — Account Hot-Swap

Data: 2026-07-12

### Melhorias
- Hot-swap multi-conta com homes e credenciais gerenciados para Codex, Grok,
  Kimi, OpenCode e AGY, preservando a sessão de cada CLI.
- Failover reconhece limites de uso e pode retomar a operação usando uma conta
  reserva compatível.
- Toolbar dos panes ganhou ações rotuladas, tooltips fora da área de corte e
  menu compacto para comandos menos frequentes.
- Seletor de contas informa conta ativa, disponibilidade e reinício necessário
  de forma mais clara.

### Segurança
- Material de autenticação fica isolado por conta e é aplicado apenas ao
  processo da CLI correspondente.

### Build
- Release `v0.13.13` assinada e notarizada com o perfil `nexus-notary`.

## 0.13.12 — Operator UX

Data: 2026-07-11

### Correções
- Pacotes de plataforma do `node-pty` são extraídos integralmente do ASAR,
  incluindo `spawn-helper` no Linux e bindings ConPTY no Windows.

### Build
- Release `v0.13.12` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.11 — Operator UX

Data: 2026-07-11

### Correções
- Smoke runtime resolve o executável `nexus-ide` dentro de DMG, DEB e NUPKG,
  preservando `NexusIDE` apenas como nome visível do produto.

### Build
- Release `v0.13.11` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.10 — Operator UX

Data: 2026-07-11

### Correções
- Smokes Linux e Windows e verificador de entitlements macOS alinhados ao nome
  estável do executável empacotado.

### Build
- Release `v0.13.10` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.9 — Operator UX

Data: 2026-07-11

### Melhorias
- Configurações ganhou localização persistente e ação sempre visível para
  voltar às missões, com suporte ao atalho Esc.
- Login de Claude, Codex, Kimi e demais CLIs apresenta estados explícitos,
  detalhe da verificação e conta usada no próximo terminal.
- Squads ganhou controles consistentes para disciplina sênior, design e código
  enxuto, com textos objetivos e hierarquia de operação.
- Providers, contas, formulários e menus se reorganizam em telas menores sem
  sobreposição, corte de conteúdo ou ações inacessíveis.

### Correções
- Executável Linux alinhado ao nome esperado pelos pacotes DEB e RPM.
- Rebuild nativo de macOS repete downloads transitórios antes de carregar a
  identidade de assinatura.

### Build
- Release `v0.13.9` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.8 — Realtime Operator

Data: 2026-07-11

### Correções
- Gate de release estabilizado para conexões TLS simultâneas do bridge remoto:
  cada cliente usa credencial curta própria, eliminando corrida de expiração em
  runners concorridos sem relaxar a segurança do runtime.

### Build
- Release `v0.13.8` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.7 — Realtime Operator

Data: 2026-07-11

### Melhorias
- Gemini Live pré-aquecido antes do wake, com follow-up contínuo, barge-in e
  rescue local de transcript.
- Jarvis executa ações explícitas de workspace e terminal no pane correto, com
  confirmação nativa e sem voz duplicada.
- Descoberta automática de modelos e efforts publicados pelas CLIs; Codex
  `ultra` aparece nos squads sem lista fixa no Nexus.
- Providers usam o modo automático nativo (`bypass`/`yolo`) por padrão; uma
  escolha manual por modo seguro continua persistida.
- Runtime de áudio com AEC3 e melhorias de pre-roll, cooldown e watchdog.

### Correções
- Sessão Claude Max preservada em workers com `HOME` isolado; elimina falso
  pedido de login nos squads.
- Transcript explícito atualizado antes de validar ações como novo workspace.
- Recuperação de `send_to_pane` para comandos destinados ao terminal focado.
- Status de fala e tool results não permanecem travados após o áudio terminar.
- Novo squad substitui o shell placeholder do workspace, sem terminal vazio.

### Build
- Release `v0.13.7` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.6 — Realtime Continuity

Data: 2026-07-11

### Melhorias
- Wake por voz: VAD passivo (hangover + force-emit de fala real), matcher
  Overclock (`acorda Jarvis`), threshold EN PT-calibrado (0.012 + RMS).
- Realtime full-duplex: mic offer enquanto ela fala; follow-up sem matar
  `realtimeTurnActive`; rescue STT→`liveRescueIn` no path `reply`.
- Hot session: gate anti-TV/ambiente (`isHotSessionCommandCandidate`) —
  não injeta "camelo vindo" / aplausos / música como comando.
- Prompt Live: leis anti-alucinação (só tools com intenção clara; ignore media).
- Paridade Overclock: follow-up sem re-dizer o nome; hot inject só com energia.

### Correções
- `liveInterrupt` soft no-op quando ainda não há owner (wake race).
- Tool follow-up em turno stale reabre continuidade na sessão quente.
- Boot: presença de secrets sem decrypt em massa (Keychain).
- force-emit peak alto o bastante para ignorar ambient contínuo.

### Build
- Release `v0.13.6` (tag dispara CI notarizado).

## 0.13.5 — Operator XP + security hardening

Data: 2026-07-11

### Melhorias
- Gamificação: XP `agent_turn` em cada turno Claude/Codex com output real;
  streak avança no uso quotidiano (não só pipeline/missão/voz).
- Operator FX: toasts "+XP", bursts de TIER-UP / TRANSCENDÊNCIA, achievements;
  HUD com shimmer; respeita reduced-motion e sober mode.

### Segurança
- Git panel: ProcessGitRunner + `assertSafeLocalGitConfig` + `--no-ext-diff`
  (mitiga config maliciosa de repo ao abrir status/diff).
- Browser: redacção de segmentos secretos em URLs; preload allowlist alinhado
  a scroll/press/hover.
- atomic-write: `O_CREAT|O_EXCL|O_NOFOLLOW` + temp name imprevisível.
- provider-config: ignora chaves `__proto__` / `constructor` / `prototype`.
- Teste hermético de known-hosts (pin/match/mismatch).

### Build
- Release arm64 notarizada localmente (`nexus-notary`).
- Windows: aguarda certificado Authenticode (eSigner/OV|IV); não incluído.

## 0.13.4 — Manual Mac notarized build

Data: 2026-07-11

### Melhorias
- Design systems import UI + CSS custom-property sensor (sessões recentes).
- Browser automation: scroll, press, hover.
- SSH: pin de host key (fail-closed em chave alterada).

### Build
- Release arm64 notarizada localmente (`nexus-notary`).

## 0.13.3 — Design systems shipping + Linux packaging

Data: 2026-07-11

### Melhorias

- Design Systems end-to-end: settings UI (designmd.ai), MCP tools, DESIGN.md
  reader, context ingestor adapter, sensor script empacotado.
- `ssh2` como optionalDependency + external no Vite main (desbloqueia package
  Linux; transporte continua injectável).
- Spike documentado para sandbox Windows (Job Object + ACL) antes de Setup
  em produção.

### Correções

- Build Linux não tenta mais bundlar `cpu-features`/`sshcrypto.node`.
- design-send tolera roots sintéticos ao anexar DESIGN.md.

## 0.13.2 — Design systems + CI sandbox gate

Data: 2026-07-11

### Melhorias

- Design systems: leitura de `DESIGN.md` no projeto, cliente designmd.ai e
  tools MCP de search/get/import como drafts de contexto (review obrigatório).
- Design Mode: copiar contexto (dry-run) sem injectar no PTY; prompt enriquece
  com DESIGN.md quando presente.
- CI: probe de sandbox real (bwrap/Seatbelt) e skip de exec sandboxed quando o
  runner bloqueia userns; evidence sintético válido no workflow de contexto.

### Correções

- Gate de qualidade Linux deixa de falhar por `bwrap uid map` / loopback em GHA.

## 0.13.1 — Mission Rail & safe multi-mission

Data: 2026-07-11

### Melhorias

- Activity Rail de missões (pinned / em progresso / fila / done), switcher de
  contas e drag de ficheiros para o agent.
- Multi-missão segura: soft-focus sem kill; merge de panes quando o orquestrador
  entrante não partilha login Claude; kill seletivo só em conflito de keychain.
- Integrações A–C: create PR GitHub, issues no rail, Linear, annotate diffs,
  port-forward local e SSH production (`ssh2`) com remote worktree.
- Jarvis: mute/gate de saída de voz, smoke live com ownership estável e
  avisos legais de terceiros opcionais em Diagnósticos.
- Design Mode: outline verde persistente no elemento selecionado (hover azul
  separado).

### Correções

- Reabrir missão já aberta foca panes vivos em vez de destruir e respawnar.
- Lançar squad em paralelo a outra missão deixa de matar todos os CLI por
  omissão quando não há orquestrador Claude em conflito.

## 0.13.0 — Always Awake

Data: 2026-07-10

### Melhorias

- Jarvis Live passa a configurar explicitamente VAD sensível, interrupção por
  atividade e cobertura somente de fala no Gemini 3.1, preservando compressão
  de contexto e retomada de sessão.
- Wake acústico ganha fallback textual com aliases observados no microfone,
  deadline local de quatro segundos e descarte de resultados tardios; wake
  direto continua disponível durante a fala por verificação STT anti-eco.
- A voz Gemini padrão muda de Charon para Gacrux, com migração apenas do antigo
  default e preservação de escolhas personalizadas.
- Runtime de agentes conecta hooks consentidos de Claude/Codex aos PTYs,
  mantém o Mac/Linux acordado durante trabalho real e registra breadcrumbs de
  crash sem transformar telemetria em evidência de conclusão.
- Harvest ORCA de confiabilidade de terminal: circuit breaker de renderer,
  protocolo binário de stream, scheduler de output com backpressure e
  worktree removal safety com provenance Nexus (MIT, pin 143c36e).
- GitHub/GitLab, terminal remoto, SSH e política de cliente móvel entram como
  fundação escopada. O pareamento usa TLS + prova de posse; E2EE permanece
  explicitamente pendente e não é anunciado como disponível.
- Migrations do servidor endurecidas: `timestamptz` em `cron_schedules` e
  reaper de soft-delete após 30 dias.

### Correções

- O microfone deixa de enviar áudio ao provider enquanto a própria Jarvis ou
  um TTS local ainda toca; drift entre FSM e fila WebAudio também fica coberto.
- A superfície do Gemini Live cai de mais de 60 ferramentas concorrentes para
  ações de voz de alto nível + uma fachada auditada, reduzindo escolhas erradas
  como abrir um squad quando o pedido era criar um.
- Reload/configuração do wake não pode mais liberar sessões ONNX durante `run`,
  eliminando o erro `Cannot read properties of null`.
- Hooks preservam arquivos e backups em modo privado, recebem endpoint/chave de
  sessão no ambiente do PTY e mantêm todos os agentes ativos no keep-awake.
- Replay de frame remoto não reexecuta input; Git remoto cita cada argumento e
  aceita somente subcomandos de escrita explicitamente permitidos.
- Cancelar o diálogo de saída não desmonta o keep-awake; confirmar saída não
  recria a janela e teardown de browser tolera `WebContents` destruído.
- O runtime macOS volta a usar `safeStorage` corretamente e mantém as chaves
  Gemini/OpenAI acessíveis no app assinado.
- O gate Linux instala e empacota Bubblewrap no CI sem fingir que o runner
  hospedado permite user namespaces; execução real continua gate de máquina.

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
