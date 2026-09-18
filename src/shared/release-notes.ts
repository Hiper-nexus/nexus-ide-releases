export interface ReleaseNote {
  title: string;
  detail: string;
}

export interface AppRelease {
  version: string;
  date: string;
  codename: string;
  summary: string;
  highlights: ReleaseNote[];
  fixes: ReleaseNote[];
}

export const RELEASE_0721: AppRelease = {
  version: '0.72.1',
  date: '2026-09-01',
  codename: 'Grid grande, memória honesta',
  summary:
    'Medimos: 16/32/64 panes sem congelar (a promessa do motor nativo não ' +
    'reproduz aqui). Acima de 24 panes, pane oculto hiberna: só snapshot e ' +
    'saída pendente ficam, e o conteúdo volta ao retornar à tela.',
  highlights: [
    {
      title: 'Hibernação de pane oculto',
      detail:
        'Grids grandes (24+ panes): o que sai da tela descarta o terminal e ' +
        'guarda snapshot (até 256KB) + buffer de saída. Reidratação reusa a ' +
        'trilha provada do restore de layout, com guarda de largura e replay ' +
        'do ring do main.',
    },
    {
      title: 'Benchmark no lugar de opinião',
      detail:
        '32 panes: 926MB RSS, heap 53MB, ~0,5s por pane. Sobreviveu a 64 ' +
        'panes vivos. Números documentados no repo — a conversa Rust ficou ' +
        'sem premissa.',
    },
  ],
  fixes: [],
};

export const RELEASE_0730: AppRelease = {
  version: '0.73.0',
  date: '2026-09-02',
  codename: 'Paridade Overclock 1.33.18 e Super Swarm',
  summary:
    'Incorporação das inovações do Overclock 1.33.18: warm pool de panes CPU-aware (~80ms spawn), ' +
    'session lease registry com startKey anticorrida, handoff mecânico com preservação de fullText e modo attach, ' +
    'squads embutidos qa-swarm, qa-vision, absurd-landing e cinema-site, e expansão da superfície MCP.',
  highlights: [
    {
      title: 'Warm Pool de Panes CPU-Aware',
      detail:
        'Sessões PTY pré-aquecidas sob demanda com validação de liveness, expiração de stale (10min) ' +
        'e reposição assíncrona condicionada a folga mínima de CPU (>=25%).',
    },
    {
      title: 'Lease Registry com startKey',
      detail:
        'Tokens criptográficos de posse física por spawn PTY impedem que requisições lentas de kill ' +
        'destruam sessões recicladas ou reencarnadas concorrentemente.',
    },
    {
      title: 'Delta de Handoff e Modo Attach',
      detail:
        'fullText preservado integralmente até 60KB (com condense determinístico 20k head + 20k tail para textos gigantes) ' +
        'e anexação de múltiplos artefatos por turno sem duplicação de handoffs na base SQLite.',
    },
    {
      title: 'Presets de Squads e Superfície MCP',
      detail:
        'Presets builtin qa-swarm (10 regras L0-L2), qa-vision (protocolo F-XXX), absurd-landing e cinema-site com skills guiadas. ' +
        'Novas ferramentas MCP: aliases cron persistentes, lint/format de recipes de squad e telemetria perf_events.',
    },
  ],
  fixes: [
    {
      title: 'Proteção contra corridas de fechamento de pane',
      detail:
        'nexus_pane_close agora aceita startKey e valida ownership antes de finalizar processos de sessão.',
    },
  ],
};

export const RELEASE_0740: AppRelease = {
  version: '0.74.0',
  date: '2026-09-03',
  codename: 'BridgeSpace 3.4.18 Parity & Autonomous Swarm Engine',
  summary:
    'Port completo dos 10 domínios do BridgeSpace 3.4.18: design tokens com elevação glass/depth hierarchy, ' +
    'terminal ghost assist com refinery assist, shell integration para macOS login shell (.zprofile) e OSC 9;9, ' +
    'drop-box watcher de agent hooks com ingest offline tolerante a falhas, swarm mailbox com escrita transcript-first ' +
    'e anti-social chatter filter, knowledge graph MCP com detecção de órfãos e sugestão de conexões, e sentinela de sobrevivência de sessão.',
  highlights: [
    {
      title: 'Design Tokens & Glass Depth Hierarchy',
      detail:
        'Hierarquia de profundidade em 3 níveis (--shadow-card-rest, focus, drag), tokens semânticos de blur e raio, ' +
        'classes surface-card e modal-radial-halo para consistência visual sem dependência de Tailwind arbitrário.',
    },
    {
      title: 'Terminal Ghost Assist & Refinery',
      detail:
        'Sugestões inline com posicionamento tipográfico por célula (xterm render service), aceitação via Tab e Right Arrow, ' +
        'aceitação por palavra via Option+Right Arrow, cancelamento no Escape e integração com o Command Refinery.',
    },
    {
      title: 'Shell Integration Hardened (macOS Login Shell & OSC 9;9)',
      detail:
        'Geração de .zprofile sob ZDOTDIR customizado para herdar /etc/zprofile e path_helper no macOS (-l), ' +
        'e notificação de troca de diretório atual via OSC 9;9 com parsing robusto.',
    },
    {
      title: 'Agent Hooks Drop-Box Watcher',
      detail:
        'Canal resiliente de drop-box em disco (~/.nexus/agent-hooks/global/) com escrita atômica, normalização de status ' +
        'e ingestão com fallback quando o socket HTTP do hook server estiver momentaneamente saturado.',
    },
    {
      title: 'Swarm Mailbox & Scope-Freeze',
      detail:
        'Protocolo de mensageria multi-agente transcript-first (escrita do log antes do inbox) com limite de até 40 arquivos ' +
        'por worker, limite de ciclos de revisão antes de escalonamento para o operador e filtro de ruído anti-social.',
    },
    {
      title: 'Knowledge Graph MCP & Backlinks',
      detail:
        'Ferramentas nexus_memory_backlinks, nexus_memory_orphans e nexus_memory_suggest_connections ' +
        'com suporte a wikilinks com alias [[Title|Alias]] e pontuação de similaridade semântica de tokens.',
    },
    {
      title: 'Session Alive Sentinel & Detecção de Queda',
      detail:
        'Heartbeat atômico contínuo registra memória RSS arredondada, panes ativos e flag de expectedExit, ' +
        'permitindo recuperação automática e diagnóstico de saídas anômalas no próximo boot.',
    },
  ],
  fixes: [
    {
      title: 'Prevenção de travamento na ingestão de hooks',
      detail:
        'Processamento particionado em lotes de 100 arquivos com debounce para não bloquear o event loop em rajadas.',
    },
    {
      title: 'Compatibilidade com Electron powerSaveBlocker em testes',
      detail:
        'Chamadas ao blocker em agent-awake-service tornadas opcionais para execução segura em ambientes headless.',
    },
  ],
};
export const RELEASE_0741: AppRelease = {
  version: '0.74.1',
  date: '2026-09-03',
  codename: 'Operador no controle',
  summary:
    'O runtime não decide mais pelo operador: pane criado na vista da missão monta ao lado ' +
    'dos panes dela, workers só encerram após "Marcar como feito", "Pedir um ajuste" religa ' +
    'o Maestro digitável esperando a orientação, revisão read-only paraleliza, catálogo com ' +
    'glm-5.3-flash, claude-fable-5-1/mythos-5-1 e gpt-6-astra, e auditoria de robustez main/preload/voz.',
  highlights: [
    {
      title: 'Pane do operador na vista da missão',
      detail:
        'Abrir Terminal pelo "+ Pane" (grid) ou "+ terminal" (canvas) dentro dos Terminais ' +
        'da missão fixa o pane novo na vista — antes ele nascia invisível, sem PTY. ' +
        'spawnAgent com garantia anti-pivô-fantasma.',
    },
    {
      title: '"Pedir um ajuste" espera você',
      detail:
        'Reabrir missão concluída religa o Maestro para ouvir, não para re-executar: hold na ' +
        'first-wave, no flush de retries do fail-closed e ordem de espera no prompt. ' +
        'Teardown de workers só após a aprovação.',
    },
    {
      title: 'Catálogo de modelos em dia',
      detail:
        'glm-5.3-flash, claude-fable-5-1/mythos-5-1 e gpt-6-astra selecionáveis (trusted-access ' +
        'fora do roteamento automático); preço do flash no estimador de custo.',
    },
  ],
  fixes: [
    {
      title: 'Auditoria main-process e preload',
      detail:
        'Deep-link com path malformado vira link inválido em vez de URIError; protocolo do ' +
        'renderer lê do mesmo fd com re-resolve (TOCTOU); listeners do preload com entrega ' +
        'isolada; erro ao encerrar Live registrado e exposto na store.',
    },
  ],
};
export const RELEASE_0742: AppRelease = {
  version: '0.74.2',
  date: '2026-09-04',
  codename: 'Pane abre, login aparece',
  summary:
    'Abrir pane manual funciona em todas as CLIs (inclusive sem catálogo de modelos) e ' +
    'sessão expirada aparece onde o operador olha: status e botão "Entrar novamente" na ' +
    'linha do provider, badge na conta, e toast de failover com ação para Providers. ' +
    'Disjuntor trava o 401-loop multi-conta na 2ª morte instantânea seguida.',
  highlights: [
    {
      title: 'Pane manual em todas as CLIs',
      detail:
        'Builder único do payload de spawn limpa strings vazias que o validador ' +
        'rejeitava (o caso do muse sem catálogo); erro de validação agora cita o ' +
        'campo. As 11 CLIs cli-pty instaladas abrem pane com PTY.',
    },
    {
      title: 'Sessão expirada visível com re-login',
      detail:
        'Conta com renovação de token falhando ganha status "sessão expirada", CTA ' +
        '"Entrar novamente" na linha do provider e na conta, botão "Usar" bloqueado ' +
        'e chip do switcher sem o falso "pronta". A falha de refresh avisa a UI ' +
        'aberta na hora, sem esperar o próximo 401.',
    },
    {
      title: 'Disjuntor do 401-loop multi-conta',
      detail:
        '1ª morte instantânea de auth ainda troca de conta (caso legítimo); a 2ª ' +
        'seguida trava o failover com diagnóstico, e o toast leva a Providers ' +
        'com um clique.',
    },
  ],
  fixes: [
    {
      title: 'Handoff sem eco acumulado',
      detail:
        'Packs de failover anteriores impressos no scrollback são podados do ' +
        'excerpt — o prompt de continuidade para de crescer a cada ciclo.',
    },
  ],
};
export const RELEASE_0743: AppRelease = {
  version: '0.74.3',
  date: '2026-09-04',
  codename: 'Sem conta morta selecionável',
  summary:
    'Sessão expirada não entra em nenhum seletor: Maestro governado pula a ' +
    'conta morta nos 3 degraus, default do orquestrador não fixa, linha de ' +
    'cota e picker nomeiam. A sidebar ganha o botão Nova missão.',
  highlights: [
    {
      title: 'Nova missão na sidebar',
      detail:
        'Cartão hero no topo do rail abre o fluxo simples (rascunho limpo + ' +
        'setup) no workspace atual.',
    },
    {
      title: 'Seletores ignoram sessão expirada',
      detail:
        'Maestro, default do orquestrador, linha de cota e picker tratam a ' +
        'conta morta com nome e bloqueio — e o erro do Maestro cita o ' +
        're-login em Providers.',
    },
  ],
  fixes: [
    {
      title: 'Resets do code-review',
      detail:
        'Cura do refresh emite onChanged, re-login zera o disjuntor do ' +
        '401-loop e todo trip emite evento (o toast deduplica no lugar).',
    },
  ],
};
export const RELEASE_0744: AppRelease = {
  version: '0.74.4',
  date: '2026-09-04',
  codename: 'Sidebar Orca, Grid Livre e Digitação Desbloqueada',
  summary:
    'Sidebar cockpit no padrão Orca com gauges e árvore de agentes viva, grid de ' +
    'terminais dinâmico com seletor de quantidade (1 a 6 ou custom), digitação ' +
    'do operador 100% liberada no PTY sem travas por status de missão, e paridade ' +
    'com modelos e flags 2026 (Grok 4.6, Gemini 3.8 Flash/Pro, Claude Opus 5).',
  highlights: [
    {
      title: 'Sidebar Cockpit no padrão Orca',
      detail:
        'Rail integrado com gauges de cotas de IA, indicador de Git branch ativo, ' +
        'árvore de subagentes com LEDs de atividade e atalho direto para o grid.',
    },
    {
      title: 'Grid de Terminais com Seletor de Quantidade',
      detail:
        'Diálogo modal para abrir 1, 2, 3, 4, 6 ou número customizado de terminais, ' +
        'com promoção de qualquer pane para orquestrador na toolbar e context menu.',
    },
    {
      title: 'Digitação do operador 100% desbloqueada',
      detail:
        'O operador humano no teclado físico tem autoridade incondicional de digitação; ' +
        'missões com erro nunca mais bloqueiam o terminal PTY ativo com mensagens de recusa.',
    },
    {
      title: 'Paridade de modelos e flags 2026',
      detail:
        'Suporte aos modelos grok-4.6, gemini-3.8-flash-high e flags não-bloqueantes ' +
        '(--permission-mode plan, --mode plan, --effort).',
    },
  ],
  fixes: [
    {
      title: 'Fim do deadlock de dispatch de missões',
      detail:
        'O intent gate agora aceita transição de pending para running e autoriza ' +
        'o spawn de workers no próprio grid do Nexus sem recorrer a terminais externos.',
    },
    {
      title: 'Contas e login (F-114)',
      detail:
        'Erro 401 não exibe mais falsamente como "esgotada" e o botão "Entrar novamente" ' +
        'fica sempre visível para reautenticação imediata.',
    },
  ],
};
export const RELEASE_07613: AppRelease = {
  version: '0.76.13',
  date: '2026-09-10',
  codename: 'Pane não morre no trust, o assento é do CLI que você pediu',
  summary:
    'O diálogo de confiança do Claude Code 2.1.267 deixava de ser respondido — pior: a tecla que o app mandava encerrava o pane. O assento de um pane era decidido por uma leitura de credencial em cache, então pedir Kimi podia abrir Claude sem aviso nenhum; agora a credencial é sondada na hora e a troca, quando acontece, aparece na tela. O logo do provider passa a sobreviver em pane estreito, e entram o GLM Flash e o Devin.',
  highlights: [
    {
      title: 'A troca de assento aparece',
      detail:
        'Quando o CLI pedido não senta e outro assume o pane, o app avisa com o nome dos dois e um atalho para Providers — antes a troca existia só num log do processo principal.',
    },
    {
      title: 'O logo da IA sobrevive a pane estreito',
      detail:
        'Abaixo de 380 px o badge do agente era escondido inteiro e não havia como saber qual modelo estava em cada pane. Agora só o texto sai; o logo fica em qualquer largura.',
    },
    {
      title: 'GLM Flash',
      detail:
        'Adapter dedicado (binário do Claude Code contra a z.ai) com upstream próprio, quatro slots pinados em glm-5.3-flash[1m], aliases de credencial, catálogo, quota e logo próprios.',
    },
    {
      title: 'Devin CLI',
      detail:
        'Adapter embutido como worker, com receita de instalação, sonda de autenticação, credencial gerenciada e logo.',
    },
    {
      title: '+ Pane virou um índice de CLIs',
      detail:
        'Uma linha por provider com logo, meta e chevron; a matriz conta×modelo aparece no drill-in. Grok e as demais CLIs deixam de ficar enterradas sob dezenas de linhas de conta.',
    },
    {
      title: 'Ranking de modelos por família',
      detail:
        'Famílias frontier (Fable/Mythos/Astra) passam acima do Opus, e modelos api-only ganham o selo "restrito" — continuam fora do auto-routing.',
    },
  ],
  fixes: [
    {
      title: 'Pane travava — ou morria — no "Yes, I trust this folder"',
      detail:
        'O Claude Code 2.1.267 tirou a numeração das opções e deixou o cursor parado em "No, exit". O autoresponder mandava "1" (ignorado) seguido de Enter, que confirmava o cancelar e encerrava o pane. A resposta agora é lida da própria tela: se o aceite está abaixo do cancelar, o pane desce antes de confirmar; se a tela não prova qual item está focado, o app não digita nada e deixa a decisão com você.',
    },
    {
      title: 'Pedir Kimi abria Sonnet',
      detail:
        'O gate pré-spawn decidia o assento do Kimi por uma cache de processo que só era aquecida em Configurações › Contas, kickoff e bootstrap — nunca no spawn direto do operador. Cache fria virava "sem credencial" e a cadeia de sucessão sentava o Claude. Agora a sonda "kimi provider list" roda na hora do spawn e o binário é resolvido por caminho absoluto, sem depender do PATH do app.',
    },
  ],
};
export const RELEASE_07612: AppRelease = {
  version: '0.76.12',
  date: '2026-09-10',
  codename: 'impeccable 0.1.5 executável, skills que se atualizam e o pane do macOS 27',
  summary:
    'O impeccable 0.1.5 entra embutido no Nexus como CLI empacotado e passa a rodar de verdade dentro dos panes; as skills instaladas se atualizam sozinhas a cada spawn de agente, sem apagar nada que o usuário escreveu; e o supervisor de PTY para de rejeitar o perl do macOS 27, que zerava todos os panes no app empacotado.',
  highlights: [
    {
      title: 'impeccable 0.1.5 embutido e executável',
      detail:
        'O skill agora traz o CLI empacotado (launcher + binário darwin-arm64 + índice de fontes) em vez de scripts soltos: os verbos do SKILL.md chamam o binário direto, e ele executa no pane.',
    },
    {
      title: 'Skills instaladas se atualizam sozinhas',
      detail:
        'As skills embutidas (impeccable, archify, bmad-templates, superpowers, dembrandt) são sincronizadas na cópia de cada CLI a cada spawn de agente, então uma instalação antiga recebe a versão nova sem reinstalar o app.',
    },
    {
      title: 'Nada seu é apagado na atualização',
      detail:
        'A sincronização só remove o que o próprio Nexus escreveu, comprovado por um registro com o hash de cada arquivo entregue. Skill que você criou, ou arquivo que você editou, fica intacto.',
    },
    {
      title: 'Cache de skills podada e íntegra',
      detail:
        'A cache de skills do app deixa de acumular arquivos de versões antigas, o que impedia instalações novas de receberem um hibrido entre a versão velha e a nova.',
    },
    {
      title: 'Pane volta a abrir no macOS 27',
      detail:
        'O supervisor de PTY passa a identificar a arquitetura do processo vivo ao validar o perl do sistema, aceitando o binário de 3 slices que o macOS 27 introduziu.',
    },
  ],
  fixes: [
    {
      title: 'Todo pane morria no app empacotado do macOS 27',
      detail:
        'O macOS 27 deu um terceiro slice ao /usr/bin/perl e o supervisor comparava o hash de um slice diferente do que o kernel carrega, recusando o lançamento com "stage0: helper exited before authenticated exec". Agora a validação é feita na arquitetura que o processo realmente executa, o que também fecha um buraco latente no Rosetta.',
    },
    {
      title: 'O impeccable entregue não executava',
      detail:
        'O bundling de skills gravava tudo com permissão de leitura, então o CLI do impeccable chegava ao pane sem poder rodar. O bit de execução agora faz parte do pacote e é reparado mesmo quando o conteúdo já estava certo.',
    },
    {
      title: 'Instalação nova recebia um impeccable híbrido',
      detail:
        'Arquivos removidos da fonte sobreviviam na cache e vazavam para instalações novas. A cache passa a ser podada contra o conteúdo realmente embutido.',
    },
  ],
};
export const RELEASE_07611: AppRelease = {
  version: '0.76.11',
  date: '2026-09-09',
  codename: 'Stage Focus, Síntese DAG, Roteador por Especialidade e Jarvis Instantâneo',
  summary:
    'Modo Stage Focus (Cmd+Shift+F) com painel principal e companion rail interativo; Context DAG sintetizando conquistas, bloqueios e próximos passos nos handoffs; sensor mecânico de cobertura adversarial; roteamento inteligente por especialidade nas CLIs; e Jarvis com execução por voz imediata.',
  highlights: [
    {
      title: 'Stage Focus Mode (Cmd+Shift+F)',
      detail:
        'Foco visual imersivo no terminal ativo (72%) acompanhado por uma coluna lateral com cards interativos de todos os outros agentes vivos.',
    },
    {
      title: 'Context DAG nos Handoffs de Workers',
      detail:
        'Handoffs automáticos entre trabalhadores e Maestro agora estruturam causalmente o fio da meada: accomplished, blockers, next_steps e contexto relacional.',
    },
    {
      title: 'Sensor Mecânico de Cobertura de Testes',
      detail:
        'Pair review adversarial automático que verifica a existência de testes irmãos para cada arquivo de código alterado antes do aceite da tarefa.',
    },
    {
      title: 'Roteador por Especialidade no "+ Pane"',
      detail:
        'Busca inteligente e catalogação por capacidades operacionais (frontend, lógica, contexto, raciocínio e rápido) nas opções de spawn de agentes.',
    },
    {
      title: 'Jarvis Direto: Execução sem Hesitação',
      detail:
        'Execução por voz imediata com feedback sonoro responsivo para comandos locais e encaminhamento ágil de intenções operacionais.',
    },
  ],
  fixes: [
    {
      title: 'Contrato de Manifestos Herdr (F-349)',
      detail:
        'Contagem e carregamento de manifestos atualizados para refletir a consolidação da CLI Google em AGY.',
    },
    {
      title: 'Correção de dependência toml',
      detail:
        'Atualização do smol-toml para 1.8.0, eliminando alertas de segurança em dependências de produção.',
    },
  ],
};
export const RELEASE_07610: AppRelease = {
  version: '0.76.10',
  date: '2026-09-09',
  codename: 'Modo vibe sem cabresto, paste humano em pane governado e Kimi desbloqueado',
  summary: 'O operador tem modo vibe completo para criar, editar, rodar comandos e commitar sem burocracia de missão; paste humano (Ctrl+V) aceito em panes governados; Kimi Code 0.41+ responde a tela de confiança; e a missão aprovada ganha paridade com o modo vibe.',
  highlights: [
    { title: 'Modo vibe completo para o operador', detail: 'Pane do operador aberto sem missão pode rodar terminal_run, file_write, git_commit e PRs diretamente pelo MCP sem barreira de intent gate ou modal de confirmação. A auditoria completa segue registrada e texto destrutivo ganha aviso no log.' },
    { title: 'Paridade de missão aprovada (zero fricção)', detail: 'Missões com contrato aprovado não travam mais em modais destrutivos para comandos de código — o preparo de reversibilidade continua protegendo em segundo plano sem interromper a execução.' },
    { title: 'Paste humano (Ctrl+V) em panes governados', detail: 'A digitação do operador através do xterm agora aceita bracketed paste sem que o backend recuse o envio como injeção orquestrada.' },
  ],
  fixes: [
    { title: 'Kimi Code 0.41+ não fica mais mudo', detail: 'A tela de seleção “Trust this folder?” é respondida automaticamente no boot pelo autoresponder do PTY, evitando que prompts iniciais sejam engolidos.' },
    { title: 'Digitação em panes filhos abertos por agentes', detail: 'Panes governados spawnados sem missão passam a aceitar a digitação direta do operador, eliminando o comportamento de terminal travado.' },
    { title: 'Ferramentas de pane sem modal repetitivo', detail: 'Operar panes (fechar, escrever, perguntar) pela mão do usuário sem missão não abre mais modal de confirmação a cada chamada.' },
    { title: 'Codex abre no modelo de ponta', detail: 'O default de produto deixa de depender do fallback nativo 5.5 e passa a selar gpt-5.6-sol no pane, no squad, no Pet Studio e no roteamento difícil.' },
    { title: 'Uma CLI Google: Antigravity', detail: 'Gemini CLI deixa de ser instalada, descoberta ou exibida como adapter separado em favor de AGY/Antigravity; modelos gemini-* continuam disponíveis dentro dele.' },
  ],
};
export const RELEASE_0769: AppRelease = {
  version: '0.76.9',
  date: '2026-09-09',
  codename: 'O picker mostra o mais forte primeiro, e o rail mostra onde você está',
  summary: 'O "+ Pane" agrupa por conta e ordena CLIs e modelos pela força operacional; o rail marca o projeto aberto; e uma pasta apagada com o app aberto passa a ser dita, não um ENOENT cru.',
  highlights: [
    { title: 'Conta por fora, modelo por dentro', detail: 'Cada CLI agrupa por conta (conta A, conta B) com o estado da conta em chip — ativa, sessão expirada, em pausa, sem credencial — em vez de intercalar conta×modelo. Sem conta salva, o bloco diz que a CLI usa a credencial ativa dela.' },
    { title: 'O mais forte primeiro', detail: 'CLIs seguem a preferência operacional; dentro delas, capacidade e família vêm antes da geração embutida no id, e utilizáveis ficam antes dos restritos. Contas ativas sobem e sessões indisponíveis descem. Chips de faixa (Profundo · Equilibrado · Rápido), padrão da CLI e acesso restrito continuam pesquisáveis.' },
    { title: 'Selo ATUAL no projeto aberto', detail: 'A linha do projeto em uso leva selo e borda de acento, independente do que está selecionado — selecionar a missão de outra pasta não apaga onde você está.' },
  ],
  fixes: [
    { title: 'Codex abre no modelo de ponta', detail: 'O default de produto deixa de depender do fallback nativo 5.5 e passa a selar gpt-5.6-sol no pane, no squad, no Pet Studio e no roteamento difícil. O gpt-6-astra permanece disponível para seleção explícita enquanto estiver marcado como rollout restrito.' },
    { title: 'Uma CLI Google: Antigravity', detail: 'Gemini CLI deixa de ser instalada, descoberta ou exibida como adapter separado. O produto mantém somente AGY/Antigravity; modelos gemini-* continuam disponíveis dentro dele. Squads e hooks antigos são migrados na entrada para não quebrar trabalho salvo.' },
    { title: 'Pasta apagada com o app aberto', detail: 'Worktree removido por outra ferramenta deixava todo pane novo morrer com ENOENT cru. Agora o pane explica e aponta a saída; o Nexus sonda a pasta ao focar a janela e a cada spawn que cai por isso, avisa uma vez, o rail troca ATUAL por “pasta sumiu”, o cabeçalho ganha o chip e o toast oferece “Abrir outra pasta”. O workspace não é fechado sozinho.' },
  ],
};
export const RELEASE_0768: AppRelease = {
  version: '0.76.8',
  date: '2026-09-09',
  codename: 'A lista de projetos para de encolher, e o pane do operador manda',
  summary: 'O rail dá espaço aos projetos, cada pasta mostra o caminho que a distingue, e um terminal aberto por você abre, vê e fala com outros panes sem precisar de missão.',
  highlights: [
    { title: 'Seu pane abre e vê outros panes sem missão', detail: 'Terminal aberto pela opção de pane pode spawnar outros (inclusive por nome de agente do roster), listá-los e mandar texto para eles. Antes tudo isso caía em “mission effect blocked” e a lista voltava vazia até para o próprio pane. Worker e orquestrador seguem presos à missão.' },
    { title: 'Descartar a missão não esteriliza o pane', detail: 'A promoção user → orchestrator era de mão única: quem criava e descartava uma missão nunca mais conseguia criar outra naquele pane.' },
    { title: 'Árvore de spaces no rail', detail: 'A branch do worktree é o nó da árvore, com a missão embaixo; missão sem worktree fica direto sob o projeto. Projetos recolhíveis com memória; ações de linha só no hover.' },
    { title: 'Projetos com piso de altura', detail: 'A lista de projetos era a única faixa elástica do rail; numa janela de 700px sobrava uma linha e meia. Agora ela tem piso e quem cede altura é a manutenção: em 700px são 4 pastas visíveis no lugar de 1.' },
    { title: 'Pasta identificável', detail: 'Cada projeto mostra o menor trecho do caminho que o distingue dos outros abertos: dois `web` viram “…/lupygo/apps/web” e “…/volare/apps/web”, enquanto um nome único fica curto.' },
    { title: 'Largura do rail é sua', detail: 'Arraste a borda entre 200 e 280px, ajuste pelo teclado ou volte ao padrão com duplo clique. A escolha persiste entre sessões.' },
    { title: 'Cotas e limpeza saem da frente', detail: 'Limpar projeto volta a ser recolhido, e o cartão de cotas some em janelas baixas — os dois continuam a um clique, sem disputar a altura da navegação.' },
  ],
  fixes: [
    { title: 'Pane aberto no Início nasce sozinho', detail: 'Pane criado com o canvas de terminais oculto ficava em branco para sempre: o spawn adiado só era retomado pelo ResizeObserver. Agora há retentativa própria até o slot ficar mensurável.' },
    { title: 'Drop de endereço no pane', detail: 'file:// vindo de app nativo ou link http(s) solto no terminal vira arquivo em mission-context (14 MB, 20 s) com o caminho colado no PTY.' },
    { title: 'Broadcast com recibo por alvo', detail: 'nexus_pane_write_many devolve submitted | skipped (pane_dead | agent_not_ready | pane_hibernated) | failed por pane; morto nunca recebe, recusa de um não para os outros.' },
    { title: 'Quadro por status derivado', detail: 'Construindo · Validando · Precisa de você · Pronto + gaveta Arquivo. Falha e sucesso não dividem mais coluna; bloqueada aparece onde precisa de você. Lane é derivada do estado, sem arrastar.' },
    { title: 'Inspector com largura sua e trilho de volta', detail: 'Largura ajustável (360–440 px) persistida; recolhido deixa um trilho de 8 px que reabre por clique, arraste ou teclado.' },
    { title: 'Recusa que ensina o caminho', detail: 'Efeito sem missão agora diz o que funciona — handoff sem missão aponta para nexus_pane_write/nexus_pane_ask ou nexus_mission_create — em vez de listar campos internos.' },
    { title: 'Imagem colada não duplica mais', detail: 'O mesmo print chegava pelos dois acessores do clipboard com carimbos de tempo a um milissegundo de distância, escapava da deduplicação e era anexado duas vezes.' },
    { title: 'Arraste sem arquivo deixa de ser silêncio', detail: 'Soltar no terminal algo que não trouxe arquivo — promessa não materializada por app nativo, link ou só texto — agora diz o que chegou em vez de não fazer nada.' },
  ],
};
export const RELEASE_0767: AppRelease = {
  version: '0.76.7',
  date: '2026-09-08',
  codename: 'Space que avisa',
  summary: 'Ditado por Space desarmado mostra toast acionável em vez de morrer em silêncio; copy do preset corrigida.',
  highlights: [
    { title: 'Space desarmado avisa', detail: 'Segurar Space com atalho global ou captura bloqueada mostra toast ("Ditado por Space desarmado") com atalho para Configurações → Voz — 1x por pressionamento, com throttle e dedupe.' },
  ],
  fixes: [
    { title: 'Copy do preset Ditado EN', detail: 'O texto dizia que Space não digitava espaço; o correto (discriminador hold) é: toque rápido digita, só o SEGURAR dita.' },
  ],
};
export const RELEASE_0766: AppRelease = {
  version: '0.76.6',
  date: '2026-09-08',
  codename: 'Failover que assenta e voz que mostra',
  summary: 'Failover multi-conta para de queimar sessões em credencial morta e de entrar em ping-pong com 401 citado; HUD de voz ganha barrinhas de nível do mic durante a captura.',
  highlights: [
    { title: 'Failover sem storm (F-511)', detail: 'Conta Claude secundária com token vencido e sem refresh é pulada no pick e recusada no prepare com motivo acionável; vencida-mas-curável renova no momento do pin. O excerpt do pack de failover é sanitizado para o 401 citado nunca re-disparar o detector.' },
    { title: 'Barrinhas de captura', detail: 'O HUD mostra 7 barras do nível real do mic enquanto escuta (ditado Space e Jarvis) — prova explícita de que está capturando.' },
  ],
  fixes: [
    { title: 'Rajadas compartilham UM alvo', detail: 'Com o switch assíncrono, o coalesce passa a registrar provisório no pick: panes da mesma rajada voltam a convergir para a mesma conta.' },
  ],
};
export const RELEASE_0765: AppRelease = {
  version: '0.76.5',
  date: '2026-09-08',
  codename: 'Multi-conta e panes que respondem',
  summary: 'Providers e menu de panes com quantas contas você quiser por CLI, Muse na lista de adapters, e quatro correções de sessão: Claude Max reconhecido no app, Grok sem loop de login e pane pós-missão que sempre responde.',
  highlights: [
    { title: 'Multi-conta de verdade', detail: 'Providers ganha cadastro de segunda (e N-ésima) conta por CLI — Codex incluso — com escolha A/B/N no menu de panes e prova de login novo por baseline e identidade de sessão: fechar ou estourar o tempo nunca conta como sucesso.' },
    { title: 'Muse entra na lista', detail: 'O adapter Muse passa a carregar (manifesto completado e validado): aparece em Providers, Contas e Cotas, detecta a sessão OAuth e abre o login pelo terminal.' },
    { title: 'Claude Max reconhecido', detail: 'O app empacotado lia o Keychain e confundia negação de leitura com logout. Agora pergunta à própria CLI (`claude auth status`) quando o storage falha — positivo só com atestação viva.' },
    { title: 'Grok sem loop de login', detail: 'Conta gerenciada com credencial expirada sombreava a sessão nativa válida e forçava device-login a cada abertura. O overlay agora prefere a sessão nativa fresca da mesma conta.' },
  ],
  fixes: [
    { title: 'Pane pós-missão nunca mudo', detail: 'Teclar num orquestrador encerrado após o done sempre responde: confirma a tentativa de religar ou orienta com Reiniciar — repetir tecla no cooldown não some mais em silêncio.' },
  ],
};
export const RELEASE_0764: AppRelease = {
  version: '0.76.4',
  date: '2026-09-07',
  codename: 'Tema claro de verdade',
  summary: 'O tema claro passa a ser claro por inteiro, e seis caminhos que podiam perder o que você escreveu ou concluir sem verificar foram fechados.',
  highlights: [
    { title: 'Tema claro completo', detail: 'Cartões, rail, filtros e o gutter do diff ganham superfícies próprias no nexus-light, e as cores de estado passam a ser legíveis sobre fundo claro. Antes o tema herdava as superfícies quase pretas do Pink City e os pontos de estado ficavam abaixo do contraste mínimo.' },
    { title: 'Sua ideia não some', detail: 'Escrever antes de escolher a pasta e depois escolher uma pasta que já tem rascunho mantém os dois textos. Antes o que você digitou era descartado em silêncio, sem aviso e sem como desfazer.' },
    { title: 'Revisão protegida', detail: 'Uma tecla num terminal de missão concluída, mas ainda não revisada, não desfaz mais o vínculo entre o painel e a missão. O canal de revisão sobrevive até você aprovar.' },
    { title: 'Entrega verificada de verdade', detail: 'A auditoria de dependências passa a impedir a conclusão quando não consegue rodar, em vez de registrar a entrega como verificada. Falha na análise automática de qualidade agora aparece no registro e na nota da entrega.' },
  ],
  fixes: [
    { title: 'Anexos ficam no projeto deles', detail: 'Fechar um projeto não leva mais os arquivos anexados nele para o projeto seguinte; reabrir o projeto de origem restaura os seus.' },
    { title: 'Painel hibernado acorda como antes', detail: 'Uma tecla não converte mais um painel hibernado em shell vazio — o botão de acordar continua sendo o caminho.' },
    { title: 'Contratos que o código cumpre', detail: 'A descrição de conclusão de missão deixa de prometer uma garantia que o caminho delegado não verifica, para o agente não planejar em cima dela.' },
  ],
};
export const RELEASE_0763: AppRelease = {
  version: '0.76.3',
  date: '2026-09-05',
  codename: 'Configurações mais claras',
  summary: 'Configurações organizadas em nove áreas, com acesso direto aos seus pets, busca integrada e identificação visual dos serviços de IA.',
  highlights: [
    { title: 'Limpar projeto', detail: 'Feche todos os panes ou apague todas as missões do projeto aberto com uma única confirmação. Os arquivos do projeto são preservados.' },
    { title: 'Menus mais fáceis de entender', detail: 'Nove áreas por finalidade substituem a lista extensa; cada área mostra suas próprias seções, com busca global e controles adaptados a janelas menores.' },
    { title: 'Seus pets sempre acessíveis', detail: 'A biblioteca tem atalho próprio e continua visível mesmo com o mascote flutuante desligado.' },
    { title: 'Serviços de IA identificados', detail: 'Logos locais nas listas, seletores e editores, com modelos e estados de conexão legíveis.' },
    { title: 'Design do projeto como regra', detail: 'O motor orienta os agentes a ler o contrato visual antes de editar UI, mesmo com a orientação adicional de design desligada.' },
  ],
  fixes: [
    { title: 'Fechamento acessível', detail: 'Panes muito estreitos mantêm espaço para o botão de fechar; remoções repetidas não empilham confirmações.' },
    { title: 'Aprovação automática nativa', detail: 'Kimi usa --yolo; plugins antigos do Kimi e Qwen recebem o argumento correto para evitar confirmações repetidas.' },
    { title: 'Falhas com recuperação', detail: 'Mídia, referências de design e atualizações informam falhas e permitem tentar novamente, sem anunciar sucesso indevido.' },
    { title: 'Equipes e regras organizadas', detail: 'Catálogos de modelos e opções avançadas deixam de dominar a tela; nomes de equipes e filtros continuam utilizáveis em janelas menores.' },
    { title: 'Contrato importado reconhecido', detail: 'Missões reconhecem DESIGN.md e o contrato aplicado em .context/docs/design-system.md, preservando a prioridade do arquivo da raiz.' },
  ],
};

