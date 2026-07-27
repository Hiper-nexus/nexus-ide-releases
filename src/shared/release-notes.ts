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
  version: '0.19.31',
  date: '2026-07-26',
  codename: 'Missão Cumprida',
  summary:
    'Uma única aprovação leva o objetivo do PRD à entrega: o Nexus distribui trabalho real ao squad, comprova que cada resultado chegou ao próximo agente e só conclui depois de revisão e QA.',
  highlights: [
    {
      title: 'Fluxo único, sem modal cosmético',
      detail:
        'Salvar o squad virou uma opção inline e a missão usa uma única revisão nativa compacta de autoridade, selada por recibo integral. O wizard revela complexidade aos poucos e acompanha o trabalho numa linha contínua, sem a sequência salvar, confirmar e confirmar de novo.',
    },
    {
      title: 'Squad inteiro trabalha e entrega',
      detail:
        'Cada identidade do roster executável recebe uma tarefa governada. Pesquisa alimenta execução, revisão alimenta correção e QA valida o resultado; recibos por dependência provam que o próximo agente recebeu o handoff antes de a missão poder terminar.',
    },
    {
      title: 'PRD preservado até o código',
      detail:
        'A promoção de plano para execução sela o handoff físico, conteúdo, artifacts e hashes. A sessão de implementação recebe o PRD exato, sem depender de texto refeito pelo renderer nem de uma sessão já encerrada.',
    },
    {
      title: 'Claude Opus 5 e OMP reais',
      detail:
        'Claude Opus 5 aparece no catálogo, roteamento e preços. As integrações de Claude CLI e OMP validam o identificador do modelo; o Nexus verifica somente a sessão do provider exigido, sem ler nem copiar o conteúdo das credenciais.',
    },
  ],
  fixes: [
    {
      title: 'Orquestração confinada por CLI',
      detail:
        'Claude e Codex continuam como Maestros verificados. Escrita autônoma guiada usa somente o Codex builtin qualificado, com sandbox workspace-write fixado e sem bypass; Kimi, OpenCode, OMP e rotas ainda não qualificadas permanecem disponíveis no uso direto/manual.',
    },
    {
      title: 'Uma aprovação, limitada à missão',
      detail:
        'O Codex não repete prompts de MCP depois da aprovação nativa: somente o servidor efêmero e bearer-bound daquela missão recebe autoaprovação. HOME, temp, filesystem e rede seguem no perfil privado; panes diretos e MCPs ambientais não herdam a decisão.',
    },
    {
      title: 'Greenfield com ownership e gates reais',
      detail:
        'Arquivos novos citados explicitamente no objetivo entram como caminhos exatos no selo, sem abrir globs ou árvores reservadas. O Doctor só autoriza sensores compatíveis com scripts, package manager e cwd reais, sem inventar comandos npm em projeto vazio.',
    },
    {
      title: 'Reviewer e QA avançam após saída natural',
      detail:
        'Uma folha visual remanescente só é aposentada quando a ausência física e toda a identidade do worker coincidem. Isso libera a vaga seguinte no mesmo passe sem aceitar sessão substituta, duplicata, outro workspace ou OMP ainda vivo.',
    },
    {
      title: 'Saída com prova física',
      detail:
        'Substituir ou encerrar um Maestro revoga dispatch e exige prova de ausência de descendentes. Fechar a última janela considera PTYs, OMP headless e spawns em voo; no macOS, um helper universal assinado também alcança processos daemonizados e falha fechado se não puder provar o encerramento.',
    },
    {
      title: 'PREVC antes do primeiro worker',
      detail:
        'Missões guiadas congelam no Main o contrato exato aprovado antes de qualquer worker, claim, worktree ou efeito de execução. Se o contexto ainda não existe, somente o Maestro de bootstrap nativamente read-only e revisores independentes confinados podem preceder o freeze; até a conta do worker fica atrás do gate.',
    },
    {
      title: 'Roster e squads sem desaparecer',
      detail:
        'O Maestro revisado na missão vence um default global antigo. Squads gerados e salvos recebem uma cópia estável que volta a aparecer no seletor, sem o sumiço causado pelos ids efêmeros do engine.',
    },
    {
      title: 'Toolchain auditado sem vulnerabilidades',
      detail:
        'O Electron Forge inteiro usa a correção upstream de brace-expansion 5.0.8 por um pacote de compatibilidade local com fonte, licença, hashes e provenance. As APIs legadas de minimatch continuam cobertas e as auditorias npm de produção e build ficam em zero.',
    },
    {
      title: 'Interface Nexus mais fluida',
      detail:
        'Rail hierárquico, painel contextual redimensionável, revisão progressiva e estados de fan-out mais discretos organizam a missão sem copiar a identidade visual do Orca. O design system Nexus continua sendo a fonte de verdade.',
    },
    {
      title: 'Handoffs idempotentes até quando a resposta se perde',
      detail:
        'Entrega, receipt e transição do dispatch são atômicos. Um retry exato apenas relê o handoff já persistido e consome seu receipt one-shot; tentativa divergente, reutilizada ou sem a mesma prova física falha fechado, sem duplicar delivery.',
    },
    {
      title: 'A release precisa provar a missão no app',
      detail:
        'O candidato empacotado só avança quando uma única missão no MissionWizard visível completa a cadeia executor → revisor → QA com quatro PTYs, três handoffs, uma aprovação Nexus e nenhum prompt MCP do Codex. O runner interno permanece um diagnóstico separado e não repete a missão no gate.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.26',
  date: '2026-07-22',
  codename: 'Piloto Automático sem Modal',
  summary:
    'Aprovar a missão autoriza a execução inteira: o agente não para em modal a cada comando, o PREVC garante sem bloquear e o wizard virou fluxo único sem jargão.',
  highlights: [
    {
      title: 'Execução sem interrupção',
      detail:
        'A aprovação da missão é a autorização — deploy, SSH, edição de código e browser fluem direto, tudo auditado; só comandos destrutivos pedem confirmação.',
    },
    {
      title: 'PREVC que garante sem limitar',
      detail:
        'Sem contrato congelado a missão executa normalmente; com contrato, stage, drift e receipts continuam valendo. Tarefas mistas de infra + código funcionam.',
    },
    {
      title: 'Wizard fluxo único',
      detail:
        'Objetivo + lançar. Tipos de entrega viraram Opções avançadas colapsadas, em linguagem simples, com Sem restrições como padrão.',
    },
  ],
  fixes: [
    {
      title: 'Fim do stall de confirmação',
      detail:
        'O agente não fica mais minutos parado esperando clique em modal a cada ação — a autorização vem da missão aprovada, com auditoria fail-closed.',
    },
    {
      title: 'Kickoff anti-travamento',
      detail:
        'O orquestrador executa direto e trata freeze/bootstrap PREVC como best-effort em segundo plano, nunca como pré-condição.',
    },
  ],
};
