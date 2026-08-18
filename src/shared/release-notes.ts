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
