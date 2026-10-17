/**
 * F-1167: conjunto rotulado EMBUTIDO do botão "Calibrar modelos". Curado e
 * barato: só texto sintético (nenhum dado de usuário, caminho real, chave ou
 * segredo), 5 casos por surface: um smoke que grava a célula, mas ainda não
 * atinge MIN_QUALITY_CASES para substituir o prior de cada surface.
 *
 * Fora daqui: dispatchGuard, handoffReview, memoryDistill, computerTool e
 * browserTool ficam fixos no Jev no Automático; medir não muda a rota deles.
 * taskRouting também é fixo; seus casos históricos continuam no smoke.
 *
 * Cobre sim/não, escolha e escala; 3 casos de desenvolvimento e 2 de validação
 * por surface. O rótulo nunca sai do processo: `evaluateDecisionCases` só
 * manda `state` e `questions` ao provedor.
 */
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import type { JevQuestion } from '../jev/jev-client';
import type { DecisionEvalCase } from './decision-evaluation';

type Expected = DecisionEvalCase['expected'][string];
type Row = readonly [state: unknown, expected: Record<string, Expected>];

/** 5 linhas por surface: as 3 primeiras de desenvolvimento, as 2 últimas de validação. */
function surfaceCases(
  surface: JevDecisionSurface, prefix: string, questions: Record<string, JevQuestion>, rows: readonly Row[],
): DecisionEvalCase[] {
  return rows.map(([state, expected], index) => {
    const asked = Object.fromEntries(Object.keys(expected).map(id => [id, questions[id]!]));
    return { id: `cal-${prefix}-${index + 1}`, surface, split: index < 3 ? 'development' : 'heldout', state, questions: asked, expected };
  });
}

const TOOL_PICK: JevQuestion = { type: 'choice', instructions: 'Qual operação corresponde ao pedido?',
  criteria: { read: 'Ler a saída existente do terminal', write: 'Enviar texto ao terminal', none: 'Nenhuma das opções' } };
const WAITING: JevQuestion = { type: 'noul', instructions: 'O terminal aguarda uma ação humana?' };
const COMPLEXITY: JevQuestion = { type: 'score', instructions: 'Quão complexo é entregar este pedido bem?',
  criteria: ['0: trivial — uma mudança rápida', '1: pequeno — uma peça focada', '2: médio — várias peças relacionadas',
    '3: grande — muitas peças, trabalho transversal'] };
const RESEARCH: JevQuestion = { type: 'noul', instructions: 'O resultado responde à pergunta?' };
const SPECIALTY: JevQuestion = { type: 'choice', instructions: 'Qual especialidade descreve melhor esta tarefa?',
  criteria: { visual: 'interface, layout, estilo, telas', security: 'autenticação, permissões, segredos',
    bug: 'algo que funcionava quebrou e a tarefa é consertar', general: 'outro trabalho de código' } };
const MISSION_PICK: JevQuestion = { type: 'choice', instructions: 'Qual missão o operador pediu para abrir?',
  criteria: { m1: 'Relatório mensal de vendas', m2: 'Migração do login para OAuth', m3: 'Tema escuro do painel',
    none: 'nenhuma corresponde' } };
const CATALOG_PICK: JevQuestion = { type: 'choice',
  instructions: 'O estado traz a stack do projeto. Qual item do catálogo mais ajudaria? Escolha none se nenhum for claramente útil.',
  criteria: { react: 'especialista em componentes React', postgres: 'especialista em consultas PostgreSQL',
    ios: 'especialista em apps iOS com Swift', none: 'nenhum é claramente útil' } };
const LANE: JevQuestion = { type: 'choice', instructions: 'Qual trilha combina melhor com esta missão?',
  criteria: { standard: 'escrever e mudar código, com testes', consult: 'responder ou investigar, sem mudar código',
    plan: 'produzir um plano ou documento antes do código', ops: 'operar, publicar ou rodar comandos' } };
const REGRESSION: JevQuestion = { type: 'noul',
  instructions: 'Qual a chance de este handoff de código introduzir uma regressão que uma revisão independente pegaria?' };
const RECOVERY: JevQuestion = { type: 'choice', instructions: 'Um worker da missão caiu. Qual a melhor recuperação?',
  criteria: { 'retry-same-cli': 'falha passageira: repetir a mesma CLI', 'switch-cli': 'o provedor é o problema: trocar de CLI',
    'escalate-orchestrator': 'a tarefa precisa de decisão: devolver ao orquestrador' } };
