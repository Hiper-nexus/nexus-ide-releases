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

export const CURRENT_RELEASE: AppRelease = {
  version: '0.20.3',
  date: '2026-08-01',
  codename: 'O gate pergunta antes de gastar',
  summary:
    'Uma CLI com sessão expirada ou sem chave só se revelava ~40 minutos ' +
    'depois de iniciar o ciclo de release, como worker travado sem heartbeat ' +
    '— e o ciclo inteiro era perdido. Numa noite isso se repetiu sete vezes. ' +
    'Agora o gate sonda os provedores ANTES de começar, com comandos ' +
    'calibrados contra as CLIs reais, e reprova em 90 segundos nomeando o ' +
    'provedor e o remédio: relogar, configurar a chave ou esperar a cota.',
  highlights: [
    {
      title: 'Preflight de provedor no gate de release',
      detail:
        'Antes da missão real, cada CLI exigida responde a uma sonda mínima: ' +
        'codex e claude num turno barato, grok numa checagem de login que nem ' +
        'gasta turno. Sessão OAuth expirada, chave ausente e provedor mudo ' +
        'são distinguidos — o remédio de cada um é diferente. CLI sem sonda ' +
        'CALIBRADA nunca bloqueia: preflight mal calibrado reprova release ' +
        'boa, que é pior que o problema que resolve.',
    },
    {
      title: 'A causa da noite tinha nome',
      detail:
        'A sonda encontrou na primeira aplicação real o que sete ciclos não ' +
        'disseram: a sessão OAuth do Claude expirada e irrecuperável — ' +
        'exatamente o provedor cuja exaustão disparava os reroutes que ' +
        'reprovavam a evidência de participação. Noventa segundos de sonda ' +
        'contra quarenta minutos por descoberta.',
    },
  ],
  fixes: [],
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
