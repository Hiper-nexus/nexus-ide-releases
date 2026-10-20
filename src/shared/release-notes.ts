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
  codename: 'Super Swarm',
  summary:
    'Novidades de orquestração: warm pool de panes CPU-aware (~80ms spawn), ' +
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
  codename: 'Autonomous Swarm Engine',
  summary:
    'Dez novos domínios: design tokens com elevação glass/depth hierarchy, ' +
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
  codename: 'Três candidatos de volta',
  summary:
    'Três candidatos entram de vez: cada story selada ganha ' +
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
        'Doutrina COBRANÇA: worker parado sem handoff ' +
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
    'doutrina de cobrança e as novidades do Orca upstream: a entrega ' +
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
      title: 'Missão ininterrupta',
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
        'o artifact de texto integral do handoff. A resposta do spawn traz harness {adapterId, model, effort, source}.',
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

export const RELEASE_07682: AppRelease = {
  version: '0.76.82',
  date: '2026-09-22',
  codename: 'Nada escondido',
  summary:
    'No Windows as CLIs instaladas por nvm, pnpm, Volta e scoop deixam de sumir, e botões, hovers e o HUD de voz param de se esconder. O cofre fecha todas as portas depois da primeira falha.',
  highlights: [
    {
      title: 'As CLIs aparecem nesta máquina',
      detail:
        'A busca cobre nvm, pnpm, mise, fnm, Volta e scoop. Se a sondagem do boot falha, o Nexus tenta de novo sozinho e reexamina as CLIs.',
    },
    {
      title: 'Botões que tinham sumido',
      detail:
        'Ícones pequenos e cores que não existiam apagavam o + e os hovers. O HUD de voz em repouso fica só o orb e não cobre o terminal.',
    },
    {
      title: 'O cofre para de verdade',
      detail:
        'Depois da primeira falha, leitura e gravação ficam desligadas juntas. Antes cada leitura voltava ao cofre.',
    },
    {
      title: 'Git e gh em todo pane gravável',
      detail:
        'A identidade de git, SSH e gh do operador entra em qualquer CLI gravável, não só no Claude. O brief espera a migração do MiMo acabar.',
    },
  ],
  fixes: [
    {
      title: 'A faixa de missões segue o tema',
      detail:
        'Ela não fica preta no tema claro. Pino de missão encerrada deixa de ser botão morto e o nome do orquestrador não repete.',
    },
    {
      title: 'Pasta, Claude, MiMo e o .env',
      detail:
        'O seletor de pasta responde, o Claude abre pelo executável, o MiMo é lido em .local\\share e o hook não pede um programa para o .env.',
    },
  ],
};

export const RELEASE_07680: AppRelease = {
  version: '0.76.80',
  date: '2026-09-22',
  codename: 'O lote do Mac no Windows',
  summary:
    'Entra no Windows o lote novo da main: ditado, várias missões, Opus 5.5, GPT-6, cofre entre PCs e a trava do desktop. O seletor de pasta, o Claude, o MiMo e o hook do .env continuam corrigidos.',
  highlights: [
    {
      title: 'Ditado só envia ao soltar',
      detail:
        'Segurar a tecla não entrega a frase no meio. O hold-to-talk espera o soltar e tem teto de segurança.',
    },
    {
      title: 'Várias missões no mesmo workspace',
      detail:
        'A faixa separa as missões. Os pinos A e B não misturam o conteúdo, e o orquestrador aparece no header.',
    },
    {
      title: 'Opus 5.5 e GPT-6',
      detail:
        'Claude Opus 5.5 entra no lugar do 5. GPT-6 Sol é o frontier do Codex e Luna cobre o tier barato.',
    },
    {
      title: 'O cofre não se envenena',
      detail:
        'A primeira falha do cofre para de reabrir o modal de chaves perdidas. O vault também exporta e importa entre PCs com senha.',
    },
  ],
  fixes: [
    {
      title: 'A pasta do workspace responde',
      detail:
        'No Windows o seletor nativo não fica mais preso à janela do Nexus. A lista deixa de travar em «Não está respondendo».',
    },
    {
      title: 'Claude, MiMo e o .env',
      detail:
        'O pane do Claude abre pelo executável de verdade, o login do MiMo é lido em .local\\share, e o hook não pede mais um programa para abrir .env.',
    },
  ],
};

export const RELEASE_07679_WIN: AppRelease = {
  version: '0.76.79',
  date: '2026-09-22',
  codename: 'A pasta abre',
  summary:
    'No Windows o seletor de pasta deixa de travar e o pane do Claude volta a abrir com a conta isolada.',
  highlights: [
    {
      title: 'Escolher a pasta do workspace responde',
      detail:
        'O diálogo nativo não fica mais preso à janela do Nexus. No Windows isso deixava a lista vazia e o título em «Não está respondendo».',
    },
    {
      title: 'O terminal do Claude abre',
      detail:
        'O atalho claude.cmd não contém o marcador da conta isolada; o executável que ele abre contém. A checagem passa a ler esse executável.',
    },
    {
      title: 'O login do MiMo fica pronto',
      detail:
        'A sessão da CLI está em .local\\share\\mimocode, não no AppData. O Nexus passa a ler esse arquivo e a conta deixa de pedir login de novo.',
    },
  ],
  fixes: [],
};

export const RELEASE_07678: AppRelease = {
  version: '0.76.78',
  date: '2026-09-22',
  codename: 'Claude com leitura',
  summary:
    'A cota do Claude no Windows volta a aparecer. O token vencido é renovado e lido no mesmo endpoint do Mac, sem depender do comando da CLI.',
  highlights: [
    {
      title: 'Claude deixa de ficar sem leitura',
      detail:
        'No Windows o access token do arquivo vence. A renovação acontecia, mas a leitura ainda pedia claude /usage, que não devolve número. Agora a cota sai do token renovado.',
    },
  ],
  fixes: [],
};

export const RELEASE_07677: AppRelease = {
  version: '0.76.77',
  date: '2026-09-22',
  codename: 'A conta fica até acabar',
  summary:
    'No Windows entra o que saiu no Mac 0.76.76: re-login da mesma conta, a conta ativa só troca quando a cota zera, e o total mensal deixa de fingir a frota inteira.',
  highlights: [
    {
      title: 'Entrar novamente da mesma conta abre',
      detail:
        'Se a sessão viva é a própria conta e o snapshot falha, o login abre mesmo assim. E-mail de outra conta continua bloqueado, para não apagar essa sessão.',
    },
    {
      title: 'A conta em uso fica até a cota acabar',
      detail:
        'Folga maior numa irmã não troca a conta ativa. A troca espera zero medido, cooldown ou um hit real. Sem medição, a escolha permanece.',
    },
    {
      title: 'O total mensal não é a frota inteira',
      detail:
        'O cartão soma só planos com preço de lista e diz quantas contas ficaram de fora. Google AI Ultra entra como $100 ou $200 só quando o plano diz 5× ou 20×.',
    },
  ],
  fixes: [],
};

export const RELEASE_07676_WIN: AppRelease = {
  version: '0.76.76',
  date: '2026-09-22',
  codename: 'MiMo 2.6',
  summary:
    'MiMo V2.6 Pro e Flash no Windows, com contas, cota e o Redline. O login do Codex abre.',
  highlights: [
    {
      title: 'MiMo V2.6 no Windows',
      detail:
        'MiMo Code, as contas Xiaomi e os modelos V2.6 Pro e Flash. No Windows a sessão fica em %LOCALAPPDATA%\\mimocode.',
    },
    {
      title: 'O Codex abre para logar',
      detail:
        'Guardar a conta que já está na CLI não cancela mais o terminal de login no Windows.',
    },
  ],
  fixes: [],
};

export const RELEASE_07675_WIN: AppRelease = {
  version: '0.76.75',
  date: '2026-09-21',
  codename: 'Xiaomi MiMo no Nexus',
  summary:
    'MiMo Code ganha integração nativa, contas próprias e os modelos V2.6 Pro e Flash.',
  highlights: [
    {
      title: 'CLI oficial e contas Xiaomi',
      detail:
        'Instale ou conecte MiMo Code nos Providers. As contas mantêm a região do plano e as conversas do Nexus ficam separadas.',
    },
    {
      title: 'Pro, Flash e UltraSpeed',
      detail:
        'V2.6 Pro e Flash no Token Plan. UltraSpeed exige API separada. Sem medição, o modelo aparece como não avaliado.',
    },
  ],
  fixes: [],
};

export const RELEASE_07674: AppRelease = {
  version: '0.76.74',
  date: '2026-09-21',
  codename: 'Segunda conta',
  summary:
    'O login do Claude no Windows que termina em «Login successful!» salva a conta nova e ela aparece no Redline.',
  highlights: [
    {
      title: 'A segunda conta entra no Redline',
      detail:
        'A primeira conta já era guardada antes do login. A frase de sucesso do Claude no Windows não era reconhecida, então a conta nova não era salva e o Redline continuava com uma linha só.',
    },
  ],
  fixes: [],
};

export const RELEASE_07673: AppRelease = {
  version: '0.76.73',
  date: '2026-09-21',
  codename: 'Conta por conta',
  summary:
    'No multi-conta, cada conta mostra o próprio limite. A cota de A não entra na linha de B.',
  highlights: [
    {
      title: 'Conta A e conta B ficam separadas',
      detail:
        'Cada conta salva consulta o próprio token. O painel de cota e o Redline mostram uma linha por conta, com o limite dela.',
    },
  ],
  fixes: [],
};

export const RELEASE_07672: AppRelease = {
  version: '0.76.72',
  date: '2026-09-21',
  codename: 'Cota no Windows',
  summary:
    'Claude e Antigravity logados no Windows passam a mostrar a cota, como no Mac.',
  highlights: [
    {
      title: 'Claude renova e mostra os limites',
      detail:
        'A conta continua conectada, mas o token de acesso do arquivo vencia. A leitura agora renova com o refresh que já está na máquina.',
    },
    {
      title: 'Antigravity lê a cota pelo mesmo comando do Mac',
      detail:
        'O agy instalado em AppData entra na sonda. O painel do Redline também deixa de piscar a cada atualização.',
    },
  ],
  fixes: [],
};

export const RELEASE_07671: AppRelease = {
  version: '0.76.71',
  date: '2026-09-21',
  codename: 'Cota de quem está logado',
  summary:
    'No Windows o Redline passa a ler a cota do Devin e do Antigravity que já estão logados.',
  highlights: [
    {
      title: 'Devin e Antigravity logados aparecem no Redline',
      detail:
        'A cota do Devin vinha da pasta errada. A do Antigravity ignorava o Gerenciador de Credenciais. As duas contas logadas deixam de aparecer como sem credencial.',
    },
  ],
  fixes: [],
};

export const RELEASE_07670: AppRelease = {
  version: '0.76.70',
  date: '2026-09-21',
  codename: 'O clique abre',
  summary: 'O clique no ícone do Redline no Windows abre o painel de cotas.',
  highlights: [
    {
      title: 'Clique no Redline abre o painel',
      detail:
        'Um clique na bandeja gerava dois avisos. O segundo fechava o painel na hora. Agora o clique abre e o painel fica.',
    },
  ],
  fixes: [],
};

export const RELEASE_07669: AppRelease = {
  version: '0.76.69',
  date: '2026-09-21',
  codename: 'Grok conectado também no Redline',
  summary: 'A cota do Grok acompanha a renovação da sessão e deixa de manter um aviso antigo de login expirado após uma leitura válida.',
  highlights: [],
  fixes: [
    {
      title: 'Grok renova a sessão para consultar a cota',
      detail: 'Quando o token vence, o Nexus pede à própria CLI que renove a sessão salva, sem abrir conversa. Falhas temporárias não exigem um novo login.',
    },
    {
      title: 'Redline remove o aviso de login já resolvido',
      detail: 'Uma leitura válida do provedor limpa o bloqueio antigo de autenticação e atualiza o Redline na mesma consulta. Bloqueios reais de consumo são preservados.',
    },
    {
      title: 'Renovação coordenada entre panes e cota',
      detail: 'Duas cópias da mesma sessão compartilham uma única tentativa de renovação. Uma troca de conta durante a consulta invalida o resultado anterior.',
    },
  ],
};



export const RELEASE_07668: AppRelease = {
  version: '0.76.68',
  date: '2026-09-21',
  codename: 'Grok 4.7',
  summary: 'Grok 4.7 disponível no catálogo do Nexus, com quatro níveis de raciocínio e estimativa de custo atualizada.',
  highlights: [
    {
      title: 'Grok 4.7 no seletor de modelos',
      detail: 'O novo modelo vem no catálogo e é o padrão para novas escolhas Grok. As escolhas que você já salvou continuam preservadas.',
    },
    {
      title: 'Raciocínio até xhigh',
      detail: 'Escolha low, medium, high ou xhigh nas opções da sessão. High é o padrão do modelo.',
    },
  ],
  fixes: [
    {
      title: 'Estimativa de custo do Grok 4.7',
      detail: 'O medidor usa os preços-base publicados de US$ 2 por milhão de tokens de entrada e US$ 6 de saída, sem herdar o preço do Grok 4 antigo.',
    },
  ],
};

export const RELEASE_07667: AppRelease = {
  version: '0.76.67',
  date: '2026-09-21',
  codename: 'Cota e login de cada conta',
  summary:
    'Claude, Codex, Grok e Antigravity passam a consultar as credenciais e ' +
    'cotas corretas. Reautenticar preserva a sessão anterior e mantém a conta escolhida.',
  highlights: [
    {
      title: 'Login Codex por código dentro do Nexus',
      detail: 'O pane de login mostra o endereço e o código de autorização. A conta escolhida só é atualizada depois da confirmação da sessão.',
    },
    {
      title: 'Criar PR no checkout atual',
      detail: 'A ferramenta nexus_pr_create abre um PR no GitHub a partir de uma branch publicada, sem exigir worktree. Uma conexão GitHub válida continua necessária.',
    },
    {
      title: 'Consumo separado por conta Claude',
      detail: 'Cada conta usa seu próprio cache. Uma sessão nativa só fornece a cota de uma conta salva depois de confirmar sua identidade com o provedor.',
    },
    {
      title: 'Codex e Grok acompanham o login renovado',
      detail: 'As consultas usam a credencial atual da mesma conta. Codex pode consultar e renovar pelo próprio CLI; sessão revogada pede novo login.',
    },
    {
      title: 'Cota Antigravity mesmo com o pane fechado',
      detail: 'A CLI consulta as janelas de consumo sem abrir conversa nem gerar tokens.',
    },
  ],
  fixes: [
    {
      title: 'Reautenticação preserva a conta certa',
      detail: 'Tentar novamente mantém a conta selecionada. A sessão atual é preservada antes do novo login, e outra identidade não pode substituir a escolhida.',
    },
    {
      title: 'Estado de login e bloqueios confiáveis',
      detail: 'O e-mail salvo não esconde mais uma sessão revogada nem apaga um bloqueio real de consumo.',
    },
    {
      title: 'Menos tentativas repetidas no Keychain',
      detail: 'Consultas simultâneas ao mesmo item são reunidas. Uma negação não abre outra CLI para tentar de novo, e a gravação não repete a tentativa por shell.',
    },
  ],
};

export const RELEASE_07666: AppRelease = {
  version: '0.76.66',
  date: '2026-09-21',
  codename: 'Multi-conta: o login novo gruda, em qualquer LLM',
  summary:
    'Cinco defeitos somados faziam o mesmo estrago: fazer login e a conta ' +
    'continuar morta. O motor de frescor de credencial só entendia o ' +
    'formato do Codex, então Grok/OpenCode/Kimi/AGY guardavam o token ' +
    'velho e ainda o promoviam de volta ao cofre; um escopo Claude VAZIO ' +
    'era aceito como conta e a CLI respondia com a cota da sessão nativa ' +
    'em duas linhas; o Muse guardava o segredo no Keychain e aparecia ' +
    '«não verificado»; a leitura do Keychain não tinha cache e cada ' +
    'negação reabria o diálogo do macOS; e «Signed in as» sequer era ' +
    'reconhecido como fim de login.',
  highlights: [
    {
      title: 'Frescor de credencial deixa de ser só-Codex',
      detail:
        'O scanner novo lê emissão e expiração em qualquer formato — ISO, ' +
        'epoch em s/ms/µs, JWT embutido e snapshot de diretório. Emissão ' +
        'vence expiração: login novo de TTL curto ganha de token velho de ' +
        'TTL longo. Sem sinal comparável, o cofre não é sobrescrito e o ' +
        'arquivo em disco não é promovido — e uma sessão de OUTRA conta ' +
        'nunca entra no cofre desta.',
    },
    {
      title: 'Escopo Claude vazio não empresta a cota da sessão nativa',
      detail:
        'O diretório existir não é credencial (validar já o cria). Medido: ' +
        '`claude /usage` apontado para escopo vazio cai na credencial ' +
        'nativa — era a origem de duas contas exibindo 3% / 73% / 48% ' +
        'idênticos, uma delas com a sessão morta. Agora a linha exige ' +
        'arquivo OAuth utilizável ou item de Keychain próprio, senão diz ' +
        '«Sem leitura» honestamente.',
    },
    {
      title: 'Muse Spark logado aparece conectado',
      detail:
        'Com `storage: keychain` o auth.json guarda só identidade; o ' +
        'segredo vive em `ai.meta.dev.credentials`, cuja conta é o nome do ' +
        'provider. A sonda confere apenas os ATRIBUTOS do item — prova a ' +
        'sessão sem pedir senha.',
    },
    {
      title: 'O Keychain para de pedir permissão em laço',
      detail:
        'A leitura com `-w` devolve o segredo, passa pela ACL e roda em ' +
        'caminho quente. Sem cache, cada negação virava «não logado», que ' +
        'dispara login, que lê de novo. Agora: cache curto para leitura ' +
        'boa ou ausente, recuo de 5 min para ACL negada, e bypass ' +
        'pós-login que NUNCA ignora uma negação.',
    },
    {
      title: '«Signed in as» conserta exatamente a conta clicada',
      detail:
        'A frase real da CLI não era reconhecida como fim de login. Além ' +
        'disso ela agora só dispara nova leitura — o watcher não desiste ' +
        'antes de a credencial ficar visível. Um fingerprint opaco do blob ' +
        'prova reautenticação do MESMO e-mail, e o accountId viaja até o ' +
        'Main, que recusa credencial comprovadamente de outra linha em vez ' +
        'de adivinhar por e-mail.',
    },
  ],
  fixes: [],
};

export const RELEASE_07665: AppRelease = {
  version: '0.76.65',
  date: '2026-09-21',
  codename: 'Grok e Kimi dizem «Entrar novamente» e o Kimi nativo lê de verdade',
  summary:
    'A cadeia de motivos honestos chega aos outros providers: Grok com ' +
    'credencial morta (401 real do endpoint xAI) e Kimi com grant revogado ' +
    'agora viram «Entrar novamente» em vez de «Sem informação». A rotação ' +
    'de refresh Kimi de conta vault volta para o vault — nunca para o ' +
    'arquivo do login nativo — e a linha nativa do Kimi, que nunca era ' +
    'sondada por causa do upstream «moonshot», passa a ler o uso real.',
  highlights: [
    {
      title: 'Grok/Kimi: sessão morta vira CTA',
      detail:
        '401/403 do billing xAI e refresh rejeitado do Kimi viram ' +
        'auth-expired acionável — a linha, o rail e o Redline mostram ' +
        '«Entrar novamente» e marcam a conta para reautenticação.',
    },
    {
      title: 'Kimi nativo lê quota real',
      detail:
        'A linha nativa de provider por assinatura deixava de ser sondada ' +
        'quando o upstream declarado não era «anthropic» — o veto de rota ' +
        'confundia família de API com roteamento. Kimi nativo agora lê ' +
        'semanal/5h do ~/.kimi-code.',
    },
    {
      title: 'Rotação Kimi respeita a linhagem',
      detail:
        'Grant de conta vault rotacionado volta para o blob da conta ' +
        '(persistKimiRotatedCreds); só a linha nativa escreve em ' +
        '~/.kimi-code. Nenhuma sessão troca de identidade.',
    },
    {
      title: 'Redline distingue sessão morta',
      detail:
        'O readHint da sonda vira excludedReason no snapshot do ' +
        'companheiro: needs-relogin para auth-expired, no-credential ' +
        'para linha sem credencial — mesmo em conta sem AccountInfo.',
    },
  ],
  fixes: [],
};

export const RELEASE_07664: AppRelease = {
  version: '0.76.64',
  date: '2026-09-21',
  codename: 'Sessão morta vira botão, plano por conta e menus internos redesenhados',
  summary:
    'Cota deixa o «Sem leitura» genérico: a linha do Claude agora sabe ' +
    'dizer «Entrar novamente» quando a sessão morreu (401 do OAuth, token ' +
    'vencido, evidência de login no ~/.claude.json) — e o cache HTTP do ' +
    'Claude Desktop cobre a conta mesmo com o CLI sem credencial. Cada ' +
    'conexão mostra o plano detectado (ChatGPT Pro, Claude Max 20×) e a ' +
    'frota soma o custo mensal das assinaturas. Todos os menus internos ' +
    'de Configurações foram revistos.',
  highlights: [
    {
      title: '«Entrar novamente» de verdade',
      detail:
        'auth-expired chega na linha como hint acionável: 401/403 do ' +
        'endpoint OAuth, expiresAt vencido do token nativo e stderr do ' +
        'CLI viram estado com CTA de re-login, não «—».',
    },
    {
      title: 'Fontes Codenotch: Desktop + bridge AGY',
      detail:
        'Claude Desktop Simple Cache (zstd, freshness-gated, ancorado ' +
        'por organizationUuid) lê cota quando a credencial do CLI morreu; ' +
        'a bridge local do Antigravity lê o language-server via CSRF — ' +
        'e rejeita o processo Windsurf/Devin (mesma família Codeium).',
    },
    {
      title: 'Plano por conta e total da frota',
      detail:
        'Claude (rateLimitTier), Codex (chatgpt_plan_type) e AGY ' +
        '(currentTier) detectam o plano; a seção soma «$400/mês em N ' +
        'assinaturas» e cada linha carrega o selo do seu plano.',
    },
    {
      title: 'Menus internos redesenhados',
      detail:
        'Seis frentes de polish em Configurações (conta, catálogo, ' +
        'sistema, agentes, mídia, shell): grupos acessíveis, estados ' +
        'vazios/erro consistentes, chips de status — 0 findings Impeccable.',
    },
  ],
  fixes: [],
};

export const RELEASE_07663: AppRelease = {
  version: '0.76.63',
  date: '2026-09-20',
  codename: 'Cota Claude por conta, pet nos cantos de verdade e consumo real no perfil',
  summary:
    'Contas Claude do cofre ganham cascata própria de leitura de cota ' +
    '(managed-auth scoped, perfil de disco casado por e-mail, materialização ' +
    'do vault) — saem do «Sem leitura» sem emprestar a janela de outra conta. ' +
    'O pet de mesa fica parado por padrão e o arrasto alcança os cantos ' +
    'físicos da tela (acima da menubar/Dock, sem cortar). E o Perfil do ' +
    'Operador mostra o consumo real: tokens torrados e quanto custariam em ' +
    'API paga.',
  highlights: [
    {
      title: 'Cascata de cota por conta Claude',
      detail:
        'Cada conta vault tenta managed-auth scoped via ' +
        'CLAUDE_SECURESTORAGE_CONFIG_DIR (o CLI renova o próprio token), ' +
        'perfil de disco com o mesmo e-mail e materialização do blob do ' +
        'cofre. O percentual exibido é sempre daquela conta.',
    },
    {
      title: 'Pet nos cantos físicos, sem corte',
      detail:
        'Drag/settle/boot/patrulha usam bounds físicos — o nível ' +
        'screen-saver desenha o pet acima de menubar e Dock. Zonas mortas ' +
        'entre monitores de alturas diferentes são recusadas por cobertura ' +
        'de pixels, não por bounding-box.',
    },
    {
      title: 'Consumo real no perfil',
      detail:
        'Tokens torrados, USD-equivalente em API paga, panes, turnos, ' +
        'mídia e missões — acumulados de todos os projetos via ' +
        'usage:lifetime. Também no rail (Cotas) e em Ajustes → Uso e cotas.',
    },
    {
      title: 'Pet parado por padrão',
      detail:
        'A patrulha autônoma virou opt-in («Passear pela tela» no menu). ' +
        'Parado, o pet mantém bob, olhar e reações; move só no arrasto. ' +
        'Menu com scrollbar slim no tema.',
    },
  ],
  fixes: [],
};

export const RELEASE_07662: AppRelease = {
  version: '0.76.62',
  date: '2026-09-20',
  codename: 'Cotas reais por CLI, contas isoladas e terminal que não some',
  summary:
    'Cota por CLI deixa de aparecer vazia quando há consumo (Grok credits, Kimi/AGY refresh, ' +
    'Claude /usage, Devin, Cursor). Quem mais gastou sobe na lista. Contas Claude isoladas, ' +
    'refresh Codex na conta materializada, e o terminal Codex não apaga texto no resize.',
  highlights: [
    {
      title: 'Cota real por CLI (Codenotch)',
      detail:
        'Grok lê billing?format=credits (créditos semanais, não monthly vazio). Kimi e AGY ' +
        'refrescam o access em memória. Claude cai em claude /usage print-only se o OAuth ' +
        'falha. Devin GetUserStatus. Cursor autoPercentUsed — never plan.used/limit do free.',
    },
    {
      title: 'Quem mais gastou fica à vista',
      detail:
        'Faixa do Redline (máx. 6), painel e Ajustes → Uso ordenam pela maior %. ' +
        'Conta sem leitura vai para baixo; 0% conhecido fica acima de «Não informado».',
    },
    {
      title: 'Contas Claude isoladas (F-153)',
      detail:
        'Cada conta tem diretório de auth próprio. A seleção do Nexus não reescreve o ' +
        'Keychain global nem atribui a credencial B ao cofre A.',
    },
    {
      title: 'Codex refresca a conta escolhida (F-207)',
      detail:
        'A trava de spawn espera o auth.json da conta materializada. Timeout não libera ' +
        'follower com refresh token velho.',
    },
  ],
  fixes: [
    {
      title: 'Terminal Codex não some no resize (F-356/F-357)',
      detail:
        'Medir sem mutar, um resize só, fila ANSI sobrevive ao descarte. Chromium: cursor ' +
        '76 e texto preservados (antes 76→30 e SPIN apagado).',
    },
    {
      title: 'Redline depois do update (F-612/F-029)',
      detail:
        'Copia o binário novo para /Applications e relança. Painel escuro com logos, ' +
        'faixa compacta, só contas com leitura na barra.',
    },
    {
      title: 'Pane manual não estaciona no TTL (F-150)',
      detail:
        'Guardian não mata pane aberto pela mão nem worker de missão só porque o relógio ' +
        'andou, sem pressão de memória.',
    },
    {
      title: 'Segundo login guarda a sessão atual (F-358)',
      detail:
        'AccountsManager preserva a conta ativa antes de abrir o terminal de cadastro.',
    },
    {
      title: 'Kimi overlay leva o catálogo nativo (F-611)',
      detail:
        'models/providers entram no overlay no spawn e voltam se a TUI reescrever config.toml.',
    },
    {
      title: 'AGY aliases e esforço (F-151/F-154)',
      detail:
        'Skills reconcilia aliases antes do pane; níveis de esforço aceitos pela CLI ' +
        '(max → high).',
    },
  ],
};

export const RELEASE_07661: AppRelease = {
  version: '0.76.61',
  date: '2026-09-20',
  codename: 'Redline no menu bar, tok/s visível e abas de espaço',
  summary:
    'Cotas na barra de menu do Mac (Redline), chip de tok/s que deixa de sumir atrás das ' +
    'ações do pane, aba do espaço com nome editável, login do Kimi perguntando o site, ' +
    'Muse na CLI certa e cota GLM de novo visível depois da troca CREDIT_LIMIT.',
  highlights: [
    {
      title: 'Redline no menu bar',
      detail:
        'Companheiro nativo com barras 5h/semana por conta, urgência e cronômetro até o reset. ' +
        'O Nexus publica ~/.nexus/redline-last-good.json (sem segredos, e-mail mascarado). ' +
        'Fleet Pulse em Uso e cotas; a escolha de conta no spawn continua aritmética de folga.',
    },
    {
      title: 'tok/s visível ao lado do custo (F-607)',
      detail:
        'Custo e velocidade saem do recorte da toolbar e ficam em um cluster que não encolhe. ' +
        'No pane largo com rótulos cheios o chip caía na linha clipada — o operador via $ e ' +
        '"Trabalhando" e nunca a velocidade.',
    },
    {
      title: 'Renomear a aba do espaço (F-606)',
      detail:
        'Duplo clique no chip "Meus terminais" edita o nome, no mesmo padrão do título do pane. ' +
        'Missão e "Painéis soltos" não entram em edição.',
    },
    {
      title: 'Login do Kimi pergunta kimi.ai vs kimi.com (F-354/F-595)',
      detail:
        'Antes de abrir a CLI o Nexus pergunta o site; cancelar a escolha não pinta erro de login.',
    },
  ],
  fixes: [
    {
      title: 'Muse deixa de imprimir --help e sair 2 (F-596/F-599)',
      detail:
        'O adapter muse não herda mais --mcp-config/--settings do Claude. muse-claude (Spark) é opcional.',
    },
    {
      title: 'Codex do operador não mistura url+stdio (F-594)',
      detail:
        'No spawn da mão do operador, chaves do hub que já existem no config.toml preservado são puladas.',
    },
    {
      title: 'Colar em pane morto não mente "cópia falhou" (F-593)',
      detail:
        'O arquivo já estava no disco; o toast passa a dizer que o pane não tem sessão ativa.',
    },
    {
      title: 'Cota GLM CREDIT_LIMIT (F-608)',
      detail:
        'A API Z.ai passou a rotular as janelas como CREDIT_LIMIT; o parser aceita o nome novo e o antigo.',
    },
    {
      title: 'Pane vivo não some ao sair dos Terminais (F-603)',
      detail:
        'Sair da workspace de terminais não derruba mais o pane que ainda tem processo.',
    },
  ],
};

export const RELEASE_07660: AppRelease = {
  version: '0.76.60',
  date: '2026-09-19',
  codename: 'Pacing EAGAIN no PTY e resume verificado do uso Codex',
  summary:
    'Retry de escrita do PTY com pacing de 1ms (fim do busy-loop sob leitor travado) e ' +
    'resume verificado do scanner de uso do Codex entre restarts, com totais idênticos e ' +
    'reparse integral em qualquer dúvida.',
  highlights: [
    {
      title: 'Retry EAGAIN com pacing no node-pty (F-591)',
      detail:
        'Porte do Orca #15319: o retry de EAGAIN espera 1ms em vez de re-tentar em microssegundos ' +
        '(121k/s a ~100% CPU viram 805/s a ~4%), e o dispose aposenta o master fd com drop da ' +
        'fila (Orca #17914). Panes sob leitor travado deixam de saturar a máquina.',
    },
    {
      title: 'Resume verificado do scanner de uso Codex (F-592)',
      detail:
        'Offsets e snapshot do ingestor persistem entre restarts e só retomam com duplo digest ' +
        'verificado (head+boundary); restart no meio de rollout preserva totais idênticos sem ' +
        'revarrer megabytes (desenho Orca #21102).',
    },
  ],
  fixes: [
    {
      title: 'F-591: Busy-loop de CPU no thread do PTY sob EAGAIN contínuo',
      detail:
        'applyEagainPacing com 5 âncoras fail-closed no patch darwin pinado; fluxo em 3 estados ' +
        'com caminho de upgrade para instalações já seladas.',
    },
    {
      title: 'F-592: Scanner Codex perdia offsets no restart e revarria tudo',
      detail:
        'Resume store atômico com validação estrita, snapshot/restore do ingestor (ordinal incluído) ' +
        'e checkpoints por scan; 8 achados do code review sênior corrigidos com regressões.',
    },
  ],
};

export const RELEASE_07659: AppRelease = {
  version: '0.76.59',
  date: '2026-09-19',
  codename: 'Paridade de Git com Orca, empty states amigáveis e velocidade de tokens contínua',
  summary:
    'Paridade completa de Source Control com o Orca (troca e criação de branches, puxar alterações com pull, descartar alterações ' +
    'individuais ou em lote), empty states acolhedores e interativos nos painéis contextuais laterais, e visibilidade ' +
    'contínua do medidor de velocidade de tokens (tok/s e TTFT) em repouso nos panes de agentes.',
  highlights: [
    {
      title: 'Paridade de Git / Source Control com Orca (F-584)',
      detail:
        'Menu de branches completo com alternância imediata e criação de nova branch (git checkout / checkout -b), ' +
        'botões dedicados de pull e push com contadores na barra de ferramentas, descarte seguro de arquivos modificados ou untracked ' +
        '(git checkout -- / git clean -f) e ação primária de pull quando atrás do repositório remoto.',
    },
    {
      title: 'Painéis laterais acolhedores e funcionais (F-584)',
      detail:
        'Estados vazios de Missão, Busca, Skills e Git agora trazem cartões explicativos com ações diretas: "+ Armar Nova Missão", ' +
        'busca orientada por símbolos e arquivos, e botão para abrir o catálogo de skills diretamente no Marketplace.',
    },
    {
      title: 'Velocidade de tokens sempre visível nos agentes (F-585)',
      detail:
        'O chip de velocidade de geração (tok/s e TTFT) permanece visível nos panes de IA em estado pronto ("— tok/s"), ' +
        'confirmando a prontidão do medidor sem exibir números fictícios antes da resposta do modelo.',
    },
    {
      title: 'Correção de catálogo e roteamento do Google Gemini 3.8 (F-586)',
      detail:
        'Remoção de referências ao modelo inexistente gemini-3.8-pro e promoção oficial de gemini-3.8-flash-high ' +
        'como padrão do Antigravity/AGY, alinhando catálogo, squads, prompts Jarvis e migração automática de legado.',
    },
    {
      title: 'Padrão de 1M de janela de contexto para LLMs de grande capacidade (F-587)',
      detail:
        'Overlays gerenciados do Codex agora configuram automaticamente 1.000.000 de tokens de contexto e 950.000 ' +
        'de teto para compactação de conversa, eliminando a limitação padrão de 256k e aproveitando toda a capacidade dos modelos.',
    },
    {
      title: 'Estacionamento de panes ociosos sob pressão e otimização para máquinas inferiores (F-588)',
      detail:
        'O reaper de emergência e a varredura pós-TTL agora podem estacionar (parkPane) workers e helpers ociosos, ' +
        'liberando ~1 GB de RAM por pane enquanto preservam o histórico no grid com botão "Acordar". O teto seguro de panes foi calibrado para 2 em máquinas de 8 GB.',
    },
    {
      title: 'Resiliência adaptativa no envio de Enter / Correção do "Pane Dormindo" (F-589)',
      detail:
        'Eliminado o travamento de prompts e cutucadas de handoff que aguardavam Enter manual: ' +
        'retentativas adaptativas com backoff (600ms, 1200ms, 2000ms) e alternância de \\r e \\r\\n garantem início imediato do turno.',
    },
    {
      title: 'Paridade do dialeto cron de automações com o Orca (F-590)',
      detail:
        'Expansão de passos N/step (sequência aberta N-max/step) e restrição lexical POSIX/vixie para dias, ' +
        'garantindo paridade exata com o Orca e evitando disparos indevidos em agendamentos recorrentes.',
    },
  ],
  fixes: [
    {
      title: 'F-584: Paridade de Source Control e resolução de telas vazias nos painéis contextuais',
      detail:
        'Implementados IPC e workspace handlers de branches, pull e discard com sanitização rígida de argumentos Git; ' +
        'atualizados stores do renderer e empty states com botões acionáveis.',
    },
    {
      title: 'F-585: Chip de velocidade de tokens invisível em repouso',
      detail:
        'TokenSpeedChip passa a renderizar estado em repouso com indicador data-idle e tooltip explicativo nos panes cli-agent.',
    },
    {
      title: 'F-586: Modelo inexistente gemini-3.8-pro corrigido para gemini-3.8-flash-high',
      detail:
        'Alinhado catálogo oficial da CLI Antigravity, corrigidos defaults em agy.json, model-catalog, squads e migração no spawn.',
    },
    {
      title: 'F-587: Limitação de 256k de contexto no Codex elevada para 1M como padrão de produto',
      detail:
        'prepareCodexGovernedSession e prepareCodexOperatorMissionHome estabelecem 1.000.000 como piso garantido ' +
        'para model_context_window e 950.000 para model_auto_compact_token_limit no config.toml do Codex.',
    },
    {
      title: 'F-588: Panes ociosos fantasma e sobrecarga de RAM sob pressão de memória em máquinas inferiores',
      detail:
        'isGuardianParkablePane e paneIsParkableUnderPressure autorizam estacionamento limpo de workers e panes de operador, ' +
        'e limitsForMachine calibra o teto de panes proporcionalmente à memória total (2 panes para 8 GB).',
    },
    {
      title: 'F-589: Pane travado em repouso após colagem de briefing aguardando Enter humano',
      detail:
        'scheduleAdaptiveEnterRescue em tool-util e retentativas adaptativas em worker-handoff-enforcement e idle-delivery ' +
        're-enviam o sinal de submissão enquanto o TUI permanecer idle, prevenindo bloqueio autônomo.',
    },
    {
      title: 'F-590: Divergência na expansão de passo e semântica de dia em expressões cron de automação',
      detail:
        'parseCronField expande N/step até o teto do campo e isCronDayFieldRestricted preserva a semântica ' +
        'lexical de curingas (*), eliminando disparos excessivos em intervalos fracionados.',
    },
  ],
};

export const RELEASE_07658: AppRelease = {
  version: '0.76.58',
  date: '2026-09-19',
  codename: 'Resiliência de providers no failover, desambiguação e nova missão nas abas do grid',
  summary:
    'Fim definitivo do loop de failover com toast enganoso ao ocorrer falha transiente no Claude quando há conta secundária ' +
    'com renovação pendente, redução do tempo de quarentena de refresh, desambiguação automática de títulos idênticos ' +
    'entre escopos de terminais, indicação visual por badge e status dot de missão, e atalho rápido "+ Nova missão" na barra de abas.',
  highlights: [
    {
      title: 'Resiliência e Desacoplamento no Failover Claude (F-583)',
      detail:
        'Contas secundárias com renovação OAuth pendente ou falhando são filtradas preventivamente antes da escolha de failover. ' +
        'O erro da secundária não culpa mais a conta ativa em toasts, e a janela de quarentena de refresh foi reduzida para 2 minutos.',
    },
    {
      title: 'Legibilidade e Ação Rápida nas Abas do Grid (F-583)',
      detail:
        'A barra de abas de terminais exibe as contagens de painéis em badges destacadas (sem colar números no título), ' +
        'desambigua títulos idênticos com índices (#1, #2), exibe status dots para missões em execução e adiciona o botão "+ Nova missão".',
    },
  ],
  fixes: [
    {
      title: 'F-583: Loop de toasts de failover da conta Claude e legibilidade das abas de escopo no grid',
      detail:
        'Implementada checagem hasRecentClaudeRefreshFailure em accountHasFailoverCredential, flexibilizado prepareAccountForSpawn ' +
        'para tokens válidos em cofre, desambiguação automática de escopos em listPaneScopes e botão de nova missão no TerminalWorkspace.',
    },
  ],
};

export const RELEASE_07657: AppRelease = {
  version: '0.76.57',
  date: '2026-09-18',
  codename: 'Jev sugere a skill',
  summary:
        'Duas peças do cookbook oficial da TypeSafe entram no Nexus. O ' +
        'roteamento de tarefas passa a sugerir a skill instalada que ' +
        'ajuda naquela tarefa — uma escolha do Jev entre as skills ' +
        'bundled, com "nenhuma" como resposta válida — e o pane aberto ' +
        'pelo fan-out do operador recebe essa dica no prompt quando a ' +
        'confiança é alta. E a extração tipada do browser faz uma única ' +
        'consulta ao Jev para todos os campos, em vez de uma por campo.',
  highlights: [
    {
      title: 'Skill sugerida pelo Jev no roteamento',
      detail:
        'nexus_route_task devolve skillSuggestion: o catálogo das skills ' +
        'bundled (impeccable, archify, superpowers e suas sub-skills, ' +
        'bmad-templates, dembrandt, typesafe-ai e as skills nativas do ' +
        'Nexus) é levantado em código a partir do frontmatter de cada ' +
        'SKILL.md, e UMA pergunta choice deixa o Jev escolher no máximo ' +
        'uma skill claramente útil — "none" quando nenhuma. Aceita só com ' +
        'confiança ≥ 0,6, filtrada pelas skills permitidas ao chamador ' +
        '(por pacote ou por nome). Registrado no diário de decisões ' +
        '(surface taskRouting); sem chave TypeSafe, null.',
    },
    {
      title: 'A dica chega ao pane do fan-out',
      detail:
        'Quando nexus_pane_spawn roteia sozinho (sem adapterId), o recibo ' +
        'route.skill traz a sugestão e, com confiança ≥ 0,7 e skill ' +
        'permitida ao filho, uma linha é acrescentada ao prompt: "Skill ' +
        'sugerida pelo Nexus: <skill> — leia a SKILL.md dela antes de ' +
        'começar". Nunca inventa prompt nem instala nada — o Jev sugere, ' +
        'o pane decide.',
    },
    {
      title: 'Extração do browser em uma chamada',
      detail:
        'nexus_browser_extract resolve em código o que é determinístico ' +
        '(JSON-LD, candidato único, nenhum candidato) e manda TODOS os ' +
        'campos que precisam de julgamento numa única consulta ao Jev — ' +
        'fan-out especulativo: a latência de N campos vira a de um. ' +
        'Booleano indeciso (0,4–0,6) devolve null em vez de ' +
        'cara-ou-coroa.',
    },
  ],
  fixes: [
    {
      title: 'Skill permitida por pacote',
      detail:
        'A sugestão respeita grants por pacote (superpowers) e por nome, ' +
        'como o skill-mirror.',
    },
    {
      title: 'Booleano sem convicção não vira false',
      detail:
        'Probabilidade entre 0,4 e 0,6 devolve null na extração.',
    },
    {
      title: 'Frontmatter YAML dobrado',
      detail:
        'description: > das skills lido inteiro no catálogo.',
    },
  ],
};

export const RELEASE_07656: AppRelease = {
  version: '0.76.56',
  date: '2026-09-18',
  codename: 'O browser fala de volta',
  summary:
    'O browser do agente deixa de ser um passo às cegas: toda ação devolve ' +
    'onde a página ficou, o que mudou e que erros apareceram — console, ' +
    'HTTP e falhas de carregamento — na mesma resposta. O agente acha o ' +
    'alvo por texto sem seletor, lê a página resultante sem uma chamada ' +
    'extra, sabe se ainda há página abaixo e, quando pede, o Jev diz se ' +
    'aquilo é um erro, se precisa de humano ou que tipo de página é. E ' +
    'nexus_browser_extract transforma a página em campos tipados: o código ' +
    'levanta os candidatos, o Jev escolhe — nunca inventa.',
  highlights: [
    {
      title: 'Toda ação devolve o depois',
      detail:
        'click, fill, press, scroll, hover e navigate respondem com after ' +
        '(url, título, carregando) e changed (url, título e navigated: ' +
        'none, same-document ou new-document — o Main espera o ' +
        'did-stop-loading numa navegação real). read: true embute a página ' +
        'resultante na mesma resposta, em JSON ou no format compact ' +
        '(outline com [e12] link "Ver squads" → /squads); viewport e ' +
        'atBottom dizem se ainda há página abaixo. Menos idas e voltas que ' +
        'um browser_act que só diz changed: false.',
    },
    {
      title: 'Alvo por texto, nunca por seletor',
      detail:
        'nexus_browser_find busca elementos visíveis pelo nome acessível (e ' +
        'pelo caminho do link), sem CSS nem JavaScript. click e fill ' +
        'aceitam text/label no lugar do ref: um vencedor claro age; empate ' +
        'devolve os candidatos sem fazer nada — e o Jev desempata só com 2 ' +
        'a 5 candidatos e confiança ≥ 0,7, registrado no diário de ' +
        'decisões.',
    },
    {
      title: 'Ver erros pelo browser',
      detail:
        'Cada resposta traz errors desde a última ação: erros de console ' +
        'JS, respostas HTTP ≥ 400 e falhas de carregamento capturados no ' +
        'Main (redigidos, no máximo 5 itens), mais os alerts da página ' +
        '(role=alert, aria-invalid). judge: true anexa o julgamento Jev: ' +
        'erro visível, bloqueado por humano (login, captcha, 2FA), ainda ' +
        'carregando e o tipo de página — opt-in, fail-open, superfície ' +
        'browserTool.',
    },
    {
      title: 'nexus_browser_extract: da página para campos tipados',
      detail:
        'O agente declara os campos (nome, tipo ' +
        'string/number/boolean/date/enum, hint). O código levanta ' +
        'candidatos limitados e redigidos — JSON-LD embutido, tabelas, ' +
        'label→valor, números, datas, e-mails e valores — e resolve: ' +
        'JSON-LD bate direto, candidato único vale 0,8, dois ou mais vão ao ' +
        'Jev, que escolhe com confiança ≥ 0,6; booleano e enum são ' +
        'perguntas tipadas. Números pt-BR/en e datas normalizados em ' +
        'código; null quando não há candidato confiável. Valores digitados ' +
        'em campos nunca saem da página.',
    },
  ],
  fixes: [
    {
      title: 'Find e extract respeitam a revisão automatizada',
      detail:
        'Os dois passam pelas mesmas checagens de superfície e URL do read.',
    },
    {
      title: 'Rótulos de candidatos também redigidos',
      detail:
        'Label e valor passam pela mesma máscara antes de sair da página.',
    },
    {
      title: 'Jev indisponível não é reconsultado',
      detail:
        'Uma extração com várias colunas não repete a chamada depois da ' +
        'primeira falha.',
    },
    {
      title: 'Console legado do Electron',
      detail:
        'A assinatura posicional (event, level, message) volta a ser lida ' +
        'no campo certo.',
    },
  ],
};

export const RELEASE_07655: AppRelease = {
  version: '0.76.55',
  date: '2026-09-18',
  codename: 'Grok escuta (canal Windows)',
  summary:
    'O canal Windows x64 alcança a 0.76.54: quem atualizou para a 0.76.53 ' +
    'recebe agora o Grok Voice Transcribe 2.0 da xAI no seletor de ' +
    'transcrição da voz, o recibo de qual conta o pane nasceu e por quê, e o ' +
    'consumo do Jev por janela no painel de decisões — cada canal publica a ' +
    'própria próxima versão estável.',
  highlights: [
    {
      title: 'Grok Voice Transcribe 2.0 no seletor de transcrição',
      detail:
        'Novo provedor xai em Ajustes → Voz → Transcrição da fala: POST ' +
        'api.x.ai/v1/stt com grok-voice-transcribe-2.0, language=pt e o ' +
        'arquivo por último, keyterm como viés de vocabulário (jargão do modo ' +
        'CODE; a wake word no passive-wake). Usa a XAI_API_KEY já configurada ' +
        'para o Grok realtime — só transcreve. Cadeia padrão: Gemini → Grok → ' +
        'Groq → OpenAI → whisper.cpp; o link entra depois do último provedor ' +
        'cloud, nunca no lugar do escolhido, e cadeias só-locais ficam ' +
        'intactas.',
    },
    {
      title: 'Recibo da escolha de conta no spawn',
      detail:
        'nexus_pane_spawn devolve harness.account e nexus_pane_whoami devolve ' +
        'account: quem decidiu (pinada, regra de folga, ativa, fallback na ' +
        'ativa, linhagem nativa ou legado), a conta com rótulo mascarado, a ' +
        'folga medida da vencedora e as alternativas com o motivo de cada ' +
        'perda. A regra continua decidindo — o Jev não escolhe conta.',
    },
    {
      title: 'Consumo do Jev por janela',
      detail:
        'Decisões do Jev ganha "Consumo do Jev (TypeSafe)": Hoje, 30 dias e ' +
        'desde sempre × consultas · custo estimado · sem resposta, e por ' +
        'superfície "N pelo Jev · M pela regra". O diário grava a consulta ' +
        'que falhou (só a categoria, nunca o texto) e a leitura sobrevive à ' +
        'rotação. Custo = tokens de entrada × US$ 0.042 por milhão, preço ' +
        'público da TypeSafe.',
    },
  ],
  fixes: [
    {
      title: 'Números honestos no consumo e na máscara',
      detail:
        'Custo abaixo de US$ 0.0001 aparece como "< US$ 0.0001" em vez de ' +
        'US$ 0.0000; o recibo de conta só é registrado depois que o spawn se ' +
        'firma no Main; a máscara de conta guarda só o sufixo público ' +
        '(.com.br, nunca subdomínios internos); linhas sem resposta ficam com ' +
        'tokens e custo nulos em vez de zero fabricado.',
    },
  ],
};

export const RELEASE_07654: AppRelease = {
  version: '0.76.54',
  date: '2026-09-18',
  codename: 'Grok escuta',
  summary:
    'O Grok Voice Transcribe 2.0 da xAI entra no seletor de transcrição ' +
    'da voz — batch rápido e barato, na mesma chave do Grok realtime, com ' +
    'viés de vocabulário para o modo CODE e a wake word. O ' +
    'nexus_pane_spawn passa a dizer em qual conta o pane nasceu e por quê ' +
    '(regra de folga, pinada, ativa, fallback), com as alternativas e a ' +
    'folga de cada uma. E o painel Decisões do Jev mostra o consumo por ' +
    'janela — hoje, 30 dias, desde sempre — incluindo as consultas sem ' +
    'resposta e a divisão "pelo Jev · pela regra".',
  highlights: [
    {
      title: 'Grok Voice Transcribe 2.0 no seletor de transcrição',
      detail:
        'Novo provedor xai em Ajustes → Voz → Transcrição da fala: POST ' +
        'api.x.ai/v1/stt com model grok-voice-transcribe-2.0, language=pt ' +
        '+ format=true (números, datas e valores saem escritos), keyterm ' +
        'como viés de vocabulário (jargão do modo CODE; a wake word no ' +
        'passive-wake) e o arquivo por último, como a API exige. Usa a ' +
        'XAI_API_KEY já configurada para o Grok realtime. Só transcreve — ' +
        'sem tradução, o modo CODE mostra CODE·PT como já acontece com ' +
        'provedores transcription-only. Cadeia padrão: Gemini → Grok → ' +
        'Groq → OpenAI → whisper.cpp; instalações existentes ganham o ' +
        'link após o último provedor cloud, nunca no lugar do escolhido; ' +
        'cadeias só-locais ficam intactas. Contrato validado contra a ' +
        'documentação oficial da xAI e coberto por testes; qualquer ' +
        'recusa da API cai no próximo provedor da cadeia, como sempre.',
    },
    {
      title: 'Recibo da escolha de conta no spawn',
      detail:
        'nexus_pane_spawn devolve harness.account e nexus_pane_whoami ' +
        'devolve account: quem decidiu (pinada pelo chamador, regra de ' +
        'folga, ativa, fallback na ativa, linhagem nativa ou legado), a ' +
        'conta com rótulo mascarado (g•••@l•••.com.br), a folga medida da ' +
        'vencedora (pior janela, % usado, quando reseta) e as ' +
        'alternativas com o motivo de cada perda (cooldown, sem ' +
        'credencial, menos folga, sem medição). A regra continua ' +
        'decidindo — Jev não escolhe conta: comparar cota medida é ' +
        'aritmética, e um decisor com 38% de confiança escolhendo a conta ' +
        'com 77% queimado foi exatamente o caso que a revisão do desenho encontrou.',
    },
    {
      title: 'Consumo do Jev por janela',
      detail:
        'Decisões do Jev ganha "Consumo do Jev (TypeSafe)": Hoje, 30 dias ' +
        'e desde sempre × consultas · custo estimado · sem resposta, e ' +
        'por superfície "N pelo Jev · M pela regra". O diário passa a ' +
        'gravar a consulta que falhou (timeout, limite, servidor, rede, ' +
        'malformado, abortado, erro do cliente — só a categoria, nunca o ' +
        'texto) e a leitura sobrevive à rotação do arquivo. Custo = ' +
        'tokens de entrada × US$ 0,042 por milhão, preço público da ' +
        'TypeSafe; chamada direta, sem OpenRouter.',
    },
  ],
  fixes: [
    {
      title: 'Custo miúdo não vira zero',
      detail:
        'Consumo abaixo de US$ 0,0001 aparece como "< US$ 0,0001" em vez ' +
        'de US$ 0,0000.',
    },
    {
      title: 'Recibo de conta só depois da sessão firmada',
      detail:
        'O registro por sessionId acontece depois que o spawn se firma no ' +
        'Main.',
    },
    {
      title: 'Máscara de conta guarda só o sufixo público',
      detail:
        'g•••@l•••.com.br, nunca subdomínios internos.',
    },
    {
      title: 'Consulta sem resposta não inventa zero',
      detail:
        'Tokens e custo ficam nulos nas linhas sem resposta, seguindo a ' +
        'doutrina do app para métrica ausente.',
    },
  ],
};

export const RELEASE_07653: AppRelease = {
  version: '0.76.53',
  date: '2026-09-18',
  codename: 'Push sai do pane (canal Windows)',
  summary:
    'O canal Windows x64 alcança a 0.76.52: cada canal publica a própria ' +
    'próxima versão estável, e quem atualiza da 0.76.41 recebe de uma vez o ' +
    'git push saindo de dentro do pane, o pane Claude que abre logado de ' +
    'primeira, o fim do re-baixar ~500 MB de MCPs a cada abertura, a era Jev ' +
    'no despacho e no fan-out, pane dormindo com "Acordar" e o medidor de ' +
    'velocidade por modelo na barra do próprio pane.',
  highlights: [
    {
      title: 'Git push de dentro do pane (F-579/F-580/F-581)',
      detail:
        'O HOME privado da família Claude nascia sem ~/.gitconfig, ~/.ssh e ' +
        '~/.config/gh: credential helper sumido, SSH sem chave, push pedindo ' +
        'usuário. Panes graváveis passam a receber a identidade de ' +
        'desenvolvedor do operador; o runner de git do Main volta a honrar a ' +
        'config global (gh auth git-credential, GCM, user.name/email) com a ' +
        'config local executável do repo seguindo recusada; e ' +
        'nexus_git_sync fica alcançável pela mão do operador em vibe.',
    },
    {
      title: 'Pane Claude abre logado no Windows (F-576)',
      detail:
        'O spawn escrevia CLAUDE_CONFIG_DIR="" para neutralizar um path ' +
        'herdado, só que vazio não é ausência: o resolver do binário aceitava ' +
        '"" via ?? e resolvia .credentials.json relativo ao cwd do pane — todo ' +
        'pane novo nascia em "Not logged in · Run /login" na máquina ' +
        'autenticada. A chave agora é removida de verdade do env do filho ' +
        '(envRemove) e o login feito no pane atravessa para a credencial de ' +
        'verdade.',
    },
    {
      title: 'Pane sobe a quente (F-578)',
      detail:
        'Os servidores MCP npx/uvx do perfil herdado resolviam o cache pelo ' +
        'HOME — descartável no pane. Medido no operador: ~475 MB baixados em ' +
        '<1 min dentro de cada overlay, main a ~99% de CPU em fs durante o ' +
        'spawn, o "tudo fica carregando". Agora o cache de pacotes aponta ' +
        'para <userData>/provider-cache/<adapter>: baixa uma vez por máquina, ' +
        'e todo pane seguinte sobe a quente.',
    },
    {
      title: 'Jev decide, Nexus executa',
      detail:
        'Toda chamada nexus_* com efeito dentro de missão passa por três ' +
        'perguntas ao Jev (TypeSafe): coerente com o objetivo? argumento ' +
        'injetado? efeito irreversível? Injeção ≥ 0.8 nega com auditoria; ' +
        'destrutivo sem relação com o objetivo traz o modal de volta. O agente ' +
        'ganha nexus_tool_pick, o roteamento vira nexus_route_task calibrado e ' +
        'o julgamento tipado segue em nexus_judge — e o fluxo "abra X panes e ' +
        'faça Y" sem missão passa a rotear pelo motor do route_task. Sem ' +
        'chave TypeSafe nada disso existe — o Nexus é o clássico. ' +
        'nexus_computer_do (piloto de desktop) é macOS nesta entrega.',
    },
    {
      title: 'Pane dormindo, guardião e hub MCP (F-572/F-573)',
      detail:
        'Pane ocioso sem dono é ESTACIONADO após 30 min com o scrollback e ' +
        'botão "Acordar" que retoma a mesma conversa; memória de pane ' +
        'dormindo: zero. O teto de panes vira aviso (bloqueio só sob pressão ' +
        'real, limites proporcionais à RAM), o reaper age sob pressão, o ' +
        'cabeçalho mostra o custo de cada pane e os servidores stdio do ' +
        'perfil sobem UMA vez no main, expostos por HTTP aos panes da mão do ' +
        'operador.',
    },
    {
      title: 'Velocidade do modelo, tok/s e TTFT',
      detail:
        'Ajustes → Diagnóstico mede quanto cada LLM gera por segundo na ' +
        'rodada aberta, latência até o 1º token, média/pico e curva — uma ' +
        'linha por modelo, somando panes do mesmo LLM. O chip de tok/s fica ' +
        'na barra do próprio pane, ao lado do badge de custo, e a busca é ' +
        'estrita: sem amostra própria, o chip não ocupa espaço. Métrica sem ' +
        'lastro aparece como travessão, nunca zero falso.',
    },
  ],
  fixes: [
    {
      title: 'Colar mídia no pane volta — e diz o motivo (F-582)',
      detail:
        'Paste aceita qualquer tipo de mídia, lê text/uri-list, imagem ' +
        'embutida em HTML e o pasteboard do sistema; arquivo com caminho real ' +
        'vai path-first em stream até 256 MiB. Recusa mostra a causa real em ' +
        'toast em vez de silêncio.',
    },
    {
      title: 'Swap em uso não trava pane novo (F-574)',
      detail:
        'O teto de 1 GB de swap recusava todo spawn depois de um pico ' +
        'antigo — no Windows o "commit" do relatório é memória prometida, ' +
        'não pressão viva. O gate de swap nasce em 0 (arma por máquina com ' +
        'NEXUS_PANE_MAX_SWAP_MB) e o sinal passa a ser a memória disponível ' +
        'de fato.',
    },
    {
      title: 'Medidor de velocidade endurecido',
      detail:
        'O observador de input do PTY passa a respeitar Backspace, Ctrl+U, ' +
        'Ctrl+W e CRLF, ignorar Enter vazio e não descartar respostas válidas ' +
        'de pontuação ou emoji como ruído de TUI; a contagem do transcript é ' +
        'retida enquanto a rodada está aberta e o filtro de TUI separa ' +
        'zero-width dos glifos de moldura sem quebrar cluster de grafema.',
    },
  ],
};

export const RELEASE_07652: AppRelease = {
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
        'Sobras de hooks de outra ferramenta, apontando para um diretório removido, agora são varridas também em ' +
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
    'quit não espera backend pendurado, "Entrar novamente" funciona e os hooks mortos de ' +
    'outra ferramenta somem do boot.',
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
      title: 'Hooks mortos de outra ferramenta limpos em três alvos',
      detail:
        'Sobras em ~/.claude/settings.json, .codex/hooks.json e .agents/hooks.json apontando ' +
        'para um diretório que não existe mais são removidas no boot quando o executável não existe. Fim do ' +
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

export const RELEASE_07675: AppRelease = {
  version: '0.76.75',
  date: '2026-09-21',
  codename: 'Xiaomi MiMo no Nexus',
  summary: 'MiMo Code ganha integração nativa, contas próprias e os modelos V2.6 Pro e Flash. A cota do Token Plan pode ser conectada ao Nexus e ao Redline.',
  highlights: [
    { title: 'CLI oficial e contas Xiaomi', detail: 'Instale ou conecte MiMo Code nos Providers. As contas mantêm suas credenciais e a região do plano; conversas do Nexus ficam separadas das sessões externas.' },
    { title: 'Pro, Flash e UltraSpeed', detail: 'V2.6 Pro e Flash disponíveis no Token Plan. UltraSpeed exige API separada com cobrança por uso. Os modelos aparecem na comparação interna como não avaliados até haver medições.' },
    { title: 'Consumo no Nexus e no Redline', detail: 'Conecte o console Xiaomi para consultar a cota da mesma conta do Token Plan. A autorização é preservada entre reinícios; falta de leitura não vira consumo zero nem aviso falso de logout.' },
  ],
  fixes: [
    { title: 'Retomada e uso por conversa', detail: 'A sessão exata da CLI acompanha o pane e o registro de tokens, incluindo cache e raciocínio, sem misturar conversas de contas diferentes.' },
    { title: 'MCP, skills e roteamento', detail: 'MiMo Code recebe o MCP do Nexus, skills permitidas e opções de modelo próprias. Benchmarks automáticos exigem chave da API separada, preservando o Token Plan para ferramentas de programação.' },
  ],
};

export const RELEASE_07676: AppRelease = {
  version: '0.76.76',
  date: '2026-09-22',
  codename: 'Redline abre neste macOS',
  summary:
    'O companheiro da barra de menu volta a abrir no macOS 27.0. A compilação ' +
    'fica presa ao piso macOS 14, em vez de herdar um mínimo mais novo que o sistema.',
  highlights: [
    {
      title: 'Nexus Redline abre de novo',
      detail:
        'O alerta «Você não pode usar esta versão do aplicativo Nexus Redline com ' +
        'esta versão do macOS» vinha de um binário carimbado com mínimo 27.2. ' +
        'O app agora exige macOS 14.0, o mesmo piso do pacote, e sobe no 27.0.',
    },
    {
      title: 'A conta em uso fica até a cota acabar',
      detail:
        'Um pane novo continua na conta ativa enquanto a medição ainda mostra ' +
        'folga. A irmã mais livre só entra quando a ativa chega a zero, entra ' +
        'em cooldown ou toma um hit real. Sem medição, a escolha do operador permanece.',
    },
  ],
  fixes: [
    {
      title: 'O mínimo do binário não flutua com o SDK',
      detail:
        'O build do companheiro passa -target arm64-apple-macosx14.0 e recusa ' +
        'entregar um executável cujo minos seja outro. Atualizar o Xcode deixa ' +
        'de gravar sozinho um piso acima do Mac em uso.',
    },
    {
      title: 'Entrar novamente da mesma conta abre o login',
      detail:
        'O aviso «Não consegui guardar a conta atual» não trava mais o re-login ' +
        'quando a sessão viva é a própria conta e o snapshot falha. Se o e-mail ' +
        'vivo for de outra conta, o login continua sem começar, para não apagar ' +
        'essa sessão. Cada conta do vault mantém a própria linha de cota.',
    },
    {
      title: 'O total mensal não chama duas contas de frota inteira',
      detail:
        'O cartão de assinaturas soma só os planos com preço de lista publicado ' +
        'e mostra quantas contas conectadas ficaram de fora. Google AI Ultra ' +
        'entra como $100 ou $200 quando o plano diz 5× ou 20×. Sem esse dado, ' +
        'o Nexus não inventa o valor.',
    },
  ],
};

export const RELEASE_07679: AppRelease = {
  version: '0.76.79',
  date: '2026-09-22',
  codename: 'Chaves no lugar',
  summary:
    'Os panes param de abrir o modal «Chaves Não Encontradas» e de pedir ' +
    'gh auth login com a máquina logada. Chegam também multi-missão com ' +
    'campos A/B, ditado que só envia ao soltar, Opus 5.5 e GPT-6.',
  highlights: [
    {
      title: 'Fim do modal «Chaves Não Encontradas» nos panes',
      detail:
        'Todo HOME privado que o Nexus cria para uma CLI (Claude, Codex, Grok, ' +
        'MiMo, cursor, droid…) enxerga o keychain real do macOS. gh, git e as ' +
        'próprias CLIs deixam de abrir o modal cujo botão «Reajustar Para ' +
        'Padrões» apagaria o seu keychain. GLM/LongCat e workers usam um item ' +
        'de credencial Claude próprio e nunca tocam a sua sessão nativa.',
    },
    {
      title: 'Agentes não pedem mais gh auth login à toa',
      detail:
        'Panes graváveis recebem a sua identidade de git, SSH e gh. Antes, o ' +
        'pane de Grok, MiMo ou cursor não via o gh logado e o agente pedia ' +
        'login com a máquina autenticada.',
    },
    {
      title: 'Multi-missão no mesmo workspace',
      detail:
        'Barra de campos por missão, pinos A/B para alternar entre duas ' +
        'missões e o nome do orquestrador em cada campo. Segue o tema claro ' +
        'e escuro, e o conteúdo da missão A nunca vai para B.',
    },
    {
      title: 'Opus 5.5 e GPT-6 no catálogo',
      detail:
        'Claude Opus 5.5 substitui o 5 no roteador e nos defaults; GPT-6 Sol ' +
        'é o frontier do Codex e Luna cobre o tier barato, com preços, OMP e ' +
        'adapters juntos.',
    },
  ],
  fixes: [
    {
      title: 'O cofre para de insistir no keychain depois da primeira falha',
      detail:
        'Uma falha do safeStorage desliga o cofre pelo resto da sessão em ' +
        'todas as portas (ler, gravar, apagar), não só na gravação. Antes, ' +
        'cada leitura voltava a consultar o keychain e podia reabrir o modal. ' +
        'O cofre também exporta e importa entre Macs com senha.',
    },
    {
      title: 'Ditado só envia ao soltar a tecla',
      detail:
        'Space/PTT não entrega a transcrição antes da hora; o hold-to-talk ' +
        'tem teto de segurança e não encerra no silêncio da fala.',
    },
    {
      title: 'O brief não cai no meio da migração do MiMo',
      detail:
        'Enquanto a migração de banco do MiMo está na tela, o Nexus espera em ' +
        'vez de colar a missão no meio dela, mesmo quando passa de 25 s.',
    },
    {
      title: 'desktop-control não vaza para o terminal externo',
      detail:
        'A digitação só vai para o app da frente e terminais (Terminal, ' +
        'iTerm, Ghostty, Warp, Termius…) são recusados: o conteúdo do ' +
        'operador não cai mais num terminal fora do Nexus.',
    },
    {
      title: 'Jev na pesquisa e no navegador',
      detail:
        'Triagem de pesquisa no search mixer e desempate por confiança no ' +
        'browser_find. O browser_read passa a trazer o julgamento do Jev por ' +
        'padrão; passe judge: false para dispensar.',
    },
  ],
};

export const RELEASE_07681: AppRelease = {
  version: '0.76.81',
  date: '2026-09-22',
  codename: 'Nada escondido',
  summary:
    'CLIs instaladas por nvm, pnpm ou mise param de sumir em outras ' +
    'máquinas, e botões, hovers e o HUD de voz deixam de se esconder.',
  highlights: [
    {
      title: 'Claude, Codex e cia. encontrados em qualquer máquina',
      detail:
        'Instalações via nvm, pnpm, mise, fnm, proto e o instalador antigo do ' +
        'Claude entram na busca, e no Windows também npm, pnpm, Volta e scoop. ' +
        'Se o shell do seu Mac demora para abrir, o Nexus tenta de novo sozinho ' +
        'e reexamina as CLIs sem reiniciar.',
    },
    {
      title: 'Botões e hovers que estavam invisíveis',
      detail:
        'Ícones pequenos perdiam traços (o "+" ao lado de Terminais sumia) e ' +
        'vários hovers da barra lateral nunca apareciam. Agora todos aparecem, ' +
        'nos temas escuro e claro.',
    },
    {
      title: 'O HUD de voz não cobre mais a tela',
      detail:
        'Parado, ele vira só o orb no canto; os controles aparecem ao passar o ' +
        'mouse ou pelo teclado.',
    },
  ],
  fixes: [
    {
      title: 'Mensagem de CLI não encontrada que ajuda',
      detail:
        'Em vez de mandar instalar algo que já está instalado, o aviso aponta ' +
        'Configurações › Providers › Reexaminar CLIs ou o caminho do binário.',
    },
    {
      title: 'Abas e botões mais fáceis de usar',
      detail:
        'Abas dos Providers e do Git reagem ao mouse e ao teclado; botões do ' +
        'pane e da barra lateral ganharam área de clique de 24 px; botão ' +
        'desabilitado não parece mais ativo.',
    },
    {
      title: 'Sessão expirada dita com as palavras certas',
      detail:
        'Com a conta conectada, um erro do servidor agora diz que a sessão ' +
        'expirou, e não "entre na sua conta primeiro".',
    },
  ],
};

export const RELEASE_07683: AppRelease = {
  version: '0.76.83',
  date: '2026-09-22',
  codename: 'Configurações no lugar',
  summary:
    'As Configurações foram reorganizadas pelo que você veio fazer: sete ' +
    'áreas, um nome por página, linguagem simples e páginas que cabem na tela.',
  highlights: [
    {
      title: 'Sete áreas no lugar de nove',
      detail:
        'Conta e acesso a IAs, Jarvis e voz, Aparência e teclado, Equipes e ' +
        'modelos, Biblioteca, Integrações e Segurança e manutenção. A aba, o ' +
        'caminho e o título dizem a mesma coisa; o técnico fica em "Avançado".',
    },
    {
      title: 'Mais espaço para configurar',
      detail:
        'Nas Configurações, a barra lateral esconde projetos e cotas. Páginas ' +
        'longas ficaram enxutas: Comparar modelos, Uso e cotas, Loja, ' +
        'Permissões e Equipes mostram primeiro o que importa.',
    },
    {
      title: 'Sem jargão e sem sinal falso',
      detail:
        'Termos internos viraram português simples, o alerta de pendências ' +
        'virou uma contagem com o motivo e a conta não fica verde quando a ' +
        'sessão precisa ser confirmada.',
    },
  ],
  fixes: [
    {
      title: 'Menus mais claros',
      detail:
        'Tornar um pane orquestrador saiu da fileira de ícones para o menu ' +
        '"…"; o menu de clique direito ficou em grupos; o "+ Pane" não corta ' +
        'mais os nomes.',
    },
    {
      title: 'Celular e Jev no lugar certo',
      detail:
        'O acesso pelo celular na rede local fica na página Celular, e as ' +
        'decisões do Jev ficam na Auditoria.',
    },
    {
      title: 'Fonte, contraste, cliques e leitores de tela',
      detail:
        'Botões e campos usam a fonte do app, avisos ficaram legíveis, ' +
        'controles pequenos ganharam área de clique e os títulos seguem a ' +
        'hierarquia certa.',
    },
  ],
};

export const RELEASE_07684: AppRelease = {
  version: '0.76.84',
  date: '2026-09-22',
  codename: 'CLI certa, janelas vivas',
  summary:
    'Atualizar CLI agora alcança a instalação que o pane usa, e duas janelas ' +
    'Nexus podem continuar processando terminais ao mesmo tempo no Mac.',
  highlights: [
    {
      title: 'CLIs atualizadas automaticamente com sua autorização',
      detail:
        'O Nexus oferece a atualização em segundo plano para instalações ' +
        'locais reconhecidas. Espera a CLI ficar sem pane ativo e confere a ' +
        'versão do executável usado pelo próximo pane; canais que precisam ' +
        'de instalação manual continuam no botão Atualizar CLI.',
    },
    {
      title: 'A CLI certa recebe a atualização',
      detail:
        'Nexus confere o executável que abrirá no próximo pane. Claude nativo ' +
        'usa o updater do Claude; npm, Homebrew e uv recebem o destino da ' +
        'instalação ativa. A tela mostra a versão encontrada e avisa se ela ' +
        'não mudou.',
    },
    {
      title: 'Trabalho em duas janelas',
      detail:
        'No Mac, cobrir uma janela Nexus com outra não pausa os timers que ' +
        'processam a saída do terminal. O aviso de backlog continua reservado ' +
        'para rajadas que ultrapassam a capacidade de parsing.',
    },
  ],
  fixes: [
    {
      title: 'Cotas Claude por identidade confirmada',
      detail:
        'Uma credencial salva na conta errada deixa de repetir o consumo de ' +
        'outra conta. Nexus pede novo login e impede que um pane gerenciado ' +
        'abra com essa credencial.',
    },
    {
      title: 'Menos resultados falsos ao atualizar',
      detail:
        'Se a versão não mudou, ou o Nexus passou a usar outro executável, ' +
        'o resultado deixa isso claro em vez de prometer uma atualização.',
    },
  ],
};

export const RELEASE_07685: AppRelease = {
  version: '0.76.85',
  date: '2026-09-23',
  codename: 'Configurações no lugar',
  summary:
    'O Windows recebe as Configurações organizadas por tarefa, a CLI atualizada onde o pane realmente roda e a cota do Claude presa à conta certa.',
  highlights: [
    {
      title: 'Configurações por tarefa',
      detail:
        'Sete áreas em vez de nove categorias por módulo. O modo foco devolve a largura ao conteúdo e as páginas longas ficaram bem mais curtas.',
    },
    {
      title: 'CLI atualizada onde o pane roda',
      detail:
        'Atualizar mexe na instalação que o pane usa. Se você deixar, o Nexus mantém as CLIs em dia sozinho, sem pane aberto da CLI no meio.',
    },
    {
      title: 'Cota do Claude na conta certa',
      detail:
        'A identidade da credencial é confirmada antes de mostrar a cota. Token de outra conta pede novo login em vez de copiar a cota da irmã.',
    },
  ],
  fixes: [
    {
      title: 'Conta sem verde falso',
      detail:
        'O selo mostra "a confirmar" ou "sessão expirada", com "Entrar de novo" e Cancelar. As mensagens apontam Configurações › Contas de IA.',
    },
    {
      title: 'Menus e alvos de clique',
      detail:
        '"Tornar orquestrador" vai para o menu do pane, "+ Pane" não corta nomes, foco visível e alvos de 24 px.',
    },
  ],
};

export const RELEASE_07686: AppRelease = {
  version: '0.76.86',
  date: '2026-09-23',
  codename: 'A CLI cuida do próprio login',
  summary:
    'No Windows a cota do Claude só lê o login da CLI e não renova o token por conta própria, então o Nexus e a CLI não disputam mais a mesma sessão.',
  highlights: [
    {
      title: 'Login do Claude sem disputa',
      detail:
        'O Nexus só lê o .credentials.json da CLI. Antes os dois podiam renovar ao mesmo tempo e um derrubava o login do outro.',
    },
  ],
  fixes: [],
};

export const RELEASE_07687: AppRelease = {
  version: '0.76.87',
  date: '2026-09-23',
  codename: 'Mais leve no Windows',
  summary:
    'O Nexus para de travar quando os agentes escrevem sem parar, o pane de missão volta a aceitar digitação depois de trocar de workspace e os botões das contas ficam no lugar.',
  highlights: [
    {
      title: 'Sem travar com agente escrevendo',
      detail:
        'Cada pedaço de saída do terminal recopiava 256 KB e percorria toda a janela de replay. Agora custa só o próprio tamanho, e cliques e menus respondem na hora.',
    },
    {
      title: 'Digitação de volta no pane da missão',
      detail:
        'Depois de trocar de workspace, o pane do Codex ou do Claude recusava as teclas e congelava. O Nexus devolve a sessão ao pane quando você volta.',
    },
  ],
  fixes: [
    {
      title: 'Botões das contas alinhados',
      detail:
        'Em Conexão e contas, os botões quebram de linha alinhados ao texto e o "Remover" não sai mais do cartão.',
    },
  ],
};

export const RELEASE_07688: AppRelease = {
  version: '0.76.88',
  date: '2026-09-23',
  codename: 'Tudo no mesmo campo',
  summary:
    'Orquestrador e painéis de uma missão começada pelos panes ficam no mesmo campo, a barra de campos fica alinhada, o modo CODE entrega prompt em inglês e terminal parado para de contar token.',
  highlights: [
    {
      title: 'Coordenador e equipe juntos',
      detail:
        'Com "Tornar orquestrador" num pane sem missão, os painéis soltos entram no campo dele. Espaços nomeados e missões seguem separados.',
    },
    {
      title: 'Modo CODE em inglês para o agente',
      detail:
        'O ditado vira um prompt claro em inglês, com passos numerados quando há vários pedidos, sem mexer em nomes, caminhos e comandos. Funciona também com o Grok Voice.',
    },
  ],
  fixes: [
    {
      title: 'Barra de campos alinhada',
      detail:
        'Cartões com borda sólida e mesma altura, "Todos" inteiro e sem a segunda linha repetida.',
    },
    {
      title: 'Token só quando há texto novo',
      detail:
        'Redesenhar a tela de um terminal parado não mostra mais tok/s nem "gerando".',
    },
  ],
};

export const RELEASE_07689: AppRelease = {
  version: '0.76.89',
  date: '2026-09-23',
  codename: 'Voz Gemini 3.8',
  summary:
    'O Jarvis passa a falar com o Gemini 3.8 Flash-Lite TTS, pela mesma chave Gemini da transcrição, com OpenAI, Piper e say de reserva.',
  highlights: [
    {
      title: 'Gemini 3.8 Flash-Lite como voz padrão',
      detail:
        'Voz natural em português brasileiro pela chave Gemini que você já usa. Se o Gemini falhar, a OpenAI e o Piper continuam falando.',
    },
    {
      title: 'Voz e modelo à sua escolha',
      detail:
        'Em Ajustes › Voz, escolha entre as vozes do Gemini e entre Flash-Lite (rápida) e Flash (qualidade).',
    },
  ],
  fixes: [
    {
      title: 'Voz de reserva preservada',
      detail:
        'As migrações antigas de configuração não gravam mais uma voz do Gemini na OpenAI.',
    },
  ],
};

export const RELEASE_07690: AppRelease = {
  version: '0.76.90',
  date: '2026-09-23',
  codename: 'Atualização que não trava',
  summary:
    'Instalar ou atualizar o Nexus no Windows não fica mais parado esperando o Nexus Redline.',
  highlights: [
    {
      title: 'Atualização até o fim',
      detail:
        'Durante a instalação o Nexus só responde ao instalador e sai. Antes ele reabria o Redline e o instalador esperava por ele para sempre.',
    },
  ],
  fixes: [],
};

export const RELEASE_07691: AppRelease = {
  version: '0.76.91',
  date: '2026-09-23',
  codename: 'O microfone explica',
  summary:
    'Quando o microfone falha, o Nexus diz o que fazer em português, e o log de cada ditado mostra quem transcreveu e o que ouviu.',
  highlights: [
    {
      title: 'Microfone que explica o problema',
      detail:
        'Sem microfone, bloqueado pela privacidade ou ocupado por outro app: a mensagem aponta onde resolver, em vez de "Requested device not found".',
    },
    {
      title: 'Ditado rastreável',
      detail:
        'O voice.log registra o serviço que transcreveu, o texto cru e, no modo CODE, o texto final de cada ditado.',
    },
  ],
  fixes: [],
};

export const RELEASE_07692: AppRelease = {
  version: '0.76.92',
  date: '2026-09-23',
  codename: 'Pasta confiada',
  summary:
    'O Claude para de perguntar se confia na pasta a cada pane no Windows, e a continuidade automática não fecha mais o pane no menu de confiança.',
  highlights: [
    {
      title: 'Workspace aberto é pasta confiada',
      detail:
        'Panes Claude, GLM e LongCat dentro do workspace aberto nascem com a confiança da pasta, só no perfil isolado do pane.',
    },
    {
      title: 'Confiança já dada vale no Windows',
      detail:
        'O Nexus agora acha a pasta que o Claude gravou com barra normal (C:/...), e o pane não pergunta de novo.',
    },
  ],
  fixes: [
    {
      title: 'Continuidade não escolhe "No, exit"',
      detail:
        'Com um menu de confirmação na tela, a continuidade espera em vez de mandar Enter e fechar o Claude.',
    },
  ],
};

export const RELEASE_07693: AppRelease = {
  version: '0.76.93',
  date: '2026-09-23',
  codename: 'Ditado no lugar',
  summary:
    'O Mac recebe o lote 0.76.85–0.76.92 — voz Gemini 3.8, modo CODE em ' +
    'inglês, campos de missão juntos e workspace como pasta confiada — e o ' +
    'ditado passa a chegar no pane certo, mais rápido, com failover que não ' +
    'troca de conta sozinho e tok/s sem número falso.',
  highlights: [
    {
      title: 'Ditado no pane do campo focado',
      detail:
        'Trocar de campo leva o foco. Ditado, Jarvis e anexos entregam no ' +
        'pane focado — um pedido de outro projeto não cai mais no agente errado.',
    },
    {
      title: 'Ditado CODE mais rápido',
      detail:
        'Uma tradução só: transcrição literal e reescrita em inglês a partir ' +
        'do original. Se a reescrita falhar, a STT transcreve de novo já ' +
        'traduzindo — o CODE nunca entrega português. O voice.log registra ' +
        'sttMs e polishMs de cada ditado.',
    },
    {
      title: 'Voz Gemini 3.8 e workspace confiável',
      detail:
        'A Jarvis fala com o Gemini 3.8 Flash-Lite; o modo CODE entrega prompt ' +
        'em inglês pronto para o agente. Panes Claude/GLM/LongCat dentro do ' +
        'workspace aberto nascem com a confiança da pasta.',
    },
    {
      title: 'Campos de missão juntos',
      detail:
        'Painéis soltos entram no campo do coordenador local; a barra de campos ' +
        'fica alinhada, sem linha repetida. Missões começadas pelos panes ficam juntas.',
    },
  ],
  fixes: [
    {
      title: 'tok/s sem número falso',
      detail:
        'Terminal parado não conta token; contagem real sem janela honesta ' +
        'vira "—". Janela e taxa num lugar só; o teto de sanidade sobe para 6.000.',
    },
    {
      title: 'Failover que fica na conta',
      detail:
        'Erro 5xx do provider não troca de conta em ping-pong. Depois do ' +
        'backoff, a missão retoma na mesma sessão com um "continue" — sem ' +
        'respawn. Foco pedido num pane de outro campo não é desviado.',
    },
    {
      title: 'Main thread mais leve',
      detail:
        'Com agente escrevendo sem parar, a saída do terminal não copia mais ' +
        'o buffer inteiro a cada pedaço. Cliques e menus respondem na hora.',
    },
    {
      title: 'Microfone que explica',
      detail:
        'Falha de microfone diz o que fazer, em português. O log do ditado ' +
        'mostra quem transcreveu e o que ouviu antes do CODE.',
    },
  ],
};

export const RELEASE_07694: AppRelease = {
  version: '0.76.94',
  date: '2026-09-23',
  codename: 'Abas de feature',
  summary:
    'Os Terminais viram abas: cada aba é uma feature, com os panes dela e a ' +
    'missão que um deles começou, e duas abas cabem lado a lado. Uma missão ' +
    'nunca mais mistura projetos, o Quadro mostra o que o terminal faz e ' +
    'criar missão pelo pane não trava os panes novos.',
  highlights: [
    {
      title: 'Terminais em abas',
      detail:
        'Cada aba é uma feature: os panes dela e a missão que um deles ' +
        'começou. O "+" abre o pane numa aba nova; duplo clique renomeia; ' +
        '⌘/Ctrl+Alt+→/← troca de aba; a grade mostra a visão geral.',
    },
    {
      title: 'Missão começada pelos panes fica junto deles',
      detail:
        'Quando o agente do seu pane cria a missão, ela, o orquestrador e os ' +
        'workers ficam na aba desse pane. Missão do assistente segue com aba própria.',
    },
    {
      title: 'Duas abas lado a lado',
      detail:
        'Clique direito numa aba → Ver ao lado. Cada metade leva o nome da aba ' +
        'e a divisória se ajusta.',
    },
  ],
  fixes: [
    {
      title: 'Missão nunca mistura projeto',
      detail:
        'Trocar de projeto com um pane abrindo ou fechando não carrega mais a ' +
        'missão do projeto anterior. Ditado, anexo e Jarvis não digitam no ' +
        'terminal escondido de outro projeto.',
    },
    {
      title: 'Criar missão pelo pane não trava os panes',
      detail:
        'Em Autopilot a missão criada pelo agente do seu pane nasce rodando — ' +
        'sem dispatch_required até alguém achar Despachar.',
    },
    {
      title: 'Quadro fiel ao terminal',
      detail:
        'Missão sem plano não mostra papéis fantasmas "Na fila"; orquestrador ' +
        'que reiniciou em outra CLI aparece vivo no card, com o aviso certo.',
    },
  ],
};

export const RELEASE_07695: AppRelease = {
  version: '0.76.95',
  date: '2026-09-23',
  codename: 'Voz medida',
  summary:
    'O ditado mede a sua voz antes de transcrever e avisa quando o microfone ' +
    'chega abafado — a causa mais comum de a transcrição trocar palavras.',
  highlights: [
    {
      title: 'Microfone abafado avisa',
      detail:
        'Voz sem agudos perde as consoantes e a transcrição adivinha palavras. ' +
        'O Nexus agora percebe isso e avisa uma vez, com o caminho: microfone ' +
        'USB ou adaptador que separa microfone e fone.',
    },
  ],
  fixes: [
    {
      title: 'Qualidade de cada ditado no voice.log',
      detail:
        'Fala em segundos, nível e agudos ficam registrados antes da ' +
        'transcrição: dá para saber se o erro veio do microfone ou do serviço.',
    },
  ],
};

export const RELEASE_07696: AppRelease = {
  version: '0.76.96',
  date: '2026-09-24',
  codename: 'Harness declarado',
  summary:
    'A tabela de harness por tarefa vira editável e ' +
    'persistida, o recibo do spawn declara o que foi decidido, a cota de ' +
    'conta aparece como janela honesta (missing ≠ zero) e o pane ganha ' +
    'identidade na sessão MCP. Warm pool retargeta pane em boot; tools/list ' +
    'perdida não deixa a sessão muda.',
  highlights: [
    {
      title: 'Harness por tarefa',
      detail:
        'nexus_harness: categorias × tipos com CLI, modelo, conta, effort e ' +
        'skills. Apply all-or-nothing (worker só propõe). O recibo do spawn ' +
        'traz ▸ harness / ▸ decisor / ▸ origens. Tabela persistida em settings.',
    },
    {
      title: 'Folga de conta visível',
      detail:
        'nexus_account_windows lista as janelas de cada conta com status ok / ' +
        'queimada / sem leitura e a idade da leitura. Missing nunca vira zero.',
    },
    {
      title: 'Identidade de pane no MCP',
      detail:
        'O wrapper Arms carrega callerPaneId só quando fala com a casa do ' +
        'pane — worker não herda orçamento de bootstrap; --descriptor alheio ' +
        'apaga a identidade (orquestrador externo).',
    },
  ],
  fixes: [
    {
      title: 'Warm pool com retarget',
      detail:
        'Pane já bootando é re-destinado à missão em vez de esperar cold-start. ' +
        'Sem startKey real nada entra no pool.',
    },
    {
      title: 'tools/list perdida não silencia a sessão',
      detail:
        'Listagens idempotentes repetem em transporte perdido; tools/call nunca ' +
        'repete. Placeholder de reconexão + recovery com list_changed.',
    },
    {
      title: 'Skills seguras',
      detail:
        'nexus_skills recusa path traversal no nome e só remove skill que o ' +
        'app embarca. Filtro declarado esconde skills pessoais no overlay ' +
        'Claude (skillOverrides: off).',
    },
  ],
};

export const RELEASE_07697: AppRelease = {
  version: '0.76.97',
  date: '2026-09-24',
  codename: 'Sessão renovada',
  summary:
    'Pane Claude de conta gerenciada não é mais recusado só porque o token de ' +
    'acesso venceu: a própria CLI renova e o Nexus prova a identidade antes de ' +
    'decidir. A cota das contas Claude volta a ler no Windows, as skills de papel ' +
    'embarcam de verdade e o warm pool só adota pane com o mesmo contrato.',
  highlights: [
    {
      title: 'Token vencido não é sessão perdida',
      detail:
        'Conta Claude parada há mais de 8 h abre pane de novo: a CLI renova no ' +
        'escopo da conta, e "Entre novamente" só aparece quando nem ela conseguiu.',
    },
    {
      title: 'Cota Claude no Windows',
      detail:
        'A sonda acha o claude pelo PATH e usa o claude.exe do shim do npm — ' +
        'cota das contas e renovação de fundo voltam a funcionar no Windows.',
    },
    {
      title: 'Skills de papel no pacote',
      detail:
        'oc-pilot, oc-builder, oc-scout e oc-conveyor saem do bundle, são ' +
        'espelhadas por CLI e nexus_skills instala a partir do cache do app.',
    },
  ],
  fixes: [
    {
      title: 'Warm pool honesto',
      detail:
        'Só adota um pane pré-aberto quando o pedido é o contrato com que ele ' +
        'nasceu; antes trocava só o rótulo de um processo do operador.',
    },
    {
      title: 'Arms do npm start',
      detail:
        'Pane da instância de desenvolvimento fala com ela, não com o app instalado.',
    },
    {
      title: 'Testes de scripts no Windows',
      detail:
        'Scripts .mjs/.cjs sempre em LF: quatro suítes voltam a carregar no Windows.',
    },
  ],
};

export const RELEASE_07698: AppRelease = {
  version: '0.76.98',
  date: '2026-09-24',
  codename: 'Linhagem única',
  summary:
    'A conta Claude que é o seu login nativo abre pane pelo próprio login, sem ' +
    'cópia gerenciada: o refresh token tem um dono só, e nem o pane nem a sonda ' +
    'de cota derrubam mais o Claude que você usa fora do Nexus. No Windows, o ' +
    'pane com login nativo renova direto no ~/.claude real.',
  highlights: [
    {
      title: 'Um dono só para o login nativo',
      detail:
        'A conta que é o login nativo não ganha mais cópia gerenciada: o pane usa ' +
        'o store nativo, como um pane sem conta, e a cota lê o perfil nativo. Duas ' +
        'cópias do mesmo refresh token não sobrevivem — quem renova primeiro mata a outra.',
    },
  ],
  fixes: [
    {
      title: 'Windows: renovação no arquivo real',
      detail:
        'A CLI regrava a credencial por rename; o link do overlay virava cópia e o ' +
        'Claude de fora caía. Agora o pane grava direto no ~/.claude real.',
    },
  ],
};

export const RELEASE_07699: AppRelease = {
  version: '0.76.99',
  date: '2026-09-25',
  codename: 'Jev no comando',
  summary:
    'Quando um agente seu abre um pane, quem escolhe CLI, modelo e esforço é o ' +
    'Jev — não mais o próprio agente. E todo pane seu aprende a dividir o ' +
    'trabalho em helpers em vez de fazer tudo sozinho.',
  highlights: [
    {
      title: 'O Jev escolhe a CLI dos helpers',
      detail:
        'O adapterId pedido pelo agente é ignorado e aparece em route.ignored no ' +
        'recibo; no empate vence a CLI que ainda não está aberta. Quando o Jev não ' +
        'responde, o pane abre pela heurística com o motivo no chip "sem Jev" e ' +
        'num aviso único.',
    },
    {
      title: 'Delegação automática',
      detail:
        'Todo pane nasce com a regra de delegar o que dá para dividir, e a cada ' +
        'mensagem longa o Jev avisa quando ela se divide em partes. Liga e desliga ' +
        'em Configurações › Equipes › Piloto automático Jev.',
    },
  ],
  fixes: [
    {
      title: 'Helpers na aba certa e sem cascata',
      detail:
        'O helper nasce na aba de quem pediu, writers entram em fila no checkout, ' +
        'o helper fecha sozinho no sucesso e o teto de panes recusa spawns pedidos ' +
        'por agentes.',
    },
  ],
};

export const RELEASE_076100: AppRelease = {
  version: '0.76.100',
  date: '2026-09-25',
  codename: 'Pasta reconhecida',
  summary:
    'No Windows, abrir um projeto com .nexus/project.json voltou a funcionar. ' +
    'O aviso "o manifesto não bate com este repositório" era um erro do git, ' +
    'não do manifesto.',
  highlights: [],
  fixes: [
    {
      title: 'Workspace com manifesto abre no Windows',
      detail:
        'O Nexus rodava o git com uma config vazia que o Git para Windows 2.55 ' +
        'recusa, e toda prova de linhagem falhava. Agora o git aceita a config ' +
        'e o projeto abre com a identidade do manifesto.',
    },
    {
      title: 'Mesma pasta, outra grafia',
      detail:
        'Caminho com outra caixa (c:\\users\\…) ou com nome curto (ADMINI~1) ' +
        'é reconhecido como a mesma pasta e abre o mesmo checkout, em vez de ' +
        'cair em quarentena.',
    },
  ],
};

export const RELEASE_076101: AppRelease = {
  version: '0.76.101',
  date: '2026-09-25',
  codename: 'Motor leve',
  summary:
    'O Nexus abre mais rápido, gasta menos RAM e CPU parado e não trava mais ' +
    'ao fechar um pane depois de reiniciar. Os panes "+" e os helpers ganham o ' +
    'motor que só as missões tinham: regra de design, ponytail e memória.',
  highlights: [
    {
      title: 'Boot e panes mais leves',
      detail:
        'O processo principal carrega 83% menos JavaScript no boot; voz, ONNX, ' +
        'AEC e o TypeScript da revisão carregam sob demanda, e abrir um pane ' +
        'prepara as skills em 6 ms quando o overlay já existe.',
    },
    {
      title: 'Panes "+" com o motor das missões',
      detail:
        'Pedido de interface recebe a regra de design do projeto (DESIGN.md ou a ' +
        'referência certa de ~/.design-references) e a Carta de Design contra a ' +
        '"cara de IA"; pedido de código lembra a skill ponytail. O Codex também ' +
        'recebe esse contexto.',
    },
    {
      title: 'Helpers que entregam',
      detail:
        'O helper acha o pane pai mesmo com a janela noutro workspace, nasce com ' +
        'a memória do projeto, só leva os servidores MCP que pediu e fecha ' +
        'sozinho só se ainda for a mesma sessão.',
    },
  ],
  fixes: [
    {
      title: 'Fechar pane depois de reiniciar não trava',
      detail:
        'O histórico de uso do Claude era relido inteiro e de forma síncrona ao ' +
        'retomar; agora a leitura é incremental. A atribuição de uso por conta ' +
        'deixou de ser apagada a cada reinício.',
    },
    {
      title: 'Menos CPU parado',
      detail:
        'Pet, failover e polls do renderer deixam de acordar à toa, e o feixe do ' +
        'pane ocupado só anima enquanto ele trabalha.',
    },
    {
      title: 'Codex sem doutrina repetida',
      detail:
        'As instruções do operador eram coladas em cada tool do Codex (cerca de ' +
        '37 mil tokens por pane); agora chegam uma vez por sessão.',
    },
    {
      title: 'Ponytail em YAML válido',
      detail: 'A skill voltou a carregar em CLIs com YAML estrito, como Kimi e OpenCode.',
    },
  ],
};

export const RELEASE_076104: AppRelease = {
  version: '0.76.104',
  date: '2026-09-26',
  codename: 'Missão até o fim',
  summary:
    'A missão só conclui quando o worker termina, e o pane de uma missão ' +
    'pronta volta a aceitar o seu ajuste. Inclui as melhorias da 0.76.102 ' +
    '(Mão livre) e da 0.76.103 (Diff sem confusão).',
  highlights: [
    {
      title: 'Missão só conclui quando o worker termina',
      detail:
        'A Via Rápida fechava a missão nos primeiros arquivos gravados, com o ' +
        'worker ainda trabalhando. Agora espera todo worker ativo parar.',
    },
    {
      title: 'Pane de missão pronta aceita o seu ajuste',
      detail:
        'Se a missão concluía com você noutro projeto, o pane voltava preso e ' +
        'recusava cada tecla. Agora mostra a sessão encerrada, e digitar no ' +
        'Maestro faz o mesmo que "Pedir um ajuste".',
    },
    {
      title: 'Barra lateral compacta',
      detail:
        'Início, Projeto, Quadro e Memória em duas colunas e "Abrir projeto" ' +
        'ao lado de "Novo pedido": sobra mais espaço para projetos e missões.',
    },
    {
      title: 'Cada aba nova com pasta própria',
      detail:
        'Abas criadas pelo + ganham pasta e branch próprias; os panes da mesma ' +
        'aba compartilham essa pasta. Abas antigas seguem na pasta do projeto.',
    },
    {
      title: 'Missão criada pelo pane abre workers',
      detail:
        'Nasce rodando, em Escolha livre de agentes e sem squad imposto. Antes ' +
        'cada worker era recusado e o agente pedia um despacho que o Quadro não ' +
        'oferece.',
    },
    {
      title: 'Missão parada tem saída',
      detail:
        'O próprio agente retoma a missão bloqueada, e toda recusa diz a ele a ' +
        'chamada exata para retomar ou encerrar, em vez de pedir a você um ' +
        'clique que não existe.',
    },
  ],
  fixes: [
    {
      title: 'Navegador do agente volta com o projeto',
      detail:
        'Depois de trocar de projeto e voltar, o agente perdia o acesso ao ' +
        'navegador que ele mesmo abriu. O navegador aberto por você também ' +
        'passa a servir aos seus agentes do mesmo projeto.',
    },
    {
      title: 'Nenhum vigia de terminal preso',
      detail:
        'Com uma janela do Ghostty ou do Terminal aberta, o processo que vigia ' +
        'cada pane podia ficar vivo para sempre gastando CPU depois que a CLI ' +
        'saía.',
    },
    {
      title: 'Diff de outro pane não aparece como edição do Claude',
      detail:
        'A comparação automática de arquivos antes e depois de comandos ' +
        'do terminal podia captar alterações de outro agente. Desativamos ' +
        'essa atribuição; os diffs de edições explícitas continuam.',
    },
    {
      title: 'Missão encerrada devolve o pane',
      detail:
        'Depois de uma missão falhar ou concluir, o pane que a criou seguia ' +
        'preso a ela, sem abrir panes nem criar outra missão. Agora volta a ser ' +
        'a sua mão na chamada seguinte.',
    },
  ],
};

export const RELEASE_076105: AppRelease = {
  version: '0.76.105',
  date: '2026-09-26',
  codename: 'Perfil e logins',
  summary:
    'O navegador ganha um Perfil Nexus com importação de sessões compatíveis ' +
    'do Chrome e busca na barra. A entrega também reúne as correções de panes, ' +
    'missões, isolamento de abas e escolha de esforço.',
  highlights: [
    {
      title: 'Seus logins no navegador do Nexus',
      detail:
        'Abra Perfil e logins, escolha um perfil do Chrome e marque os sites. ' +
        'No macOS, o Nexus importa as sessões compatíveis sem alterar o Chrome. ' +
        'Alguns sites podem exigir novo login; senhas e extensões não são importadas.',
    },
    {
      title: 'Compartilhamento escolhido por você',
      detail:
        'Use o Perfil Nexus ou mantenha uma aba isolada. Você pode permitir ' +
        'o perfil em novos navegadores dos agentes; abas já existentes conservam a escolha anterior.',
    },
    {
      title: 'Busca na barra de endereço',
      detail: 'Palavras como coolify viram pesquisa; endereços continuam abrindo diretamente.',
    },
    ...RELEASE_076104.highlights,
  ],
  fixes: [
    {
      title: 'Helpers na janela do seu pane',
      detail:
        'Outra janela aberta não faz o agente perder o destino de novos panes. ' +
        'O helper segue a janela do pane que fez o pedido e o projeto autorizado.',
    },
    {
      title: 'Alertas de provider com evidência',
      detail:
        'Mencionar internal_error no pedido ou citar Failure|rate-limit não ' +
        'dispara mais aviso de provider instável nem cooldown indevido.',
    },
    {
      title: 'Nova tentativa com horário atual',
      detail:
        'Quando ainda não há conta disponível, o aviso mostra o próximo horário real. ' +
        'Ao terminar as tentativas, deixa de prometer uma recuperação já vencida.',
    },
    ...RELEASE_076104.fixes,
  ],
};

export const RELEASE_076106: AppRelease = {
  version: '0.76.106',
  date: '2026-09-26',
  codename: 'Navegador em segundo plano',
  summary:
    'O navegador do agente continua vivo quando você troca de projeto: o ' +
    'agente segue usando-o e, na volta, a página está onde ficou.',
  highlights: [
    {
      title: 'Navegador que espera a sua volta',
      detail:
        'Ir a outro projeto não fecha mais o navegador. A página e o login ' +
        'continuam, o agente do projeto segue navegando, lendo e clicando, e ' +
        'na volta você encontra a página onde ela estiver, sem recarregar.',
    },
    {
      title: 'Screenshot com o navegador fora da tela',
      detail:
        'A captura de uma página carregada com o navegador escondido tenta de ' +
        'novo uma vez e sai com a página atual, também sob painéis abertos por cima.',
    },
  ],
  fixes: [
    {
      title: 'Fim do "unknown pane" ao trocar de projeto',
      detail:
        'O agente não perde mais o navegador do projeto enquanto você está ' +
        'noutro. Fechar o projeto ou tirá-lo da lista encerra os navegadores dele.',
    },
    {
      title: 'Mensagens que apontam o caminho',
      detail:
        'Com a janela noutro projeto, abrir um navegador novo explica que dá ' +
        'para seguir no navegador que o projeto já tem.',
    },
  ],
};

export const RELEASE_076107: AppRelease = {
  version: '0.76.107',
  date: '2026-09-26',
  codename: 'Abas no Windows',
  summary:
    'As abas com pasta própria também funcionam no Windows: a worktree de cada ' +
    'aba nova nasce num caminho que o Git para Windows aceita. Inclui tudo da ' +
    '0.76.103 à 0.76.106 (diff sem confusão, missão até o fim, perfil e logins, ' +
    'navegador em segundo plano).',
  highlights: [
    {
      title: 'Abas com pasta própria no Windows',
      detail:
        'Cada aba nova ganha a própria worktree também no Windows. Antes o Git ' +
        'recusava o caminho, longo demais, e nenhuma aba nova conseguia abrir a ' +
        'pasta; escritor isolado e missão planejada também passam a funcionar.',
    },
  ],
  fixes: [
    {
      title: 'Worktree com caminho curto no Windows',
      detail:
        'O Git para Windows recusa worktree com mais de ~215 caracteres, e o ' +
        'caminho montado pelo Nexus passava de 400. No Windows as worktrees ' +
        'moram agora numa raiz curta dentro dos dados do app; no macOS nada muda.',
    },
  ],
};

export const RELEASE_076108: AppRelease = {
  version: '0.76.108',
  date: '2026-09-27',
  codename: 'MiniMax Code',
  summary:
    'O MiniMax Code, a CLI oficial mcode, entra como provedor nativo: login, ' +
    'panes com os modelos oficiais, escolha pelo Jev e cota do Token Plan no ' +
    'Redline. Inclui a 0.76.107 (abas no Windows).',
  highlights: [
    {
      title: 'MiniMax Code como provedor nativo',
      detail:
        'O Nexus detecta, instala e atualiza a CLI mcode, mostra o login e abre ' +
        'panes com M3, M3.1 Flash Preview, M2.7 Highspeed e M2.7. O Jev pode ' +
        'escolhê-la e o benchmark roda o modo headless.',
    },
    {
      title: 'Cota do Token Plan no Redline',
      detail:
        'Com a Subscription Key da MiniMax, o Redline mostra quanto resta do ' +
        'Token Plan, consultando a API pública da sua região.',
    },
  ],
  fixes: [
    {
      title: 'Rota MiniMax via Claude atualizada',
      detail:
        'O upstream minimax do launcher usava endpoint e modelo fora de linha; ' +
        'agora usa os valores oficiais atuais.',
    },
  ],
};


export const RELEASE_076109: AppRelease = {
  version: '0.76.109',
  date: '2026-09-27',
  codename: 'Sessões estáveis',
  summary:
    'Corrige as trocas repetidas de conta causadas por mensagens antigas do ' +
    'próprio Nexus. Melhora a distribuição entre CLIs, o ditado técnico e o ' +
    'comportamento dos helpers.',
  highlights: [
    {
      title: 'Distribuição entre CLIs',
      detail:
        'Qualquer orquestrador pode distribuir tarefas comparáveis entre CLIs ' +
        'menos ocupadas. As 16 CLIs do catálogo têm candidatos, respeitando ' +
        'autenticação, modelos disponíveis e a política da missão.',
    },
    {
      title: 'Ditado com vocabulário técnico',
      detail:
        'Jev, Nexus, MiMo, Antigravity e outros nomes entram no contexto de ' +
        'reconhecimento. A reescrita preserva comandos e identificadores.',
    },
  ],
  fixes: [
    {
      title: 'Handoff antigo não encerra a sessão nova',
      detail:
        'O motivo da troca de conta recebe o mesmo tratamento do histórico. ' +
        'O detector reconhece também a linha antiga do handoff sem cabeçalho, ' +
        'preservando a detecção de erros novos do provider.',
    },
    {
      title: 'Helpers sem roubar foco',
      detail:
        'Abrir um worker mantém a aba e o foco do operador. Helpers com entrega ' +
        'concluída fecham mesmo quando a saída da sessão chega primeiro. ' +
        'O limite de panes volta a avisar por padrão também na delegação.',
    },
    {
      title: 'Cota do MiniMax pelo login',
      detail:
        'A conta nativa pode consultar o plano com o token de acesso vigente, ' +
        'sem renovar credenciais. Cota indisponível não é apresentada como ' +
        'ausência de conta.',
    },
    {
      title: 'Controles da barra alinhados',
      detail:
        'Configurações, chaves e voz usam a mesma altura e os controles ' +
        'existentes do sistema visual.',
    },
  ],
};


export const RELEASE_076110: AppRelease = {
  version: '0.76.110',
  date: '2026-09-27',
  codename: 'Nexus consciente',
  summary:
    'Portão de regressão, modelo de negócio no .context, code map ligado ao ' +
    'banco e memória automática do Jev: o agente lê o projeto antes de mexer ' +
    'e nada é aceito sem os testes impactados passarem. "+ Pane" com poder ' +
    'de missão e writers em paralelo. Failover no limite de sessão do Claude.',
  highlights: [
    {
      title: 'Portão de regressão',
      detail:
        'Toda entrega de escrita roda os testes impactados pelo diff (inclusive ' +
        'os alcançados pelo banco) no sandbox do writer. Falhou, volta ao ' +
        'agente. Nunca aprova o que não rodou: diff grande, pytest por arquivo ' +
        'e falha do git contam como não verificado.',
    },
    {
      title: 'Modelo de negócio e code map do banco',
      detail:
        'Fluxos, invariantes e tabelas extraídos do repo, atestados pelo Main e ' +
        'injetados em todo pane, inclusive em worktree. O code map liga código ' +
        'a tabelas, triggers e RLS, com blast radius até os testes.',
    },
    {
      title: '"+ Pane" com poder de missão',
      detail:
        'Writers em paralelo em worktrees isolados, missão livre sem squad, ' +
        'missão sob demanda no primeiro helper sem roubar a coroa, um ' +
        'orquestrador por aba que sobrevive ao reinício.',
    },
  ],
  fixes: [
    {
      title: 'Failover no limite de sessão do Claude',
      detail:
        '"You\'ve hit your session limit · resets 8:10pm", inclusive vindo de ' +
        'um claude -p filho, troca de conta em vez de prender o pane. O reset ' +
        'é lido no horário e fuso impressos; sem cota fresca a quarentena é ' +
        'curta, não uma supressão.',
    },
    {
      title: 'Navegador do Jev',
      detail:
        'nexus_browser_responsive com prazo por carga; uma navegação do ' +
        'operador durante a análise nunca é sobrescrita, nem na restauração.',
    },
    {
      title: 'Modelos com ids vivos',
      detail:
        'Grok 4.7 e Gemini 3.8 Flash no roteamento; 3.1 Pro sai do catálogo do ' +
        'agy; política de modelos de topo para revisão e alto risco; trava ' +
        'contra tabela velha.',
    },
    {
      title: 'Memória e panes',
      detail:
        'Memória do Jev sem teto diário; helper concluído não reabre como shell ' +
        'vazio; Enter chega no Codex; Kimi recebe o brief no "+ Pane"; ' +
        'nexus_mission_create atômico; GC de worktrees assíncrono.',
    },
  ],
};

export const RELEASE_076111: AppRelease = {
  version: '0.76.111',
  date: '2026-09-28',
  codename: 'Helpers variados',
  summary:
    'Os helpers que o seu pane do "+ Pane" abre voltam a se espalhar por CLIs ' +
    'diferentes e só em CLIs que falam com o Nexus — nada de três panes pretos ' +
    'no mesmo agente. Inclui tudo da 0.76.110 (Nexus consciente).',
  highlights: [
    {
      title: 'Helpers em CLIs diferentes',
      detail:
        'O roteamento passa a enxergar os helpers que já estão abertos na missão ' +
        'e distribui os próximos entre outras CLIs, em vez de repetir a mesma.',
    },
  ],
  fixes: [
    {
      title: 'Sem três panes pretos no AGY',
      detail:
        'Na 0.76.110 os helpers do "+ Pane" podiam cair todos no AGY, que no modo ' +
        'one-shot não mostra nada até terminar. Eles voltam a usar só CLIs com o ' +
        'MCP do Nexus, como antes da missão da aba.',
    },
  ],
};

export const RELEASE_076112: AppRelease = {
  version: '0.76.112',
  date: '2026-09-28',
  codename: 'Smoke test',
  summary:
    'Pendências do 0.76.110 e o que o smoke test no app instalado achou: rodapé ' +
    'da barra lateral no lugar, revisão de código roteada para modelo de topo, ' +
    'navegador do Jev emulando de verdade, Kimi abrindo com sessão e briefing, e ' +
    'o portão de regressão rodando com o Node do projeto.',
  highlights: [
    {
      title: 'Rodapé da barra lateral no lugar',
      detail:
        'Em Configurações a lista e as utilidades somem e o grid puxava o rodapé ' +
        'para o meio da barra, com um vazio embaixo. Cada faixa tem posição fixa; ' +
        'provado no Chrome headless (botão a 9 px do fundo, antes 328 px).',
    },
    {
      title: 'Revisão de código vai para modelo de topo',
      detail:
        '"Revisão sênior, somente leitura" era classificada como trivial e ia ' +
        'para o grok em esforço baixo. Revisão de código tem piso hard também ' +
        'sobre o tier do Jev, e o modelo e o esforço citados no texto ("com o ' +
        'GPT-6 Astra, esforço xhigh") são honrados quando a CLI está instalada, ' +
        'sem furar circuit breaker e com guarda de negação.',
    },
    {
      title: 'Kimi abre com sessão e com o briefing',
      detail:
        'A preferência antiga kimi-k2.7 ia no --model e o Kimi Code recusava a ' +
        'sessão inteira; os ids antigos migram para os aliases kimi-code/*, o ' +
        'config.toml vira fonte de descoberta e alias fora dele não viaja. O ' +
        'briefing do helper pendente deixa de morrer na autoridade da chamada ' +
        'MCP já respondida.',
    },
  ],
  fixes: [
    {
      title: 'Navegador do Jev emula de verdade',
      detail:
        'A emulação de dispositivo morria na navegação e nexus_browser_responsive ' +
        'media a mesma largura nos três dispositivos. Reaplicada no commit de cada ' +
        'navegação; a auditoria espera o relayout.',
    },
    {
      title: 'Portão de regressão com o Node do projeto',
      detail:
        'O runner herdava o Node 26 do PATH do app e reprovava trabalho são com ' +
        'ERR_DLOPEN_FAILED do better-sqlite3. O Node pinado em package.json ' +
        '(Homebrew node@N ou nvm) vai na frente do PATH.',
    },
  ],
};

export const RELEASE_076114: AppRelease = {
  version: '0.76.114',
  date: '2026-09-28',
  codename: 'CLIs no canal certo',
  summary:
    'Atualizar CLI reconhece o Codex instalado via npm com atalho externo e o ' +
    'launcher nativo atual do Grok. No macOS, inclui também as correções de ' +
    'pane e missão publicadas no Windows em 0.76.113.',
  highlights: [
    {
      title: 'Codex atualiza a instalação usada pelo pane',
      detail:
        'O atalho externo do Codex é aceito quando resolve para o binário do ' +
        'mesmo prefixo npm que será atualizado. A confirmação mostra o comando.',
    },
    {
      title: 'Grok reconhece o launcher nativo',
      detail:
        'O binário versionado em ~/.grok/downloads agora é associado ao ' +
        'launcher ~/.grok/bin/grok para a atualização manual e automática.',
    },
    {
      title: 'Correções do Windows chegam ao macOS',
      detail:
        'Inclui a 0.76.113: pane encerra corretamente no Windows, missão ' +
        'aguarda respostas pendentes e Retomar recupera a conversa da aba.',
    },
  ],
  fixes: [],
};

export const RELEASE_076115: AppRelease = {
  version: '0.76.115',
  date: '2026-09-28',
  codename: 'Worker que responde',
  summary:
    'A missão da aba volta a abrir workers só em CLIs que falam com o Nexus, ' +
    'também depois de retomada, e perguntar a um pane one-shot responde na ' +
    'hora em vez de parecer infraestrutura quebrada. Inclui a 0.76.114 (CLIs ' +
    'no canal certo).',
  highlights: [
    {
      title: 'Missão da aba sem worker mudo',
      detail:
        'Depois do "Retomar", o orquestrador da aba pedia rota e recebia o AGY, ' +
        'que no modo one-shot não mostra nada até terminar. A regra de só abrir ' +
        'helper em CLI com o MCP do Nexus agora vale para a missão inteira, não ' +
        'só para o pane original.',
    },
    {
      title: 'Pergunta a pane one-shot responde na hora',
      detail:
        'nexus_pane_ask esperava o prazo inteiro e voltava vazio num pane AGY ' +
        'que estava trabalhando. Agora responde na hora que o pane é one-shot e ' +
        'que a entrega chega quando ele terminar; nexus_pane_write avisa o mesmo.',
    },
  ],
  fixes: [],
};

export const RELEASE_076116: AppRelease = {
  version: '0.76.116',
  date: '2026-09-28',
  codename: 'Conversa preservada',
  summary:
    'No Windows, fechar ou retomar um pane apagava as conversas guardadas do ' +
    'projeto — o "Retomar" nunca achava a conversa. A limpeza agora remove só ' +
    'os atalhos, e cada retomada da missão da aba continua da conversa mais ' +
    'recente, com o modelo do seu pane.',
  highlights: [
    {
      title: 'Conversas não somem mais no Windows',
      detail:
        'O runtime do Electron 43 atravessa junctions ao apagar uma pasta. A ' +
        'pasta temporária de cada pane liga as conversas guardadas por junction, ' +
        'então fechar o pane apagava todas as conversas do projeto. Toda ' +
        'remoção do Nexus tira os atalhos antes de apagar.',
    },
    {
      title: 'Retomar continua da conversa certa',
      detail:
        'Cada "Retomar" da missão da aba voltava ao mesmo pane antigo, com o ' +
        'modelo padrão da CLI. A missão agora acompanha o pane retomado e usa o ' +
        'modelo do pane que você abriu.',
    },
  ],
  fixes: [],
};

export const RELEASE_076117: AppRelease = {
  version: '0.76.117',
  date: '2026-09-28',
  codename: 'Missão no seu ritmo',
  summary:
    'A missão da aba espera o orquestrador concluir o pedido inteiro. ' +
    'A manutenção das CLIs cede à sua atividade, e a memória acompanha a tarefa.',
  highlights: [
    {
      title: 'Pausar não encerra a missão',
      detail:
        'Entregas dos helpers e pausas entre turnos deixam de fechar a missão da aba. ' +
        'O orquestrador solicita a conclusão quando terminar o pedido, incluindo a release se solicitada.',
    },
    {
      title: 'Manutenção das CLIs espera você parar',
      detail:
        'Atualizações automáticas começam após 60 segundos de inatividade. ' +
        'O pane deixa de esperar a descoberta das outras CLIs depois de seu launcher ser validado.',
    },
    {
      title: 'Memória relevante para cada tarefa',
      detail:
        'A busca considera a tarefa e seus símbolos. Recibos sem aprendizado não ocupam o resumo, ' +
        'e o contexto continua disponível quando seu pane assume uma missão.',
    },
  ],
  fixes: [
    {
      title: 'Retomada e verificações mais consistentes',
      detail:
        'Retomar preserva missões paralelas e a orientação de delegação. ' +
        'Worktrees usam o modelo de negócio atestado também na checagem de regressões.',
    },
  ],
};

export const RELEASE_076118: AppRelease = {
  version: '0.76.118',
  date: '2026-09-28',
  codename: 'Retoma e continua',
  summary:
    'Retomar a missão da aba volta a continuar o trabalho: a conversa abre com ' +
    'um resumo do que estava sendo feito, sem ficar presa num "Pedir um ajuste" ' +
    'antigo. Inclui a 0.76.117 (Missão no seu ritmo).',
  highlights: [
    {
      title: 'Retomar continua o trabalho',
      detail:
        'Um "Pedir um ajuste" feito horas antes fazia toda retomada abrir com ' +
        '"AGUARDE O OPERADOR" e o orquestrador parava. Agora só um ajuste recém-' +
        'pedido faz esperar; nos outros casos ele resume onde parou e segue.',
    },
  ],
  fixes: [],
};

export const RELEASE_076119: AppRelease = {
  version: '0.76.119',
  date: '2026-09-28',
  codename: 'Codex na worktree',
  summary:
    'Helpers Codex soltos em worktree isolada voltam a trabalhar no Windows: ' +
    'a tela de acesso à pasta do Codex é respondida e as ferramentas dele ' +
    'executam. Inclui a 0.76.118.',
  highlights: [
    {
      title: 'Helper Codex em worktree trabalha no Windows',
      detail:
        'O Codex 0.157 pergunta "Folder access" antes de abrir uma pasta ' +
        'restrita, e o perfil do Nexus desligava o executor que ele usa para ' +
        'rodar comandos: o helper morria em segundos ou não fazia nada. A tela ' +
        'agora é respondida com "Open restricted" e o executor fica ligado no Windows.',
    },
  ],
  fixes: [],
};

export const RELEASE_076120: AppRelease = {
  version: '0.76.120',
  date: '2026-09-28',
  codename: 'Instalação e tarefas recuperadas',
  summary:
    'O Claude volta a ser encontrado com atalho nativo quebrado, o Kimi espera o campo de mensagem ' +
    'antes de receber a tarefa e a retomada preserva a conversa. Inclui as correções anteriores da missão da aba.',
  highlights: [
    {
      title: 'Claude reconhecido no macOS',
      detail:
        'A busca encontra instalações nativas válidas mesmo sem o atalho. ' +
        'O Nexus prefere o instalador nativo e verifica a CLI antes de confirmar sucesso.',
    },
    {
      title: 'Briefing chega ao Kimi',
      detail:
        'A tarefa aguarda o campo de mensagem ficar pronto e não se perde no menu de migração. ' +
        'Suas conversas não são migradas automaticamente.',
    },
  ],
  fixes: [
    {
      title: 'Retomada, limpeza e memória revisadas',
      detail:
        'Falhas ao examinar pastas interrompem a limpeza. Vínculos de panes são reconciliados ' +
        'antes da próxima retomada, e resumos úteis sobrevivem a listas longas de evidências.',
    },
  ],
};

export const RELEASE_076121: AppRelease = {
  version: '0.76.121',
  date: '2026-09-28',
  codename: 'Brief inteiro',
  summary:
    'No Windows os helpers voltam a receber a tarefa inteira: o Nexus abre o ' +
    'executável real das CLIs instaladas pelo npm, sem passar pelo cmd.exe, ' +
    'que cortava o brief na primeira linha. Inclui a 0.76.120.',
  highlights: [
    {
      title: 'Helper recebe a tarefa inteira no Windows',
      detail:
        'Com o Claude instalado pelo npm, o brief do helper passava pelo atalho ' +
        'claude.cmd e o cmd.exe cortava tudo depois da primeira linha — o ' +
        'helper recebia só "## Nexus execution authority" ou morria. Agora o ' +
        'Nexus abre o executável do pacote direto, para toda CLI embutida.',
    },
  ],
  fixes: [
    {
      title: 'Brief longo não derruba o helper',
      detail:
        'Brief grande demais para a linha de comando do Windows (32.767 ' +
        'caracteres) ia no argv e o helper morria com "Linha de comando muito ' +
        'longa". Acima do limite o brief agora é colado depois do boot.',
    },
  ],
};

export const RELEASE_076122: AppRelease = {
  version: '0.76.122',
  date: '2026-09-28',
  codename: 'Sonnet 5.5 e Jev com medição',
  summary:
    'Sonnet 5.5 chega ao catálogo e ao roteamento. O Jev reúne decisões numa consulta, ' +
    'reutiliza leituras iguais e mostra as otimizações observadas. Inclui as correções da 0.76.121.',
  highlights: [
    {
      title: 'Sonnet 5.5 oficial',
      detail:
        'Disponível no Claude e no roteamento do Nexus, com contexto de 1 milhão de tokens, ' +
        'preço próprio e acompanhamento de uso e cotas. Sonnet 5 continua disponível.',
    },
    {
      title: 'Jev com menos consultas repetidas',
      detail:
        'Classificação e sugestão de skill usam um único lote. Leituras iguais do navegador ' +
        'reutilizam o julgamento por até 15 segundos; uma pergunta de foco seleciona trechos relevantes.',
    },
    {
      title: 'Otimização medida',
      detail:
        'As configurações mostram consultas evitadas, triagens resolvidas sem LLM e volume de texto ' +
        'selecionado. Esses números não são estimativas de tokens faturados economizados.',
    },
  ],
  fixes: [
    {
      title: 'Trechos preservados na leitura compacta',
      detail:
        'O formato compacto mantém os trechos escolhidos para a pergunta, inclusive os do fim da página. ' +
        'Quando o julgamento não é suficiente, a leitura preserva o texto completo.',
    },
  ],
};

export const RELEASE_076123: AppRelease = {
  version: '0.76.123',
  date: '2026-09-28',
  codename: 'Helpers variados de novo',
  summary:
    'Helpers no Windows recebem o brief inteiro em qualquer caso, e quando o ' +
    'orquestrador fixa a mesma CLI para vários helpers o recibo sugere deixar ' +
    'o Jev distribuir o trabalho. Inclui a 0.76.122 (Sonnet 5.5 e Jev com medição).',
  highlights: [
    {
      title: 'Aviso de diversidade no spawn',
      detail:
        'Depois de uma falha já corrigida, o orquestrador passava a fixar Claude ' +
        'em todo helper e o Jev nunca mais roteava. A escolha explícita continua ' +
        'valendo, mas com dois ou mais helpers vivos na mesma CLI o recibo diz ' +
        'para omitir adapterId e deixar o Nexus rotear.',
    },
    {
      title: 'Brief inteiro no Windows, sem exceção',
      detail:
        'O Nexus mede a linha de comando final (executável, flags, config e ' +
        'brief) e, se a CLI ainda cairia num atalho .cmd ou a linha passaria do ' +
        'limite do Windows, entrega o brief colado depois do boot.',
    },
  ],
  fixes: [],
};

export const RELEASE_076124: AppRelease = {
  version: '0.76.124',
  date: '2026-09-28',
  codename: 'Todas as LLMs',
  summary:
    'Os panes no Windows param de misturar telas antigas com novas, e a missão ' +
    'da aba passa a distribuir os helpers entre as LLMs prontas em vez de ' +
    'empilhar tudo numa só. Inclui a 0.76.123.',
  highlights: [
    {
      title: 'Panes sem texto sobreposto no Windows',
      detail:
        'O terminal não sabia que rodava sobre o ConPTY do Windows: ao ganhar ' +
        'linhas puxava o histórico enquanto o ConPTY repintava por cima, e as ' +
        'TUIs apareciam com telas antigas misturadas. Agora o xterm liga as ' +
        'regras de ConPTY com o build do Windows.',
    },
    {
      title: 'Helpers distribuídos entre as LLMs',
      detail:
        'O orquestrador fixava Claude em todo helper. Na missão da aba, uma CLI ' +
        'que já tem dois ou mais helpers vivos é redistribuída pelo roteamento ' +
        '(Jev + tabela), salvo quando você pediu aquela CLI.',
    },
  ],
  fixes: [],
};

export const RELEASE_076125: AppRelease = {
  version: '0.76.125',
  date: '2026-09-28',
  codename: 'Frota de contas',
  summary:
    'A troca automática de conta aguenta de 1 a 100 contas por LLM, cada pane ' +
    'AGY no Windows passa a usar a conta escolhida, o MiniMax entra na ' +
    'orquestração com o MCP do Nexus e o roteador escolhe modelos pelos ' +
    'benchmarks oficiais dos fabricantes.',
  highlights: [
    {
      title: 'Troca de conta com frotas grandes',
      detail:
        'Quando uma conta bate o limite, a próxima entra mesmo com dezenas de ' +
        'contas: contas expiradas não travam mais a rotação das outras, a troca ' +
        'percorre a frota até achar uma conta pronta e a cota é sondada no ' +
        'máximo seis contas por vez.',
    },
    {
      title: 'Conta AGY por pane no Windows',
      detail:
        'O AGY do Windows guarda o login numa vaga única do Gerenciador de ' +
        'Credenciais. O Nexus agora salva essa sessão como conta e, antes de ' +
        'abrir cada pane, coloca nela a conta escolhida — sem perder a que ' +
        'estava lá.',
    },
    {
      title: 'MiniMax Code orquestrado',
      detail:
        'O pane do MiniMax ganha as ferramentas do Nexus (handoff, panes, ' +
        'missão) por uma ponte registrada no MCP do próprio MiniMax, e passa a ' +
        'receber helpers da missão da aba.',
    },
    {
      title: 'Roteamento pelos benchmarks oficiais',
      detail:
        'Sem avaliação própria do Nexus, cada modelo compete pelos números que ' +
        'o fabricante publicou (DeepSWE, Terminal-Bench 2.1, SWE-bench ' +
        'Verified), com fonte — MiMo, DeepSeek, Muse e MiniMax deixam de perder ' +
        'por falta de nota.',
    },
  ],
  fixes: [],
};

export const RELEASE_076126: AppRelease = {
  version: '0.76.126',
  date: '2026-09-29',
  codename: 'Volta inteira',
  summary:
    'Missões em dois projetos ao mesmo tempo voltam inteiras: o Maestro Codex retoma a ' +
    'mesma conversa, a remontagem automática não encerra um Maestro vivo e os panes ' +
    'redesenham a tela ao voltar. O ditado mostra o andamento no pane. Inclui a 0.76.125.',
  highlights: [
    {
      title: 'Conversa do Codex retomada',
      detail:
        'Religar, acordar ou retomar um pane Codex volta à mesma conversa, com a conta do pane. ' +
        'Conversas iniciadas antes desta versão ainda abrem uma nova.',
    },
    {
      title: 'Maestro vivo não é substituído',
      detail:
        'Religamentos automáticos adotam o Maestro que está vivo em vez de encerrá-lo para ' +
        'abrir outro. Só o Retomar do operador substitui o Maestro.',
    },
    {
      title: 'Ditado com andamento no pane',
      detail:
        'Ao soltar o Espaço, o pane mostra "Transcrevendo áudio…" com o tempo decorrido até o ' +
        'texto chegar, ou avisa que a transcrição falhou.',
    },
  ],
  fixes: [
    {
      title: 'Pane de helper encerrado aponta o Maestro',
      detail:
        'A tecla num helper encerrado não promete religar nada: com o Maestro vivo, o pane ' +
        'indica onde escrever. A dica de tentativa em curso aparece no máximo uma vez a cada 15 segundos.',
    },
    {
      title: 'Tela da TUI volta inteira',
      detail:
        'Depois de saída descartada ou de hibernação, o pane pede à CLI para redesenhar a tela. ' +
        'No macOS, voltar de outro aplicativo repinta os panes visíveis.',
    },
    {
      title: 'Diagnóstico de mortes e aberturas lentas',
      detail:
        'O trace do Nexus registra como cada sessão de agente terminou e quanto cada etapa da ' +
        'abertura de um pane levou.',
    },
  ],
};

export const RELEASE_076127: AppRelease = {
  version: '0.76.127',
  date: '2026-09-29',
  codename: 'Troca de projeto sem perder agentes',
  summary:
    'Trocar de workspace não encerra mais os agentes das missões, e o pane de um agente ' +
    'que parou fora da tela volta a aceitar Retomar e Reiniciar. Inclui a 0.76.126.',
  highlights: [
    {
      title: 'Troca de projeto sem matar agentes',
      detail:
        'Sair e voltar de um workspace mantém o Maestro e os helpers da missão rodando, ' +
        'inclusive quando o plano da missão foi revisado.',
    },
  ],
  fixes: [
    {
      title: 'Pane de agente parado volta a responder',
      detail:
        'Quando um agente para com o projeto fora da tela, o pane mostra que ele parou em vez ' +
        'de recusar cada tecla, e Retomar e Reiniciar funcionam.',
    },
  ],
};

export const RELEASE_076128: AppRelease = {
  version: '0.76.128',
  date: '2026-09-29',
  codename: 'Todas as LLMs pelo benchmark oficial',
  summary:
    'A rota das tarefas usa o benchmark oficial de cada LLM e espalha o trabalho por todas ' +
    'as CLIs prontas — MiMo, MiniMax, Kimi, GLM, Grok, Gemini, Codex, Claude e as demais. ' +
    'Inclui a 0.76.127.',
  highlights: [
    {
      title: 'Todas as CLIs entram na rota',
      detail:
        'Modelos sem benchmark publicado entram com nota neutra em vez de ficar por último, e a ' +
        'diversidade da missão distribui as tarefas entre todas as CLIs disponíveis.',
    },
    {
      title: 'Benchmark oficial decide',
      detail:
        'A nota publicada pelo fabricante pesa mais que a ordem fixa da tabela. A preferência ' +
        'do Maestro só desempata, e excluir uma CLI saudável é ignorado e avisado.',
    },
  ],
  fixes: [],
};

export const RELEASE_076129: AppRelease = {
  version: '0.76.129',
  date: '2026-09-29',
  codename: 'Catálogo em dia',
  summary:
    'Um catálogo de modelos antigo guardado na máquina deixa de passar por ' +
    'cima do catálogo que a versão instalada traz — custo e modelos voltam a ' +
    'ser os atuais e a rota para de favorecer uma LLM por dado velho. Inclui ' +
    'a 0.76.128.',
  highlights: [
    {
      title: 'Rota com o catálogo atual',
      detail:
        'A cópia local do catálogo, semeada numa versão antiga, sobrescrevia o ' +
        'catálogo do app: o Gemini 3.8 Flash aparecia como barato e puxava a ' +
        'rota para o AGY. Cópia mais velha que o app agora só acrescenta ' +
        'modelos que o app não conhece.',
    },
  ],
  fixes: [],
};

export const RELEASE_076130: AppRelease = {
  version: '0.76.130',
  date: '2026-09-29',
  codename: 'Maestro religado lidera de novo',
  summary:
    'Quando o Nexus religa o Maestro no mesmo pane, a missão volta a coordenar por ele — sem ' +
    'ficar presa em "o orquestrador reiniciou e a missão não o reconhece". Inclui a 0.76.129.',
  highlights: [
    {
      title: 'Religar a missão ao Maestro',
      detail:
        'O religamento do Maestro religa a missão sozinho, e o Quadro oferece o botão para ' +
        'missões que já ficaram nesse estado.',
    },
  ],
  fixes: [],
};

export const RELEASE_076131: AppRelease = {
  version: '0.76.131',
  date: '2026-09-29',
  codename: 'Pane órfão volta a abrir',
  summary:
    'Um pane ligado no layout a uma missão que não existe mais volta a abrir em Reiniciar e ' +
    'Retomar, em vez de falhar para sempre. Inclui a 0.76.130.',
  highlights: [
    {
      title: 'Pane com missão órfã volta a abrir',
      detail:
        'O Nexus usa a missão gravada por ele para aquele pane; sem registro, o pane abre como ' +
        'pane comum. Missão real diferente continua recusada.',
    },
  ],
  fixes: [],
};

export const RELEASE_076132: AppRelease = {
  version: '0.76.132',
  date: '2026-09-29',
  codename: 'Equipe da missão da aba no Quadro',
  summary:
    'O Quadro de uma missão aberta a partir de um pane mostra o Maestro e os helpers dela, em ' +
    'vez de dizer que não conseguiu carregar a equipe. Inclui a 0.76.131.',
  highlights: [
    {
      title: 'Equipe da missão da aba no Quadro',
      detail:
        'O grafo monta a equipe pelos panes da missão: o Maestro e cada helper, com o estado de ' +
        'cada um e o atalho para o terminal.',
    },
  ],
  fixes: [],
};

export const RELEASE_076133: AppRelease = {
  version: '0.76.133',
  date: '2026-09-29',
  codename: 'Orientação chega ao Maestro da aba',
  summary:
    'Orientações enviadas pelo Quadro de uma missão aberta a partir de um pane chegam ao ' +
    'Maestro, em vez de falhar por falta de recibo de início. Inclui a 0.76.132.',
  highlights: [
    {
      title: 'Orientação pelo Quadro na missão da aba',
      detail:
        'A caixa "Enviar orientação" entrega a mensagem ao Maestro da missão da aba; as ' +
        'checagens de sessão viva e autoridade continuam valendo.',
    },
  ],
  fixes: [],
};

export const RELEASE_076134: AppRelease = {
  version: '0.76.134',
  date: '2026-09-29',
  codename: 'Revisão completa',
  summary:
    'Revisão de todas as mudanças desde a 0.76.126, com a suíte inteira de testes verde. ' +
    'Orientar um agente específico da missão da aba volta a funcionar, e as recusas da ' +
    'orientação aparecem em português. Inclui a 0.76.133.',
  highlights: [
    {
      title: 'Orientação a um agente da missão da aba',
      detail:
        'Escolher um helper no seletor do Quadro manda a orientação ao Maestro com a indicação ' +
        'do pane a repassar.',
    },
  ],
  fixes: [
    {
      title: 'Recusas da orientação em português',
      detail:
        'Briefing em curso, Maestro parado, terminal não reconhecido ou agente fora da missão ' +
        'aparecem com o que fazer, em vez da mensagem técnica em inglês.',
    },
  ],
};

export const RELEASE_076135: AppRelease = {
  version: '0.76.135',
  date: '2026-09-29',
  codename: 'Todas as LLMs de verdade, com o Jev enxugando',
  summary:
    'A CLI fixada pelo agente vira preferência e a rota decide pelo benchmark; o Jev ' +
    'classifica a tarefa pelo trabalho real, resume o que o Maestro lê e entrega ' +
    'continuações a helpers parados. Inclui a 0.76.134.',
  highlights: [
    {
      title: 'Todas as LLMs de verdade',
      detail:
        'Sem pedido seu, a CLI fixada pelo agente é só preferência; a CLI que você digitou no ' +
        'pane continua valendo.',
    },
    {
      title: 'Rota mais barata',
      detail:
        'O Jev classifica a tarefa pelo trabalho real e, no tier caro, o modelo barato com ' +
        'nota próxima vence.',
    },
    {
      title: 'Maestro lê menos',
      detail:
        'Leitura de pane resumida com o estado julgado pelo Jev, e a lista de handoffs sem ' +
        'repetir entregas antigas.',
    },
    {
      title: 'Helper parado recebe a continuação',
      detail:
        'Tarefa relacionada vai para o helper parado da mesma CLI, sem abrir pane novo.',
    },
  ],
  fixes: [],
};

export const RELEASE_076136: AppRelease = {
  version: '0.76.136',
  date: '2026-09-29',
  codename: 'Agente trabalhando não cai',
  summary:
    'A missão deixa de ser bloqueada — e de derrubar todos os agentes — ' +
    'quando o Maestro está no meio de um comando longo ou um worker está ' +
    'trabalhando sem ter entregue ainda. Inclui a 0.76.135.',
  highlights: [
    {
      title: 'Agente trabalhando não é missão parada',
      detail:
        'O vigia de missão parada olhava só a saída do terminal: um comando ' +
        'longo do Maestro ou um worker produzindo sem handoff viravam "60 ' +
        'min sem progresso", a missão ia para "Precisa de reparo" e todos os ' +
        'panes caíam. Agora ele usa o status real das CLIs.',
    },
  ],
  fixes: [],
};

export const RELEASE_076137: AppRelease = {
  version: '0.76.137',
  date: '2026-09-29',
  codename: 'Sem clique, sem relogin',
  summary:
    'Os panes não param mais em diálogos de início, o Grok para de pedir ' +
    'login todo dia no Windows, o Maestro não consegue mais prender os ' +
    'helpers numa LLM só e o modelo recusado pelo provider sai do roteamento.',
  highlights: [
    {
      title: 'Panes sem clique no início',
      detail:
        'O "Trust this folder?" do Codex nos seus panes e o aviso de Bypass ' +
        'do Claude Code novo (sem números) são respondidos sozinhos. Workers ' +
        'governados da missão continuam com a pasta restrita.',
    },
    {
      title: 'Grok mantém o login no Windows',
      detail:
        'O token renovado dentro do pane voltava só no fechamento — e se ' +
        'perdia. Agora cada renovação volta na hora ao perfil real, só se ' +
        'for da mesma conta e mais nova.',
    },
    {
      title: 'Todas as LLMs de verdade',
      detail:
        'O Maestro marcava sozinho "escolha do operador" para abrir tudo em ' +
        'Claude. Essa marca agora só vale quando você nomeou a CLI (no pane ou ' +
        'pelo Quadro); sem isso o Nexus distribui pela tarefa.',
    },
    {
      title: 'Modelo recusado sai da rota',
      detail:
        'Helper que caiu em "Model access is disabled" (OpenCode Zen) troca ' +
        'de modelo, e o roteador deixa esse modelo de fora por 12 horas.',
    },
  ],
  fixes: [],
};

export const RELEASE_076138: AppRelease = {
  version: '0.76.138',
  date: '2026-09-29',
  codename: 'Várias missões lado a lado',
  summary:
    'O Maestro que espera o seu pedido aparece como "Aguardando", não mais como ' +
    '"Dormindo"; a aba com missão dormindo aceita uma missão nova; e o segundo ' +
    'orquestrador da aba pergunta se começa missão própria ou assume a liderança. ' +
    'Os writers voltam a entregar em projeto com a config do Jest fora da raiz. ' +
    'Inclui a 0.76.137.',
  highlights: [
    {
      title: 'Writers voltam a entregar',
      detail:
        'O portão de regressão rodava o Jest sem a config do projeto: em projeto com a ' +
        'config em tests/jest.config.js, toda entrega de writer era recusada duas vezes ' +
        'por dezenas de testes que nem chegavam a ser lidos. Agora ele usa a config dos ' +
        'scripts, e arquivo que não carrega fora do diff vira "não verificado".',
    },
    {
      title: 'Aguardando, não Dormindo',
      detail:
        'O Maestro vivo parado no prompt aparece como "Aguardando" na barra lateral, ' +
        'no Quadro e nas abas, com a orientação pelo Quadro liberada. "Dormindo" fica ' +
        'só para missão sem processo.',
    },
    {
      title: 'Aba com missão dormindo aceita outra',
      detail:
        '"Tornar orquestrador" numa aba cuja missão dorme ou parou cria uma missão nova, ' +
        'em vez de dar erro. A aba volta a oferecer "Criar missão desta aba" e a fechar.',
    },
    {
      title: 'O segundo orquestrador pergunta',
      detail:
        'Numa aba com missão rodando, "Tornar orquestrador" em outro pane pergunta se ' +
        'ele começa uma missão própria, em paralelo, ou assume a liderança.',
    },
  ],
  fixes: [],
};

export const RELEASE_076139: AppRelease = {
  version: '0.76.139',
  date: '2026-09-29',
  codename: 'O Nexus orquestra sozinho',
  summary:
    'Em Autopilot, o pane que recebe um pedido que se divide vira orquestrador sozinho e ' +
    'abre os helpers; revisões e trabalho crítico vão para um modelo de topo. ' +
    'Inclui a 0.76.138.',
  highlights: [
    {
      title: 'Orquestração automática no Autopilot',
      detail:
        'Pedido que se divide em partes independentes (por exemplo, a mesma mudança no app ' +
        'nativo e no PWA) torna o pane orquestrador de uma missão e ele abre um helper por ' +
        'parte. No Hardened o Nexus só sugere.',
    },
    {
      title: 'Revisão com modelo de topo',
      detail:
        'Revisão de código e trabalho crítico (segurança, pagamento, dados) vão para GPT-6 ' +
        'Astra, Claude Fable 5.1 ou Opus 5.5, de qualquer CLI disponível. O resto segue ' +
        'distribuído entre todas as LLMs, com a variante certa de cada uma (Flash no ' +
        'rotineiro, Pro no difícil).',
    },
    {
      title: 'Electron 43.7.4',
      detail:
        'O app passa a rodar no Electron 43.7.4, que corrige quatro falhas de segurança ' +
        'altas do 43.0.0 (sandbox, leitura entre origens e preload).',
    },
  ],
  fixes: [],
};

export const RELEASE_076140: AppRelease = {
  version: '0.76.140',
  date: '2026-09-29',
  codename: 'GPT-6.1 Sol',
  summary:
    'O GPT-6.1 Sol, lançado hoje pela OpenAI, vira o modelo de trabalho do Codex no Nexus: ' +
    'mesmo preço do GPT-6 Sol e quase o nível do Astra. Inclui a 0.76.139.',
  highlights: [
    {
      title: 'GPT-6.1 Sol no Codex',
      detail:
        'Panes, squads e a rota automática do Codex passam a usar o GPT-6.1 Sol. Ele custa o ' +
        'mesmo que o GPT-6 Sol e empata com o Astra no DeepSWE, a um quinto do preço. Codex ' +
        'que ainda não lista o 6.1 continua no GPT-6 Sol.',
    },
  ],
  fixes: [],
};

export const RELEASE_076141: AppRelease = {
  version: '0.76.141',
  date: '2026-09-29',
  codename: 'Sem piscar',
  summary:
    'Os cabeçalhos dos panes param de piscar no Windows, o Codex para de travar ' +
    'na revisão de hooks e o Nexus Shot volta a entregar capturas no Windows. ' +
    'Inclui a 0.76.140 (GPT-6.1 Sol).',
  highlights: [
    {
      title: 'Cabeçalho parado',
      detail:
        'No Windows os cabeçalhos de todos os panes alternavam entre título e ' +
        'botões a cada quadro, porque a barra de rolagem da grade aparecia e ' +
        'sumia. Agora o cabeçalho só volta a se alargar quando tem folga.',
    },
    {
      title: 'Codex sem "Hooks need review"',
      detail:
        'O pane Codex do Windows não parava mais nessa tela à espera de uma ' +
        'escolha. O Nexus volta a ler a versão do Codex instalado pelo npm e ' +
        'passa a flag de confiança só para os hooks que ele mesmo escreveu, ' +
        'como já fazia no macOS.',
    },
    {
      title: 'Nexus Shot no Windows',
      detail:
        'Capturas e gravações do Nexus Shot no Windows voltam a chegar ao ' +
        'pane. Antes eram recusadas porque o caminho começava com a letra da ' +
        'unidade. As pastas Imagens e Vídeos, inclusive no OneDrive, passam a ' +
        'ser aceitas.',
    },
  ],
  fixes: [],
};

export const RELEASE_076142: AppRelease = {
  version: '0.76.142',
  date: '2026-09-29',
  codename: 'Codex no Windows',
  summary:
    'O Codex volta a trabalhar no Windows, o Nexus para de fechar helpers que o ' +
    'Maestro reaproveitou e cada CLI passa a usar sempre o seu modelo mais novo.',
  highlights: [
    {
      title: 'Codex não morre com o Nexus como administrador',
      detail:
        'O Codex 0.159 do Windows fechava sozinho em 12 a 20 segundos quando o ' +
        'Nexus rodava elevado, e a missão tirava o Codex da rota. Os panes Codex ' +
        'agora rodam sem o servidor compartilhado do Codex, cada um no seu próprio ' +
        'ambiente.',
    },
    {
      title: 'Codex com ferramentas funcionando',
      detail:
        'Com o Node do WinGet, o Codex instalado pelo npm ficava num caminho longo ' +
        'demais para o Windows, e nenhuma ferramenta rodava. O Nexus passa a usar a ' +
        'instalação em %USERPROFILE%\.local\bin, e o "Atualizar CLI" move o Codex ' +
        'para lá. Sem instalação curta, o pane não abre e diz como corrigir.',
    },
    {
      title: 'Helper reaproveitado não é mais fechado',
      detail:
        'Quando o Maestro mandava trabalho novo a um helper que já tinha entregado, o ' +
        'Nexus o fechava na primeira pausa, e ele "encerrava sem entregar". Agora esse ' +
        'helper só fecha depois de entregar de novo.',
    },
    {
      title: 'Sempre o modelo mais novo',
      detail:
        'Cada CLI usa primeiro o seu modelo mais novo, com ou sem benchmark ' +
        'publicado: o MiniMax passa ao M3.1 Flash Preview e o AGY ao Gemini 3.8 ' +
        'também nas tarefas simples. Os modelos anteriores ficam de reserva.',
    },
  ],
  fixes: [],
};

export const RELEASE_076143: AppRelease = {
  version: '0.76.143',
  date: '2026-09-29',
  codename: 'Terminal sobe rápido',
  summary:
    'Pane novo com pasta isolada sobe em segundos em vez de quase um minuto, e o terminal ' +
    'reafirma o próprio tamanho para a CLI não desenhar fora do pane. Inclui a 0.76.142.',
  highlights: [
    {
      title: 'Pane novo sobe em segundos',
      detail:
        'Writers do Maestro e o 1º pane de uma aba nova ficavam cerca de 50 s em "Subindo…" ' +
        'copiando o node_modules arquivo por arquivo. Agora o Nexus clona a pasta inteira de ' +
        'uma vez: 4 a 6 s no saasbarbearia.',
    },
    {
      title: 'Terminal no tamanho certo',
      detail:
        'Ao focar ou voltar a ver um pane, o Nexus reafirma o tamanho dele para a CLI; se ela ' +
        'estava em outro tamanho, redesenha a tela. "Redesenhar tela" no toolbar do pane força ' +
        'o redesenho quando algo ainda sair embaralhado.',
    },
  ],
  fixes: [],
};

export const RELEASE_076144: AppRelease = {
  version: '0.76.144',
  date: '2026-09-29',
  codename: 'O modelo mais novo, sempre',
  summary:
    'Quando uma CLI passa a oferecer uma versão nova de um modelo, o Nexus a usa na hora, com ' +
    'ou sem benchmark publicado. Inclui a 0.76.143.',
  highlights: [
    {
      title: 'Modelo novo usado na hora',
      detail:
        'A versão mais nova da mesma linha (por exemplo, um GPT-6.2 Sol ao lado do 6.1) passa a ' +
        'valer na rota automática e como padrão do pane assim que a CLI a lista, sem esperar ' +
        'uma atualização do Nexus. Sem benchmark, ela herda a nota da versão anterior.',
    },
  ],
  fixes: [],
};

export const RELEASE_076145: AppRelease = {
  version: '0.76.145',
  date: '2026-09-29',
  codename: 'MiniMax livre',
  summary:
    'O MiniMax Code para de pedir permissão a cada ferramenta e roda livre nos ' +
    'panes, como as outras CLIs. Inclui a 0.76.144 (O modelo mais novo, sempre).',
  highlights: [
    {
      title: 'MiniMax Code sem pedir permissão',
      detail:
        'O MiniMax Code não tem opção de linha de comando para rodar livre. O ' +
        'Nexus agora ajusta o modo "Full access" na configuração dele antes de ' +
        'abrir o pane, e ele trabalha sem parar para pedir aprovação. Panes ' +
        'somente leitura continuam sem essa liberação.',
    },
  ],
  fixes: [],
};

export const RELEASE_076146: AppRelease = {
  version: '0.76.146',
  date: '2026-09-29',
  codename: 'Sol 6.1 em todo pedido',
  summary:
    'Quando um agente pede um modelo pelo nome, o Nexus usa a versão mais nova daquela linha: ' +
    'pedir o GPT-6 Sol abre o GPT-6.1 Sol. Inclui a 0.76.145.',
  highlights: [
    {
      title: 'Pedido pelo nome também sobe de versão',
      detail:
        'O modelo que um agente pede ao abrir um pane, o de um squad e o citado no texto da ' +
        'tarefa passam a usar a versão mais nova da mesma linha que a CLI oferece. O recibo ' +
        'mostra o que foi pedido e o que rodou. Rosters selados de missões antigas e panes ' +
        'retomados continuam como estavam.',
    },
  ],
  fixes: [],
};

export const RELEASE_076147: AppRelease = {
  version: '0.76.147',
  date: '2026-09-30',
  codename: 'Todas as CLIs na rota',
  summary:
    'AGY (Gemini 3.8), Devin, Kimi e Muse voltam a receber trabalho nas missões, ' +
    'a cota do Kimi aparece de novo, e o GLM não para mais no aviso de Bypass — ' +
    'com os hooks de controle dos workers funcionando. Inclui a 0.76.146.',
  highlights: [
    {
      title: 'AGY e Devin nas missões',
      detail:
        'O AGY e o Devin ficavam fora das missões porque não tinham o MCP do Nexus. ' +
        'Os dois leem servidores MCP do perfil do usuário: o Nexus registra a ' +
        'conexão uma vez pela própria CLI, e eles passam a devolver o resultado ' +
        'ao Maestro. Fora do Nexus eles seguem iguais.',
    },
    {
      title: 'Kimi na rota e com cota',
      detail:
        'O Kimi Code 2 guarda o login num arquivo com outro nome, e o Nexus o ' +
        'achava deslogado: nenhum helper ia para o Kimi e a cota ficava vazia. ' +
        'Agora o login é reconhecido, o K3 entra na rota, e a renovação do token ' +
        'volta ao mesmo arquivo que a CLI usa.',
    },
    {
      title: 'Muse nas missões',
      detail:
        'O Muse Code 1.4 aceita o MCP do Nexus e passa a concorrer em todos os ' +
        'tiers; fora do Nexus o Muse segue igual.',
    },
    {
      title: 'GLM sem o aviso de Bypass',
      detail:
        'Worker GLM com filtro de skills parava em "Bypass Permissions mode": a ' +
        'configuração do pane era descartada inteira, com os hooks de controle ' +
        'junto. Agora o filtro sai no formato que o Claude Code aceita.',
    },
  ],
  fixes: [],
};

export const RELEASE_076148: AppRelease = {
  version: '0.76.148',
  date: '2026-09-30',
  codename: 'Maestro delega',
  summary:
    'O Maestro volta a delegar em missões longas, o GPT-6 Astra sai da rota ' +
    'automática, os workers deixam de parar para perguntar e o MiniMax não é ' +
    'mais estacionado no meio do trabalho. Inclui a 0.76.147.',
  highlights: [
    {
      title: 'Maestro que não esquece de delegar',
      detail:
        'Numa missão de dias, o Maestro perdia a regra de delegar quando o ' +
        'contexto compactava e passava a fazer o trabalho sozinho. A regra agora ' +
        'fica nas instruções permanentes dele, e cada nova mensagem ou entrega ' +
        'de worker o lembra de abrir os workers em paralelo.',
    },
    {
      title: 'Astra só quando você pedir',
      detail:
        'O GPT-6 Astra saía em toda revisão e em toda tarefa crítica: 1 de cada ' +
        '4 workers num dia. Ele custa 5× mais e empata com o GPT-6.1 Sol nos ' +
        'benchmarks. Agora ele só é usado quando pedido pelo nome.',
    },
    {
      title: 'Worker não para para perguntar',
      detail:
        'Um worker Codex parava com uma pergunta de múltipla escolha quando o ' +
        'brief conflitava com as regras do Nexus, e o pane ficava parado até ' +
        'alguém clicar. Agora ele segue o Nexus e devolve o conflito na entrega.',
    },
    {
      title: 'MiniMax não é estacionado trabalhando',
      detail:
        'Sob pressão de memória, o Nexus estacionava o MiniMax no meio de uma ' +
        'tarefa longa. Agora ele lê a tela do MiniMax e reconhece quando ele está ' +
        'trabalhando.',
    },
  ],
  fixes: [],
};

export const RELEASE_076149: AppRelease = {
  version: '0.76.149',
  date: '2026-09-30',
  codename: 'Memória que enche',
  summary:
    'As entregas que o Maestro confirma passam a virar memória do projeto: ' +
    'antes, a missão da aba nunca gravava nada. Inclui a 0.76.148.',
  highlights: [
    {
      title: 'Memória do projeto de verdade',
      detail:
        'O Jev só guardava memória de tarefas do plano selado, de entregas com ' +
        'evidência verificada ou do "+ Pane". Na missão da aba, onde o Maestro ' +
        'abre os workers, nada disso acontecia, e a tela Memória ficava vazia ' +
        'depois de dias de trabalho. Agora cada entrega que o Maestro confirma ' +
        'passa pelo Jev, e o que vale lembrar aparece em Memória. As entregas ' +
        'antigas não são reprocessadas.',
    },
  ],
  fixes: [],
};

export const RELEASE_076150: AppRelease = {
  version: '0.76.150',
  date: '2026-09-30',
  codename: 'Hooks de volta no Windows',
  summary:
    'No Windows os hooks do Nexus chegavam vazios aos panes Claude e GLM: sem ' +
    'triagem de erro, sem lembrete de delegar, sem portão de regressão. Agora ' +
    'chegam inteiros. O AGY não cai mais por esforço e o Muse recebe a tarefa. ' +
    'Inclui a 0.76.149.',
  highlights: [
    {
      title: 'Hooks funcionando no Windows',
      detail:
        'O Claude Code do Windows roda os hooks pelo Git Bash, e o comando do ' +
        'Nexus perdia tudo o que o agente mandava. Em três dias foram 349 ' +
        'erros de terminal sem nenhuma triagem do Jev. Agora a triagem, o ' +
        'lembrete de delegar do Maestro, a memória de preferências e o portão ' +
        'de regressão chegam ao Nexus, com acentos corretos.',
    },
    {
      title: 'AGY sem "invalid model selection"',
      detail:
        'No AGY o esforço faz parte do nome do modelo. Quando a rota pedia ' +
        'outro esforço, o pane caía na hora. Agora o Nexus escolhe a variante ' +
        'certa do mesmo modelo.',
    },
    {
      title: 'Muse recebe a tarefa',
      detail:
        'No Windows o Muse abria e ficava parado, sem a tarefa. Agora o Nexus ' +
        'abre o programa do Muse direto e a tarefa já vai junto.',
    },
  ],
  fixes: [],
};

export const RELEASE_076151: AppRelease = {
  version: '0.76.151',
  date: '2026-09-30',
  codename: 'Mac em dia com o Windows',
  summary:
    'O Mac recebe as correções da 0.76.147 à 0.76.150, que tinham saído só ' +
    'para Windows: todas as CLIs nas missões, Maestro que delega, memória que ' +
    'enche e o AGY sem cair por esforço. Inclui a 0.76.150.',
  highlights: [
    {
      title: 'Todas as CLIs nas missões',
      detail:
        'AGY, Devin e Muse passam a entregar trabalho nas missões pelo MCP do ' +
        'Nexus, e o Kimi volta à rota com a cota lida certa.',
    },
    {
      title: 'Maestro que delega e memória que enche',
      detail:
        'O Maestro mantém a regra de delegar mesmo depois de compactar o ' +
        'contexto, os workers não param para perguntar, e cada entrega que ele ' +
        'confirma pode virar memória do projeto.',
    },
    {
      title: 'Menos gasto e menos quedas',
      detail:
        'O GPT-6 Astra só roda quando pedido pelo nome, o GLM não para mais no ' +
        'aviso de Bypass e o AGY não cai quando a rota pede outro esforço.',
    },
  ],
  fixes: [],
};

export const RELEASE_076152: AppRelease = {
  version: '0.76.152',
  date: '2026-09-30',
  codename: 'Jev que ajuda',
  summary:
    'O Jev para de devolver entregas boas, orienta o Maestro a dividir seus ' +
    'pedidos em workers e não segura mais o fechamento de panes. Inclui a ' +
    '0.76.151.',
  highlights: [
    {
      title: 'Revisão de entrega que não atrasa',
      detail:
        'A revisão do Jev devolvia 9 de cada 10 entregas: um revisor que achava ' +
        'problemas era tratado como trabalho inacabado. Metade das devolvidas ' +
        'nunca chegava ao Maestro. Agora só volta o que o worker consegue ' +
        'corrigir; o resto chega marcado para o Maestro decidir.',
    },
    {
      title: 'Maestro dividindo seus pedidos',
      detail:
        'Quando você digita um pedido no Maestro, o Jev avalia se ele se divide ' +
        'e o Maestro recebe a orientação de abrir um worker por parte, em ' +
        'paralelo.',
    },
    {
      title: 'Fechar pane sem esperar o Jev',
      detail:
        'Fechar o pane de um worker não passa mais pela guarda do Jev, que ' +
        'segurava o Maestro alguns segundos a cada fechamento.',
    },
  ],
  fixes: [],
};

export const RELEASE_076153: AppRelease = {
  version: '0.76.153',
  date: '2026-09-30',
  codename: 'Segunda conta Grok',
  summary:
    'O pane do Grok volta a abrir na segunda conta Grok: no Windows ele caía ' +
    'com "failed to prepare the isolated grok agent runtime". Inclui a 0.76.152.',
  highlights: [
    {
      title: 'Segunda conta Grok funcionando',
      detail:
        'Depois de cadastrar uma segunda conta Grok, todo pane que o Nexus ' +
        'abria nela falhava na hora. A conta nova guarda atalhos para as ' +
        'pastas do Grok, e o Nexus tentava copiá-los como arquivos. Agora ' +
        'eles são ligados como pastas.',
    },
  ],
  fixes: [],
};

export const RELEASE_076154: AppRelease = {
  version: '0.76.154',
  date: '2026-10-01',
  codename: 'Motor que usa todo mundo',
  summary:
    'Todas as CLIs instaladas entram na rota, só modelo de ponta julga código ' +
    'e workers Devin/Kimi param de morrer ao nascer. Inclui a 0.76.153.',
  highlights: [
    {
      title: 'Todas as CLIs entram na rota',
      detail:
        'Em 7 dias medidos, cinco CLIs levavam todas as tarefas e muse, grok, ' +
        'openclaude, minimax e deepseek ficavam com zero. Agora cada uma ' +
        'elegível ganha assento na missão antes de alguém repetir, e quem ' +
        'ficou para trás nos últimos 7 dias passa à frente.',
    },
    {
      title: 'Só modelo de ponta julga',
      detail:
        'Revisão, auditoria, QA e veredito vão para Fable 5.1, Opus 5.5, ' +
        'Sonnet 5.5, Sol 6.1 ou Astra. Sem nenhum deles livre, o Maestro ' +
        'julga no próprio pane em vez de delegar a um modelo barato.',
    },
    {
      title: 'Duas contas Claude, dois panes',
      detail:
        'Com o Maestro no Claude, nenhum worker Claude era aberto. Agora ' +
        'cabem tantos panes Claude quanto contas com credencial, cada um ' +
        'numa conta distinta.',
    },
    {
      title: 'Worker Devin/Kimi não morre em 2 segundos',
      detail:
        'O brief era colado enquanto o terminal ainda desenhava a tela ' +
        'inicial e o pane era fechado como "não ficou pronto a tempo". A ' +
        'entrega agora espera o terminal ficar pronto.',
    },
    {
      title: 'Qwen Code entra na rota',
      detail:
        'A CLI qwen, instalada e configurada com qwen3.8-max, nunca era ' +
        'chamada. Agora é roteável nos três tiers, lê o catálogo do seu ' +
        'settings e avisa quando a chave do Token Plan está recusada.',
    },
    {
      title: 'Veredito de ponta antes do push',
      detail:
        'Push, push automático ao concluir e git push digitado numa missão ' +
        'só rodam com um veredito "approve" de modelo de ponta registrado ' +
        'para o commit exato. Modelo barato não aprova produção.',
    },
    {
      title: '"+ Pane" dentro da missão',
      detail:
        'Numa aba de missão o picker pergunta o destino: nesta missão (o ' +
        'pane vira participante, só você fecha), nesta aba ou nova aba. Pane ' +
        'solto não é mais puxado para Terminais.',
    },
    {
      title: 'DeepSeek como CLI',
      detail:
        'DeepSeek deixa de ser só um endereço e passa a abrir pane próprio ' +
        '(deepseek-v4-pro e deepseek-flash) com a chave já cadastrada.',
    },
  ],
  fixes: [
    {
      title: 'Worker reaproveitado volta a entregar',
      detail:
        'Um pane só podia entregar uma vez: a segunda entrega do mesmo worker ' +
        'era recusada como repetição e se perdia. Entrega já recebida pelo ' +
        'Maestro mais conteúdo novo agora conta como rodada nova.',
    },
    {
      title: 'Worker travado acorda o Maestro',
      detail:
        'Um worker que pendurou no meio do turno deixava a missão parada até o ' +
        'relógio de ociosidade bloquear tudo horas depois. Agora, após 20 ' +
        'minutos sem atividade, o Maestro é avisado para ler, destravar ou ' +
        'trocar o pane.',
    },
    {
      title: 'Maestro gasta menos contexto',
      detail:
        'O orquestrador relia quase 900 mil tokens a cada turno. Agora compacta ' +
        'em 400 mil, cortando o custo por turno pela metade sem perder o resumo.',
    },
    {
      title: 'Missão parada explica o reparo',
      detail:
        'O Quadro dizia só "bloqueio técnico" e os terminais já tinham ' +
        'morrido. Agora ele nomeia a causa e o próximo passo, e guarda a ' +
        'última tela de cada pane para você ver o que aconteceu.',
    },
    {
      title: 'Missão pausada tem saída',
      detail:
        '"Tentar início novamente" não fazia nada depois que o pane do ' +
        'coordenador era fechado, e "Retomar" recusava a missão pausada por ' +
        'ociosidade. Agora Retomar o coordenador funciona para qualquer ' +
        'bloqueio técnico.',
    },
    {
      title: 'Workers não gastam a noite com teste que já quebrava',
      detail:
        'O portão de regressão compara com o commit-base: falha que já ' +
        'existia vira aviso, não devolução. E o hub de MCPs deixa de entrar ' +
        'inteiro em cada worker — boot rápido e sem travar em login de MCP.',
    },
    {
      title: 'Licença sem bloqueio falso',
      detail:
        'A tela de bloqueio não pisca a cada renovação, uma resposta boa não ' +
        'vira "sessão expirou", e um relógio alguns minutos atrasado não ' +
        'invalida um token recém-emitido.',
    },
    {
      title: 'Pane AGY não cai por atalho interno',
      detail:
        'A CLI do AGY consolida atalhos de configuração dentro do próprio ' +
        'estado; a guarda lia isso como adulteração e abortava o pane.',
    },
    {
      title: 'Chrome bloqueado pelo macOS explica o que fazer',
      detail:
        'Em vez de um erro EPERM cru, o painel pede Acesso Total ao Disco ' +
        'em Ajustes do Sistema.',
    },
  ],
};

export const RELEASE_076155: AppRelease = {
  version: '0.76.155',
  date: '2026-10-01',
  codename: 'Guarda no lugar',
  summary:
    'No Windows, o Nexus volta a recusar um atalho de credencial adulterado ' +
    'em vez de refazê-lo em silêncio. Inclui a 0.76.154.',
  highlights: [
    {
      title: 'Atalho de credencial adulterado volta a ser recusado no Windows',
      detail:
        'Antes de abrir um pane, o Nexus confere os atalhos de login e ' +
        'configuração de cada CLI. No Windows, essa conferência aceitava um ' +
        'atalho para a própria pasta do perfil ou para uma pasta vizinha de ' +
        'nome parecido, e apenas o refazia. Agora ela recusa e o pane não ' +
        'abre, como no Mac.',
    },
  ],
  fixes: [],
};

export const RELEASE_076156: AppRelease = {
  version: '0.76.156',
  date: '2026-10-01',
  codename: 'Fechar sempre à vista',
  summary:
    'O botão Fechar não some mais do cabeçalho quando vários panes ficam ' +
    'lado a lado. Inclui a 0.76.155.',
  highlights: [
    {
      title: 'Fechar sempre à vista',
      detail:
        'Com três panes lado a lado numa tela larga, o cabeçalho mostrava ' +
        'custo, tok/s e todas as ações com nome, passava da largura e o ' +
        'botão Fechar ficava cortado. Agora, quando os botões não cabem, ' +
        'eles viram ícones ou vão para o menu "⋯", e o Fechar fica sempre ' +
        'no canto direito.',
    },
  ],
  fixes: [],
};

export const RELEASE_076157: AppRelease = {
  version: '0.76.157',
  date: '2026-10-01',
  codename: 'Kimi sem alarme falso',
  summary:
    'O Nexus para de avisar "Limite temporário" no Kimi quando é só a ' +
    'própria CLI organizando os subagentes. Inclui a 0.76.156.',
  highlights: [
    {
      title: 'Kimi sem alarme falso de limite',
      detail:
        'Quando o Kimi roda vários subagentes juntos, o provider às vezes ' +
        'pede para ir mais devagar. A própria CLI espera alguns segundos e ' +
        'segue, mostrando "Rate limited…" no painel. O Nexus lia isso como ' +
        'limite da conta e avisava "Limite temporário" com a cota sobrando. ' +
        'Agora ele ignora esse aviso interno, e só um erro real do provider ' +
        'conta como limite.',
    },
  ],
  fixes: [],
};

export const RELEASE_076158: AppRelease = {
  version: '0.76.158',
  date: '2026-10-01',
  codename: 'Uma linha por cota',
  summary:
    'O GLM aparece uma vez só nas cotas e no Redline, e o login pelo GitHub ' +
    'ou Google mostra a espera e diz o motivo quando falha. Inclui a 0.76.157.',
  highlights: [
    {
      title: 'GLM uma vez só nas cotas',
      detail:
        'GLM e GLM Flash usam a mesma chave z.ai, então são a mesma cota. A ' +
        'barra lateral, as Configurações e o Redline mostravam as duas ' +
        'linhas com os mesmos números. Agora aparece uma linha por cota; se ' +
        'o GLM Flash tiver chave própria, as duas continuam separadas.',
    },
    {
      title: 'Login que diz o que está acontecendo',
      detail:
        'Ao clicar em "Entrar com GitHub" ou "Entrar com Google", o Nexus ' +
        'confere o servidor antes de abrir o navegador, mostra que está ' +
        'esperando e explica o motivo se o login falhar. A tela de acesso ' +
        'foi redesenhada e aceita código de licença.',
    },
  ],
  fixes: [],
};

export const RELEASE_076159: AppRelease = {
  version: '0.76.159',
  date: '2026-10-01',
  codename: 'Marca nova',
  summary:
    'O ícone do Nexus no Mac e no Windows, a tela do instalador e a marca ' +
    'dentro do app passam a ser o "N" pixel rosa do site. Inclui as ' +
    'versões 0.76.155 a 0.76.158.',
  highlights: [
    {
      title: 'O "N" pixel do site é a marca do app',
      detail:
        'O ícone do Dock, do Finder e da barra de tarefas, a tela "Preparando ' +
        'seu ambiente" do instalador do Windows e a marca da abertura e da ' +
        'tela de acesso agora são o mesmo "N" pixel rosa do site, no lugar ' +
        'do nó em losango. O ícone novo aparece depois de atualizar.',
    },
    {
      title: 'Tudo que estava pendente chega junto',
      detail:
        'Login que diz o que está acontecendo e resgate de código de ' +
        'licença, uma linha por cota, Kimi sem alarme falso e o botão Fechar ' +
        'sempre à vista.',
    },
  ],
  fixes: [],
};

export const RELEASE_076160: AppRelease = {
  version: '0.76.160',
  date: '2026-10-01',
  codename: 'Teste à vista',
  summary:
    'O app avisa quantos dias faltam do teste de 15 dias e leva direto para ' +
    'assinar. Inclui a 0.76.159 (marca nova).',
  highlights: [
    {
      title: 'Aviso de fim do teste na barra lateral',
      detail:
        'Nos últimos 3 dias do teste, o rodapé da barra lateral mostra ' +
        'quantos dias faltam, ou que termina amanhã ou hoje, com o botão ' +
        'Assinar que abre o checkout. Quem já assina, usa código de licença ' +
        'ou é administrador não vê o aviso.',
    },
  ],
  fixes: [],
};

export const RELEASE_076161: AppRelease = {
  version: '0.76.161',
  date: '2026-10-01',
  codename: 'Jev e Clef juntos',
  summary:
    'Escolha Jev, Clef ou o modo automático nas configurações. O Clef pode ' +
    'analisar a página do navegador com visão optativa. Inclui a 0.76.160.',
  highlights: [
    {
      title: 'Dois modelos de decisão, uma configuração',
      detail:
        'Account ID e token Cloudflare no cofre local, um botão de teste de ' +
        'conexão (ainda não validado contra a Cloudflare real) e escolha ' +
        'entre Automático, Somente Jev e Somente Clef, com Clef Flash ' +
        'opcional. Jev e suas credenciais permanecem disponíveis; guarda de ' +
        'despacho, revisão de handoff, memória e pilotos seguem só no Jev.',
    },
    {
      title: 'Visão do navegador com Clef',
      detail:
        'Ao ativar a análise de imagens (com confirmação), o agente pode ' +
        'consultar sinais visuais de erro, sucesso, carregamento, bloqueio ' +
        'humano e layout em abas isoladas; abas com o seu perfil pessoal são ' +
        'recusadas. Campos, segredos reconhecidos, frames e mídia são ' +
        'ocultos antes do envio, mas a ocultação é parcial. A consulta não ' +
        'clica nem concede permissões.',
    },
    {
      title: 'Uso e custos por modelo',
      detail:
        'O histórico identifica o provedor, modelo, regra de seleção, ' +
        'tokens e tentativas. A regra automática inicial mantém Jev nas ' +
        'tarefas de texto e usa Clef para escolher ferramentas; qualidade ' +
        'local ainda será medida antes de promover novas rotas.',
    },
  ],
  fixes: [],
};

export const RELEASE_076162: AppRelease = {
  version: '0.76.162',
  date: '2026-10-01',
  codename: 'Cloudflare protegido',
  summary:
    'Tokens Cloudflare no formato novo também são ocultos em texto e nos ' +
    'pixels do navegador. Inclui Jev e Clef complementares da 0.76.161.',
  highlights: [],
  fixes: [{
    title: 'Token Cloudflare protegido sem precisar de label',
    detail:
      'O formato prefixado de token de usuário ou conta é reconhecido em ' +
      'texto livre. A redação protege as consultas dos modelos e inclui a ' +
      'área do texto nas máscaras de captura. A visão continua optativa.',
  }],
};

export const RELEASE_076163: AppRelease = {
  version: '0.76.163',
  date: '2026-10-02',
  codename: 'Reporte de problema',
  summary:
    'Achou um problema? Ajuda → Reportar um problema… manda o relato direto ' +
    'para a equipe, mostrando antes exatamente o que será enviado. Traz também ' +
    'o endurecimento da visão do navegador com Clef. Inclui a 0.76.162.',
  highlights: [
    {
      title: 'Reportar um problema, sem sair do app',
      detail:
        'No menu Ajuda ou na paleta de comandos. Você escolhe a categoria e o ' +
        'impacto, descreve o que aconteceu e vê o texto exato que será ' +
        'enviado. O diagnóstico técnico (versão, agente ativo, eventos ' +
        'recentes) só vai se você marcar, e chaves, e-mails e caminhos da sua ' +
        'pasta são ocultados antes do envio. A limpeza não pega tudo: confira ' +
        'a prévia. Dá para copiar o relato e mandar por outro canal se a ' +
        'conexão falhar.',
    },
    {
      title: 'Visão do navegador mais cuidadosa',
      detail:
        'A análise de imagens recusa abas com o seu perfil pessoal, oculta o ' +
        'bloco inteiro quando um rótulo sensível aparece (e não só o campo), ' +
        'junta segredos partidos em trechos vizinhos e exige uma nova ' +
        'confirmação ao ligar. A ocultação continua parcial: ' +
        'fundos e dados pessoais em texto comum não são cobertos.',
    },
  ],
  fixes: [
    {
      title: 'Guarda, revisão e memória ficam no Jev',
      detail:
        'A guarda de despacho, a revisão de handoff, a memória e os pilotos ' +
        'de navegador e desktop não vão mais para o Clef, nem em "Somente ' +
        'Clef": os limiares deles foram calibrados para o Jev. A tela de ' +
        'configuração avisa quando isso desliga alguma delas.',
    },
    {
      title: 'Resposta do Jev tolerada, não zerada',
      detail:
        'Uma soma de probabilidades com diferença mínima ou um uso de tokens ' +
        'ausente não derrubam mais a decisão do Jev; o uso ausente aparece ' +
        'como "sem medição", nunca como zero. Conexões e texto foram ' +
        'validados com a Cloudflare; a visão segue optativa e limitada.',
    },
  ],
};

export const RELEASE_076164: AppRelease = {
  version: '0.76.164',
  date: '2026-10-02',
  codename: 'Revisão completa',
  summary:
    'Todas as melhorias recentes juntas, com duas rodadas de revisão, ' +
    'proteção visual reforçada, login que preserva a tentativa nova e ' +
    'contabilidade correta quando uma consulta só responde em parte.',
  highlights: [
    { title: 'Jev e Clef, com controle pela interface', detail:
      'Automático, Somente Jev ou Somente Clef/Flash; chave Cloudflare no ' +
      'cofre local. A visão continua optativa e superfícies com efeito ' +
      'conservam os controles Jev.' },
    { title: 'Relato de problema com prévia e consentimento', detail:
      'Menu Ajuda e paleta de comandos, prévia do texto a enviar e escolha ' +
      'do diagnóstico técnico. Inclui acesso, licença, assinatura, marca ' +
      'e aviso de fim do teste já integrados.' },
  ],
  fixes: [
    { title: 'Dados sensíveis fora da caixa também são ocultos', detail:
      'A máscara cobre texto e descendentes do bloco sensível, incluindo ' +
      'valores vizinhos e sombras abertas. Árvores DOM excessivas são ' +
      'recusadas com limites antes de processamento recursivo.' },
    { title: 'A tentativa nova de login continua válida', detail:
      'Uma resposta atrasada de uma tentativa anterior, inclusive falha ' +
      'de rede ou do servidor, não interrompe o login mais recente.' },
    { title: 'Confirmações do relato ficam acessíveis', detail:
      'A confirmação de descartar alterações aparece acima do diálogo ' +
      'de reporte e recebe interação.' },
    { title: 'Custos parciais e medidas ausentes permanecem distintos', detail:
      'Rankings preservam o uso conhecido dos candidatos que responderam ' +
      'mesmo se outro falhar; uso ausente permanece sem medição.' },
  ],
};

export const RELEASE_076165: AppRelease = {
  version: '0.76.165',
  date: '2026-10-02',
  codename: 'Decisões à vista',
  summary:
    'Você passa a ver por que o Nexus escolheu: a confiança do Jev, o que a ' +
    'regra teria escolhido e qual conta foi usada. A voz deixou de abrir ' +
    'missão por palpite. Inclui a 0.76.164.',
  highlights: [
    {
      title: 'Recibo da rota com a confiança do Jev',
      detail:
        'Ao passar o mouse no chip "Jev" do pane você vê a confiança por ' +
        'dimensão (tarefa, especialidade, esforço) e o que a regra teria ' +
        'escolhido sozinha. Quando o Jev só confirma a regra, o recibo diz ' +
        'que a regra chegaria ao mesmo lugar. O mesmo dado aparece no ' +
        'resultado de nexus_route_task e no log de rotas.',
    },
    {
      title: 'Conta escolhida, à vista no pane',
      detail:
        'Um chip no cabeçalho do pane mostra qual conta foi usada (sempre ' +
        'mascarada) e, no tooltip, quem decidiu, a folga medida na hora e as ' +
        'alternativas com o motivo de cada uma ter perdido. A escolha de ' +
        'conta continua sendo da regra de folga, que compara cota medida; o ' +
        'Jev não decide conta.',
    },
    {
      title: 'Missão falada com desempate do Jev',
      detail:
        'Ao dizer "abre a missão site", se duas missões parecem o que você ' +
        'disse, o Jev desempata (só com confiança alta) e a voz avisa qual ' +
        'abriu; sem certeza, ela pergunta qual. Um nome mal reconhecido ' +
        'também é tratado, com critério mais rígido, e a voz diz que ' +
        'interpretou. Há uma superfície nova, missionPick, com interruptor ' +
        'próprio em Configurações.',
    },
  ],
  fixes: [
    {
      title: 'A voz não abre mais uma missão qualquer',
      detail:
        'Antes, um nome que não casava com nenhuma missão abria a primeira ' +
        'da lista em silêncio, e dois nomes parecidos abriam sempre a ' +
        'primeira. Agora, sem correspondência a voz diz que não achou e ' +
        'lista as missões, e nada abre por palpite.',
    },
    {
      title: 'Cabeçalho do pane sem pulo de 3 px',
      detail:
        'Quando um chip não cabia na linha e ia para a escondida, o ' +
        'conteúdo do cabeçalho subia 3 px. A altura da primeira linha agora ' +
        'é fixa.',
    },
  ],
};

export const RELEASE_076166: AppRelease = {
  version: '0.76.166',
  date: '2026-10-02',
  codename: 'Workers com mais autonomia',
  summary:
    'Workers abrem e verificam o navegador da própria missão e criam ' +
    'subagentes quando a CLI oferece esse recurso. O acesso continua ' +
    'vinculado à janela, ao projeto e à conta da tarefa, e o desktop segue ' +
    'só do operador e do orquestrador. Inclui a 0.76.165.',
  highlights: [
    {
      title: 'Workers executam e verificam a interface',
      detail:
        'Workers abrem e controlam o navegador da própria missão, na janela ' +
        'de origem. As abas do operador e as de outra missão continuam fora ' +
        'do alcance deles, e o desktop segue só do operador e do ' +
        'orquestrador. A entrega deve informar a página, as interações e a ' +
        'evidência visual; se a verificação não puder acontecer, a pendência ' +
        'fica explícita.',
    },
    {
      title: 'Subagentes nativos disponíveis',
      detail:
        'Claude e OpenClaude deixam de bloquear Task por padrão. Workers ' +
        'podem usar os subagentes da própria CLI dentro das permissões da ' +
        'tarefa; o orquestrador, o modo governado e as restrições ' +
        'explícitas continuam sem Task.',
    },
  ],
  fixes: [
    {
      title: 'Teclas para jogos no navegador',
      detail:
        'As teclas passam a fornecer event.code e podem ficar pressionadas ' +
        'por até um segundo. A navegação e o cancelamento encerram a ação ' +
        'sem mandar eventos para uma página antiga.',
    },
    {
      title: 'Configuração e respostas ACP',
      detail:
        'Modelo e esforço precisam ser anunciados e confirmados pela CLI ' +
        'antes do pedido. O coordenador recebe o texto público das respostas, ' +
        'com separação entre turnos e sem incluir pensamentos internos.',
    },
    {
      title: 'Catálogo remoto público',
      detail:
        'O catálogo usa uma fonte pública versionada e um prazo de refresh ' +
        'validado no proxy. Falhas preservam o catálogo local existente.',
    },
    {
      title: 'Build e verificação Linux no CI',
      detail:
        'Preview Linux registra o commit, os smokes e as evidências de ' +
        'formulário, menu, viewport mobile e jogo. O canal de release Linux ' +
        'confere os pacotes e o recibo antes da publicação.',
    },
  ],
};

export const RELEASE_076167: AppRelease = {
  version: '0.76.167',
  date: '2026-10-02',
  codename: 'Qwen no ar',
  summary:
    'O pane do Qwen volta a abrir, e o Qwen chamado pelo Nexus é sempre o ' +
    'qwen3.8-max. Inclui a 0.76.166.',
  highlights: [
    {
      title: 'Qwen volta a abrir',
      detail:
        'Todo pane do Qwen com modelo definido era recusado com "modelo ' +
        'selado não entrou no argv". O comando passava o modelo com uma ' +
        'flag diferente da que o Nexus confere. Agora as duas batem, e um ' +
        'teste confere isso em todas as CLIs embutidas.',
    },
    {
      title: 'Qwen sempre no 3.8 Max',
      detail:
        'Em qualquer faixa de tarefa, o Qwen chamado pelo Nexus usa o ' +
        'qwen3.8-max. O Qwen Code não tem mais login por OAuth (a Qwen ' +
        'encerrou em 15/04/2026); a assinatura é o Coding Plan, por chave.',
    },
  ],
  fixes: [],
};

export const RELEASE_076168: AppRelease = {
  version: '0.76.168',
  date: '2026-10-02',
  codename: 'Pane que começa',
  summary:
    'O Nexus confere se cada pane começou a tarefa e, se não começou, ' +
    'corrige ali ou manda para outra CLI. Sair do app não encerra mais as ' +
    'missões. Inclui a 0.76.167.',
  highlights: [
    {
      title: 'Pane que não começa é corrigido ou trocado',
      detail:
        'Se um pane aberto para uma tarefa falha ao nascer, o Nexus fica ' +
        'sabendo na hora. Se ele abre mas fica 90 segundos parado, a tarefa ' +
        'é reenviada; se ainda assim não começar, o pane é fechado e a tarefa ' +
        'vai para outra CLI, uma vez só. Quem pediu sempre recebe o aviso.',
    },
    {
      title: 'Sair do Nexus não encerra as missões',
      detail:
        'O diálogo de sair agora tem "Sair e retomar ao abrir" como padrão: ' +
        'as missões voltam sozinhas quando você abre o Nexus. "Sair e ' +
        'encerrar missões" continua disponível como escolha explícita.',
    },
    {
      title: 'O aviso de worker travado chega ao Maestro',
      detail:
        'O aviso de worker pendurado no meio do turno ficava preso na fila e ' +
        'chegava a se repetir a cada 15 segundos. Agora ele é entregue ao ' +
        'Maestro uma vez por hora, para ele destravar ou trocar o worker.',
    },
  ],
  fixes: [],
};

export const RELEASE_076169: AppRelease = {
  version: '0.76.169',
  date: '2026-10-02',
  codename: 'DeepSeek pelo plano',
  summary:
    'O DeepSeek agora roda pela API direta da DeepSeek ou pelo Alibaba ' +
    'Token Plan, à sua escolha. A chave do plano nunca vai para a DeepSeek. ' +
    'O Qwen Code também ganha o DeepSeek V4 Pro do plano.',
  highlights: [
    {
      title: 'Escolha o provedor do DeepSeek',
      detail:
        'Em Providers › DeepSeek, escolha "DeepSeek (API direta)" ou ' +
        '"Alibaba Token Plan". Cada provedor usa o endpoint e a chave dele: ' +
        'a chave do plano (sk-sp-…) nunca é enviada para a DeepSeek, que ' +
        'respondia 401 e derrubava o pane. Se você ainda não escolheu, o ' +
        'Nexus segue o seu launcher: chave do plano lá significa Token Plan.',
    },
    {
      title: 'DeepSeek V4 Pro também pelo Qwen Code',
      detail:
        'Com o Qwen Code no Token Plan, o DeepSeek V4 Pro aparece no catálogo ' +
        'dele. O plano não serve o DeepSeek Flash: tarefas que pediriam o ' +
        'Flash sobem no V4 Pro em vez de falhar.',
    },
  ],
  fixes: [],
};

export const RELEASE_076170: AppRelease = {
  version: '0.76.170',
  date: '2026-10-02',
  codename: 'Linux no desktop',
  summary:
    'Versão do Linux, conferida num Omarchy/Hyprland de verdade: o login ' +
    'volta para o app, o cofre funciona fora de GNOME e KDE e o Redline ' +
    'aparece na bandeja. Inclui as versões 0.76.167 a 0.76.169.',
  highlights: [
    {
      title: 'Login que volta para o app no Linux',
      detail:
        'Depois de entrar pelo navegador, o Nexus recebe o retorno e conclui ' +
        'o login. Vale para o pacote .deb, o .rpm e o ZIP portátil, que ' +
        'agora cria a própria entrada no menu de aplicativos.',
    },
    {
      title: 'Cofre de segredos no Omarchy, Hyprland e sway',
      detail:
        'A sessão e as suas chaves passam a ser guardadas no chaveiro do ' +
        'sistema (gnome-keyring, KeePassXC) também fora de GNOME e KDE. ' +
        'Sem chaveiro ativo, o Nexus avisa e não grava nada em texto plano.',
    },
    {
      title: 'Redline na bandeja do Linux',
      detail:
        'Ligue em Uso e cotas › Bandeja do sistema para ver o consumo das ' +
        'suas contas no ícone da bandeja enquanto o Nexus está aberto.',
    },
    {
      title: 'Ícone do Nexus no menu e na janela',
      detail:
        'O app instalado aparece com o ícone do Nexus, na categoria ' +
        'Desenvolvimento.',
    },
  ],
  fixes: [
    {
      title: 'Link nexus:// não fecha mais o Nexus',
      detail:
        'Abrir um link de pasta ou de licença com o Nexus em uso podia ' +
        'encerrar o app e os terminais se a confirmação ficasse aberta por ' +
        'mais de 20 segundos.',
    },
    {
      title: 'Comandos dos agentes encontram o Node instalado no seu usuário',
      detail:
        'No Linux, node e npm instalados por mise ou nvm não eram ' +
        'encontrados pelos comandos que os agentes rodam no modo protegido.',
    },
    {
      title: 'Gravações do Nexus Shot na pasta Vídeos',
      detail:
        'O Nexus passa a aceitar gravações enviadas da pasta Vídeos do Linux.',
    },
  ],
};

export const RELEASE_076171: AppRelease = {
  version: '0.76.171',
  date: '2026-10-02',
  codename: 'Entrega que chega',
  summary:
    'O Maestro Codex recebe as entregas dos workers sem ficar parado no ' +
    'Enter, retomar a missão retoma a conversa do Maestro, e a CLI que falha ' +
    'ao começar sai da rota em vez de ser escolhida de novo. Inclui a 0.76.170.',
  highlights: [
    {
      title: 'Entregas chegam ao Maestro Codex',
      detail:
        'No Windows, a entrega de um worker ficava colada no Maestro Codex como ' +
        '"[Pasted Content]" e não era enviada; cada nova tentativa colava outra ' +
        'cópia. Agora o Nexus espera o Codex terminar de receber o texto antes ' +
        'de apertar Enter.',
    },
    {
      title: 'Retomar a missão retoma a conversa',
      detail:
        'Depois de reiniciar o app, a missão da aba volta com o Maestro na ' +
        'mesma conversa, sem um segundo Maestro vazio disputando a conta. ' +
        'O aviso de "Agente em pausa" some quando o pane volta.',
    },
    {
      title: 'CLI que não começa sai da rota',
      detail:
        'Pane cuja chave o provedor recusa já no primeiro pedido é tratado ' +
        'como pane que não começou: a tarefa vai para outra CLI e aquela CLI ' +
        'fica fora da rota por um tempo. Uma CLI que morre ao abrir também é ' +
        'pausada, por mais tempo a cada nova falha.',
    },
  ],
  fixes: [
    {
      title: 'Texto em português chega certo aos agentes no Windows',
      detail:
        'As orientações do Nexus aos agentes chegavam com acentos trocados ' +
        '("sessão" virava "sessÃ£o").',
    },
  ],
};

export const RELEASE_076172: AppRelease = {
  version: '0.76.172',
  date: '2026-10-02',
  codename: 'Sala de racks',
  summary:
    'O quadro da missão virou uma sala de racks: cada CLI é um rack com a ' +
    'ferramenta, o modelo e o estado, e as relações são cabos que acendem ' +
    'quando o agente está trabalhando. Inclui a 0.76.171.',
  highlights: [
    {
      title: 'Cada agente é um rack',
      detail:
        'O logo e o modelo da CLI, a luz e a palavra do estado, uma régua de ' +
        'atividade e o visor com a unidade em que o agente está. O Maestro é ' +
        'o núcleo, com o painel de portas de onde saem os cabos.',
    },
    {
      title: 'Cabos com energia passando',
      detail:
        'Delegação, entrega, dependência e revisão viram cabos entre os ' +
        'racks. Enquanto o agente trabalha, o cabo acende e leva pacotes; ' +
        'parado, fica quieto e na cor do estado. Com "reduzir movimento" ' +
        'ligado no sistema, nada se mexe.',
    },
  ],
  fixes: [],
};

export const RELEASE_076173: AppRelease = {
  version: '0.76.173',
  date: '2026-10-02',
  codename: 'O Maestro lembra',
  summary:
    'Build do Mac que reúne tudo o que saiu desde a 0.76.166. O Maestro ' +
    'passa a conferir o que os workers entregam, e a retomada do Maestro ' +
    'depois de uma atualização não prende mais a missão num id velho. ' +
    'Inclui a 0.76.172.',
  highlights: [
    {
      title: 'O Maestro confere o que os workers entregam',
      detail:
        'Handoff é alegação, não prova: antes de aceitar ou integrar, o ' +
        'Maestro lê o diff e roda o teste que prova a correção; sem isso o ' +
        'que vale é "não verificado". Vale para qualquer CLI que seja o Maestro.',
    },
    {
      title: 'Retomada do Maestro que não prende a missão',
      detail:
        'Se a conversa guardada do Maestro nunca virou uma conversa de ' +
        'verdade, depois de duas falhas seguidas o Nexus a esquece e o ' +
        'Maestro sobe limpo, em vez de a missão ficar bloqueada sem saída.',
    },
  ],
  fixes: [
    {
      title: 'Aviso falso de "falha ao retomar"',
      detail:
        'Quando o próprio Nexus encerra um processo de propósito (por ' +
        'exemplo, ao religar o Maestro), o pane não mostra mais "Falha ao ' +
        'retomar a sessão".',
    },
  ],
};

export const RELEASE_076174: AppRelease = {
  version: '0.76.174',
  date: '2026-10-02',
  codename: 'Missão que volta',
  summary:
    'Quando o Maestro pausa a missão esperando você, ela aparece em ' +
    '"Precisa de você" e volta com Retomar, em vez de cair no Arquivo como ' +
    'encerrada. Inclui a 0.76.173.',
  highlights: [
    {
      title: 'A missão que o Maestro pausou volta com Retomar',
      detail:
        'Se o Maestro para a missão para perguntar algo a você, a missão ' +
        'fica em "Precisa de você" com o motivo dele. Retomar religa o ' +
        'Maestro na mesma conversa para você responder ali. Antes ela podia ' +
        'ir para o Arquivo como "encerrada pelo operador" e o Retomar falhava.',
    },
  ],
  fixes: [],
};

export const RELEASE_076175: AppRelease = {
  version: '0.76.175',
  date: '2026-10-02',
  codename: 'Login no Omarchy',
  summary:
    'Versão do Linux. O login pelo navegador agora volta para o Nexus no ' +
    'Omarchy e em outros desktops que abrem links pelo portal do sistema, e ' +
    'o Redline aparece na bandeja sem precisar ligar. Inclui as versões ' +
    '0.76.171 a 0.76.174.',
  highlights: [
    {
      title: 'Login que conclui no Linux',
      detail:
        'Depois de entrar pelo navegador, o sistema reconhece o Nexus como o ' +
        'app que recebe o retorno. Antes aparecia a janela "Open With" sem ' +
        'nenhum aplicativo e o login não terminava.',
    },
    {
      title: 'Redline visível desde o primeiro uso',
      detail:
        'O ícone do Redline já aparece na bandeja enquanto o Nexus está ' +
        'aberto. Para tirar, use "Ocultar da bandeja" no menu do ícone ou ' +
        'em Uso e cotas.',
    },
  ],
  fixes: [],
};

export const RELEASE_076176: AppRelease = {
  version: '0.76.176',
  date: '2026-10-02',
  codename: 'Helpers sem espera',
  summary:
    'O Maestro abre os helpers numa chamada só, sem a rodada extra de ' +
    'roteamento, e os panes que nasciam parados (Qwen que não abria, Devin ' +
    'com o brief sem Enter, MiMo retomado que fechava sozinho) começam a ' +
    'trabalhar. A missão parada fica à vista no Quadro, com Remover. Inclui ' +
    'a 0.76.175.',
  highlights: [
    {
      title: 'O Maestro abre os helpers mais rápido',
      detail:
        'O Maestro consultava a rota de cada tarefa antes de abrir os panes, ' +
        'uma rodada inteira de raciocínio a mais antes do primeiro helper ' +
        'nascer. Abrir o pane já escolhe a CLI, o modelo e o esforço, e as ' +
        'instruções do Maestro agora mandam fazer só isso.',
    },
    {
      title: 'Missão parada à vista no Quadro, com Remover',
      detail:
        'A missão parada ou dormindo aparece em "Precisa de você", não mais ' +
        'escondida na gaveta do Arquivo. O card de missão sem processo ganha ' +
        '"Remover", com a mesma confirmação da lista lateral.',
    },
  ],
  fixes: [
    {
      title: 'O Qwen volta a abrir',
      detail:
        'O Qwen Code novo recusa duas opções de permissão que o Nexus passava ' +
        'juntas e fechava mostrando a ajuda. O pane do Qwen volta a abrir, ' +
        'pelo "+ Pane" e nas missões.',
    },
    {
      title: 'Atualizar o Devin com panes abertos',
      detail:
        'O botão "Atualizar CLI" do Devin falhava se algum pane Devin ' +
        'estivesse aberto. A atualização passa a acontecer, e os panes ' +
        'abertos seguem na versão anterior até fechar.',
    },
    {
      title: 'Brief do Devin não fica mais parado sem Enter',
      detail:
        'Com a máquina carregada, o Enter do brief chegava junto com a ' +
        'colagem e virava quebra de linha: o brief ficava no campo de texto ' +
        'sem ser enviado. O Nexus espera o Devin terminar de receber a ' +
        'colagem antes do Enter, como já fazia com o Codex.',
    },
    {
      title: 'Worker MiMo retomado não fecha mais sozinho',
      detail:
        'O MiMo pergunta, a cada abertura, se aceita rodar sem pedir ' +
        'permissão, com "não, sair" marcado. Na retomada, o brief colado cedo ' +
        'respondia essa pergunta e o pane fechava em 5 segundos. O Nexus liga ' +
        'o mesmo modo pela variável que o MiMo documenta, sem a pergunta, e ' +
        'só cola o brief com o campo de texto pronto.',
    },
    {
      title: 'Codex e Claude fora do Nexus sem erro de hook no Windows',
      detail:
        'Quando você usava o Codex ou o Claude num terminal comum, o hook ' +
        'que o Nexus instala falhava a cada evento com "A sintaxe do comando ' +
        'está incorreta". Agora ele sai em silêncio quando não está num pane ' +
        'do Nexus.',
    },
  ],
};

export const RELEASE_076177: AppRelease = {
  version: '0.76.177',
  date: '2026-10-02',
  codename: 'Mac em dia',
  summary:
    'Build do Mac que traz o que saiu nas versões do Windows e do Linux ' +
    'desde a 0.76.173: o bloqueio do Maestro sempre tem Retomar, a missão ' +
    'parada fica à vista no Quadro, o Maestro abre os helpers numa chamada ' +
    'só e os panes que nasciam parados (Qwen, Devin, MiMo) começam a ' +
    'trabalhar. Inclui a 0.76.176.',
  highlights: [
    {
      title: 'O Maestro bloqueado sempre tem saída',
      detail:
        'Um bloqueio que o Maestro declara não vira mais "encerrada pelo ' +
        'operador" por engano, e a missão sempre mostra Retomar em vez de ' +
        'ir para o Arquivo sem saída.',
    },
    {
      title: 'Missão parada à vista no Quadro',
      detail:
        'Missão parada, dormindo ou sem sessão aparece em "Precisa de você", ' +
        'e o card da missão sem processo ganha Remover, com confirmação.',
    },
    {
      title: 'O Maestro abre os helpers mais rápido',
      detail:
        'O Maestro não consulta mais a rota de cada tarefa antes de abrir os ' +
        'panes: delega numa chamada só.',
    },
  ],
  fixes: [
    {
      title: 'Qwen, Devin e MiMo começam a trabalhar',
      detail:
        'O Qwen volta a abrir, o brief do Devin espera a colagem antes do ' +
        'Enter e o worker MiMo retomado não fecha mais sozinho.',
    },
  ],
};

export const RELEASE_076178: AppRelease = {
  version: '0.76.178',
  date: '2026-10-02',
  codename: 'Linux avisa da versão nova',
  summary:
    'Versão do Linux. O Nexus passa a avisar quando sai uma versão nova e ' +
    'mostra o comando para atualizar, e o clique no ícone do Redline abre ' +
    'as suas cotas. Inclui as versões 0.76.176 e 0.76.177.',
  highlights: [
    {
      title: 'Aviso de versão nova no Linux',
      detail:
        'O painel de atualização agora verifica se há versão nova para ' +
        'Linux e mostra o comando de uma linha para atualizar, com botão ' +
        'de copiar. Suas contas, projetos e missões ficam como estão.',
    },
    {
      title: 'Redline abre com um clique',
      detail:
        'Clique no ícone do Redline na bandeja para abrir Uso e cotas no ' +
        'Nexus. O botão direito continua mostrando a lista das contas.',
    },
  ],
  fixes: [],
};

export const RELEASE_076179: AppRelease = {
  version: '0.76.179',
  date: '2026-10-02',
  codename: 'Fechar agentes ao reabrir',
  summary:
    'Build do Mac. Ao reabrir o Nexus, o diálogo dos agentes da sessão ' +
    'anterior ganha a opção de fechá-los, além de retomar ou deixar em ' +
    'pausa. Inclui a 0.76.178.',
  highlights: [
    {
      title: 'Fechar os agentes ao reabrir',
      detail:
        'O diálogo "Retomar agentes da sessão anterior?" agora tem três ' +
        'escolhas: deixar em pausa, retomar ou fechar. Esc e Cancelar ' +
        'deixam em pausa e nunca fecham nada.',
    },
  ],
  fixes: [
    {
      title: 'Fechar não derruba um agente que já começou',
      detail:
        'Se a Main adotou o agente ou ele virou parte de uma missão com o ' +
        'diálogo aberto, "Fechar agentes" o deixa como está.',
    },
  ],
};

export const RELEASE_076182: AppRelease = {
  version: '0.76.182',
  date: '2026-10-02',
  codename: 'Mac em dia',
  summary:
    'Build do Mac que reúne o que saiu nas versões 0.76.177 a 0.76.179: ' +
    'o diálogo de reabrir ganha "Fechar agentes", o Maestro bloqueado ' +
    'sempre tem Retomar e os helpers abrem mais rápido. Inclui a 0.76.179.',
  highlights: [
    {
      title: 'Fechar os agentes ao reabrir',
      detail:
        'O diálogo "Retomar agentes da sessão anterior?" agora tem três ' +
        'escolhas: deixar em pausa, retomar ou fechar. Esc e Cancelar ' +
        'deixam em pausa e nunca fecham nada.',
    },
    {
      title: 'O Maestro bloqueado sempre tem saída',
      detail:
        'Um bloqueio que o Maestro declara não vira mais "encerrada pelo ' +
        'operador" por engano, e a missão sempre mostra Retomar.',
    },
    {
      title: 'Missão parada à vista no Quadro',
      detail:
        'Missão parada, dormindo ou sem sessão aparece em "Precisa de você", ' +
        'e o card da missão sem processo ganha Remover, com confirmação.',
    },
  ],
  fixes: [
    {
      title: 'Qwen, Devin e MiMo começam a trabalhar',
      detail:
        'O Qwen volta a abrir, o brief do Devin espera a colagem antes do ' +
        'Enter e o worker MiMo retomado não fecha mais sozinho.',
    },
  ],
};
export const RELEASE_076183: AppRelease = {
  version: '0.76.183',
  date: '2026-10-02',
  codename: 'Skills escolhidas pelo Jev',
  summary:
    'O Jev escolhe também entre as skills instaladas no seu projeto, não só ' +
    'entre as que vêm com o Nexus, e avisa o agente qual SKILL.md ler: no ' +
    'helper que o Maestro abre e no pedido que você digita num pane do ' +
    '"+ Pane". Inclui a 0.76.182.',
  highlights: [
    {
      title: 'As skills do projeto chegam sozinhas ao agente',
      detail:
        'As skills em .claude/skills e .nexus/skills do projeto, que antes ' +
        'precisavam ser arrastadas do painel Skills para o pane, entram na ' +
        'escolha do Jev (ou do Clef, no modo Automático ou Somente Clef). ' +
        'Quando uma delas serve para a tarefa, o helper recebe o caminho do ' +
        'SKILL.md no brief.',
    },
    {
      title: 'Dica de skill no pedido digitado',
      detail:
        'Quando o Jev tem confiança alta de que uma skill ajuda no pedido que ' +
        'você digitou num pane do "+ Pane", o agente recebe a dica junto com ' +
        'o pedido, no máximo uma vez a cada 30 minutos para a mesma skill.',
    },
  ],
  fixes: [
    {
      title: 'Mais escolhas de skill com confiança',
      detail:
        'As skills do projeto são uma pergunta separada das que vêm com o ' +
        'Nexus. Juntas numa lista só, a confiança se espalhava. Em 60 tarefas ' +
        'reais, as escolhas confiantes passaram de 12 para 21.',
    },
  ],
};
export const RELEASE_076184: AppRelease = {
  version: '0.76.184',
  date: '2026-10-02',
  codename: 'Skills sem espera',
  summary:
    'O Jev escolhe também entre as skills instaladas no seu projeto e avisa ' +
    'o agente qual SKILL.md ler, sem atrasar o pedido que você digita num ' +
    'pane do "+ Pane". Inclui a 0.76.183, que não foi publicada no Windows.',
  highlights: [
    {
      title: 'As skills do projeto chegam sozinhas ao agente',
      detail:
        'As skills em .claude/skills e .nexus/skills do projeto, que antes ' +
        'precisavam ser arrastadas do painel Skills para o pane, entram na ' +
        'escolha do Jev (ou do Clef, no modo Automático ou Somente Clef). ' +
        'Quando uma delas serve para a tarefa, o helper recebe o caminho do ' +
        'SKILL.md no brief, e o pedido digitado no "+ Pane" recebe a dica.',
    },
  ],
  fixes: [
    {
      title: 'A dica de skill não atrasa o seu pedido',
      detail:
        'A consulta da skill roda junto com a sugestão de delegação e tem o ' +
        'mesmo limite de tempo. Com o Jev lento, o pedido segue sem a dica em ' +
        'vez de esperar e perder também a sugestão de delegação.',
    },
    {
      title: 'Skills de fora do projeto não entram na escolha',
      detail:
        'Uma pasta .claude/skills que aponta para fora do projeto é ignorada, ' +
        'como já fazia o painel Skills, e nome de pasta fora do formato de ' +
        'skill não chega ao agente.',
    },
  ],
};
export const RELEASE_076185: AppRelease = {
  version: '0.76.185',
  date: '2026-10-02',
  codename: 'Marketplace recomendado',
  summary:
    'O Marketplace mostra os agentes e as instruções que o Jev escolheu para ' +
    'a stack do seu projeto, cada um com o motivo. Instalar continua com a ' +
    'mesma confirmação. Inclui a 0.76.184.',
  highlights: [
    {
      title: 'Recomendados para este projeto',
      detail:
        'O Nexus lê a stack pelos arquivos do projeto (React, Go, Docker, ' +
        'Supabase, testes…) e o Jev, ou o Clef, escolhe no catálogo o agente e ' +
        'a instrução que mais ajudam em cada parte. Cada item diz para qual ' +
        'parte foi escolhido e em qual arquivo ela apareceu. Nada é instalado ' +
        'sem o seu clique.',
    },
  ],
  fixes: [
    {
      title: 'Só o necessário sai da máquina',
      detail:
        'Para recomendar, o modelo de decisão recebe apenas os nomes das ' +
        'tecnologias e dos itens do catálogo, nunca caminhos, o nome do ' +
        'projeto ou conteúdo de arquivo. A recomendação pode ser desligada em ' +
        'Orquestração, entre as superfícies dos modelos de decisão.',
    },
  ],
};

export const RELEASE_076188: AppRelease = {
  version: '0.76.188',
  date: '2026-10-02',
  codename: 'Bug à vista, anexo no pane, cotas à vista',
  summary:
    'Build do Mac. Reportar um bug fica à vista em qualquer tela, arrastar ' +
    'um arquivo para o pane entrega ao agente o caminho onde ele realmente ' +
    'está, o card de cotas expande para todas as contas e o Redline ganha um ' +
    'modo ampliado para print.',
  highlights: [
    {
      title: 'Reportar bug em qualquer tela',
      detail:
        'Botão "Reportar bug" no topo da barra lateral e na tela de acesso ' +
        'bloqueado, e o atalho ⌘⇧B (Ctrl+Shift+B) em qualquer lugar.',
    },
    {
      title: 'Arquivo arrastado chega ao agente',
      detail:
        'Imagem, áudio ou qualquer arquivo solto no pane agora vai com o ' +
        'caminho exato onde foi guardado, também em abas com worktree.',
    },
    {
      title: 'Todas as cotas num clique',
      detail:
        'O card "Cotas" da barra lateral expande para todas as contas, com ' +
        'o consumo e as janelas de cada uma, e recolhe com outro clique.',
    },
    {
      title: 'Redline ampliado para print',
      detail:
        'O painel da barra de menu tem um modo ampliado que mostra todas as ' +
        'contas de uma vez, sem rolagem, e fica aberto para a captura de tela.',
    },
  ],
  fixes: [
    {
      title: 'Nome longo não esconde o percentual',
      detail:
        'No card de cotas, um e-mail comprido agora é cortado com reticências ' +
        'em vez de empurrar o percentual para fora da borda.',
    },
  ],
};
export const RELEASE_076189: AppRelease = {
  version: '0.76.189',
  date: '2026-10-02',
  codename: 'Entrar pelo Perfil Nexus',
  summary:
    'No Windows, "Perfil e logins" do navegador deixa de ser um beco sem ' +
    'saída: você digita o site, a aba passa ao Perfil Nexus e abre para você ' +
    'entrar uma vez. Inclui a 0.76.188.',
  highlights: [
    {
      title: 'Entrar nos seus sites pelo Perfil Nexus',
      detail:
        'Onde o Chrome não deixa outros programas lerem os logins dele, como ' +
        'no Windows, a seção explica por quê e oferece um campo de endereço. O ' +
        'site abre na própria aba, já no Perfil Nexus; o login feito ali fica ' +
        'salvo e chega aos agentes quando "Usar o perfil em novos navegadores ' +
        'dos agentes" está ligado.',
    },
  ],
  fixes: [],
};

export const RELEASE_076190: AppRelease = {
  version: '0.76.190',
  date: '2026-10-02',
  codename: 'Linux em dia',
  summary:
    'Versão do Linux com tudo que Mac e Windows receberam desde a 0.76.178, ' +
    'uma correção de segurança na sandbox dos agentes e o pacote RPM ' +
    'corrigido para o Fedora.',
  highlights: [
    {
      title: 'Sandbox dos agentes mais fechada no Linux',
      detail:
        'Se você instalou o Node em ~/.local/bin, os agentes podiam ler ' +
        'arquivos de ~/.local/share, como chaveiros e credenciais de CLIs. ' +
        'Isso foi corrigido: a sandbox não expõe mais esses diretórios.',
    },
    {
      title: 'Fedora e openSUSE abrem o Nexus em instalações enxutas',
      detail:
        'O pacote RPM agora traz a biblioteca de áudio que o app exige. ' +
        'Antes, num Fedora sem ela, o Nexus nem abria.',
    },
    {
      title: 'Tudo que chegou ao Mac e ao Windows',
      detail:
        'Fechar agentes ao reabrir, helpers sem espera, skills escolhidas ' +
        'pelo Jev, recomendados do Marketplace, "Reportar bug" à vista, ' +
        'anexo no pane e cotas de todas as contas na barra lateral.',
    },
  ],
  fixes: [],
};
export const RELEASE_076191: AppRelease = {
  version: '0.76.191',
  date: '2026-10-05',
  codename: 'Login que fica',
  summary:
    'O login do Nexus deixa de cair a cada reinício, e o Pro pode ser ' +
    'assinado por trimestre, semestre ou ano, com cupom de desconto.',
  highlights: [
    {
      title: 'Pro trimestral, semestral ou anual, com cupom',
      detail:
        'Ao assinar, escolha o período e, se tiver, digite um cupom. O mensal ' +
        'continua com o mesmo preço.',
    },
  ],
  fixes: [
    {
      title: 'O login do Nexus não cai mais a cada reinício',
      detail:
        'Quando o servidor recusava a renovação da sessão, o app guardava a ' +
        'sessão vencida e a reapresentava a cada 30 segundos e ao abrir. Cada ' +
        'tentativa fazia o servidor encerrar o login de todos os seus apps ' +
        'desktop, inclusive o que você tinha acabado de fazer. Agora o app ' +
        'esquece a sessão recusada e o servidor só encerra tudo diante de ' +
        'reuso real.',
    },
  ],
};

export const RELEASE_076193: AppRelease = {
  version: '0.76.193',
  date: '2026-10-05',
  codename: 'Terminais e missões em dia',
  summary:
    'Integra as correções de terminais, recuperação de missões e memória ' +
    'compartilhada, com proteções para manter a janela respondendo durante a saída dos agentes.',
  highlights: [
    {
      title: 'O Nexus não congela mais com muitos agentes',
      detail:
        'Com uma dúzia de agentes trabalhando, a janela podia congelar por minutos: alguns padrões da ' +
        'detecção de limite levavam 300 ms por leitura. Agora cada leitura leva menos de 1 ms, e um pane ' +
        'cuja leitura passe de 25 ms espera alguns segundos antes da próxima.',
    },
    {
      title: 'Mais fôlego com vários terminais',
      detail:
        'A análise da saída roda fora da janela principal e recebe texto em lotes. ' +
        'Um agente que produz texto demais tem sua velocidade limitada; ' +
        'a janela avisa quando o Nexus está ocupado.',
    },
    {
      title: 'Memória compartilhada com origem conferida',
      detail:
        'As CLIs recebem o contexto pelo canal que cada uma suporta. ' +
        'A memória relaciona decisões e arquivos afetados, sem promover ' +
        'texto não verificado a instrução confiável.',
    },
    {
      title: 'Entregas e retomadas mais seguras',
      detail:
        'A retomada mantém a conta, o modelo e a pasta da sessão. ' +
        'Se o helper enviar apenas um resumo, o Nexus preserva uma cauda ' +
        'sanitizada do terminal antes de fechar e avisa que pode estar incompleta.',
    },
  ],
  fixes: [
    {
      title: 'Diagnóstico de travamentos',
      detail:
        'O registro de travamentos inclui amostras das funções em execução ' +
        'e contexto de atividade, para que a próxima investigação tenha provas.',
    },
    {
      title: 'Worktrees e credenciais',
      detail:
        'Criar uma worktree usa Git assíncrono. Novas pastas gerenciadas no Mac ' +
        'ficam fora da indexação do Spotlight; as existentes são preservadas. ' +
        'Chave Qwen inválida deixa de aparecer como pronta para uso.',
    },
    {
      title: 'Cópias de trabalho dos agentes não acumulam mais no disco',
      detail:
        'Ao fechar o pane de um agente de missão, a cópia de trabalho dele é removida ' +
        'quando o trabalho já foi integrado. Cópias limpas paradas há mais de um dia saem aos poucos; ' +
        'as que têm alterações não salvas ficam, com uma salvaguarda Git. Sem clone rápido, o Nexus ' +
        'não copia mais as dependências arquivo por arquivo.',
    },
    {
      title: 'Fila de compilação e testes para todas as CLIs',
      detail:
        'Muse, AGY e Devin entram na mesma fila de comandos pesados das outras CLIs. ' +
        'Serviços MCP que ficam abertos a sessão inteira não ocupam mais a vez de um build. ' +
        'O login e as configurações de cada CLI continuam no lugar.',
    },
    {
      title: 'Panes da missão abrem de novo com qualquer CLI',
      detail:
        'Panes de AGY, DeepSeek, Grok e outras CLIs podiam mostrar "failed to start" com o agente ' +
        'rodando por trás, quando a conta ou o modelo tinha sido reescolhido. O pane agora se liga ' +
        'ao agente que já está rodando.',
    },
    {
      title: 'Missões não ficam mais paradas esperando agente que caiu',
      detail:
        'Quando um agente cai ou um aviso de esteira parada fica na fila, o orquestrador volta a ser ' +
        'chamado, com intervalo crescente. Um reinício do app não bloqueia mais a CLI como se ' +
        'os agentes dela tivessem falhado.',
    },
    {
      title: 'Agentes começam a trabalhar assim que abrem',
      detail:
        'O AGY passa direto pela pergunta de confiança da pasta, Devin e Kimi recebem a tarefa sem ' +
        'ficar com o texto parado na caixa, e pedir uma CLI pelo nome no meio da conversa é respeitado.',
    },
    {
      title: 'Grafo da missão legível com muitos agentes',
      detail:
        'Com muitos helpers, os cabos do grafo correm em faixas e não cruzam os cartões. ' +
        'Um cabo sem caminho seguro vira uma curva simples em vez de quebrar a tela.',
    },
    {
      title: 'Memória e roteamento mais precisos',
      detail:
        'O alerta de memória parada considera a atividade da missão. Correções relatadas pelos agentes ' +
        'viram memória de problema resolvido, e o roteamento respeita o tamanho de contexto de cada modelo.',
    },
  ],
};
export const RELEASE_076194: AppRelease = {
  version: '0.76.194',
  date: '2026-10-05',
  codename: 'Windows de volta',
  summary:
    'O Windows recebe tudo o que saiu no Mac desde a 0.76.188. O instalador ' +
    'sai sem assinatura digital até a versão da Microsoft Store chegar.',
  highlights: [
    {
      title: 'Windows em dia com o Mac',
      detail:
        'O instalador do Windows volta a sair e traz as correções das versões ' +
        '0.76.189 a 0.76.193: o app não congela com muitos agentes, as missões ' +
        'não param no meio e os workers nascem trabalhando.',
    },
  ],
  fixes: [
    {
      title: 'Aviso do Windows ao instalar',
      detail:
        'Por enquanto o instalador não tem assinatura digital. Ao instalar pelo ' +
        'site, o Windows mostra "O Windows protegeu o computador": clique em ' +
        '"Mais informações" e depois em "Executar assim mesmo". Quem já tem o ' +
        'Nexus instalado atualiza sem esse aviso. A versão assinada virá pela ' +
        'Microsoft Store.',
    },
  ],
};
export const RELEASE_076195: AppRelease = {
  version: '0.76.195',
  date: '2026-10-05',
  codename: 'Atualizar o Codex de volta',
  summary:
    'O botão de atualizar o Codex volta a funcionar para quem o instalou ' +
    'pelo instalador oficial ou pelo Homebrew, sem mais o erro de canal.',
  highlights: [
    {
      title: 'Atualizar o Codex pelo app',
      detail:
        'O Nexus agora reconhece o Codex instalado pelo instalador oficial e ' +
        'pelo Homebrew, não só pelo npm, e atualiza cada um pelo seu canal.',
    },
  ],
  fixes: [
    {
      title: 'Atualizar o Codex pelo app',
      detail:
        'Quem instalou o Codex pelo instalador oficial (chatgpt.com/codex/' +
        'install.sh) ou pelo Homebrew via o app recebia "Não reconheci o canal ' +
        'da CLI usada pelo pane" ao atualizar. Agora o app reconhece esses dois ' +
        'canais: a instalação oficial é reexecutada no lugar e a do Homebrew ' +
        'usa "brew upgrade --cask codex". As instalações por npm continuam ' +
        'iguais.',
    },
  ],
};

export const RELEASE_076197: AppRelease = {
  version: '0.76.197',
  date: '2026-10-05',
  codename: 'Panes abrem, missão continua',
  summary: 'Corrige a falha que impedia abrir panes no Mac e preserva o coordenador quando a missão precisa de recuperação.',
  highlights: [
    { title: 'Panes voltam a abrir no Mac', detail: 'A inicialização do zsh grava seus caches na configuração do usuário, preservando a assinatura do aplicativo.' },
    { title: 'Missão bloqueada mantém o coordenador', detail: 'O coordenador continua disponível para conversar e retomar. Encerrar por sua ordem continua encerrando os processos.' },
  ],
  fixes: [
    { title: 'Falha de abertura com código 76', detail: 'O cache de completamento do zsh podia ser gravado dentro do pacote assinado e impedir todos os panes seguintes. Os arquivos de inicialização agora recebem o diretório correto do usuário.' },
    { title: 'Ociosidade não encerra a missão', detail: 'Após uma hora aguardando workers sem progresso, o supervisor avisa o coordenador sem bloquear nem matar os panes.' },
    { title: 'Bloquear não mata o próprio Maestro', detail: 'Um bloqueio pausa o despacho e encerra workers, mas conserva o coordenador legítimo para recuperação. O comando Encerrar permanece explícito e efetivo.' },
    { title: 'Panes isolados abrem juntos', detail: 'Duas criações simultâneas de worktree não disputam mais o registro interno do Git. Só esse registro é ordenado; cópias e trabalho dos agentes seguem em paralelo.' },
    { title: 'Retomar recupera o processo ausente', detail: 'O botão Retomar verifica o processo mesmo quando a missão já está marcada como em execução, em vez de retornar sem fazer nada.' },
  ],
};

export const RELEASE_076198: AppRelease = {
  version: '0.76.198',
  date: '2026-10-05',
  codename: 'Preferências que ficam',
  summary: 'Protege o modo Automático e o Account ID Cloudflare dos clientes contra regravações de outras configurações.',
  highlights: [
    { title: 'Modo e Account ID preservados', detail: 'As preferências de Jev e Clef têm gravação própria. O que já está salvo é importado automaticamente; o token continua no cofre.' },
  ],
  fixes: [
    { title: 'Outra configuração inválida não apaga o Clef', detail: 'Um campo antigo ou inválido da orquestração podia restaurar toda a seção aos padrões, deixando Somente Jev e o Account ID vazio. Agora as preferências válidas dos modelos de decisão são recuperadas independentemente.' },
    { title: 'Cópia antiga do app não remove as preferências novas', detail: 'Uma versão antiga podia regravar settings.json sem conhecer o campo do Clef. A versão nova mantém sua própria cópia validada, inclusive ao reabrir o aplicativo.' },
  ],
};

export const RELEASE_076199: AppRelease = {
  version: '0.76.199',
  date: '2026-10-05',
  codename: 'Linux se atualiza sozinho',
  summary: 'O Linux portátil baixa e troca a própria versão, com assinatura conferida, e o Redline aparece na barra do Omarchy.',
  highlights: [
    { title: 'Atualização automática no Linux', detail: 'Pelo pacote portátil (Arch, Omarchy), o app baixa a versão nova, confere a assinatura e o SHA-256 e se troca ao reiniciar. Sem assinatura válida, nada é aplicado.' },
    { title: 'Redline na barra do Omarchy', detail: 'A bandeja do Omarchy esconde os ícones; agora a pior janela das contas pode ficar sempre visível na barra, com um comando que instala e desfaz o módulo.' },
  ],
  fixes: [
    { title: 'Site sem tremor no Linux', detail: 'O letreiro do sorteio e as animações contínuas ficam parados no Linux desktop, onde apareciam duplicados e tremidos.' },
  ],
};

export const RELEASE_076200: AppRelease = {
  version: '0.76.200',
  date: '2026-10-05',
  codename: 'Linux atualiza pelo sistema',
  summary: 'DEB e RPM ganham repositório apt e dnf assinado, e o aviso de versão nova mostra o comando certo.',
  highlights: [
    { title: 'Atualização pelo apt e pelo dnf', detail: 'Um comando registra o repositório assinado do NexusIDE; depois, o apt upgrade ou o dnf upgrade atualiza o app. É opcional e se desfaz com --remove.' },
  ],
  fixes: [
    { title: 'Troca automática do ZIP mais limpa', detail: 'Resíduo de uma troca que não aconteceu é removido no boot, e o script espera mais tempo o app fechar.' },
  ],
};

export const RELEASE_076201: AppRelease = {
  version: '0.76.201',
  date: '2026-10-05',
  codename: 'A atualização do Linux funciona',
  summary: 'A atualização automática do ZIP portátil do Linux agora termina: o app grava o pacote novo e troca a própria pasta.',
  highlights: [
    { title: 'Linux se atualiza sozinho, de verdade', detail: 'O teste real achou uma falha ao gravar o app.asar da versão nova. Corrigida e coberta por teste no runtime do Electron. Quem está na 0.76.199 ou 0.76.200 pelo ZIP roda o install.sh uma vez.' },
  ],
  fixes: [],
};

export const RELEASE_076202: AppRelease = {
  version: '0.76.202',
  date: '2026-10-05',
  codename: 'Experimente uma equipe inteira',
  summary: 'Teste de 15 dias com seis agentes simultâneos, Pro ilimitado e uma experiência mais clara de terminais e atualização das CLIs.',
  highlights: [
    { title: 'Seis agentes no teste', detail: 'Até seis agentes simultâneos, incluindo o orquestrador, durante os 15 dias. O Pro permite agentes simultâneos ilimitados; consumo e cotas das IAs seguem seus provedores.' },
    { title: 'Uso real no painel administrativo', detail: 'Presença do aplicativo, execução de agentes, primeira missão concluída, retorno em outro dia e assinatura paga aparecem separados. Sem envio de código, prompts ou conteúdo dos projetos.' },
    { title: 'CLIs atualizadas nos três sistemas', detail: 'Manutenção diária de instalações reconhecidas e graváveis no macOS, Windows e Linux, com Qwen incluído. Ligada por padrão quando ainda não há preferência; respeita sua escolha anterior e espera a CLI ficar sem panes ativos. Canais desconhecidos ou com privilégios continuam manuais.' },
  ],
  fixes: [
    { title: 'Quadro distingue terminal vivo', detail: 'Um worker sem processo mostra Sem terminal ativo; o cartão não tenta abrir um pane antigo encerrado.' },
    { title: 'Sonda de versão pode se recuperar', detail: 'Falhas transitórias de leitura de versão deixam de ficar cacheadas indefinidamente.' },
    { title: 'Proteção na troca de login', detail: 'Requisições do login anterior não são reenviadas com a sessão de outra conta.' },
    { title: 'Atualização do Linux preservada', detail: 'Inclui a correção da 0.76.201 para extrair o pacote com original-fs, mantendo a atualização real do ZIP.' },
  ],
};


export const RELEASE_076209: AppRelease = {
  version: '0.76.209',
  date: '2026-10-07',
  codename: 'Missões com entrega verificada',
  summary: 'Mais controle de memória, envio confiável aos agentes e revisão independente antes de concluir missões de código.',
  highlights: [
    { title: 'Seis agentes para experimentar', detail: 'O teste de 15 dias permite até seis agentes simultâneos, incluindo o orquestrador. No Pro, a licença não limita agentes; a execução respeita a capacidade da máquina e as cotas dos provedores.' },
    { title: 'Execução ajustada à memória', detail: 'A admissão automática considera processos e memória disponíveis. Compilações e testes pesados compartilham uma fila por projeto, e a reserva só é liberada quando o processo termina.' },
    { title: 'Conclusão com evidência', detail: 'Missões de código passam por verificações aplicáveis e revisão independente da entrega atual. Achados voltam ao orquestrador para correção, tanto nas missões comuns quanto nas iniciadas por um pane.' },
    { title: 'Quadro em destaque', detail: 'Tela inteira, orientação horizontal ou vertical, zoom e ajuste da visão. Os cartões acompanham os terminais e a atividade atual da missão.' },
  ],
  fixes: [
    { title: 'Abre mesmo com o Mac lento', detail: 'Se o terminal nativo demora a responder na abertura, o Nexus inicia assim mesmo. Até essa preparação terminar, os agentes não executam comandos pesados; ela é refeita em segundo plano e antes de abrir cada agente. Quando a abertura falha, o aviso mostra o motivo.' },
    { title: 'Sem erro fatal do git', detail: 'Uma falha do git ao restaurar os painéis de uma missão não derruba mais o aplicativo. O painel afetado espera alguns minutos antes de tentar de novo, sem travar a interface; falhas do git na abertura também não encerram mais o app.' },
    { title: 'Fila de comandos pesados livre', detail: 'Um agente Codex aberto não ocupa mais a vez das compilações e dos testes do projeto. Os demais agentes deixam de falhar esperando a admissão.' },
    { title: 'Kimi recebe a tarefa', detail: 'Depois de aceitar a confiança na pasta, o Nexus envia o briefing assim que o Kimi fica pronto, em vez de esperar até o painel ser fechado.' },
    { title: 'Modelo do AGY confirmado', detail: 'Missões só usam o Gemini 4 Argon quando a CLI do AGY instalada oferece esse modelo; caso contrário usam o Gemini 3.8 Flash.' },
    { title: 'Revisão aceita a entrega revisada', detail: 'O gasto registrado pelo próprio veredito do revisor não invalida mais a revisão independente. Mudanças reais de objetivo, limites, ferramentas ou equipe continuam exigindo nova revisão.' },
    { title: 'Encerrar mantém a missão parada', detail: 'Recuperações automáticas e spawns pendentes respeitam o encerramento. Só a retomada explícita reabre a missão e vincula o novo terminal do Maestro.' },
    { title: 'Verificações que conseguem iniciar', detail: 'Máquinas com muitas ferramentas instaladas deixam de exceder o limite interno do supervisor. As permissões de isolamento permanecem preservadas.' },
    { title: 'Padrão coerente no Maestro', detail: 'Modelo e esforço aprovados acompanham a criação e a retomada do coordenador. A orientação da missão não é recusada por uma diferença entre esses valores.' },
    { title: 'Histórico fiel e encerramento claro', detail: 'O grafo conserva a ferramenta e o modelo reais dos workers encerrados; Encerrar não mostra o aviso incorreto de execução em segundo plano.' },
    { title: 'Dependências de segurança atualizadas', detail: 'Corrige a leitura lenta de documentos TOML e a validação de sub-redes de proxies. A candidata anterior foi retida antes da publicação pelo portão de segurança.' },
    { title: 'Envio ao Kimi confirmado', detail: 'O envio espera a confirmação do transporte e protege o Enter de recuperação quando há um diálogo ativo.' },
    { title: 'Menos bloqueios no trabalho', detail: 'Corrige o loop na leitura de saída que podia ocupar o processo principal. Avisos opcionais sobre versões de dependências deixam de impedir a conclusão da missão.' },
    { title: 'Validação de projetos nativos', detail: 'Verificações de Go e Rust usam a configuração do projeto. Dependências de execução ausentes aparecem como não verificadas, sem inventar um resultado aprovado.' },
    { title: 'Experiência do teste e manutenção', detail: 'Inclui a medição mínima de uso real no painel, sem código ou prompts, e a manutenção automática das CLIs compatíveis nos três sistemas, respeitando suas preferências.' },
  ],
};

export const RELEASE_076210: AppRelease = {
  version: '0.76.210',
  date: '2026-10-08',
  codename: 'O melhor do T3 Code dentro do Nexus',
  summary: 'Diff, paleta, temas e app do celular vindos do T3 Code (MIT), e missões que abrem panes e terminam, provadas por uma missão de ponta a ponta no gate da release.',
  highlights: [
    { title: 'Missões que terminam', detail: 'Writers isolados abrem dentro da missão, comandos leves não caem mais na fila de comandos pesados e cada worktree tem a sua fila. A release só publica se uma missão completa terminar de ponta a ponta.' },
    { title: 'Troca de conta no limite', detail: 'Ao bater o limite de uso, o pane passa para a outra conta conectada da mesma CLI com folga, preservando a conversa e sem levar segredos no pacote de continuidade.' },
    { title: 'Diff e Git novos', detail: 'Realce de sintaxe, modo unificado ou lado a lado, comentário num intervalo de linhas e stage/unstage por arquivo, com código do T3 Code.' },
    { title: 'Paleta com três modos', detail: '⌘K comandos, ⌘P arquivos e ⇧⌘F busca no conteúdo do projeto, com submenus e dicas de teclado.' },
    { title: 'Seu tema do VS Code', detail: 'Importe o tema da interface e do terminal com contraste garantido, remapeie atalhos com aviso de conflito e veja o uso e as cotas somados por ferramenta.' },
    { title: 'Nexus no celular', detail: 'O app Expo pareia pela Remote Bridge no tailnet, mostra panes e missões ao vivo, envia comandos e responde aprovações.' },
  ],
  fixes: [
    { title: 'Aprovação por card', detail: 'Pedidos de permissão do Claude e do Codex aparecem como card no desktop e no celular, e o status não fica preso em "bloqueado".' },
    { title: 'Modelos que a CLI oferece', detail: 'O Nexus só oferece e roteia modelos que a CLI instalada lista; o Gemini 4 Argon entra só quando o AGY o anuncia.' },
    { title: 'Pane do operador na missão', detail: '"+ Pane → Nesta missão" abre na conta que o Main escolheu, em vez de tentar de novo sem parar.' },
    { title: 'Missão do + Pane conclui', detail: 'O done do Maestro passa pela verificação e pela revisão independente e é reverificado quando ele fica ocioso, em vez de deixar a missão em andamento para sempre.' },
    { title: 'Quadro de entregas completo', detail: 'Writers isolados aparecem no quadro, e cada entrega chega ao Maestro uma vez, mesmo em rajada.' },
    { title: 'Timeline fluida', detail: 'A atividade da missão rola leve com milhares de eventos, com carregamento sob demanda e uma rolagem só.' },
    { title: 'Terminal sem faixa preta', detail: 'O rodapé do terminal usa o fundo do tema em temas claros e importados, e os controles que ficavam tapados voltaram a aparecer.' },
    { title: 'Detecção com memória contida', detail: 'A grade libghostty-vt devolve picos de memória em vez de deixar panes novos fora dela e resiste a enxurradas de caracteres invisíveis.' },
    { title: 'Anexos do iPhone', detail: 'Foto HEIC vira JPEG ao anexar, e imagem grande é comprimida em vez de recusada.' },
    { title: 'Bridge remota mais segura', detail: 'Publicar no tailnet com HTTPS, e entrada remota com teclas de controle escondidas é recusada antes de chegar ao terminal.' },
    { title: 'Sessões de navegador', detail: 'Importa sessões de 9 navegadores sem fechá-los, e a chave do Chrome não fica acessível a outros processos.' },
    { title: 'Teste automatizado isolado', detail: 'O modo de teste não lê o Keychain nem executa CLIs de IA no boot.' },
    { title: 'RAM do pane no Linux', detail: 'O badge de RAM não some mais depois de um ajuste do relógio.' },
  ],
};

export const RELEASE_076211: AppRelease = {
  version: '0.76.211',
  date: '2026-10-08',
  codename: 'Atualização que chega sozinha',
  summary: 'A versão nova baixa sozinha em segundo plano e só pede para reiniciar; recusas de conclusão de missão dizem a chamada que o pane pode fazer.',
  highlights: [
    { title: 'Atualização automática', detail: 'Quando sai uma versão nova, o Nexus baixa em segundo plano e o aviso pede só para reiniciar. Antes, ele esperava um clique em "Atualizar agora" e a versão podia ficar horas parada.' },
  ],
  fixes: [
    { title: 'Concluir missão de outro pane', detail: 'A recusa diz quem lidera a missão e como pedir a conclusão a esse pane, em vez de mandar criar outra missão, e não anuncia mais um efeito que não aconteceu.' },
  ],
};

export const RELEASE_076212: AppRelease = {
  version: '0.76.212',
  date: '2026-10-08',
  codename: 'Nexus no celular de verdade',
  summary: 'O app do celular vira cliente completo do desktop Nexus: Git e arquivos, fila offline, notificações, atividade dos panes e permissões por aparelho.',
  highlights: [
    { title: 'Git e arquivos no celular', detail: 'Veja as alterações e o diff de cada arquivo do pane e navegue pelos arquivos, só leitura, presos ao checkout real do pane.' },
    { title: 'Fila offline e notificações', detail: 'Sem conexão, o comando espera e sai em ordem ao voltar, sem digitar duas vezes. Aprovações, "esperando você" e "terminou" avisam no celular.' },
    { title: 'Permissões por aparelho', detail: 'Ao parear, escolha se o celular pode ver, enviar comandos, aprovar ou fechar panes. O desktop confere cada pedido.' },
    { title: 'Histórico de uso', detail: 'Uso e cotas mostra os últimos 30 dias em tokens ou custo de API, com leitura dia a dia pelo teclado.' },
  ],
  fixes: [
    { title: 'Citar na timeline', detail: 'Leve um trecho da atividade da missão para a orientação, com a origem do evento.' },
    { title: 'Abas reordenáveis', detail: 'Arraste, use Alt+Shift+setas ou o menu da aba para mudar a ordem dos Terminais.' },
    { title: 'Mais segredos redigidos', detail: 'Chaves da Stripe, do age e valores secretos em variáveis *_KEY saem como [REDACTED].' },
    { title: 'Missões mais seguras', detail: 'A troca de líder recusa pane somente leitura e um checkpoint atrasado não deixa ref órfã.' },
    { title: 'App em português', detail: 'O app do celular fala pt-BR, usa a marca Nexus e não oferece atalhos que não funcionam no desktop Nexus.' },
  ],
};

export const RELEASE_076233: AppRelease = {
  version: '0.76.233',
  date: '2026-10-10',
  codename: 'Missões com acompanhamento contínuo',
  summary: 'Melhorias no início e na retomada das missões, conclusão com entrega verificada e capturas vinculadas ao terminal escolhido. Inclui decisões por conta e Quadro com participantes vivos.',
  highlights: [
    { title: 'Clef-omni ouve antes de atender', detail: 'Em Modelos de decisão, escolha a variante Clef-omni (texto, imagem e áudio). Com a autorização de áudio ligada, cada detecção de “Hey Jarvis” envia à Cloudflare os cerca de 2 s de áudio que terminam nela, e o Clef-omni ajuda a descartar ativações de TV ou som ambiente; a ativação pode esperar até cerca de 1,5 s. Áudio e capturas só vão à Cloudflare com a sua autorização.' },
    { title: 'Agentes com acesso a tudo', detail: 'Orquestrador, helpers, workers e revisores alcançam toda ferramenta do Nexus e as nativas da CLI. O orquestrador também edita e commita, revisores deixam de ser somente leitura e não há filtro de skill nem bloqueio do WebFetch. Confirmações humanas e o modo Hardened continuam valendo.' },
    { title: 'Luna, Decisions API da OpenAI', detail: 'Em Configurações → Modelos de decisão, escolha Somente Luna (beta) ou Luna junto com Jev e Clef. A chave é a da OpenAI em Chaves de API; a preferência fica nesta conta Nexus.' },
    { title: 'Imagens com autorização por provedor', detail: 'O envio de imagens à OpenAI exige autorização própria. Trocar o modelo ou cadastrar uma chave não concede essa autorização.' },
    { title: 'Quadro com participantes vivos', detail: 'O Quadro acompanha os participantes atuais da missão, mantém o Maestro ocioso visível e oferece controles de zoom sem sobrepor o inspetor.' },
    { title: 'Captura no pane escolhido', detail: 'A captura conserva a sessão e o projeto do destino escolhido. Se o terminal reiniciar ou o projeto mudar antes da entrega, o app pede um destino vivo.' },
    { title: 'Launcher pelo teclado', detail: 'As ações do Launcher respondem aos atalhos de 1 a 6, uma vez por toque; campos de texto preservam a digitação.' },
  ],
  fixes: [
    { title: 'Comandos do Grok no Mac', detail: 'A integração usa o Bash do sistema para evitar a recusa causada pela escolha de outro Bash. Scripts de inicialização exclusivos do Bash 5 precisam ser adaptados.' },
    { title: 'Liderança ligada ao terminal real', detail: 'Criar uma missão pelo MCP preserva o vínculo do Maestro após a sincronização dos panes. A recuperação dos workers reconhece o líder atual.' },
    { title: 'Terminal disponível após encerrar', detail: 'O terminal do operador adotado pela missão volta ao seu controle e permanece aberto quando a missão termina.' },
    { title: 'Missão com modelo automático', detail: 'Terminais que usam o modelo padrão da CLI podem criar a missão pelo MCP e pela interface, sem exigir uma escolha explícita de modelo.' },
    { title: 'Workers rápidos reconhecidos', detail: 'Quando o primeiro turno termina durante a preparação do terminal, o Nexus reconhece o envio do pedido e libera o orquestrador sem repetir o prompt.' },
    { title: 'Envio confirmado no Claude', detail: 'Pedidos e continuidade após retomada aguardam a aceitação do prompt. Se o primeiro Enter não enviar, o Nexus tenta somente o Enter outra vez, sem duplicar o pedido.' },
    { title: 'Maestro acompanha a missão desde o início', detail: 'O início e a retomada mantêm o acompanhamento quando o Maestro começa a delegar durante a preparação. Alterações na missão e encerramento continuam protegidos.' },
    { title: 'Conclusão que continua', detail: 'Missões comuns e iniciadas por um pane preservam a nova tentativa de verificar a entrega quando o Maestro termina o turno durante uma verificação. Encerrar cancela essa retomada.' },
    { title: 'Conta coerente na recuperação', detail: 'Uma troca recusada antes de criar o terminal substituto preserva a conta do terminal original quando sua identidade está comprovada.' },
    { title: 'Ferramentas dos agentes mais rápidas', detail: 'O Nexus deixa de rodar um controle a cada ferramenta de um agente de missão. No Mac cada chamada esperava cerca de 6 segundos; o envio do handoff mantém só a cópia em disco para quando o app não responde.' },
    { title: 'Retomada de worker sem duplicar', detail: 'Retomar um worker fechado reserva a continuação antes de iniciar o processo, para que o terminal antigo e o novo não rodem a mesma conversa ao mesmo tempo. A tarefa continua a mesma e o novo terminal só é registrado depois de iniciar de fato.' },
    { title: 'Orientação no início da missão', detail: 'Enquanto o líder se prepara, a orientação fica na fila. O app distingue a entrega comprovada do pedido ainda pendente e mostra falha sem reenviar para outro pane.' },
    { title: 'API e sessão nativa distintas', detail: 'Uma credencial de API ou transporte não é tratada como login nativo do Claude. A sessão nativa comprovada continua com prioridade sobre a chave de API.' },
    { title: 'Retomada com resultado real', detail: 'O Nexus distingue um pedido de retomada do religamento confirmado, revalida a autoridade após esperas e encaminha a conclusão ao líder atual da missão.' },
    { title: 'Entrega assentada antes de concluir', detail: 'Uma entrega ainda na fila impede a conclusão da missão, mesmo após muitas mensagens do Maestro. O diagnóstico usa o prazo real da tentativa.' },
    { title: 'Comandos pendentes seguram a conclusão', detail: 'As ferramentas de terminal e segundo plano mantêm a pendência até a saída comprovada do comando e seus subprocessos. Reiniciar o app sem essa prova mantém a pendência.' },
    { title: 'Fechamento recusa novas ferramentas', detail: 'Ao iniciar o fechamento, o Nexus recusa novas ferramentas. Pedidos que aguardam confirmação não recebem autorização depois desse ponto.' },
    { title: 'Reenvios ligados ao canal do terminal', detail: 'Reenviar a mesma chamada na mesma sessão e canal do terminal não repete seu efeito. Encerrar o canal impede chamadas que ainda aguardam despacho.' },
    { title: 'Helpers após a preparação do coordenador', detail: 'Os helpers só começam após a preparação confirmada do coordenador. Uma falha não encerra o pane do operador nem substitui uma liderança mais recente.' },
    { title: 'Decisões conservadoras e custo registrado', detail: 'Juntos preserva as exigências de verificação e memória; o uso conhecido continua registrado em recusa, falha parcial ou alteração de configuração, com o nome do conjunto no histórico.' },
    { title: 'Conta escolhida na missão', detail: 'O pane aberto na missão recebe a conta selecionada, e o Main confere a identidade da sessão antes de confirmar a escolha.' },
    { title: 'Limite confirmado por cota medida', detail: 'Uma janela recente com cota esgotada pode confirmar o limite da conta. Texto de terminal e cota sem resposta continuam sem provocar troca imediata.' },
    { title: 'Handoffs paginados', detail: 'A listagem com cursor só marca como vistos os itens devolvidos; cursor inválido não consome entregas.' },
    { title: 'Preview com as proteções do Nexus', detail: 'O preview local preserva os comandos de navegador governados e fecha o acesso experimental de depuração que contornava suas proteções.' },
  ],
};

export const RELEASE_076234: AppRelease = {
  version: '0.76.234',
  date: '2026-10-11',
  codename: 'Motor de decisão em toda missão',
  summary: 'Jev, Clef e Luna acompanham a missão do início ao fim, com orçamento por missão, escolha por custo e qualidade no Automático e dicas ao Maestro que nunca bloqueiam.',
  highlights: [
    { title: 'Orçamento de decisão por missão', detail: 'Cada missão tem um teto para as consultas de Jev, Clef e Luna (padrão US$ 0,50), ajustável em Modelos de decisão. As checagens de segurança fixas no Jev continuam e só entram na conta.' },
    { title: 'Automático por custo e qualidade', detail: 'No modo Automático o motor pesa qualidade e preço: Clef Flash no texto barato e Clef-omni na imagem autorizada. Escolher Jev, Clef, Luna ou Juntos mantém o modelo fixo.' },
    { title: 'Dicas do início ao fim', detail: 'O Maestro recebe sugestão de workers no início (inclusive em missão +pane), risco de cada entrega de código, conselho quando um worker cai e a cobertura do objetivo antes de concluir.' },
    { title: 'Calibrar modelos', detail: 'Mede Jev, Clef e Luna com as suas chaves em 55 casos, mostra o custo antes e pode ser cancelada. Com medição, o Automático junta dois modelos nas decisões reversíveis quando compensa.' },
    { title: 'Motor de decisão na missão', detail: 'A aba Plano mostra o gasto de decisão da missão, o orçamento usado, as chamadas por modelo e as dicas com o modelo que respondeu.' },
  ],
  fixes: [
    { title: 'Custo que sobrevive ao reinício', detail: 'O valor cobrado de cada consulta fica no diário, então reiniciar o app não devolve orçamento à missão.' },
    { title: 'Estatísticas sem a calibração', detail: 'O gasto da calibração aparece à parte e não infla a contagem de decisões.' },
  ],
};

export const RELEASE_076235: AppRelease = {
  version: '0.76.235',
  date: '2026-10-11',
  codename: 'O T3 Code nas telas',
  summary: 'O que veio do T3 Code e ainda não aparecia agora está na tela: texto dos agentes formatado com diagramas, editor rich-text na missão, histórico das CLIs, recursos da máquina e pontos de restauração dos writers.',
  highlights: [
    { title: 'Texto dos agentes formatado', detail: 'Resultado, plano, orientação, linha do tempo, perguntas e notas de memória mostram markdown com títulos, listas, tabelas, código com realce de sintaxe e diagramas Mermaid. HTML do agente aparece como texto e links abrem só http/https no navegador.' },
    { title: 'Editor rich-text na missão', detail: 'Orientação, resposta livre e objetivo da missão e do Expresso usam o editor com negrito, itálico, tachado e código (⌘B, ⌘I, ⌘E). Enter envia na orientação, a citação continua, e o título da missão sai sem marcadores.' },
    { title: 'Histórico das CLIs', detail: 'No menu Cmds do pane e na paleta, "Importar histórico das CLIs" traz os comandos de shell dos agentes deste projeto, sem segredos e sem duplicar. A seção Histórico busca no que foi importado e gravado, com Copiar e Inserir.' },
    { title: 'Recursos da máquina', detail: 'Uso e cotas mostra memória, pico, carga de CPU e o quanto os panes e o Nexus ocupam, com a mesma leitura que decide estacionar panes. O rodapé da barra lateral avisa só quando a memória aperta.' },
    { title: 'Pontos de restauração dos writers', detail: 'A missão lista os checkpoints de cada entrega, na Atividade durante a missão e em O que mudou depois. Restaurar mostra antes o que será sobrescrito, guarda o estado atual e recusa se a árvore mudou desde a prévia.' },
  ],
  fixes: [
    { title: 'Calibração explica a falha', detail: 'Modelo que não respondeu mostra o motivo. Testar a Luna aparece também no Automático e diz se a OpenAI recusou a chave, se a conta não tem acesso à Decisions API (beta) ou se faltou crédito.' },
    { title: 'Runtime WSL mais seguro', detail: 'O terminal em distro WSL só vale no Windows fora do sandbox, roda o binário Linux e repassa o ambiente da sessão sem expor valores na linha de comando.' },
  ],
};

export const RELEASE_076236: AppRelease = {
  version: '0.76.236',
  date: '2026-10-11',
  codename: 'Nexus testado por dentro',
  summary: 'Uma varredura sênior feita de dentro do próprio Nexus: panes voltam a nascer do pane do operador, o app não congela mais com diálogos e o que só falhava no app instalado foi corrigido.',
  highlights: [
    { title: 'Panes voltam a nascer', detail: 'O primeiro helper aberto de um pane do operador morria em ~9 ms desde a 0.76.213. A missão da aba nasce, o helper entra nela e a entrega volta ao pane. O teste de missão da release cobre esse caminho.' },
    { title: 'Nada de app congelado', detail: 'O aviso de atualização e as confirmações de agentes, ACP, celular e voz abrem presos a uma janela, sem parar o Nexus. Sem janela ou com prazo esgotado, a resposta é negar.' },
    { title: 'Fila de comandos pesados por worktree', detail: 'Agentes em worktrees diferentes testam em paralelo. Quando a fila estoura, a mensagem diz quanto tempo esperou e atrás de quem.' },
    { title: 'Ferramentas completas no app instalado', detail: 'Definição, referências e diagnósticos do LSP, OCR, blocos de comando nos terminais e as ferramentas do Nexus em sessões ACP voltam a funcionar fora do ambiente de desenvolvimento.' },
    { title: 'Suíte confiável dentro dos panes', detail: 'Agentes que rodam os testes do Nexus num pane deixam de ver dezenas de falhas falsas; o que só roda fora do pane é pulado com o motivo.' },
  ],
  fixes: [
    { title: 'Scripts estritos nos panes', detail: 'Scripts com set -euo pipefail não morrem mais na segunda linha, e o zsh não entra em recursão.' },
    { title: 'Mac volta a dormir', detail: 'O manter-acordado não deixa mais processos órfãos depois de um crash ou atualização.' },
    { title: 'Code map completo', detail: 'O mapa do projeto não para mais na metade, e a busca acha arquivo pelo nome.' },
    { title: 'Doctor sem alarme falso', detail: 'O Codex volta a contar como revisor independente, e o aviso de attestation diz qual alvo mudou.' },
    { title: 'Ranking de modelos atual', detail: 'Só recomenda modelos instalados, na versão mais nova de cada linha.' },
    { title: 'Portão de regressão justo', detail: 'WIP antigo de outro agente não bloqueia mais o encerramento do pane.' },
  ],
};

export const RELEASE_076237: AppRelease = {
  version: '0.76.237',
  date: '2026-10-11',
  codename: 'Varredura fechada',
  summary: 'Fecha as pendências da varredura sênior: confirmações de agente não seguram mais a fila, a coleta de worktrees fica estável sob carga e o code map não trava o Main.',
  highlights: [
    { title: 'Confirmação que não trava a fila', detail: 'Sem resposta em 10 min, a confirmação pedida por agente é negada (nunca aprovada), o diálogo fecha e as dos outros panes andam. O agente é avisado para pedir de novo.' },
    { title: 'Coleta de worktrees estável', detail: 'Symlink, pasta inválida ou fora da raiz são recusados antes da sonda de processos; com a máquina carregada a coleta segue decidindo certo e nada em uso é removido sem prova.' },
  ],
  fixes: [
    { title: 'Code map sem travar o Main', detail: 'O índice estrutural é lido de forma assíncrona e uma vez só, mesmo com consultas simultâneas.' },
    { title: 'Portão conservador em pane retomado', detail: 'A mudança que culparia o pane pelo WIP de outro agente no checkout compartilhado saiu antes da release.' },
  ],
};

export const RELEASE_076238: AppRelease = {
  version: '0.76.238',
  date: '2026-10-11',
  codename: 'Autoria pela própria conversa',
  summary: 'O portão de regressão passa a saber quais arquivos a própria conversa editou: o pane retomado responde pelo que fez, sem herdar o WIP de outro agente. Hooks mais robustos e CI de Linux validado sem GitHub Actions.',
  highlights: [
    { title: 'Pane retomado responde pelo que fez', detail: 'O Nexus registra os arquivos que a conversa editou, com o hash do conteúdo. Na retomada, só conta como do pane o arquivo que ainda tem esse conteúdo; a reescrita de outro agente continua alheia.' },
    { title: 'Hooks mais robustos', detail: 'Corpo de hook triado logo no início, com tetos por sessão e prazos de recepção no servidor local; o registro tem poda, limpeza e migração.' },
  ],
  fixes: [
    { title: 'Formatador reconhecido', detail: 'O fim do turno atualiza o hash dos arquivos editados, então o format-on-save do próprio agente não apaga a autoria.' },
    { title: 'Testes portáveis para Linux', detail: 'Quatro testes que falhariam no CI de Linux foram corrigidos, e o CI passa a instalar o zsh.' },
  ],
};

export const RELEASE_076239: AppRelease = {
  version: '0.76.239',
  date: '2026-10-12',
  codename: 'Missões que terminam',
  summary: 'Panes que abrem, recebem o prompt e entregam; missões que concluem sem travar por histórico velho nem pela atividade do próprio Maestro; e um processo principal que não para em diálogo.',
  highlights: [
    { title: 'Writers isolados voltam a nascer', detail: 'Um writer antigo que falhou num ref velho não envenena mais o estado: depois de trocar de branch, o próximo writer isolado nasce. A fila de merge também não trava mais o checkout por histórico cheio ou linha ilegível.' },
    { title: 'A missão conclui', detail: 'Erro antigo no histórico não veta mais o done, a atividade do Maestro durante a revisão não anula a conclusão, o trabalho sem commit de outro agente não bloqueia a leitura, e a revisão sem revisor livre reagenda sozinha.' },
    { title: 'Panes que abrem e não se perdem', detail: 'A recusa por teto chega com o motivo real, o prompt colado em blocos é enviado, e o one-shot que trabalha de tela muda não é mais tratado como ocioso.' },
  ],
  fixes: [
    { title: 'Diálogos sem travar o app', detail: 'O aviso de encerramento, o prompt de sair e o consentimento de hooks abrem como sheet na janela, sem prender o processo principal.' },
    { title: 'Roteamento econômico que acerta', detail: 'Palavras soltas não decidem mais o nível da tarefa; o ranking mostra os modelos instalados mais novos e o rodízio de CLIs funciona também sem missão.' },
    { title: 'Ferramentas e atualizador', detail: 'Busca de arquivos, LSP e code map funcionam em arquivo real; o atualizador não faz rajada de checagens nem deixa o ZIP no tmp.' },
  ],
};

export const RELEASE_076240: AppRelease = {
  version: '0.76.240',
  date: '2026-10-12',
  codename: 'Escrever, julgar, devolver',
  summary: 'Os panes escrevem em paralelo, o orquestrador julga e devolve ao mesmo writer; todas as LLMs prontas recebem trabalho; o portão de regressão roda os testes diretos; e a memória injeta o que importa para o arquivo que você está mexendo.',
  highlights: [
    { title: 'Escrever, julgar, devolver', detail: 'O Jev não zera mais a escrita num pedido de correção, e o veredito "refazer" volta ao mesmo writer — pelo PTY, pelo resume ou num pane novo na mesma worktree, em qualquer CLI e também em missão com squad.' },
    { title: 'Todas as LLMs trabalham', detail: 'O roteamento espalha por uso entre as CLIs prontas, a preferência é um empurrão e não um pin, o Kimi é preferido em front sem monopolizar, e prompt grande vai para um arquivo privado.' },
    { title: 'Portão de regressão que roda', detail: 'Os testes diretos rodam primeiro, dentro do prazo, com retentativa e comparação com a base; o recibo diz o que não rodou e por quê.' },
  ],
  fixes: [
    { title: 'Memória e modelo de negócio', detail: 'Invariantes escolhidos pelos arquivos que a conversa editou, busca por F-XXXX exata e recibos vazios fora da memória injetada.' },
    { title: 'Estado real dos panes', detail: 'One-shot trabalhando aparece ocupado, o minimax "Loading" conta como trabalho, sem alarme falso de travado e sem index.lock órfão.' },
    { title: 'Segurança e configuração', detail: 'O audit não vaza segredo, o startKey não é exposto, segredo em args de MCP vai para o cofre, o playwright do hub volta a abrir e o Muse isola a sessão por pane.' },
  ],
};

export const RELEASE_076241: AppRelease = {
  version: '0.76.241',
  date: '2026-10-12',
  codename: 'Windows de verdade',
  summary: 'Suíte inteira rodada num Windows real: os anexos lacrados, o Pet Studio e o consent do smoke deixam de falhar por detalhes POSIX que não existem no NTFS.',
  highlights: [
    { title: 'Anexos lacrados funcionam no Windows', detail: 'O selo passa a usar o bit read-only do NTFS e as provas dev/ino/nlink, que são reais lá; modo POSIX 0o700/0o400 só é exigido onde existe.' },
    { title: 'Pet Studio instala de ponta a ponta', detail: 'O fsync pedia um handle de leitura, que o Windows recusa; agora abre para escrita e o pacote completo instala sem EPERM.' },
    { title: 'Consent do smoke aceita perfil Windows', detail: 'A checagem de diretório privado não exige mais uid/modo POSIX no Windows — perfil de usuário já é privado por ACL.' },
  ],
  fixes: [
    { title: 'Durabilidade sem fsync de diretório', detail: 'No Windows o rename já é o commit; fsync de diretório (EPERM) só roda em POSIX.' },
    { title: 'Fixture do atualizador correta', detail: 'O teste F-1280 stuba TEMP/TMP, que é o que os.tmpdir() lê no Windows.' },
  ],
};

export const RELEASE_076242: AppRelease = {
  version: '0.76.242',
  date: '2026-10-12',
  codename: 'Cada LLM no seu lugar',
  summary: 'O Muse Wonder Full no esforço máximo lidera o front e o julgamento; o front reveza entre os melhores modelos e Next.js e jogos vão para o Opus; o ditado chega ao painel ocupado; o Nexus atualiza todas as CLIs ao iniciar; o Nexus confere se cada worker começou e mostra a cota de cada conta.',
  highlights: [
    { title: 'Muse Wonder e Wonder Full', detail: 'Os modelos novos da Meta entram no Nexus com os números oficiais. O Wonder Full no esforço máximo lidera a revisão e o front, os modelos contributor ficam nas tarefas menores com o seu consentimento, e o catálogo do próprio Muse é lido sozinho.' },
    { title: 'Ditado que chega', detail: 'Com o painel ocupado, o ditado entra na fila; com uma pergunta aberta, espera e entra sozinho quando o painel fica livre. Nada é entregue duas vezes, e o HUD diz o que está acontecendo.' },
    { title: 'CLIs sempre atualizadas', detail: 'Ao iniciar, o Nexus confere e atualiza todas as CLIs. Claude, Devin e Grok atualizam mesmo com painel aberto; as demais, quando o último painel delas fecha. Cask só com manifesto sem privilégio.' },
  ],
  fixes: [
    { title: 'Cada LLM no seu lugar', detail: 'Front em revezamento entre Opus, Sonnet, Wonder Full, Kimi, Sol e Devin; Next.js e jogos no Opus; GLM 5.3 no código e o Flash nas tarefas leves e de imagem; revisão de segurança nunca num modelo econômico; sem limite de um painel Claude por conta.' },
    { title: 'Nenhum trabalho sem dono', detail: 'O Nexus confere se o worker de fato começou e, se não, reabre a tarefa em outra CLI na mesma worktree; os workers fecham ao entregar; o Maestro é avisado quando faz tudo sozinho.' },
    { title: 'Cota de cada conta', detail: 'Conta logada não aparece mais como sessão expirada, a cota de cada conta só é mostrada com a identidade provada, e Muse, OpenClaude e Alibaba Token Plan ganharam sondas de cota no Redline.' },
    { title: 'Telas', detail: 'Painel Git estreito sem sobreposição, o navegador do Stage não rola por cima dos outros painéis, e a falha de atualização de CLI aparece clara no painel de Providers.' },
  ],
};

export const RELEASE_076243: AppRelease = {
  version: '0.76.243',
  date: '2026-10-13',
  codename: 'Herança do T3',
  summary: 'O terminal ganha a janela de ACK do T3 e o Nexus herda do T3 Code o assistente de primeira execução, o chip de contexto, o seletor de fontes e o editor de tema; panes com spinner não viram erro, o brief não é colado duas vezes, a missão recusada volta ao Maestro e worktree criada à mão nunca é apagada.',
  highlights: [
    { title: 'Terminal mais leve', detail: 'No máximo 8 pedaços de saída em voo por terminal: rajadas não entopem mais a ponte do Electron, e o fim da saída chega inteiro antes do terminal fechar.' },
    { title: 'Primeira execução guiada', detail: 'Instalação nova abre um assistente de 4 etapas — chaves, agentes, projeto e como usar — e um checklist que só marca o que você de fato fez. Quem atualiza não vê o assistente.' },
    { title: 'Fontes, tema e contexto', detail: 'Escolha as fontes da interface, do código e do terminal, edite os 14 papéis do tema e veja no pane quanto da janela de contexto do modelo a última rodada usou.' },
  ],
  fixes: [
    { title: 'Panes lidos certo', detail: 'Spinner de Devin, Claude, Kimi e MiMo conta como trabalhando, não como erro, e o brief do Devin não é mais colado duas vezes: o reenvio é só o Enter.' },
    { title: 'Missões que terminam', detail: 'Erro de provedor parado reabre a tarefa noutra CLI; recusa do verificador volta ao Maestro e a missão segue rodando; limite de leitura vira ressalva na nota em vez de travar a conclusão.' },
    { title: 'Worktrees protegidas', detail: 'Worker aberto numa worktree já existente é adotado com recibo e rework, e o Nexus nunca apaga a pasta nem a branch de uma worktree criada à mão.' },
    { title: 'Portão de push', detail: 'O portão mede o checkout real de cd e git -C; caminho com expansão, inexistente ou com erro de git bloqueia, e o veredito de revisão amarra o HEAD exato revisado.' },
  ],
};

export const RELEASE_076244: AppRelease = {
  version: '0.76.244',
  date: '2026-10-13',
  codename: 'Argon liberado',
  summary: 'O Gemini 4 Argon volta a ser usado pelo Nexus: o AGY 1.3.4 o lista com sufixo de esforço, e a rota agora reconhece essas variantes como prova de acesso da sua conta.',
  highlights: [
    { title: 'Gemini 4 Argon na rota', detail: 'Com o Argon liberado na sua conta do AGY, tarefas difíceis e revisões voltam a usá-lo em vez de cair no Gemini 3.8 Flash; o esforço pedido escolhe a variante (baixo, médio ou alto).' },
  ],
  fixes: [
    { title: 'Acesso ao Argon reconhecido', detail: 'O Nexus dizia "sem acesso ao Argon nesta conta" mesmo com acesso, porque procurava o nome antigo do modelo. Se a conta for recusada, o Argon sai da rota por 12 horas sem insistir.' },
  ],
};

export const RELEASE_076245: AppRelease = {
  version: '0.76.245',
  date: '2026-10-13',
  codename: 'Multi-conta no Antigravity e login sem tropeço',
  summary: 'Você pode cadastrar e alternar várias contas Google no Antigravity (agy) e nas demais CLIs sem perder a sessão anterior; o terminal de login abre mesmo vindo do Início ou em máquinas com partida mais lenta do PowerShell, e a lista de Providers mostra "10 modelos" em vez de "10/10".',
  highlights: [
    { title: 'Várias contas no Antigravity e em todas as CLIs', detail: 'Ao adicionar outra conta do Antigravity no Windows, o Nexus guarda a conta atual no cofre e libera a vaga local para o navegador abrir o login da nova conta — sem desconectar a anterior no Google — e sincroniza o cofre ao clicar em "Usar".' },
    { title: 'Contagem clara de modelos em Providers', detail: 'A lista lateral de Providers agora mostra "10 modelos" (em vez de "10/10" ou "13/15"), deixando claro que o número é o total de modelos da ferramenta e não consumo de cota.' },
  ],
  fixes: [
    { title: 'Terminal de login sempre disponível', detail: 'Abrir o login de uma CLI a partir do Início reabre automaticamente o projeto recente (ou pede uma pasta) e aguarda até 60 segundos pela partida do terminal, eliminando o erro "O terminal não ficou disponível. O login não foi iniciado.".' },
  ],
};

export const RELEASE_076249: AppRelease = {
  version: '0.76.249',
  date: '2026-10-13',
  codename: 'Linux em dia com o Mac e o Windows',
  summary: 'O app no Omarchy, no Debian e no Ubuntu deixa a 0.76.201 e passa a incluir tudo o que o Mac e o Windows receberam até a 0.76.245: missões que concluem, cada modelo no seu lugar e as telas novas.',
  highlights: [
    { title: 'Missões que terminam', detail: 'Writers isolados voltam a nascer, a conclusão não trava num erro antigo e a revisão independente aceita a entrega atual.' },
    { title: 'Cada modelo no que faz de melhor', detail: 'Argon e Wonder Full entram na rota, o front reveza entre as CLIs e Next.js e jogos ficam com o Opus. Vários panes Claude da mesma conta convivem.' },
    { title: 'Telas, ditado e celular', detail: 'Markdown, editor da missão, diff do Git e checkpoints dos writers. O ditado não se perde com o pane ocupado, e o celular pareado controla o desktop.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'Da 0.76.202 à 0.76.245 só havia pacote de Mac ou Windows. O Omarchy consultava o espelho e ficava na 0.76.201, achando que já estava na mais recente.' },
  ],
};
export const RELEASE_076250: AppRelease = {
  version: '0.76.250',
  date: '2026-10-13',
  codename: 'Comandos pesados de volta no Windows',
  summary: 'No Windows, testes, typecheck, build e npm install rodados pelo Bash de um pane Claude voltam a rodar, a fila de comandos pesados não trava mais e toda recusa diz o motivo real.',
  highlights: [
    { title: 'Testes e build pelo Bash no Windows', detail: 'O Git Bash numera os processos do jeito dele e o Nexus procurava o comando pelo número errado. Agora vai o número do Windows, e os workers de squad e de missão voltam a testar e compilar.' },
  ],
  fixes: [
    { title: 'Fila de comandos pesados presa', detail: 'Um processo antigo, com número reaproveitado pelo Windows, era confundido com filho de um teste e a vaga do projeto nunca voltava. Agora só conta como filho quem nasceu depois do pai.' },
    { title: 'Recusa com o motivo real', detail: 'A mensagem diz se foi outro job na mesma pasta, o limite de jobs da máquina, swap ou RAM abaixo da reserva. A RAM só é citada quando falta RAM.' },
  ],
};
export const RELEASE_076251: AppRelease = {
  version: '0.76.251',
  date: '2026-10-13',
  codename: 'Campo em dia',
  summary: 'O Maestro do «+ Pane» volta a delegar em vez de trabalhar sozinho, ditar segurando Space não derruba mais o app no macOS, a segunda conta do Antigravity entra, um erro de autenticação citado no terminal não troca mais a conta de uma missão que estava funcionando, um squad salvo que não abria mais no editor volta a abrir, e o pane do Muse com login nativo não decreta mais «sessão expirada» sobre uma credencial que está funcionando.',
  highlights: [
    { title: 'Maestro que delega', detail: 'O orquestrador criado pelo «+ Pane» recebia os pedidos e executava tudo no próprio terminal, sem abrir workers. Agora ele recebe a doutrina de delegar e o vigia de esteira cobra quando a missão fica sem workers.' },
  ],
  fixes: [
    { title: 'Ditado sem crash no macOS', detail: 'Segurar Space para ditar derrubava o app no macOS 27.2 porque os serviços de mídia morriam ao abrir o microfone; eles agora rodam dentro do processo.' },
    { title: 'Segunda conta do Antigravity', detail: 'Adicionar a segunda conta falhava com «terminal não ficou disponível»; o login agora espera a sessão do jeito certo e entra.' },
    { title: 'Modelos por extenso', detail: 'Providers mostrava frações nuas como 13/13 e 256/256; a contagem de modelos agora vem em palavras, sem adivinhação.' },
    { title: 'Sem o diálogo do Keychain em loop', detail: 'O macOS repetia sem fim o pedido de acesso às credenciais do Muse a cada sonda de cota; a leitura não dispara mais o diálogo.' },
    { title: 'Falso limite do AGY', detail: 'Um «401» que aparecia no texto do terminal fazia o Nexus trocar de conta e parar a missão, mesmo com a conta funcionando. Agora a sonda de cota confirma antes: credencial aceita pelo provider desmente o alarme e o pane segue na mesma conta.' },
    { title: 'Windows sem falsa queda', detail: 'Pane encerrado pelo próprio Nexus ao fim da missão mostrava «processo caiu (code 129)»; o encerramento normal não é mais rotulado como queda.' },
    { title: 'Squad salvo abre de novo', detail: 'Squads de plano (e as cópias deles) falhavam ao abrir e em «Usar integrantes», sem jeito de corrigir no editor. Agora o roster carrega normalmente e o squad volta a ser utilizável.' },
    { title: 'Muse sem falsa expiração', detail: 'O pane do Muse com login nativo mostrava «Sessão expirada» por causa de um erro de autenticação que só aparecia no texto do terminal, mesmo com a credencial funcionando. O Nexus agora confirma com a sonda de cota antes de avisar: sem confirmação, nada de toast e o pane segue trabalhando.' },
  ],
};
export const RELEASE_076252: AppRelease = {
  version: '0.76.252',
  date: '2026-10-13',
  codename: 'Linux em dia com o campo',
  summary: 'O app no Linux deixa a 0.76.249 e passa a incluir a 0.76.250 e a 0.76.251: o Maestro do «+ Pane» volta a delegar, um erro citado no terminal não troca a conta da missão, e o squad salvo volta a abrir.',
  highlights: [
    { title: 'Maestro que delega', detail: 'O orquestrador criado pelo «+ Pane» recebia os pedidos e executava tudo no próprio terminal. Agora ele recebe a doutrina de delegar e o vigia de esteira cobra quando a missão fica sem workers.' },
    { title: 'Conta da missão estável', detail: 'Um «401» que só aparecia no texto do terminal não troca mais a conta nem para a missão. A sonda de cota confirma antes.' },
    { title: 'Squad salvo abre de novo', detail: 'Squads de plano, e as cópias deles, falhavam ao abrir no editor. O roster carrega e o squad volta a ser utilizável.' },
  ],
  fixes: [
    { title: 'Muse e a segunda conta', detail: 'O pane do Muse com login nativo não avisa mais «sessão expirada» sem a sonda confirmar, e a segunda conta do Antigravity espera a sessão em vez de falhar na hora.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.250 e a 0.76.251 só tinham pacote de Mac ou Windows. O Omarchy consultava o espelho e ficava na 0.76.249.' },
  ],
};
export const RELEASE_076253: AppRelease = {
  version: '0.76.253',
  date: '2026-10-14',
  codename: 'Troca de conta sem perder nada',
  summary: 'Quando uma conta atinge o limite, o Maestro e os workers trocam para outra conta do mesmo provedor sem parar a missão e sem perder a conversa, o pedido em andamento, a pasta nem a tarefa. O coordenador volta sempre, o Grok não pede login a cada pane no Windows, o AGY aparece ao vivo e o celular volta a conectar.',
  highlights: [
    { title: 'A missão não para quando a conta acaba', detail: 'Quando uma conta atinge o limite de uso, o pane troca para outra conta do mesmo provedor e segue a tarefa, na mesma pasta. A troca encadeia entre várias contas, espera até 24 horas se todas esgotarem e retoma sozinha depois de reiniciar o app.' },
    { title: 'A mesma conversa na conta nova', detail: 'No Claude, a troca de conta continua a mesma conversa (só depois de provar que retomou; senão, sessão nova com resumo), e o último pedido em andamento vai junto, o mais recente sempre inteiro.' },
    { title: 'Coordenador sempre volta', detail: 'O Maestro não é mais recusado com «orchestrator physical spawn authority is missing or mismatched» quando a conta escolhida muda: ele volta na conta com folga do mesmo provedor e, se houver recusa, ela diz o motivo em português.' },
  ],
  fixes: [
    { title: 'Limite avisado pelo Claude troca na hora', detail: 'Quando o próprio Claude avisa que a conta bateu o limite, a troca acontece uma vez só, sem a pausa de 15 minutos, e o bloqueio da conta vai até a cota voltar de verdade.' },
    { title: 'Um Maestro só na tela', detail: 'A missão não acumula mais panes mortos do coordenador depois de religar ou atualizar o app.' },
    { title: 'AGY ao vivo', detail: 'O pane do Antigravity mostra o trabalho enquanto acontece, em vez de ficar preto até terminar.' },
    { title: 'Mais modelos nas revisões', detail: 'Revisões somente leitura usam todos os modelos de ponta prontos; o portão de integração continua com Claude/Codex. CLI parada na tela de login sai da rota até você logar.' },
    { title: 'Grok sem login a cada pane', detail: 'No Windows o Grok não pede login a cada pane: a renovação volta para o perfil, e sem login válido aparece «Entrar no Grok» em vez de panes mudos.' },
    { title: 'Celular pelo QR', detail: 'O QR de controle volta a dar controle, o celular diz por que não conectou, os links copiam o endereço https certo e o QR velho dá lugar a «Gerar novo QR». O servidor de conexão do celular foi para a Cloudflare.' },
    { title: 'Celular na rede local', detail: 'A porta não muda a cada início, há o botão «Parar», «Iniciar neste computador» volta a ser só local e a tela diz o que fazer quando ninguém conecta.' },
    { title: 'Sem erro vermelho no Windows', detail: 'O hook do Nexus no Claude não estoura mais o tempo no Windows nem despeja o comando em base64 na tela.' },
    { title: 'Comandos pesados no horário de verão', detail: 'No macOS e no Linux, a vaga de comando pesado não é liberada com processo ainda rodando na volta do horário de verão.' },
    { title: 'Squads mais firmes', detail: 'Editor e importação de squads recusam nome repetido com o nome, aceitam arquivo UTF-16 e com BOM do Windows, leem frontmatter CRLF, recusam CON/NUL e aceitam pastas em 8.3 e com outra caixa.' },
  ],
};
export const RELEASE_076254: AppRelease = {
  version: '0.76.254',
  date: '2026-10-14',
  codename: 'Linux em dia com a troca de conta',
  summary: 'O app no Linux deixa a 0.76.252 e passa a incluir a 0.76.253: quando a conta atinge o limite, a missão troca de conta sem parar e sem perder a conversa, o pedido, a pasta nem a tarefa.',
  highlights: [
    { title: 'A missão não para quando a conta acaba', detail: 'O Maestro e os workers trocam para outra conta do mesmo provedor e seguem a tarefa. No Claude a conversa continua, e o último pedido em andamento vai junto.' },
    { title: 'Coordenador sempre volta', detail: 'O Maestro volta na conta com folga em vez de ser recusado, e a missão mostra um Maestro só, sem panes mortos acumulados.' },
    { title: 'AGY ao vivo e celular de volta', detail: 'O pane do Antigravity mostra o trabalho enquanto acontece. O QR de controle volta a dar controle, e na rede local a porta não muda a cada início.' },
  ],
  fixes: [
    { title: 'Revisão, squads e comando pesado', detail: 'Revisões somente leitura usam todos os modelos de ponta. Squads salvos importam de novo, inclusive arquivo do Windows. A vaga de comando pesado não some na volta do horário de verão.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.253 só tinha pacote de Windows. O Omarchy consultava o espelho e ficava na 0.76.252.' },
  ],
};
export const RELEASE_076255: AppRelease = {
  version: '0.76.255',
  date: '2026-10-14',
  codename: 'macOS em dia com a troca de conta e sem modal do Chaveiro',
  summary: 'Traz para o macOS toda a troca de conta sem perder nada da 0.76.253 (mesma conversa no Claude, pedido em andamento preservado, coordenador sem recusa nem panes mortos, AGY ao vivo, QR e rede local do celular) e elimina de vez o modal «security deseja acessar a chave "ai.meta.dev.credentials"» ao abrir o app.',
  highlights: [
    { title: 'Troca de conta sem perder nada no macOS', detail: 'Quando uma conta bate o limite, o Maestro e os workers trocam para outra conta do mesmo provedor na mesma pasta, continuando a mesma conversa no Claude e reentregando o pedido em andamento.' },
    { title: 'Sem o modal do Chaveiro do Muse no Início', detail: 'O macOS não abre mais o diálogo «security deseja acessar a chave "ai.meta.dev.credentials"» ao iniciar o NexusIDE: a sessão do Muse é confirmada pelos metadados sem ler o segredo via `/usr/bin/security -w`.' },
    { title: 'AGY ao vivo, coordenador firme e celular', detail: 'O pane do Antigravity mostra o trabalho ao vivo, a missão mantém um Maestro só na tela e o celular conecta pelo QR na Cloudflare ou na rede local com porta fixa.' },
  ],
  fixes: [
    { title: 'Chaveiro do Muse sem prompt de senha (F-1513)', detail: 'O item `ai.meta.dev.credentials` pertence à ACL exclusiva do binário `muse-bin`; o QuotaService no macOS não invoca mais `security find-generic-password -w` sobre ele.' },
    { title: 'Espera e retomada da troca de conta (F-1470..F-1512)', detail: 'Inclui todas as correções de encadeamento de contas, StopFailure rate_limit do Claude, reentrega de pedido aceito durante a troca, comandos pesados no horário de verão e validação de squads.' },
  ],
};
export const RELEASE_076256: AppRelease = {
  version: '0.76.256',
  date: '2026-10-14',
  codename: 'Orquestrador volta, teclado sem letras duplicadas e voz sem falso "falta chave"',
  summary: 'Corrige a missão que perdia o orquestrador e não reabria, as letras duplicadas ao digitar num pane religado e o ditado que acusava falta de chave quando o problema era tempo limite.',
  highlights: [
    { title: 'Orquestrador volta sozinho', detail: 'Quando a CLI responde «No conversation found», o Nexus esquece a conversa inexistente e reabre o orquestrador numa conversa nova, sob o mesmo contrato, em vez de recusar a retomada para sempre.' },
    { title: 'Teclado sem letras duplicadas', detail: 'Cada pane tem um único receptor de teclado; religar ou acordar o pane depois de uma saída não envia mais cada tecla duas vezes.' },
    { title: 'Voz com diagnóstico honesto', detail: 'O ditado só diz «falta chave» quando nenhum provedor tentou. Tempo limite cresce com o tamanho do áudio e o log registra o motivo de cada provedor.' },
  ],
  fixes: [
    { title: 'Retomada exata de conversa inexistente', detail: 'A tela da CLI com «No conversation found with session ID» esquece o vínculo na 1ª ocorrência; a retomada da aba troca a linha do orquestrador e leva a nota de conversa perdida.' },
    { title: 'Receptor de teclado duplicado no terminal', detail: 'startSpawn descarta o receptor anterior antes de registrar o novo, inclusive em respawns que não passam por cleanups.' },
    { title: 'stt-needs-key e tempo limite da STT', detail: 'needsKey exige provedor sem chave e nenhuma tentativa real; tempo limite de nuvem proporcional ao tamanho do áudio; evento stt.failed no voice.log.' },
  ],
};
export const RELEASE_076257: AppRelease = {
  version: '0.76.257',
  date: '2026-10-14',
  codename: 'Linux em dia com o orquestrador, o teclado e a voz',
  summary: 'O app no Linux deixa a 0.76.254 e passa a incluir a 0.76.256: o orquestrador da aba volta quando a conversa não existe, o teclado não duplica letras depois de religar o pane, e o ditado deixa de dizer que falta chave quando o problema foi tempo.',
  highlights: [
    { title: 'Orquestrador volta sozinho', detail: 'Quando a CLI responde «No conversation found», o Nexus esquece a conversa inexistente e reabre o orquestrador numa conversa nova, sob o mesmo contrato, em vez de recusar a retomada para sempre.' },
    { title: 'Teclado sem letras duplicadas', detail: 'Cada pane tem um único receptor de teclado; religar ou acordar o pane depois de uma saída não envia mais cada tecla duas vezes.' },
    { title: 'Voz com diagnóstico honesto', detail: 'O ditado só diz «falta chave» quando nenhum provedor tentou. Tempo limite cresce com o tamanho do áudio e o log registra o motivo de cada provedor.' },
  ],
  fixes: [
    { title: 'Retomada e teclado', detail: 'A tela «No conversation found with session ID» esquece o vínculo na 1ª ocorrência. O receptor antigo de teclado é descartado antes de registrar o novo.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.255 só tinha pacote de macOS e a 0.76.256 ainda não tinha Linux. O Omarchy consultava o espelho e ficava na 0.76.254. O modal do Chaveiro do Muse não muda o Linux.' },
  ],
};
export const RELEASE_076258: AppRelease = {
  version: '0.76.258',
  date: '2026-10-14',
  codename: 'Menus nativos do Windows com o tema do app',
  summary: 'Corrige o fundo branco com texto claro nos menus nativos dos seletores no Windows: o popup agora segue o tema escuro ou claro do app.',
  highlights: [
    { title: 'Menus nativos legíveis', detail: 'Os seletores de modelo, esforço e demais abrem o menu nativo com o mesmo tema do app, sem fundo branco e texto claro.' },
  ],
  fixes: [
    { title: 'color-scheme nos temas (F-380)', detail: ':root declara color-scheme dark e o tema nexus-light declara light, para o popup nativo do select não herdar o canvas claro do sistema.' },
  ],
};
export const RELEASE_076259: AppRelease = {
  version: '0.76.259',
  date: '2026-10-14',
  codename: 'Panes mais rápidos, sem tela preta, e XP que conta de verdade',
  summary: 'Abrir e redimensionar panes ficou mais leve, o processo principal parou de travar em gravações síncronas, o pane de missão volta a retomar sem conta, o mapa da equipe fica à vista e a gamificação passa a responder ao trabalho real.',
  highlights: [
    { title: 'Sem pane preto', detail: 'O terminal adotado recebe na hora o tamanho certo, o resize sai no frame seguinte e um pane que remonta volta visível sozinho.' },
    { title: 'Abrir pane mais rápido', detail: 'Writer isolado usa uma worktree já preparada, o brief espera o Jev por no máximo 2,5 s e leituras repetidas do spawn ficam em cache.' },
    { title: 'Nexus mais leve com muitos panes', detail: 'Sem fsync no espelho de diagnóstico, shim por fs.watch em vez de varrer a cada 40 ms, foco que redesenha só os panes envolvidos.' },
    { title: 'XP de verdade', detail: 'Handoffs aceitos e turnos do MiMo dão XP, o medidor volta à barra lateral e a lata de energético do pane ganha vida.' },
  ],
  fixes: [
    { title: 'Retomada sem conta (F-1514)', detail: 'Conta omitida pela interface usa a conta selada do pane; conta diferente continua recusada.' },
    { title: 'Mapa da equipe e etapa Equipe', detail: 'Mapa na barra de abas com a tarefa real de cada agente; a barra Voltar/Continuar não cobre mais os cartões.' },
    { title: 'Builds nas worktrees', detail: 'Typecheck incremental e cache de testes por worktree em .nexus-cache, copiados por CoW para worktrees novas.' },
  ],
};
export const RELEASE_076260: AppRelease = {
  version: '0.76.260',
  date: '2026-10-14',
  codename: 'Linux em dia com panes rápidos, mapa da equipe e XP',
  summary: 'Corte não publicado. A suíte no Ubuntu 22.04 recusou o ledger de proveniência do T3 Code, desatualizado depois do mapa da equipe e do orçamento de foco. O Linux sai na 0.76.261.',
  highlights: [
    { title: 'Sem pane preto', detail: 'O terminal adotado recebe na hora o tamanho certo, o resize sai no frame seguinte e um pane que remonta volta visível sozinho.' },
    { title: 'Abrir pane mais rápido', detail: 'Writer isolado usa uma worktree já preparada, o brief espera o Jev por no máximo 2,5 s e leituras repetidas do spawn ficam em cache.' },
    { title: 'Nexus mais leve com muitos panes', detail: 'Sem fsync no espelho de diagnóstico, shim por fs.watch em vez de varrer a cada 40 ms, foco que redesenha só os panes envolvidos.' },
    { title: 'XP de verdade', detail: 'Handoffs aceitos e turnos do MiMo dão XP, o medidor volta à barra lateral e a lata de energético do pane ganha vida.' },
  ],
  fixes: [
    { title: 'Retomada sem conta (F-1514)', detail: 'Conta omitida pela interface usa a conta selada do pane; conta diferente continua recusada.' },
    { title: 'Mapa da equipe e etapa Equipe', detail: 'Mapa na barra de abas com a tarefa real de cada agente; a barra Voltar/Continuar não cobre mais os cartões.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.258 só tinha pacote de Windows e a 0.76.259 só de macOS. O Omarchy consultava o espelho e ficava na 0.76.257. Os menus nativos do Windows não mudam o Linux.' },
  ],
};
export const RELEASE_076261: AppRelease = {
  version: '0.76.261',
  date: '2026-10-14',
  codename: 'Linux em dia com panes rápidos, mapa da equipe e XP',
  summary: 'O app no Linux deixa a 0.76.257 e passa a incluir a 0.76.259: panes abrem e redimensionam mais leve, o processo principal para de travar em gravações síncronas, o pane de missão retoma sem conta, o mapa da equipe fica à vista e a gamificação responde ao trabalho real.',
  highlights: [
    { title: 'Sem pane preto', detail: 'O terminal adotado recebe na hora o tamanho certo, o resize sai no frame seguinte e um pane que remonta volta visível sozinho.' },
    { title: 'Abrir pane mais rápido', detail: 'Writer isolado usa uma worktree já preparada, o brief espera o Jev por no máximo 2,5 s e leituras repetidas do spawn ficam em cache.' },
    { title: 'Nexus mais leve com muitos panes', detail: 'Sem fsync no espelho de diagnóstico, shim por fs.watch em vez de varrer a cada 40 ms, foco que redesenha só os panes envolvidos.' },
    { title: 'XP de verdade', detail: 'Handoffs aceitos e turnos do MiMo dão XP, o medidor volta à barra lateral e a lata de energético do pane ganha vida.' },
  ],
  fixes: [
    { title: 'Retomada sem conta (F-1514)', detail: 'Conta omitida pela interface usa a conta selada do pane; conta diferente continua recusada.' },
    { title: 'Mapa da equipe e etapa Equipe', detail: 'Mapa na barra de abas com a tarefa real de cada agente; a barra Voltar/Continuar não cobre mais os cartões.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.258 só tinha pacote de Windows e a 0.76.259 só de macOS. O Omarchy consultava o espelho e ficava na 0.76.257. Os menus nativos do Windows não mudam o Linux.' },
    { title: 'Ledger de proveniência', detail: 'A tag 0.76.260 não foi publicada. Os hashes do CommandPalette e do orçamento de render da grade acompanham o mapa da equipe e o foco que redesenha só os dois panes.' },
  ],
};

export const RELEASE_076262: AppRelease = {
  version: '0.76.262',
  date: '2026-10-14',
  codename: 'Retomada clara, trabalho preservado',
  summary: 'Ao reabrir o Nexus, uma missão aguardando resposta do sistema não prende mais os outros terminais. Os controles da missão ficam visíveis e os panes mostram o caminho certo para continuar.',
  highlights: [
    { title: 'Cada missão volta no seu tempo', detail: 'Um pane já autorizado retoma sem esperar outra missão que ainda está carregando. Agentes avulsos também seguem sua preferência de retomada.' },
    { title: 'Retomada ao alcance', detail: 'O pane da missão oferece Abrir missão ou Retomar missão conforme o estado. Durante a retomada, o botão informa o andamento e evita cliques repetidos.' },
    { title: 'Comandos sempre à vista', detail: 'As ações do Quadro têm uma faixa própria e se ajustam à largura. Título e telemetria não empurram mais o botão de retomada para fora da tela.' },
  ],
  fixes: [
    { title: 'Ações que correspondem ao estado', detail: 'Panes controlados pela missão não oferecem mais Dormir e Reiniciar individuais que o sistema recusava. Missões aguardando revisão ou resposta abrem o Quadro.' },
    { title: 'Falhas de retomada visíveis', detail: 'Se a retomada falhar, o Nexus apresenta o erro e permite tentar novamente.' },
    { title: 'Teste de credenciais isolado', detail: 'O teste de OpenClaude usa um cofre simulado e deixa de consultar a credencial real do Mac.' },
  ],
};

export const RELEASE_076263: AppRelease = {
  version: '0.76.263',
  date: '2026-10-14',
  codename: 'Linux em dia com a retomada',
  summary: 'O app no Linux deixa a 0.76.261 e passa a incluir a 0.76.262: ao reabrir, uma missão aguardando resposta não prende os outros terminais, e os controles da missão ficam visíveis.',
  highlights: [
    { title: 'Cada missão volta no seu tempo', detail: 'Um pane já autorizado retoma sem esperar outra missão que ainda está carregando. Agentes avulsos também seguem sua preferência de retomada.' },
    { title: 'Retomada ao alcance', detail: 'O pane da missão oferece Abrir missão ou Retomar missão conforme o estado. Durante a retomada, o botão informa o andamento e evita cliques repetidos.' },
    { title: 'Comandos sempre à vista', detail: 'As ações do Quadro têm uma faixa própria e se ajustam à largura. Título e telemetria não empurram mais o botão de retomada para fora da tela.' },
  ],
  fixes: [
    { title: 'Ações que correspondem ao estado', detail: 'Panes controlados pela missão não oferecem mais Dormir e Reiniciar individuais que o sistema recusava. Missões aguardando revisão ou resposta abrem o Quadro.' },
    { title: 'Falhas de retomada visíveis', detail: 'Se a retomada falhar, o Nexus apresenta o erro e permite tentar novamente.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.262 só tinha pacote de macOS. O Linux não anexa arquivos a essa release e sai na 0.76.263.' },
  ],
};

export const RELEASE_076264: AppRelease = {
  version: '0.76.264',
  date: '2026-10-15',
  codename: 'Nexus mais rápido de ponta a ponta',
  summary: 'Panes abrem e respondem mais rápido: o terminal manda a saída em lotes, git e arquivos saem do processo principal e o app carrega menos ao abrir. Renovar a sessão em um aparelho não desconecta mais os outros.',
  highlights: [
    { title: 'Terminal em lotes', detail: 'A saída de cada pane chega à tela agrupada, em vez de uma mensagem por pedaço. Comandos com muita saída deixam de travar a janela.' },
    { title: 'Git e arquivos sem travar', detail: 'Push, pull, status, explorador de arquivos e anexos rodam fora do processo principal. A interface continua respondendo durante essas operações.' },
    { title: 'Abertura mais leve', detail: 'O Nexus carrega menos ao abrir: fontes mais leves, painéis secundários sob demanda e tarefas de fundo depois que a janela aparece.' },
    { title: 'Espaço para ditar ajustável', detail: 'Segurar Espaço inicia o ditado depois de 450 ms. Em Voz, você ajusta esse tempo entre 250 e 1000 ms. Um toque normal continua digitando o espaço.' },
  ],
  fixes: [
    { title: 'Login nos três sistemas', detail: 'Uma renovação repetida derruba só aquele aparelho. Mac, Linux, Windows e web continuam conectados.' },
    { title: 'Anexos grandes', detail: 'Arquivos acima de cerca de 3 MiB soltos na janela voltam a ser anexados.' },
    { title: 'Pool de worktrees após crash', detail: 'Uma worktree pré-alocada que estava sendo adotada no momento de um crash é concluída quando o Nexus abre de novo.' },
    { title: 'Espera de atualização de CLI com teto', detail: 'Abrir um pane enquanto uma CLI se atualiza desiste em 60 s e mostra o motivo.' },
  ],
};

export const RELEASE_076265: AppRelease = {
  version: '0.76.265',
  date: '2026-10-15',
  codename: 'Linux em dia com a velocidade',
  summary: 'Corte não publicado. A suíte no Ubuntu 22.04 recusou o teste do cache de symref: git init cria master quando o branch padrão não é main. O Linux sai na 0.76.267.',
  highlights: [
    { title: 'Terminal em lotes', detail: 'A saída de cada pane chega à tela agrupada, em vez de uma mensagem por pedaço. Comandos com muita saída deixam de travar a janela.' },
    { title: 'Git e arquivos sem travar', detail: 'Push, pull, status, explorador de arquivos e anexos rodam fora do processo principal. A interface continua respondendo durante essas operações.' },
    { title: 'Abertura mais leve', detail: 'O Nexus carrega menos ao abrir: fontes mais leves, painéis secundários sob demanda e tarefas de fundo depois que a janela aparece.' },
    { title: 'Espaço para ditar ajustável', detail: 'Segurar Espaço inicia o ditado depois de 450 ms. Em Voz, você ajusta esse tempo entre 250 e 1000 ms. Um toque normal continua digitando o espaço.' },
  ],
  fixes: [
    { title: 'Login nos três sistemas', detail: 'Uma renovação repetida derruba só aquele aparelho. Mac, Linux, Windows e web continuam conectados.' },
    { title: 'Anexos grandes', detail: 'Arquivos acima de cerca de 3 MiB soltos na janela voltam a ser anexados.' },
    { title: 'Pool de worktrees após crash', detail: 'Uma worktree pré-alocada que estava sendo adotada no momento de um crash é concluída quando o Nexus abre de novo.' },
    { title: 'Espera de atualização de CLI com teto', detail: 'Abrir um pane enquanto uma CLI se atualiza desiste em 60 s e mostra o motivo.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.264 só tinha pacote de macOS. O Linux não anexa arquivos a essa release e sai na 0.76.267.' },
  ],
};

export const RELEASE_076266: AppRelease = {
  version: '0.76.266',
  date: '2026-10-15',
  codename: 'Linux em dia com a velocidade',
  summary: 'Corte não publicado. O smoke empacotado chamou releaseReadiness no splash, antes de o IPC existir. O Linux sai na 0.76.267.',
  highlights: [
    { title: 'Terminal em lotes', detail: 'A saída de cada pane chega à tela agrupada, em vez de uma mensagem por pedaço. Comandos com muita saída deixam de travar a janela.' },
    { title: 'Git e arquivos sem travar', detail: 'Push, pull, status, explorador de arquivos e anexos rodam fora do processo principal. A interface continua respondendo durante essas operações.' },
    { title: 'Abertura mais leve', detail: 'O Nexus carrega menos ao abrir: fontes mais leves, painéis secundários sob demanda e tarefas de fundo depois que a janela aparece.' },
    { title: 'Espaço para ditar ajustável', detail: 'Segurar Espaço inicia o ditado depois de 450 ms. Em Voz, você ajusta esse tempo entre 250 e 1000 ms. Um toque normal continua digitando o espaço.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'A 0.76.264 só tinha pacote de macOS. A tag 0.76.265 não foi publicada. O smoke da 0.76.266 também não. O Linux sai na 0.76.267.' },
  ],
};

export const RELEASE_076267: AppRelease = {
  version: '0.76.267',
  date: '2026-10-15',
  codename: 'Linux em dia com a velocidade',
  summary: 'O app no Linux deixa a 0.76.263 e passa a incluir a 0.76.264: o terminal manda a saída em lotes, git e arquivos saem do processo principal, o app abre mais leve e renovar a sessão em um aparelho não desconecta os outros.',
  highlights: [
    { title: 'Terminal em lotes', detail: 'A saída de cada pane chega à tela agrupada, em vez de uma mensagem por pedaço. Comandos com muita saída deixam de travar a janela.' },
    { title: 'Git e arquivos sem travar', detail: 'Push, pull, status, explorador de arquivos e anexos rodam fora do processo principal. A interface continua respondendo durante essas operações.' },
    { title: 'Abertura mais leve', detail: 'O Nexus carrega menos ao abrir: fontes mais leves, painéis secundários sob demanda e tarefas de fundo depois que a janela aparece.' },
    { title: 'Espaço para ditar ajustável', detail: 'Segurar Espaço inicia o ditado depois de 450 ms. Em Voz, você ajusta esse tempo entre 250 e 1000 ms. Um toque normal continua digitando o espaço.' },
  ],
  fixes: [
    { title: 'Login nos três sistemas', detail: 'Uma renovação repetida derruba só aquele aparelho. Mac, Linux, Windows e web continuam conectados.' },
    { title: 'Anexos grandes', detail: 'Arquivos acima de cerca de 3 MiB soltos na janela voltam a ser anexados.' },
    { title: 'Pool de worktrees após crash', detail: 'Uma worktree pré-alocada que estava sendo adotada no momento de um crash é concluída quando o Nexus abre de novo.' },
    { title: 'Espera de atualização de CLI com teto', detail: 'Abrir um pane enquanto uma CLI se atualiza desiste em 60 s e mostra o motivo.' },
    { title: 'Atualização do Linux', detail: 'A 0.76.264 só tinha pacote de macOS. As tags 0.76.265 e 0.76.266 não foram publicadas. O Linux sai na 0.76.267.' },
  ],
};
export const RELEASE_076270: AppRelease = {
  version: '0.76.270',
  date: '2026-10-15',
  codename: 'Retomada sem tropeço e agentes à vista',
  summary: 'A retomada de missão deixa de terminar sem efeito ou sem dizer a causa e não duplica o pane de origem, o rail e as abas mostram quem está trabalhando agora, o Quadro ganha uma ação principal só, e o spawn de panes deixa de duplicar quando o Main está sob carga.',
  highlights: [
    { title: 'Quem trabalha agora', detail: 'O rail, as abas e o cabeçalho da missão contam os agentes trabalhando, e "Em andamento" lista todos os repositórios ativos sem duplicar em Recentes.' },
    { title: 'Quadro mais limpo', detail: 'Uma ação primária por vez, o resto no menu Mais, e o Quadro pode ser minimizado (a escolha fica salva).' },
    { title: 'Jev 1.14 preview', detail: 'Selecionável em Chaves de API › Modelos de decisão; o padrão continua o estável e um modelo recusado volta ao jev-latest.' },
    { title: 'Spawn idempotente', detail: 'O mesmo requestId, da mesma sessão, devolve o pane que já nasceu em vez de abrir um segundo; recusa por carga não pune a CLI no disjuntor.' },
    { title: 'XP global e perfil sempre à vista', detail: 'Patente, poder e XP de hoje somam os projetos já abertos, com detalhe "Por projeto" no perfil; o HUD ganhou faixa própria no rodapé da rail e o diálogo perdeu animações em loop (F-1521/F-1542).' },
  ],
  fixes: [
    { title: 'Retomar com efeito e causa (A5/A7/A9)', detail: 'Retomar não termina mais sem efeito nem sem a causa, o orquestrador religa sem esperar workers podres e a reserva da retomada da aba tem prazo.' },
    { title: 'accountId[undefined != acct-…] (A1/A6/A8)', detail: 'A retomada devolve a especificação selada e alinha o espelho do layout numa única gravação, evitando a recusa da cerca do spawn persistido.' },
    { title: 'Retomada sem pane duplicado (F-1538/F-1539/F-1540)', detail: 'A folha de origem é aposentada na transferência, a fita retida do terminal respeita a largura (sem quebra por uma coluna) e o aviso de pausa diz o motivo e reavalia quando a missão destrava.' },
    { title: 'Teclado do pane após hibernar (F-1537)', detail: 'A tecla segue o estado vivo do pane e o teclado é religado ao reidratar; "Inserir" do histórico usa a mesma rota do teclado.' },
    { title: 'Gravação de voz fantasma (F-1541)', detail: 'Soltar a tecla enquanto o microfone ainda abre encerra a captura em vez de deixá-la gravando; outra tecla durante o hold também encerra o ditado.' },
    { title: 'Entrega de handoff cortada (F-1536)', detail: 'Colagem picotada no ConPTY é detectada pelo marcador do Codex e reentregue, sem Enter em texto truncado.' },
    { title: 'Ditado em inglês (F-1530)', detail: 'Reescrita do CODE que devolvia o português é detectada e recusada; a STT de fallback sempre é tentada.' },
    { title: 'Portão de regressão e worktree (F-1533/F-1535)', detail: 'O mapa do portão tem prazo e cache, o lexer do catálogo preserva caminho do Windows e a worktree isolada nasce com node_modules ligado (fora do git).' },
    { title: 'Checkpoint oculto no Windows (F-1532)', detail: 'O checkpoint do writer funciona com tmp em nome curto 8.3 no Windows.' },
  ],
};
export const RELEASE_076271: AppRelease = {
  version: '0.76.271',
  date: '2026-10-15',
  codename: 'Teclado, medidor e dependências em ordem',
  summary: 'Correções da revisão independente da 0.76.270: a tecla deixa de chegar dobrada depois de hibernar e acordar o pane, o medidor de comandos pesados não é mais contornado por barra invertida, e o contrato dos workers avisa para nunca apagar o node_modules ligado ao checkout de origem. A 0.76.270 foi publicada como código; o instalador do Windows sai nesta versão.',
  highlights: [
    { title: 'Tecla dobrada ao hibernar', detail: 'Reidratar um pane hibernado e depois acordá-lo ou retomá-lo não soma um segundo receptor de teclado ("bbuugg").' },
    { title: 'Medidor de comandos pesados', detail: 'Escapar uma letra do programa (n\px) não tira mais o comando do medidor: o comando é lido como o Windows e como o bash o leem.' },
  ],
  fixes: [
    { title: 'node_modules ligado à worktree', detail: 'No Node 24 a remoção recursiva atravessa o junction e apaga as dependências do checkout de origem (medido). O contrato do worker proíbe apagar ou reinstalar esse node_modules.' },
  ],
};

export const RELEASE_076272: AppRelease = {
  version: '0.76.272',
  date: '2026-10-15',
  codename: 'Linux em dia com a retomada e os agentes',
  summary: 'O app no Linux deixa a 0.76.267 e passa a incluir a 0.76.270 e a 0.76.271: retomada com efeito e causa, agentes à vista, perfil com XP global, teclado que não duplica tecla depois de hibernar e worktree com node_modules ligado.',
  highlights: [
    { title: 'Quem trabalha agora', detail: 'O rail, as abas e o cabeçalho da missão contam os agentes trabalhando, e "Em andamento" lista todos os repositórios ativos sem duplicar em Recentes.' },
    { title: 'Retomada com efeito', detail: 'Retomar não termina mais sem efeito nem sem a causa, não duplica o pane de origem e devolve a especificação selada numa gravação só do layout.' },
    { title: 'Quadro mais limpo', detail: 'Uma ação primária por vez, o resto no menu Mais, e o Quadro pode ser minimizado (a escolha fica salva).' },
    { title: 'XP global e perfil', detail: 'Patente, poder e XP de hoje somam os projetos já abertos, com detalhe por projeto. O HUD ganhou faixa própria no rodapé da rail.' },
  ],
  fixes: [
    { title: 'Tecla dobrada ao hibernar', detail: 'Reidratar um pane hibernado e depois acordá-lo ou retomá-lo não soma um segundo receptor de teclado.' },
    { title: 'Spawn idempotente', detail: 'O mesmo pedido, da mesma sessão, devolve o pane que já nasceu. Recusa por carga não pune a CLI no disjuntor.' },
    { title: 'Voz sem gravação fantasma', detail: 'Soltar a tecla enquanto o microfone ainda abre encerra a captura. Reescrita do ditado que ecoava o português é recusada.' },
    { title: 'Handoff cortado', detail: 'Colagem picotada é detectada pelo marcador do Codex e reentregue, sem Enter em texto truncado. Sem marcador, a detecção não ocorre.' },
    { title: 'node_modules da worktree', detail: 'A worktree isolada nasce com node_modules ligado. O contrato do worker proíbe apagar ou reinstalar esse diretório, porque a remoção recursiva atravessa o link.' },
    { title: 'Atualização do Linux', detail: 'As tags 0.76.270 e 0.76.271 não recebem pacotes Linux. A 0.76.271 é a candidata do Windows. O Linux sai na 0.76.272.' },
  ],
};

export const RELEASE_076273: AppRelease = {
  version: '0.76.273',
  date: '2026-10-15',
  codename: 'Mais claro, mais vivo',
  summary: 'Configuração guiada, contas de IA mais claras, retomadas fáceis de encontrar e uma lata de energia com mais vida. O Mac também recebe as melhorias de missão, teclado e agentes incluídas no Windows 0.76.272.',
  highlights: [
    { title: 'Configure pelo que você precisa', detail: 'A nova Configuração rápida leva direto a conectar uma IA, ajustar a leitura, configurar o microfone ou ver seus limites. A busca entende termos como “entrar no Claude” e “aumentar letra”.' },
    { title: 'Suas contas de IA, sem confusão', detail: 'A tela distingue ferramentas instaladas, ativadas e conectadas. Conectar minha conta fica em destaque; instalar ou atualizar várias ferramentas é uma opção separada.' },
    { title: 'Retome sem procurar o botão', detail: 'Missões tem acesso direto na navegação. Pendências ficam acima do histórico e trabalhos dormindo mostram Abrir para retomar.' },
    { title: 'Ações explicadas nos painéis', detail: 'O menu Ações explica cada operação e mantém a leitura em janelas pequenas. Focar painel e Dividir à direita deixam claro o que cada controle faz.' },
    { title: 'Energia com movimento', detail: 'A lata ganhou presença, estalo e espuma na abertura e celebra o XP recebido. As cenas respeitam o modo sóbrio, a visibilidade e a preferência por movimento reduzido.' },
    ...RELEASE_076270.highlights,
  ],
  fixes: [
    { title: 'Retomada de missão', detail: 'O coordenador religa sem esperar workers sem sessão. A transferência preserva a conta e a conversa seladas, aposenta o pane antigo e tem prazo e erros visíveis.' },
    { title: 'Teclado após hibernar', detail: 'O pane acompanha o estado vivo e mantém um único receptor de teclado ao acordar ou retomar.' },
    { title: 'Spawn sem duplicatas', detail: 'O mesmo requestId da mesma sessão devolve o pane existente; recusa por carga não pune a CLI.' },
    { title: 'Menu Mais sem corte', detail: 'As ações continuam acessíveis com o Quadro minimizado e em largura compacta.' },
    { title: 'Recusa de religação', detail: 'A mensagem permite tentar novamente pelo Quadro, sem recomendar reinício local de um pane controlado pela missão.' },
    { title: 'Ditado e comandos pesados', detail: 'Soltar a tecla durante a abertura do microfone encerra a captura. O medidor também reconhece comandos escapados pelo bash.' },
  ],
};

export const RELEASE_076275: AppRelease = {
  ...RELEASE_076273,
  version: '0.76.275',
  codename: 'Mais fácil de usar, painéis à vista',
  summary: 'O Mac recebe configuração guiada, contas e ações mais claras, retomada fácil de encontrar e a nova animação da lata. Esta versão também corrige a apresentação do painel aberto dentro de uma missão e impede que sinais automáticos do terminal retomem uma missão parada.',
  fixes: [
    { title: 'Início da coordenação', detail: 'Ao criar uma missão a partir de um painel, o aviso ao coordenador aguarda a preparação da IA e a confirmação de recebimento antes de liberar a próxima instrução.' },
    { title: 'Novo painel na missão', detail: 'O painel aberto em Nesta missão é apresentado assim que o registro fica pronto, sem depender de outro evento da missão para aparecer.' },
    { title: 'Missão parada continua parada', detail: 'Sinais automáticos de foco e do terminal não são tratados como uma tecla sua. Voltar à tela não religa sozinho o painel encerrado pelo runtime.' },
    { title: 'Leitura leve do histórico', detail: 'Abrir um painel solto consulta apenas o trecho final do terminal, sem serializar todo o histórico nem forçar a saída pendente.' },
    { title: 'Primeiros passos coerentes', detail: 'O guia usa os nomes atuais de Configurações e prioriza conectar sua conta. Chave inválida ou conta que exige novo login não conta como uma conexão pronta.' },
    ...RELEASE_076273.fixes,
  ],
};

export const RELEASE_076276: AppRelease = {
  version: '0.76.276',
  date: '2026-10-15',
  codename: 'Linux em dia com a clareza',
  summary: 'O app no Linux deixa a 0.76.272 e passa a incluir a configuração guiada, contas e ações mais claras, a retomada fácil de encontrar e a lata animada. As tags 0.76.273 e 0.76.275 não recebem pacotes Linux; a 0.76.275 é a candidata do Mac.',
  highlights: [
    { title: 'Configure pelo que você precisa', detail: 'A Configuração rápida leva direto a conectar uma IA, ajustar a leitura, configurar o microfone ou ver seus limites. A busca entende termos como “entrar no Claude” e “aumentar letra”.' },
    { title: 'Suas contas de IA, sem confusão', detail: 'A tela distingue ferramentas instaladas, ativadas e conectadas. Conectar a conta fica em destaque; instalar ou atualizar várias ferramentas é uma opção separada.' },
    { title: 'Retome sem procurar o botão', detail: 'Missões tem acesso direto na navegação. Pendências ficam acima do histórico e trabalhos dormindo mostram Abrir para retomar.' },
    { title: 'Ações explicadas nos painéis', detail: 'O menu Ações explica cada operação e mantém a leitura em janelas pequenas. Focar painel e Dividir à direita deixam claro o que cada controle faz.' },
    { title: 'Energia com movimento', detail: 'A lata ganhou presença, estalo e espuma na abertura e celebra o XP recebido. As cenas respeitam o modo sóbrio, a visibilidade e a preferência por movimento reduzido.' },
  ],
  fixes: [
    { title: 'Início da coordenação', detail: 'Ao criar uma missão a partir de um painel, o aviso ao coordenador aguarda a preparação da IA e a confirmação de recebimento antes de liberar a próxima instrução.' },
    { title: 'Novo painel na missão', detail: 'O painel aberto em Nesta missão é apresentado assim que o registro fica pronto, sem depender de outro evento da missão para aparecer.' },
    { title: 'Missão parada continua parada', detail: 'Sinais automáticos de foco e do terminal não são tratados como uma tecla sua. Voltar à tela não religa sozinho o painel encerrado pelo runtime.' },
    { title: 'Leitura leve do histórico', detail: 'Abrir um painel solto consulta apenas o trecho final do terminal, sem serializar todo o histórico nem forçar a saída pendente.' },
    { title: 'Primeiros passos coerentes', detail: 'O guia usa os nomes atuais de Configurações e prioriza conectar sua conta. Chave inválida ou conta que exige novo login não conta como uma conexão pronta.' },
    { title: 'Menu Mais sem corte', detail: 'As ações continuam acessíveis com o Quadro minimizado e em largura compacta. Recusa de religação pede nova tentativa no Quadro.' },
    { title: 'Atualização do Linux', detail: 'As tags 0.76.273 e 0.76.275 não recebem pacotes Linux. A 0.76.275 é a candidata do Mac. O Linux sai na 0.76.276.' },
  ],
};

export const RELEASE_076277: AppRelease = {
  version: '0.76.277',
  date: '2026-10-15',
  codename: 'Redline mais visual no Mac',
  summary: 'Suas cotas em um olhar: medidores circulares, contas lado a lado e filtros para chegar às conexões que precisam de atenção. O Redline do Mac também explica melhor quando uma leitura não está disponível.',
  highlights: [
    { title: 'Cotas mais visuais', detail: 'Medidores circulares e logos maiores mostram o consumo de cada conta. A visão ampliada organiza tudo em colunas, com menos texto repetido.' },
    { title: 'Encontre o que precisa', detail: 'Os filtros Todas, Com leitura e Resolver separam as contas com medições das conexões pendentes. Resolver no Nexus abre o caminho para corrigir a conexão.' },
  ],
  fixes: [
    { title: 'Cursor mensal', detail: 'A franquia mensal aparece sem janelas genéricas de 5 horas e semana que o Cursor não informou.' },
    { title: 'Antigravity nativo', detail: 'Uma conta salva deixa de ocultar a fonte de cota da sessão nativa. Essa leitura permanece em sua própria linha, sem ser atribuída a outra conta.' },
    { title: 'Leitura com contexto', detail: 'Os motivos de cota indisponível acompanham a conta até o Redline. Estimativas ficam identificadas; somente medições confirmadas entram no resumo da barra.' },
  ],
};

export const RELEASE_076278: AppRelease = {
  version: '0.76.278',
  date: '2026-10-15',
  codename: 'Linux em dia com as cotas',
  summary: 'O app no Linux deixa a 0.76.276 e passa a mostrar a franquia mensal do Cursor, a cota nativa do Antigravity na própria linha e o motivo quando uma leitura não está disponível. A tag 0.76.277 não recebe pacotes Linux; os medidores circulares ficam no companheiro do Mac.',
  highlights: [
    { title: 'Cursor mensal', detail: 'A franquia mensal aparece sem janelas genéricas de 5 horas e semana que o Cursor não informou.' },
    { title: 'Antigravity nativo', detail: 'Uma conta salva deixa de ocultar a fonte de cota da sessão nativa. Essa leitura permanece em sua própria linha, sem ser atribuída a outra conta.' },
  ],
  fixes: [
    { title: 'Leitura com contexto', detail: 'Os motivos permitidos de cota indisponível acompanham a conta até o snapshot do Redline. Estimativas ficam identificadas; somente medições confirmadas entram no resumo da barra.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.277 não recebe pacotes Linux. Ela é a candidata do Mac. O Linux sai na 0.76.278.' },
  ],
};

export const RELEASE_076279: AppRelease = {
  version: '0.76.279',
  date: '2026-10-15',
  codename: 'Cotas à frente e barras segmentadas',
  summary: 'Clique em Cotas na lateral para abrir uma visão ampla à frente da tela. O Redline também ganha barras segmentadas, números maiores e menos texto.',
  highlights: [
    { title: 'Cotas à frente da tela', detail: 'O painel abre acima da interface, com todas as contas, busca, filtros, atualização e acesso às configurações. A lateral continua compacta.' },
    { title: 'Barras segmentadas no Redline', detail: 'Os círculos dão lugar a barras com escala e percentuais em destaque, mantendo os dados reais de cada janela.' },
  ],
  fixes: [
    { title: 'Leitura sem sobreposição', detail: 'A lista completa deixa de ficar espremida na lateral e encoberta pelo perfil do operador.' },
    { title: 'Teclado no lugar certo', detail: 'Tab e Escape continuam no painel durante a atualização. Ir para Configurações preserva o foco do destino; fechar devolve o foco à origem.' },
    { title: 'Dados com contexto', detail: 'Sem leitura, estimativa, pausa e sessão expirada continuam distintos. Nenhum percentual de outra conta é exibido na linha errada.' },
  ],
};

export const RELEASE_076280: AppRelease = {
  version: '0.76.280',
  date: '2026-10-15',
  codename: 'Linux em dia com as cotas à frente',
  summary: 'No Linux, Cotas abre um painel amplo à frente da tela, com barras segmentadas, busca e filtros. A tag 0.76.279 não recebe pacotes Linux; as barras da barra de menus ficam no companheiro do Mac.',
  highlights: [
    { title: 'Cotas à frente da tela', detail: 'O clique em Cotas abre o painel acima da interface, com todas as contas, busca, filtros, atualização e acesso às configurações. A lateral continua compacta.' },
    { title: 'Barras no painel', detail: 'O painel de cotas usa barras segmentadas e as janelas de cada conta. Sem leitura, estimativa, pausa e sessão expirada continuam distintos.' },
  ],
  fixes: [
    { title: 'Leitura sem sobreposição', detail: 'A lista completa deixa de ficar espremida na lateral e encoberta pelo perfil do operador.' },
    { title: 'Teclado no lugar certo', detail: 'Tab e Escape continuam no painel durante a atualização. Ir para Configurações preserva o foco do destino; fechar devolve o foco à origem.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.279 não recebe pacotes Linux. Ela é a candidata do Mac. O Linux sai na 0.76.280.' },
  ],
};

export const RELEASE_076281: AppRelease = {
  version: '0.76.281',
  date: '2026-10-15',
  codename: 'Windows legível e voz que se explica',
  summary: 'No Windows, menus e seletores nativos ficam legíveis e a lateral vira uma lista plana com todos os projetos em andamento. A voz explica quando o realtime falha, toca uma amostra antes de escolher e passa a usar o Grok Voice 3.0. O Quadro conversa melhor em painéis estreitos.',
  highlights: [
    { title: 'Menus legíveis no Windows', detail: 'Popups e seletores nativos usam as cores do tema, sem texto claro sobre fundo claro.' },
    { title: 'Lateral em lista plana', detail: 'Cada projeto vira um grupo, missões ocupam uma linha e agentes aparecem aninhados. O destaque ao passar o mouse mantém o contraste em todos os temas.' },
    { title: 'Ouça antes de escolher', detail: 'Um botão de play toca uma amostra de cada voz na Voz por etapas e na Voz Gemini Live. Parar ou trocar de voz interrompe a amostra anterior.' },
    { title: 'Grok Voice 3.0', detail: 'O modelo realtime atual da xAI vira o padrão, e configurações com o modelo antigo migram sozinhas. Quando a conexão realtime falha, o chip e o teste dizem o motivo.' },
  ],
  fixes: [
    { title: 'Escritor isolado em qualquer aba', detail: 'Abas com HEAD solto aceitam escritores isolados. Quando o isolamento não é possível, o escritor segue no checkout compartilhado e o recibo explica por quê.' },
    { title: 'Troca de chave ou modelo na voz', detail: 'Trocar a chave ou o modelo durante uma conexão cancela a tentativa anterior: a falha antiga não volta ao chip.' },
    { title: 'Grok com sessão vencida', detail: 'Uma conta do Grok com login vencido sai da rota até você entrar de novo. O card de abertura mostra a falha em vez de ficar carregando.' },
    { title: 'Qwen sem piscar', detail: 'O painel do Qwen deixa de piscar. No Windows, comandos pesados passam pela admissão de memória.' },
    { title: 'Conversa do Quadro', detail: 'A aba Conversa cabe em painéis estreitos. Orientação a um coordenador ocupado é recusada na hora, as orientações não somem e o foco volta ao editor depois do envio.' },
    { title: 'Mensagens claras', detail: 'Respostas aguardam a sua confirmação com "Aguardando confirmação…", a linha do tempo detalhada mostra o quadro correto e as recusas aparecem em português.' },
  ],
};

export const RELEASE_076282: AppRelease = {
  version: '0.76.282',
  date: '2026-10-15',
  codename: 'Linux em dia com a voz e a lateral',
  summary: 'No Linux, a lateral vira uma lista plana, a voz explica a falha do realtime e toca uma amostra antes da escolha, e o Quadro cabe em painel estreito. A tag 0.76.281 não recebe pacotes Linux; ela é a candidata do Windows.',
  highlights: [
    { title: 'Lateral em lista plana', detail: 'Cada projeto vira um grupo, missões ocupam uma linha e agentes aparecem aninhados. O destaque ao passar o mouse mantém o contraste em todos os temas.' },
    { title: 'Ouça antes de escolher', detail: 'Um botão de play toca uma amostra de cada voz na Voz por etapas e na Voz Gemini Live. Parar ou trocar de voz interrompe a amostra anterior.' },
    { title: 'Grok Voice 3.0', detail: 'O modelo realtime atual da xAI vira o padrão, e configurações com o modelo antigo migram sozinhas. Quando a conexão falha, o chip e o teste dizem o motivo.' },
  ],
  fixes: [
    { title: 'Escritor isolado em qualquer aba', detail: 'Abas com HEAD solto aceitam escritores isolados. Quando o isolamento não é possível, o escritor segue no checkout compartilhado e o recibo explica por quê.' },
    { title: 'Troca de chave ou modelo na voz', detail: 'Trocar a chave ou o modelo durante uma conexão cancela a tentativa anterior: a falha antiga não volta ao chip.' },
    { title: 'Grok com sessão vencida', detail: 'Uma conta do Grok com login vencido sai da rota até você entrar de novo. O card de abertura mostra a falha em vez de ficar carregando.' },
    { title: 'Conversa do Quadro', detail: 'A aba Conversa cabe em painéis estreitos. Orientação a um coordenador ocupado é recusada na hora, as orientações não somem e o foco volta ao editor depois do envio.' },
    { title: 'Mensagens claras', detail: 'Respostas aguardam a sua confirmação com "Aguardando confirmação…", a linha do tempo detalhada mostra o quadro correto e as recusas aparecem em português.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.281 não recebe pacotes Linux. Ela é a candidata do Windows. A suíte da 0.76.282 não fechou; o Linux sai na 0.76.283.' },
  ],
};

export const RELEASE_076283: AppRelease = {
  version: '0.76.283',
  date: '2026-10-15',
  codename: 'Linux em dia com a voz e a lateral',
  summary: 'No Linux, a lateral vira uma lista plana, a voz explica a falha do realtime e toca uma amostra antes da escolha, e o Quadro cabe em painel estreito. A tag 0.76.282 não recebe pacotes Linux.',
  highlights: [
    { title: 'Lateral em lista plana', detail: 'Cada projeto vira um grupo, missões ocupam uma linha e agentes aparecem aninhados. O destaque ao passar o mouse mantém o contraste em todos os temas.' },
    { title: 'Ouça antes de escolher', detail: 'Um botão de play toca uma amostra de cada voz na Voz por etapas e na Voz Gemini Live. Parar ou trocar de voz interrompe a amostra anterior.' },
    { title: 'Grok Voice 3.0', detail: 'O modelo realtime atual da xAI vira o padrão, e configurações com o modelo antigo migram sozinhas. Quando a conexão falha, o chip e o teste dizem o motivo.' },
  ],
  fixes: [
    { title: 'Escritor isolado em qualquer aba', detail: 'Abas com HEAD solto aceitam escritores isolados. Quando o isolamento não é possível, o escritor segue no checkout compartilhado e o recibo explica por quê.' },
    { title: 'Troca de chave ou modelo na voz', detail: 'Trocar a chave ou o modelo durante uma conexão cancela a tentativa anterior: a falha antiga não volta ao chip.' },
    { title: 'Grok com sessão vencida', detail: 'Uma conta do Grok com login vencido sai da rota até você entrar de novo. O card de abertura mostra a falha em vez de ficar carregando.' },
    { title: 'Conversa do Quadro', detail: 'A aba Conversa cabe em painéis estreitos. Orientação a um coordenador ocupado é recusada na hora, as orientações não somem e o foco volta ao editor depois do envio.' },
    { title: 'Mensagens claras', detail: 'Respostas aguardam a sua confirmação com "Aguardando confirmação…", a linha do tempo detalhada mostra o quadro correto e as recusas aparecem em português.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.282 não recebe pacotes Linux. A suíte dela não fechava. O Linux sai na 0.76.283.' },
  ],
};

export const RELEASE_076284: AppRelease = {
  version: '0.76.284',
  date: '2026-10-15',
  codename: 'Linux em dia com a projeção',
  summary: 'O pacote Linux acompanha a correção da projeção de missão no Windows. No Linux o atalho da projeção continua exigindo o modo 0600.',
  highlights: [
    { title: 'Mesmo atalho no Linux', detail: 'A projeção de missão no Linux segue reconhecendo o arquivo pelo modo 0600. O desktop Linux não muda de comportamento nesta versão.' },
  ],
  fixes: [
    { title: 'Projeção no Windows', detail: 'No Windows o atalho da projeção aceita o modo 0666 que o NTFS reporta, em vez de regravar um arquivo que não mudou.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.283 já tem pacotes Linux. Esta versão publica o commit seguinte, que não altera o comportamento no Linux.' },
  ],
};

export const RELEASE_076285: AppRelease = {
  version: '0.76.285',
  date: '2026-10-15',
  codename: 'Jarvis em tempo real, Clef no Jev e Uso e custos',
  summary: 'A Jarvis conversa em tempo real no Grok Voice 3.0 com socket quente reutilizado e opera panes, missões, navegador e arquivos sem modais bloqueantes. O modo Somente Jev analisa capturas do navegador com Clef, handoffs não falham por evidenceIds e as Configurações ganham o painel de Uso e custos com gasto mensal real.',
  highlights: [
    { title: 'Jarvis em tempo real e operacional', detail: 'Microfone full-duplex no Grok Voice 3.0 e OpenAI Realtime, reuso do socket quente com sonda de vida, envio para qualquer pane ou terminal e execução mãos-livres no Nexus.' },
    { title: 'Clef em Somente Jev e navegador rápido', detail: 'Em Somente Jev, o texto segue no Jev e a captura visual do navegador vai ao Clef ou Luna autorizados. O piloto do navegador reduz o intervalo entre ações para 150 ms.' },
    { title: 'Painel de Uso e custos e gasto mensal', detail: 'Gráfico diário de 90 dias, recortes de 7, 30 e 90 dias por provedor e modelo, economia de cache e cartão de gasto mensal real em USD editável na linha.' },
  ],
  fixes: [
    { title: 'Handoffs e panes sem cercas indevidas', detail: 'Passar evidenceIds sem workflow congelado ou com IDs de captura grava o handoff como unverified em vez de abortar a entrega, e agentName livre em nexus_pane_spawn vira título do pane.' },
    { title: 'Multi-conta na Reserva', detail: 'Contas AGY/Gemini e Claude na Reserva com access token vencido renovam pelo refresh token e gravam a nova credencial no cofre da conta.' },
    { title: 'Windows 32 GB, ConPTY e ambiente ao vivo', detail: 'A admissão de workers no Windows considera memória disponível (Standby), os panes e o hub MCP leem HKCU\\Environment ao vivo e o cabeçalho filtra o caminho do console host.' },
    { title: 'Vagas do Trial e Nexus Shot', detail: 'O leque de helpers no Trial reserva duas vagas para o Maestro e o revisor, e a ponte do Nexus Shot aceita target nulo na entrega padrão.' },
  ],
};

export const RELEASE_076286: AppRelease = {
  version: '0.76.286',
  date: '2026-10-16',
  codename: 'Linux em dia com a Jarvis e o uso',
  summary: 'No Linux, a Jarvis conversa em tempo real e opera o Nexus sem modais bloqueantes, o modo Somente Jev manda a captura do navegador ao Clef e as Configurações ganham Uso e custos. A tag 0.76.285 não recebe pacotes Linux. A suíte desta tag não fechou.',
  highlights: [
    { title: 'Jarvis em tempo real', detail: 'O microfone opera em full-duplex no Grok Voice 3.0 e no OpenAI Realtime. O socket quente é reaproveitado, e a voz entrega texto em qualquer pane ou terminal e executa a lista operacional sem modal bloqueante.' },
    { title: 'Clef no navegador', detail: 'Em Somente Jev o texto continua no Jev e a captura do navegador vai ao Clef ou Luna autorizados. O piloto do navegador espera 150 ms entre ações.' },
    { title: 'Uso e custos', detail: 'As Configurações mostram a série diária de 90 dias, recortes de 7, 30 e 90 dias por provedor e modelo, e o gasto mensal real em USD editável na linha.' },
  ],
  fixes: [
    { title: 'Handoff que não cai', detail: 'evidenceIds sem workflow congelado, ou IDs de captura, gravam o handoff como não verificado em vez de recusar a entrega. Um nome livre no spawn vira título do pane.' },
    { title: 'Abas que rolam de lado', detail: 'A roda do mouse rola as abas do painel direito e as sub-abas do Git. A largura mínima do painel fica em 300 px.' },
    { title: 'Conta da Reserva renovada', detail: 'Contas AGY/Gemini e Claude com access token vencido renovam pelo refresh token e gravam a credencial nova.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.285 não recebe pacotes Linux. O ConPTY e a admissão de memória do Windows não são o motivo deste pacote. A suíte da 0.76.286 não fechou; o Linux sai na 0.76.287.' },
  ],
};

export const RELEASE_076287: AppRelease = {
  version: '0.76.287',
  date: '2026-10-16',
  codename: 'Linux em dia com a Jarvis e o uso',
  summary: 'No Linux, a Jarvis conversa em tempo real e opera o Nexus sem modais bloqueantes, o modo Somente Jev manda a captura do navegador ao Clef e as Configurações ganham Uso e custos. A suíte da 0.76.286 não fechou. O smoke empacotado desta tag também não fechou.',
  highlights: [
    { title: 'Jarvis em tempo real', detail: 'O microfone opera em full-duplex no Grok Voice 3.0 e no OpenAI Realtime. O socket quente é reaproveitado, e a voz entrega texto em qualquer pane ou terminal e executa a lista operacional sem modal bloqueante.' },
    { title: 'Clef no navegador', detail: 'Em Somente Jev o texto continua no Jev e a captura do navegador vai ao Clef ou Luna autorizados, inclusive quando a visão já estava ligada sem uma lista de consentimento. O piloto do navegador espera 150 ms entre ações.' },
    { title: 'Uso e custos', detail: 'As Configurações mostram a série diária de 90 dias, recortes de 7, 30 e 90 dias por provedor e modelo, e o gasto mensal real em USD editável na linha.' },
  ],
  fixes: [
    { title: 'Handoff que não cai', detail: 'evidenceIds sem workflow congelado, ou IDs de captura, gravam o handoff como não verificado em vez de recusar a entrega. Um nome livre no spawn vira título do pane.' },
    { title: 'Abas que rolam de lado', detail: 'A roda do mouse rola as abas do painel direito e as sub-abas do Git. A largura mínima do painel fica em 300 px.' },
    { title: 'Conta da Reserva renovada', detail: 'Contas AGY/Gemini e Claude com access token vencido renovam pelo refresh token e gravam a credencial nova.' },
    { title: 'Atualização do Linux', detail: 'As tags 0.76.285 e 0.76.286 não recebem pacotes Linux. A suíte da 0.76.286 não fechava. O smoke empacotado da 0.76.287 também não; o Linux sai na 0.76.288.' },
  ],
};

export const RELEASE_076288: AppRelease = {
  version: '0.76.288',
  date: '2026-10-16',
  codename: 'Linux em dia com a Jarvis e o uso',
  summary: 'No Linux, a Jarvis conversa em tempo real e grava arquivo sem missão, o modo Somente Jev manda a captura do navegador ao Clef e as Configurações ganham Uso e custos. O push continua barrado. As tags 0.76.286 e 0.76.287 não recebem pacotes Linux.',
  highlights: [
    { title: 'Jarvis em tempo real', detail: 'O microfone opera em full-duplex no Grok Voice 3.0 e no OpenAI Realtime. O socket quente é reaproveitado, e a voz entrega texto em qualquer pane ou terminal e executa a lista operacional sem modal bloqueante.' },
    { title: 'Clef no navegador', detail: 'Em Somente Jev o texto continua no Jev e a captura do navegador vai ao Clef ou Luna autorizados, inclusive quando a visão já estava ligada sem uma lista de consentimento. O piloto do navegador espera 150 ms entre ações.' },
    { title: 'Uso e custos', detail: 'As Configurações mostram a série diária de 90 dias, recortes de 7, 30 e 90 dias por provedor e modelo, e o gasto mensal real em USD editável na linha.' },
  ],
  fixes: [
    { title: 'Handoff que não cai', detail: 'evidenceIds sem workflow congelado, ou IDs de captura, gravam o handoff como não verificado em vez de recusar a entrega. Um nome livre no spawn vira título do pane.' },
    { title: 'Abas que rolam de lado', detail: 'A roda do mouse rola as abas do painel direito e as sub-abas do Git. A largura mínima do painel fica em 300 px.' },
    { title: 'Arquivo pela mão do operador', detail: 'A Jarvis grava arquivo no workspace sem missão e sem modal. O push remoto continua exigindo missão.' },
    { title: 'Atualização do Linux', detail: 'As tags 0.76.285, 0.76.286 e 0.76.287 não recebem pacotes Linux. O Linux sai na 0.76.288.' },
  ],
};

export const RELEASE_076289: AppRelease = {
  version: '0.76.289',
  date: '2026-10-16',
  codename: 'macOS em dia com a Jarvis, Clef no Jev e Uso e custos',
  summary: 'No macOS, a Jarvis conversa em tempo real em full-duplex e opera o Nexus sem modais bloqueantes, o modo Somente Jev envia a captura do navegador ao Clef e as Configurações ganham Uso e custos com gasto mensal real em USD.',
  highlights: [
    { title: 'Jarvis em tempo real', detail: 'O microfone opera em full-duplex no Grok Voice 3.0 e no OpenAI Realtime. O socket quente é reaproveitado, e a voz entrega texto em qualquer pane ou terminal e executa a lista operacional sem modal bloqueante.' },
    { title: 'Clef no navegador', detail: 'Em Somente Jev o texto continua no Jev e a captura do navegador vai ao Clef ou Luna autorizados, inclusive quando a visão já estava ligada sem uma lista de consentimento. O piloto do navegador espera 150 ms entre ações.' },
    { title: 'Uso e custos', detail: 'As Configurações mostram a série diária de 90 dias, recortes de 7, 30 e 90 dias por provedor e modelo, e o gasto mensal real em USD editável na linha.' },
  ],
  fixes: [
    { title: 'Handoff que não cai', detail: 'evidenceIds sem workflow congelado, ou IDs de captura, gravam o handoff como não verificado em vez de recusar a entrega. Um nome livre no spawn vira título do pane.' },
    { title: 'Abas que rolam de lado', detail: 'A roda do mouse rola as abas do painel direito e as sub-abas do Git. A largura mínima do painel fica em 300 px.' },
    { title: 'Conta da Reserva renovada', detail: 'Contas AGY/Gemini e Claude com access token vencido renovam pelo refresh token e gravam a credencial nova.' },
    { title: 'Vagas do Trial e Nexus Shot', detail: 'O leque de helpers no Trial reserva duas vagas para o Maestro e o revisor, e a ponte do Nexus Shot aceita target nulo na entrega padrão.' },
  ],
};

export const RELEASE_076290: AppRelease = {
  version: '0.76.290',
  date: '2026-10-16',
  codename: 'Jarvis sem repetição, navegador sob menus, +Pane imediato e Kimi --auto',
  summary: 'A Jarvis responde uma única vez por turno e cura sozinha o click-through da janela, o pane de navegador se recolhe sob popovers, menus e modais, abrir aba nova no +Pane não copia mais o cache do Vitest, o modo YOLO do Kimi usa --auto (Never Ask) e os catálogos AGY 1.4.0, Grok e Codex 0.163.0 entram em dia.',
  highlights: [
    { title: 'Jarvis sem repetição e sempre clicável', detail: 'Em full-duplex, a resposta do turno nasce de um único lado (VAD do servidor no Grok Voice 3.0 e create_response:false no OpenAI Realtime), eliminando a fala duplicada. A janela da Jarvis/companion detecta e desfaz sozinha o estado preso em ignoreMouseEvents.' },
    { title: 'Navegador sob menus e +Pane imediato', detail: 'Popovers, menus e modais ocultam apenas a WebContentsView nativa com que cruzam, sem cobrir controles da interface. Abrir uma aba nova com worktree não copia mais .nexus-cache/vitest (~1,7 GB), destravando o nascimento do pane.' },
    { title: 'Kimi em --auto e catálogos atualizados', detail: 'O modo YOLO do Kimi Code 2.2.0 passa --auto (Never Ask), migrando também flags legadas (--yolo/-y). Catálogos atualizados para AGY 1.4.0, Codex 0.163.0 (gpt-daybreak-blue-latest) e Grok, além das correções F-1307 e F-1545..F-1553.' },
  ],
  fixes: [
    { title: ' +Pane sem espera de cache', detail: 'copyBuildCaches mantém os *.tsbuildinfo e deixa de copiar .nexus-cache/vitest ao materializar a worktree da aba.' },
    { title: 'Uma resposta por turno na Jarvis', detail: 'endUserTurn não dispara response.create duplicado quando o VAD do servidor já é dono do turno.' },
    { title: 'Self-heal do click-through', detail: 'O renderer reconcilia pet:setIgnoreMouseEvents ao abrir controles da Jarvis, montar ou recuperar foco.' },
    { title: 'Oclusão cirúrgica do navegador', detail: 'browser-occlusion observa popovers, menus e diálogos abertos e esconde apenas o navegador que intercepta o retângulo.' },
    { title: 'Kimi sem pedir permissão no YOLO', detail: 'kimi.json, tui-agent-permissions e a migração de overrides legados em adapter-registry usam --auto.' },
  ],
};

export const RELEASE_076291: AppRelease = {
  version: '0.76.291',
  date: '2026-10-16',
  codename: 'Linux em dia com a Jarvis, o navegador e o Kimi',
  summary: 'No Linux, a Jarvis responde uma vez por turno e volta a ser clicável, o navegador se recolhe sob menus, abrir aba nova não copia o cache do Vitest e o Kimi autônomo usa --auto. A suíte desta tag não fechou.',
  highlights: [
    { title: 'Jarvis sem repetição', detail: 'Em full-duplex a resposta nasce de um único lado: o VAD do servidor no Grok Voice 3.0 e create_response:false no OpenAI Realtime. A janela da companion desfaz sozinha o click-through preso.' },
    { title: 'Navegador sob menus e +Pane imediato', detail: 'Popovers, menus e modais ocultam só a vista nativa do navegador que cruza a área. A worktree da aba nova deixa de copiar .nexus-cache/vitest.' },
    { title: 'Kimi em --auto', detail: 'O modo YOLO do Kimi Code 2.2.0 passa --auto (Never Ask) e migra --yolo, -y e o vazio. Catálogos de AGY 1.4.0, Codex 0.163.0 e Grok entram em dia.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'As tags 0.76.289 e 0.76.290 não recebem pacotes Linux. A suíte da 0.76.291 não fechou. O Linux sai na 0.76.292.' },
  ],
};

export const RELEASE_076292: AppRelease = {
  version: '0.76.292',
  date: '2026-10-16',
  codename: 'Linux em dia com a Jarvis, o navegador e o Kimi',
  summary: 'No Linux, a Jarvis responde uma vez por turno e volta a ser clicável, o navegador se recolhe sob menus, abrir aba nova não copia o cache do Vitest e o Kimi autônomo usa --auto. A suíte da 0.76.291 não fechou; o Linux sai nesta versão.',
  highlights: [
    { title: 'Jarvis sem repetição', detail: 'Em full-duplex a resposta nasce de um único lado: o VAD do servidor no Grok Voice 3.0 e create_response:false no OpenAI Realtime. A janela da companion desfaz sozinha o click-through preso.' },
    { title: 'Navegador sob menus e +Pane imediato', detail: 'Popovers, menus e modais ocultam só a vista nativa do navegador que cruza a área. A worktree da aba nova deixa de copiar .nexus-cache/vitest.' },
    { title: 'Kimi em --auto', detail: 'O modo YOLO do Kimi Code 2.2.0 passa --auto (Never Ask) e migra --yolo, -y e o vazio. Catálogos de AGY 1.4.0, Codex 0.163.0 e Grok entram em dia.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'As tags 0.76.289, 0.76.290 e 0.76.291 não recebem pacotes Linux. A suíte da 0.76.291 não fechava. O Linux sai na 0.76.292.' },
  ],
};

export const RELEASE_076293: AppRelease = {
  version: '0.76.293',
  date: '2026-10-16',
  codename: 'Tela sem piscar e anexos que chegam',
  summary: 'O painel Git deixa de piscar e os botões ficam legíveis no tema roxo. Imagem colada aparece no campo da missão, imagem e áudio chegam ao coordenador (com transcrição do áudio), iniciar missão ficou mais claro e mostra "Preparando a missão", e as abas laterais cabem em painel estreito.',
  highlights: [
    { title: 'Painel Git estável', detail: 'As releituras do git status não trocam mais "Mesa limpa" por "Lendo git status", então a tela para de piscar e o foco se mantém. Os botões Puxar, Enviar, Ver histórico e Trocar branch mantêm contraste AA em hover, clique e foco nas sete paletas.' },
    { title: 'Anexos até a missão', detail: 'Imagem colada no campo aparece com miniatura, nome e estado. Imagem e áudio são copiados para a worktree da missão e listados com tipo no prompt do coordenador e dos workers; o áudio é transcrito em segundo plano com o mesmo reconhecimento de voz do ditado.' },
    { title: 'Iniciar missão mais claro', detail: 'O botão "Iniciar criação" fica sempre à vista, ⌘/Ctrl+Enter inicia, os anexos ficam sob o pedido e o início espera o anexo que ainda está copiando. Enquanto a missão é preparada, um painel com mensagens de dev acompanha as etapas reais e permite tentar de novo se falhar.' },
  ],
  fixes: [
    { title: 'Abas do painel lateral', detail: 'Em painel estreito as abas ganham setas de rolagem, alvos de 44 px, teclado completo e o botão de fechar sempre visível.' },
    { title: 'Modos de permissão por CLI', detail: 'Grok, AGY e Qwen ganham os níveis reais de permissão (edições automáticas, plano) além do YOLO, com aviso de risco em Configurações. Os safeArgs de Claude e Codex continuam intactos.' },
  ],
};

export const RELEASE_076294: AppRelease = {
  version: '0.76.294',
  date: '2026-10-16',
  codename: 'Linux em dia com a tela sem piscar e os anexos',
  summary: 'No Linux, o painel Git para de piscar, imagem e áudio chegam à missão e o início mostra "Preparando a missão". A tag 0.76.293 não recebe pacotes Linux. A suíte desta tag não fechou.',
  highlights: [
    { title: 'Painel Git estável', detail: 'As releituras do git status não trocam mais "Mesa limpa" por "Lendo git status", então a tela para de piscar. Os botões Puxar, Enviar, Ver histórico e Trocar branch mantêm contraste ao clicar, inclusive no tema roxo.' },
    { title: 'Anexos até a missão', detail: 'Imagem colada aparece no campo. Imagem e áudio chegam à worktree e ao prompt do coordenador e dos workers; o áudio é transcrito em segundo plano com o reconhecimento de voz do ditado. Iniciar espera o anexo que ainda está copiando.' },
    { title: 'Iniciar missão mais claro', detail: 'O botão fica à vista, ⌘/Ctrl+Enter inicia, e o painel "Preparando a missão" acompanha as etapas reais. Em painel estreito as abas laterais ganham setas e o fechar sempre visível.' },
  ],
  fixes: [
    { title: 'Modos de permissão por CLI', detail: 'Grok, AGY e Qwen ganham os níveis reais de permissão além do YOLO, com aviso de risco. Os safeArgs de Claude e Codex continuam intactos.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.293 não recebe pacotes Linux: é o candidato macOS. A suíte da 0.76.294 não fechou. O Linux sai na 0.76.295.' },
  ],
};

export const RELEASE_076295: AppRelease = {
  version: '0.76.295',
  date: '2026-10-16',
  codename: 'Linux em dia com a tela sem piscar e os anexos',
  summary: 'No Linux, o painel Git para de piscar, imagem e áudio chegam à missão e o início mostra "Preparando a missão". O aviso de risco do YOLO usa entrelinha 1.5. As tags 0.76.293 e 0.76.294 não recebem pacotes Linux.',
  highlights: [
    { title: 'Painel Git estável', detail: 'As releituras do git status não trocam mais "Mesa limpa" por "Lendo git status", então a tela para de piscar. Os botões Puxar, Enviar, Ver histórico e Trocar branch mantêm contraste ao clicar, inclusive no tema roxo.' },
    { title: 'Anexos até a missão', detail: 'Imagem colada aparece no campo. Imagem e áudio chegam à worktree e ao prompt do coordenador e dos workers; o áudio é transcrito em segundo plano com o reconhecimento de voz do ditado. Iniciar espera o anexo que ainda está copiando.' },
    { title: 'Iniciar missão mais claro', detail: 'O botão fica à vista, ⌘/Ctrl+Enter inicia, e o painel "Preparando a missão" acompanha as etapas reais. Em painel estreito as abas laterais ganham setas e o fechar sempre visível.' },
  ],
  fixes: [
    { title: 'Aviso de risco do YOLO', detail: 'O aviso deixou de citar o token inexistente --leading-normal. A entrelinha agora é 1.5, então a declaração vale.' },
    { title: 'Modos de permissão por CLI', detail: 'Grok, AGY e Qwen ganham os níveis reais de permissão além do YOLO, com aviso de risco. Os safeArgs de Claude e Codex continuam intactos.' },
    { title: 'Atualização do Linux', detail: 'As tags 0.76.293 e 0.76.294 não recebem pacotes Linux. A 0.76.293 é o candidato macOS. A suíte da 0.76.294 não fechava. O Linux sai na 0.76.295.' },
  ],
};

export const RELEASE_076296: AppRelease = {
  version: '0.76.296',
  date: '2026-10-17',
  codename: 'Linux em dia com o DeepSeek Flash e o diálogo de início',
  summary: 'No Linux, o DeepSeek Flash entra no menu do Claude, do Qwen Code e do DeepSeek sem trocar o modelo padrão. O rodapé do diálogo de início deixa de ser cortado quando a janela é baixa. A suíte desta tag não fechou.',
  highlights: [
    { title: 'DeepSeek Flash', detail: 'O modelo entra no fim do menu do Claude, do Qwen Code e do DeepSeek. O padrão de cada CLI não muda. No Qwen Code o Flash só aparece quando o endpoint efetivo é a API direta da DeepSeek (api.deepseek.com); DashScope e o Token Plan continuam sem ele. O alias deepseek-v4-flash aponta para o id canônico.' },
    { title: 'Diálogo de início', detail: 'O rodapé, inclusive Cancelar, deixa de sair da tela quando a janela é baixa. O painel cabe no container, o rodapé não encolhe, a divisória fica mais forte e as ações secundárias do rodapé ganham contorno.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'A suíte da 0.76.296 não fechou: o ledger de proveniência ainda tinha o hash antigo de model-catalog.ts. O Linux sai na 0.76.297.' },
  ],
};

export const RELEASE_076297: AppRelease = {
  version: '0.76.297',
  date: '2026-10-17',
  codename: 'Linux em dia com o DeepSeek Flash e o diálogo de início',
  summary: 'No Linux, o DeepSeek Flash entra no menu do Claude, do Qwen Code e do DeepSeek sem trocar o modelo padrão. O rodapé do diálogo de início deixa de ser cortado quando a janela é baixa. A tag 0.76.296 não recebe pacotes Linux.',
  highlights: [
    { title: 'DeepSeek Flash', detail: 'O modelo entra no fim do menu do Claude, do Qwen Code e do DeepSeek. O padrão de cada CLI não muda. No Qwen Code o Flash só aparece quando o endpoint efetivo é a API direta da DeepSeek (api.deepseek.com); DashScope e o Token Plan continuam sem ele. O alias deepseek-v4-flash aponta para o id canônico.' },
    { title: 'Diálogo de início', detail: 'O rodapé, inclusive Cancelar, deixa de sair da tela quando a janela é baixa. O painel cabe no container, o rodapé não encolhe, a divisória fica mais forte e as ações secundárias do rodapé ganham contorno.' },
  ],
  fixes: [
    { title: 'Ledger do catálogo', detail: 'O hash de model-catalog.ts no ledger de proveniência passa a ser o do arquivo, com o DeepSeek Flash classificado como barato no Claude e no Qwen Code.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.296 não recebe pacotes Linux. A suíte não fechava porque o ledger ainda tinha o hash antigo de model-catalog.ts. O Linux sai na 0.76.297.' },
  ],
};

export const RELEASE_076298: AppRelease = {
  version: '0.76.298',
  date: '2026-10-17',
  codename: 'Retomada após reiniciar e uso com filtros',
  summary: 'Abas isoladas e panes de missões voltam após reiniciar o Mac. A Jarvis ganha controles clicáveis e arrastáveis, o DeepSeek Flash entra na especialidade de frontend e os filtros de uso recalculam o painel inteiro. Entrar em outra conta Codex preserva a sessão irmã.',
  highlights: [
    { title: 'Retomada após reiniciar o Mac', detail: 'Abas isoladas e panes de missões em "Dormindo" ou encerradas reabrem sem erro de pasta nem falha ao vincular os anexos selados. A retomada do coordenador aceita a mudança de identificação do dispositivo (st_dev) entre reinicializações.' },
    { title: 'Jarvis clicável e arrastável', detail: 'O HUD de voz responde ao clique e pode ser arrastado. Os controles mostram o estado das opções de entrega e voz, e as barras de nível sonoro ficam mais claras.' },
    { title: 'DeepSeek Flash no frontend', detail: 'O DeepSeek Flash entra na Visual Frontier Lane e no roteamento das especialidades frontend, ui e ux, nos adaptadores DeepSeek, Claude e Qwen Code.' },
    { title: 'Uso e custos com filtros', detail: 'Filtrar por dia, intervalo, ferramenta ou modelo recalcula o painel inteiro. Clicar no dia diretamente na tabela aplica o recorte aos totais e gráficos.' },
    { title: 'Panes mais leves sob pressão', detail: 'A pasta isolada do writer nasce sem copiar o cache do Vitest, a admissão usa uma régua de memória só e, sob pressão de build, o Nexus libera RAM mais rápido e hiberna panes de até dois projetos.' },
    { title: 'Decisões com failover', detail: 'As superfícies calibradas ficam no Jev e, quando um provedor cai, a decisão passa para o próximo e soma o gasto de todas as tentativas. Uso desconhecido mantém o custo estimado no orçamento.' },
  ],
  fixes: [
    { title: 'Contas Codex preservadas', detail: 'Entrar em uma nova conta Codex não revoga a sessão da conta irmã (F-1560).' },
    { title: 'Arquivo sem projeto aberto', detail: 'Colar ou soltar um arquivo sem projeto aberto destaca e foca o seletor de pasta, indicando onde continuar.' },
    { title: 'Abas e retomada de missão', detail: 'Abas de missão aposentada voltam a poder ser fechadas. Na barra lateral, "Abrir para retomar" fica alinhado na coluna do título.' },
    { title: 'Abrir projeto existente', detail: 'A ação "Abrir projeto existente" ganha rótulo visível abaixo de "Novo pedido".' },
    { title: 'Terminal hibernado sem perder saída', detail: 'Hibernar um pane guarda a saída que o terminal ainda tinha na fila, e o pane segue vivo se o descarte do terminal falhar.' },
    { title: 'Relógio de nascimento do pane', detail: 'O tempo de nascimento sobrevive a remontagens; uma tentativa vencida após 90 s continua vencida e o novo spawn recomeça do zero.' },
    { title: 'Rolagem em Configurações → Uso', detail: 'A página não rola mais além do fim da seção.' },
    { title: 'Confirmação ao salvar tema e tecnologias', detail: '"Salvar tema" confirma com "Tema salvo." só depois de o tema voltar na lista; se falhar, o editor continua aberto e mostra o motivo. Salvar as tecnologias do projeto confirma com "Tecnologias salvas." ou mostra o erro.' },
  ],
};

export const RELEASE_076299: AppRelease = {
  version: '0.76.299',
  date: '2026-10-17',
  codename: 'Linux em dia com a retomada, o uso e a Jarvis',
  summary: 'O desktop Linux recebe a retomada de abas e panes, a Jarvis clicável, o DeepSeek Flash no frontend e os filtros de uso. A tag 0.76.298 não recebe pacotes Linux.',
  highlights: [
    { title: 'Retomada depois de reiniciar', detail: 'Abas isoladas e panes de missões em "Dormindo" ou encerradas reabrem com pasta e anexos preservados. A retomada do coordenador aceita a mudança de st_dev entre boots.' },
    { title: 'Jarvis clicável e arrastável', detail: 'O HUD de voz responde ao clique e pode ser arrastado. Os controles mostram o estado das opções de entrega e voz, e as barras de nível sonoro ficam mais claras.' },
    { title: 'DeepSeek Flash no frontend', detail: 'O DeepSeek Flash entra na Visual Frontier Lane e no roteamento das especialidades frontend, ui e ux, nos adaptadores DeepSeek, Claude e Qwen Code.' },
    { title: 'Uso e custos com filtros', detail: 'Filtrar por dia, intervalo, ferramenta ou modelo recalcula o painel inteiro. Clicar no dia diretamente na tabela aplica o recorte aos totais e gráficos.' },
    { title: 'Panes mais leves sob pressão', detail: 'A pasta isolada do writer nasce sem copiar o cache do Vitest, a admissão usa uma régua de memória só e, sob pressão de build, o Nexus libera RAM mais rápido e hiberna panes de até dois projetos.' },
    { title: 'Decisões com failover', detail: 'As superfícies calibradas ficam no Jev e, quando um provedor cai, a decisão passa para o próximo e soma o gasto de todas as tentativas. Uso desconhecido mantém o custo estimado no orçamento.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'A tag 0.76.298 não recebe pacotes Linux: é o candidato macOS e a release do Windows. O desktop Linux sai na 0.76.299.' },
    { title: 'Contas Codex preservadas', detail: 'Entrar em uma nova conta Codex não revoga a sessão da conta irmã (F-1560).' },
    { title: 'Arquivo sem projeto aberto', detail: 'Colar ou soltar um arquivo sem projeto aberto destaca e foca o seletor de pasta, indicando onde continuar.' },
    { title: 'Abas e retomada de missão', detail: 'Abas de missão aposentada voltam a poder ser fechadas. Na barra lateral, "Abrir para retomar" fica alinhado na coluna do título.' },
    { title: 'Abrir projeto existente', detail: 'A ação "Abrir projeto existente" ganha rótulo visível abaixo de "Novo pedido".' },
    { title: 'Terminal hibernado sem perder saída', detail: 'Hibernar um pane guarda a saída que o terminal ainda tinha na fila, e o pane segue vivo se o descarte do terminal falhar.' },
    { title: 'Relógio de nascimento do pane', detail: 'O tempo de nascimento sobrevive a remontagens; uma tentativa vencida após 90 s continua vencida e o novo spawn recomeça do zero.' },
    { title: 'Rolagem em Configurações → Uso', detail: 'A página não rola mais além do fim da seção.' },
    { title: 'Confirmação ao salvar tema e tecnologias', detail: '"Salvar tema" confirma com "Tema salvo." só depois de o tema voltar na lista; se falhar, o editor continua aberto e mostra o motivo. Salvar as tecnologias do projeto confirma com "Tecnologias salvas." ou mostra o erro.' },
  ],
};

export const RELEASE_076300: AppRelease = {
  version: '0.76.300',
  date: '2026-10-17',
  codename: 'Jarvis com corpo de partículas, fala sem laço e janela à mão',
  summary: 'A Jarvis ganha um humano de partículas no HUD ampliado, que acorda ao clique, com alça própria para arrastar. O atalho global recupera a janela minimizada sem roubar o foco, e o relato de handoff não fala por cima do despertar nem entra em laço quando a síntese é lenta.',
  highlights: [
    { title: 'Corpo de partículas no HUD', detail: 'O humano de partículas se forma e se desfaz, muda de estado sozinho, mostra o cursor e desenha ondas enquanto fala. Clicar nele acorda a Jarvis, e a barra de título serve de alça para arrastar o HUD.' },
    { title: 'Janela sempre à mão', detail: 'O atalho global recupera a janela do Nexus mesmo minimizada. Ele só age ao abrir a captura, confere o foco e registra o que fez, sem roubar quem está digitando em outro lugar.' },
    { title: 'Voz sem laço', detail: 'O relato de handoff espera o despertar e o turno da voz terminarem, não segura o microfone e não entra em laço de re-síntese quando a voz local é lenta.' },
  ],
  fixes: [
    { title: 'Figura legível no ocioso', detail: 'Parada, só as mãos e os pés se soltam; as duas pernas continuam legíveis. Com movimento reduzido, a figura fica estática e formada.' },
    { title: 'CSS morto das partículas', detail: 'O CSS antigo das partículas por DOM foi removido e a suíte de tokens religada.' },
  ],
};

export const RELEASE_076301: AppRelease = {
  version: '0.76.301',
  date: '2026-10-17',
  codename: 'Linux em dia com a Jarvis de partículas',
  summary: 'O desktop Linux recebe o humano de partículas da Jarvis, o atalho que recupera a janela e o relato de handoff sem laço. A tag 0.76.300 não recebe pacotes Linux.',
  highlights: [
    { title: 'Corpo de partículas no HUD', detail: 'O humano de partículas se forma e se desfaz, muda de estado sozinho, mostra o cursor e desenha ondas enquanto fala. Clicar nele acorda a Jarvis, e a barra de título serve de alça para arrastar o HUD.' },
    { title: 'Janela sempre à mão', detail: 'O atalho global recupera a janela do Nexus mesmo minimizada. Ele só age ao abrir a captura, confere o foco e registra o que fez, sem roubar quem está digitando em outro lugar.' },
    { title: 'Voz sem laço', detail: 'O relato de handoff espera o despertar e o turno da voz terminarem, não segura o microfone e não entra em laço de re-síntese quando a voz local é lenta.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'A tag 0.76.300 não recebe pacotes Linux: é o candidato macOS. O desktop Linux sai na 0.76.301.' },
    { title: 'Figura legível no ocioso', detail: 'Parada, só as mãos e os pés se soltam; as duas pernas continuam legíveis. Com movimento reduzido, a figura fica estática e formada.' },
  ],
};

export const RELEASE_076302: AppRelease = {
  version: '0.76.302',
  date: '2026-10-17',
  codename: 'Todas as LLMs no roteamento',
  summary: 'O roteador reparte o trabalho entre todas as LLMs instaladas pela cota real de cada assinatura: sobra que vai expirar puxa worker, cota no limite cede e rota que só falha deixa de liderar.',
  highlights: [
    { title: 'Cota entre CLIs', detail: 'Cada CLI ganha um ritmo de cota (folga ÷ tempo até o reset). Assinatura com sobra que vai expirar puxa trabalho e conta como escritor econômico mesmo com preço de API alto; a que está perto do limite cede.' },
    { title: 'Rota que só falha não lidera', detail: 'Modelo com cinco tentativas ou mais e até 20% de sucesso em 14 dias perde o assento no escritor econômico, nas lanes de topo, no revezamento e no fair-share, e cede a liderança à primeira rota pronta do mesmo tier. Só volta quando é a única opção do tier ou pedido pelo nome.' },
    { title: 'Qualquer conjunto de CLIs', detail: 'Sem CLI da tabela instalada, a rota escolhe por qualidade e custo. A primeira onda da missão completa a oferta com todas as CLIs prontas.' },
  ],
  fixes: [
    { title: 'Cota medida cheia sai da rota', detail: 'CLI com janela medida em 100% em todas as contas não recebe worker até o reset; janela por modelo, leitura velha e cadência desconhecida não derrubam nem inventam folga.' },
    { title: 'Fair-share com memória', detail: 'A contagem de uso por CLI sobrevive à limpeza de missões, conta cada pane de IA uma vez e grava em disco sem travar o processo principal.' },
    { title: 'Nome da missão acompanha a aba', detail: 'Renomear a aba renomeia a missão leve dela na barra lateral e no Quadro. Título do operador e missão de squad aprovada não são sobrescritos.' },
  ],
};

export const RELEASE_076303: AppRelease = {
  version: '0.76.303',
  date: '2026-10-18',
  codename: 'Linux em dia com todas as LLMs no roteamento',
  summary: 'O desktop Linux recebe o roteador que reparte o trabalho entre todas as LLMs instaladas pela cota real de cada assinatura. A tag 0.76.302 não recebe pacotes Linux.',
  highlights: [
    { title: 'Cota entre CLIs', detail: 'Cada CLI ganha um ritmo de cota (folga ÷ tempo até o reset). Assinatura com sobra que vai expirar puxa trabalho e conta como escritor econômico mesmo com preço de API alto; a que está perto do limite cede.' },
    { title: 'Rota que só falha não lidera', detail: 'Modelo com cinco tentativas ou mais e até 20% de sucesso em 14 dias perde o assento no escritor econômico, nas lanes de topo, no revezamento e no fair-share, e cede a liderança à primeira rota pronta do mesmo tier. Só volta quando é a única opção do tier ou pedido pelo nome.' },
    { title: 'Qualquer conjunto de CLIs', detail: 'Sem CLI da tabela instalada, a rota escolhe por qualidade e custo. A primeira onda da missão completa a oferta com todas as CLIs prontas.' },
  ],
  fixes: [
    { title: 'Atualização do Linux', detail: 'A tag 0.76.302 não recebe pacotes Linux: é o candidato macOS. O desktop Linux sai na 0.76.303.' },
    { title: 'Cota medida cheia sai da rota', detail: 'CLI com janela medida em 100% em todas as contas não recebe worker até o reset; janela por modelo, leitura velha e cadência desconhecida não derrubam nem inventam folga.' },
    { title: 'Fair-share com memória', detail: 'A contagem de uso por CLI sobrevive à limpeza de missões, conta cada pane de IA uma vez e grava em disco ao sair, sem travar o processo principal.' },
    { title: 'Nome da missão acompanha a aba', detail: 'Renomear a aba renomeia a missão leve dela na barra lateral e no Quadro. Título do operador e missão de squad aprovada não são sobrescritos.' },
  ],
};

export const RELEASE_076304: AppRelease = {
  version: '0.76.304',
  date: '2026-10-18',
  codename: 'Linux em dia com a chave do Qwen',
  summary: 'A chave do Qwen configurada no Nexus chega ao pane, isolada do settings do operador, na base URL que a chave aceita. 401 de chave inválida deixa de ser tratado como limite.',
  highlights: [
    { title: 'Chave do Qwen no pane', detail: 'O overlay grava os modelProviders na base URL que a chave aceita. A chave sk-sp- do Token Plan só fala com a URL exclusiva do plano; no DashScope ela morria em 401.' },
    { title: 'Settings do operador fica de fora', detail: 'A cópia mesclada do overlay não leva as credenciais Alibaba do operador. O que o Nexus impõe fica num settings de sistema à parte, e a entrada só aponta uma variável de ambiente nova a cada spawn.' },
    { title: 'Base URL em Providers', detail: 'Em Qwen › Avançado dá para fixar a Base URL. Vazio continua automático pela chave. Endereço novo pede confirmação e precisa ser https, sem usuário nem senha.' },
  ],
  fixes: [
    { title: 'Sonda no mesmo par', detail: 'A prontidão prova a mesma chave e a mesma URL que o pane vai usar. 401 ou 403 é credencial recusada, não cota.' },
    { title: 'Aviso só do Qwen', detail: 'O failover do Qwen fala de chave ou base URL incompatível. Login expirado de Claude, Codex e AGY continua com o texto de sessão.' },
    { title: 'Prosa não troca a conta', detail: 'A frase solta "Invalid API-key" com hífen não arma o failover: ela aparece em texto, log e diff. Overlay de Qwen deixado por processo morto é limpo no boot.' },
  ],
};

export const RELEASE_076305: AppRelease = {
  version: '0.76.305',
  date: '2026-10-18',
  codename: 'Linux em dia com a chave do Qwen',
  summary: 'O desktop Linux recebe a chave do Qwen isolada do settings do operador, na base URL que a chave aceita. A tag 0.76.304 no espelho público ficou com o candidato Windows.',
  highlights: [
    { title: 'Chave do Qwen no pane', detail: 'O overlay grava os modelProviders na base URL que a chave aceita. A chave sk-sp- do Token Plan só fala com a URL exclusiva do plano; no DashScope ela morria em 401.' },
    { title: 'Settings do operador fica de fora', detail: 'A cópia mesclada do overlay não leva as credenciais Alibaba do operador. O que o Nexus impõe fica num settings de sistema à parte, e a entrada só aponta uma variável de ambiente nova a cada spawn.' },
    { title: 'Base URL em Providers', detail: 'Em Qwen › Avançado dá para fixar a Base URL. Vazio continua automático pela chave. Endereço novo pede confirmação e precisa ser https, sem usuário nem senha.' },
  ],
  fixes: [
    { title: 'Credencial do admin fica', detail: 'A chave que o administrador provisionou no settings de sistema não é apagada. O descarte de uma entrada que interpola $ deixa rastro só com o caminho, nunca com o valor.' },
    { title: 'Sonda no mesmo par', detail: 'A prontidão prova a mesma chave e a mesma URL que o pane vai usar. 401 ou 403 é credencial recusada, não cota.' },
    { title: 'Aviso só do Qwen', detail: 'O failover do Qwen fala de chave ou base URL incompatível. Login expirado de Claude, Codex e AGY continua com o texto de sessão. A frase solta "Invalid API-key" não troca a conta.' },
    { title: 'Atualização do Linux', detail: 'A tag 0.76.304 no espelho público não recebe pacotes Linux: é o candidato Windows. O desktop Linux sai na 0.76.305.' },
  ],
};

export const RELEASE_076306: AppRelease = {
  version: '0.76.306',
  date: '2026-10-18',
  codename: 'Reserva sem rota falha e chave do Qwen no Mac',
  summary: 'A reserva do Claude passa a preferir a primeira alternativa saudável, sem reabrir circuito aberto, e o vigia de esteira para de cobrar workers enquanto a missão espera a verificação de conclusão. O macOS recebe também a chave do Qwen isolada do settings do operador.',
  highlights: [
    { title: 'Reserva do Claude prefere rota saudável', detail: 'Quando o Claude fica reservado ao Maestro, o worker vai para a primeira alternativa que não é falha provada (cinco tentativas ou mais e até 20% de sucesso, como uma CLI com credencial recusada). Se todas as alternativas fora do Claude forem falhas provadas, a primeira delas ainda herda a vaga.' },
    { title: 'Esteira em silêncio na verificação', detail: 'Depois que o Maestro atual pede a conclusão, o lembrete "Esteira parada" deixa de chegar a cada hora enquanto a verificação não responde. Se a verificação recusar a entrega, o lembrete volta.' },
    { title: 'Chave do Qwen no pane', detail: 'O overlay grava os modelProviders na base URL que a chave aceita, e a cópia mesclada não leva as credenciais Alibaba do operador. Em Qwen › Avançado dá para fixar a Base URL; vazio continua automático pela chave.' },
  ],
  fixes: [
    { title: 'Circuito aberto fica fora da reserva', detail: 'A troca da reserva não escolhe CLI com circuito aberto; sem alternativa com o circuito fechado ou meio aberto, o Claude é mantido.' },
    { title: 'Lane de segurança respeitada', detail: 'Em auditoria de segurança crítica, a troca fica entre Claude e Codex, como o recibo diz, e não escapa para outra CLI.' },
    { title: 'Qwen: sonda e aviso certos', detail: 'A prontidão prova a mesma chave e URL que o pane vai usar, 401 ou 403 é credencial recusada e não cota, e o failover do Qwen fala de chave ou base URL incompatível.' },
  ],
};

export const RELEASE_076307: AppRelease = {
  version: '0.76.307',
  date: '2026-10-18',
  codename: 'Reserva sem rota falha no Linux',
  summary: 'O desktop Linux recebe a reserva do Claude que prefere a primeira alternativa saudável, sem reabrir circuito aberto, e o vigia de esteira para de cobrar workers enquanto a missão espera a verificação de conclusão. A tag 0.76.306 ficou no macOS.',
  highlights: [
    { title: 'Reserva do Claude prefere rota saudável', detail: 'Quando o Claude fica reservado ao Maestro, o worker vai para a primeira alternativa que não é falha provada (cinco tentativas ou mais e até 20% de sucesso, como uma CLI com credencial recusada). Se todas as alternativas fora do Claude forem falhas provadas, a primeira delas ainda herda a vaga.' },
    { title: 'Esteira em silêncio na verificação', detail: 'Depois que o Maestro atual pede a conclusão, o lembrete "Esteira parada" deixa de chegar a cada hora enquanto a verificação não responde. Se a verificação recusar a entrega, o lembrete volta.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.306 é o candidato macOS e não recebe pacotes Linux. O desktop Linux sai na 0.76.307.' },
  ],
  fixes: [
    { title: 'Circuito aberto fica fora da reserva', detail: 'A troca da reserva não escolhe CLI com circuito aberto; sem alternativa com o circuito fechado ou meio aberto, o Claude é mantido.' },
    { title: 'Lane de segurança respeitada', detail: 'Em auditoria de segurança crítica, a troca fica entre Claude e Codex, como o recibo diz, e não escapa para outra CLI.' },
  ],
};

export const RELEASE_076308: AppRelease = {
  version: '0.76.308',
  date: '2026-10-18',
  codename: 'Recibo fiel e esteira sem corrida no Mac',
  summary: 'O recibo de rota deixa de dizer que evitou a rota falha quando o fail-open acabou escolhendo justamente ela, e o vigia de esteira relê o pedido de conclusão antes de mandar o lembrete. O smoke do macOS fica estável sob carga.',
  highlights: [
    { title: 'Recibo de rota fiel', detail: 'Quando todas as alternativas fora do Claude são falhas provadas e a primeira delas herda a vaga, o recibo não cita mais "evitou rota falha". O resto do recibo continua igual.' },
    { title: 'Esteira sem corrida na conclusão', detail: 'O vigia confere de novo o pedido de conclusão depois da análise do Jev e antes de enviar o lembrete "Esteira parada". Um pedido feito nesse intervalo pelo Maestro atual cala o lembrete; pedido de outra sessão, versão ou missão não cala.' },
  ],
  fixes: [
    { title: 'Smoke do macOS estável sob carga', detail: 'A sonda de PTY do smoke espera a prova de assinatura do boot antes de abrir o terminal. Se a prova falhar ou travar, o smoke falha de forma visível no timeout normal, sem prender o gate.' },
  ],
};

export const RELEASE_076309: AppRelease = {
  version: '0.76.309',
  date: '2026-10-18',
  codename: 'Recibo fiel e esteira sem corrida no Linux',
  summary: 'O desktop Linux recebe o recibo de rota que deixa de dizer que evitou a rota falha quando o fail-open a escolheu, e o vigia de esteira relê o pedido de conclusão antes de mandar o lembrete. A tag 0.76.308 ficou no macOS.',
  highlights: [
    { title: 'Recibo de rota fiel', detail: 'Quando todas as alternativas fora do Claude são falhas provadas e a primeira delas herda a vaga, o recibo não cita mais "evitou rota falha". O resto do recibo continua igual.' },
    { title: 'Esteira sem corrida na conclusão', detail: 'O vigia confere de novo o pedido de conclusão depois da análise do Jev e antes de enviar o lembrete "Esteira parada". Um pedido feito nesse intervalo pelo Maestro atual cala o lembrete; pedido de outra sessão, versão ou missão não cala.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.308 é o candidato macOS e não recebe pacotes Linux. O desktop Linux sai na 0.76.309.' },
  ],
  fixes: [],
};

export const RELEASE_076310: AppRelease = {
  version: '0.76.310',
  date: '2026-10-18',
  codename: 'Retomada à vista no Mac',
  summary: 'Missão interrompida mostra onde clicar para retomar, login expirado troca de conta sozinho, workers não param em plan mode, o Nexus Shot é atualizado junto, o JARVIS Live volta a arrastar e reagir à voz, a assinatura vem antes da API key, a Muse logada volta a abrir, queda de rede troca de CLI e as missões andam mais rápido.',
  highlights: [
    { title: 'Retomar missão à vista', detail: 'Depois de reinício, crash ou travamento, a missão aparece como Interrompida num cartão único com o botão Retomar missão em destaque na barra do pane e no ⌘K. Os avisos do terminal apontam para esse botão, Fechar avisa quando é o último pane da missão, e depois de 20 s restaurando os agentes o Nexus diz o que está esperando.' },
    { title: 'Retomada mais confiável', detail: 'A entrega de handoff depois do reinício não se perde nem duplica, a equipe parada há muito tempo aparece no quadro, worker travado sem telemetria é detectado. Um clique duplo em Retomar reabre a missão uma vez só, e o cartão de interrompida não corta mais o grid de panes.' },
    { title: 'Login expirado troca de conta', detail: 'Quando o Claude mostra "Login expired · Please run /login", o Nexus troca a conta do pane para outra pronta em vez de deixar o Maestro parado. A troca nunca mexe no login global do Mac.' },
    { title: 'Workers sem tela de plano', detail: 'Workers da família Claude nascem em modo direto, sem plan mode: não param mais em "aprovar plano".' },
    { title: 'Nexus Shot atualizado junto', detail: 'O Nexus atualiza o Nexus Shot instalado quando ele está abaixo da versão mínima ou crashou recentemente, baixando só do feed oficial e conferindo assinatura, equipe e Gatekeeper antes de trocar.' },
    { title: 'JARVIS Live solto e vivo', detail: 'A pílula do JARVIS não pisca mais ao passar o mouse e volta a arrastar e clicar sobre o cabeçalho do Mac. As partículas se mexem com a própria voz ao falar e com o microfone ao ouvir, e a voz continua audível mesmo se o medidor falhar.' },
    { title: 'Assinatura antes de API key', detail: 'Quando o mesmo modelo chega por duas rotas, como o DeepSeek pelo Qwen Code no plano do operador e pelo adapter DeepSeek com API key, o Nexus prefere a rota da assinatura. A API key fica de reserva para quando a assinatura estiver sem credencial, em cooldown ou falhando.' },
    { title: 'Missões mais rápidas', detail: 'Comandos de leitura pesados (typecheck, testes) rodam em paralelo e só build/instalação ficam exclusivos. Um pedido espera na fila com ticket em vez de falhar. O gate de regressão guarda o mapa de imports em disco e escolhe os testes pelo nome do arquivo, e worker parado é reaberto uma vez em vez de segurar a esteira.' },
  ],
  fixes: [
    { title: 'Spawn de worker resiste a Git transitório', detail: 'A criação da worktree repete falhas passageiras do Git e diz a causa quando desiste.' },
    { title: 'Rota confere a credencial', detail: 'O Nexus testa a credencial da CLI escolhida antes de abrir o worker e evita CLI com login recusado.' },
    { title: 'Muse logada volta a abrir', detail: 'A Muse com login guardado no Keychain era recusada no spawn e caía calada no Claude. Agora a checagem de login do spawn é a mesma da tela e da rota, um teste cobre todos os formatos de login conhecidos e, se as duas discordarem, o Nexus avisa em vez de trocar de CLI escondido.' },
    { title: 'Recibo diz a CLI que subiu', detail: 'Quando a credencial de uma CLI é recusada e o assento passa para outra, o recibo do spawn, o título do pane e a lista de panes mostram a CLI e o modelo reais, com o motivo da troca. Uma CLI recusada duas vezes em 1 h sai da rota até a credencial voltar.' },
    { title: 'Queda de rede troca de CLI', detail: 'Uma CLI presa no contador "check your network" não conta mais como trabalhando: esgotada a espera, o Nexus marca falha do provedor e reabre a tarefa em outra CLI.' },
    { title: 'Git mais seguro e sem travar', detail: 'O supervisor usa o runner git seguro do Nexus, o diff do gate ignora textconv/ext-diff e as buscas do gate rodam assíncronas e com teto de tempo. A mensagem de fila pesada fica curta o bastante para chegar ao terminal.' },
    { title: 'Esteira parada não insiste com o operador', detail: 'Enquanto o Maestro espera uma decisão sua, o aviso de esteira parada fica em silêncio; depois de 6 h sai um único lembrete no inspector. Uma segunda onda de tarefas prontas espera os 30 s de novo em vez de herdar o carimbo antigo.' },
    { title: 'Instalador do Shot mais rígido', detail: 'O Nexus confere o Shot pelo requisito do codesign (identificador e equipe), só aceita asset do repositório oficial e nunca apaga o app antigo se a troca e a restauração falharem.' },
    { title: 'Fila pesada por repositório', detail: 'Build de outro repositório (ex.: o Shot) não segura mais typecheck e testes do Nexus.' },
    { title: 'Publicação do Mac resiste à main andando', detail: 'Se outra plataforma empurrar a main durante a publicação, o script atualiza e segue sem forçar nada.' },
  ],
};

export const RELEASE_076311: AppRelease = {
  version: '0.76.311',
  date: '2026-10-19',
  codename: 'Retomada no Linux',
  summary: 'O desktop Linux recebe a retomada de missão à vista, a troca de conta quando o login expira, workers sem plan mode, a preferência pela assinatura, a voz do JARVIS nas partículas e missões mais rápidas. A tag 0.76.310 ficou no macOS.',
  highlights: [
    { title: 'Retomar missão à vista', detail: 'Depois de reinício, crash ou travamento, a missão aparece como Interrompida num cartão único, com Retomar missão em destaque na barra do pane e na paleta de comandos. Os avisos do terminal apontam para esse botão, Fechar avisa quando é o último pane da missão, e depois de 20 s restaurando os agentes o Nexus diz o que está esperando.' },
    { title: 'Retomada mais confiável', detail: 'A entrega de handoff depois do reinício não se perde nem duplica, a equipe parada há muito tempo aparece no quadro e worker travado sem telemetria é detectado. Um clique duplo em Retomar reabre a missão uma vez só, e o cartão de interrompida não corta mais o grid de panes.' },
    { title: 'Login expirado troca de conta', detail: 'Quando o Claude mostra "Login expired · Please run /login", o Nexus troca a conta do pane para outra pronta em vez de deixar o Maestro parado.' },
    { title: 'Workers sem tela de plano', detail: 'Workers da família Claude nascem em modo direto, sem plan mode: não param mais em "aprovar plano".' },
    { title: 'JARVIS reage à própria voz', detail: 'As partículas se mexem com a voz ao falar e com o microfone ao ouvir, e a voz continua audível mesmo se o medidor falhar.' },
    { title: 'Assinatura antes de API key', detail: 'Quando o mesmo modelo chega por duas rotas, como o DeepSeek pelo Qwen Code no plano do operador e pelo adapter DeepSeek com API key, o Nexus prefere a rota da assinatura. A API key fica de reserva para quando a assinatura estiver sem credencial, em cooldown ou falhando.' },
    { title: 'Missões mais rápidas', detail: 'Comandos de leitura pesados (typecheck, testes) rodam em paralelo e só build e instalação ficam exclusivos. Um pedido espera na fila com ticket em vez de falhar. O gate de regressão guarda o mapa de imports em disco e escolhe os testes pelo nome do arquivo, e worker parado é reaberto uma vez em vez de segurar a esteira.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.310 é o candidato macOS e não recebe pacotes Linux. O desktop Linux sai na 0.76.311.' },
  ],
  fixes: [
    { title: 'Spawn de worker resiste a Git transitório', detail: 'A criação da worktree repete falhas passageiras do Git e diz a causa quando desiste.' },
    { title: 'Rota confere a credencial', detail: 'O Nexus testa a credencial da CLI escolhida antes de abrir o worker e evita CLI com login recusado. A checagem de login do spawn é a mesma da tela e da rota; se as duas discordarem, o Nexus avisa em vez de trocar de CLI escondido.' },
    { title: 'Recibo diz a CLI que subiu', detail: 'Quando a credencial de uma CLI é recusada e o assento passa para outra, o recibo do spawn, o título do pane e a lista de panes mostram a CLI e o modelo reais, com o motivo da troca. A segunda recusa dentro de 1 h liga de fato a saída da rota até a credencial voltar. A sonda de recuperação roda no máximo uma vez por CLI a cada 10 min.' },
    { title: 'Queda de rede troca de CLI', detail: 'Uma CLI presa no contador "check your network" não conta mais como trabalhando: esgotada a espera, o Nexus marca falha do provedor e reabre a tarefa em outra CLI.' },
    { title: 'Git mais seguro e sem travar', detail: 'O supervisor usa o runner git seguro do Nexus, o diff do gate ignora textconv/ext-diff e as buscas do gate rodam assíncronas e com teto de tempo. A mensagem de fila pesada fica curta o bastante para chegar ao terminal.' },
    { title: 'Esteira parada não insiste com o operador', detail: 'Enquanto o Maestro espera uma decisão sua, o aviso de esteira parada fica em silêncio; depois de 6 h sai um único lembrete no inspector. Uma segunda onda de tarefas prontas espera os 30 s de novo em vez de herdar o carimbo antigo.' },
    { title: 'Fila pesada por repositório', detail: 'Build de outro repositório não segura mais typecheck e testes do Nexus.' },
  ],
};

export const RELEASE_076312: AppRelease = {
  version: '0.76.312',
  date: '2026-10-19',
  codename: 'Retomada no Linux',
  summary: 'O desktop Linux recebe a retomada de missão à vista, a troca de conta quando o login expira, workers sem plan mode, a preferência pela assinatura, a voz do JARVIS nas partículas e missões mais rápidas. A tag 0.76.310 ficou no macOS. A 0.76.311 não foi publicada.',
  highlights: [
    { title: 'Retomar missão à vista', detail: 'Depois de reinício, crash ou travamento, a missão aparece como Interrompida num cartão único, com Retomar missão em destaque na barra do pane e na paleta de comandos. Os avisos do terminal apontam para esse botão, Fechar avisa quando é o último pane da missão, e depois de 20 s restaurando os agentes o Nexus diz o que está esperando.' },
    { title: 'Retomada mais confiável', detail: 'A entrega de handoff depois do reinício não se perde nem duplica, a equipe parada há muito tempo aparece no quadro e worker travado sem telemetria é detectado. Um clique duplo em Retomar reabre a missão uma vez só, e o cartão de interrompida não corta mais o grid de panes.' },
    { title: 'Login expirado troca de conta', detail: 'Quando o Claude mostra "Login expired · Please run /login", o Nexus troca a conta do pane para outra pronta em vez de deixar o Maestro parado.' },
    { title: 'Workers sem tela de plano', detail: 'Workers da família Claude nascem em modo direto, sem plan mode: não param mais em "aprovar plano".' },
    { title: 'JARVIS reage à própria voz', detail: 'As partículas se mexem com a voz ao falar e com o microfone ao ouvir, e a voz continua audível mesmo se o medidor falhar.' },
    { title: 'Assinatura antes de API key', detail: 'Quando o mesmo modelo chega por duas rotas, como o DeepSeek pelo Qwen Code no plano do operador e pelo adapter DeepSeek com API key, o Nexus prefere a rota da assinatura. A API key fica de reserva para quando a assinatura estiver sem credencial, em cooldown ou falhando.' },
    { title: 'Missões mais rápidas', detail: 'Comandos de leitura pesados (typecheck, testes) rodam em paralelo e só build e instalação ficam exclusivos. Um pedido espera na fila com ticket em vez de falhar. O gate de regressão guarda o mapa de imports em disco e escolhe os testes pelo nome do arquivo, e worker parado é reaberto uma vez em vez de segurar a esteira.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.310 é o candidato macOS e não recebe pacotes Linux. A 0.76.311 não foi publicada porque a suíte não fechou. O desktop Linux sai na 0.76.312.' },
  ],
  fixes: [
    { title: 'Spawn de worker resiste a Git transitório', detail: 'A criação da worktree repete falhas passageiras do Git e diz a causa quando desiste.' },
    { title: 'Rota confere a credencial', detail: 'O Nexus testa a credencial da CLI escolhida antes de abrir o worker e evita CLI com login recusado. A checagem de login do spawn é a mesma da tela e da rota; se as duas discordarem, o Nexus avisa em vez de trocar de CLI escondido.' },
    { title: 'Recibo diz a CLI que subiu', detail: 'Quando a credencial de uma CLI é recusada e o assento passa para outra, o recibo do spawn, o título do pane e a lista de panes mostram a CLI e o modelo reais, com o motivo da troca. A segunda recusa dentro de 1 h liga de fato a saída da rota até a credencial voltar. A sonda de recuperação roda no máximo uma vez por CLI a cada 10 min.' },
    { title: 'Queda de rede troca de CLI', detail: 'Uma CLI presa no contador "check your network" não conta mais como trabalhando: esgotada a espera, o Nexus marca falha do provedor e reabre a tarefa em outra CLI.' },
    { title: 'Git mais seguro e sem travar', detail: 'O supervisor usa o runner git seguro do Nexus, o diff do gate ignora textconv/ext-diff e as buscas do gate rodam assíncronas e com teto de tempo. A mensagem de fila pesada fica curta o bastante para chegar ao terminal.' },
    { title: 'Esteira parada não insiste com o operador', detail: 'Enquanto o Maestro espera uma decisão sua, o aviso de esteira parada fica em silêncio; depois de 6 h sai um único lembrete no inspector. Uma segunda onda de tarefas prontas espera os 30 s de novo em vez de herdar o carimbo antigo.' },
    { title: 'Fila pesada por repositório', detail: 'Build de outro repositório não segura mais typecheck e testes do Nexus.' },
  ],
};

export const RELEASE_076313: AppRelease = {
  version: '0.76.313',
  date: '2026-10-19',
  codename: 'Retomada à vista no Mac',
  summary: 'O macOS recebe tudo da 0.76.310 a 0.76.312: retomada de missão à vista, troca de conta quando o login expira, workers sem plan mode, a assinatura antes da API key, a voz do JARVIS nas partículas e missões mais rápidas. O Muse logado volta a ser escolhido pela rota e o pane reaberto atende pelo próprio id. A tag 0.76.310 não foi publicada.',
  highlights: [
    { title: 'Retomar missão à vista', detail: 'Depois de reinício, crash ou travamento, a missão aparece como Interrompida num cartão único, com Retomar missão em destaque na barra do pane e na paleta de comandos. Os avisos do terminal apontam para esse botão, Fechar avisa quando é o último pane da missão, e depois de 20 s restaurando os agentes o Nexus diz o que está esperando.' },
    { title: 'Retomada mais confiável', detail: 'A entrega de handoff depois do reinício não se perde nem duplica, a equipe parada há muito tempo aparece no quadro e worker travado sem telemetria é detectado. Um clique duplo em Retomar reabre a missão uma vez só, e o cartão de interrompida não corta mais o grid de panes.' },
    { title: 'Login expirado troca de conta', detail: 'Quando o Claude mostra "Login expired · Please run /login", o Nexus troca a conta do pane para outra pronta em vez de deixar o Maestro parado.' },
    { title: 'Workers sem tela de plano', detail: 'Workers da família Claude nascem em modo direto, sem plan mode: não param mais em "aprovar plano".' },
    { title: 'JARVIS reage à própria voz', detail: 'As partículas se mexem com a voz ao falar e com o microfone ao ouvir, e a voz continua audível mesmo se o medidor falhar.' },
    { title: 'Assinatura antes de API key', detail: 'Quando o mesmo modelo chega por duas rotas, como o DeepSeek pelo Qwen Code no plano do operador e pelo adapter DeepSeek com API key, o Nexus prefere a rota da assinatura. A API key fica de reserva para quando a assinatura estiver sem credencial, em cooldown ou falhando.' },
    { title: 'Missões mais rápidas', detail: 'Comandos de leitura pesados (typecheck, testes) rodam em paralelo e só build e instalação ficam exclusivos. Um pedido espera na fila com ticket em vez de falhar. O gate de regressão guarda o mapa de imports em disco e escolhe os testes pelo nome do arquivo, e worker parado é reaberto uma vez em vez de segurar a esteira.' },
    { title: 'Pacote macOS', detail: 'A 0.76.313 leva ao Mac o que saiu no Linux na 0.76.312 e as correções abaixo. A tag 0.76.310 não foi publicada: o gate do candidato caiu e as correções desta versão entraram antes.' },
  ],
  fixes: [
    { title: 'Spawn de worker resiste a Git transitório', detail: 'A criação da worktree repete falhas passageiras do Git e diz a causa quando desiste.' },
    { title: 'Rota confere a credencial', detail: 'O Nexus testa a credencial da CLI escolhida antes de abrir o worker e evita CLI com login recusado. A checagem de login do spawn é a mesma da tela e da rota; se as duas discordarem, o Nexus avisa em vez de trocar de CLI escondido.' },
    { title: 'Recibo diz a CLI que subiu', detail: 'Quando a credencial de uma CLI é recusada e o assento passa para outra, o recibo do spawn, o título do pane e a lista de panes mostram a CLI e o modelo reais, com o motivo da troca. A segunda recusa dentro de 1 h liga de fato a saída da rota até a credencial voltar. A sonda de recuperação roda no máximo uma vez por CLI a cada 10 min.' },
    { title: 'Queda de rede troca de CLI', detail: 'Uma CLI presa no contador "check your network" não conta mais como trabalhando: esgotada a espera, o Nexus marca falha do provedor e reabre a tarefa em outra CLI.' },
    { title: 'Git mais seguro e sem travar', detail: 'O supervisor usa o runner git seguro do Nexus, o diff do gate ignora textconv/ext-diff e as buscas do gate rodam assíncronas e com teto de tempo. A mensagem de fila pesada fica curta o bastante para chegar ao terminal.' },
    { title: 'Esteira parada não insiste com o operador', detail: 'Enquanto o Maestro espera uma decisão sua, o aviso de esteira parada fica em silêncio; depois de 6 h sai um único lembrete no inspector. Uma segunda onda de tarefas prontas espera os 30 s de novo em vez de herdar o carimbo antigo.' },
    { title: 'Fila pesada por repositório', detail: 'Build de outro repositório não segura mais typecheck e testes do Nexus.' },
    { title: 'Muse logado volta à rota', detail: 'Recusas de credencial antigas deixavam o Muse como "rota falha" mesmo depois do login, e o Nexus desviava dele. Quando o teste da credencial volta a passar, essas recusas deixam de contar no histórico de sucesso da CLI. Falhas de entrega reais continuam contando.' },
    { title: 'Pane reaberto atende pelo id', detail: 'Depois de reabrir o CLI de um pane, ler ou escrever nele pelo id respondia "unknown pane" listando o próprio pane. O Nexus agora escolhe a sessão viva desse pane; com duas sessões vivas continua recusando.' },
    { title: 'Gate do candidato diz o que caiu', detail: 'Quando uma etapa do gate de release falha, a mensagem nomeia o script e mostra o fim da saída, onde está o motivo, em vez do caminho do executável.' },
  ],
};

export const RELEASE_076314: AppRelease = {
  version: '0.76.314',
  date: '2026-10-19',
  codename: 'Muse de volta à rota',
  summary: 'No desktop Linux, o Muse que já está logado volta a ser escolhido pela rota, e um pane cujo CLI foi reaberto volta a atender pelo próprio id. A tag 0.76.313 ficou no macOS.',
  highlights: [
    { title: 'Muse logado volta à rota', detail: 'Recusas de credencial antigas deixavam o Muse como "rota falha" mesmo depois do login, e o Nexus desviava dele. Quando o teste da credencial volta a passar, essas recusas deixam de contar no histórico de sucesso da CLI. Falhas de entrega reais continuam contando.' },
    { title: 'Pane reaberto atende pelo id', detail: 'Depois de reabrir o CLI de um pane, ler ou escrever nele pelo id respondia "unknown pane" listando o próprio pane. O Nexus agora escolhe a sessão viva desse pane; com duas sessões vivas continua recusando.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.313 é o candidato macOS e não recebe pacotes Linux. O desktop Linux sai na 0.76.314.' },
  ],
  fixes: [],
};

export const RELEASE_076315: AppRelease = {
  version: '0.76.315',
  date: '2026-10-19',
  codename: 'Retomada à vista no Mac',
  summary: 'O macOS recebe tudo da 0.76.310 a 0.76.314: retomada de missão à vista, troca de conta quando o login expira, workers sem plan mode, a assinatura antes da API key, a voz do JARVIS nas partículas e missões mais rápidas. O Muse logado volta a ser escolhido pela rota e o pane reaberto atende pelo próprio id. As tags 0.76.310 e 0.76.313 não foram publicadas.',
  highlights: [
    { title: 'Retomar missão à vista', detail: 'Depois de reinício, crash ou travamento, a missão aparece como Interrompida num cartão único, com Retomar missão em destaque na barra do pane e na paleta de comandos. Os avisos do terminal apontam para esse botão, Fechar avisa quando é o último pane da missão, e depois de 20 s restaurando os agentes o Nexus diz o que está esperando.' },
    { title: 'Retomada mais confiável', detail: 'A entrega de handoff depois do reinício não se perde nem duplica, a equipe parada há muito tempo aparece no quadro e worker travado sem telemetria é detectado. Um clique duplo em Retomar reabre a missão uma vez só, e o cartão de interrompida não corta mais o grid de panes.' },
    { title: 'Login expirado troca de conta', detail: 'Quando o Claude mostra "Login expired · Please run /login", o Nexus troca a conta do pane para outra pronta em vez de deixar o Maestro parado.' },
    { title: 'Workers sem tela de plano', detail: 'Workers da família Claude nascem em modo direto, sem plan mode: não param mais em "aprovar plano".' },
    { title: 'JARVIS reage à própria voz', detail: 'As partículas se mexem com a voz ao falar e com o microfone ao ouvir, e a voz continua audível mesmo se o medidor falhar.' },
    { title: 'Assinatura antes de API key', detail: 'Quando o mesmo modelo chega por duas rotas, como o DeepSeek pelo Qwen Code no plano do operador e pelo adapter DeepSeek com API key, o Nexus prefere a rota da assinatura. A API key fica de reserva para quando a assinatura estiver sem credencial, em cooldown ou falhando.' },
    { title: 'Missões mais rápidas', detail: 'Comandos de leitura pesados (typecheck, testes) rodam em paralelo e só build e instalação ficam exclusivos. Um pedido espera na fila com ticket em vez de falhar. O gate de regressão guarda o mapa de imports em disco e escolhe os testes pelo nome do arquivo, e worker parado é reaberto uma vez em vez de segurar a esteira.' },
    { title: 'Pacote macOS', detail: 'A 0.76.315 leva ao Mac o que saiu no Linux até a 0.76.314 e as correções abaixo. As tags 0.76.310 e 0.76.313 não foram publicadas: o gate do candidato caiu na primeira e a 0.76.314 do Linux saiu antes da segunda.' },
  ],
  fixes: [
    { title: 'Spawn de worker resiste a Git transitório', detail: 'A criação da worktree repete falhas passageiras do Git e diz a causa quando desiste.' },
    { title: 'Rota confere a credencial', detail: 'O Nexus testa a credencial da CLI escolhida antes de abrir o worker e evita CLI com login recusado. A checagem de login do spawn é a mesma da tela e da rota; se as duas discordarem, o Nexus avisa em vez de trocar de CLI escondido.' },
    { title: 'Recibo diz a CLI que subiu', detail: 'Quando a credencial de uma CLI é recusada e o assento passa para outra, o recibo do spawn, o título do pane e a lista de panes mostram a CLI e o modelo reais, com o motivo da troca. A segunda recusa dentro de 1 h liga de fato a saída da rota até a credencial voltar. A sonda de recuperação roda no máximo uma vez por CLI a cada 10 min.' },
    { title: 'Queda de rede troca de CLI', detail: 'Uma CLI presa no contador "check your network" não conta mais como trabalhando: esgotada a espera, o Nexus marca falha do provedor e reabre a tarefa em outra CLI.' },
    { title: 'Git mais seguro e sem travar', detail: 'O supervisor usa o runner git seguro do Nexus, o diff do gate ignora textconv/ext-diff e as buscas do gate rodam assíncronas e com teto de tempo. A mensagem de fila pesada fica curta o bastante para chegar ao terminal.' },
    { title: 'Esteira parada não insiste com o operador', detail: 'Enquanto o Maestro espera uma decisão sua, o aviso de esteira parada fica em silêncio; depois de 6 h sai um único lembrete no inspector. Uma segunda onda de tarefas prontas espera os 30 s de novo em vez de herdar o carimbo antigo.' },
    { title: 'Fila pesada por repositório', detail: 'Build de outro repositório não segura mais typecheck e testes do Nexus.' },
    { title: 'Muse logado volta à rota', detail: 'Recusas de credencial antigas deixavam o Muse como "rota falha" mesmo depois do login, e o Nexus desviava dele. Quando o teste da credencial volta a passar, essas recusas deixam de contar no histórico de sucesso da CLI. Falhas de entrega reais continuam contando.' },
    { title: 'Pane reaberto atende pelo id', detail: 'Depois de reabrir o CLI de um pane, ler ou escrever nele pelo id respondia "unknown pane" listando o próprio pane. O Nexus agora escolhe a sessão viva desse pane; com duas sessões vivas continua recusando.' },
    { title: 'Gate do candidato diz o que caiu', detail: 'Quando uma etapa do gate de release falha, a mensagem nomeia o script e mostra o fim da saída, onde está o motivo, em vez do caminho do executável.' },
    { title: 'Smoke do candidato resiste a máquina carregada', detail: 'Sob carga o macOS descarta a saída não lida do terminal e a prova do PTY no candidato caía mesmo com tudo funcionando. A prova é refeita até três vezes só quando a saída volta vazia; o recibo do provider continua obrigatório.' },
    { title: 'Testes dos workers voltam a rodar', detail: 'A fila de comandos pesados recusava o vitest de workers com "pid fora da árvore do terminal" quando um processo intermediário já tinha saído. A prova de dono agora aceita também o terminal do pane, e processo de fora continua recusado.' },
  ],
};

export const RELEASE_076316: AppRelease = {
  version: '0.76.316',
  date: '2026-10-19',
  codename: 'Dono pelo terminal do pane',
  summary: 'No desktop Linux, a fila de comandos pesados aceita o processo do pane mesmo quando o intermediário já saiu, e continua recusando processo de fora. A tag 0.76.315 ficou no macOS.',
  highlights: [
    { title: 'Testes dos workers voltam a rodar', detail: 'A fila de comandos pesados recusava o vitest de workers com "pid fora da árvore do terminal" quando um processo intermediário já tinha saído. A prova de dono agora aceita também o terminal do pane, e processo de fora continua recusado.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.315 é o pacote macOS e não recebe arquivos Linux. O desktop Linux sai na 0.76.316.' },
  ],
  fixes: [],
};

export const RELEASE_076317: AppRelease = {
  version: '0.76.317',
  date: '2026-10-19',
  codename: 'MiniMax-M3.1-Flash na rota Anthropic',
  summary: 'A rota `minimax` do `claude` passa a pedir `MiniMax-M3.1-Flash` no lugar de `MiniMax-M3[1m]`. Sem o sufixo `[1m]`, o Claude Code 2.1.303 mediu a janela do id novo em 200 mil tokens, e esta versão não promete 1M de contexto no cliente. O `mcode` continua no Preview.',
  highlights: [
    { title: 'Modelo novo na rota `claude` com MiniMax', detail: 'O `MINIMAX_MODEL` (`src/main/adapters/launcher-provider-manager.ts`) deixa de ser `MiniMax-M3[1m]`, que é o `MiniMax-M3` com o sufixo `[1m]` do Claude Code, e passa a ser `MiniMax-M3.1-Flash`. Os quatro slots (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`) e o `defaultModel` do upstream apontam para o id novo, e o endpoint continua `https://api.minimax.io/anthropic`. O teste do upstream trava o id, os quatro slots e a ausência de `[1m]`.' },
    { title: 'Janela de contexto: sem promessa de 1M no cliente', detail: 'A documentação da MiniMax lista 1M de contexto para o `MiniMax-M3.1-Flash` na API compatível com Anthropic, mas o cliente aplica outra janela: o sufixo `[1m]` era o que fazia o Claude Code tratar o modelo antigo como 1M. Numa sonda local com o Claude Code 2.1.303 (servidor de teste em loopback, sem inferência autenticada), o id novo reportou `modelUsage.contextWindow=200000`, com ou sem `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`, e o id antigo reportou 1000000. O upstream continua mandando `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` como configuração, sem garantia de janela efetiva de 1M.' },
    { title: 'O `mcode` continua no Preview', detail: 'O `mcode` (rota do `minimax-code`) segue com `minimax/MiniMax-M3.1-Flash-Preview` como padrão e `minimax/MiniMax-M3` como secundário em `src/adapters/builtin/minimax-code.json`; `model-catalog`, `task-router` e `published-benchmarks` não mudam. A versão 0.6.12 do `mcode`, conferida em 19/10/2026, só lista o Preview do Flash e não o id `MiniMax-M3.1-Flash`.' },
    { title: 'Thinking: sem promessa universal', detail: 'O env do upstream `minimax` não define nenhuma chave de thinking, e o teste trava isso no env, não no payload HTTP. A documentação da MiniMax diz que o `MiniMax-M3.1-Flash` sempre pensa e responde HTTP 400 a `thinking.type=disabled`. Esta versão não promete o que cada versão ou configuração do cliente envia.' },
  ],
  fixes: [],
};

export const RELEASE_076318: AppRelease = {
  version: '0.76.318',
  date: '2026-10-19',
  codename: 'MiniMax-M3.1-Flash no Linux',
  summary: 'No desktop Linux, a rota `minimax` do `claude` passa a pedir `MiniMax-M3.1-Flash` no lugar de `MiniMax-M3[1m]`. Sem o sufixo `[1m]`, o Claude Code 2.1.303 mediu a janela do id novo em 200 mil tokens, e esta versão não promete 1M de contexto no cliente. O `mcode` continua no Preview. A tag 0.76.317 ficou no macOS.',
  highlights: [
    { title: 'Modelo novo na rota `claude` com MiniMax', detail: 'O `MINIMAX_MODEL` deixa de ser `MiniMax-M3[1m]`, que é o `MiniMax-M3` com o sufixo `[1m]` do Claude Code, e passa a ser `MiniMax-M3.1-Flash`. Os quatro slots e o `defaultModel` do upstream apontam para o id novo, e o endpoint continua `https://api.minimax.io/anthropic`.' },
    { title: 'Janela de contexto: sem promessa de 1M no cliente', detail: 'O sufixo `[1m]` era o que fazia o Claude Code tratar o modelo antigo como 1M. Numa sonda local com o Claude Code 2.1.303, o id novo reportou `modelUsage.contextWindow=200000`, com ou sem `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`. O upstream continua mandando essa variável, sem garantia de janela efetiva de 1M.' },
    { title: 'O `mcode` continua no Preview', detail: 'A rota do `minimax-code` segue com `minimax/MiniMax-M3.1-Flash-Preview`. A versão 0.6.12 do `mcode` só lista o Preview do Flash e não o id `MiniMax-M3.1-Flash`.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.317 é o pacote macOS e não recebe arquivos Linux. O desktop Linux sai na 0.76.318.' },
  ],
  fixes: [],
};

export const RELEASE_076319: AppRelease = {
  version: '0.76.319',
  date: '2026-10-19',
  codename: 'Piloto para todas as CLIs',
  summary: 'O Piloto automático passa a oferecer o AGY e todas as CLIs que coordenam missão, as equipes salvas aparecem e se editam sem projeto aberto e podem ser escolhidas na Nova missão, e a atualização automática do Claude Code pelo npm 12 não quebra mais a CLI. No Windows, textos, botões de som e a conta do AGY falam a língua do sistema. Leva tudo da 0.76.317 e da 0.76.318, inclusive o MiniMax-M3.1-Flash na rota Anthropic.',
  highlights: [
    { title: 'AGY e todas as CLIs no Piloto automático', detail: 'O Piloto automático só oferecia Claude e Codex como coordenador, mesmo no Autopiloto, onde a missão aceita qualquer CLI que coordena. Agora o card mostra o AGY, Kimi, Grok, Qwen e as demais CLIs instaladas que coordenam missão; só o modo Hardened continua restrito aos Maestros verificados. A trava antiga que tirava o AGY da coordenação saiu: ele já tem o MCP do Nexus desde o fim de setembro.' },
    { title: 'Equipes salvas sem projeto aberto', detail: 'O catálogo de equipes é global, mas a tela de Ajustes só o mostrava com um projeto aberto e dizia "Nenhuma equipe salva" sem ele. Agora as equipes originais e as suas aparecem sempre, e criar, editar, importar, exportar e apagar funcionam sem projeto. Erros técnicos em inglês viraram orientação em português.' },
    { title: 'Escolha a equipe na Nova missão', detail: 'A etapa Equipe da Nova missão ganhou "Começar de uma equipe salva", com as suas equipes antes das originais. O Quadro explica que a equipe é da missão e que outra equipe se escolhe numa Nova missão.' },
    { title: 'Atualização do Claude Code não quebra mais a CLI', detail: 'O npm 12 bloqueia os scripts de instalação e o Claude Code atualizado ficava como um stub que saía no boot: toda missão nascia com o Maestro morto. As atualizações liberam só o script do próprio pacote da CLI, uma atualização que deixa a CLI sem responder é reinstalada na hora, e o Quadro mostra a última tela do Maestro que caiu em vez de culpar uma build anterior.' },
  ],
  fixes: [
    { title: 'DeepSeek Flash só onde existe', detail: 'O deepseek-flash aparecia em primeiro no grupo Claude mesmo com o Claude na Anthropic, onde esse modelo não existe, e a rota visual podia escolhê-lo. Agora ele só aparece com o Claude apontado para a DeepSeek, e o seletor usa a lista que o provider realmente serve.' },
    { title: 'Windows fala Windows', detail: 'No Windows, as chaves dizem "cofre do Windows" em vez de Keychain, a wake word diz "detecção local neste computador", os botões de microfone e som abrem os Ajustes do Windows, "Mostrar no Finder" vira Explorador de Arquivos, o trecho do Arms traz o caminho real do executável e a opção escolhida nos menus nativos fica legível no tema escuro.' },
    { title: 'Conta do AGY no Windows', detail: 'Salvar a conta do AGY podia guardar a sobra de ~/.gemini (inclusive a sessão do Gemini CLI) num formato que o AGY do Windows não lê, e o pane recusava com "salve de novo" em laço. Agora a conta vem do Gerenciador de Credenciais, a sobra de outro formato é recusada com o motivo e a mensagem manda usar Entrar novamente; cancelar o login devolve os arquivos.' },
    { title: 'O pane diz o motivo real', detail: '"Contexto degradado" virou a causa de fato (troca de conta por limite confirmado ou entrega que o Maestro não aceitou), um pane cuja missão não existe mais não diz que ela encerrou com relatório, e quando a verificação automática recusa a conclusão o Quadro mostra que o Maestro está corrigindo.' },
  ],
};

export const RELEASE_076320: AppRelease = {
  version: '0.76.320',
  date: '2026-10-19',
  codename: 'Piloto para todas as CLIs no Linux',
  summary: 'No desktop Linux, o Piloto automático oferece o AGY e todas as CLIs que coordenam missão, as equipes salvas aparecem sem projeto aberto e podem ser escolhidas na Nova missão, e a atualização do Claude Code pelo npm 12 não deixa a CLI como stub. A tag 0.76.319 ficou no Windows.',
  highlights: [
    { title: 'AGY e todas as CLIs no Piloto automático', detail: 'O Piloto automático só oferecia Claude e Codex como coordenador, mesmo no Autopiloto, onde a missão aceita qualquer CLI que coordena. Agora o card mostra o AGY, Kimi, Grok, Qwen e as demais CLIs instaladas que coordenam missão; só o modo Hardened continua restrito aos Maestros verificados. A trava antiga que tirava o AGY da coordenação saiu: ele já tem o MCP do Nexus desde o fim de setembro.' },
    { title: 'Equipes salvas sem projeto aberto', detail: 'O catálogo de equipes é global, mas a tela de Ajustes só o mostrava com um projeto aberto e dizia "Nenhuma equipe salva" sem ele. Agora as equipes originais e as suas aparecem sempre, e criar, editar, importar, exportar e apagar funcionam sem projeto. Erros técnicos em inglês viraram orientação em português.' },
    { title: 'Escolha a equipe na Nova missão', detail: 'A etapa Equipe da Nova missão ganhou "Começar de uma equipe salva", com as suas equipes antes das originais. O Quadro explica que a equipe é da missão e que outra equipe se escolhe numa Nova missão.' },
    { title: 'Atualização do Claude Code não quebra mais a CLI', detail: 'O npm 12 bloqueia os scripts de instalação e o Claude Code atualizado ficava como um stub que saía no boot: toda missão nascia com o Maestro morto. As atualizações liberam só o script do próprio pacote da CLI, uma atualização que deixa a CLI sem responder é reinstalada na hora, e o Quadro mostra a última tela do Maestro que caiu em vez de culpar uma build anterior.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.319 é o pacote Windows e não recebe arquivos Linux. O desktop Linux sai na 0.76.320.' },
  ],
  fixes: [
    { title: 'DeepSeek Flash só onde existe', detail: 'O deepseek-flash aparecia em primeiro no grupo Claude mesmo com o Claude na Anthropic, onde esse modelo não existe, e a rota visual podia escolhê-lo. Agora ele só aparece com o Claude apontado para a DeepSeek, e o seletor usa a lista que o provider realmente serve.' },
    { title: 'Textos do Linux', detail: 'O cofre passa a dizer "chaveiro do sistema" (libsecret), mostrar um arquivo salvo é "Mostrar na pasta", e o aviso de microfone mudo aponta o mixer de som. Os botões que abrem os Ajustes de som do macOS e do Windows ficam ocultos no Linux: não há uma URL comum entre os desktops.' },
    { title: 'O pane diz o motivo real', detail: '"Contexto degradado" virou a causa de fato (troca de conta por limite confirmado ou entrega que o Maestro não aceitou), um pane cuja missão não existe mais não diz que ela encerrou com relatório, e quando a verificação automática recusa a conclusão o Quadro mostra que o Maestro está corrigindo.' },
  ],
};

export const RELEASE_076321: AppRelease = {
  version: '0.76.321',
  date: '2026-10-19',
  codename: 'Piloto para todas as CLIs no Linux',
  summary: 'No desktop Linux, o Piloto automático oferece o AGY e todas as CLIs que coordenam missão, as equipes salvas aparecem sem projeto aberto e podem ser escolhidas na Nova missão, e a atualização do Claude Code pelo npm 12 não deixa a CLI como stub. A tag 0.76.319 ficou no Windows e a 0.76.320 não foi publicada.',
  highlights: [
    { title: 'AGY e todas as CLIs no Piloto automático', detail: 'O Piloto automático só oferecia Claude e Codex como coordenador, mesmo no Autopiloto, onde a missão aceita qualquer CLI que coordena. Agora o card mostra o AGY, Kimi, Grok, Qwen e as demais CLIs instaladas que coordenam missão; só o modo Hardened continua restrito aos Maestros verificados. A trava antiga que tirava o AGY da coordenação saiu: ele já tem o MCP do Nexus desde o fim de setembro.' },
    { title: 'Equipes salvas sem projeto aberto', detail: 'O catálogo de equipes é global, mas a tela de Ajustes só o mostrava com um projeto aberto e dizia "Nenhuma equipe salva" sem ele. Agora as equipes originais e as suas aparecem sempre, e criar, editar, importar, exportar e apagar funcionam sem projeto. Erros técnicos em inglês viraram orientação em português.' },
    { title: 'Escolha a equipe na Nova missão', detail: 'A etapa Equipe da Nova missão ganhou "Começar de uma equipe salva", com as suas equipes antes das originais. O Quadro explica que a equipe é da missão e que outra equipe se escolhe numa Nova missão.' },
    { title: 'Atualização do Claude Code não quebra mais a CLI', detail: 'O npm 12 bloqueia os scripts de instalação e o Claude Code atualizado ficava como um stub que saía no boot: toda missão nascia com o Maestro morto. As atualizações liberam só o script do próprio pacote da CLI, uma atualização que deixa a CLI sem responder é reinstalada na hora, e o Quadro mostra a última tela do Maestro que caiu em vez de culpar uma build anterior.' },
    { title: 'Pacote Linux', detail: 'A tag 0.76.319 é o pacote Windows e não recebe arquivos Linux. A tag 0.76.320 não foi publicada porque a suíte Ubuntu falhou. O desktop Linux sai na 0.76.321.' },
  ],
  fixes: [
    { title: 'DeepSeek Flash só onde existe', detail: 'O deepseek-flash aparecia em primeiro no grupo Claude mesmo com o Claude na Anthropic, onde esse modelo não existe, e a rota visual podia escolhê-lo. Agora ele só aparece com o Claude apontado para a DeepSeek, e o seletor usa a lista que o provider realmente serve.' },
    { title: 'Textos do Linux', detail: 'O cofre passa a dizer "chaveiro do sistema" (libsecret), mostrar um arquivo salvo é "Mostrar na pasta", e o aviso de microfone mudo aponta o mixer de som. Os botões que abrem os Ajustes de som do macOS e do Windows ficam ocultos no Linux: não há uma URL comum entre os desktops.' },
    { title: 'O pane diz o motivo real', detail: '"Contexto degradado" virou a causa de fato (troca de conta por limite confirmado ou entrega que o Maestro não aceitou), um pane cuja missão não existe mais não diz que ela encerrou com relatório, e quando a verificação automática recusa a conclusão o Quadro mostra que o Maestro está corrigindo.' },
  ],
};

export const RELEASE_076323: AppRelease = {
  version: '0.76.323',
  date: '2026-10-19',
  codename: 'Velocidade e detalhes da missão',
  summary: 'No Quadro, o botão "Ver o que aconteceu" abre a visão de Atividade ampliada, com estado coerente com a barra lateral e layout ajustado para janelas estreitas. No motor, a base da worktree ganha aviso e atualização com throttle de 60 s, o verificador lê entregáveis além do corte de 512 arquivos, o portão de regressão roda testes em lotes, o pane_write comprova entrega e o esforço do revisor fica proporcional.',
  highlights: [
    { title: 'Equipe salva no Expresso', detail: 'Em Personalizar equipe, no início expresso da missão, "Começar de uma equipe salva" lista as suas equipes antes das originais (já na 0.76.322 do Linux).' },
    { title: 'Atividade ampliada no Quadro', detail: 'O botão "Ver o que aconteceu" no Quadro da missão agora abre a visão de Atividade detalhada ao concluir ou interromper uma missão. O estado visual fica sincronizado e coerente com o status da barra lateral, e os cards e cabeçalho se ajustam perfeitamente mesmo em janelas estreitas.' },
    { title: 'Base da worktree com aviso e atualização', detail: 'Antes de congelar a base isolada do writer, o motor atualiza o upstream do origin (com throttle de 60 s por raiz no fetch) e emite aviso explícito caso a branch local não rastreie uma branch remota origin/*.' },
    { title: 'Entregáveis lidos antes do corte de 512 arquivos', detail: 'No snapshot da árvore de trabalho candidata, entregáveis declarados alfabeticamente além do limite de 512 arquivos continuam sendo lidos e têm fingerprint gerado antes do corte de leitura.' },
    { title: 'Portão de regressão em lotes', detail: 'A faixa de testes impactados no handoff agora é dividida em lotes calculados dinamicamente com base no tempo restante. Cada lote concluído reporta seu veredito imediatamente, evitando que suítes extensas terminem com 0 testes reportados ao atingir o prazo.' },
    { title: 'pane_write com recibo de entrega', detail: 'A ferramenta de escrita em terminais (nexus_pane_write) agora emite prova de turno e confirmação de recebimento apenas quando os bytes chegam e o pane está apto a aceitar entrada.' },
    { title: 'Esforço do revisor proporcional', detail: 'O roteador de tarefas e as regras de modelo reservam o nível de esforço máximo no revisor para tarefas críticas, usando esforço proporcional nos demais níveis para evitar latência desnecessária.' },
  ],
  fixes: [
    { title: 'Fila de comandos pesados se liberta sozinha', detail: 'Um lease exclusivo cujo executor ou sessão dona morreu passa a ser liberado pela própria fila após 60 s — antes ficava preso e travava novos comandos —, e a recusa da fila diz qual comando segura o lease. O conserto no supervisor nativo (native/darwin-pty-supervisor/main.c) não está nesta build: fica para o próximo rebuild nativo.' },
  ],
};

export const RELEASE_076325: AppRelease = {
  ...RELEASE_076323,
  version: '0.76.325',
  summary: 'No desktop Linux, o Quadro ganha "Ver o que aconteceu", a base da worktree avisa e atualiza com throttle de 60 s, o portão de regressão roda em lotes, o pane_write prova a entrega e a fila de comandos pesados se libera em 60 s. A tag 0.76.323 é o pacote macOS. A 0.76.324 não foi publicada: a suíte Ubuntu falhou num teste do MiMo.',
  highlights: [
    ...RELEASE_076323.highlights,
    { title: 'Pacote Linux', detail: 'A tag 0.76.323 é o pacote macOS e não recebe arquivos Linux. A tag 0.76.324 não foi publicada porque a suíte Ubuntu falhou no teste de retomada do MiMo (o recibo de escrita agora leva inputWriter). O desktop Linux sai na 0.76.325.' },
  ],
};

export const RELEASE_076326: AppRelease = {
  version: '0.76.326',
  date: '2026-10-19',
  codename: 'Comparador honesto e mídia que gera',
  summary: 'Comparar modelos passa a mostrar os benchmarks oficiais que a escolha automática usa, só na versão mais nova de cada modelo e das ferramentas instaladas. Serviços de mídia e o Estúdio funcionam sem projeto aberto, explicam as falhas, só oferecem a duração e o formato que cada modelo de vídeo aceita e mostram o custo antes de gerar. Leva ao Windows a velocidade e os detalhes da missão da 0.76.323 a 0.76.325.',
  highlights: [
    { title: 'Comparar modelos com números oficiais', detail: 'As notas da tela eram de demonstração, escritas à mão em setembro, e a escolha automática nem as usava. Agora a tela mostra os mesmos benchmarks oficiais da rota (DeepSWE, Terminal-Bench 2.1, SWE-bench Verified), com link para a fonte e dizendo quando a nota vem de outro modelo da mesma linha. Aparece só a versão mais nova de cada modelo e, por padrão, só as ferramentas instaladas; modelo sem número publicado fica sem nota, nunca com zero.' },
    { title: 'Mídia sem projeto aberto', detail: 'Sem projeto aberto, Serviços de mídia caía num erro e nem deixava conectar uma chave, e o Estúdio abria mudo. Agora os serviços carregam sempre e o Estúdio explica que gerar precisa de um projeto aberto.' },
    { title: 'Vídeo só com o que o modelo aceita', detail: 'O Estúdio mandava 5 s para todo vídeo e o Veo, que só aceita 4, 6 ou 8 s, falhava com as opções padrão; Hailuo, Sora e Wan também recebiam valores que recusam. Agora cada modelo só oferece a duração, a proporção e a resolução que aceita, o pedido inválido é recusado antes de qualquer chamada paga e o custo aparece antes de gerar.' },
  ],
  fixes: [
    { title: 'Erro de mídia com o que fazer', detail: 'A falha do serviço chegava crua ("HTTP 422" com JSON). Agora vem uma frase com o que houve e o que fazer, e um botão para Serviços de mídia quando o problema é a chave.' },
    { title: 'Prévia mostra o arquivo gerado', detail: 'A prévia do Estúdio podia mostrar outra criação do mesmo tipo; agora mostra exatamente o arquivo que acabou de ser gerado.' },
    { title: 'Veo nativo do Google até 22/10', detail: 'O Google desliga os Veo 3.1 preview do Gemini em 22/10/2026. O Estúdio avisa antes da data e, depois dela, recusa indicando o Veo 3.1 pelo Replicate. O Veo 2, já desligado, saiu da lista.' },
  ],
};

export const RELEASE_076327: AppRelease = {
  version: '0.76.327',
  date: '2026-10-19',
  codename: 'Instalador assinado',
  summary: 'O instalador, o app e o atualizador do Windows passam a sair assinados com o certificado de assinatura de código da HIPERSEND, guardado num token de hardware (YubiKey). O conteúdo do app é o mesmo da 0.76.326.',
  highlights: [
    { title: 'Instalador do Windows assinado', detail: 'O Setup.exe, o NexusIDE, o atualizador e o Redline do Windows saem com assinatura Authenticode da HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA, emitida pelo SSL.com, com carimbo de tempo. O Windows mostra o editor em vez de "Editor desconhecido". O SmartScreen ainda pode avisar nas primeiras instalações, até o certificado novo ganhar reputação. A chave fica num token de hardware e não sai dele.' },
  ],
  fixes: [],
};

export const RELEASE_076328: AppRelease = {
  version: '0.76.328',
  date: '2026-10-19',
  codename: 'Comparador e mídia no Linux',
  summary: 'No desktop Linux, Comparar modelos mostra os benchmarks oficiais da rota, só na versão mais nova de cada modelo e das ferramentas instaladas. Serviços de mídia e o Estúdio funcionam sem projeto aberto, explicam as falhas, só oferecem a duração e o formato que cada modelo de vídeo aceita e mostram o custo antes de gerar. As tags 0.76.326 e 0.76.327 são pacotes Windows e não recebem arquivos Linux.',
  highlights: [
    ...RELEASE_076326.highlights,
    { title: 'Pacote Linux', detail: 'A tag 0.76.326 é o pacote Windows do comparador e da mídia e não recebe arquivos Linux. A tag 0.76.327 só assina o instalador do Windows e também não recebe arquivos Linux. O desktop Linux sai na 0.76.328.' },
  ],
  fixes: RELEASE_076326.fixes,
};

export const RELEASE_076329: AppRelease = {
  version: '0.76.329',
  date: '2026-10-19',
  codename: 'Freio de emergência de memória',
  summary: 'Num Mac de 16 GB com vários panes abertos e trabalhando, a máquina podia travar inteira. O guardião de memória só sabia recuperar pane OCIOSO, e a memória está justamente nos panes que trabalham: com todos ocupados ele não recuperava nada e o sistema ia ao chão. Agora, só na pressão crítica, o Nexus estaciona o pane de maior consumo — histórico e retomada preservados — reage em 5 segundos e recusa abrir mais um pane na beira do travamento. Teto, pressão moderada e severa continuam só avisando.',
  highlights: [
    { title: 'Pane ocupado também libera memória na hora', detail: 'O guardião estacionava apenas panes ociosos. Medido: oito panes ocupados, memória crítica, dez varreduras — zero recuperado, porque a lista de candidatos era vazia por construção. Foi assim que um iMac M5 de 16 GB travou inteiro depois que o cliente abriu vários panes. Agora, quando a memória livre cai abaixo de 30 % da reserva, o Nexus estaciona até três panes por varredura mesmo que estejam trabalhando, remedindo a memória a cada um: assim que a folga volta, ele para. Estacionar encerra só o processo — o pane, o histórico e o "Acordar" ficam, e quem não sabe retomar a conversa não é tocado.' },
    { title: 'O Nexus recusa abrir pane na beira do travamento', detail: 'O teto de panes e a memória baixa sempre foram aviso, e um aviso se dispensa com um clique: num Mac de 16 GB o nono pane entrava com 500 MB livres. Agora a pressão crítica — e só ela — recusa o spawn, dizendo que é memória física da máquina (não limite do plano), o que aconteceria e o que fazer. Contagem de panes, pressão moderada e severa seguem apenas avisando, e NEXUS_PANE_GUARD=off desliga tudo.' },
    { title: 'Reação em 5 segundos, não em um minuto', detail: 'A varredura do guardião roda a cada 60 s. Com seis a oito agentes alocando ao mesmo tempo, a máquina sai de "apertada" para travada antes do próximo ciclo. Enquanto a pressão está severa ou crítica a varredura passa a rodar a cada 5 segundos; fora disso continua de minuto em minuto, sem medição extra.' },
  ],
  fixes: [
    { title: 'Escolhe o pane que realmente pesa', detail: 'O consumo de memória de cada pane já era medido e mostrado no cabeçalho, mas nenhuma decisão o usava. Agora ele ordena quem sai primeiro: worker e ajudante antes do pane que você abriu, e dentro disso o de maior consumo medido — um pane de 3 GB devolve a folga que três de 900 MB não devolvem. Pane sem medida vai para o fim: falta de dado não é zero.' },
    { title: 'O aviso do pane não parece mais um crash', detail: 'Um pane estacionado no meio do trabalho dizia apenas "pane estacionado". Agora explica que foi para a máquina não travar, por memória crítica, e que basta digitar para retomar a conversa.' },
  ],
};

export const RELEASE_076330: AppRelease = {
  version: '0.76.330',
  date: '2026-10-19',
  codename: 'As contas se revezam sozinhas',
  summary: 'Quem tem várias contas da mesma IA usava só a primeira: quando a cota dela acabava, o pane simplesmente parava — não trocava, não avisava, não morria com erro. Agora o Nexus mede a cota e tira o trabalho NOVO da conta que está chegando ao fim, antes de ela acabar, sem interromper quem já está trabalhando. Quem esgota no meio da tarefa continua na conta seguinte, e quando todas acabam o trabalho segue em outra IA. Sete contas passam a render como sete, não como uma.',
  highlights: [
    { title: 'A próxima tarefa já nasce na conta que tem folga', detail: 'A troca acontece na borda entre uma tarefa e outra, então ninguém é interrompido e nada se perde: o agente que está trabalhando termina o que começou usando a fatia que resta, e o próximo nasce na conta seguinte. O limiar é 89 % da janela que está apertando — e os 11 % que sobram não são desperdiçados: quando todas as contas chegam lá, o Nexus volta a usá-las e consome o resto numa segunda volta.' },
    { title: 'O pane que emudecia por falta de cota agora continua', detail: 'Algumas IAs não imprimem erro quando a cota acaba: a tela simplesmente para. Sem texto de erro o Nexus nunca sabia que havia um limite, e a missão ficava parada até alguém perceber. Agora a própria medição de cota serve de prova: o pane parado numa conta esgotada é religado na conta seguinte com um resumo do que estava fazendo, e um aviso aparece no momento da troca.' },
    { title: 'Acabaram todas as contas? O trabalho segue em outra IA', detail: 'Quando nenhuma conta da CLI tem folga, a missão não para: ela continua numa IA elegível, com o contexto reidratado, no mesmo lugar. A conta esgotada não volta a ser escolhida antes de liberar.' },
  ],
  fixes: [
    { title: 'A conta que está em uso é medida de verdade', detail: 'Em algumas IAs o provedor só informa a cota da conta que está logada no momento, e recusa a consulta das demais. Essa leitura passa a ser atribuída à conta que o Nexus de fato abriu — sem ela, a frota inteira parecia "sem medição" e nada rotacionava. As contas irmãs continuam honestamente sem leitura: ninguém as mediu.' },
    { title: 'A troca não acusa conta saudável', detail: 'A decisão só aceita leitura vinda do provedor e com menos de 10 minutos: uma estimativa local nunca tira o pane de uma conta que está bem. Conta fixada por você continua só cedendo quando esgota de fato, e um agente que está no meio de uma chamada silenciosa não é trocado por engano.' },
  ],
};

export const RELEASE_076331: AppRelease = {
  version: '0.76.331',
  date: '2026-10-19',
  codename: 'Memória e contas no Linux',
  summary: 'No desktop Linux, a pressão crítica estaciona até o pane que está trabalhando e recusa abrir outro na beira do travamento. Várias contas da mesma IA passam a se revezar pela cota medida: o trabalho novo sai da conta que está chegando ao fim, e o pane que emudece continua na conta seguinte. A tag 0.76.329 é o pacote macOS. A tag 0.76.330 não recebe arquivos Linux.',
  highlights: [
    ...RELEASE_076329.highlights,
    ...RELEASE_076330.highlights,
    { title: 'Pacote Linux', detail: 'A tag 0.76.329 é o pacote macOS e não recebe arquivos Linux. A tag 0.76.330 não recebe arquivos Linux. O desktop Linux sai na 0.76.331, com o comparador e a mídia da 0.76.328, o freio de memória e a rotação de contas.' },
  ],
  fixes: [...RELEASE_076329.fixes, ...RELEASE_076330.fixes],
};

export const RELEASE_076332: AppRelease = {
  version: '0.76.332',
  date: '2026-10-19',
  codename: 'As contas se revezam sozinhas (macOS)',
  summary: 'Pacote macOS do revezamento de contas. Quem tem várias contas da mesma IA usava só a primeira: quando a cota acabava, o pane simplesmente parava. Agora o Nexus mede a cota e tira o trabalho NOVO da conta que está chegando ao fim antes de ela acabar, sem interromper quem já trabalha; o pane que emudece por cota esgotada continua na conta seguinte; e quando todas acabam o trabalho segue em outra IA. Inclui a pressão crítica de memória da 0.76.329 e o pacote Linux da 0.76.331.',
  highlights: [
    ...RELEASE_076331.highlights,
  ],
  fixes: [
    { title: 'O resgate não trava mais por status preso', detail: 'Quando a cota esgota, o pedido ao provedor pode travar antes do aviso de parada, e a IA ficava marcada como "trabalhando" para sempre — o que impedia o próprio resgate que essa trava deveria proteger. Agora esse estado vale por tempo limitado, e depois disso o pane é religado na conta seguinte.' },
    { title: 'O orquestrador não troca de conta à toa', detail: 'Algumas IAs têm cota separada por família de modelo. O orquestrador era tirado da conta quando a cota de uma família que ele nem usa enchia, e a missão recomeçava a conversa noutra conta sem precisar. Agora só a cota do modelo que ele realmente usa conta para essa decisão.' },
  ],
};

export const RELEASE_076333: AppRelease = {
  version: '0.76.333',
  date: '2026-10-19',
  codename: 'Memória e contas no Linux',
  summary: 'No desktop Linux, a pressão crítica estaciona até o pane que está trabalhando e recusa abrir outro na beira do travamento. Várias contas da mesma IA passam a se revezar pela cota medida: o trabalho novo sai da conta que está chegando ao fim, e o pane que emudece continua na conta seguinte. O resgate ignora um status working obsoleto, e o Maestro só drena pela cota do modelo que usa. A tag 0.76.332 é o pacote macOS e não recebe arquivos Linux. A tag 0.76.331 foi marcada e não foi publicada.',
  highlights: [
    ...RELEASE_076329.highlights,
    ...RELEASE_076330.highlights,
    { title: 'Pacote Linux', detail: 'A tag 0.76.329 é o pacote macOS da memória e não recebe arquivos Linux. A tag 0.76.332 é o pacote macOS das contas e não recebe arquivos Linux. A tag 0.76.330 não recebe arquivos Linux. A tag 0.76.331 foi marcada e não foi publicada. O desktop Linux sai na 0.76.333, com o comparador e a mídia da 0.76.328, o freio de memória e a rotação de contas.' },
  ],
  fixes: [...RELEASE_076329.fixes, ...RELEASE_076330.fixes, ...RELEASE_076332.fixes],
};

export const RELEASE_076334: AppRelease = {
  version: '0.76.334',
  date: '2026-10-19',
  codename: 'Vídeo pelo Gemini Omni e pelo Grok (macOS)',
  summary: 'Pacote macOS da mídia nova. O Google desliga em 22/10/2026 os Veo 3.1 preview que o vídeo nativo do Gemini usava; agora a mesma chave gera pelo Gemini Omni Flash, o substituto que o Google indica. A chave do Grok, que só servia à voz, passa a gerar imagem e vídeo pelo Grok Imagine. Os agentes escolhem o modelo de mídia vendo antes o que cada um aceita e quanto custa, e o vídeo pago não se perde numa falha passageira. A tag 0.76.333 é o pacote Linux e não recebe arquivos macOS.',
  highlights: [
    { title: 'Vídeo do Google pelo Gemini Omni Flash', detail: 'A mesma chave do Gemini gera vídeo pelo Gemini Omni Flash, de 360p a 4K, em 16:9 ou 9:16. É o modelo que decide quanto o vídeo dura, então o Estúdio não oferece duração e mostra o preço por segundo antes de gerar; depois, mostra o custo real, calculado pelo que o Google cobrou. O Omni só funciona com cobrança ativa no projeto do Google: no plano gratuito, o Nexus agora diz que falta ativar a cobrança, em vez de mandar esperar e tentar de novo.' },
    { title: 'Grok Imagine com a chave do Grok', detail: 'A chave do Grok salva para a voz já liga a geração de imagem e de vídeo pelo Grok Imagine (xAI), no Estúdio e nas ferramentas dos agentes. Vídeo de 1 a 15 s, de 480p a 1080p; pelas ferramentas, também com imagem inicial, último quadro e referências nos modelos que aceitam. O custo de lista aparece antes de gerar, incluindo as imagens de entrada.' },
    { title: 'Agentes escolhem o modelo de mídia vendo regras e preço', detail: 'Antes de gerar, o agente vê, para cada modelo de vídeo, as durações, resoluções e proporções aceitas, se exige imagem, o preço e quando ele sai do ar — as mesmas regras que o Nexus usa para recusar um pedido antes de cobrar. Sem serviço escolhido, o padrão passa a ser o de menor preço de lista entre os que têm chave; antes valia a ordem da tabela.' },
  ],
  fixes: [
    { title: 'Vídeo pago não se perde em falha passageira', detail: 'Depois que o vídeo existe e foi cobrado, uma queda de rede, de download ou de disco deixa o pedido pendente com o código para retomar, em vez de marcá-lo como falho e induzir a pagar de novo. A retomada só baixa o que já foi gerado e registra o custo certo.' },
    { title: 'Chave recusada diz para trocar a chave', detail: 'O Google e a xAI recusam chave errada com HTTP 400, que virava "não aceitou o pedido" com o JSON cru. Agora a mensagem diz que a chave foi recusada e leva a Serviços de mídia.' },
    { title: 'Imagem do Grok com a extensão certa e o custo certo', detail: 'Ao gravar num caminho pedido, a imagem leva a extensão do formato que a xAI devolveu, em vez de gravar JPEG num arquivo .png. Sem o custo na resposta, a edição de imagem passa a somar a qualidade da edição e a imagem de entrada (uma edição 2K custa US$ 0,09, não US$ 0,06).' },
  ],
};

export const RELEASE_076335: AppRelease = {
  version: '0.76.335',
  date: '2026-10-20',
  codename: 'Vídeo pelo Gemini Omni e pelo Grok',
  summary: 'No desktop Linux, a mesma chave do Gemini gera vídeo pelo Gemini Omni Flash, e a chave do Grok passa a gerar imagem e vídeo pelo Grok Imagine. Os agentes escolhem o modelo de mídia vendo regras e preço, e o vídeo pago não se perde numa falha passageira. A tag 0.76.334 é o pacote macOS e não recebe arquivos Linux.',
  highlights: [
    ...RELEASE_076334.highlights,
    { title: 'Pacote Linux', detail: 'A tag 0.76.334 é o pacote macOS da mídia nova e não recebe arquivos Linux. A tag 0.76.333 é o pacote Linux anterior. O desktop Linux sai na 0.76.335, com o vídeo do Gemini Omni Flash, o Grok Imagine e a escolha de modelo por regras e preço.' },
  ],
  fixes: [...RELEASE_076334.fixes],
};

export const CURRENT_RELEASE: AppRelease = {
  version: '0.76.336',
  date: '2026-10-20',
  codename: 'O Nexus limpa o próprio disco (macOS)',
  summary: 'Em pouco uso o Nexus chegava a ocupar metade do disco. Cada agente que escreve código ganha uma cópia de trabalho do projeto (worktree), e a de um pane encerrado só saía se estivesse limpa: com qualquer alteração não commitada, saída de build ou cache, ficava para sempre — e no Windows nunca saía. Na máquina de desenvolvimento havia 50 cópias guardadas ao mesmo tempo, de 1,5 a 2,6 GB cada. Agora uma rotina de higiene roda sozinha, encurta os prazos quando o disco aperta e nunca apaga trabalho que só exista ali. A tag 0.76.335 é o pacote Linux e não recebe arquivos macOS.',
  highlights: [
    { title: 'Limpeza automática de disco', detail: 'Roda a cada 3 horas com o disco folgado e a cada 20 minutos com o disco crítico (menos de 5 GB livres). Cuida das cópias de trabalho dos agentes, dos perfis do navegador de cada pane, dos snapshots de desfazer das CLIs, dos mapas de orientação, dos arquivos de sessões encerradas, dos anexos de missão antigos, dos temporários e dos logs que não tinham rotação.' },
    { title: 'Cópias de trabalho dos agentes não se acumulam', detail: 'Uma hora depois de o pane encerrar, os caches regeneráveis (.nexus-cache, .vite, .turbo…) saem, sem tocar no código nem no node_modules. A cópia limpa sai em 12 horas. A que tem trabalho não commitado sai em 2 dias, e só depois de o Nexus guardar tudo numa ref de salvaguarda (refs/nexus-salvage/…) duas vezes seguidas, sem nenhuma edição no meio; a branch sempre fica. Repositório Git aninhado, edição recente no disco ou saída de build recente (out/, dist/) seguram a cópia. Com o disco apertado, os prazos caem para horas.' },
    { title: 'Armazenamento em Configurações → Diagnóstico', detail: 'Mostra o espaço livre, quanto o Nexus ocupa em cada categoria, o que a última limpeza removeu — com a ref de cada cópia aposentada e o cherry-pick para trazê-la de volta — e o botão \"Limpar agora\", que roda na hora com os prazos de disco apertado.' },
    { title: 'Lixo do Nexus dentro dos projetos', detail: 'Prints colados em missões (.nexus/attachments) saem depois de 30 dias e rascunhos de swarm de missões antigas (.nexus/swarms) depois de 14. Nada sai de missão que ainda pode rodar, e o que estiver versionado no Git do projeto nunca é apagado.' },
    { title: 'Windows', detail: 'As cópias de trabalho passam a ser coletadas também no Windows, que não tem como ler a pasta atual dos processos: o Nexus prova que a pasta está livre tentando renomeá-la, o que o NTFS recusa quando algum programa a usa. O node_modules ligado por junction sai só como link, nunca o conteúdo. O log do Jarvis vai para a pasta de logs do app e não cria mais Library\\Logs no perfil do usuário. O temporário do Windows, que o sistema não esvazia sozinho, também é limpo.' },
  ],
  fixes: [
    { title: 'Configs MCP de sessões encerradas', detail: 'Os arquivos em ~/.nexus/mcp-configs, cada um com um token, ficavam para sempre quando o pane morria sem encerrar (crash, kill). Agora saem 3 dias depois; os de sessões vivas nunca saem. Um login feito no pane que morreu volta ao perfil real antes, só se for mais novo que o login atual.' },
    { title: 'Cache do Chromium com teto', detail: 'O cache HTTP de cada perfil do navegador fica limitado a 64 MB e é esvaziado quando o disco aperta. Perfis de pane sem uso há 21 dias saem (os perfis pessoais, só depois de 63 dias); o perfil carregado nunca sai.' },
    { title: 'Banco SQLite sem WAL gigante', detail: 'O arquivo -wal volta a até 16 MB depois de cada checkpoint, em vez de guardar para sempre o pico de escrita. Das cópias de migração do banco, ficam só as 3 mais novas por projeto.' },
    { title: 'Pool de cópias de trabalho respeita o disco', detail: 'Com o disco crítico, o Nexus não deixa mais cópias de reserva prontas (cerca de 1,6 GB cada); o agente cria a sua na hora.' },
  ],
};