export const RELEASE_0761: AppRelease = {
  version: '0.76.1',
  date: '2026-09-05',
  codename: 'Motor de missões e Settings confiáveis',
  summary:
    'Correção do contrato real de missões multi-agente, com receipts por integrante, ' +
    'roteamento usando credenciais consistentes e páginas internas de Settings/Cotas/Harness ' +
    'mais honestas sobre estados conhecidos, desconhecidos e recuperáveis.',
  highlights: [
    {
      title: 'Missões exigem respostas reais',
      detail:
        'Perguntas para a equipe agora usam o elenco aprovado como denominador, ' +
        'recusam sucesso parcial e preservam receipts físicos por worker.',
    },
    {
      title: 'Settings e cotas honestas',
      detail:
        'Uso/Cotas não inventa progresso para janelas desconhecidas, mostra dados ' +
        'com fornecedor e horário de observação e prioriza providers com quota real.',
    },
    {
      title: 'Páginas internas revisadas',
      detail:
        'Onboarding, Providers, Harness, Catálogo, Squads e páginas de produto ' +
        'ganharam estados de erro/vazio/retry e layouts responsivos verificados.',
    },
  ],
  fixes: [
    {
      title: 'Roteamento e credenciais',
      detail:
        'Router e respostas diretas reutilizam o resolvedor dos providers, respeitam ' +
        'providers desativados e evitam enviar chaves para fornecedores incompatíveis.',
    },
    {
      title: 'Recursos mortos removidos',
      detail:
        'Controles Ralph/GoalDriver sem runtime ativo foram retirados; Squads permanecem ' +
        'com aplicação real no preparo e aviso quando o time salvo está incompleto.',
    },
  ],
};
export const RELEASE_06100: AppRelease = {
  version: '0.61.0',
  date: '2026-08-19',
  codename: 'Herança do concorrente',
  summary:
    'Os três candidatos do overclick entram de vez: cada story selada ganha ' +
    'um roteiro "como confirmar" que o revisor recebe verbatim, handoffs ' +
    'carregam telemetria autorrelatada (min · tokens no Quadro) e assentos ' +
    'caminham cadeias de sucessão. O wizard fala: dite o objetivo por voz. ' +
    'PDF e documentos anexam em todo caminho, o pane aceita qualquer ' +
    'arquivo, a seleção de modelo do operador nunca mais é sombreada e o ' +
    'Maestro cobra worker mudo em vez de esperar.',
  highlights: [
    {
      title: 'Feito ≠ validado — "como confirmar" por story',
      detail:
        'O revisor pós-recusa recebe o board selado com um roteiro de ' +
        'confirmação por story e devolve veredito POR STORY com evidência ' +
        'citada.',
    },
    {
      title: 'Dite o objetivo da missão',
      detail:
        'Botão de microfone na etapa 1: fale, o Nexus transcreve no campo ' +
        '(mesmo modo CODE/CHAT dos panes). Segurar Espaço fora dos campos ' +
        'de texto também dita para o wizard.',
    },
    {
      title: 'Telemetria autorrelatada no Quadro',
      detail:
        'Worker informa {durationMs, tokens} do próprio transcript no ' +
        'handoff; o Quadro mostra "34 min · 1.2M tokens · autorrelato N/M". ' +
        'Estimativa é marcada; ausência é declarada, nunca zero.',
    },
    {
      title: 'Maestro cobra, não espera',
      detail:
        'Doutrina COBRANÇA (modelo overclock): worker parado sem handoff ' +
        'leva nexus_pane_read + cobrança direta — fim do "aguardando ' +
        'handoffs" com worker mudo.',
    },
  ],
  fixes: [
    {
      title: 'Sua seleção de modelo vale',
      detail:
        'Assentos sintéticos/remintados não escrevem mais default hardcoded ' +
        '(grok subia em 4.5 com 4.6 configurado); o spawn resolve ' +
        'roster → defaultModel do provider → default do adapter.',
    },
    {
      title: 'PDF e documentos anexam em todo caminho',
      detail:
        'Wizard, drop em qualquer lugar da tela e pane aceitam ' +
        'PDF/Office; o pane aceita QUALQUER arquivo até 14 MB. Rejeição ' +
        'nunca é silêncio — sempre toast com o motivo.',
    },
    {
      title: 'Pane não abre mais em branco pós-corte de backlog',
      detail:
        'O resync agora retoma no próximo ESC além do newline — TUI em ' +
        'alternate screen redesenha sem \\n e ficava invisível.',
    },
    {
      title: 'Efforts no vocabulário das CLIs',
      detail:
        'Low/Medium/High/XHigh no wizard — mesmo idioma do rodapé do pane.',
    },
  ],
};

export const RELEASE_06002: AppRelease = {
  version: '0.60.2',
  date: '2026-08-19',
  codename: 'O operador manda',
  summary:
    'Fecha as quatro feridas do voo real de 19/08 no mesmo dia: Marcar ' +
    'concluída vence o gate de revisão (missão presa tinha zero saída), o ' +
    'board não infla mais sem arquivo no disco, briefing não fica largado ' +
    'no composer, a tela não mostra lixo ANSI pós-corte de backlog e tecla ' +
    'em pane morto revive uma vez, não doze.',
  highlights: [
    {
      title: 'A palavra do operador atravessa o gate',
      detail:
        'Marcar concluída agora conclui — o gate de revisão independente ' +
        'continua barrando o Maestro, nunca o humano. O beco "review_missing ' +
        'sem botão de cancelar" acabou.',
    },
    {
      title: 'Board honesto',
      detail:
        'Conclusão física de worker só avança story com match real de ' +
        'arquivo/identidade; o fallback next-open ficou exclusivo do ' +
        'handoff assertado.',
    },
  ],
  fixes: [
    {
      title: 'Composer nunca fica com briefing largado',
      detail:
        'Colagem sem prova de Enter limpa a linha; o retry recomeça limpo.',
    },
    {
      title: 'Tela limpa pós-corte de backlog',
      detail:
        'Resync até o próximo newline elimina o lixo ANSI ("(B", "1;2m", ' +
        'payload Kitty) que aparecia no pane do grok.',
    },
  ],
};

export const RELEASE_06001: AppRelease = {
  version: '0.60.1',
  date: '2026-08-19',
  codename: 'O 0.60 que funciona',
  summary:
    'Completa o stack 0.60 (9 módulos que ficaram fora do merge), atravessa ' +
    'uma missão real de 10 stories em dev e corrige o que o voo mostrou: ' +
    'recusa de revisão abre o revisor em vez de loop, revisor sem ' +
    'credencial reminta pro CLI logado, trust prompt aceita em pane ' +
    'estreito, workspace quarentenado degrada pro launcher e o orb de voz ' +
    'sai de cima do Enviar.',
  highlights: [
    {
      title: 'Recusa de revisão vira revisor aberto — nunca loop',
      detail:
        'Board N/N sem revisor gerava centenas de recusas por minuto de ' +
        'completeVerified. Agora a recusa loga uma vez por janela e spawna ' +
        'o revisor pendente do roster; sem credencial, o assento reminta ' +
        'pro primeiro CLI com auth present.',
    },
    {
      title: 'Missão real como gate',
      detail:
        'First-wave de 7 writers no turno do Maestro, handoffs MCP ' +
        'consumidos via idle-delivery, mortalidade contada, revive por ' +
        'tecla sem duplicar Maestro e Encerrar com marcadores — validados ' +
        'ao vivo em missão de 10 stories no dev.',
    },
  ],
  fixes: [
    {
      title: 'Trust prompt do Claude casa em pane estreito',
      detail:
        'A moldura do TUI quebrava a frase no meio e o worker ficava ' +
        'eterno no "Yes, I trust this folder". O matching compacto aceita ' +
        'automaticamente em spawn governado.',
    },
    {
      title: 'Orientação do operador nunca é rejeitada crua',
      detail:
        '"orchestrator authority is incomplete" durante revival agora ' +
        'enfileira a orientação e o tick re-entrega; nada de erro técnico ' +
        'em inglês no board.',
    },
    {
      title: 'Workspace quarentenado não derruba o hydrate',
      detail:
        'Manifesto com lineage divergente no current persistido virava ' +
        'erro em todo workspace:get. Agora degrada pro launcher com ' +
        'recents vivos.',
    },
  ],
};

export const RELEASE_06000: AppRelease = {
  version: '0.60.0',
  date: '2026-08-19',
  codename: 'Identidade 0.60',
  summary:
    'Esta entrada só alinha a identidade de versão 0.60.0 do Nexus / ' +
    'NexusIDE. Não declara features enviadas. Os gates funcionais ' +
    'obrigatórios antes da notarização Mac estão no checklist de ' +
    'RELEASE-0.60.md e nenhum item está marcado como passado.',
  highlights: [
    {
      title: 'Identidade de pacote, não changelog de entrega',
      detail:
        'package.json, server/package.json, lockfile e estas notas internas ' +
        'passam a 0.60.0. CFBundleShortVersionString e o feed de update ' +
        'continuam derivados dessa versão no Electron Forge. Nome do ' +
        'produto permanece Nexus / NexusIDE.',
    },
    {
      title: 'Gates de notarização ainda em aberto',
      detail:
        'Via Rápida de 20 stories sozinha, incrementos no quadro, Pronto ' +
        'com evidência em disco, leftovers Dormindo persistidos, nenhum ' +
        'toast de CLI não autenticada, nenhum pane zumbi — tudo listado ' +
        'em RELEASE-0.60.md como checklist, não como feito.',
    },
  ],
  fixes: [],
};

export const RELEASE_05005: AppRelease = {
  version: '0.50.5',
  date: '2026-08-18',
  codename: 'O terminal explica',
  summary:
    'Quando o app é atualizado em disco enquanto está aberto, o supervisor ' +
    'de terminais recusava todo spawn com um erro técnico em inglês — ' +
    'terminais mortos e nenhuma instrução. A recusa continua (é segurança ' +
    'correta), mas agora o terminal diz em português exatamente o que ' +
    'fazer: fechar e reabrir o Nexus, com a missão preservada no rail. ' +
    'Embarca também a Fase 0 do daemon de terminais: o protocolo de posse ' +
    'de endpoint que vai permitir, nas próximas versões, fechar o app sem ' +
    'matar os terminais das missões.',
  highlights: [
    {
      title: 'Quadro ganha "Limpar concluídas"',
      detail:
        'O quadro de tarefas acumulava etapas concluídas sem nenhuma ação de ' +
        'limpeza. Agora o cabeçalho oferece "Limpar concluídas" com ' +
        'confirmação em dois cliques: missão viva perde apenas os itens ' +
        'concluídos (o plano em curso segue intacto); checklist de missão ' +
        'terminada ou órfã sai inteiro. A política decide no processo ' +
        'principal — a interface nunca escolhe o que pode sair.',
    },
    {
      title: 'Erro de spawn agora orienta em português',
      detail:
        'Classes conhecidas da falha de preflight do supervisor ganham uma ' +
        'frase acionável no terminal (\"feche e reabra o Nexus para religar ' +
        'os terminais; a missão continua no rail\"; ou \"reinstale o app\" ' +
        'quando a assinatura está quebrada). O texto técnico original ' +
        'permanece como evidência; erro desconhecido segue cru — orientação ' +
        'nunca é inventada.',
    },
    {
      title: 'Fase 0 do daemon de terminais',
      detail:
        'Protocolo de posse de endpoint travado em teste: bind privado com ' +
        'link exclusivo, incumbente provado por conexão, morte física ' +
        'provada por recusa, \"não sei\" jamais vira takeover, endpoint ' +
        'nunca removido no shutdown, zero varredores. Fundação invisível ' +
        'desta versão — a co-existência (feature.ptyd) vem a seguir.',
    },
  ],
  fixes: [],
};

export const RELEASE_05004: AppRelease = {
  version: '0.50.4',
  date: '2026-08-18',
  codename: 'O handoff chega',
  summary:
    'O bug mais doloroso da frota morto com prova física: o worker entrega, ' +
    'o handoff fica queued com ZERO tentativas e o orquestrador espera para ' +
    'sempre — enquanto o journal registrou ele idle minuto após minuto. Um ' +
    'aviso semântico de \"working\" de dois dias antes vetava a entrega que ' +
    'o terminal idle autorizava. Agora o físico vence o hook morto, e a ' +
    'verdade durável do SQLite re-arma entregas que a fila em memória perdeu.',
  highlights: [
    {
      title: 'Working velho não trava mais',
      detail:
        'O estado \"working\" só bloqueia injeção por 10 minutos sem evento ' +
        'novo — laço de ferramentas re-pulsa; silêncio com terminal idle é ' +
        'hook morto. Diálogo aberto (permissão/pergunta) segue travando em ' +
        'qualquer idade: nunca escrever no diálogo errado.',
    },
    {
      title: 'SQLite é a verdade, fila é cache',
      detail:
        'Orquestrador idle com entrega pendente no banco → o supervisor ' +
        're-arma a entrega (idempotente, janela por missão). Troca de ' +
        'workspace e authority nulo no submit deixaram de perder handoff ' +
        'para sempre.',
    },
  ],
  fixes: [],
};

export const RELEASE_05003: AppRelease = {
  version: '0.50.3',
  date: '2026-08-18',
  codename: 'O Retomar retoma',
  summary:
    'Dois bugs que você viu na tela, mortos na raiz: o Retomar de missão ' +
    'encerrada que recusava com erro interno (os únicos estados em que o ' +
    'card oferecia o botão eram os que o motor recusava) e o áudio de ' +
    'WhatsApp que não colava no terminal nem avisava por quê. Junto, a ' +
    'jornada do operador — encerrar e retomar — virou cenário reproduzível ' +
    'que fecha o ciclo ao vivo.',
  highlights: [
    {
      title: 'Missão encerrada volta quando você pede',
      detail:
        'Retomar limpa o selo de encerramento, devolve a missão a ' +
        'execução e religa a coordenação com re-entrega do pendente. ' +
        'Missão concluída com trabalho residual retoma igual; concluída ' +
        'com entrega verificada segue intocada.',
    },
    {
      title: 'Áudio cola — e recusa fala',
      detail:
        '.opus (WhatsApp/Telegram), .oga, .aiff e .wma entram como anexo ' +
        'mesmo quando o paste chega sem tipo MIME. E arquivo recusado ' +
        'aparece num aviso em vez de morrer em silêncio.',
    },
    {
      title: 'Cenário da jornada do operador',
      detail:
        'Encerrar missão (diálogo nativo incluso) → card anuncia Retomar → ' +
        'o clique → rodando de novo com exatamente UM orquestrador: o caminho ' +
        'que você faz virou prova automatizada ao vivo.',
    },
  ],
  fixes: [],
};

export const RELEASE_05002: AppRelease = {
  version: '0.50.2',
  date: '2026-08-18',
  codename: 'Execução instrumentada para o worker',
  summary:
    'O worker com Bash na lane ganha o nexus_terminal_run — a execução que ' +
    'o Nexus observa, registra e usa como prova. Antes o gate de evidência ' +
    'pedia exatamente a coisa que a allowlist proibia de instrumentar. ' +
    'Junto, a spec do daemon de PTY: o contrato do destino arquitetural ' +
    'onde o terminal sobrevive ao fechamento do app.',
  highlights: [
    {
      title: 'Execução que serve de prova',
      detail:
        'Execução instrumentada liberada sse a lane do worker libera Bash — ' +
        'o main vê o comando, confina por sandbox e pode usá-lo como ' +
        'evidência. Lanes sem execução e o regime do operador seguem ' +
        'exatamente como antes.',
    },
    {
      title: 'Spec do daemon de PTY',
      detail:
        'Documento arquitetural do futuro onde o PTY sobrevive a ' +
        'quit/update e o main re-anexa por incarnation — fim dos grants ' +
        'que morrem no restart e das ressurreições caras. Contrato pronto ' +
        'para o porte em fases.',
    },
  ],
  fixes: [],
};

export const RELEASE_05001: AppRelease = {
  version: '0.50.1',
  date: '2026-08-18',
  codename: 'A missão termina',
  summary:
    'O destravador final: a missão que entrega, consome e é ack\'ada pelo ' +
    'orquestrador agora fecha done de verdade — antes o gate recusava ' +
    'qualquer conclusão do Maestro na Via Rápida e o trabalho pronto ' +
    'morria "blocked". Pergunta em aberto sobrevive ao rebind, cerca de ' +
    'exclusividade travada em contrato, e o ciclo completo (crash no meio ' +
    'da entrega → missão concluída) provado ao vivo.',
  highlights: [
    {
      title: 'A missão termina',
      detail:
        'Handoff success consumido com aceite da sessão CORRENTE do ' +
        'orquestrador + nota durável do que foi entregue = verificação ' +
        'sancionada. O trabalho pronto nunca mais vira "blocked" por falta ' +
        'de cerimônia que a Via Rápida nem tem.',
    },
    {
      title: 'Pergunta não some no rebind',
      detail:
        'Após respawn/restart a pergunta em aberto ficava invisível enquanto ' +
        'a missão esperava resposta. Agora a sessão corrente ganha e, sem ' +
        'nenhuma, a mais recente da anterior permanece visível no rail.',
    },
    {
      title: 'Cerca com contrato escrito',
      detail:
        'Liveness tri-state como verdade única e o contrato da cerca de ' +
        'exclusividade travado em teste — nunca mais colapsar "não sei" em ' +
        '"morto", nunca deixar dois Maestros na mesma credencial.',
    },
  ],
  fixes: [],
};

export const RELEASE_05000: AppRelease = {
  version: '0.50.0',
  date: '2026-08-18',
  codename: 'Imbatível: a missão vai do início ao fim',
  summary:
    'A campanha 0.50 cruzou a evidência das suas missões reais com a ' +
    'doutrina do Overclock e as novidades do Orca upstream: a entrega ' +
    'que morria "Handoff não entregue" tendo entregue, o worker que ' +
    'nascia morto invisível e respawna 6×, a sentinela de HEAD que ' +
    'disparava à toa, o app empacotado sem NENHUM log — tudo com teste, ' +
    'tudo com cenário de sobrevivência provado ao vivo.',
  highlights: [
    {
      title: 'A missão não mente no fim',
      detail:
        'Fechar o app na janela do ack engolia a entrega final e a missão ' +
        'acordava bloqueada tendo concluído o trabalho. O respawn agora ' +
        're-entrega os handoffs pendentes ao orquestrador novo: trabalho ' +
        'pronto é consumido, nunca vira "Handoff não entregue".',
    },
    {
      title: 'Worker morto é visível e o loop acaba',
      detail:
        'Todo worker que morre sem entregar vira evento no journal com ' +
        'adapter e contagem. À terceira morte do mesmo adapter, o circuit ' +
        'breaker recusa o spawn com motivo e o Maestro reroteia para outro ' +
        'agente do roster — chega de pane respawnado 6× para morrer igual.',
    },
    {
      title: 'O app empacotado enxerga',
      detail:
        'main.trace.ndjson com redactor e rotação grava respawn, ' +
        'mortalidade e breaker; hang watchdog em worker thread carimba a ' +
        'DURAÇÃO de qualquer congelamento da main em disco. O pós-mortem ' +
        'noturno deixou de ser cego.',
    },
  ],
  fixes: [
    {
      title: 'Sentinela de HEAD calibrada',
      detail:
        'Commit do trabalho da própria missão é interno e silencioso; só ' +
        'processo de fora avisa. O Maestro para de gastar turno ' +
        'revalidando o próprio trabalho dele.',
    },
    {
      title: 'Missão encerrada não deixa cadáver',
      detail:
        'Panes restaurados de missão concluída/failed saem do grid ' +
        'sozinhos; missão bloqueada preserva o contexto para o Retomar.',
    },
    {
      title: 'Cenário de sobrevivência como artefato',
      detail:
        'Crash → revival → exatamente UM orquestrador vivo, zero grant ' +
        'expirado, zero block falso: o bug real virou script reproduzível ' +
        'que asserciona na tela, verde ao vivo três vezes.',
    },
  ],
};

export const RELEASE_03230: AppRelease = {
  version: '0.32.30',
  date: '2026-08-17',
  codename: 'Um orquestrador por missão',
  summary:
    'Reabrir o app depois de um crash não deixa mais dois panes de ' +
    'orquestrador na tela: o revival aposenta o pane morto da sessão ' +
    'anterior na hora em que o orquestrador novo nasce, a tecla num pane ' +
    'de missão travado para de estourar grant expirado, e a substituição ' +
    'não anuncia "missão sem pane" por engano.',
  highlights: [
    {
      title: 'Fim do pane de orquestrador morto',
      detail:
        'O revival spawnava o orquestrador novo mas o pane restaurado do ' +
        'boot ficava na tela travado, com teclado morto e erro de spawn ' +
        'grant a cada tecla. Agora vale a lei um-missão-um-orquestrador: o ' +
        'spawn novo aposenta os panes do mesmo papel sem sessão viva, e o ' +
        'main só emite o grant após provar o exit físico do antecessor.',
    },
    {
      title: 'Tecla revive pela autoridade certa',
      detail:
        'Digitar num pane de missão travado tentava religar a CLI carregando ' +
        'o token de spawn da sessão anterior — falha garantida. O teclado ' +
        'agora só dispara o respawn main-owned; pane avulso do operador ' +
        'continua religando na mesma conta.',
    },
    {
      title: 'Sem toast falso na substituição',
      detail:
        'Aposentar o cadáver disparava "Missão continua em execução / ' +
        'Reabrir panes" nos milissegundos em que o sucessor nascia. O aviso ' +
        'agora cala quando o fechamento é substituição imediata.',
    },
  ],
  fixes: [],
};

