import type { Squad, SquadAgent } from '../../shared/orch-types';
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import { applySquadModelDefault } from '../../shared/squad-model-defaults';

/**
 * NEXUS ORIGINALS — squads embutidos, semeados no primeiro run (marcados
 * `builtin`) para que o Modo Squad funcione out-of-the-box, sem depender de
 * migração ou criação manual. Squads de desenvolvimento usam Claude como
 * orquestrador; o Pet Studio é a exceção visual deliberada, com um único Codex
 * e sem pipeline de repositório. Os workers podem ser trocados no passo de
 * revisão do wizard. Ids estáveis para não duplicar entre versões; `createdAt`
 * fixo para não churnar.
 */

const SEED_TS = '1704067200000'; // 2024-01-01, estável

const SPEAK_HUMAN =
  '\n\n## Comunicação com o usuário\n' +
  'Fale humano: traduza estado interno em linguagem natural e acionável. ' +
  'Não leia nomes de tools, JSON, IDs longos, stacks de erro ou jargão de ' +
  'orquestração quando falar com o usuário; resuma impacto, decisão e próximo passo.';

/**
 * Allowlist mínima e explícita por papel (SEC#5 — antes `null` = irrestrito em
 * todos). Em squads gerais o orquestrador é o dono da missão e usa o toolset
 * completo; o Pet Studio declara apenas `load_workspace_dependencies`. Todo
 * worker é uma folha que só precisa entregar o handoff (nexus_handoff_submit é
 * sempre permitido), então seu `allowedTools` é `[]` — sem pane cross-access,
 * sem spawnar panes, sem controlar a missão. `allowedSkills` fica aberto de
 * propósito: skills rodam no contexto do próprio worker (não é vetor de escape
 * lateral) e workers legítimos precisam delas (ex.: impeccable no UX Designer).
 *
 * NOTA — normalizador canônico: esta é a ÚNICA regra de allowlist do produto.
 * Os built-ins a aplicam no load; os squads custom/arquiteto/importados a
 * aplicam na camada de persistência (squad-store.saveSquad / importSquadsJson)
 * para que TODO worker persistido tenha `allowedTools` não-nulo e passe o
 * fire-gate do wizard (validateWorkerToolScopes). O `[]` do worker escopa
 * APENAS o toolset MCP do Nexus (nexus_pane_*, remote_*, etc.) — as tools
 * NATIVAS da CLI do worker (Read/Write/Edit/Bash/Grep/Glob) não passam por este
 * gate, então `[]` NÃO incapacita o worker: ele continua codando normalmente e
 * só perde acesso cruzado a panes/missão, entregando via nexus_handoff_submit
 * (sempre permitido). Tools nativas continuam sob o sandbox/modo de permissão
 * seguro do próprio CLI; o hook distingue essas tools das chamadas MCP Nexus.
 * Ver gate.ts isHookToolAllowed/isToolAllowed + mcp-protocol.ts.
 */
