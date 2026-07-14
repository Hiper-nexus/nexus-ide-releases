# Changelog

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