export const RELEASE_03229: AppRelease = {
  version: '0.32.29',
  date: '2026-08-17',
  codename: 'Nenhuma missão presa',
  summary:
    'Missão travada revive de verdade: o respawn do orquestrador termina a ' +
    'sessão antiga com prova física em vez de ser recusado para sempre, o ' +
    'erro real do spawn chega até você, e o rail mostra as missões de TODOS ' +
    'os workspaces — abrir um terceiro workspace não esconde nem derruba ' +
    'mais nada.',
  highlights: [
    {
      title: 'Fim do deadlock do revival',
      detail:
        'Cerca de exclusividade e fast-lane discordavam sobre o orquestrador ' +
        'estar vivo: todo respawn era recusado para sempre e cada tecla ' +
        'virava "revival da missão falhou". Agora o respawn termina a sessão ' +
        'antiga com prova física antes de spawnar a reposição — nunca dois ' +
        'Maestros, nunca beco sem saída.',
    },
    {
      title: 'Rail de todos os workspaces',
      detail:
        'Missão rodando em outro workspace era invisível na sidebar. Agora ' +
        'cada workspace com missões ativas aparece na seção "Em andamento" ' +
        'e o clique troca de workspace e navega até a missão.',
    },
    {
      title: 'Orquestrador ocioso não passa mais batido',
      detail:
        'Orquestrador idle aguardando workers por 30 minutos sem mudança ' +
        'escala a missão para bloqueio técnico com motivo visível — nada ' +
        'mais de missão rodando em silêncio por horas a fio.',
    },
  ],
  fixes: [],
};

export const RELEASE_03228: AppRelease = {
  version: '0.32.28',
  date: '2026-08-17',
  codename: 'Fechar sem barulho',
  summary:
    'Fechar o app no meio da missão não é mais uma parede de avisos: um ' +
    'aviso calmo único ("as missões continuam no rail e retomam sozinhas ' +
    'no próximo boot") e nada de banner por pane nem balão de falha.',
  highlights: [
    {
      title: 'Um aviso, não uma parede',
      detail:
        'Cada pane imprimia "process exited" + "a missão ainda é dona ' +
        'deste pane" (e toasts) quando você fechava o app. Agora o grid ' +
        'inteiro recebe uma linha só, e os banners por pane ficam quietos.',
    },
    {
      title: 'Encerrar não é falha técnica',
      detail:
        'O balão do pet tratava missão fechada pelo operador como falha ' +
        'técnica numa corrida de teardown. O marcador de encerramento é ' +
        'prova suficiente em qualquer intent — shutdown não é alerta.',
    },
  ],
  fixes: [],
};

export const RELEASE_03227: AppRelease = {
  version: '0.32.27',
  date: '2026-08-17',
  codename: 'MCP pela lei física do binário',
  summary:
    'Worker de adapter de usuário que roda o binário claude (deepseek, ' +
    'qwen, sakana…) nasce com o MCP do Nexus de novo — a família é do ' +
    'binário, não do JSON. HEAD do checkout mudando por fora da missão ' +
    'gera aviso, o orquestrador aprende a despachar revisores em ' +
    'paralelo, modelos não reconhecidos param de compactar cedo, e o ' +
    'route_task explica o destino de cada preferAdapters.',
  highlights: [
    {
      title: 'MCP pela lei física do binário',
      detail:
        'deepseek/qwen/sakana declaravam nexusMcp none e o worker nascia ' +
        'sem nexus_handoff_submit. Se o adapter roda o binário claude, é ' +
        'família Claude: HOME isolado + --mcp-config + --settings.',
    },
    {
      title: 'Sentinela de HEAD (achado #14)',
      detail:
        'O lock do same-checkout só serializa a própria missão. Quando o ' +
        'HEAD muda por um processo de fora, o watcher emite evento e aviso ' +
        'para o Maestro revalidar o chão — exclusividade falsa vira ' +
        'observabilidade real.',
    },
    {
      title: 'Paralelismo com inteligência',
      detail:
        'Doutrina nova no orquestrador: review/auditoria NUNCA em série — ' +
        'fatie o escopo e despache os revisores no mesmo turno; um ' +
        'escritor por vez; leitor acompanha escritor.',
    },
  ],
  fixes: [
    {
      title: 'Modelo não reconhecido não compacta mais cedo',
      detail:
        'deepseek-v4-pro fazia o Claude Code assumir janela 200k. O ramo ' +
        'third-party exporta a env oficial que devolve a decisão de ' +
        'janela para a API.',
    },
    {
      title: 'route_task explica os preferAdapters',
      detail:
        'Preferido derrubado em silêncio (não instalado/reservado/fora do ' +
        'ranking) parecia preferência ignorada. O reason agora diz o ' +
        'destino de cada um.',
    },
  ],
};

export const RELEASE_03226: AppRelease = {
  version: '0.32.26',
  date: '2026-08-17',
  codename: 'Maestro com plano de verdade',
  summary:
    'Os três bugs que o próprio Maestro reportou na primeira missão ' +
    'real: nexus_task plan existe de fato (plano selado com queue e ' +
    'ownership), revisor read-only roda em paralelo ao executor, e CLI ' +
    'que trava em prompt de pasta no boot recebe Enter sozinho. E o ' +
    'painel de detalhes da missão agora fecha — só o time na tela.',
  highlights: [
    {
      title: 'nexus_task plan de verdade',
      detail:
        'Description prometia, o gate exigia, o servidor recusava ' +
        '(unknown action: plan). A action agora existe: sela o plano no ' +
        'registro de tasks contra o roster real, com replay determinístico ' +
        'e dependsOn/ownership embutidos. O Maestro volta a ter rastreio ' +
        'durável de etapas.',
    },
    {
      title: 'Revisor em paralelo ao executor',
      detail:
        'Worker read-only não espera mais o escritor terminar no mesmo ' +
        'checkout. Um escritor por vez continua; leitura acompanha o WIP.',
    },
    {
      title: 'Painel de detalhes fecha',
      detail:
        'Botão "detalhes ›" na missão esconde o menu da direita e deixa ' +
        'só a visão do time (preferência fica salva).',
    },
  ],
  fixes: [
    {
      title: 'CLI que pede "trust this folder?" no boot',
      detail:
        'O Kimi travava esperando um Enter que ninguém dava e o worker ' +
        'morria na largada. O watchdog de boot aperta Enter sozinho — ' +
        'só em pane de missão, só na janela de boot, máx 2 tentativas.',
    },
  ],
};

export const RELEASE_03225: AppRelease = {
  version: '0.32.25',
  date: '2026-08-17',
  codename: 'Atualização que não pendura',
  summary:
    'O download de atualização ganhou progresso visível (baixando 42%, ' +
    '87 MB de 216 MB), watchdog de stall (90s sem byte novo aborta com ' +
    'erro claro em vez de pendurar a noite inteira) e retry automático ' +
    'com fallback de fonte — rede instável não trava mais a atualização.',
  highlights: [
    {
      title: 'Progresso de verdade no botão',
      detail:
        '"baixando…" vira "baixando 42%" com MB no tooltip. Sem mais ' +
        'tela congelada sem informação.',
    },
    {
      title: 'Watchdog de stall',
      detail:
        '90 segundos sem NENHUM byte novo aborta o download com erro ' +
        'claro. A madrugada de "baixando…" eterno acabou.',
    },
    {
      title: 'Retry + fallback de fonte',
      detail:
        'Tenta o espelho público, cai para o gh autenticado, e ainda tem ' +
        'uma segunda tentativa completa antes de errar.',
    },
  ],
  fixes: [],
};

export const RELEASE_03224: AppRelease = {
  version: '0.32.24',
  date: '2026-08-16',
  codename: 'Missão ininterrupta + troca de conta automática',
  summary:
    'A missão vai do início ao fim sem travar: o watcher nunca ' +
    'interrompe sozinho, respawna o orquestrador com orçamento, ' +
    'o restart do app ressuscita missões running, e worker de ' +
    'missão que bate limite de conta troca sozinho para a conta ' +
    'reserva e continua trabalhando.',
  highlights: [
    {
      title: 'Missão ininterrupta (doutrina Overclock)',
      detail:
        'Todos os panes morreram não fecha a missão: o orquestrador ' +
        'é respawnado com nota de continuidade (até 3 tentativas ' +
        'por episódio) e consome os handoffs pendentes. Só o ' +
        'operador para.',
    },
    {
      title: 'Troca de conta automática em missão',
      detail:
        'Worker de missão que bate limite (quota/rate-limit/auth) ' +
        'troca sozinho para a próxima conta do mesmo provider e ' +
        'continua a tarefa de onde parou. Cadastre 2+ contas em ' +
        'Configurações → Contas.',
    },
    {
      title: 'Restart não é mais zumbi',
      detail:
        'Reabrir o app ressuscita missões running (respawn ou ' +
        'watcher) a cada escopo aberto, e o servidor MCP faz bind ' +
        'antes do renderer — acaba o MCP startup interrupted.',
    },
  ],
  fixes: [
    {
      title: 'Toast Handoff não entregue extinto na raiz',
      detail:
        'Falha de entrega virava bloqueio + marcador venenoso na ' +
        'descrição. Agora é recuperação de runtime + outbox; o ' +
        'rebind re-enfileira entregas em vez de bloquear; e o dedup ' +
        'do fechamento mecânico conta por encarnação física com ' +
        'fail-closed — nunca mais handoff duplicado.',
    },
    {
      title: 'Split-brain de intent curado',
      detail:
        'Write status-only deixava intent bloqueado em missão viva, ' +
        'matando a autoridade de dispatch (o erro em inglês ao ' +
        'Enviar orientação). Agora a reativação normaliza o intent ' +
        'e a orientação cura a linha antes de recusar.',
    },
    {
      title: 'Cards Interrompido viram Na fila',
      detail:
        'Turno encerrado sem processo físico é fila para o ' +
        'orquestrador re-disparar — não interrupção.',
    },
    {
      title: 'Tecla em pane morto religa tudo',
      detail:
        'Digitar em pane de missão morta revive a missão e religa ' +
        'a própria CLI na mesma conta — acabou o cursor oco.',
    },
    {
      title: 'Rodapé não corta mais',
      detail:
        'O aviso de backlog apaga a linha do composer antes de ' +
        'escrever (fim do "> [Nexus skipped hidden").',
    },
    {
      title: 'Aviso loop_control do Kimi é upstream',
      detail:
        'O próprio Kimi CLI escreve max_retries_per_step no config ' +
        'dele e o binário novo reclama. O Nexus não edita config de ' +
        'terceiro; nada quebrou.',
    },
  ],
};

export const RELEASE_03223: AppRelease = {
  version: '0.32.23',
  date: '2026-08-16',
  codename: 'GLM-5.3 no z.ai',
  summary:
    'O Nexus passa a oferecer o GLM-5.3 que a Z.AI lançou em ' +
    '14 de agosto, e deixa de travar a missão no fim do turno: ' +
    'orientação religa o Maestro, pane vazio não interrompe, e ' +
    'Tentar início novamente respawna a sessão.',
  highlights: [
    {
      title: 'GLM-5.3 no picker',
      detail:
        'Default do adapter GLM/z.ai. 5.2, 4.7, 4.6 e 4.5-air ' +
        'continuam na lista.',
    },
    {
      title: 'Roteador no 5.3',
      detail:
        'Medium, hard e critical delegam para glm-5.3 em vez ' +
        'de glm-5.2.',
    },
    {
      title: 'Env oficial da Z.AI',
      detail:
        'Sonnet/Opus usam glm-5.3[1m] (janela de 1M); Haiku ' +
        'passa a glm-4.7.',
    },
  ],
  fixes: [
    {
      title: 'Missão não morre no fim do turno',
      detail:
        'Worker com exit 0 e pane vazio deixava de ser Interrompido ' +
        'e de receber Precisa de reparo. A missão segue running; ' +
        'só o operador para.',
    },
    {
      title: 'Handoff entregue não mente',
      detail:
        'Se o worker já imprimiu o handoffId, o Main não bloqueia ' +
        'a missão com Handoff não entregue — pede recuperação e ' +
        'mantém a autoridade de dispatch.',
    },
    {
      title: 'Tentar início novamente respawna',
      detail:
        'O botão no-opava quando o status ainda era running sem ' +
        'sessão. Agora reabre o orquestrador. Digitar no pane ' +
        'dispara o mesmo caminho.',
    },
    {
      title: 'Orientação religa o Maestro',
      detail:
        'Enviar orientação após o exit 0 respawna a sessão e o ' +
        'recibo de kickoff em vez de falhar com dispatch authority.',
    },
    {
      title: 'Teclado não morre no exit 0',
      detail:
        'O pane deixa de hibernar e de escrever o trio dona / ' +
        'pausado / cursor oco. Digite para religar o Maestro.',
    },
    {
      title: 'Aviso de backlog cabe no pane',
      detail:
        'A linha Nexus skipped hidden output não cola mais no ' +
        'prompt nem some cortada no rodapé estreito.',
    },
  ],
};

export const RELEASE_03100: AppRelease = {
  version: '0.31.0',
  date: '2026-08-10',
  codename: 'A frota inteira na mão: login, "+ Pane" e panes com nome',
  summary:
    'A Via Rápida ganhou a operação em volta dela: 18 CLIs reconhecidas com ' +
    'logo e login pelo próprio cartão, um "+ Pane" que abre qualquer ' +
    'ferramenta no modelo que você escolher, panes com nome falável ' +
    '("pane 7") que a voz entende, e o MCP do hub finalmente chegando dentro ' +
    'do terminal do agente. Junto, o fim do loop que fazia agente refazer ' +
    'trabalho já entregue.',
  highlights: [
    {
      title: 'Login da CLI pelo próprio cartão',
      detail:
        'A ferramenta que ainda não autenticou mostra "entrar": o Nexus abre ' +
        'um terminal e roda o comando de login DELA. Nenhuma credencial passa ' +
        'pelo Nexus, e quando o terminal fecha o painel reexamina sozinho.',
    },
    {
      title: '+ Pane: qualquer CLI, na hora',
      detail:
        'Um botão na grelha abre terminal, browser ou qualquer uma das CLIs ' +
        'instaladas — com a conta e o modelo escolhidos na hora, filtrando ' +
        'por texto. CLI sem catálogo entra no padrão da própria ferramenta.',
    },
    {
      title: 'Pane 7 é o nome dele',
      detail:
        'Cada pane ganhou nome curto e falável, estável entre reinícios, ' +
        'reusando o menor livre. "pane sete" funciona na voz e nos comandos; ' +
        'número ambíguo recusa dizendo quais valem, em vez de chutar.',
    },
    {
      title: 'MCP do hub chega no agente',
      detail:
        'Os servidores MCP que você sincroniza para o hub agora entram na ' +
        'configuração por sessão do pane — claude, codex, opencode, kimi e ' +
        'grok — sem afrouxar o isolamento de missão.',
    },
  ],
  fixes: [
    {
      title: 'Fim do trabalho refeito em loop',
      detail:
        'O motor lê o PRONTO do próprio agente em vez de depender só do ' +
        'estado do terminal, e a recarga de prompt tem teto. CLI que entrega ' +
        'sem ficar "ocupada" não é mais cutucada para refazer tudo.',
    },
    {
      title: 'Missão agendada voltou a partir',
      detail:
        'Toda ocorrência de cron morria exigindo um selo de revisão que só a ' +
        'aprovação humana carimbava. A faixa automática agora usa o próprio ' +
        'consentimento verificado da agenda.',
    },
    {
      title: 'Telas de primeiro run não param mais a missão',
      detail:
        'Confiança no diretório, consentimento de dados e migração de CLI ' +
        'são respondidos na largada — o "sim" só sai quando o diretório é o ' +
        'da própria missão; consentimento e migração são adiados, nunca aceitos.',
    },
    {
      title: 'Sync de MCP não sobrescreve mais o que não leu',
      detail:
        'Config existente que o leitor recusava era tratada como vazia e ' +
        'substituída sem backup. Ilegível agora é recusa.',
    },
  ],
};

export const RELEASE_03000: AppRelease = {
  version: '0.30.0',
  date: '2026-08-10',
  codename: 'Via Rápida: missão que começa e termina',
  summary:
    'O motor de execução de missão foi substituído: Iniciar missão abre um ' +
    'terminal interativo por agente direto no workspace, com prompt curto, e ' +
    'a conclusão é observada — a equipe trabalha, assenta e a missão fecha ' +
    'sozinha. Missão real medida em ~90 segundos (antes: 32 minutos de ' +
    'cerimônia). O pipeline antigo foi removido por inteiro: −111 mil linhas.',
  highlights: [
    {
      title: 'Missão termina sozinha',
      detail:
        'Conclusão observada e honesta: todos os agentes trabalharam e ' +
        'assentaram ⇒ Concluída. Agente que morre sem executar nunca vira ' +
        'done falso — a missão bloqueia visível com Retomar.',
    },
    {
      title: 'Prontidão deixou de ser gate',
      detail:
        'CLI instalada participa como coordenação e execução. Login é ' +
        'conversa do terminal do agente; o passo Equipe não reprova mais ' +
        'ferramenta logada e nenhum hook externo é necessário.',
    },
    {
      title: 'Terminais reais, operador no comando',
      detail:
        'A equipe aparece no grid como panes de verdade: clique e digite ' +
        'direto no agente, no meio ou no fim da missão. Ferramenta, modelo ' +
        '(campo livre) e esforço personalizáveis em cada papel.',
    },
    {
      title: 'Frotas paralelas de verdade',
      detail:
        'Força total abre 8 terminais de até 6 providers diferentes que se ' +
        'auto-dividem pelas stories do objetivo. Missões de interface ' +
        'recebem o design system do projeto e o catálogo do operador.',
    },
  ],
  fixes: [
    {
      title: 'Fim dos vigias que travavam missão viva',
      detail:
        'Reconciler, exit-watchdog do Maestro, driver cerimonial e o selo de ' +
        'adoção do grid re-bloqueavam equipes trabalhando. Todos removidos ' +
        'com o motor antigo.',
    },
    {
      title: 'Retomar adota panes vivos',
      detail:
        'A retomada religa a equipe reaproveitando sessões vivas em vez de ' +
        'duplicar coordenador de auth exclusiva, e re-entrega o prompt a ' +
        'quem ainda não trabalhou.',
    },
    {
      title: 'Release validada pelo smoke',
      detail:
        'O gate de release passou a ser a prova que importa: o app abre, ' +
        'roda uma missão trivial e a conclui com artefato correto em ' +
        'minutos.',
    },
  ],
};

export const RELEASE_02601: AppRelease = {
  version: '0.26.1',
  date: '2026-08-05',
  codename: 'Hotfix do primeiro voo — voz, aprovação e missões que falam',
  summary:
    'Correções do primeiro voo real da 0.26.0: o ditado aterrissa no pane da ' +
    'missão com recibo (Espaço só arma segurando), a aprovação fecha em vez ' +
    'de reperguntar para sempre, a missão parada diz por que parou e Retomar ' +
    'volta aos panes, o pane do orquestrador pinta o conteúdo, acentos deixam ' +
    'de virar mojibake e a frota acelera além de 2 workers quando há trabalho ' +
    'elegível.',
  highlights: [
    {
      title: 'Ditado que chega — e provado no gate',
      detail:
        'Falar num pane governado entrega pela lane do operador com recibo ' +
        'real; toque simples de Espaço digita espaço e só o hold arma. O ' +
        'smoke empacotado ganhou probes obrigatórias de entrega, autoridade ' +
        'e do contrato do Espaço — voz não shipa mais na fé.',
    },
    {
      title: 'Aprovação que fecha',
      detail:
        'O selo do squad derivado do intent aprovado não invalida mais a ' +
        'própria aprovação: o diálogo fecha, missão viva não repergunta e o ' +
        '"não perguntar de novo" segue durável.',
    },
    {
      title: 'Missão que fala com você',
      detail:
        'Card parado mostra o porquê a partir de evidência durável, worker ' +
        'mudo é cobrado com sonda de stall e handoff sintético, e você nunca ' +
        'é ejetado dos panes — Retomar e "Voltar aos panes" preservam o ' +
        'trabalho.',
    },
    {
      title: 'Paralelismo e locale honestos',
      detail:
        'Escada adaptativa coerente com o hardware substitui o teto ' +
        'silencioso de 2 workers; o plano de controle expõe panes, fila, ' +
        'ownership e bloqueios numa leitura; e o PTY garante locale UTF-8 — ' +
        'fim do "miss√£o" no app aberto pelo Finder.',
    },
  ],
  fixes: [
    {
      title: 'Ditado recusado em pane governado',
      detail:
        'A escrita crua do terminal é negada por design para agentes ' +
        'orquestrados; o ditado agora cai na lane do operador com recibo.',
    },
    {
      title: 'Loop infinito do diálogo de aprovação',
      detail:
        'Mutação derivada do próprio approve (selo do squad) não invalida ' +
        'mais a aprovação consumada; só objetivo divergente repergunta.',
    },
    {
      title: 'Pane do orquestrador preto',
      detail:
        'A repintura da adoção usa fita local de saída com backstop — o pane ' +
        'não fica mais vazio com a sessão viva.',
    },
    {
      title: 'Mojibake de acentos no empacotado',
      detail:
        'App aberto pelo Finder não herdava locale; o PTY injeta LANG UTF-8 ' +
        'quando falta ou é C/POSIX, sem sobrescrever escolha do usuário.',
    },
    {
      title: 'Card de missão parada mudo',
      detail:
        'O motivo vem de evidência durável (handoff), não do layout vivo que ' +
        'zera quando o reaper colhe os panes.',
    },
  ],
};

export const RELEASE_02600: AppRelease = {
  version: '0.26.0',
  date: '2026-08-05',
  codename: 'O loop que fecha — da largura ao encerramento',
  summary:
    'A missão passa a fechar sozinha: worker que entrega encerra por padrão, a ' +
    'rota resolvida vincula o dispatch, o plano guiado abre em escritores ' +
    'paralelos com propriedade disjunta e o fan-out largo drena até o fim. ' +
    'Sair do app não pendura mais, o ditado chega no pane certo e o editor de ' +
    'squad para de reescrever o roster do operador em silêncio.',
  highlights: [
    {
      title: 'Fan-out real, não um escritor por construção',
      detail:
        'A decomposição emite propriedade disjunta por story, então dois ou ' +
        'mais workers escrevem em paralelo sem colidir. Metas em linguagem ' +
        'natural também ficam elegíveis à topologia de fan-out, e o dreno de ' +
        'ondas fecha frentes de até 85 stories sem deixar cauda presa.',
    },
    {
      title: 'O loop encerra sozinho',
      detail:
        'O TTL pós-handoff vem ligado por padrão em missões guiadas e ' +
        'autopiloto: o worker que entregou é encerrado e acorda o ' +
        'orquestrador. Boot de worker que não executa é reapado pelo ' +
        'watchdog, e revisor bloqueado por dependência tem desfecho terminal.',
    },
    {
      title: 'A rota resolvida vira lei',
      detail:
        'No caminho agêntico o squad e a rota vinculam o dispatch: o loop não ' +
        'ignora mais o roster salvo nem cai em monocultura, e o pane_spawn ' +
        'respeita o roster da missão.',
    },
  ],
  fixes: [
    {
      title: 'Sair do app sem travar',
      detail:
        'O comando de sair ganhou prazo global e backstop de app.exit, e o ' +
        'término dos processos de terminal escala de forma limitada de ' +
        'SIGTERM para SIGKILL.',
    },
    {
      title: 'Ditado entregue no pane certo',
      detail:
        'A entrega do ditado ao pane foi corrigida com instrumentação de ' +
        'confirmação: o texto chega ao destino e sinaliza que a entrega ocorreu.',
    },
    {
      title: 'Editor de squad não descarta edição',
      detail:
        'Trocar modo ou política preserva as edições não salvas do roster; a ' +
        'opção já selecionada nunca é desabilitada; e em modo governado ' +
        'qualquer provider credenciado é override selecionável, com o não ' +
        'credenciado ainda bloqueado por login necessário.',
    },
  ],
};

export const RELEASE_02501: AppRelease = {
  version: '0.25.1',
  date: '2026-08-04',
  codename: 'Missão fluida — entrega sem sumir',
  summary:
    'Patch de confiabilidade do ciclo completo de missão: filas de handoff ' +
    'sobrevivem a rebind, lifecycle locks não deixam caudas órfãs, quota usa ' +
    'o escopo físico completo e os contratos Autopiloto/Hardened ficam ' +
    'explicitamente provados. Panes seguem responsivos em 4/8/10.',
  highlights: [
    {
      title: 'Entrega não desaparece em rebind',
      detail:
        'Quando uma sessão aparece ligada a mais de uma fila de missão, o ' +
        'Nexus não apaga mais o estado em memória: aposenta as filas ambíguas ' +
        'e solicita recuperação física Main-owned para cada handoff.',
    },
    {
      title: 'Autopiloto rápido, Hardened íntegro',
      detail:
        'Autopiloto segue sem atestação obrigatória e tolera drift operacional; ' +
        'Hardened continua fail-closed para plan seal, squad, runtime, ' +
        'confinamento, autoridade física e credencial de agente.',
    },
    {
      title: 'Cota e panes mais estáveis',
      detail:
        'Telemetria identifica instalação, projeto, checkout e raiz física; ' +
        'benchmark multipane preserva ordem/ANSI, backlog limitado e input ' +
        'responsivo em grades de 4, 8 e 10 panes.',
    },
  ],
  fixes: [
    {
      title: 'Lifecycle lock sem cauda órfã',
      detail:
        'Waiters que expiram restauram a cauda predecessora no registry, ' +
        'mantendo exclusão mútua e permitindo limpeza quando o holder termina.',
    },
    {
      title: 'Readiness sem listeners duplicados',
      detail:
        'Roots React são desmontados no cleanup e fixtures declaram a matriz ' +
        'Main-owned completa, eliminando contagens duplicadas e falsos bloqueios.',
    },
    {
      title: 'Gates e smoke completos',
      detail:
        '10.061 testes, typecheck, auditoria de sinks, sensor de design e ' +
        'package smoke com 20 probes e inventário físico de PTYs passam.',
    },
  ],
};

export const RELEASE_02500: AppRelease = {
  version: '0.25.0',
  date: '2026-08-03',
  codename: 'Autopiloto no chão — vibe first, multi-LLM',
  summary:
    'O chão do produto é Autopiloto: sem Seatbelt por omissão, gates pré-PTY ' +
    'avisam em vez de matar o Maestro, kickoff enxuto (~1,7KB) e frota multi-' +
    'provedor pronta. Hardened continua opt-in fail-closed. Release notarizado ' +
    'público com a experiência vibe completa.',
  highlights: [
    {
      title: 'Autopiloto é o default real',
      detail:
        'Floor único no boot: squadCliPolicy=operator-choice, atestação off e ' +
        'sandbox de kernel desligado. Seatbelt/bwrap e ladder Hardened só com ' +
        'governed explícito nas Configurações.',
    },
    {
      title: 'Menos freio pré-PTY no caminho vibe',
      detail:
        'No Autopiloto, catálogo, hash/plan seal drift e identity vault avisam ' +
        'e seguem — não reabrem aprovação nem derrubam a missão. Worktree, ' +
        'login CLI e merge Main permanecem.',
    },
    {
      title: 'Kickoff curto e multi-provedor',
      detail:
        'Missão por squad cola objetivo + roster + condução enxuta (~1,7KB) ' +
        'em vez de manifesto gigante. Runtime de frota multi-LLM deixa de ' +
        'travar em um único provedor quando o resto está pronto.',
    },
  ],
  fixes: [
    {
      title: 'Policy ausente não reativa Hardened',
      detail:
        'Valor desconhecido/ausente de squadCliPolicy deixa de cair no ' +
        'governed: sandbox e perfil privado do Codex só com governed ' +
        'explícito (case/whitespace normalizados).',
    },
    {
      title: 'Atestação e identity best-effort no Autopiloto',
      detail:
        'agentAttestationGate default off; vault de identity não mata o ' +
        'primeiro pane. Drift de runtime e mismatch pós-spawn viram aviso ' +
        'no Autopiloto e fail-closed só no Hardened.',
    },
    {
      title: 'Release público limpo',
      detail:
        '0.25.0 fecha o ciclo de publish notarizado com a experiência vibe ' +
        'como produto padrão — DMG/ZIP assinados, stapled e publicados.',
    },
  ],
};