export function withAllowlists(agents: SquadAgent[]): SquadAgent[] {
  return agents.map((agent) => ({
    ...applySquadModelDefault(agent),
    allowedTools:
      agent.allowedTools ?? (agent.category === 'orchestrator' ? null : []),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Review P0–P3 — port do pipeline de review do oh-my-pi.
// Derived from can1357/oh-my-pi@03c48d073 review pipeline (MIT):
// - prompts/review-request.md (orquestração: escopo, distribuição, filtro)
// - prompts/agents/reviewer.md (reviewer: critérios, prioridades, cross-boundary)
// - extensibility/custom-commands/bundled/review/index.ts (EXCLUDED_PATTERNS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toolset Nexus read-only dos reviewers do Review P0–P3: leitura de arquivo,
 * busca, diff/log/status + handoff. Sem panes, sem missão, sem escrita — o
 * gate MCP recusa qualquer outra tool. handoff_submit/handoff_list já são
 * sempre permitidas pelo gate; ficam explícitas para documentar o contrato.
 * (As tools NATIVAS da CLI continuam disponíveis; o prompt instrui read-only.)
 */
const REVIEW_P0P3_READONLY_TOOLS: string[] = [
  'nexus_file_read',
  'nexus_file_search',
  'nexus_git_diff',
  'nexus_git_log',
  'nexus_git_status',
  'nexus_handoff_submit',
  'nexus_handoff_list',
];

/**
 * Lista literal de exclusão de ruído (com a razão de cada uma), espelhando
 * EXCLUDED_PATTERNS do /review do omp. Vive nas instruções do orquestrador
 * porque é ele quem calcula e filtra o escopo do diff.
 */
const REVIEW_P0P3_NOISE_EXCLUSIONS =
  '## 2. Filtro de ruído (exclusões obrigatórias)\n' +
  'Remova do escopo os arquivos abaixo ANTES de distribuir — eles só geram ' +
  'ruído de review. Liste cada um no handoff final como excluído, com a razão:\n' +
  '- Lock files: `*.lock`, `*-lock.json`, `*-lock.yaml`/`.yml`, ' +
  '`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, ' +
  '`Gemfile.lock`, `poetry.lock`, `composer.lock`, `flake.lock` — razão ' +
  '"lock file": gerados pelo gerenciador de dependências, ninguém os edita à mão;\n' +
  '- Minificados: `*.min.js`, `*.min.css` — razão "minified": ilegíveis, a ' +
  'fonte real é o arquivo original;\n' +
  '- Gerados: `*.generated.*` — razão "generated": a fonte da verdade é o gerador;\n' +
  '- Snapshots de teste: `*.snap` — razão "snapshot": derivados dos testes, ' +
  'mudam junto com eles;\n' +
  '- Source maps: `*.map` — razão "source map": artefato de build;\n' +
  '- Saída de build: `dist/`, `build/`, `out/` — razão "build output": ' +
  'artefatos compilados, revise a fonte;\n' +
  '- Vendor: `node_modules/`, `vendor/` — razão "vendor": código de terceiros;\n' +
  '- Imagens: `png`, `jpg`, `jpeg`, `gif`, `ico`, `webp`, `avif` — razão ' +
  '"image": binário, sem diff textual útil;\n' +
  '- Fontes tipográficas: `woff`, `woff2`, `ttf`, `eot`, `otf` — razão "font": binário;\n' +
  '- Binários/arquivos compactados: `pdf`, `zip`, `tar`, `gz`, `rar`, `7z` — ' +
  'razão "binary": binário.\n';

/**
 * Bloco de instruções que o orquestrador repassa INTEIRO a cada reviewer no
 * prompt do spawn (SquadAgent não tem instruções por agente — a entrega é
 * via prompt). Adaptação fiel do reviewer.md do omp.
 */
const REVIEW_P0P3_REVIEWER_INSTRUCTIONS =
  '### Papel\n' +
  'Você é um revisor de código READ-ONLY. Identifique bugs que o autor ' +
  'gostaria de corrigir antes do merge. Você NUNCA edita arquivos nem ' +
  'dispara builds; use o terminal apenas para leitura (`git diff`, ' +
  '`git log`, `git show`).\n' +
  '\n' +
  '### Procedimento\n' +
  '1. Revise SOMENTE os arquivos designados a você, usando os hunks de diff ' +
  'fornecidos neste prompt (não recalcule o escopo do review).\n' +
  '2. Leia os arquivos modificados para obter o contexto completo.\n' +
  '3. Registre cada problema como um finding no formato abaixo.\n' +
  '4. Feche com o veredito e entregue TUDO num único nexus_handoff_submit.\n' +
  '\n' +
  '### Critérios (reporte um finding apenas quando TODOS valem)\n' +
  '- **Impacto provável**: aponte o caminho de código afetado (sem especulação);\n' +
  '- **Acionável**: correção discreta, não um vago "considere melhorar X";\n' +
  '- **Não intencional**: claramente não é escolha deliberada de design;\n' +
  '- **Introduzido no patch**: não aponte bugs pré-existentes;\n' +
  '- **Sem suposições não declaradas**: o bug não depende de suposições ' +
  'sobre o codebase ou a intenção do autor;\n' +
  '- **Rigor proporcional**: a correção não exige rigor ausente no resto do codebase.\n' +
  '\n' +
  '### Regra cross-boundary (obrigatória)\n' +
  'Para todo tipo, variante ou valor novo introduzido pelo patch que cruza ' +
  'uma fronteira de função ou módulo (evento, mensagem, comando, frame, ' +
  'variante de enum, item de fila, payload IPC):\n' +
  '1. Localize o **dispatch point** — o switch, router, filter chain, ' +
  'handler registry ou corpo de loop que recebe e roteia valores desse tipo ' +
  'no lado CONSUMIDOR;\n' +
  '2. Confirme que o tipo novo tem um branch explícito, ou que o catch-all ' +
  'existente o encaminha corretamente;\n' +
  '3. Se o tipo novo cai num drop silencioso, no-op ou descarte (ex.: um ' +
  '`if`/`switch` sem match que retorna sem processar), reporte como defeito.\n' +
  'O dispatch point frequentemente está FORA do diff. Você DEVE lê-lo antes ' +
  'de concluir que o lado produtor está correto. Rastrear só o código ' +
  'emissor e pular a lógica de roteamento consumidora é a fonte nº 1 de ' +
  'bugs de integração perdidos em reviews.\n' +
  '\n' +
  '### Prioridades\n' +
  '| Nível | Critério | Exemplo |\n' +
  '|---|---|---|\n' +
  '| P0 | Bloqueia release/operação; universal (sem suposição de input) | corrupção de dados, bypass de auth |\n' +
  '| P1 | Alta; corrigir no próximo ciclo | race condition sob carga |\n' +
  '| P2 | Média; corrigir eventualmente | edge case mal tratado |\n' +
  '| P3 | Informativo; nice to have | subótimo, porém correto |\n' +
  '\n' +
  '### Formato de cada finding\n' +
  '- `title`: imperativo, no máximo 80 caracteres (ex.: "Valide o tamanho ' +
  'do input antes do memcpy");\n' +
  '- `body`: um parágrafo — bug, condição de disparo, impacto; tom neutro;\n' +
  '- `priority`: "P0" | "P1" | "P2" | "P3";\n' +
  '- `confidence`: 0.0-1.0 — confiança de que é bug real;\n' +
  '- `file`: caminho do arquivo afetado;\n' +
  '- `lineStart`/`lineEnd`: intervalo 1-indexado de no máximo 10 linhas, ' +
  'que DEVE sobrepor o diff.\n' +
  '\n' +
  '### Entrega (obrigatória)\n' +
  'Chame nexus_handoff_submit UMA vez ao terminar, com:\n' +
  '- status: "success" ("blocked"/"failed" apenas se não conseguiu revisar);\n' +
  '- summary: resumo textual curto seguido de um bloco ```json contendo ' +
  'exatamente este objeto:\n' +
  '{"verdict": "correct"|"incorrect", "explanation": "1-3 frases", ' +
  '"confidence": 0.0-1.0, "findings": [{"title", "body", "priority", ' +
  '"confidence", "file", "lineStart", "lineEnd"}]}\n' +
  '- artifacts: [o mesmo objeto JSON].\n' +
  '"correct" = sem bugs/bloqueadores; o veredito ignora questões não ' +
  'bloqueantes (estilo, docs, nits). Todo finding DEVE ser ancorado no ' +
  'patch e sustentado por evidência.\n';

/**
 * Instruções do orquestrador do Review P0–P3 — adaptação em pt-BR do
 * review-request.md do omp: escopo do diff, filtro de ruído, distribuição
 * por localidade e consolidação num handoff final com JSON tipado
 * (ver src/main/orch/review-findings.ts / parseReviewFindings).
 */
const REVIEW_P0P3_ORCH_INSTRUCTIONS =
  '# Review P0–P3\n' +
  'Você é o orquestrador de um pipeline de code review multi-agente. Sua ' +
  'entrega final é um handoff consolidado com veredito e findings ' +
  'priorizados de P0 a P3. Os reviewers são READ-ONLY: nenhum agente desta ' +
  'missão edita arquivos.\n' +
  '\n' +
  '## 1. Escopo do diff\n' +
  'Calcule o diff conforme a missão pedir:\n' +
  '- **Uncommitted** (default): combine `git diff` (unstaged) e ' +
  '`git diff --cached` (staged);\n' +
  '- **Branch (estilo PR)**: `git diff <base>...<branch-atual>`;\n' +
  '- **Commit específico**: `git show <hash>`.\n' +
  'Conte arquivos e linhas +/- por arquivo — isso guia a distribuição. Se ' +
  'não houver mudanças reviewáveis, finalize com um handoff explicando isso.\n' +
  '\n' +
  REVIEW_P0P3_NOISE_EXCLUSIONS +
  '\n' +
  '## 3. Distribuição por localidade\n' +
  'Decida o número de reviewers pelo peso do diff:\n' +
  '- <100 linhas alteradas ou ≤2 arquivos → 1 reviewer;\n' +
  '- <500 linhas → até 2 reviewers;\n' +
  '- <2000 linhas → até 4 (≈1 por 3 arquivos);\n' +
  '- acima disso → mais reviewers, mantendo grupos coesos.\n' +
  'Agrupe os arquivos por localidade:\n' +
  '- mesmo diretório/módulo → mesmo reviewer;\n' +
  '- funcionalidade relacionada → mesmo reviewer;\n' +
  '- testes junto dos arquivos de implementação que eles cobrem.\n' +
  'Registre o plano com nexus_task e spawne cada reviewer do roster via ' +
  'nexus_pane_spawn (em paralelo). O prompt de cada reviewer DEVE conter:\n' +
  '(a) a lista de arquivos designados com +/- por arquivo;\n' +
  '(b) os hunks do diff desses arquivos — se o diff total for grande ' +
  '(>50k caracteres ou >20 arquivos), inclua só um preview e instrua o ' +
  'reviewer a rodar `git diff -- <path>` (e `git diff --cached -- <path>` ' +
  'no modo uncommitted) nos arquivos designados;\n' +
  '(c) o bloco "Instruções do reviewer" abaixo, INTEIRO e sem alterações.\n' +
  'Aguarde com nexus_pane_wait_many e colete os handoffs com nexus_handoff_list.\n' +
  '\n' +
  '## 4. Instruções do reviewer (repasse este bloco inteiro a cada reviewer)\n' +
  '\n' +
  REVIEW_P0P3_REVIEWER_INSTRUCTIONS +
  '\n' +
  '## 5. Consolidação (handoff final)\n' +
  'Reúna os handoffs de todos os reviewers e consolide:\n' +
  '- deduplique findings do mesmo arquivo/intervalo, mantendo a maior ' +
  'prioridade e a maior confidence;\n' +
  '- descarte findings sem âncora no patch ou sem evidência;\n' +
  '- ordene por prioridade (P0 primeiro) e, dentro dela, por confidence;\n' +
  '- verdict global: "incorrect" se restou qualquer bug/bloqueador real; ' +
  'senão "correct" (estilo, docs e nits não mudam o veredito);\n' +
  '- explanation: 1-3 frases; confidence: a mais conservadora entre os reviewers.\n' +
  'O handoff FINAL DEVE incluir o JSON consolidado no formato do item 4 — ' +
  'num bloco ```json dentro do summary E como item de artifacts — para o ' +
  'Nexus fazer o parse tipado (parseReviewFindings). Sem esse JSON o ' +
  'resultado do review é inutilizável.\n';

const RAW_SQUADS: Squad[] = [
  PET_STUDIO_SQUAD,
  {
    id: 'nexus-fullstack',
    name: 'Full-Stack',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Full-Stack\n' +
      'Você é o orquestrador. Quebre a tarefa em frente, back e revisão; ' +
      'delegue cada parte ao worker correspondente via nexus_pane_* e ' +
      'integre os handoffs. O roster é um MENU: spawne só os agentes que a ' +
      'missão pede. Antes de finalizar: QA roda os testes/o app de verdade e ' +
      'tenta quebrar a entrega; Security revisa qualquer coisa que toque ' +
      'auth, pagamentos, rede ou dados de usuário; UX Designer critica e ' +
      'refina toda entrega com interface (hierarquia, estados vazios, ' +
      'acessibilidade, polish — use a skill impeccable se disponível). Só ' +
      'finalize com QA e Reviewer aprovando.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      // Workers em CLIs DIFERENTES (defaults editáveis no review): diversidade
      // de modelos = custo menor e sem sobrecarregar um provedor só.
      { id: 'frontend', agentName: 'Frontend', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'backend', agentName: 'Backend', category: 'executor', cli: 'agy', effort: 'medium' },
      // Executor generalista no omp: entra no menu para tarefas que cruzam
      // frente/back ou quando o orquestrador quer paralelizar implementação.
      { id: 'generalist', agentName: 'Generalist (omp)', category: 'executor', cli: 'omp', effort: 'medium' },
      { id: 'ux', agentName: 'UX Designer', category: 'reviewer', cli: 'claude', effort: 'medium' },
      { id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'grok', effort: 'medium' },
      { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'claude', effort: 'high' },
      { id: 'reviewer', agentName: 'Reviewer', category: 'reviewer', cli: 'kimi', effort: 'high' },
    ],
  },
  {
    id: 'nexus-review',
    name: 'Code Review',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Code Review\n' +
      'Você é o orquestrador. Envie o diff para os revisores em paralelo ' +
      '(correção, segurança e performance), colete os handoffs e consolide ' +
      'um veredito único, priorizando os achados por severidade.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'correctness', agentName: 'Correctness', category: 'reviewer', cli: 'kimi', effort: 'high' },
      { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'claude', effort: 'high' },
      { id: 'performance', agentName: 'Performance', category: 'reviewer', cli: 'agy', effort: 'high' },
      // Quarto olhar no omp: casos de borda e integrações cross-boundary
      // (mesma diversidade de modelos dos outros squads).
      { id: 'edge-cases', agentName: 'Edge Cases (omp)', category: 'reviewer', cli: 'omp', effort: 'high' },
    ],
  },
  {
    id: 'review-p0p3',
    name: 'Review P0–P3',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions: REVIEW_P0P3_ORCH_INSTRUCTIONS,
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      // Reviewers em CLIs diferentes (mesma razão do Full-Stack: diversidade
      // de modelos). Allowlist Nexus explícita e read-only; allowedSkills []
      // porque review P0–P3 é leitura pura — nenhuma skill é necessária.
      {
        id: 'reviewer-a',
        agentName: 'Reviewer A',
        category: 'reviewer',
        cli: 'claude',
        effort: 'high',
        allowedTools: [...REVIEW_P0P3_READONLY_TOOLS],
        allowedSkills: [],
      },
      {
        id: 'reviewer-b',
        agentName: 'Reviewer B',
        category: 'reviewer',
        cli: 'kimi',
        effort: 'high',
        allowedTools: [...REVIEW_P0P3_READONLY_TOOLS],
        allowedSkills: [],
      },
      {
        id: 'reviewer-c',
        agentName: 'Reviewer C',
        category: 'reviewer',
        cli: 'agy',
        effort: 'high',
        allowedTools: [...REVIEW_P0P3_READONLY_TOOLS],
        allowedSkills: [],
      },
      {
        // O pipeline É um port do oh-my-pi — o omp revisa no próprio rito,
        // e é assim que ele entra em operação de background (achado de
        // operador: "omp integrado mas nunca vi em ação").
        id: 'reviewer-d',
        agentName: 'Reviewer D (omp)',
        category: 'reviewer',
        cli: 'omp',
        effort: 'high',
        allowedTools: [...REVIEW_P0P3_READONLY_TOOLS],
        allowedSkills: [],
      },
    ],
  },
  {
    id: 'nexus-research',
    name: 'Research & Arquitetura',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Research & Arquitetura\n' +
      'Você é o orquestrador. Mande os scouts levantarem o terreno em ' +
      'paralelo, sintetize os achados e peça ao arquiteto um plano de ' +
      'implementação com trade-offs. Depois passe o plano ao Contrarian ' +
      'para ele atacar (custos ocultos, riscos, alternativa mais simples) ' +
      'antes de qualquer código.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'scout-a', agentName: 'Scout A', category: 'scout', cli: 'agy', effort: 'medium' },
      { id: 'scout-b', agentName: 'Scout B', category: 'scout', cli: 'grok', effort: 'medium' },
      { id: 'scout-c', agentName: 'Scout C (omp)', category: 'scout', cli: 'omp', effort: 'medium' },
      { id: 'architect', agentName: 'Architect', category: 'architect', cli: 'claude', effort: 'high' },
      { id: 'contrarian', agentName: 'Contrarian', category: 'reviewer', cli: 'kimi', effort: 'high' },
    ],
  },
];

/** Built-in squads with the per-role tool allowlists applied (SEC#5). */
export const BUILTIN_SQUADS: Squad[] = RAW_SQUADS.map((squad) => ({
  ...squad,
  orchestratorInstructions:
    squad.id === PET_STUDIO_SQUAD_ID
      ? squad.orchestratorInstructions
      : `${squad.orchestratorInstructions}${SPEAK_HUMAN}`,
  agents: withAllowlists(squad.agents),
}));
