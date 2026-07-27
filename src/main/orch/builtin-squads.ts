import type { Squad, SquadAgent } from '../../shared/orch-types';
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import { applySquadModelDefault } from '../../shared/squad-model-defaults';
import {
  NEXUS_PLAN_SQUAD_ID,
  NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
} from '../../shared/builtin-squad-ids';

/**
 * NEXUS ORIGINALS — squads embutidos, semeados no primeiro run (marcados
 * `builtin`) para que o Modo Squad funcione out-of-the-box, sem depender de
 * migração ou criação manual. Squads de desenvolvimento usam Claude como
 * orquestrador e Codex como worker governado; o Pet Studio é a exceção visual
 * deliberada, com um único Codex e sem pipeline de repositório. Outras CLIs
 * continuam disponíveis em painéis/Terminal manual, mas não são prometidas
 * pelos rosters autônomos desta release. Ids estáveis para não duplicar entre
 * versões; `createdAt` fixo para não churnar.
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
 * completo; o Pet Studio declara apenas dependências locais e as duas tools
 * Nexus de mídia necessárias ao pipeline visual. Todo
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
  'Todos os reviewers deste roster são identidades independentes executadas ' +
  'no Codex builtin governado. Kimi, OMP, Grok, AGY e outras CLIs continuam ' +
  'disponíveis no Terminal/manual, mas não substituem workers desta missão.\n' +
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

const OUTCOME_PACK_COMMON =
  '\n\n## Operação segura\n' +
  'Transforme o contrato de resultado em tarefas com donos, dependências e ' +
  'critérios de aceite antes de spawnar. Use apenas agentes do roster; nesta ' +
  'release, cada worker governado usa o Codex builtin e mantém escrita em um ' +
  'único worktree por tarefa. Kimi, OMP, Grok, AGY e outras CLIs permanecem ' +
  'disponíveis apenas no Terminal/manual. ' +
  'Cada worker entrega um handoff com arquivos alterados e provas executadas. ' +
  'O implementador nunca aprova o próprio trabalho: QA e Reviewer verificam ' +
  'o resultado de forma independente. Não marque a missão como concluída/done ' +
  'sem handoffs aceitos e evidência real dos critérios de aceite; se algo ' +
  'essencial não puder ser provado, bloqueie com uma ação clara para o usuário.\n' +
  '\n' +
  '## Fechamento\n' +
  'O roster oferece um reviewer P0–P3, mas presença no roster ou neste prompt ' +
  'não prova execução automática. Só registre esse review como realizado ' +
  'quando ele existir no plano controlado pelo Nexus e houver handoff aceito; ' +
  'caso contrário, declare a revisão P0–P3 automática como indisponível. O ' +
  'handoff final explica em linguagem humana: o que ficou pronto, como foi ' +
  'provado, riscos restantes e onde encontrar os artefatos.\n';

const RAW_SQUADS: Squad[] = [
  PET_STUDIO_SQUAD,
  {
    id: 'outcome-landing-page',
    name: 'Landing Page',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Landing Page\n' +
      'Você conduz uma entrega de landing page utilizável, não um mock solto.\n' +
      '\n' +
      '## Contrato de resultado\n' +
      'Entregue a página integrada ao projeto existente, responsiva nas larguras ' +
      'previstas, com hierarquia visual clara, conteúdo coerente com o objetivo ' +
      'e um caminho de conversão funcional. Preserve o design system e a stack ' +
      'do workspace; não troque framework ou infraestrutura por conveniência.\n' +
      '\n' +
      'Critérios de aceite mínimos:\n' +
      '- a rota abre no app real sem erro de console impeditivo;\n' +
      '- CTA e navegação principal funcionam, inclusive por teclado;\n' +
      '- estados mobile e desktop foram observados em execução real;\n' +
      '- build, testes relevantes e checagens de acessibilidade do projeto passam;\n' +
      '- o handoff inclui caminhos, comandos e evidência visual quando houver UI.\n' +
      OUTCOME_PACK_COMMON,
    agents: [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        effort: 'high',
      },
      {
        id: 'frontend',
        agentName: 'Frontend',
        category: 'executor',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'ux-content',
        agentName: 'UX & Conteúdo',
        category: 'architect',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'qa-accessibility',
        agentName: 'QA & Acessibilidade',
        category: 'reviewer',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'final-review',
        agentName: 'Reviewer P0–P3',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
      },
    ],
  },
  {
    id: 'outcome-bug-fix',
    name: 'Bug Fix',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Bug Fix\n' +
      'Você conduz a correção completa de um defeito, da reprodução à prova ' +
      'contra regressão. Não trate sintoma como causa-raiz.\n' +
      '\n' +
      '## Contrato de resultado\n' +
      'Entregue uma reprodução determinística ou evidência equivalente, uma ' +
      'explicação curta da causa-raiz, a menor correção segura e um teste de ' +
      'regressão que falha no comportamento anterior e passa com a correção.\n' +
      '\n' +
      'Critérios de aceite mínimos:\n' +
      '- o caso reportado foi reproduzido antes de editar ou a impossibilidade foi documentada;\n' +
      '- o patch corrige a causa-raiz sem ampliar escopo sem necessidade;\n' +
      '- um teste ou prova repetível protege o caminho corrigido;\n' +
      '- testes vizinhos e typecheck/build relevantes continuam verdes;\n' +
      '- o handoff registra reprodução, causa, arquivos e comandos de validação.\n' +
      OUTCOME_PACK_COMMON,
    agents: [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        effort: 'high',
      },
      {
        id: 'investigator',
        agentName: 'Investigador',
        category: 'scout',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'fixer',
        agentName: 'Implementador',
        category: 'executor',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'regression-qa',
        agentName: 'QA de Regressão',
        category: 'reviewer',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'final-review',
        agentName: 'Reviewer P0–P3',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
      },
    ],
  },
  {
    id: 'outcome-store',
    name: 'Loja',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Loja\n' +
      'Você conduz uma entrega de comércio eletrônico navegável e verificável. ' +
      'Prefira integrar serviços já adotados pelo workspace.\n' +
      '\n' +
      '## Contrato de resultado\n' +
      'Entregue catálogo, detalhe de produto, carrinho persistente no escopo ' +
      'pedido e um checkout coerente com a integração aprovada. Pagamento real, ' +
      'alteração de preço, uso de segredo/credencial ou acesso a dados do cliente ' +
      'são superfícies sensíveis: exigem autorização explícita e nunca entram em ' +
      'logs, prompts, fixtures ou commits. Sem autorização, use apenas sandbox ' +
      'documentado e não alegue que produção foi validada.\n' +
      '\n' +
      'Critérios de aceite mínimos:\n' +
      '- catálogo, produto e carrinho funcionam no app real nos estados vazio e preenchido;\n' +
      '- totais e transições de checkout têm testes nos limites relevantes;\n' +
      '- falhas de rede/pagamento apresentam recuperação sem duplicar pedido;\n' +
      '- nenhuma credencial ou dado do cliente aparece em artefatos do repositório;\n' +
      '- build, testes, revisão de segurança e prova do fluxo aprovado passam;\n' +
      '- o handoff separa claramente sandbox validado de qualquer passo ainda pendente em produção.\n' +
      OUTCOME_PACK_COMMON,
    agents: [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        effort: 'high',
      },
      {
        id: 'storefront',
        agentName: 'Storefront',
        category: 'executor',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'commerce-backend',
        agentName: 'Catálogo & Pedidos',
        category: 'executor',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'security',
        agentName: 'Segurança de Pagamento',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
      },
      {
        id: 'checkout-qa',
        agentName: 'QA de Checkout',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
      },
      {
        id: 'final-review',
        agentName: 'Reviewer P0–P3',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
      },
    ],
  },
  {
    id: 'nexus-fullstack',
    name: 'Full-Stack',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Full-Stack\n' +
      'Você é o orquestrador. Quebre a tarefa em frente, back e revisão; ' +
      'delegue cada parte ao worker correspondente via nexus_pane_* e ' +
      'integre os handoffs. O roster é um MENU de identidades Codex ' +
      'independentes: spawne só os agentes que a missão pede e use o ' +
      'Generalist quando a missão cruzar frente+back ou pedir paralelismo. ' +
      'Antes de finalizar: QA roda os testes/o app de verdade e ' +
      'tenta quebrar a entrega; Security revisa qualquer coisa que toque ' +
      'auth, pagamentos, rede ou dados de usuário; UX Designer critica e ' +
      'refina toda entrega com interface (hierarquia, estados vazios, ' +
      'acessibilidade, polish — use a skill impeccable se disponível). Só ' +
      'finalize com QA e Reviewer aprovando.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'frontend', agentName: 'Frontend', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'backend', agentName: 'Backend', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'generalist', agentName: 'Generalist', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'ux', agentName: 'UX Designer', category: 'reviewer', cli: 'codex', effort: 'medium' },
      { id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'codex', effort: 'medium' },
      { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'codex', effort: 'high' },
      { id: 'reviewer', agentName: 'Reviewer', category: 'reviewer', cli: 'codex', effort: 'high' },
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
      'um veredito único, priorizando os achados por severidade. Todos são ' +
      'reviewers Codex governados e independentes; use Edge Cases para ' +
      'integrações cross-boundary.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'correctness', agentName: 'Correctness', category: 'reviewer', cli: 'codex', effort: 'high' },
      { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'codex', effort: 'high' },
      { id: 'performance', agentName: 'Performance', category: 'reviewer', cli: 'codex', effort: 'high' },
      { id: 'edge-cases', agentName: 'Edge Cases', category: 'reviewer', cli: 'codex', effort: 'high' },
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
      // Identidades independentes no Codex governado. Allowlist Nexus
      // explícita e read-only; allowedSkills [] porque review P0–P3 é leitura
      // pura — nenhuma skill é necessária.
      {
        id: 'reviewer-a',
        agentName: 'Reviewer A',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
        allowedTools: [...REVIEW_P0P3_READONLY_TOOLS],
        allowedSkills: [],
      },
      {
        id: 'reviewer-b',
        agentName: 'Reviewer B',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
        allowedTools: [...REVIEW_P0P3_READONLY_TOOLS],
        allowedSkills: [],
      },
      {
        id: 'reviewer-c',
        agentName: 'Reviewer C',
        category: 'reviewer',
        cli: 'codex',
        effort: 'high',
        allowedTools: [...REVIEW_P0P3_READONLY_TOOLS],
        allowedSkills: [],
      },
      {
        id: 'reviewer-d',
        agentName: 'Reviewer D',
        category: 'reviewer',
        cli: 'codex',
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
      'implementação com trade-offs. O Architect DEVE entregar junto um ' +
      'diagrama de arquitetura gerado com a skill archify (HTML ' +
      'self-contained salvo em docs/architecture/<slug>.html) cobrindo o ' +
      'estado atual e o proposto; abra o HTML num pane de browser para o ' +
      'usuário ver. Depois passe o plano ao Contrarian para ele atacar ' +
      '(custos ocultos, riscos, alternativa mais simples) antes de ' +
      'qualquer código.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'scout-a', agentName: 'Scout A', category: 'scout', cli: 'codex', effort: 'medium' },
      { id: 'scout-b', agentName: 'Scout B', category: 'scout', cli: 'codex', effort: 'medium' },
      { id: 'scout-c', agentName: 'Scout C', category: 'scout', cli: 'codex', effort: 'medium' },
      { id: 'architect', agentName: 'Architect', category: 'architect', cli: 'codex', effort: 'high' },
      { id: 'contrarian', agentName: 'Contrarian', category: 'reviewer', cli: 'codex', effort: 'high' },
    ],
  },
  {
    // Planejamento estilo BMAD adaptado a brownfield: leitura REAL do sistema
    // antes de qualquer pergunta, interrogatório grilling (uma pergunta por
    // vez, decisões do usuário), e documentos versionáveis como entrega.
    id: NEXUS_PLAN_SQUAD_ID,
    name: 'Planejamento & PRD',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Planejamento & PRD (brownfield-first)\n' +
      'Você é o Maestro de planejamento. Consolide PRD, arquitetura e stories ' +
      'executáveis em docs/plan.md — NENHUM código de produção é escrito nesta ' +
      'missão. Esta lane é deliberadamente executada apenas pelo Maestro: NÃO ' +
      'use nexus_pane_spawn nem nexus_route_task. Delegação nativa de leitura ' +
      'ainda não possui confinamento comprovado em todas as CLIs; o fan-out ' +
      'de workers Codex começa somente depois da promoção para standard.\n' +
      '\n' +
      '## 1. Leitura real do sistema (sempre primeiro)\n' +
      'Antes de qualquer pergunta ao usuário, levante o estado REAL do ' +
      'workspace: stack e dependências, módulos ' +
      'e fronteiras, fluxos críticos, integrações externas, testes e dívidas ' +
      'aparentes. Fatos se buscam no código — NUNCA pergunte ao usuário o ' +
      'que o repositório já responde.\n' +
      '\n' +
      '## 2. Interrogatório (skill grilling)\n' +
      'Com o terreno mapeado, entreviste o usuário no rito da skill ' +
      '`grilling`: UMA pergunta por vez, sempre com a sua recomendação ' +
      'junto; espere a resposta antes da próxima. Decisões são do usuário; ' +
      'fatos são do código. Percorra: problema e usuário-alvo, resultado ' +
      'esperado, escopo IN/OUT, restrições (prazo, plataformas, compliance), ' +
      'riscos aceitáveis e critérios de sucesso mensuráveis. Não avance ' +
      'para o PRD sem confirmar entendimento compartilhado.\n' +
      '\n' +
      '## 3. PRD\n' +
      'Produza uma seção PRD completa dentro de docs/plan.md, no formato do template ' +
      'prd/prd-template.md da skill bmad-templates (vision, JTBD, FRs ' +
      'aninhados por feature, NFRs, assumptions indexadas, escopo negativo). ' +
      'O PRD referencia os achados da leitura — nada de suposição que o ' +
      'código contradiga. Antes de aprovar, valide o documento item a ' +
      'item com prd/prd-validation-checklist.md e registre o resultado no ' +
      'fim do arquivo.\n' +
      '\n' +
      '## 4. Arquitetura com diagrama\n' +
      'Produza uma seção de arquitetura dentro de docs/plan.md, ' +
      'estruturada pelo architecture/spine-template.md da skill ' +
      'bmad-templates, ancorado no estado atual: componentes tocados, ' +
      'mudanças por módulo, contratos e migrações, sequenciamento e ' +
      'trade-offs. Inclua no mesmo docs/plan.md a especificação completa do ' +
      'diagrama (estado atual e proposto) que a execução materializará com ' +
      'archify após a promoção para standard.\n' +
      '\n' +
      '## 5. Shard em stories\n' +
      'Quebre PRD+arquitetura em épicos ' +
      '(stories/epics-template.md) e stories (stories/story-template.md) como ' +
      'seções estruturadas completas de docs/plan.md: cada story autossuficiente, com critérios de aceite ' +
      'verificáveis e dependências explícitas, validada com ' +
      'stories/story-checklist.md — prontas para o squad Implementação por ' +
      'Stories consumir uma a uma.\n' +
      '\n' +
      '## 6. Validação final\n' +
      'Faça uma passada Contrarian no pacote inteiro: custos ocultos, alternativa mais ' +
      'simples, o que quebra em produção. Incorpore o que sobreviver e ' +
      'finalize com nexus_handoff_submit: summary contém o conteúdo integral ' +
      'de docs/plan.md e artifacts estrutura os futuros caminhos em docs/prd/, ' +
      'docs/architecture/ e docs/stories/. Nesta lane escreva somente docs/plan.md.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
    ],
  },
  {
    // Elo de execução do ciclo BMAD: consome docs/stories/ do Planejamento &
    // PRD e implementa story por story com gate de Definition of Done.
    id: NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
    name: 'Implementação por Stories',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Implementação por Stories (ciclo BMAD)\n' +
      'Você é o orquestrador do ciclo disciplinado de implementação: consome ' +
      'as stories de docs/stories/ (geradas pelo squad Planejamento & PRD) ' +
      'e as implementa UMA POR VEZ até acabarem ou o usuário mandar parar. ' +
      'Spawne workers via nexus_pane_spawn, aguarde com nexus_pane_wait_many ' +
      'e colete entregas com nexus_handoff_list.\n' +
      '\n' +
      '## Entrada física da promoção\n' +
      'Quando o kickoff trouxer “PRD/plano físico aprovado na promoção”, esse ' +
      'payload selado (summary, artifacts e digests) é a fonte de verdade da ' +
      'execução. Antes da primeira story, materialize dele os documentos finais ' +
      'em docs/prd/, docs/architecture/ e docs/stories/ e gere o diagrama ' +
      'archify especificado; esta lane standard autoriza essa escrita. Depois ' +
      'comece pela primeira story pronta. ' +
      'NÃO repita discovery, entrevista, PRD, arquitetura nem o shard de ' +
      'stories; o planejamento já terminou na revisão plan anterior.\n' +
      '\n' +
      '## Ciclo por story\n' +
      '1. **Seleção**: liste docs/stories/ e escolha a próxima story aberta ' +
      'sem dependência pendente. Se o diretório estiver vazio mas houver o ' +
      'payload promovido, materialize-o primeiro — nunca repita planejamento. ' +
      'Somente sem payload promovido, bloqueie orientando rodar o squad ' +
      'Planejamento & PRD.\n' +
      '2. **SM prepara**: o SM transforma a story num pacote de ' +
      'implementação autossuficiente no formato stories/story-template.md ' +
      'da skill bmad-templates — Dev Notes com arquivos/padrões REAIS do ' +
      'código, tasks, critérios de aceite — e valida com ' +
      'stories/story-checklist.md ANTES de entregar ao Dev.\n' +
      '3. **Dev implementa**: executa as tasks com testes, mantendo File ' +
      'List e Dev Agent Record da story atualizados. Escopo é SÓ o da ' +
      'story — mudança fora do escopo volta como proposta, nunca como ' +
      'código.\n' +
      '4. **QA valida**: roda os testes de verdade e percorre ' +
      'implementation/dev-story-checklist.md (Definition of Done) item a ' +
      'item; reprovou, volta ao Dev citando o item exato.\n' +
      '5. **Fechamento**: com DoD verde, atualize o status na própria story ' +
      'em docs/stories/, registre no handoff e passe à próxima.\n' +
      '\n' +
      '## Regras\n' +
      '- Uma story por vez por Dev; o segundo Dev entra apenas em stories ' +
      'independentes entre si.\n' +
      '- NUNCA marque story concluída com teste falhando ou DoD incompleto.\n' +
      '- Ao final (ou ao parar), o handoff lista stories concluídas, ' +
      'reprovadas e restantes.',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', effort: 'high' },
      { id: 'sm', agentName: 'SM', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'dev-b', agentName: 'Dev B', category: 'executor', cli: 'codex', effort: 'medium' },
      { id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'codex', effort: 'medium' },
    ],
  },
  {
    // Inspired by Kimi Code subagent roles (explore / plan / coder). Governed
    // workers use the only release-qualified confined runtime (Codex); Kimi
    // itself remains available in a manual terminal without a false promise
    // of PREVC/worktree/handoff automation.
    id: 'kimi-code-cell',
    name: 'Code Cell — método Kimi',
    createdAt: SEED_TS,
    builtin: true,
    orchestratorInstructions:
      '# Code Cell — método Kimi\n' +
      'Você orquestra três papéis no método explore → plan → coder inspirado ' +
      'no Kimi Code. A autoridade da missão é do Nexus (PREVC, worktrees e ' +
      'handoffs), e nesta release os workers governados rodam no Codex builtin ' +
      'qualificado. Kimi continua disponível para exploração manual no ' +
      'Terminal, fora da execução autônoma da missão.\n' +
      '\n' +
      '## Fluxo\n' +
      '1. **Explorer** — só leitura: mapa, greps, git log/diff. Sem editar código.\n' +
      '2. **Planner** — desenha abordagem (pode escrever só plan.md / docs se a ' +
      'lane for plan). Entrega riscos, arquivos e verificação.\n' +
      '3. **Coder** — implementa no worktree; handoff com evidência real.\n' +
      'Spawne via nexus_pane_spawn com o agentName do roster; o roster Codex ' +
      'é sticky. Não substitua automaticamente esses workers por Kimi/OMP: ' +
      'essas CLIs são rotas manuais nesta release.',
    agents: [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        effort: 'high',
      },
      {
        id: 'explorer',
        agentName: 'Explorer',
        category: 'scout',
        cli: 'codex',
        effort: 'medium',
      },
      {
        id: 'planner',
        agentName: 'Planner',
        category: 'architect',
        cli: 'codex',
        effort: 'high',
      },
      {
        id: 'coder',
        agentName: 'Coder',
        category: 'executor',
        cli: 'codex',
        effort: 'medium',
      },
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