const COVERAGE: JevQuestion = { type: 'noul', instructions: 'Os handoffs entregues, juntos, cobrem o objetivo e os critérios de aceite?' };

const CASES: DecisionEvalCase[] = [
  ...surfaceCases('toolPick', 'tool', { decision: TOOL_PICK }, [
    ['O operador pediu só as últimas linhas da saída do terminal, sem digitar nada.', { decision: 'read' }],
    ['Digite "npm test" no terminal e aperte Enter.', { decision: 'write' }],
    ['O operador quer reservar uma mesa num restaurante. O catálogo só lê e escreve no terminal.', { decision: 'none' }],
    ['Mostre o que apareceu no terminal depois do build, sem mexer nele.', { decision: 'read' }],
    ['Responda "s" à pergunta que o instalador está fazendo no terminal.', { decision: 'write' }],
  ]),
  ...surfaceCases('paneState', 'pane', { decision: WAITING }, [
    ['O instalador mostra "Deseja continuar? [s/n]" e o cursor está parado após a pergunta.', { decision: true }],
    ['O build terminou com código 0, o prompt do shell voltou e não há processo filho ativo.', { decision: false }],
    ['Os testes estão rodando e imprimem uma linha por segundo.', { decision: false }],
    ['A ferramenta pede "Digite a senha do certificado:" e não imprime mais nada.', { decision: true }],
    ['O servidor de desenvolvimento diz "pronto em 1,2 s" e segue escutando a porta.', { decision: false }],
  ]),
  ...surfaceCases('intake', 'intake', { complexity: COMPLEXITY }, [
    ['Corrija um erro de digitação no título da página de ajuda.', { complexity: { min: 0, max: 1 } }],
    ['Adicione um filtro por data na lista de pedidos, com teste.', { complexity: { min: 0.5, max: 2 } }],
    ['Troque o mecanismo de autenticação do app desktop, do app móvel e da API, migrando as sessões ativas, com testes em cada parte.',
      { complexity: { min: 2, max: 3 } }],
    ['Mude a cor do botão principal de azul para verde.', { complexity: { min: 0, max: 1 } }],
    ['Reescreva a sincronização offline entre o app móvel e o servidor, com resolução de conflitos e migração de dados.',
      { complexity: { min: 2, max: 3 } }],
  ]),
  ...surfaceCases('researchTriage', 'research', { decision: RESEARCH }, [
    [{ question: 'Como funciona o fluxo OAuth com PKCE?', result: 'Receita de bolo de cenoura com cobertura.' }, { decision: false }],
    [{ question: 'Qual código HTTP indica limite de requisições?', result: 'O código 429 indica excesso de requisições num intervalo.' },
      { decision: true }],
    [{ question: 'Como desligar o cache de um fetch no navegador?', result: 'Use a opção cache: "no-store" na chamada fetch.' },
      { decision: true }],
    [{ question: 'Qual a diferença entre let e const em JavaScript?', result: 'Dicas de jardinagem para o inverno.' }, { decision: false }],
    [{ question: 'Como criar um índice numa tabela PostgreSQL?', result: 'CREATE INDEX nome ON tabela (coluna); cria o índice.' },
      { decision: true }],
  ]),
  ...surfaceCases('taskRouting', 'routing', { specialty: SPECIALTY }, [
    ['Ajustar o espaçamento dos cartões na tela inicial.', { specialty: 'visual' }],
    ['O botão de salvar parou de funcionar depois da última versão; consertar.', { specialty: 'bug' }],
    ['Exigir permissão de administrador para apagar projetos.', { specialty: 'security' }],
    ['Trocar a fonte e as cores do cabeçalho.', { specialty: 'visual' }],
    ['A exportação em CSV voltou a gerar arquivos vazios; corrigir.', { specialty: 'bug' }],
  ]),
  ...surfaceCases('missionPick', 'pick', { mission: MISSION_PICK }, [
    ['O operador disse: "abre a missão do relatório de vendas".', { mission: 'm1' }],
    ['O operador disse: "volta na missão do login".', { mission: 'm2' }],
    ['O operador disse: "abre a missão da fatura de energia".', { mission: 'none' }],
    ['O operador disse: "quero ver aquela do tema escuro".', { mission: 'm3' }],
    ['O operador disse: "abre a do OAuth".', { mission: 'm2' }],
  ]),
  ...surfaceCases('catalogPick', 'catalog', { item: CATALOG_PICK }, [
    [{ stack: 'React com TypeScript no front', area: 'componentes de interface' }, { item: 'react' }],
    [{ stack: 'API em Node com PostgreSQL', area: 'consultas lentas no banco' }, { item: 'postgres' }],
    [{ stack: 'script de linha de comando em Go', area: 'leitura de argumentos' }, { item: 'none' }],
    [{ stack: 'app iOS nativo', area: 'telas em SwiftUI' }, { item: 'ios' }],
    [{ stack: 'painel em React', area: 'formulários e validação na tela' }, { item: 'react' }],
  ]),
  ...surfaceCases('missionKickoff', 'kickoff', { complexity: COMPLEXITY, lane: LANE }, [
    [{ goal: 'Escrever um documento de arquitetura para o novo módulo de relatórios, sem código ainda.' }, { lane: 'plan' }],
    [{ goal: 'Adicionar um botão "Copiar" na tela de detalhes, com teste do componente.' },
      { complexity: { min: 0, max: 1.5 }, lane: 'standard' }],
    [{ goal: 'Publicar a versão aprovada no servidor de produção e conferir os logs.' }, { lane: 'ops' }],
    [{ goal: 'Explicar por que a página inicial ficou lenta, sem alterar código.' }, { lane: 'consult' }],
    [{ goal: 'Implementar pagamentos recorrentes no app, na API e no painel, com testes.' },
      { complexity: { min: 2, max: 3 }, lane: 'standard' }],
  ]),
  ...surfaceCases('reviewTriage', 'triage', { decision: REGRESSION }, [
    [{ summary: 'Reescrevi a camada de permissões e a migração do banco; não rodei os testes.', files: 24 }, { decision: { min: 0.6, max: 1 } }],
    [{ summary: 'Corrigi o texto de um rótulo e o teste do componente passou.', files: 1 }, { decision: { min: 0, max: 0.4 } }],
    [{ summary: 'Troquei a biblioteca de datas em todo o projeto; testes parciais.', files: 40 }, { decision: { min: 0.6, max: 1 } }],
    [{ summary: 'Ajustei a margem de um ícone; captura de tela conferida.', files: 1 }, { decision: { min: 0, max: 0.4 } }],
    [{ summary: 'Mudei o cálculo de impostos e a forma de arredondar valores; sem teste novo.', files: 6 }, { decision: { min: 0.6, max: 1 } }],
  ]),
  ...surfaceCases('recoveryAdvice', 'recovery', { next_step: RECOVERY }, [
    [{ triggerClass: 'transient', detail: 'queda de rede de alguns segundos' }, { next_step: 'retry-same-cli' }],
    [{ triggerClass: 'quota', detail: 'cota mensal do provedor esgotada' }, { next_step: 'switch-cli' }],
    [{ triggerClass: 'unknown', detail: 'a tarefa pede uma decisão de produto que ninguém tomou' }, { next_step: 'escalate-orchestrator' }],
    [{ triggerClass: 'model-rejected', detail: 'o provedor recusa o modelo configurado' }, { next_step: 'switch-cli' }],
    [{ triggerClass: 'transient', detail: 'o processo caiu uma vez sem erro do provedor' }, { next_step: 'retry-same-cli' }],
  ]),
  ...surfaceCases('completionCheck', 'coverage', { decision: COVERAGE }, [
    [{ goal: 'Login com e-mail e recuperação de senha', criteria: ['login funciona', 'recuperação de senha funciona'],
      handoffs: ['Implementei o login com e-mail e testes.'] }, { decision: false }],
    [{ goal: 'Exportar relatório em CSV', criteria: ['botão exporta CSV', 'teste cobre a exportação'],
      handoffs: ['Botão "Exportar CSV" implementado.', 'Teste da exportação adicionado e passando.'] }, { decision: true }],
    [{ goal: 'Tema escuro no painel', criteria: ['alternar tema', 'preferência salva'],
      handoffs: ['Alternância de tema pronta.', 'Preferência gravada e restaurada ao abrir.'] }, { decision: true }],
    [{ goal: 'Busca com filtros', criteria: ['busca por texto', 'filtro por data', 'filtro por autor'],
      handoffs: ['Busca por texto pronta.'] }, { decision: false }],
    [{ goal: 'Notificação por e-mail ao concluir pedido', criteria: ['e-mail enviado', 'teste do envio'],
      handoffs: ['Envio do e-mail implementado.', 'Teste do envio com servidor falso passando.'] }, { decision: true }],
  ]),
];

export const DECISION_CALIBRATION_CASES: readonly DecisionEvalCase[] = Object.freeze(CASES);