export const RELEASE_02400: AppRelease = {
  version: '0.24.0',
  date: '2026-08-03',
  codename: 'Wave Pack, fast path e missão que conta o que faz',
  summary:
    'Missões ganham Wave Pack (stories em paralelo), fast path sem PREVC ' +
    'em risco normal, warm-ups read-only na onda 1, boot com etapa ao vivo, ' +
    'kickoff enxuto, cronograma de ondas e recuperação com saída. O promote ' +
    'amarra Pack/Guiado ao fence que o operador revisou.',
  highlights: [
    {
      title: 'Wave Pack e orquestração explícita',
      detail:
        'Templates Landing/SaaS/Fix e escolha Livre / Pack / Guiado no ' +
        'wizard e no promote; N stories abrem panes em paralelo com QA no ' +
        'fan-in, sem surpresa Pack no caminho destrutivo.',
    },
    {
      title: 'Fast path e warm-ups na onda 1',
      detail:
        'risk=normal pula PREVC antes do primeiro pane; warm-up read-only de ' +
        'reviewer/QA está pronto atrás da flag Labs (default OFF até a PTY ' +
        'do warm-up ser reutilizada no review real), com single-writer intacto.',
    },
    {
      title: 'Missão que mostra o que está fazendo',
      detail:
        'Card de vaga com etapa de boot ao vivo, kickoff <2,4KB, cronograma ' +
        'de ondas no diagnóstico e recuperação que conta tentativas e ' +
        'oferece Forçar retomada / Encerrar.',
    },
  ],
  fixes: [
    {
      title: 'Promote sem divergência pós-revisão',
      detail:
        'O fence nativo inclui orchestrationMode, template e contagem de ' +
        'stories — o commit não pode promover um modo diferente do ' +
        'confirmado.',
    },
    {
      title: 'Fechamento com causa legível',
      detail:
        'Quatro caminhos gravam motivo na description quando a missão ' +
        'fechava sem veredito; recovery deixa de parecer eterna.',
    },
    {
      title: 'Autopiloto nunca reativa Seatbelt por omissão',
      detail:
        'Policy ausente/desconhecida deixa de cair no Hardened: sandbox de ' +
        'kernel e perfil privado do Codex só com governed explícito ' +
        '(case/whitespace normalizados). Autopiloto vale para missão e pane ' +
        'ad-hoc; default de roster/Maestro é operator-choice (vibe).',
    },
    {
      title: 'Atestação crypto e gates pré-PTY no chão do vibe',
      detail:
        'agentAttestationGate default off (opt-in Hardened). Identity no ' +
        'spawn é best-effort — vault não mata o primeiro pane. Drift de ' +
        'runtime do orquestrador e mismatches pós-spawn avisam no Autopiloto ' +
        'em vez de reabrir aprovação ou derrubar a missão.',
    },
    {
      title: 'Sem sandbox por padrão — para todo mundo',
      detail:
        'Floor único no boot: squadCliPolicy=operator-choice e atestação off. ' +
        'Seatbelt/bwrap e ladder Hardened só se o operador ir em Configurações ' +
        'e mudar. Migração one-shot; quem reativar Hardened depois mantém.',
    },
    {
      title: 'Autopiloto livre: menos reaprovação e menos freio pré-PTY',
      detail:
        'No Autopiloto, squad de catálogo, hash drift, plan seal, seal/runtime ' +
        'drift e identity vault avisam e seguem — não matam o Maestro. Hardened ' +
        'continua fail-closed. Worktree + login CLI + merge Main ficam.',
    },
    {
      title: 'Kickoff curto no Autopiloto (estilo ADE libre)',
      detail:
        'Missão por squad não cola mais manifesto gigante: objetivo, roster e ' +
        'condução enxuta (~1,7KB). Base longa do squad some no Autopiloto; ' +
        'Hardened mantém o texto completo.',
    },
  ],
};

export const RELEASE_02300: AppRelease = {
  version: '0.23.0',
  date: '2026-08-03',
  codename: 'Missão nasce, anda e respira melhor',
  summary:
    'O fan-out de panes ganha roteamento read-only por topologia e ACK de ' +
    'handoff por leitura física, o spawn falha rápido quando falta auth de ' +
    'MCP, e a orquestração de panes fica mais leve: IPC coalescido, render ' +
    'só do que está visível e pipes com flush adaptativo. A aprovação perde ' +
    'o despejo de hashes e a interface ganha profundidade em camadas.',
  highlights: [
    {
      title: 'Fan-out read-only sem deadlock',
      detail:
        'Missões de consulta abrem todos os especialistas em panes somente ' +
        'leitura por topologia selada, e o ACK do handoff passa a ser prova ' +
        'física por leitura — a fila deixa de morrer esperando um paste idle ' +
        'que nunca vinha.',
    },
    {
      title: 'Spawn honesto e frota maior',
      detail:
        'Auth de MCP ausente vira falha rápida no watchdog em vez de pane ' +
        'preso no login, e o teto de workers sobe para 12 panes alinhado ao ' +
        'orçamento aprovado.',
    },
    {
      title: 'Orquestração de panes mais leve',
      detail:
        'O espelho renderer→main coalesce rajadas de sync em uma chamada por ' +
        'frame, terminais só renderizam quando visíveis (com repaint na ' +
        'volta), e pipes fluem a 50ms cheios e 300ms rasos.',
    },
  ],
  fixes: [
    {
      title: 'Aprovação sem despejo de hashes',
      detail:
        'O modal de missão mostra os fatos que importam e uma única âncora ' +
        'de review integral; a identidade do squad e o recibo auditável ' +
        'seguem intactos.',
    },
    {
      title: 'Profundidade visual em camadas',
      detail:
        'Sombras em duas camadas e filete de luz interno nas superfícies ' +
        'elevadas (menus, modais, painéis, wizard) — hierarquia por ' +
        'material, não por borda.',
    },
  ],
};

export const RELEASE_02201: AppRelease = {
  version: '0.22.1',
  date: '2026-08-02',
  codename: 'O piloto para de girar em falso',
  summary:
    'Missões aprovadas passam a executar sobre squads imutáveis, falhas ' +
    'permanentes deixam de alimentar recovery infinito e delegação antecipada ' +
    'continua rápida sem abrir escrita antes do PREVC. O pane da missão também ' +
    'assume o foco correto no Canvas.',
  highlights: [
    {
      title: 'Squad aprovado não muda no próximo boot',
      detail:
        'A confirmação materializa um mission-runtime imutável e vincula a ' +
        'missão antes de selar o hash. O preview permanece sem efeitos, e o ' +
        'sync de squads builtin pode evoluir sem invalidar missões em curso.',
    },
    {
      title: 'Recovery automático agora é finito',
      detail:
        'Falhas de preflight determinísticas viram bloqueio acionável na hora; ' +
        'as recuperáveis têm backoff e teto de tentativas. A missão para de ' +
        'repetir a mesma falha indefinidamente e pede uma nova aprovação.',
    },
    {
      title: 'Spawn cedo, autoridade estreita',
      detail:
        'O Maestro pode rotear e abrir scouts/revisores antes da execução, mas ' +
        'panes antecipados exigem readOnly nativo. Escrita, shell e Git seguem ' +
        'presos ao estágio de execução e ao worktree governado.',
    },
  ],
  fixes: [
    {
      title: 'A missão fica na frente no Canvas',
      detail:
        'Após preservar shells existentes, o pane recém-lançado do ' +
        'orquestrador recebe foco explícito e o z-index correto; um shell antigo ' +
        'não cobre mais a missão.',
    },
    {
      title: 'Lock de checkout espera sem queimar CPU',
      detail:
        'Contenção do registro de checkouts usa retry limitado com espera ' +
        'bloqueante, em vez de falhar no primeiro EEXIST ou girar o event loop.',
    },
    {
      title: 'Revisor usa modelo real do catálogo',
      detail:
        'O modelo inexistente que matava o reviewer foi removido da rota padrão, ' +
        'e erros de bloqueio voltam a chegar ao operador em vez de parar calados.',
    },
  ],
};

export const RELEASE_02200: AppRelease = {
  version: '0.22.0',
  date: '2026-08-02',
  codename: 'O piloto aprende a pilotar',
  summary:
    'O Nexus passa a saber O QUE está executando: bug, feature, documento e ' +
    'visual têm caminhos próprios, o objetivo em português natural ativa o ' +
    'caminho certo, e nenhum projeto de UI nasce sem contrato de design — ' +
    'com catálogo aberto de 74 marcas sem chave de API. O orquestrador ganha ' +
    'instrumentos de leitura (cota, ranking, skills, CLIs) para decidir antes ' +
    'de gastar.',
  highlights: [
    {
      title: 'Tipo de trabalho muda o grafo',
      detail:
        'Corrigir um bug deixa de ser o mesmo caminho de criar uma feature: ' +
        'a missão de bug ganha reprodução antes da correção e teste de ' +
        'regressão depois, com aceite "falha no HEAD atual, passa depois". ' +
        'Documentação fica fisicamente cercada fora do código. Classificação ' +
        'fraca nunca vira restrição irreversível.',
    },
    {
      title: 'Contrato de design de ponta a ponta',
      detail:
        'Missão de UI sem contrato materializa um sozinha — das suas ' +
        'referências locais, do catálogo aberto getdesign (74 marcas, sem ' +
        'chave) ou derivado dos tokens que o projeto já tem. Os bytes são ' +
        'selados no plano e chegam ao executor e ao revisor; o sensor mede ' +
        'token declarado com o valor documentado, e comentário não engana.',
    },
    {
      title: 'Instrumentos do piloto',
      detail:
        'Cota por conta, ranking de modelos, inventário de skills, CLIs e ' +
        'MCPs viram leitura que o orquestrador consulta antes de montar o ' +
        'time — sem vazar segredo, e-mail nem caminho, e dizendo "não sei" ' +
        'quando o produto não mede (liveness de MCP, ranking estimado).',
    },
    {
      title: 'Português natural ativa o caminho visual',
      detail:
        '"Arrumar o visual", "trocar as cores do tema" e "deixar a tela mais ' +
        'bonita" passam a conceder as skills de design e o revisor de UX. ' +
        'Uma gramática única substitui as cinco que divergiam — "paginação" ' +
        'não é mais página, "core" não é mais cor.',
    },
  ],
  fixes: [
    {
      title: 'Pane fantasma: invariantes na costura do layout',
      detail:
        'O placeholder que cobria a missão (com scrollback de shell antigo) ' +
        'morreu pela raiz: apresentação da missão determina o que fica ' +
        'visível, zoom e foco obsoletos não sobrevivem, e o teto de panes ' +
        'falha nomeado em vez de criar PTY órfão de 75 segundos.',
    },
    {
      title: 'Entrega física de skills nos CLIs nativos',
      detail:
        'O que a política concede agora chega de verdade ao Codex e ao ' +
        'Claude no modo padrão, com marcador de reversibilidade. BMAD é ' +
        'entregue a quem escreve PRD e stories.',
    },
    {
      title: 'Cota esgotada na frase da OpenAI troca de conta',
      detail:
        '"You exceeded your current quota" não era reconhecido e a frota ' +
        'parava numa conta morta em silêncio. Detectado e coberto por teste, ' +
        'com guarda contra falso positivo em prosa.',
    },
    {
      title: 'Revisões concorrentes com o mesmo HEAD, cerca completa',
      detail:
        'Revisores independentes rodam em paralelo lendo o mesmo HEAD ' +
        'integrado — e a cerca que recusa observação obsoleta agora cobre ' +
        'também as lanes novas de reprodução e regressão.',
    },
  ],
};

export const RELEASE_02100: AppRelease = {
  version: '0.21.0',
  date: '2026-08-01',
  codename: 'O agente deixou de ser texto',
  summary:
    'O Nexus passa a conduzir agentes por eventos tipados e transportes ACP, ' +
    'com deadlines que liberam filas, receipts verificáveis por cadeia e ' +
    'identidade criptográfica no handoff. A UI deixa de ser casca: settings, ' +
    'wizard, panes e timeline agora mostram e executam o estado real da missão.',
  highlights: [
    {
      title: 'Observer plane tipado',
      detail:
        'Hooks e sessões ACP emitem frames semânticos de turno, ferramenta, ' +
        'status e lifecycle. A timeline da missão valida o schema e não ' +
        'precisa inferir saúde de regex sobre scrollback.',
    },
    {
      title: 'ACP e BYOH com permissionamento real',
      detail:
        'O driver JSON-RPC sobre stdio tem handshake, timeouts, cancelamento, ' +
        'kill, injeção MCP, provenance acp-stdio e permission UI nativa. ' +
        'Harnesses preset e custom são configuráveis e testáveis sem fallback ' +
        'silencioso para PTY.',
    },
    {
      title: 'Fila e trilha fecham o ciclo de confiança',
      detail:
        'Deadlines transformam trabalho abandonado em dead-letter acionável, ' +
        'receipts carregam o hash anterior e o verify_chain detecta adulteração. ' +
        'Reroute e merge exigem identidade/atestação mantidas no Main e ' +
        'revalidadas no handoff físico.',
    },
  ],
  fixes: [
    {
      title: 'UI operacional completa',
      detail:
        'Mission Composer, wizard, journal, ops board, settings ACP, panes ' +
        'semânticos e estados de erro foram ligados a ações reais, com ' +
        'hierarquia visual, acessibilidade e tokens do design system.',
    },
  ],
};

export const RELEASE_02002: AppRelease = {
  version: '0.20.2',
  date: '2026-07-31',
  codename: 'Travar deixou de ser mudo',
  summary:
    'Uma missão entregou tudo — 8 tasks done, 8 dispatches completed, 8 ' +
    'worktrees integrated — e mesmo assim ficou eterna em "running". O gate ' +
    'de release morreu por timeout e o post-mortem no banco não tinha o que ' +
    'ler: o motivo do wait do driver e o not-ready do autopilot do PREVC só ' +
    'existiam em memória. Esta versão torna esses dois motivos duráveis. Ela ' +
    'não conserta a parada; ela faz a parada dizer o nome dela.',
  highlights: [
    {
      title: 'O motivo da parada agora sobrevive ao processo',
      detail:
        'Duas camadas decidem não avançar: o Mission Driver, quando escolhe ' +
        'esperar, e o autopilot do PREVC, quando se declara not-ready. Os ' +
        'dois motivos passam a ser gravados por missão, cada um com o ' +
        'instante da sua transição. Uma missão que trava para de ser um ' +
        'timeout sem causa e passa a ser um motivo com nome e hora.',
    },
    {
      title: 'Diagnóstico não vira progresso nem consome orçamento',
      detail:
        'Parar não é tentativa: o registro nunca toca revisão, contagem de ' +
        'tentativas ou updated_at — senão uma missão parada pareceria estar ' +
        'progredindo e queimaria orçamento de recuperação sem agir. E o ' +
        'registro só grava quando o motivo MUDA: a 5 segundos por tick, ' +
        'reescrever a mesma frase centenas de vezes é só I/O, o valor está ' +
        'na transição.',
    },
    {
      title: 'Instrumentação nunca derruba a missão',
      detail:
        'Falha ao registrar é engolida com aviso nas duas camadas. ' +
        'Diagnóstico não pode competir com a condução da missão — se o ' +
        'registro quebrar, o tick segue e a missão continua sendo conduzida.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.20.1',
  date: '2026-07-31',
  codename: 'O gateway não desloga ninguém',
  summary:
    'A 0.20.0 pôs um gateway de IA local na frente das CLIs. Auditando a ' +
    'integração inteira apareceu o preço escondido: ligar o gateway fazia o ' +
    'Claude de assinatura ser lido como provider de terceiro e subir sem ' +
    'credencial nenhuma. A causa era mais funda que o gateway — qualquer ' +
    'ANTHROPIC_BASE_URL herdada do ambiente, até a oficial, causava o mesmo. ' +
    'Esta versão separa transporte de identidade, dá ao gateway configuração, ' +
    'credencial e documentação próprias, e conserta o diagnóstico da voz.',
  highlights: [
    {
      title: 'Transporte deixou de responder "que plano é este?"',
      detail:
        'Cada spawn passa a construir dois ambientes: o de TRANSPORTE, que a ' +
        'CLI recebe com as base URLs no gateway, e o de IDENTIDADE, sem o ' +
        'gateway, que é quem decide HOME, credencial e classificação de ' +
        'provider. Antes o gateway vazava para a segunda decisão e o Claude ' +
        'de assinatura ganhava HOME isolado SEM a credencial nativa: /login no ' +
        'meio da missão. As três camadas que decidem isso agora concordam por ' +
        'construção, sem precisar sincronizar argumento.',
    },
    {
      title: 'A URL oficial da Anthropic parou de ser "provider de terceiro"',
      detail:
        'Bug mais antigo, achado pelo teste de regressão do item acima: ' +
        'QUALQUER ANTHROPIC_BASE_URL não vazia marcava a CLI como plano de ' +
        'terceiro — inclusive api.anthropic.com. Shells, wrappers de CLI e ' +
        'imagens de CI exportam essa variável; quando ela alcançava o Nexus, a ' +
        'assinatura perdia a credencial sem nenhum terceiro envolvido. Agora ' +
        'o host oficial é reconhecido, e URL ilegível continua fail-closed.',
    },
    {
      title: 'Gateway ganhou configuração, credencial e documentação',
      detail:
        'Campo próprio nas Configurações → Orquestrador (a variável de ' +
        'ambiente segue como fallback), NEXUS_AI_GATEWAY_API_KEY para quando o ' +
        'gateway exige a própria chave, e um aviso explícito quando ela falta ' +
        'e a credencial do provider viaja junto. O log diz, por adapter, quem ' +
        'foi roteado, quem ficou fora e por quê — antes ligar o gateway não ' +
        'produzia sinal nenhum.',
    },
    {
      title: 'Diagnóstico da voz para de acusar a chave errada',
      detail:
        '"Realtime indisponível" significa que NENHUMA rota da cadeia ' +
        'conectou, mas a mensagem nomeava só a credencial do transporte ' +
        'escolhido: com Grok configurado e sem XAI_API_KEY, quem falhava era a ' +
        'OpenAI e o operador era mandado conferir a chave do Grok. A cadeia de ' +
        'degradação virou fonte única compartilhada entre runtime e UI.',
    },
  ],
  fixes: [
    {
      title: 'Grok Voice deixou de depender de coincidência',
      detail:
        'O validador de transporte não listava grok-realtime: a rota oficial ' +
        'passava pelo ramo de coerção e só sobrevivia porque o default é ela ' +
        'mesma. Qualquer troca futura de default trocaria a voz do produto em ' +
        'silêncio.',
    },
    {
      title: 'Notas de versão e DESIGN.md dizendo a verdade',
      detail:
        'A 0.20.0 anunciava "sombra de elevação real no card" — o código ' +
        'rejeitou sombra de propósito (sobre preto ela não projeta nada, só ' +
        'embaça a borda e repintava o canvas do xterm; a elevação se lê por ' +
        'luminosidade). E o "TODOS os halos" ignorava o sprite do agente, cuja ' +
        'luz é do personagem e agora está documentada como exceção. O ' +
        'DESIGN.md ainda trazia a paleta azul-negra trocada por cinza neutro.',
    },
  ],
};

export const RELEASE_02000: AppRelease = {
  version: '0.20.0',
  date: '2026-07-31',
  codename: 'Operacional de verdade',
  summary:
    'A régua desta versão é a frase do operador: "se o Nexus estiver ' +
    'operacional de verdade". Provider morto re-rota na hora para outro agente ' +
    'do time — no primeiro 401, no esgotamento físico e até com a missão ainda ' +
    'rodando. Merge abandonado ganha watchdog. Tarefa dispensada é contada, ' +
    'nunca escondida. A voz oficial vira Grok Voice. E o visual inteiro foi ' +
    'redesenhado: hierarquia, anéis em vez de neon, rail quieto.',
  highlights: [
    {
      title: 'Reroute imediato no primeiro 401',
      detail:
        'Credencial revogada ou cota esgotada não espera mais três tentativas ' +
        'nem vira dispensa silenciosa: o failover consulta o roster selado ' +
        'ANTES de qualquer waiver e re-vincula a tarefa a outro agente da ' +
        'mesma categoria com CLI viva — com a missão ainda running. Soluços ' +
        'curtos (rate-limit) continuam na espera-pela-irmã, que resolve em ' +
        'minutos sem queimar um agente saudável.',
    },
    {
      title: 'Advisor esgotado não pendura mais a missão',
      detail:
        'A terceira forma do mesmo bug, flagrada no gate desta release: um ' +
        'advisor esgotava o spawn com a missão RODANDO (7/8 tarefas ' +
        'completas) e ela esperava para sempre. O sweep de reroute agora ' +
        'aceita missão running e re-vincula na hora.',
    },
    {
      title: 'Watchdog de merge abandonado',
      detail:
        'Uma tentativa de merge que o próprio processo abandonou (flagrada ao ' +
        'vivo: 22,7 min parada, sem erro, sem validador existindo) agora é ' +
        'detectada por idade — acima de todos os bounds legítimos de ' +
        'validação — e reconciliada como interrompida. O watchdog bate nos ' +
        'dois loops (driver e scheduler), e cada projeção do tick ficou ' +
        'isolada: uma que lança não silencia mais as seguintes.',
    },
    {
      title: 'Grok Voice é a voz oficial',
      detail:
        'O realtime padrão vira grok-voice-think-fast-2.0 (voz rex), com ' +
        'OpenAI e Gemini como degradação automática. O seletor mostra a rota, ' +
        'as configurações ganham campo para a XAI_API_KEY, e a versão do ' +
        'modelo é fixa de propósito: alias que migra sozinho não decide a voz ' +
        'do produto.',
    },
    {
      title: 'Visual redesenhado de ponta a ponta',
      detail:
        'Nome do agente domina o pane; badges viram metadado quieto; ações ' +
        'recuam até o ponteiro chegar; os halos de neon persistentes do cromo ' +
        'viraram anéis nítidos (orbe de voz, mascote, sprite do agente e FX ' +
        'de celebração seguem brilhando de propósito); o rail trocou caixas ' +
        'coloridas por cabeçalhos quietos com ponto de estado — a missão em ' +
        'execução é o único card aceso. Orbe de voz, boot e mascote seguem ' +
        'brilhando: atmosfera é deliberada, cromo não.',
    },
    {
      title: 'Gateway de IA local na frente das CLIs',
      detail:
        'NEXUS_AI_GATEWAY_BASE_URL aponta as CLIs para um gateway ' +
        'OmniRoute-like local (ANTHROPIC_BASE_URL/OPENAI_BASE_URL, só nas ' +
        'vars que cada adapter declara; planos com endpoint próprio como GLM ' +
        'e LongCat ficam intocados). O gateway troca de provider por baixo — ' +
        'a CLI nem vê a falha.',
    },
  ],
  fixes: [
    {
      title: 'Tarefa dispensada é contada, nunca escondida',
      detail:
        'Um waiver por provider indisponível sempre foi durável no recibo, ' +
        'mas invisível na tela — a tarefa aparecia idêntica a uma que ' +
        'trabalhou. Agora toda dispensa vira aprendizado da missão dizendo o ' +
        'nome da tarefa, que ela NÃO foi executada, qual CLI falhou e o ' +
        'remédio certo (login só quando a causa é auth).',
    },
    {
      title: 'PTY órfão não escreve mais em worktree liberado',
      detail:
        'Liberar o registro de um worktree agora encerra os PTYs que ' +
        'provadamente moram nele (prova por caminho, fail-closed: na dúvida ' +
        'não mata). Era a origem do worktree órfão que travava missões ' +
        'futuras.',
    },
  ],
};

export const RELEASE_01942: AppRelease = {
  version: '0.19.42',
  date: '2026-07-31',
  codename: 'A missão não para por causa de uma CLI',
  summary:
    'Uma CLI sem cota, sem login ou com binário quebrado deixou de ser o fim da ' +
    'missão: o Nexus passa a tarefa para outro agente do mesmo time aprovado e ' +
    'retoma sozinho, contando o que fez. Missões de squad salvo voltam a ganhar ' +
    'plano selado pelo Main, o modo agêntico reusa o time que você montou, e um ' +
    'pane que está subindo diz quem está subindo em vez de ficar preto.',
  highlights: [
    {
      title: 'Provider morto não trava mais a missão',
      detail:
        'Quando um worker esgota as três tentativas físicas de spawn (cota, ' +
        'login expirado, binário quebrado), a tarefa é re-roteada para outro ' +
        'agente da MESMA categoria do time aprovado, com CLI viva, e a missão ' +
        'volta a rodar sozinha. O plano não muda: o reroute é uma re-vinculação ' +
        'de despacho, nunca um replanejamento nem uma dispensa de tarefa. Cada ' +
        'CLI já provada morta fica registrada, então a cadeia é finita.',
    },
    {
      title: 'O Nexus conta a troca que fez sozinho',
      detail:
        'Toda troca automática de provider vira uma entrada durável nos ' +
        'aprendizados da missão: qual CLI morreu, quem assumiu e que o plano ' +
        'continua o mesmo. Recuperação automática deixou de ser invisível.',
    },
    {
      title: 'Missão de squad salvo ganha plano selado',
      detail:
        'Um time salvo com pelo menos um executor entra na política guiada do ' +
        'Main e recebe plano selado. Antes essas missões caíam numa rota de ' +
        'planejamento pelo orquestrador que morria em ' +
        '"workflow_authority_revoked", deixando a missão despachada com zero ' +
        'tarefas para sempre.',
    },
    {
      title: 'Agêntico reusa o time que você montou',
      detail:
        'O modo agêntico agora prefere por padrão um squad salvo elegível em ' +
        'vez de sintetizar um time novo com modelos default — que era a origem ' +
        'do gpt-5.5 aparecendo em missão nenhuma pediu.',
    },
  ],
  fixes: [
    {
      title: 'Pane que está subindo diz quem está subindo',
      detail:
        'Enquanto o PTY não reporta sessão, o pane mostra "Subindo…" com o ' +
        'agente, a CLI e o modelo — e avisa honestamente quando passa do tempo ' +
        'normal de cold start. O retângulo preto sem explicação era lido como ' +
        '"pane morto tapando a missão".',
    },
    {
      title: 'Frota da missão visível fora do foco',
      detail:
        'A lista de agentes de uma missão aparece sempre que existirem panes ' +
        'dela, não só quando a missão está aberta no grid.',
    },
  ],
};

export const RELEASE_01941: AppRelease = {
  version: '0.19.41',
  date: '2026-07-31',
  codename: 'Missão destrava, diagnóstico aparece',
  summary:
    'Uma missão que falha não condena mais o projeto: bloqueios órfãos da fila ' +
    'de merge são retirados sozinhos, o Retomar volta a funcionar, o erro real ' +
    'aparece legível com um clique, e pedidos de análise viram missões de ' +
    'consulta que terminam com relatório em vez de um pipeline de código.',
  highlights: [
    {
      title: 'Fila de merge não brica mais o projeto',
      detail:
        'Um bloqueio cuja missão foi removida é retirado automaticamente — na ' +
        'abertura do projeto, na remoção da missão e a cada passada do ' +
        'scheduler — com evento de auditoria. Antes, UMA missão rejeitada e ' +
        'deletada condenava todas as seguintes a "merge diferido 12 vezes".',
    },
    {
      title: 'Diagnóstico da falha a um clique',
      detail:
        'Clicar numa missão com falha técnica abre o diagnóstico parseado em ' +
        'seções legíveis (sem códigos internos), com "Retomar missão" ao lado. ' +
        'O toast "Ver diagnóstico" navega direto para a missão certa e o card ' +
        'do Ops Board ficou clicável mostrando a primeira linha do erro.',
    },
    {
      title: 'Análise vira missão de consulta no piloto automático',
      detail:
        '"analise…", "audite…", "explique…" agora sugerem e aplicam a lane de ' +
        'consulta (somente leitura, termina com relatório durável) com um chip ' +
        'visível e reversível — em vez de montar worktree e fila de merge para ' +
        'responder uma pergunta.',
    },
    {
      title: 'Retomar missão volta a funcionar',
      detail:
        'O selo do plano ignora worktrees terminais do plano anterior; a ' +
        'retomada replaneja, ressuscita o worktree preservado e redespacha em ' +
        'vez de morrer em "sealed after the first worktree allocation".',
    },
  ],
  fixes: [
    {
      title: 'Pane vazio não cobre mais a missão',
      detail:
        'A apresentação de panes espera a hidratação do layout: o placeholder ' +
        'salvo não substitui mais os panes reais numa corrida de boot, o ' +
        'recovery descarta o placeholder solitário e dividir/adicionar panes ' +
        'limpa um maximize obsoleto que escondia o grid.',
    },
    {
      title: 'Journal de missão não perde eventos',
      detail:
        'Chaves de idempotência longas eram rejeitadas em silêncio pelo limite ' +
        'de 128 caracteres; agora são comprimidas por hash e os eventos chegam ' +
        'ao journal.',
    },
  ],
};

export const RELEASE_01940: AppRelease = {
  version: '0.19.40',
  date: '2026-07-31',
  codename: 'Sem cerimônia',
  summary:
    'O Maestro para de gastar minutos e tokens com burocracia PREVC que o Main já executa sozinho, a aprovação da missão volta a ser um clique só, e as travas de retomada descobertas em produção foram eliminadas.',
  highlights: [
    {
      title: 'Fim da cerimônia PREVC do orquestrador',
      detail:
        'Em missões guiadas o Main já congela o contrato, avança estágios, roda revisões e sensores e conclui a missão. O kickoff agora diz isso explicitamente: sem freeze/Doctor/prepare_execution manual, sem ACK obrigatório em entregas, sem polling para um set_status que sempre seria rejeitado. As tools de cerimônia falham rápido com orientação clara nesse caminho.',
    },
    {
      title: 'Aprovação em um clique',
      detail:
        'O "Começar" do plano revisado no wizard já é a aprovação — nada de modal nativo duplicado na primeira missão. O modal continua para risco destrutivo, promoção de plano, modo governado e chamadas fora do wizard.',
    },
    {
      title: 'Roteador dentro do roster',
      detail:
        'nexus_route_task honra o roster selado da missão: nunca mais sugere um adapter fora do plano aprovado. Tarefa fora do plano falha com motivo claro; sem missão, o roteamento livre continua.',
    },
    {
      title: 'Restore sem diálogo e sessão marcada',
      detail:
        'Panes restaurados voltam direto (ask/pause viram opt-in), e quando uma sessão é recriada sobre um pane com histórico, um divisor visível separa o scrollback morto da sessão viva.',
    },
  ],
  fixes: [
    {
      title: 'Retry não morre mais em worktree failed',
      detail:
        'A liberação de worktree de dispatch terminal agora usa o marcador de ressurreição: a tentativa seguinte do bootstrap recovery re-prova a identidade física e segue, em vez de bloquear a missão com "task worktree is already failed".',
    },
    {
      title: 'Driver desligado não falha em silêncio',
      detail:
        'Missão guiada com o mission driver desativado recebe aviso explícito no início — a conclusão depende dele — em vez de nunca terminar sem explicação.',
    },
  ],
};

export const RELEASE_01939: AppRelease = {
  version: '0.19.39',
  date: '2026-07-30',
  codename: 'Vibecode sem atrito',
  summary:
    'O caminho padrão fica liso de verdade: até 8 workers em paralelo, providers autenticados reconhecidos na hora, executor que termina sem mudança completa sem deadlock, e nenhum retry silencioso infinito — todo bloqueio tem saída automática ou motivo acionável.',
  highlights: [
    {
      title: 'Paralelismo real por padrão',
      detail:
        'O teto aprovado de workers é o cap da wave no operator-choice — fim do clamp adaptativo que iniciava em 2. Limites de máquina são lidos de verdade (núcleos e budget de panes do renderer), risco restringe a aprovação e não o paralelismo, e a criação de worktrees em onda é serializada para não correr em lock do Git.',
    },
    {
      title: 'AGY participa sem truque',
      detail:
        'A sessão AGY vive no Keychain do macOS: todos os limites de missão aquecem essa prova antes de montar rosters e squads. O briefing vai nativamente por argv com prova física de aceite, o handoff real é lido mesmo com quebra de linha do TUI e o exit pós-entrega vale como conclusão, não como falha de boot.',
    },
    {
      title: 'Executor sem mudança também completa',
      detail:
        'Objetivos de verificação que terminam sem nenhum commit ganham caminho legítimo: handoff físico + worktree limpo + HEAD igual à base selada completam com receipt de no-change, e reviewer/QA validam a decisão. Worktree sujo sem commit bloqueia na hora com motivo claro.',
    },
    {
      title: 'Nada trava em silêncio',
      detail:
        'Dispatch pré-claim, defer de merge e retry de provider têm limites visíveis com bloco técnico auditável. Gerações órfãs de plano são aposentadas, worktrees de dono morto são liberados e a recuperação pós-restart continua a missão em contexto novo em vez de morrer num pane vermelho.',
    },
    {
      title: 'Memória sob controle',
      detail:
        'O transporte PTY ganhou cap de buffer de gap, recover single-flight com heal de buraco, backpressure de envio main→renderer e throttle de escrita no xterm — sessões pesadas não inflam mais o app.',
    },
  ],
  fixes: [
    {
      title: 'Pane certo, shell certo',
      detail:
        'Panes do operador abrem o login shell real da conta (via Directory Services) como login shell, com o PATH completo. O placeholder estrutural não cobre mais o grid no lançamento nem um maximize esquecido esconde os panes da missão.',
    },
    {
      title: 'Missão nunca some atrás de um shell',
      detail:
        'Fechar o último pane de uma missão em execução mostra um toast com "Reabrir panes" pelo mesmo caminho do card. A missão continua visível e a um clique de distância.',
    },
    {
      title: 'Erro que diz o motivo',
      detail:
        'Worker sem rota, merge sem commit e falhas de bootstrap agora nomeiam a causa concreta em português — login-needed, conta ausente, modelo não pronto, ownership sobreposto — em vez de mensagens crípticas.',
    },
  ],
};

export const RELEASE_01938: AppRelease = {
  version: '0.19.38',
  date: '2026-07-29',
  codename: 'Missões que seguem em frente',
  summary:
    'O Nexus mantém missões e panes vivos através de falhas técnicas, reloads e concorrência entre agentes, com inicialização mais rápida, recuperação automática e qualidade ligada ao código real.',
  highlights: [
    {
      title: 'Autopiloto multi-CLI de verdade',
      detail:
        'No modo Autopiloto, qualquer CLI instalada, autenticada e capaz de entregar handoff pode executar, revisar ou validar. Acesso de rede e autoaprovação do próprio provider ficam disponíveis durante toda a missão; busca/fetch nativos são usados quando a CLI oferece essa capacidade.',
    },
    {
      title: 'Maestro multi-CLI sem depender de MCP',
      detail:
        'CLIs PTY compatíveis coordenam plano, operações e conclusão pelo dispatcher Main-owned. A autorização fica ligada à sessão, missão, papel e contrato aprovados; chamadas são deduplicadas e os resultados voltam ao mesmo terminal.',
    },
    {
      title: 'Falha técnica vira recuperação',
      detail:
        'Saída precoce, falha de bootstrap, indisponibilidade temporária e retomada após reinício voltam para uma fila durável com retry e backoff. Bloqueio fica reservado para autenticação, decisão humana, ambiguidade real ou ação sensível.',
    },
    {
      title: 'PREVC acompanha sem segurar a largada',
      detail:
        'Memória, orientação e contrato são preparados em paralelo ao trabalho. O PREVC valida a promoção e o merge, sem congelar a missão antes do primeiro worker nem transformar contexto incompleto em beco sem saída.',
    },
    {
      title: 'Memória operacional automática',
      detail:
        'SQLite FTS5 é a fonte canônica, Markdown continua legível no Obsidian e decisões confiáveis entram em recall automático limitado antes de planejar, executar e revisar. O mapa estrutural atualiza somente o que mudou.',
    },
    {
      title: 'Qualidade ligada ao código real',
      detail:
        'Receipts agora se ligam ao diff, contrato, sensores, Git físico e revisão independente. A análise do candidate procura código morto, duplicação, APIs parecidas, violações de fronteira, blast radius e lacunas de teste.',
    },
    {
      title: 'Núcleo simples e modo Hardened opcional',
      detail:
        'O padrão mantém worktrees separados, identidade por sessão e merge validado pelo Main sem sandbox de provider ou kernel. Confinamento e verificações rigorosas continuam disponíveis no modo Hardened.',
    },
  ],
  fixes: [
    {
      title: 'A missão escolhe como a equipe trabalha',
      detail:
        'Implementação mantém executor, revisão e QA; uma rodada explícita de opiniões ou papéis abre todos os especialistas em paralelo. A topologia fica selada no plano e a missão só termina depois de ACKs reais e da consolidação durável do Maestro.',
    },
    {
      title: 'Maestro ocupado continua no comando',
      detail:
        'Entregas aguardam um idle estável antes de escrever no terminal. Um busy transitório não consome retry nem recria o Maestro; missões normais avançam pelo aceite físico do transporte, enquanto fanout preserva ACK individual e consolidação durável.',
    },
    {
      title: 'Uso do Codex não congela o Nexus',
      detail:
        'Rollouts grandes são processados em blocos com yield para o event loop. Histórico copiado, raiz física divergente e replay deixam de contaminar custo/XP ou ocupar o processo principal enquanto panes e scheduler esperam.',
    },
    {
      title: 'Interface não corre na frente do núcleo',
      detail:
        'A janela nativa e o Dock continuam aparecendo cedo, mas React só inicia depois que o Main registrou todos os canais IPC. Um primeiro launch lento não deixa mais providers, contas ou missão presos em estado de fallback até recarregar.',
    },
    {
      title: 'Fim do “caminho não pôde ser selado”',
      detail:
        'Objetivos em linguagem natural recebem ownership a partir de um inventário limitado do projeto. Arquivos explícitos continuam exatos, mas a falta de um path literal não impede mais o lançamento.',
    },
    {
      title: 'Pane antigo não sela a missão atual',
      detail:
        'Autoridade persisted bloqueada ou dispatched é reconciliada para o estado executável antes do spawn. Ao reabrir o app, panes de missão são retomados pelo Main sem depender da preferência de restauração de terminais avulsos.',
    },
    {
      title: 'Autopiloto conserva a autoridade aprovada',
      detail:
        'O pane físico, o PREVC e os validadores de release agora comprovam o mesmo contrato: escrita nativa fica disponível no Autopiloto e confinada somente no Hardened. Uma divergência transitória entra em recuperação automática sem manter o wizard aberto nem pedir outro clique.',
    },
    {
      title: 'Recuperação visível, sem falso bloqueio',
      detail:
        'Rail, Ops Board e pet distinguem retry Main-owned de espera humana. Durante o backoff a missão aparece como Recuperando, não pode ser arrastada nem apagada, mas oferece Parar para interromper o retry preservando o histórico. Eventos tardios do wizard são drenados sem erro de handler.',
    },
    {
      title: 'Pane vivo reaparece sem voltar para Home',
      detail:
        'Ao alternar workspace e voltar, o renderer reapresenta a sessão Main-owned exata em vez de descartá-la como replay antigo. Consultas transitórias de autoridade repetem com backoff até uma resposta real; apenas uma resposta negativa confirmada remove o pane.',
    },
    {
      title: 'Crash de worker não condena a missão',
      detail:
        'Quando o runtime físico desaparece, o dispatch volta para pending com backoff e o substituto só assume após rebind exato de missão, pane, sessão e encarnação. Falha de heartbeat ou persistência nunca duplica um worker ainda vivo.',
    },
    {
      title: 'Capacidade cheia significa aguardar',
      detail:
        'O scheduler respeita o limite real de workers e mantém a próxima task pendente. Falta temporária de vaga não marca mais a task como failed nem encerra a missão.',
    },
    {
      title: 'Transações físicas com rollback',
      detail:
        'Falhas depois do claim desfazem exatamente a transição do Main e preservam o worktree para retry. Reinícios durante candidate, integração, pós-validação ou finalização recuperam o estágio durável em vez de condenar o branch.',
    },
    {
      title: 'Autenticação compatível com cada provider',
      detail:
        'Claude nativo usa o HOME e Keychain reais no Autopiloto; providers compatíveis com Claude, mas baseados em token, continuam isolados. CLIs com auth none iniciam sem injeção ou supressão artificial de credenciais.',
    },
    {
      title: 'Remoção de missão sem perda de histórico',
      detail:
        'O Nexus só remove missão, tasks e receipts após provar o encerramento físico do runtime. Se o teardown falhar, os registros permanecem recuperáveis e o usuário recebe um erro acionável.',
    },
    {
      title: 'OMP e lease global removidos',
      detail:
        'O runtime, configurações e interface do OMP saíram do produto. O lease AGY que alterava configuração MCP real também foi removido, eliminando symlinks destruídos, bearer órfão e conflito entre instâncias.',
    },
    {
      title: 'Gates honestos e rápidos',
      detail:
        'Risco em português recebe a mesma severidade do equivalente em inglês, requisitos explícitos desconhecidos permanecem pendentes e worktrees antigos em .dev-user-data deixam de contaminar testes e indexadores.',
    },
  ],
};

export const RELEASE_07614: AppRelease = {
  version: '0.76.14',
  date: '2026-09-11',
  codename: 'O terminal sobrevive à troca de projeto',
  summary:
    'Trocar de projeto deixava de ser navegação e virava perda: o processo do ' +
    'pane era morto no instante em que o workspace saía de cena, e o ' +
    'scrollback salvo fingia que o terminal tinha voltado — vazio. Agora os ' +
    'panes do projeto que sai ficam estacionados com a sessão viva e voltam ' +
    'intactos. Na mesma linha, pane de missão encerrada parou de ser apagado ' +
    'do layout (era perda permanente e silenciosa), e o layout parou de ' +
    'gravar os panes de um projeto sob a chave de outro.',
  highlights: [
    {
      title: 'Trocar de projeto não mata mais o que está rodando',
      detail:
        'Ao hidratar o projeto novo, o app descartava todo host fora da árvore e ' +
        'matava o PTY com force, pulando o lease — a única guarda protegia ' +
        'sessão de agente de missão, e o shell do operador nasce sem agente. ' +
        'Agora os panes do projeto que sai são estacionados: saem da tela e ' +
        'devolvem o lease de WebGL, mas mantêm terminal, processo e estado, e ' +
        'voltam ao lugar quando você retorna. Só o fechamento explícito ' +
        '(pane ✕, Fechar projeto, remover da lista) encerra.',
    },
    {
      title: 'Pane de missão encerrada para de ser apagado',
      detail:
        'Quando a Main negava autoridade de restore, o pane era fechado e o ' +
        'layout era gravado sem ele: os terminais e o histórico daqueles ' +
        'agentes sumiam para sempre, com a Main ainda dona deles. Em campo ' +
        'isso custou 7 panes de uma missão concluída e 2 de uma bloqueada. ' +
        'Agora o pane é aposentado — continua no layout, legível, e não ' +
        'reexecuta sozinho. Quem fecha é você, em Limpar projeto.',
    },
    {
      title: 'Um projeto não grava mais os panes de outro',
      detail:
        'Se uma ação sua caísse na janela exata da troca de projeto, o app ' +
        'marcava a árvore antiga como sendo do projeto novo e, 300 ms depois, ' +
        'gravava os terminais de um projeto sob a chave do outro — o terminal ' +
        'de um lugar aparecendo dentro de outro. A posse só é declarada depois ' +
        'que o layout do projeto realmente carrega.',
    },
    {
      title: 'Arrastar, soltar e colar na tela Iniciar missão',
      detail:
        'O aviso "Solte para anexar contexto à missão" ficava preso na tela — ' +
        'inclusive em outro projeto — porque quem o limpava nunca recebia o ' +
        'evento. Arrastar mídia do WhatsApp não fazia nada, porque o app exigia ' +
        'um tipo de carga que aquele arraste não traz. E colar só funcionava ' +
        'com o wizard aberto. Os três passaram a ter um só dono, e nenhum ' +
        'caminho é silencioso: se não der para anexar, o app diz o que chegou.',
    },
  ],
  fixes: [
    {
      title: 'Navegar para um projeto abre nos terminais dele',
      detail:
        'Clicar num projeto no rail com o wizard aberto deixava o destino ' +
        'colado em "O que você quer criar?". Agora abre nos terminais, como ' +
        'já fazia o caminho de abrir a pasta pelo Finder.',
    },
  ],
};
export const RELEASE_07615: AppRelease = {
  version: '0.76.15',
  date: '2026-09-11',
  codename: 'O pane não congela no redesenho e o crash report conta tudo',
  summary:
    'Resync dos módulos herdados do Orca para o v1.4.200. Um TUI que redesenha ' +
    'sem parar não congela mais o pane visível, a fila de saída deixa de prender ' +
    'buffers gigantes na memória, os crash reports ficam mais fiéis, o protocolo ' +
    'de stream ganha teto contra frames gigantes e o parser de ssh_config segue ' +
    'a semântica do OpenSSH.',
  highlights: [
    {
      title: 'TUI que redesenha sem parar não congela mais o pane',
      detail:
        'O scheduler segurava o frame aberto e, ao chegar o fechamento, esperava ' +
        'mais um pouco — e cada espera cancelava o timer de segurança da outra. ' +
        'Num stream que alterna as duas sem parar, o pane nunca drenava. Agora ' +
        'um prazo único vale para o episódio inteiro: a tela pinta no fim dele, ' +
        'seja lá quantas vezes o modo vire.',
    },
    {
      title: 'Fila de saída não prende mais buffers gigantes',
      detail:
        'Uma fatia de 16 KiB de uma leitura de 2 MB mantinha os 2 MB inteiros ' +
        'vivos enquanto qualquer resto ficasse na fila, e slots já drenados ' +
        'seguravam a string até a compactação. Fatias parciais são copiadas ' +
        'quando o resto cai à metade do retido, slot drenado solta na hora e a ' +
        'montagem dos chunks deixou de ser quadrática.',
    },
    {
      title: 'Crash reports mais fiéis',
      detail:
        'Breadcrumbs coalescidos com o payload pendente, dedupe por webContents, ' +
        'classificação por plataforma, amostragem de memória do host antes da ' +
        'morte do processo, wait status POSIX e assinatura do minidump no texto, ' +
        'notas do usuário preservadas.',
    },
    {
      title: 'Manter acordado com três modos',
      detail:
        'Off, auto e on. No macOS a assertion do sistema tem precedência sobre o ' +
        'powerSaveBlocker e o status passa a ser assinável.',
    },
    {
      title: 'Protocolo de stream do terminal com teto',
      detail:
        'Um frame JSON gigante ou profundamente aninhado chegava sem limite ao ' +
        'JSON.parse. Agora há cap de 8 MiB e limite estrutural e de aninhamento.',
    },
  ],
  fixes: [
    {
      title: 'ssh_config com a semântica do OpenSSH',
      detail:
        'Quando uma diretiva se repete no mesmo bloco Host, o primeiro valor ' +
        'vence, como no OpenSSH. No Windows o token __PROGRAMDATA__ passa a ser ' +
        'expandido: antes virava ENOENT silencioso e escondia um known_hosts ' +
        'administrado.',
    },
    {
      title: 'Proveniência do código herdado do Orca em dia',
      detail:
        'O verificador lê todos os ledgers, oito arquivos sem ledger e uma ' +
        'entrada malformada foram regularizados, e cinco ondas de resync para ' +
        'o v1.4.200 estão registradas com hash real de cada blob.',
    },
  ],
};

export const RELEASE_07616: AppRelease = {
  version: '0.76.16',
  date: '2026-09-11',
  codename: 'O ditado para de perder palavra e o pane prova que está ouvindo',
  summary:
    'Duas frentes. No ditado, o Gemini 3.5 Transcribe entra como provedor ' +
    'escolhível (transcrição literal, com o jargão técnico no vocabulário do ' +
    'decoder) ao lado do Groq — e as barras de nível do microfone passam a ' +
    'viver também na barra superior, onde ficam visíveis mesmo com o HUD ' +
    'oculto. Em panes, três ajustes de custo tirados do Orca: menos reflow ' +
    'por rajada, teto no respawn adiado e fit antes da pintura.',
  highlights: [
    {
      title: 'Prova de captura onde você está olhando',
      detail:
        'As barrinhas de nível do microfone existiam só dentro do HUD ' +
        'flutuante — e o HUD em "só áudio" devolve null, então quem esconde o ' +
        'HUD ficava sem nenhuma prova de que o áudio estava entrando. Agora ' +
        'elas aparecem na barra superior, ao lado do chip CODE/CHAT, ' +
        'independentes do estado do HUD.',
    },
    {
      title: 'Gemini 3.5 Transcribe como provedor de ditado',
      detail:
        'Transcrição LITERAL com `verbatim` — o modo `smart` remove muletas de ' +
        'fala, que era justamente a queixa de "a palavra que eu falei não ' +
        'entrou". O vocabulário técnico do modo code vai como ' +
        '`custom_vocabulary` para o decoder. Vem ligado quando existe ' +
        'GEMINI_API_KEY; sem a chave, a cadeia Whisper (Groq → OpenAI → ' +
        'whisper.cpp) assume sozinha, e o provedor continua escolhível em ' +
        'Configurações › Serviços.',
    },
    {
      title: 'O chip não mente sobre o idioma',
      detail:
        'O Gemini transcreve e não traduz — com ele ativo, o modo CODE entrega ' +
        'português, como escolhido. Como um tooltip não avisa quem já está ' +
        'ditando, o próprio rótulo passa a denunciar: o chip mostra `CODE·PT`.',
    },
    {
      title: 'Panes mais baratos em rajada de redesenho',
      detail:
        'O debounce de refit sobe de 60ms para 150ms: a troca de colunas ' +
        'dispara reflow do scrollback inteiro, e a 60ms cada pane grande ' +
        'refazia esse trabalho ~2,5x mais vezes por rajada.',
    },
    {
      title: 'Respawn adiado não tenta para sempre em silêncio',
      detail:
        'Um slot que nunca fica mensurável reagendava de 2 em 2 segundos para ' +
        'sempre, deixando um timer vivo e um pane vazio sem explicação. Agora ' +
        'há um teto de 60s e, ao estourar, o próprio pane diz o motivo.',
    },
    {
      title: 'Terminal assume a largura nova antes da pintura',
      detail:
        'Quando a sidebar abre e os panes esticam, o fit passa a rodar dentro ' +
        'do layout effect — o container já tem o tamanho novo e o terminal ' +
        'nunca aparece com a grade antiga. Sem isso o debounce maior deixaria ' +
        'as colunas velhas na tela por mais tempo.',
    },
  ],
  fixes: [
    {
      title: 'Modo do ditado não é mais apagado por upgrade',
      detail:
        'A migração que instala o Gemini escrevia os defaults por cima de TODOS ' +
        'os campos do topo da cadeia — e o modo CODE/CHAT mora justamente ali. ' +
        'Quem tinha escolhido CHAT voltava para CODE, e como o arquivo é ' +
        'reescrito a perda era permanente.',
    },
    {
      title: 'Head fixado de propósito é respeitado',
      detail:
        'A mesma migração só checava "o Gemini está ausente?", nunca "esta é a ' +
        'cadeia de fábrica". Quem fixou `local-whisper` para manter o áudio na ' +
        'máquina ganharia o Gemini na frente — e como o Gemini também é o brain ' +
        'padrão, a chave costuma existir: a fala iria para a nuvem sem ninguém ' +
        'pedir. Agora a migração só age sobre a cadeia padrão.',
    },
    {
      title: 'Interação que falhou não vira transcrição',
      detail:
        'Uma resposta com status de falha mas com texto parcial era aceita como ' +
        'sucesso e injetada no pane como se fosse fala. Agora só passos de ' +
        'saída concluídos contam.',
    },
    {
      title: 'Vocabulário técnico não vaza para o modo CHAT',
      detail:
        'O viés de vocabulário do modo code passou a ser ligado pelo mesmo ' +
        'sinal que o caminho Whisper usa (o prompt de priming), para os dois ' +
        'provedores não discordarem sobre o que o modo significa.',
    },
    {
      title: 'O wake não gasta o orçamento com modelo generativo',
      detail:
        'A cadeia do wake foi reordenada para os provedores de transcrição ' +
        'rápida virem primeiro: uma chamada generativa entre a Groq e a OpenAI ' +
        'queimava a fatia apertada do orçamento numa tarefa de duas palavras.',
    },
  ],
};

export const RELEASE_07617: AppRelease = {
  version: '0.76.17',
  date: '2026-09-11',
  codename: 'O pane estreito para de encher a tela de lixo',
  summary:
    'Com muitos panes abertos, cada pane fica estreito — e a linha de status ' +
    'do agente, redesenhada no lugar a cada tick, passa a quebrar. O `\\r` ' +
    'seguinte volta à coluna 0 da linha de baixo, o cursor desce um degrau por ' +
    'tick e a tela enche de lixo permanente. Agora a grade do terminal não ' +
    'desce abaixo de 60 colunas enquanto há sessão viva.',
  highlights: [
    {
      title: 'Pane estreito para de virar lixo',
      detail:
        'Medimos ao vivo: numa janela de 1280, três panes lado a lado dão 28 ' +
        'colunas, quatro dão 21 e cinco ou mais dão 8 — enquanto a linha de ' +
        'status realista de um agente tem 51 caracteres. A grade passa a não ' +
        'descer abaixo de 60 colunas: o agente vê largura suficiente, para de ' +
        'quebrar a linha e para de subir resíduo. O que sobra fica cortado pela ' +
        'borda do pane — corte se recupera alargando o pane, creep corrompia o ' +
        'histórico para sempre.',
    },
    {
      title: 'Um caminho só para medir o terminal',
      detail:
        'O fit passa sempre pelo mesmo wrapper, então nenhuma das seis rotas de ' +
        'redimensionamento (observer por pane, refit global, reveal, spawn) ' +
        'escapa da regra.',
    },
  ],
  fixes: [],
};

export const RELEASE_07618: AppRelease = {
  version: '0.76.18',
  date: '2026-09-11',
  codename: 'O terminal deixa de ficar escondido na tela de criação',
  summary:
    'A tela "O que você quer criar?" só oferecia "Iniciar criação" — para abrir ' +
    'um terminal era preciso sair para Terminais, e não havia como escolher ' +
    'quais IAs abrir em cada painel. A capacidade existia e tinha sido ' +
    'perdida: agora ela volta, visível, abaixo do formulário.',
  highlights: [
    {
      title: 'Montar seus próprios painéis, sem sair da criação',
      detail:
        '"Prefere trabalhar nos terminais?" traz duas portas. "Montar meus ' +
        'terminais" abre o assistente que deixa escolher a pasta, a quantidade ' +
        'de painéis e UMA IA DIFERENTE EM CADA UM. "Terminal sem IA" abre um ' +
        'terminal direto, para quem quer só digitar comandos.',
    },
    {
      title: 'Seu pedido não se perde ao ir para os terminais',
      detail:
        'Ir para os terminais não apaga o que você já escreveu: ao voltar para ' +
        'a criação, o pedido continua no campo. Verificado ao vivo.',
    },
    {
      title: 'O CTA continua sendo um só',
      detail:
        'Os dois cartões novos são secundários e neutros — "Iniciar criação" ' +
        'segue sendo a única ação primária da tela, e a cor de estado do ' +
        'produto continua significando estado, não decoração.',
    },
  ],
  fixes: [],
};

export const RELEASE_07619: AppRelease = {
  version: '0.76.19',
  date: '2026-09-13',
  codename: 'Chaves de API unificadas, Jarvis visível e resguardo de terminal',
  summary:
    'Painel centralizado de Chaves de API (Gemini, Grok, Groq, OpenAI, Claude e outros) ' +
    'com salvamento no Keychain, assistente Jarvis embutida diretamente nas configurações ' +
    'internas, orientação em português para ausência de bundle em disco e drenagem pré-exit no terminal.',
  highlights: [
    {
      title: 'Central de Chaves de API unificada',
      detail:
        'Novo painel "Chaves de API" em Configurações para gerenciar Gemini, Grok, Groq, OpenAI, ' +
        'Claude, ElevenLabs, DeepSeek, Kimi, Replicate e OpenRouter em um só lugar, com ' +
        'salvamento automático no Keychain seguro e propagação para Jarvis, CLIs e Estúdio de Mídia.',
    },
    {
      title: 'Jarvis visível e configurável nas configurações internas',
      detail:
        'A assistente Jarvis agora aparece com destaque em "Jarvis & Voz", trazendo todo o painel ' +
        'de conversa ao vivo (Grok Voice, Gemini Live, OpenAI Realtime), personalização, timbre, ' +
        'atalhos de atendimento e microfone de forma embutida e direta, sem modal escondido.',
    },
    {
      title: 'Orientação clara quando o executável é movido ou excluído',
      detail:
        'Se o aplicativo em disco for apagado ou movido enquanto estava ' +
        'aberto, o Darwin PTY Supervisor não cospe mais erro cru de ENOENT: ' +
        'ele avisa em português que o app foi removido do disco e pede ' +
        'reabertura ou novo build.',
    },
    {
      title: 'Fim do texto sobreposto no encerramento de terminal',
      detail:
        'O evento de exit agora drena e descarrega todo o buffer pendente no ' +
        'xterm antes de pintar "process exited", eliminando a corrida visual ' +
        'que deixava resíduos de texto embaralhados na tela.',
    },
  ],
  fixes: [
    {
      title: 'F-204: Resguardo de bundle em disco e drenagem pré-exit no terminal',
      detail:
        'Previne travamentos ou mensagens de erro cruas quando arquivos do bundle são removidos em tempo de execução, e drena a saída do PTY antes de renderizar o banner de saída.',
    },
    {
      title: 'F-350: Chaves de API dispersas e configuração da Jarvis oculta em modal',
      detail:
        'Criação da seção Chaves de API para todos os provedores e embutimento nativo do painel da Jarvis nas configurações internas.',
    },
  ],
};

export const RELEASE_07620: AppRelease = {
  version: '0.76.20',
  date: '2026-09-13',
  codename: 'Orquestração estável, terminais transparentes e modelos de fronteira',
  summary:
    'Foco estável sem roubo de cursor por workers em background, abertura direta em terminais ao iniciar workspaces, ' +
    'instalação de CLIs no terminal com receita verificada do Meta Muse, expurgo e auto-migração de modelos legados (gpt-5.4 → gpt-5.6-luna) ' +
    'e catálogo atualizado com Kimi K2.8/K3, Devin SWE-2 e Gemini 3.8 Pro.',
  highlights: [
    {
      title: 'Foco e cursores protegidos no grid multi-painéis',
      detail:
        'A reorganização da grade preserva com precisão o terminal focado pelo operador, e workers montados em segundo plano não roubam mais o foco da digitação ativa.',
    },
    {
      title: 'Início direto em terminais e novo fluxo de workspace',
      detail:
        'Ao abrir ou selecionar um workspace, o Nexus entra diretamente nos terminais interativos em vez de prender o operador na tela de criação, com opções rápidas de montar grade multi-IA na vaga livre.',
    },
    {
      title: 'Instalação de CLIs via terminal e correção do Meta Muse',
      detail:
        'Novo botão "Instalar via terminal" em Provedores para executar a instalação em um painel interativo visível com feedback em tempo real. A receita do Meta Muse no macOS agora utiliza o Homebrew Cask oficial (brew install --cask muse-code).',
    },
    {
      title: 'Expurgo de modelos legados e migração transparente',
      detail:
        'Modelos descontinuados pela OpenAI que retornavam erro 400 (gpt-5.4, gpt-5.4-mini, gpt-5.3) foram removidos dos catálogos e ganharam migração automática transparente para gpt-5.6-luna.',
    },
    {
      title: 'Novos modelos e Jarvis direcionada',
      detail:
        'Integração oficial de Kimi K2.8 e K3, Devin SWE-2, Gemini 3.8 Pro e Flash, e suporte expandido a modelos DeepSeek, com roteamento de voz direcionado aos modelos de alta capacidade.',
    },
  ],
  fixes: [
    {
      title: 'F-513: Foco involuntário e roubo de cursor por montagem de workers no grid',
      detail:
        'Preserva o pane focado em setPanes e restringe focusFreshlyPresentedPane para workers secundários.',
    },
    {
      title: 'F-514: Falha na instalação do Meta Muse e falta de terminal visível para instalar CLIs',
      detail:
        'Atualiza receita do Muse para cask oficial e adiciona terminal interativo para instalações de CLIs.',
    },
    {
      title: 'F-515: Erro 400 por modelos legados do Codex (gpt-5.4) e distorção na ordenação de modelos',
      detail:
        'Remove modelos obsoletos, cria mapeamento migrateModelId e garante ordenação estrita por nota numérica no comparador de modelos.',
    },
  ],
};

export const RELEASE_07621: AppRelease = {
  version: '0.76.21',
  date: '2026-09-13',
  codename: 'Rei da Parada: Feixe rotativo do orquestrador e distinção real',
  summary:
    'Destaque visual de alta visibilidade para o terminal orquestrador com feixe de luz rotativo perimetral ' +
    '(Crown Beam) 100% acelerado no compositor GPU sem repintar o xterm, insígnia da coroa no badge da barra de ferramentas ' +
    'e realce dinâmico do painel líder do grid.',
  highlights: [
    {
      title: 'Feixe rotativo do orquestrador (Rei da Parada)',
      detail:
        'Um feixe de luz dinâmico e contínuo percorre o perímetro externo do terminal orquestrador via gradiente cônico animado ' +
        'no compositor GPU, destacando o líder da missão sem degradar performance nem repintar o canvas do xterm.',
    },
    {
      title: 'Insígnia da coroa e comandos de liderança',
      detail:
        'O badge orq passa a exibir a coroa dourada com drop-shadow luminoso, e o botão de liderança na barra de ferramentas ' +
        'recebe realce ativo em tons de ouro e magenta.',
    },
  ],
  fixes: [
    {
      title: 'F-516: Falta de distinção imediata do terminal orquestrador líder em grids multi-painéis',
      detail:
        'Implementado feixe luminoso perimetral com máscara de exclusão CSS e gradiente cônico animado, com suporte total a prefers-reduced-motion.',
    },
  ],
};

export const RELEASE_07622: AppRelease = {
  version: '0.76.22',
  date: '2026-09-13',
  codename: 'Preços de API em tempo real, aviso proativo de atualização e anexos duráveis no terminal',
  summary:
    'Auditoria e atualização completa dos preços e custos de uso de todas as APIs e LLMs (Anthropic, OpenAI, Kimi, Devin, Muse, Gemini, DeepSeek, Grok, GLM, Qwen), ' +
    'notificação proativa em card flutuante na UI para novas atualizações do NexusIDE com ação de 1 clique, ' +
    'e resolução de caminho absoluto e espelho em home para imagens e arquivos colados no terminal.',
  highlights: [
    {
      title: 'Preços de API atualizados e suporte a Prompt Cache',
      detail:
        'Tabela de custos por 1M de tokens alinhada aos preços oficiais de lista das APIs. Inclui Claude Fable 5.1, Opus 5/4.x, Sonnet 5/3.7, ' +
        'OpenAI GPT-6 Astra, GPT-5.6 Sol/Luna/Terra, GPT-4o/mini, Kimi K3, Devin SWE-2, Meta Muse (gratuito), Gemini 3.8 Pro/Flash e DeepSeek R1/V3, ' +
        'com cálculo exato de cache read e write.',
    },
    {
      title: 'Aviso proativo de atualização disponível',
      detail:
        'Novo banner flutuante na UI com indicador de status e botão de atualização direta sem necessidade de abrir manualmente o modal. ' +
        'Checagem rápida de boot (3s) e verificação inteligente periódica ao focar a janela do app.',
    },
    {
      title: 'Anexos de imagem duráveis no terminal e espelho na home',
      detail:
        'Ao colar imagens (⌘V) ou soltar arquivos no terminal, o caminho injetado no prompt é sempre absoluto, garantindo que agentes CLI ' +
        'e comandos do shell localizem o anexo em qualquer subpasta. Criação automática de espelho em ~/.nexus/attachments/mission-context ' +
        'para compatibilidade com ferramentas que buscam na home.',
    },
  ],
  fixes: [
    {
      title: 'F-517: Notificação de atualização disponível não visível proativamente na interface',
      detail:
        'Adicionado banner flutuante com beacon luminoso, botão pulsante no header e gatilhos de foco/boot para verificação de versão.',
    },
    {
      title: 'F-518: Preços e custos de APIs defasados e modelos compostos caindo no preço padrão',
      detail:
        'Expandida a tabela MODEL_PRICES com todas as famílias oficiais, suporte a cache de prompt e resolução inteligente de identificadores compostos.',
    },
    {
      title: 'F-519: Imagem colada no terminal não encontrada por agentes CLI devido a caminho relativo',
      detail:
        'Resolução para caminho absoluto completo no PTY e prompts de agentes, além de espelho de conveniência em ~/.nexus/attachments/mission-context.',
    },
  ],
};

export const RELEASE_07623: AppRelease = {
  version: '0.76.23',
  date: '2026-09-14',
  codename: 'Rotação automática de modelo, agy no Gemini 3.8 Pro e orquestrador sempre em foco',
  summary:
    'Quando um provider rejeita o modelo (CLI desatualizada ou id aposentado), o Nexus rotaciona o pane para o modelo ativo e religa na mesma conta — sem deixar o terminal parado. ' +
    'O adapter agy passa a abrir sempre na geração mais recente do Gemini (3.8 Pro high), com migração automática de panes legados. ' +
    'Providers ganha atualização de CLIs em 1 clique e 1 lote, e o orquestrador em modo foco não perde mais o foco quando a missão abre workers.',
  highlights: [
    {
      title: 'Rotação automática de LLM em modelo rejeitado',
      detail:
        'Erro 400 "model requires a newer version" (Codex), model_not_found e variantes agora disparam failover de MODELO: o pane migra para o modelo ativo da linhagem ' +
        '(ou o default curado do catálogo) e religa na MESMA conta. A credencial não entra em cooldown — as contas seguem operacionais.',
    },
    {
      title: 'AGY sempre no Gemini mais recente (3.8 Pro high)',
      detail:
        'Default do adapter promovido a gemini-3.8-pro-high no catálogo builtin, no catálogo publicado e nos defaults de squad. ' +
        'Panes e squads legados em gemini-3.1-pro-high são migrados no spawn — sempre a geração mais recente da linhagem pro com reasoning high.',
    },
    {
      title: 'Atualizar CLIs pelo próprio Nexus',
      detail:
        'Configurações → Providers: "Atualizar CLI" por provider instalado e "Atualizar N CLIs" em lote reexecutam a receita oficial (npm/instalador) e instalam a última versão, ' +
        'com confirmação nativa mostrando o comando exato. CLI desatualizada é a causa raiz de modelos novos rejeitados.',
    },
    {
      title: 'Orquestrador mantém o foco com workers novos',
      detail:
        'Em modo foco (pane ampliado), workers abertos pela orquestração entram no grid por trás — sem roubar o foco nem derrubar o zoom. ' +
        'O zoom só cai por apresentação/restore explícitos ou quando o pane ampliado sai da árvore.',
    },
  ],
  fixes: [
    {
      title: 'F-520: pane Codex morto com erro 400 de modelo (gpt-6-astra em CLI antiga)',
      detail:
        'Detecção de rejeição de modelo no limit-detector + failover de modelo (migração/default do catálogo) religando na mesma conta; sem alternativa, orientação acionável para atualizar a CLI.',
    },
    {
      title: 'F-520: agy abrindo em gemini-3.1-pro em vez do mais recente',
      detail:
        'Default promovido a gemini-3.8-pro-high e migração automática do id legado gemini-3.1-pro-high em todo spawn de pane e squad.',
    },
    {
      title: 'F-521: pane novo da orquestração roubava o foco do orquestrador em modo foco',
      detail:
        'Invariante I2 do layout reformulado: zoom sobrevive a writes que adicionam panes; spawn de worker preserva focusedPaneId e maximizedPaneId ativos.',
    },
    {
      title: 'Default do Codex abria em gpt-5.6-luna (drift pré-existente)',
      detail:
        'Adapter builtin volta a gpt-5.6-sol (CODEX_FRONTIER_MODEL), alinhado ao catálogo publicado; muse passa a ser oferecido pelo adapter builtin; suíte de testes volta ao verde total (mock app.on do updater e rótulo da seção Chaves de API e Conta).',
    },
  ],
};

export const RELEASE_07624: AppRelease = {
  version: '0.76.24',
  date: '2026-09-14',
  codename: 'Cotas com a verdade do provider, ditado resiliente, workers distribuídos e mídia sempre aceita',
  summary:
    'A análise de cotas deixa de mentir (cooldown nunca mais pinta 100% falso), o ditado sobrevive a qualquer chave Gemini e diz qual API atendeu, ' +
    'os workers de missão passam a se distribuir entre os CLIs da máquina sempre no modelo mais atual, e imagem do WhatsApp passa a ser aceita ' +
    'sempre — arrastada ou colada, no pane ou na missão.',
  highlights: [
    {
      title: 'Cooldown nunca mais fabrica 100% nas cotas',
      detail:
        'Barra e contadores vêm SOMENTE da telemetria real; conta pausada mostra o percentual verdadeiro + selo "pausa". Refutação de cooldown fantasma com gate justo (0.8), ' +
        'GLM/Z.ai pelas contagens exatas, reconsulta de 5 min e countdown por minuto. Rail sem cortes: "54%" inteiro, menus completos.',
    },
    {
      title: 'Ditado resiliente e transparente (F-524)',
      detail:
        'Gemini STT com rota universal: chave sem acesso ao preview cai para generateContent, que também TRADUZ PT→EN no modo CODE. O chip anuncia "via {provider}", ' +
        'o HUD mostra quem transcreveu e a falha vem com correção em português (configurar chave, ativar Groq, instalar whisper.cpp).',
    },
    {
      title: 'Workers distribuídos entre os CLIs da máquina (F-525)',
      detail:
        'Lane governada aberta para os builtin writáveis (Codex, Claude, AGY, Grok, GLM, Kimi): Codex no sandbox nativo, demais no boundary worktree+merge. ' +
        'Fallback do roteador escolhe o CLI menos usado e o pool multi-CLI alimenta a diversidade — chega de tudo em gpt-5.6-sol.',
    },
    {
      title: 'Imagem do WhatsApp aceita sempre (F-526)',
      detail:
        'Mídia que chega sem arquivo, só como HTML com imagem embutida, é extraída, salva no mission-context e injetada com caminho absoluto — no terminal, no wizard e na missão.',
    },
  ],
  fixes: [
    {
      title: 'F-522: cockpit mostrava 100% vermelho numa conta com folga comprovada',
      detail:
        'Caso real: conta Codex retornoja em cooldown(quota) exibindo barra 100% enquanto o serviço reportava Semanal 54%. Correção em três camadas: exibição por telemetria, refutação com gate de 0.8 e cooldown vencido ignorado.',
    },
    {
      title: 'F-524: ditado Gemini morria em chave sem preview e não traduzia',
      detail:
        'Interactions API (preview) continua como etapa literal; 403/404/status incompleto e o modo inglês caem para generateContent (GA para toda chave AI Studio, com tradução PT→EN via prompt).',
    },
    {
      title: 'F-525: toda missão concentrava em Codex gpt-5.6-sol',
      detail:
        'Release-qualified writers expandidos + fallback least-used no roteador + grok-4.6 como default no catálogo publicado e nos squads (o publicado estava defasado em 4.5).',
    },
    {
      title: 'F-526: arrastar imagem do WhatsApp não fazia nada',
      detail:
        'Drop/colagem com imagem embutida em data:URI (sem File, sem uri-list) agora é aceita no terminal e no shell de missão; dragover libera a entrega do drop.',
    },
    {
      title: 'F-522: pane pinado podia mostrar a cota de outra conta',
      detail:
        'entryForAccount não cai mais na linha de outra conta (nem na "CLI nativo") quando a conta pinada ainda não tem entry — tooltip do CostBadge não mistura mais credenciais.',
    },
    {
      title: 'F-523: rail cortando conteúdo',
      detail:
        'Percentuais nunca mais truncados ("54" virava corte seco de "54%"), e-mail da conta ganha ellipsis de verdade, "Ver" e o indicador "Local" cabem inteiros, ' +
        'label de Configurações encolhe com ellipsis em rail estreito e a barra de cota anima com transform na GPU em vez de width.',
    },
  ],
};


export const RELEASE_07625: AppRelease = {
  version: '0.76.25',
  date: '2026-09-14',
  codename: 'Missões separadas por pane, mídia do WhatsApp de verdade e limpeza sempre à mão',
  summary:
    'Promover um pane a orquestrador nunca mais anexa à "missão padrão" em silêncio: com missões rolando, ' +
    'o Nexus pergunta qual missão o painel lidera — ou abre uma nova, separada por construção. A vista Terminais ' +
    'ganha chips de foco por missão, o botão "Nova missão" vive dentro do quadro, a imagem do WhatsApp chega ' +
    'pelo caminho real do Electron (DownloadURL/promessa) e as ações de limpar panes/missões voltam a ficar sempre visíveis.',
  highlights: [
    {
      title: 'Missão por pane, separada (F-527)',
      detail:
        '"Tornar Orquestrador" em pane sem vínculo agora abre um diálogo: escolher a missão existente ou criar uma NOVA ' +
        'separada. A promoção também para de rebaixar panes de outras missões — cada missão mantém os próprios panes.',
    },
    {
      title: 'Vista Terminais com chips de missão (F-527)',
      detail:
        'Com duas ou mais missões vivas, a vista Terminais abre focada numa missão e oferece chips para trocar ou ver todas ' +
        '— chega de grid misturando panes de missões diferentes.',
    },
    {
      title: 'Nova missão em 1 clique com outra rolando (F-527)',
      detail:
        'Botão "+ Nova missão" direto no quadro da missão atual, levando ao Caminho Expresso (uma tela: objetivo + iniciar).',
    },
    {
      title: 'Imagem do WhatsApp pelo caminho real (F-526)',
      detail:
        'O WhatsApp entrega a mídia como promessa (flavor DownloadURL) — agora o Nexus entende esse formato, além do HTML ' +
        'com data:URI e caminho local em texto, no terminal e na missão. O aviso de "nada solto" lista os tipos recebidos.',
    },
    {
      title: 'Limpar panes/missões sempre à mão (F-528)',
      detail:
        'As ações "Fechar todos os panes" e "Apagar missões" viviam escondidas atrás de um controle recolhido no rodapé — ' +
        'voltaram como linha compacta permanente, com confirmação completa antes de agir.',
    },
  ],
  fixes: [
    {
      title: 'F-527: segunda missão por pane virava bagunça na tela',
      detail:
        'Três causas corrigidas: promoção com fallback silencioso à primeira missão ativa, promoteMissionPaneRole rebaixando panes sem vínculo, ' +
        'e a vista global mostrando panes de todas as missões no mesmo grid sem separação.',
    },
    {
      title: 'F-526: drop do WhatsApp mostrava "nada foi solto no terminal"',
      detail:
        'resolveDropUris agora entende o flavor DownloadURL do Chromium (promessa de mídia de apps Electron/web) e caminho absoluto em text/plain.',
    },
    {
      title: 'F-528: sidebar cortando texto em rail estreito',
      detail:
        'Atalho ⌘K da busca com flex-shrink, título do CTA e placeholder de busca com ellipsis — nada mais corta seco no rail ajustável.',
    },
    {
      title: 'Anti-pattern de animação no brief da revisão',
      detail:
        'transição de max-height substituída por grid-template-rows (sem layout thrash), apontado pelo audit de UI.',
    },
  ],
};


export const RELEASE_07626: AppRelease = {
  version: '0.76.26',
  date: '2026-09-14',
  codename: 'O pane GLM abre de verdade — trust respondido nas duas bordas',
  summary:
    'Abrir um pane GLM (ou de qualquer CLI da família Claude Code) deixava o terminal ' +
    '"Aguardando" para sempre no diálogo "Yes, I trust this folder". O autoresponder ' +
    'desistia antes do diálogo pintar (janela de 20s contada do spawn, e o cold start ' +
    'do GLM é mais lento que isso) e, quando respondia, digitava UMA vez só: a tecla ' +
    'perdida na race do desenho da tela nunca era reenviada. Agora o diálogo de trust ' +
    'tem janela própria de 60s e toda resposta enviada exige prova de aceite — silêncio ' +
    'reenvia a tecla segura, a última tentativa usa o fallback numérico e o repaint do ' +
    'TUI encerra a verificação. Vale para todas as CLIs com diálogo de confiança ' +
    '(Claude, GLM, GLM Flash, LongCat, AGY, Grok e Kimi), no pane do operador e em missão.',
  highlights: [
    {
      title: 'Trust de cold start é respondido (F-529)',
      detail:
        'Diálogos de confiança ganham janela de observação de 60s — o relógio antigo de 20s ' +
        'expirava antes de o GLM/Z.ai terminar de subir e o pane ficava pendurado sem aviso. ' +
        'Menus de boot rápidos continuam no default de 20s, então sessões longas não pagam ' +
        'parsing para sempre.',
    },
    {
      title: 'Resposta com prova de aceite (F-529)',
      detail:
        'Um TUI que aceitou a tecla sempre repinta a tela; silêncio completo de 1,8s quer ' +
        'dizer que a tecla se perdeu. O autoresponder reenvia a mesma tecla (idempotente e ' +
        'segura), usa o fallback numérico na última tentativa quando a assinatura tem, e ' +
        'para de digitar ao comprovar o aceite — esgotadas as tentativas, o diálogo é ' +
        'devolvido ao operador em vez de chutes.',
    },
  ],
  fixes: [
    {
      title: 'F-529: abrir pane GLM ficava "Aguardando" no trust para sempre',
      detail:
        'Duas causas corrigidas no CliPromptAutoResponder: watch único de 20s valendo também ' +
        'para trust que pinta tarde, e resposta única sem verificação de efeito — o caminho ' +
        'com fallback só existia quando havia brief de missão para injetar, nunca no pane ' +
        'aberto pelo operador.',
    },
  ],
};


export const RELEASE_07628: AppRelease = {
  version: '0.76.28',
  date: '2026-09-14',
  codename: 'Trust direto GLM/Kimi, Enter garantido, sidebar sem cortes e motor inteligente',
  summary:
    'Quatro correções essenciais para estabilidade e usabilidade em produção: ' +
    '1. Pre-seeding de workspace trust no GLM, Kimi e Claude entra direto no terminal sem telas bloqueantes; ' +
    '2. Envio de prompt para workers com Enter garantido e prova de busy após o submit, evitando prompts pendurados; ' +
    '3. Expansão da sidebar para até 480px, eliminando corte de rótulos e encolhimento do badge ATUAL; ' +
    '4. Orquestrador reutiliza squads e modelos salvos pelo usuário (sem trocar para gpt-5.5) e delega uniformemente via nexus_route_task. ' +
    'A instalação Windows recebe branding Nexus e o updater trata feeds ainda sem artefato como "sem atualização".',
  highlights: [
    {
      title: 'Trust de workspace direto sem telas de confirmação (F-520)',
      detail:
        'Panes de GLM, Kimi e Claude entram diretamente no workspace sem travar na tela "Yes, I trust this folder" ' +
        'ou "Quick safety check". O Nexus pre-seeda o aceite no .claude.json e nas pastas governadas do Kimi, ' +
        'usando caminhos canônicos com realpath.',
    },
    {
      title: 'Enter garantido após injeção de prompt no pane (F-521)',
      detail:
        'Prompts colados no terminal de workers não ficam mais parados aguardando confirmação. O motor de injeção ' +
        'diferencia o eco da colagem do início real de processamento e reenvia Enter se a primeira tentativa ' +
        'for engolida pelo TUI. CLIs com suporte a prompt posicional recebem o prompt inicial diretamente nos argumentos.',
    },
    {
      title: 'Sidebar ampla e sem cortes de conteúdo (F-530)',
      detail:
        'Largura máxima da sidebar expandida para 480px (padrão 260px). O badge "ATUAL" não encolhe para "ATU", ' +
        'o atalho [⌘K] mantém espaçamento limpo e os títulos de workspaces longos truncam elegantemente com reticências.',
    },
    {
      title: 'Orquestrador inteligente com reuso de squad salvo (F-531)',
      detail:
        'O orquestrador respeita os modelos escolhidos no squad pelo usuário em vez de forçar o fallback para gpt-5.5. ' +
        'A ferramenta nexus_route_task agora está disponível para o orquestrador despachar subtarefas para a frota de ' +
        'CLIs especializadas, sem executar missões complexas sozinho sem autorização.',
    },
    {
      title: 'Instalador Windows com identidade Nexus',
      detail:
        'Setup e pacote interno usam o ícone Nexus, a tela de carregamento da marca e o updater não exibe erro quando o feed ainda não possui um artefato Windows.',
    },
  ],
  fixes: [
    {
      title: 'F-520: diálogos bloqueantes de pasta e segurança no GLM, Kimi e Claude',
      detail:
        'Configurado exactProjectTrust com realpath, pre-seeding de workspace-trust para Kimi e bypass de onboarding no .claude.json.',
    },
    {
      title: 'F-521: prompt colado no pane sem Enter automático nos workers',
      detail:
        'Corrigida race condition no submitEnter e injectWithBusyProof; suporte a native argv initial prompt para qualquer role.',
    },
    {
      title: 'F-530: barra lateral cortando badges e botões de busca',
      detail:
        'Ajustadas regras CSS da workspace rail e ampliado o limite de arraste do painel lateral.',
    },
    {
      title: 'F-531: orquestrador ignorando squad salvo e assumindo gpt-5.5 sozinho',
      detail:
        'Incluso preferSavedSquad na síntese de squads, lookup de modelo em squads ativos no nexus_pane_spawn e doutrina de delegação.',
    },
    {
      title: 'Feed vazio do updater tratado sem falso erro',
      detail:
        'Respostas 404/Not Found do mirror público são classificadas como ausência de release, mantendo a interface em dia até o primeiro pacote Windows ser publicado.',
    },
  ],
};


export const RELEASE_07629: AppRelease = {
  version: '0.76.29',
  date: '2026-09-14',
  codename: 'Multi-conta de cotas limpa, resolução de segredos e sidebar polida sem cortes',
  summary:
    'Duas melhorias fundamentais de usabilidade e multi-conta: ' +
    '1. Deduplicação de contas de cotas (elimina card duplicado de CLI nativo quando a conta já está no cofre) ' +
    'e descriptografia sob demanda para sondagem de cotas de contas secundárias do cofre (com renovação automática de OAuth Claude); ' +
    '2. Barra lateral polida com margem de respiro à direita, largura mínima de 240px (padrão 280px), ' +
    'cockpit de cotas ampliado para até 4 contas e formatação compacta de janelas sem cortes de texto.',
  highlights: [
    {
      title: 'Multi-conta de cotas limpa e sem duplicações (F-532)',
      detail:
        'A página de Uso e cotas e a barra lateral não duplicam mais conexões que já estão salvas no cofre. ' +
        'Contas secundárias têm seus segredos descriptografados sob demanda para leitura de cotas em tempo real.',
    },
    {
      title: 'Barra lateral espaçosa e cockpit de cotas para 4 contas (F-533)',
      detail:
        'Largura mínima ampliada para 240px e padrão para 280px, com margem de respiro contra a borda divisória. ' +
        'O cockpit agora exibe até 4 contas e abrevia janelas de tempo ("Sem 29% · 6d9h") para nunca quebrar ou truncar.',
    },
  ],
  fixes: [
    {
      title: 'F-532: duplicação de cards de cota e falha na sondagem de contas salvas no cofre',
      detail:
        'Suprimida linha fantasma de CLI nativo quando o login já é coberto pelo cofre; liberada descriptografia segura de segredos em provider-usage-auth e auto-refresh de OAuth Claude.',
    },
    {
      title: 'F-533: elementos encostados na divisória e janelas de cota cortadas por reticências',
      detail:
        'Ajustados paddings horizontais da barra lateral (var(--space-3)), opção compact: true no shortWindowsLine e cockpit com slice(0, 4).',
    },
  ],
};


export const RELEASE_07633: AppRelease = {
  version: '0.76.33',
  date: '2026-09-15',
  codename: 'Releases separadas por SO e CLIs Windows nativas',
  summary:
    'A versão separa de forma explícita os canais de instalação e os artefatos de release por sistema operacional: ' +
    'Windows usa PowerShell e Setup assinado, macOS usa DMG/ZIP com bash/Homebrew quando oficial, e Linux usa DEB/RPM. ' +
    'Também corrige o modal de atualização deslocado e preserva as correções operacionais da 0.76.32.',
  highlights: [
    {
      title: 'Instalação de CLI nativa por sistema operacional (F-543)',
      detail:
        'Antigravity e Devin usam os scripts oficiais .ps1 no Windows; macOS/Linux mantêm os scripts .sh. ' +
        'Aider usa uv em todos os sistemas suportados e Muse não promete um instalador Windows inexistente.',
    },
    {
      title: 'Matriz de artefatos sem mistura entre SOs',
      detail:
        'O Forge fixa Squirrel em win32, DMG/ZIP em darwin e DEB/RPM em linux. ' +
        'Cada runner gera somente o pacote nativo que o sistema consegue validar e assinar.',
    },
    {
      title: 'Modal de atualização alinhado à viewport (F-350)',
      detail:
        'A camada global não cria mais um containing block transformado de 0×0; overlays `position: fixed` ficam no lugar correto.',
    },
    {
      title: 'Refutação viva e fim dos falsos positivos de cota esgotada (F-539)',
      detail:
        'O Codex reportando headroom saudável (como 72% de uso semanal com 28% livre) não entra mais em quarentena de 12h. ' +
        'Eliminados falsos disparos de limit_reached em payloads de telemetria e refutação viva estendida para sinais do observer.',
    },
    {
      title: 'Nexus Mobile Companion v1.4.201 com 100% de testes verdes (F-540)',
      detail:
        '581 suítes e 5.026 testes passando no cliente mobile Expo 55 / React Native 0.83. ' +
        'Contratos compartilhados, screencast do navegador e biblioteca de ícones offline totalmente integrados.',
    },
    {
      title: 'Modo Foco/Palco estável e sem sobreposição de cabeçalhos (F-535, F-536)',
      detail:
        'O painel principal do palco permanece travado via stagePaneId evitando layout shifts e tremor violento ao interagir ' +
        'com companions na barra lateral. Eliminado o cabeçalho duplo em cada card e adicionada aceleração de hardware (translateZ(0)) ' +
        'para impedir disputa de composição GPU com o WebGL do terminal.',
    },
    {
      title: 'Orquestração de frota robusta e entrega de prompts (F-537)',
      detail:
        'GLM recebe --permission-mode acceptEdits e aceite de pastas confiáveis automático. ' +
        'Devin recebe prompt posicional via -- <prompt> na inicialização. ' +
        'Kimi e Antigravity (AGY) operam sem caracteres corrompidos de bracketed paste e com garantia de não-apagamento após Enter.',
    },
  ],
  fixes: [
    {
      title: 'F-543: Windows executava curl/bash e Homebrew incompatíveis',
      detail:
        'Receitas e comandos manuais agora são filtrados pelo SO; PowerShell é baixado para arquivo temporário e executado sem pipe oculto.',
    },
    {
      title: 'F-350: modal de atualização deslocado no canto esquerdo',
      detail:
        'Removidos `transform`/`-webkit-transform` do ancestral `.overlay-layer`, que fazia `position: fixed` resolver contra uma área 0×0.',
    },
    {
      title: 'F-539: falso positivo de cota esgotada no Codex com refutação viva',
      detail:
        'Hardening de regex de limite, guarda de negação false/null/0, teto de refutação em 0.8 e fallback para ~/.codex/auth.json.',
    },
    {
      title: 'F-540: companion móvel com contratos transitivos e runner isolado',
      detail:
        'Restaurados contratos de source-control, review, screencast e ícones em src/shared/ com 0 erros de tsc.',
    },
    {
      title: 'F-541: limites de arquivos no LSP sidecar e mocks de teste de orquestração',
      detail:
        'Elevado maxProjectFiles para 4.000 para suportar monorepos em crescimento e alinhadas asserções de contratos visuais.',
    },
    {
      title: 'F-535: tremor de tela e oclusão do menu de ações de pane no macOS',
      detail:
        'Promovida camada do menu e overlay para composição de hardware dedicada (translateZ(0)), prevenindo z-fighting com o canvas do xterm.',
    },
    {
      title: 'F-536: oscilação e cabeçalhos duplicados nos companion cards do modo Palco',
      detail:
        'Trava do palco por stagePaneId em vez de focar automaticamente o companion ao clicar; cabeçalho de barra redundante removido e botão explícito "Palco" adicionado.',
    },
    {
      title: 'F-537: falhas de spawn e perda de prompts iniciais em GLM, Devin, Kimi e AGY',
      detail:
        'Adicionada permissão acceptEdits no GLM, injeção posicional no Devin e proteção contra Ctrl+U residual em tool-util.ts.',
    },
    {
      title: 'F-538: companion móvel desatualizado sem suporte funcional a streaming',
      detail:
        'Herdada base completa do Orca Mobile v1.4.201 sob mobile/ com tipagem estrita de RPC e rebranding Nexus.',
    },
    {
      title: 'Windows: npm/CLIs instaláveis deixavam ENOENT/EINVAL',
      detail:
        'Corrigida a resolução de `.cmd`, fallback de diretórios Node/npm e opções de spawn para o instalador e descoberta de modelos.',
    },
    {
      title: 'Windows: Terminais ficava como canvas preto sem projeto',
      detail:
        'A navegação agora renderiza a tela de escolha de pasta e não deixa o operador sem feedback.',
    },
    {
      title: 'Jarvis: teste manual exigia escopo de workspace',
      detail:
        'Adicionada a rota de smoke test sem escopo; `voice:jarvis` permanece fail-closed para comandos reais.',
    },
    {
      title: 'Windows: grade filtrada sem panes mostrava preto',
      detail:
        'O estado vazio agora informa que não há terminal visível, evitando confundir missão sem pane com falha de renderização.',
    },
  ],
};


export const RELEASE_07634: AppRelease = {
  version: '0.76.34',
  date: '2026-09-15',
  codename: 'Goal Governor autônomo e motor de ondas para panes do grid',
  summary:
    'Introduz o Goal Governor e o motor de ondas autônomo (Onda 4, 5, 6...) no processo principal do Electron, ' +
    'permitindo execuções multi-etapas contínuas durante a madrugada em panes soltos sem parada no prompt do orquestrador; ' +
    'inclui bloqueio de suspensão do sistema, testes automáticos de transição e circuit-breaker contra consumo excessivo de tokens.',
  highlights: [
    {
      title: 'Goal Governor & Wave Engine Autônomo para Panes do Grid (F-544)',
      detail:
        'Motor supervisor integrado ao relógio adaptativo do Electron main (3s). Conduz a execução de ondas sequenciais (ex: Onda 4 -> 5 -> 6), ' +
        'avalia gates de testes/comandos e injeta comandos PTY no orquestrador assim que as tarefas e testes passam.',
    },
    {
      title: 'Prevenção de Suspensão Noturna (Anti-Sleep)',
      detail:
        'Ativação coordenada de powerSaveBlocker e MacosSystemSleepAssertion / LinuxLidSleepAssertion durante a execução de ondas noturnas, ' +
        'mantendo o Mac e os panes trabalhando até a conclusão total.',
    },
    {
      title: 'Supervisão MCP no Namespace nexus_*',
      detail:
        'Ferramentas expostas para orquestradores (Codex, Claude, AGY, Devin): nexus_goal_register, nexus_goal_status, nexus_goal_bind_pane, ' +
        'nexus_wave_advance, nexus_goal_control e nexus_goal_task_update.',
    },
    {
      title: 'Circuit Breaker Fail-Safe',
      detail:
        'Pausa automática com alerta ao operador após 3 falhas consecutivas de gate de verificação, impedindo loops infinitos e desperdício de tokens.',
    },
  ],
  fixes: [
    {
      title: 'F-544: Orquestração de ondas em panes soltos interrompida por falta de Goal Governor e supervisão autônoma',
      detail:
        'Criado o motor de supervisão autônoma de metas e ondas com gates de verificação, injeção de prompts via PTY, bloqueio de suspensão e circuit breaker.',
    },
    {
      title: 'F-542: Falha de OOM no CI e typecheck por estouro de heap do Node.js',
      detail:
        'Adicionado --max-old-space-size=4096 nas pipelines de CI, scripts de lint e typecheck e no fluxo do nexus-notary.',
    },
  ],
};


export const RELEASE_07635: AppRelease = {
  version: '0.76.35',
  date: '2026-09-15',
  codename: 'Desktop Pet fluido e integrado, recuperação fail-safe de panes e distribuição universal',
  summary:
    'Torna a movimentação do mascote desktop contínua e fluida por toda a tela, conecta os alertas do pet em tempo real ' +
    'às metas e ondas (/goal), embarca os avatares personalizados para distribuição em qualquer Mac, restaura o botão de ' +
    'Modo Palco, centraliza modais na viewport e protege contra travamento ao fechar panes reiniciados mid-mission.',
  highlights: [
    {
      title: 'Desktop Pet Fluido e Livre por Toda a Tela (F-545)',
      detail:
        'Substituído o travamento rígido em coordenadas de borda de 64px por posicionamento contínuo em tela cheia (clampPetDragFreeDesktop), ' +
        'com movimentação suave, suporte a multi-monitores e respeito estrito ao prefers-reduced-motion.',
    },
    {
      title: 'Utilidade Operacional do Pet com Metas e Terminais (F-545)',
      detail:
        'Balões e reações do pet agora acompanham em tempo real o ciclo de metas (goal-wave-started, goal-wave-completed, goal-gate-passed, ' +
        'goal-finished), com CTAs que navegam diretamente para o terminal (open-terminal) ou para o painel de operações.',
    },
    {
      title: 'Distribuição Universal de Mascotes Embarcados (F-545)',
      detail:
        'Os pets "Codex Companion" e "Nivu" foram empacotados em resources/pets/sheets/ e são provisionados automaticamente de forma idempotente ' +
        'e segura (ensureDefaultInstalledPets) em qualquer Mac na inicialização.',
    },
    {
      title: 'Recuperação Fail-Safe e Fechamento de Panes sem Deadlock (F-546)',
      detail:
        'Garantia de que panes órfãos ou com sessões PTY zumbis após reinício mid-mission possam ser fechados imediatamente sem deadlock na UI.',
    },
    {
      title: 'Modo Palco Restaurado e Modais Alinhados (F-546)',
      detail:
        'Ação do Modo Palco reintroduzida como botão primário na barra de ferramentas dos panes, e correção de modais ancorados na viewport inteira.',
    },
  ],
  fixes: [
    {
      title: 'F-545: Pet travado em posições predefinidas, sem utilidade de sistema e ausente em builds em outros Macs',
      detail:
        'Implementado clampPetDragFreeDesktop, eventos goal no pet, roteamento open-terminal e provisionamento seguro de pets padrão.',
    },
    {
      title: 'F-546: Deadlock no fechamento de panes ao reiniciar mid-mission, menu Palco ausente, desalinhamento de modais e botão de abrir panes de IAs',
      detail:
        'Implementado fallback gracioso no encerramento de panes, restaurado botão do Palco, ajustado layout fixed dos modais e visibilidade imediata de novos panes.',
    },
  ],
};


export const RELEASE_07636: AppRelease = {
  version: '0.76.36',
  date: '2026-09-15',
  codename: 'Paridade multiplataforma e release Windows determinística',
  summary:
    'Alinha fixtures e caminhos de configuração entre macOS, Linux e Windows, torna a instalação do Devin explícita no Windows, ' +
    'protege anexos selados contra substituição same-inode e elimina ECONNRESET assíncrono no daemon de PTY.',
  highlights: [
    {
      title: 'Paridade de caminhos MCP/Cline em todos os sistemas',
      detail:
        'Os testes e observadores usam APPDATA/XDG_CONFIG_HOME/Application Support conforme o SO, evitando falsos ausentes no Windows e Linux.',
    },
    {
      title: 'Devin com instalador PowerShell nativo no Windows',
      detail:
        'A superfície de instalação mantém scripts bash em macOS/Linux e usa o canal oficial PowerShell no Windows.',
    },
    {
      title: 'Anexos selados com identidade temporal',
      detail:
        'ctimeNs e mtimeNs complementam device/inode para detectar recriação same-inode e impedir remoção de substitutos.',
    },
  ],
  fixes: [
    {
      title: 'CI multiplataforma e endpoint de PTY',
      detail:
        'Suites macOS-only deixam de falhar em Linux/Windows e sockets que recebem desconexão imediata não vazam ECONNRESET.',
    },
  ],
};


export const RELEASE_07637: AppRelease = {
  version: '0.76.37',
  date: '2026-09-15',
  codename: 'Contrato de entrega, hooks vivos e conector por instância',
  summary:
    'Fecha o ciclo de entrega dos workers com contrato validado no handoff, torna os hooks de ' +
    'parada realmente vivos (ESM, continue-json para o Codex, fallback de endpoint), isola o ' +
    'conector Arms por instância, faz as recusas de tool instruírem o agente e paga as dívidas ' +
    'de evidência da 0.76.35.',
  highlights: [
    {
      title: 'Contrato de entrega no spawn (expect.schema)',
      detail:
        'nexus_pane_spawn aceita expect {schema, retries}. Num handoff success os artifacts do worker ' +
        'são validados contra o JSON Schema declarado; divergência devolve ao worker o que falta, e ' +
        'com as devoluções esgotadas o handoff entra como blocked com as violações registradas.',
    },
    {
      title: 'Régua do summary e receipt de harness',
      detail:
        'Summary acima de 400 caracteres é condensado na fronteira de frase e a íntegra vai para ' +
        'overclock.fullText. A resposta do spawn traz harness {adapterId, model, effort, source}.',
    },
    {
      title: 'Hooks de worker vivos (F-536/F-555)',
      detail:
        'O hook gerado é ESM (o require() num .mjs silenciava o relato do Stop), escreve ' +
        '{"continue":true} para o runner do Codex, relança o neto com windowsHide e cai para a porta ' +
        'publicada em arms-runtime.json quando a URL herdada está morta.',
    },
    {
      title: 'Conector Arms por instância (--descriptor)',
      detail:
        'Dev escreve arms-runtime.dev.json, o descritor leva instance e descriptorPath, o snippet de ' +
        'Conectores passa --descriptor e o conector fica amarrado a uma instância por construção.',
    },
    {
      title: 'Recusas que instruem o agente',
      detail:
        'Negações por allowlist, papel, read-only e perfil de reviewer carregam um hint: não tentar de ' +
        'novo, não reportar como bloqueio, entregar com o que tem e declarar no handoff o que faltou.',
    },
    {
      title: 'gpt-5.5 sai do catálogo; o GPT leve é o gpt-5.6-luna',
      detail:
        'O modelo deixa de existir e saiu de codex/aider, do catálogo, do picker de sessão e dos specs ' +
        'de commit-message. Squads e rotas salvos com gpt-5.5 são redirecionados para gpt-5.6-luna em ' +
        'vez de falhar no spawn.',
    },
  ],
  fixes: [
    {
      title: 'Dívidas de evidência da 0.76.35',
      detail:
        'Testes reais para ensureDefaultInstalledPets e para panes soltos na vista global; texto ' +
        'neutro no manifesto do mascote; cards F-545/F-546 apontam só para evidência existente.',
    },
    {
      title: 'Aviso de CLI ausente endurecido',
      detail:
        'label e installCommand do catálogo são citados com aspas simples POSIX antes de ir ao ' +
        'terminal, então nada do texto é interpretado pelo shell.',
    },
  ],
};

export const RELEASE_07638: AppRelease = {
  version: '0.76.38',
  date: '2026-09-15',
  codename: 'Terminais Windows com launchers nativos',
  summary:
    'Corrige a resolução de CLIs no Windows para que cada pane use o launcher nativo executável, ' +
    'preservando a sessão autenticada e impedindo que um shim POSIX derrube o host de PTY. ' +
    'Também mantém os panes de cada missão na sua própria superfície durante a navegação.',
  highlights: [
    {
      title: 'Panes de IA voltam a iniciar no Windows',
      detail:
        'Codex e as demais CLIs instaladas por npm passam a abrir pelo launcher Windows (.cmd, .bat, .exe ou .com) ' +
        'compatível com ConPTY, em vez de um arquivo de shell POSIX sem extensão.',
    },
    {
      title: 'Cada missão permanece na própria grade',
      detail:
        'Rail, atalhos, paleta e Jarvis preservam o vínculo ativo do pane com a missão, inclusive antes ' +
        'da persistência do layout, para não misturar terminais entre missões.',
    },
  ],
  fixes: [
    {
      title: 'Host de PTY não é mais derrubado por shim inválido',
      detail:
        'Caminhos de CLI salvos de versões anteriores são revalidados antes do spawn; um shim inválido é ' +
        'descartado e o launcher Windows correto é resolvido novamente.',
    },
  ],
};

export const RELEASE_07639: AppRelease = {
  version: '0.76.39',
  date: '2026-09-16',
  codename: 'Cada pedido no seu espaço',
  summary:
    'Os painéis que você abre pelo "Novo pedido" param de grudar na missão que já estava ' +
    'aberta: cada abertura ganha um espaço próprio, e os Terminais passam a ter abas por ' +
    'missão e por espaço. "Tornar orquestrador" deixa de ser beco sem saída — a missão nova ' +
    'ADOTA o painel em que você já estava trabalhando. E fecha a regressão de navegação que ' +
    'podia interromper um comando de voz durante a hidratação dos vínculos de missão.',
  highlights: [
    {
      title: 'Abas nos Terminais: missão, espaço e soltos',
      detail:
        'Cada painel pertence a exatamente um escopo e a vista desenha um de cada vez, com a ' +
        'contagem de painéis em cada aba. "Todos" continua ali para quem quer o mosaico ' +
        'inteiro. O escopo sobrevive ao restart junto com o resto do layout.',
    },
    {
      title: 'Montar meus terminais abre um espaço separado',
      detail:
        'O assistente do "Novo pedido" mina um espaço, carimba os painéis criados e já leva ' +
        'você para dentro dele. Dividir um painel mantém o irmão no mesmo espaço, e o "+ Pane" ' +
        'aberto dentro de um espaço entra nele.',
    },
    {
      title: 'A missão adota o painel que você já estava usando',
      detail:
        'Marcar um terminal como coordenador leva ao Novo pedido com um aviso; quando a missão ' +
        'começa, é aquele painel que assume. Nenhum terminal novo é aberto e o seu não é ' +
        'encerrado. Se a adoção não puder acontecer, a missão arranca com um coordenador ' +
        'próprio e o motivo é dito por extenso.',
    },
    {
      title: 'O painel focado está sempre na tela',
      detail:
        'Login de ferramenta, instalação de CLI, voz e ⌘K criam painéis e pedem sua atenção ' +
        'neles. Agora a aba acompanha o painel focado, então nunca mais somos mandados ' +
        'concluir um login num terminal que não está desenhado.',
    },
    {
      title: 'Jarvis não perde o comando em estado parcial',
      detail:
        'Se o mapa transitório de panes ainda não estiver disponível, um shell ou agente sem missão ' +
        'segue para a grade global de forma segura em vez de lançar uma exceção.',
    },
    {
      title: 'Missões continuam separadas',
      detail:
        'Quando o vínculo de runtime está disponível, as rotas de rail, atalho, paleta e voz ainda ' +
        'abrem exclusivamente a superfície de terminais da missão correspondente.',
    },
  ],
  fixes: [
    {
      title: 'Fim do orquestrador órfão',
      detail:
        'A promoção passou a respeitar a recusa do processo principal. Antes a estrela de ' +
        'coordenador aparecia na tela mesmo quando o motor não reconhecia líder nenhum, e ' +
        'você só descobria quando nada acontecia. Vínculo morto ou missão que não existe mais ' +
        'também deixaram de virar destino silencioso da promoção.',
    },
    {
      title: 'Snapshot transitório não derruba a navegação',
      detail:
        'A leitura de paneMissions agora trata ausência temporária do mapa como pane sem vínculo, ' +
        'preservando o comportamento esperado de shells e agentes comuns.',
    },
  ],
};

export const RELEASE_07641: AppRelease = {
  version: '0.76.41',
  date: '2026-09-16',
  codename: 'Panes Windows sem eco e sem limite',
  summary:
    'Esta atualização Windows corrige a abertura real dos panes: o Codex não morre mais por ' +
    'linha de comando longa, CLIs instaladas no Path voltam a ser encontradas e cada tecla é ' +
    'enviada uma única vez depois de recuperar um terminal.',
  highlights: [
    {
      title: 'Codex abre sem bater no limite do cmd.exe',
      detail:
        'O launcher npm `codex.cmd` agora é convertido de forma verificada para o Node nativo ' +
        'com o mesmo `codex.js`, evitando o erro "Linha de comando muito longa" antes do prompt.',
    },
    {
      title: 'PowerShell enxerga as CLIs instaladas',
      detail:
        'O ambiente do pane preserva a grafia `Path` herdada do Windows sem abrir a allowlist ' +
        'para outras variáveis. Login e comandos como `claude`, `codex` e ferramentas npm voltam ' +
        'a ser localizados pelo shell.',
    },
    {
      title: 'Recuperar um pane não duplica a digitação',
      detail:
        'Ao transformar um processo encerrado em shell, a sessão antiga é limpa antes de a nova ' +
        'se inscrever no xterm. Uma tecla continua sendo uma tecla, sem `CC` ou `CCCOEE`.',
    },
  ],
  fixes: [
    {
      title: 'Mac e Linux permanecem no caminho original',
      detail:
        'As adaptações de launcher e ambiente só são ativadas em `win32`; os planos sandbox e ' +
        'o comportamento de macOS/Linux não são reescritos por esta atualização.',
    },
  ],
};

export const RELEASE_07646: AppRelease = {
  version: '0.76.46',
  date: '2026-09-16',
  codename: 'Otimizar, não limitar',
  summary:
    'Canal Windows x64 com o conteúdo da 0.76.45: o teto de panes virou aviso (só a pressão ' +
    'real de memória bloqueia), pane ocioso é estacionado em vez de fechado (memória a zero, ' +
    'acorda com um clique no mesmo contexto), os seus servidores MCP globais sobem uma vez em ' +
    'vez de uma vez por pane, e o cabeçalho mostra quanto cada pane custa. Quem vem da 0.76.41 ' +
    'recebe também o conteúdo da 0.76.43 (pane guardian, sessão de CLI isolada por checkout, ' +
    'liderança única de missão).',
  highlights: [
    {
      title: 'Pane dormindo em vez de fechado',
      detail:
        'Pane ocioso sem dono (helper seu ou worker sem missão) tem o CLI encerrado após 30 ' +
        'min, ou na hora sob pressão de memória, mas fica no layout com o scrollback e um ' +
        'botão "Acordar" que retoma a MESMA conversa (resume exato por sessão). Memória do ' +
        'pane dormindo: zero.',
    },
    {
      title: 'Servidores MCP compartilhados',
      detail:
        'Os servidores MCP do seu perfil global (~19, ~600 MB por pane até a 0.76.43) sobem ' +
        'uma única vez no Nexus e cada pane fala com eles por HTTP. Um pane Claude da sua mão ' +
        'cai de ~1,1 GB para ~0,5 GB; workers já não herdavam.',
    },
    {
      title: 'Teto vira aviso; só pressão real bloqueia',
      detail:
        'Acima do teto proporcional à RAM o spawn passa com um aviso nomeando os ociosos a ' +
        'fechar. O único bloqueio é a máquina de fato sob pressão: menos de 15 % da RAM ' +
        'disponível (sinal do kernel no macOS) ou mais de 1 GB de swap. NEXUS_PANE_CAP_HARD=1 ' +
        'restaura o bloqueio por contagem para quem quiser.',
    },
    {
      title: 'Custo de cada pane no cabeçalho',
      detail:
        'O RSS da árvore de processos de cada pane (CLI + filhos MCP) aparece no cabeçalho a ' +
        'cada 30 s, com tom de aviso acima de 1,5 GB. nexus_perf_snapshot traz o mesmo.',
    },
  ],
  fixes: [
    {
      title: 'Reaper de emergência',
      detail:
        'Sob pressão de memória o guardian estaciona um pane ocioso elegível por minuto, o ' +
        'mais parado primeiro, sem esperar o TTL — nunca o seu pane, um orquestrador, um worker ' +
        'de missão ou um pane com entrega pendente.',
    },
    {
      title: 'Limites proporcionais à máquina',
      detail:
        'Teto entre 4 e 12 conforme a RAM (16 GB → 6, 24 GB → 12); mínimo disponível 15 % da ' +
        'RAM em vez de 1 GB fixo (tarde demais num Mac de 24 GB).',
    },
  ],
};

export const RELEASE_07647: AppRelease = {
  version: '0.76.47',
  date: '2026-09-16',
  codename: 'Swap não é pressão',
  summary:
    'Abrir um pane não trava mais por swap em uso: o número de swap guarda o pico, não o agora, ' +
    'e na máquina do operador ele recusava todo pane novo até reiniciar o app com o kernel ' +
    'dizendo "normal" (8 GB de swap e 62 % de RAM livre — o mesmo Mac já chegou a 16 GB). O ' +
    'gate segue como aviso, nunca trava, e o de swap passa a ser config por máquina. O guardian ' +
    'deixa de estacionar panes ociosos à toa pelo mesmo motivo.',
  highlights: [
    {
      title: 'Abrir pane não trava mais por swap',
      detail:
        'Depois que a máquina uma vez passou por pressão, o teto de 1 GB de swap passava a ' +
        'recusar QUALQUER pane novo até reiniciar — mesmo com o kernel em NORMAL e RAM ' +
        'sobrando. O número de swap em uso guarda o pico, não o agora, e cada máquina tem a sua ' +
        'medida (a mesma já chegou a 16 GB). Agora o gate só avisa e quem quiser o de swap numa ' +
        'máquina específica arma com NEXUS_PANE_MAX_SWAP_MB.',
    },
    {
      title: 'Panes param de ser estacionados sem necessidade',
      detail:
        'O reaper de emergência do guardian lia o mesmo sinal de swap e, com o pico acima do ' +
        'teto, estacionava um pane ocioso a cada minuto para sempre. Agora ele só age com a ' +
        'memória disponível de fato baixa.',
    },
    {
      title: 'O sinal de memória é o do agora',
      detail:
        'macOS usa o nível de memória do kernel (o mesmo sinal que o jetsam usa para decidir o ' +
        'que matar), Linux usa a memória disponível e o Windows a memória livre — nunca um ' +
        'número fixo igual para todas as máquinas.',
    },
  ],
  fixes: [
    {
      title: 'Nada trava o spawn: o gate só avisa',
      detail:
        'Teto de panes e pressão de memória nomeiam o que está acontecendo e quais panes ' +
        'ociosos fechar, mas quem decide abrir é você. Trava dura existe apenas como opt-in ' +
        'explícito (NEXUS_PANE_CAP_HARD=1 ou NEXUS_PANE_GUARD=hard).',
    },
    {
      title: 'Swap do Windows não é swap',
      detail:
        'No Windows o campo de "swap" do sistema é limite de commit (memória + pagefile), não ' +
        'paginação: um desktop saudável reportava mais de 20 GB e o gate acusaria pressão ' +
        'sempre. Sem sinal de swap real, quem decide é a memória livre.',
    },
  ],
};

export const CURRENT_RELEASE: AppRelease = {
  version: '0.76.52',
  date: '2026-09-18',
  codename: 'Push sai do pane',
  summary:
    'Três travas que impediam um agente dentro do pane de fazer git push ' +
    'caem de uma vez: o HOME privado da família Claude passa a carregar a ' +
    'identidade git/SSH/gh do operador, o runner de git do Main volta a ' +
    'honrar o credential helper, e nexus_git_sync fica alcançável pela mão ' +
    'do operador. O Jev entra no fluxo "abra X panes e faça Y" sem missão — ' +
    'roteamento automático no spawn, guarda só-injeção nos filhos, revisão ' +
    'do handoff e triagem de Bash. E colar mídia no pane volta a funcionar, ' +
    'dizendo o motivo real quando não dá.',
  highlights: [
    {
      title: 'Git push de dentro do pane (F-579)',
      detail:
        'Desde o HOME privado por checkout (F-567) o pane da família Claude ' +
        'nascia sem ~/.gitconfig, ~/.ssh e ~/.config/gh: o credential helper ' +
        'do gh sumia, o SSH não achava chave e todo push morria pedindo ' +
        'usuário. Panes graváveis passam a receber a identidade de ' +
        'desenvolvedor (.gitconfig, .git-credentials, .netrc, .ssh, .gnupg, ' +
        '.config/git, .config/gh); a lane sem gate hooks recebe o HOME real ' +
        'inteiro menos o estado de conversa Claude, .nexus, Library e ' +
        '.Trash. Lane somente-leitura não recebe nada e o teardown remove ' +
        'os links sem segui-los. Nenhuma fronteira foi relaxada: pane ' +
        'Claude gravável nunca foi confinado pelo kernel — a omissão só ' +
        'quebrava push, commit e gh.',
    },
    {
      title:
        'nexus_git_push e o push antes do PR voltam a funcionar em HTTPS ' +
        '(F-580)',
      detail:
        'O runner de git do Main setava GIT_CONFIG_NOSYSTEM e ' +
        'GIT_CONFIG_GLOBAL=/dev/null e descartava gh auth git-credential, ' +
        'osxkeychain, GCM e user.name/email — "could not read Username" em ' +
        'todo remoto HTTPS. A config global e de sistema do usuário volta ' +
        'a valer; a config LOCAL executável do repositório continua ' +
        'recusada e hooks, fsmonitor, gpg e protocolos seguem pinados por ' +
        'argv.',
    },
    {
      title: 'nexus_git_sync na mão do operador (F-581)',
      detail:
        'Fast-forward verificado, subconjunto estrito do git_pull que o ' +
        'pane do operador já executa em vibe — negá-lo era inconsistência, ' +
        'não fronteira. Só ui_action mantém autoridade de origem renderer; ' +
        'workers de missão não mudam.',
    },
    {
      title: 'Jev no fan-out sem missão',
      detail:
        'nexus_pane_spawn sem adapterId roteia task ?? prompt pelo mesmo ' +
        'motor do nexus_route_task (tier e especialidade pelo Jev, tabela ' +
        'de custo/capacidade) e devolve o recibo harness.source auto-route ' +
        'com tier, especialidade e motivo; a descrição do route_task deixa ' +
        'de ser "orchestrator-only". Filhos do operador herdam o allowlist ' +
        'dele em Autopilot (Hardened continua atenuado) e sempre recebem ' +
        '--strict-mcp-config / preserveUserMcp=false — um helper nunca ' +
        'carrega o perfil MCP global (F-572). A guarda Jev passa a cobrir ' +
        'os filhos em modo só-injeção (o prompt do spawn é o objetivo; ' +
        'deny ≥ 0.8, nunca modal); a mão do operador segue sem julgamento. ' +
        'O handoff sem missão passa pela mesma revisão de evidência (uma ' +
        'devolução, depois "[evidência fraca]" no resumo entregue ao pai). ' +
        'E o hook PostToolUseFailure com matcher Bash posta em /hook/triage: ' +
        'a triagem Jev da falha volta ao Claude como additionalContext, sem ' +
        'nunca bloquear.',
    },
    {
      title: 'Colar mídia no pane volta a funcionar — e diz o motivo (F-582)',
      detail:
        'Vídeo, áudio e imagem baixados do WhatsApp: o paste aceita ' +
        'qualquer tipo (vídeo era descartado em silêncio), lê text/uri-list ' +
        'e DownloadURL, a imagem embutida em HTML e, por fim, o pasteboard ' +
        'do sistema (public.file-url do Finder) via Main. Arquivo com ' +
        'caminho real vai path-first pelo Main em stream até 256 MiB — ' +
        'base64 e downloads seguem em 14 MiB. Texto colado (URL, caminho) ' +
        'nunca é interceptado. Toda recusa mostra a causa real em vez de ' +
        '"não pôde ser copiado para a missão" — inclusive a dica de ' +
        'Privacidade do macOS para ~/Downloads. Arrastar direto da janela ' +
        'do WhatsApp continua limitado pela promessa de arquivo que o ' +
        'Electron não materializa.',
    },
  ],
  fixes: [
    {
      title: 'Espelho de anexos só até 14 MiB',
      detail:
        'A cópia de conveniência em ~/.nexus/attachments/mission-context/ ' +
        'deixa de duplicar vídeos grandes na home; o arquivo do workspace ' +
        'é o único acima do teto.',
    },
    {
      title: 'Triagem ignora falha sem comando',
      detail:
        'Um PostToolUseFailure sem tool_input.command não chega ao Jev.',
    },
    {
      title: 'Consulta ao pasteboard que falha vira aviso',
      detail:
        'Depois de interceptar a colagem, uma falha ao consultar a área ' +
        'de transferência do sistema avisa no toast em vez de ficar muda.',
    },
  ],
};

export const RELEASE_07651: AppRelease = {
  version: '0.76.51',
  date: '2026-09-17',
  codename: 'Jev decide, Nexus executa',
  summary:
    'O Jev (TypeSafe) passa a decidir onde o Nexus controla: cada chamada de ' +
    'ferramenta com efeito dentro de missão é checada por coerência, injeção e ' +
    'efeito irreversível; o agente ganha recomendação de ferramenta entre as ' +
    '~170 disponíveis; o roteamento de tarefas troca palavras-chave por tier e ' +
    'especialidade calibrados; e o piloto automático chega ao desktop do Mac ' +
    'com nexus_computer_do. Sem chave TypeSafe, nada disso existe e o Nexus é ' +
    'o clássico.',
  highlights: [
    {
      title: 'Guarda de chamadas no despacho MCP',
      detail:
        'Toda chamada nexus_* com efeito, dentro de missão e fora da mão do ' +
        'operador, passa por três perguntas ao Jev: é coerente com o objetivo? ' +
        'os argumentos parecem instrução injetada por página, arquivo ou outro ' +
        'agente? o efeito é difícil de reverter? Injeção ≥ 0.8 nega com auditoria ' +
        'e devolve ao agente o motivo; ação destrutiva sem relação com o objetivo ' +
        'traz o modal de confirmação de volta mesmo em missão aprovada — exceção ' +
        'estreita à doutrina "missão aprovada não pergunta": é segurança, não ' +
        'cerimônia. Tudo o mais passa; serviço fora = fluxo de hoje. Medido: ' +
        'curl de ~/.ssh para fora → negado (injeção 0.97); rm -rf dist antes do ' +
        'build → passa (coerente); git push --force main numa missão de login → ' +
        'confirmação.',
    },
    {
      title: 'nexus_tool_pick: qual ferramenta resolve isto?',
      detail:
        'O agente descreve o que precisa e recebe as ferramentas que ELE pode ' +
        'chamar, ranqueadas por probabilidade, com a margem entre a 1ª e a 2ª. ' +
        'Pré-filtro lexical (sinônimos pt-BR → nomes em inglês) sobre a lista ' +
        'visível ao chamador, uma escolha do Jev com opção "nenhuma". Medido: ' +
        '"ver o que outro pane está fazendo" → nexus_pane_read 0.84; "rodar os ' +
        'testes" → nexus_terminal_run 1.00; "comparar três entregas" → nexus_rank ' +
        '1.00.',
    },
    {
      title: 'nexus_route_task com tier e especialidade calibrados',
      detail:
        'A heurística de palavras-chave vira fallback: o Jev classifica tier ' +
        '(trivial…critical) e especialidade (visual, security, bug, feature, doc, ' +
        'ops, general) numa chamada, cada campo aceito só com confiança ≥ 0.6. O ' +
        'tier passado pelo Maestro continua mandando; tabela, catálogo e reserva ' +
        'não mudam. O resultado ganha classifierSource (jev | heuristic | mixed) e ' +
        'escalate (0..1): "isto pede o modelo mais forte ou revisão humana?".',
    },
    {
      title: 'nexus_computer_do: piloto automático no desktop do Mac',
      detail:
        'Lê a árvore de acessibilidade do app (fallback: OCR local da janela — ' +
        'pixels nunca saem da máquina; ao Jev vão só rótulos), o Jev escolhe ' +
        'operação e elemento, o Nexus executa via System Events. Uma confirmação ' +
        'por objetivo; ação irreversível para em needs_confirmation; trava de app; ' +
        'campos de senha nunca lidos nem preenchidos; só operador ou orquestrador ' +
        'chamam; exige permissão de Acessibilidade para o NexusIDE.',
    },
    {
      title: 'Interruptores por função e log de decisões',
      detail:
        'Ajustes → Squads ganha um interruptor por superfície (guarda, ' +
        'recomendação, roteamento, além dos anteriores) sob o mestre "Piloto ' +
        'automático Jev". Cada decisão entra em Ajustes → Decisões do Jev com ' +
        'probabilidades e custo, sem nunca guardar o texto julgado; Certo/Errado ' +
        'alimenta a recalibração dos limiares.',
    },
    {
      title: 'Velocidade do modelo na barra do próprio pane',
      detail:
        'O medidor já rodava desde o boot, mas só aparecia em Ajustes → ' +
        'Diagnóstico. O chip agora fica ao lado do badge de custo, com tok/s da ' +
        'última resposta e TTFT no tooltip, pintando no acento enquanto o modelo ' +
        'gera. A busca é estrita por pane: sem medição própria, o chip não ocupa ' +
        'espaço — nunca atribui a um pane a velocidade que outro produziu.',
    },
  ],
  fixes: [
    {
      title: 'Acento é estado, não enfeite',
      detail:
        'O card de velocidade e o aviso de transporte ACP perdem a barra lateral ' +
        'rosa: o DESIGN.md reserva --accent para estado (foco, agente ativo, item ' +
        'selecionado, streaming). A hierarquia entre os números passa a vir da ' +
        'escala tipográfica; o aviso ACP usa a linguagem de card dos itens abaixo.',
    },
    {
      title: 'browser_do e computer_do: "done" pede verificação',
      detail:
        'A descrição das ferramentas passa a dizer o óbvio que faltava: done é ' +
        'julgamento do Jev — o agente confirma o resultado (lê a página ou o app) ' +
        'antes de reportar sucesso.',
    },
    {
      title: 'Capturas de confirmação expiram',
      detail:
        'A imagem gravada em needs_confirmation do computer_do (tela do usuário, ' +
        'sensível) é apagada depois de 24 h a cada nova gravação.',
    },
  ],
};

export const RELEASE_07650: AppRelease = {
  version: '0.76.50',
  date: '2026-09-17',
  codename: 'Panes a quente',
  summary:
    'O pane parava minutos em tela preta porque re-baixava ~500 MB de servidores ' +
    'MCP a cada abertura: o cache de pacotes morria com o HOME descartável. Agora ' +
    'npm_config_cache, XDG_CACHE_HOME e UV_CACHE_DIR apontam para uma raiz durável ' +
    'por adapter — o download acontece uma vez por máquina e o pane sobe a quente, ' +
    'sem um third-party jamais tocar o cache do pane nativo.',
  highlights: [
    {
      title: 'Fim do re-download de ~500 MB por pane',
      detail:
        'Os servidores MCP npx/uvx do perfil herdado resolviam o cache pelo $HOME ' +
        '— descartável. Cada pane novo gastava ~475 MB de download e minutos de fs ' +
        'churn com o Main a 99% de CPU. O cache durável em ' +
        '<userData>/provider-cache/<adapter.id>/ aquece uma vez e reusa para sempre.',
    },
    {
      title: 'Velocidade de geração por LLM (tok/s e TTFT)',
      detail:
        'Ajustes → Diagnóstico ganha um medidor de quanto cada modelo cospe por ' +
        'segundo nesta rodada, quanto demorou até o 1º token, média e pico, e uma ' +
        'tabela com uma linha por LLM — um pane que troca de modelo no meio da ' +
        'sessão alimenta as duas linhas sem reescrever o passado. Métrica que a ' +
        'medição não sustenta aparece como "—", nunca como zero falso: rodada ' +
        'curta demais ou submit não observado não viram número inventado. Claude ' +
        'e Codex corrigem a estimativa com a contagem exata do transcript.',
    },
    {
      title: 'Isolamento por adapter, como sempre',
      detail:
        'A raiz do cache é por adapter.id: GLM/LongCat e outros third-party ganham ' +
        'raízes próprias e nunca escrevem no cache que a toolchain do pane nativo ' +
        'executa. Os demais adapters já isolavam seus homes duráveis.',
    },
    {
      title: 'Auth intacta',
      detail:
        'A correção do F-575 (keychain linkado no HOME efêmero) segue como estava: ' +
        'este release ataca o boot lento medido depois dela, não mexe em ' +
        'autenticação nem em concessões de sandbox.',
    },
    {
      title: 'Jev: julgamento tipado no produto',
      detail:
        'Triagem de intake no router (opt-in via orch.jevAutopilot; sem chave ' +
        'TypeSafe o fluxo é exatamente o de antes), tool nexus_judge read-only ' +
        'com rate limit, revisão de evidência dos handoffs, cofre ' +
        'jev-env:TYPESAFE_API_KEY em Ajustes e skill typesafe-ai bundled. A chave ' +
        'chega pelo shell do usuário, nunca pelo process.env do Main.',
    },
    {
      title: '"Enviar para o NexusIDE" vira evento visível (F-577)',
      detail:
        'O shot-bridge recebia o arquivo do Nexus Shot e o evento morria no ' +
        'renderer sem consumidor. Agora o IDE confirma a entrega com um toast e ' +
        'ação Abrir/Abrir pasta; a validação de caminho continua no Main e ' +
        'nenhum canal IPC novo foi criado.',
    },
  ],
  fixes: [
    {
      title: 'Medido, não suposto',
      detail:
        'Reproduzido no Mac do operador com PTY real: overlay novo → ~475 MB de ' +
        '.npm/.cache em <1 min e Main a 99% de CPU; com o env novo, npx cai na ' +
        'raiz durável e o segundo run sai em ~0.8s. Claude renderiza a TUI em ~30s ' +
        'a frio, ~2s a quente.',
    },
    {
      title: 'Quem vem da 0.76.48',
      detail:
        'A atualização também traz o fix de auth do Claude (keychain real linkado ' +
        'no HOME efêmero — /login que persiste de verdade) e o gate de swap por ' +
        'máquina da 0.76.47.',
    },
  ],
};

export const RELEASE_07648: AppRelease = {
  version: '0.76.48',
  date: '2026-09-17',
  codename: 'O Claude volta a entrar',
  summary:
    'O pane do Claude abria em "Not logged in · Run /login" mesmo com a máquina ' +
    'autenticada — e um login feito dentro dele nunca persistia. A causa é do macOS: ' +
    'a lista de keychains é resolvida pelo $HOME do processo, então no HOME privado ' +
    'do pane a credencial da assinatura ficava invisível. O overlay agora enxerga o ' +
    'keychain real: sessão viva, refresh compartilhado e /login que segura de verdade.',
  highlights: [
    {
      title: 'Pane Claude abre logado de novo',
      detail:
        'Desde a 0.76.45 (HOME privado por checkout) todo pane do Claude nascia em ' +
        '"Not logged in" com a máquina autenticada: o macOS só procura keychains em ' +
        '~/Library/Keychains do $HOME do processo, e o HOME efêmero escondia ' +
        '"Claude Code-credentials". O overlay agora linka os *.keychain-db reais — ' +
        'o pane usa a mesma sessão viva do seu Terminal.',
    },
    {
      title: 'Login dentro do pane passa a segurar',
      detail:
        'Sem o keychain real na busca, um /login feito no pane gravava a credencial ' +
        'num keychain descartável que morria com o overlay. Agora a escrita atravessa ' +
        'para o keychain de verdade: o login persiste e o refresh continua ' +
        'compartilhado entre pane, CLI nativo e demais panes.',
    },
    {
      title: 'Workers seguem no token injetado',
      detail:
        'A superfície de cada pane não mudou de política: workers e orquestradores ' +
        'gated continuam autenticando por CLAUDE_CODE_OAUTH_TOKEN (superfície ' +
        'mínima), e overlays de terceiro (GLM/LongCat) nunca recebem identidade nem ' +
        'keychain. Linux/Windows já usavam o .credentials.json linkado.',
    },
  ],
  fixes: [
    {
      title: 'Causa medida no macOS, não suposta',
      detail:
        'Reproduzido com a máquina logada: HOME efêmero → `claude auth status` = ' +
        'false e `security` não acha a credencial; com o keychain linkado → ' +
        'loggedIn: true, e uma escrita de teste no HOME efêmero caiu no keychain ' +
        'real. O sync-back de identidade e .credentials.json segue como estava.',
    },
    {
      title: 'Quem vem da 0.76.45/0.76.47',
      detail:
        'A atualização também traz o teto de panes como aviso, o gate de swap por ' +
        'máquina (o número de swap guarda pico, não o agora) e o fim dos ' +
        'estacionamentos em loop do reaper.',
    },
  ],
};

export const RELEASE_07649: AppRelease = {
  version: '0.76.49',
  date: '2026-09-17',
  codename: 'O Claude entra no Windows também',
  summary:
    'A 0.76.48 curou o pane Claude no macOS (keychain invisível no HOME privado), ' +
    'mas no Windows o "Not logged in" continuava — causa raiz diferente, mesmo ' +
    'sintoma. O spawn marcava CLAUDE_CONFIG_DIR como vazio para "neutralizar" um ' +
    'path herdado, só que vazio não é ausência: a variável continuava no env do ' +
    'processo e o resolver de config do binário aceita "" literalmente — o store ' +
    'de credenciais (.credentials.json, projects, sessions) passava a ser lido ' +
    'relativo ao diretório de trabalho do pane, não ao HOME privado. A variável ' +
    'agora é removida de verdade do env do filho e o pane volta a ler a ' +
    'credencial linkada do overlay.',
  highlights: [
    {
      title: 'Pane Claude no Windows abre logado',
      detail:
        'Todo pane novo lia <cwd>/.credentials.json — que não existe — em vez ' +
        'do <HOME efêmero>/.claude/.credentials.json linkado da máquina real. ' +
        'Resultado: "Not logged in" eterno, e um /login completava o OAuth em ' +
        'memória sem nunca persistir. Com a variável removida do env block, o ' +
        'resolver cai no HOME privado e a sessão da assinatura aparece.',
    },
    {
      title: 'envRemove: remoção real, não esvaziamento',
      detail:
        'O decoration de spawn ganhou envRemove — a chave é deletada do env do ' +
        'filho (mesmo contrato do suppressEnv de providers), em vez de receber ' +
        '"". Um CLAUDE_CONFIG_DIR herdado de adapter com passthrough declarado ' +
        'continua bloqueado: a garantia original do HOME privado fica de pé.',
    },
  ],
  fixes: [
    {
      title: 'Causa provada no binário, não suposta',
      detail:
        'Reprodução controlada com o env literal do pane: CLAUDE_CONFIG_DIR= ' +
        '+ cwd com credencial → loggedIn:true; cwd sem → false; var ausente + ' +
        'HOME do overlay → loggedIn:true com e-mail e org. O .claude.json ' +
        'seguia funcionando porque seu resolver usa || (falsy→homedir) — a ' +
        'divergência ?? vs || dentro do binário mascarou o bug por um release ' +
        'inteiro.',
    },
    {
      title: 'macOS inalterado',
      detail:
        'O fix da 0.76.48 (keychain linkado no overlay) permanece: lá o store ' +
        'de credenciais é o Keychain, não o arquivo — a remoção da variável só ' +
        'alinha o config dir ao HOME privado nos dois sistemas.',
    },
  ],
};

export const RELEASE_07645: AppRelease = {
  version: '0.76.45',
  date: '2026-09-16',
  codename: 'Otimizar, não limitar',
  summary:
    'Resposta ao freeze com 8 panes num Air de 24 GB: o teto de panes virou aviso (só a ' +
    'pressão real de memória bloqueia), pane ocioso é estacionado em vez de fechado (memória ' +
    'a zero, acorda com um clique no mesmo contexto), os seus servidores MCP globais sobem ' +
    'uma vez em vez de uma vez por pane, e o cabeçalho mostra quanto cada pane custa.',
  highlights: [
    {
      title: 'Pane dormindo em vez de fechado',
      detail:
        'Pane ocioso sem dono (helper seu ou worker sem missão) tem o CLI encerrado após 30 ' +
        'min, ou na hora sob pressão de memória, mas fica no layout com o scrollback e um ' +
        'botão "Acordar" que retoma a MESMA conversa (resume exato por sessão). Memória do ' +
        'pane dormindo: zero.',
    },
    {
      title: 'Servidores MCP compartilhados',
      detail:
        'Os servidores MCP do seu perfil global (~19, ~600 MB por pane até a 0.76.43) sobem ' +
        'uma única vez no Nexus e cada pane fala com eles por HTTP. Um pane Claude da sua mão ' +
        'cai de ~1,1 GB para ~0,5 GB; workers já não herdavam.',
    },
    {
      title: 'Teto vira aviso; só pressão real bloqueia',
      detail:
        'Acima do teto proporcional à RAM o spawn passa com um aviso nomeando os ociosos a ' +
        'fechar. O único bloqueio é a máquina de fato sob pressão: menos de 15 % da RAM ' +
        'disponível (sinal do kernel no macOS) ou mais de 1 GB de swap. NEXUS_PANE_CAP_HARD=1 ' +
        'restaura o bloqueio por contagem para quem quiser.',
    },
    {
      title: 'Custo de cada pane no cabeçalho',
      detail:
        'O RSS da árvore de processos de cada pane (CLI + filhos MCP) aparece no cabeçalho a ' +
        'cada 30 s, com tom de aviso acima de 1,5 GB. nexus_perf_snapshot traz o mesmo.',
    },
  ],
  fixes: [
    {
      title: 'Reaper de emergência',
      detail:
        'Sob pressão de memória o guardian estaciona um pane ocioso elegível por minuto, o ' +
        'mais parado primeiro, sem esperar o TTL — nunca o seu pane, um orquestrador, um worker ' +
        'de missão ou um pane com entrega pendente.',
    },
    {
      title: 'Limites proporcionais à máquina',
      detail:
        'Teto entre 4 e 12 conforme a RAM (16 GB → 6, 24 GB → 12); mínimo disponível 15 % da ' +
        'RAM em vez de 1 GB fixo (tarde demais num Mac de 24 GB).',
    },
  ],
};

export const RELEASE_07643: AppRelease = {
  version: '0.76.43',
  date: '2026-09-16',
  codename: 'Cada pane com a própria sessão',
  summary:
    'Pane guardian (F-572): panes parados fecham sozinhos, o spawn tem teto e gate de ' +
    'memória, e a telemetria enxerga a árvore de processos de cada pane — resposta ao ' +
    'freeze de 16/09 com 22 panes ociosos. ' +
    'Um pane de Grok/Kimi dentro do Nexus não vaza mais para um terminal externo aberto no ' +
    'mesmo checkout (F-566), auditoria fechou o mesmo risco em todos os outros adapters ' +
    '(F-567), handoff sem missão já funciona de ponta a ponta para painéis do operador ' +
    '(F-565), o cabeçalho do painel parou de tremer (F-568) e a base da liderança única de ' +
    'missão mais o fan-out de escritores paralelos entraram em produção sob contrato ' +
    'fechado, sem religar nenhum comportamento novo por padrão.',
  highlights: [
    {
      title: 'Pane guardian: nada fica aberto sem fazer nada (F-572)',
      detail:
        'Em 16/09, 22 panes parados (33 abertos, 6 fechados; workers sem missão presos ' +
        'após handoff recusado) esgotaram a RAM de um Mac de 24 GB até o freeze. O ' +
        'auto-fechamento de pane ocioso existia desde agosto e nunca tinha sido ligado. ' +
        'Agora liga no boot, cobre worker sem missão e helper aberto pela mão do operador ' +
        '(nunca orquestrador, worker de missão, pane aberto pelo humano ou pane com entrega ' +
        'pendente), e varre o PTY a cada 60 s para CLIs sem hooks. TTL 30 min.',
    },
    {
      title: 'Teto de panes e gate de memória no spawn (F-572)',
      detail:
        'Todo spawn de agente passa por um único ponto: acima de 12 panes de agente, ' +
        'ou com menos de 1 GB disponível / mais de 2 GB de swap, o spawn é recusado ' +
        'nomeando os panes ociosos a fechar. No macOS o sinal é o mesmo do jetsam ' +
        '(kern.memorystatus_level), não o "free" cru. nexus_perf_snapshot passa a mostrar ' +
        'o RSS da árvore de processos de cada pane. Workers não herdam mais o perfil MCP ' +
        'global (um pane Claude cai de ~1,1 GB para ~0,5 GB).',
    },
    {
      title: 'Sessão de CLI isolada por checkout (F-566/F-567)',
      detail:
        'Grok e Kimi guardavam o histórico de conversa dentro do `~/.grok`/`~/.kimi-code` ' +
        'real; um `grok -c`/`kimi -c` rodado num terminal comum fora do Nexus, no mesmo ' +
        'diretório de trabalho de um painel aberto, conversava com a MESMA sessão. A ' +
        'auditoria completa (F-567) cobriu os 13 adapters builtin: família Claude (claude, ' +
        'glm, glm-flash, longcat, deepseek) ganhou HOME privado por pane; Codex, OpenCode, ' +
        'AGY e Devin pararam de resolver "sessão mais recente" e passaram a guardar estado ' +
        'por checkout; os TUI restantes (droid, cursor, copilot, amp, goose, pi, ' +
        'prime-agent, hermes, command-code) ganharam o mesmo gancho em `pty-manager.ts`. ' +
        'Toda conversa durável agora mora em `<userData>/provider-state/<adapter>/' +
        '<checkoutId>/…`; resume só acontece por id explícito, nunca por fallback de "mais ' +
        'recente no diretório".',
    },
    {
      title: 'Handoff sem missão, ponta a ponta (F-565)',
      detail:
        '`nexus_handoff_submit` disparado por um painel do operador sem missão ativa deixa ' +
        'de ser recusado: `resolveWorkspaceHandoffParent` reconhece o painel-filho do ' +
        'operador, persiste o handoff com `mission_id` nulo e entrega no painel pai pelo ' +
        'transporte normal de `pane_write`. Um orquestrador sem missão já tinha todos os ' +
        'poderes; agora também recebe o retorno de um ajudante que ele mesmo abriu.',
    },
    {
      title: 'Cabeçalho do painel parou de tremer (F-568)',
      detail:
        'Título de terminal alternando glifo de spinner a cada tick fazia o `PaneToolbar` ' +
        'recalcular largura e reflowar o cabeçalho continuamente. `normalizePaneTitle` ' +
        'separa título de indicador de atividade, o terminal-host deduplica e limita a ' +
        'frequência de atualização, e o indicador ganhou um slot de largura fixa — o texto ' +
        'ao lado para de balançar.',
    },
    {
      title: 'Motor de liderança única de missão (F-562), fundação em produção',
      detail:
        'Uma única `MissionLeadership` por missão (origem spawn/adopt/respawn/promote/' +
        'create, mais `takeover` explícito só para a UI do operador — nunca automático) ' +
        'substitui o dono implícito por sessão. Onda 1 migrou leitores sem efeito para ' +
        '`resolveMissionLeader`; onda 2 fez o renderer espelhar só o líder confirmado pelo ' +
        'main (`leadership-reflect.ts`); onda 3 trocou o papel de UI por uma capability e os ' +
        'gates de efeito passaram a consultar o líder resolvido via ' +
        '`requireMissionLeaderSession`. Promover um painel por cima de um líder vivo continua ' +
        'recusado por padrão — um orquestrador por missão.',
    },
    {
      title: 'Fan-out de escritores paralelos, com cerca reforçada (F-563)',
      detail:
        'Um worker `isolatedWriter` ganha worktree própria dentro da Via Rápida. A cerca foi ' +
        'endurecida antes de qualquer uso real: git fica limitado a add/commit/status/diff/' +
        'log na worktree e branch do registro do Main (push, stash, reset, HEAD destacado e ' +
        'repo aninhado são recusados), `nexus_terminal_run` desses writers não abre shell ' +
        '— só traduz argv Git literal para os mesmos handlers protegidos — e write/close ' +
        'entre workers exige a mesma `executionScope.rootRealPath`.',
    },
  ],
  fixes: [
    {
      title: 'Liderança única: gate e leitores sem falso "sessão obsoleta"',
      detail:
        'A suíte completa pegou 23 regressões das ondas 1/3 antes da release: o gate de ' +
        'líder recusava o próprio líder registrado antes da prova física, e os leitores ' +
        'vazavam "domain stores are not initialized" quando o engine estava indisponível. ' +
        'Agora só morte conhecida (sessão exited) nega o líder, e leitores degradam à ' +
        'ligação durável da missão.',
    },
    {
      title: 'Grant de sandbox governado só cobre o material de auth (F-569)',
      detail:
        'Uma sessão governada de Grok/Kimi recebia leitura+escrita no `~/.grok`/' +
        '`~/.kimi-code` inteiro — `config.toml`, `device_id`, `workspaces.json`, qualquer ' +
        'coisa que estivesse ali — quando a política `governed` existe para restringir o que ' +
        'o worker enxerga. O grant agora é só os caminhos reais que o overlay linka de volta ' +
        '(`auth.json`/`.lock` no Grok; `credentials/` e `oauth/` no Kimi).',
    },
    {
      title: 'Provider-state do checkout some quando o workspace some (F-570)',
      detail:
        '`<userData>/provider-state/<adapter>/<checkoutId>` nunca era removido, nem com o ' +
        'checkout apagado — a árvore persistia para sempre. Agora é purgada no evento de ' +
        'remoção do workspace, para todos os adapters, não só o ativo no momento.',
    },
    {
      title: 'Spawn paralelo não revoga mais o refresh token do Codex (ciclo 5)',
      detail:
        'Cada painel Codex compartilhando uma conta gerenciada rotaciona o refresh token no ' +
        'boot; seis painéis em paralelo sobre o mesmo `auth.json` derrubavam uns aos outros ' +
        'com "refresh token was revoked". `managed-auth-spawn-gate.ts` faz um líder assumir o ' +
        'refresh (token ainda válido por >5min segue em paralelo) e os seguidores esperam a ' +
        'reescrita do arquivo, com lock e teto de 12s.',
    },
    {
      title: 'Grok não roda mais `grok models` (ciclo 5)',
      detail:
        'Esse binário faz silent refresh e rotaciona o refresh token a cada chamada; o poll ' +
        'de 5 minutos derrubava a sessão a cada ~10. A descoberta de modelos passou a ler ' +
        '`~/.grok/models_cache.json` e o catálogo bundled; a cota usa o JWT que já está em ' +
        '`auth.json` direto contra o endpoint de billing.',
    },
    {
      title: 'Devin sobe pelo PTY (ciclo 5)',
      detail:
        'Spawn de Devin deixou de reportar "did not start after prompt delivery" no caminho ' +
        'read-only ao subir pelo mesmo host de PTY que os demais adapters, em vez de um ' +
        'caminho próprio.',
    },
    {
      title: 'Limpador de hooks legados cobre HOMEs de CLI e todo workspace registrado',
      detail:
        'Sobras do Overclock apontando para `~/.overclock-app` agora são varridas também em ' +
        '`~/.codex`, `~/.grok` e `~/.kimi-code`, e a varredura roda por workspace REGISTRADO ' +
        '— não só pelo cwd do app — fechando o caso do hook morto num workspace fora do ' +
        'diretório corrente.',
    },
    {
      title: 'Contrato da liderança fechado antes de religar qualquer coisa',
      detail:
        '`MissionLeadershipError` ganhou códigos tipados (`split_brain`, `existing_session`, ' +
        '`target_not_live`, `write_incomplete`, `scope_mismatch`, `busy`, `mission_missing`); ' +
        'sessão `exited` deixou de travar a resolução; origens `create` e `release` além do ' +
        '`takeover` explícito completam o vocabulário que as três ondas de religamento ' +
        'consomem.',
    },
    {
      title: 'Publicação `--macos` pelo caminho oficial (F-564)',
      detail:
        '`npm run release:publish -- --macos` consome só a candidata local já aprovada pelo ' +
        'gate, sem disparar build nem exigir/aguardar candidato Windows — o Mac publica no ' +
        'seu próprio ritmo.',
    },
    {
      title: 'Gate de release não trava mais num app preso em exit do kernel',
      detail:
        'O smoke do pacote agora copia o app via `ditto`, desmonta a imagem antes de rodar o ' +
        'smoke e trata um processo em `STAT` de saída do kernel (E/Z) como encerrado em vez ' +
        'de aguardar para sempre, com teto de 60s na prova de árvore de processos.',
    },
  ],
};

export const RELEASE_07642: AppRelease = {
  version: '0.76.42',
  date: '2026-09-16',
  codename: 'Orquestrador num clique, cofre sem modal',
  summary:
    'Atualização macOS com os seis bugs cobrados hoje: "Tornar orquestrador" volta a ser ' +
    'um clique num painel solto, o cofre deixa de insistir com o Keychain (adeus modal ' +
    '"Chaves Não Encontradas"), o spawn de painel não reporta falha de um painel vivo, o ' +
    'quit não espera backend pendurado, "Entrar novamente" funciona e os hooks mortos do ' +
    'Overclock somem do boot.',
  highlights: [
    {
      title: '"Tornar orquestrador" num clique',
      detail:
        'Sem missão ativa, o painel solto vira coordenador na hora, como antes — sem abrir ' +
        'o assistente de Novo pedido. Quem quer uma missão a partir do painel usa "Nova ' +
        'missão deste painel", que marca o painel para adoção.',
    },
    {
      title: 'Cofre sem modal do Keychain',
      detail:
        'O cofre sonda se o armazenamento seguro está disponível antes de cifrar e, se o ' +
        'macOS recusar, devolve um erro nosso em vez de insistir até o sistema abrir ' +
        '"Chaves Não Encontradas" — o modal cujo botão azul apaga o keychain inteiro. O ' +
        'read-back de contas também parou de forçar reescrita quando o decrypt falha com a ' +
        'chave presente.',
    },
    {
      title: 'Spawn nunca mais mente sobre um painel vivo',
      detail:
        'Quando o CLI demora mais que o teto do MCP para ficar pronto, nexus_pane_spawn ' +
        'responde com o paneId e pending: true em vez de "falhou". A prontidão é do ' +
        'nexus_pane_wait_idle. Acabou o segundo worker nascido de um retry sobre um pane vivo.',
    },
  ],
  fixes: [
    {
      title: 'Quit não espera cron pendurado',
      detail:
        'stopCronLoop, primeiro passo do encerramento, ganhou teto de 3 s: um backend remoto ' +
        'que não responde deixa de segurar o app até o "quit excedeu o teto de 45000ms".',
    },
    {
      title: '"Entrar novamente" abre o login',
      detail:
        'No painel de cotas, quando a conta pede novo login, o selo vira um botão de verdade ' +
        'que abre o terminal de login pela mesma rota do gerenciador de contas.',
    },
    {
      title: 'Hooks mortos do Overclock limpos em três alvos',
      detail:
        'Sobras em ~/.claude/settings.json, .codex/hooks.json e .agents/hooks.json apontando ' +
        'para ~/.overclock-app são removidas no boot quando o executável não existe. Fim do ' +
        '"Hook failed — exited with code 127" a cada tool e do modal "1 hook needs review".',
    },
    {
      title: 'Recusa do handoff aponta um caminho que existe',
      detail:
        'A dica de "mission effect blocked" é recalculada pela allowlist do painel: um pane ' +
        'somente-leitura ouve nexus_pane_ask, não ferramentas que o próprio gate barra.',
    },
  ],
};
