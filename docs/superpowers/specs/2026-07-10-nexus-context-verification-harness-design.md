# Nexus Context & Verification Harness

**Data:** 2026-07-10  
**Status:** arquitetura aprovada para implementação incremental  
**Escopo:** contexto de negócio, execução autônoma, revisão real, isolamento multi-PC/multi-projeto  
**Referência analisada:** `vinilana/dotcontext@b9e29812574d7a27f9c3b89a042f8776f2c30b30`

## Decisão

O Nexus terá um harness nativo. Ele adotará os conceitos fortes do Dotcontext —
`.context`, PREVC, contratos, sensores, traces e replay — sem delegar ao
Dotcontext autoridade sobre identidade, política, evidência ou conclusão.

Dotcontext será suportado por um adapter de importação/exportação e, quando
útil, por uma fachada MCP compatível. Ele não será instalado globalmente com
`npx ...@latest` nos computadores dos usuários.

O objetivo operacional é eliminar revisão humana rotineira. Quando não existir
fonte suficiente para determinar uma regra de negócio, o comportamento correto
será bloquear a mudança como requisito não demonstrável. Autonomia não significa
inventar certeza.

## Problema real

O Nexus já executa múltiplos agentes, mas hoje grande parte da qualidade depende
de prompt:

- workers concorrentes trabalham no mesmo diretório;
- missão não congela commit, contexto ou contrato;
- handoff pode declarar que um comando passou sem o Nexus executá-lo;
- reviewer não entrega findings estruturados;
- o autor pode alterar o código depois da revisão;
- missão pode ser marcada como concluída sem relacionar critério e evidência;
- conhecimento de produto existe em `PRODUCT.md`, README e specs, mas não é
  compilado nem obrigatoriamente entregue aos agentes;
- missões, handoffs, tarefas, memória e parte da auditoria ainda são globais.

Uma skill, RAG ou memória vetorial isolada melhora recuperação, mas não resolve
autoridade, concorrência, evidência falsa ou conclusão indevida.

## O que o Nexus já possui

| Fundação | Situação | Reuso no harness |
| --- | --- | --- |
| MCP local por agente | token, allowlists e dispatch validados | transporte das operações do harness |
| Panes e CLIs | múltiplos providers e retomada de sessão | executores e revisores independentes |
| Squads | papéis de executor, QA, segurança e reviewer | catálogo inicial do Review Council |
| Missões e handoffs | persistência e entrega ao orquestrador | projeção de UX sobre contratos/eventos |
| Guardrails e confirmação | efeitos de alto impacto confirmados | policy enforcement de borda |
| Auditoria | JSONL com redaction | migrar para evidence/event ledger |
| Graphify | grafo útil no desenvolvimento local | adapter opcional de code intelligence |
| ProjectExecutionScope | projeto, checkout, instalação e raiz canônica | chave obrigatória de todo runtime |

## Lições do Dotcontext

### Preservar

- contexto versionado separado de runtime derivado;
- PREVC com escala adaptativa;
- plano estruturado derivando contrato;
- sensores e artefatos obrigatórios;
- hooks como observabilidade;
- snapshot semântico, trace, replay e dataset de falhas;
- superfícies CLI, harness e MCP desacopladas;
- projeção do mesmo conhecimento para diferentes ferramentas.

### Não portar como autoridade

Na versão auditada:

- o próprio chamador MCP pode registrar um sensor como aprovado;
- `force` atravessa gates;
- a IA pode registrar/substituir/resetar políticas;
- evidência não é obrigatoriamente vinculada ao commit ou diff;
- critérios de aceitação são armazenados, mas não executados integralmente;
- contexto `filled` pode conter fatos obsoletos;
- hooks são deliberadamente não bloqueantes;
- paths não são sempre protegidos por `realpath`;
- cache e runtime são locais e não resolvem multi-PC/concorrrência.

Referências:

- [arquitetura do Dotcontext](https://github.com/vinilana/dotcontext/blob/b9e29812574d7a27f9c3b89a042f8776f2c30b30/ARCHITECTURE.md)
- [task contracts](https://github.com/vinilana/dotcontext/blob/b9e29812574d7a27f9c3b89a042f8776f2c30b30/src/harness/application/contracts/taskContractsService.ts)
- [workflow gates](https://github.com/vinilana/dotcontext/blob/b9e29812574d7a27f9c3b89a042f8776f2c30b30/src/harness/domain/workflow/gates/gateChecker.ts)
- [sensor actions](https://github.com/vinilana/dotcontext/blob/b9e29812574d7a27f9c3b89a042f8776f2c30b30/src/harness/application/execution/actionService.ts)
- [policy service](https://github.com/vinilana/dotcontext/blob/b9e29812574d7a27f9c3b89a042f8776f2c30b30/src/harness/application/policies/policyService.ts)

## Invariantes não negociáveis

1. Nenhum efeito de agente existe sem `projectId`, `checkoutId`, `missionId` e
   `contextRevision`.
2. Path absoluto é atributo local, nunca identidade.
3. Trocar o workspace visível não altera uma execução em andamento.
4. Autor não produz nem aprova a própria evidência.
5. Policy e definição de sensor são somente leitura para agentes executores.
6. Evidência pertence exatamente a `baseSha + headSha + diffHash + contractHash
   + contextHash + sensorConfigHash`.
7. Alterar o diff invalida revisão e evidência anteriores afetadas.
8. `CRITICAL` e `HIGH` abertos bloqueiam integração.
9. Cada worker escreve em worktree/branch próprios.
10. Integração é serializada e revalidada depois de cada merge.
11. Contexto inferido nunca substitui fato declarado sem proveniência.
12. Falha da persistência crítica entra em safe/read-only mode; nunca degrada
    silenciosamente para memória.
13. Segredos, paths, sessões de provider e installation IDs não são sincronizados.
14. Não existe `force` acessível à IA.
15. Toda consulta de store exige scope por construção.

## Arquitetura alvo

```text
Nexus Core (instalação)
├── Installation Registry + Secret Broker
├── Project Runtime Manager
│   └── Project Runtime(projectId, checkoutId)
│       ├── Context Ingestor
│       ├── Truth Graph
│       ├── Context Snapshot Compiler
│       ├── Ambiguity/Contradiction Engine
│       ├── Contract Compiler + PREVC Engine
│       ├── Worktree/Integration Manager
│       ├── Sensor Broker
│       ├── Review Council
│       └── Evidence/Event Ledger
├── MCP/CLI/Hook adapters
└── Optional Sync Engine
```

### Project Runtime Manager

Mantém runtimes isolados por `projectId + checkoutId`. O workspace ativo da UI
não participa de decisões de autorização. Um runtime só é suspenso quando não
possui missão, sensor, merge ou cron ativo.

### Context Ingestor

Fontes, em ordem de autoridade:

1. regras estruturadas e ADRs versionados;
2. testes e schemas executáveis;
3. documentação versionada;
4. código e histórico Git;
5. sistemas externos explicitamente conectados;
6. inferência de IA.

Cada fato guarda fonte e validade. A ingestão não escreve fatos inferidos como
verdade. Ela cria candidatos para validação independente.

### Truth Graph

O grafo relaciona:

- personas e jornadas;
- capacidades de produto;
- entidades, estados e transições;
- regras, exceções e invariantes;
- APIs, eventos, tabelas e schemas;
- módulos, símbolos e chamadas;
- testes e sensores;
- ADRs e decisões históricas;
- incidentes, findings e regressões.

Graphify pode alimentar a camada estrutural, mas o formato canônico pertence ao
Nexus e deve funcionar sem Python/plugin global.

### Context Snapshot Compiler

Produz uma cápsula específica por tarefa, em vez de despejar toda a base no
prompt. Inclui sempre:

- objetivo e vocabulário do domínio;
- invariantes críticas;
- decisões arquiteturais aplicáveis;
- símbolos/fluxos impactados;
- casos de regressão conhecidos;
- comandos e sensores obrigatórios;
- conflitos ou lacunas ainda abertas.

O snapshot é imutável e identificado por hash. Toda sessão recebe o hash no
capability token e no contrato.

### Ambiguity/Contradiction Engine

Antes do código, compara solicitação, contexto, implementação e testes. Gera:

```ts
interface ContextConflict {
  id: string;
  kind: 'missing-source' | 'contradiction' | 'stale-reference' | 'unsafe-inference';
  severity: 'blocking' | 'warning';
  claims: string[];
  sources: ContextSourceRef[];
  affectedDomains: string[];
}
```

Um council pode resolver conflitos apenas quando existe evidência suficiente.
Conflito material sem fonte permanece bloqueante.

## Modelo de conhecimento

```ts
interface ContextFact {
  id: string;
  projectId: string;
  statement: string;
  kind: 'asserted' | 'observed' | 'inferred' | 'deprecated' | 'conflict';
  source: ContextSourceRef;
  sourceHash: string;
  commitSha?: string;
  domains: string[];
  relatedSymbols: string[];
  confidence: number;
  validFrom: string;
  validUntil?: string;
  supersedes?: string[];
}

interface ContextSourceRef {
  type: 'file' | 'git' | 'test' | 'schema' | 'connector' | 'decision';
  locator: string;
  lines?: [number, number];
}
```

Busca vetorial é índice derivado. O resultado sempre retorna as fontes; sem
fonte, não vira regra bloqueante.

Uma attestation cujo `sourceHash` mudou, mas cujo alvo ainda é byte a byte
idêntico ao hash atestado, representa drift somente da fonte e gera warning.
Alvo ausente, alterado, malformado ou sem attestation continua bloqueante; o
Doctor nunca transforma documento de contexto ausente em warning.

## Layout de projeto

```text
.nexus/
  project.json                 # identidade portátil mínima

.context/
  docs/                        # compatível com Dotcontext
    project-overview.md
    business-model.md
    domain-glossary.md
    architecture.md
    testing.md
  decisions/                   # ADRs
  plans/                       # planos portáveis aprovados
  agents/                      # playbooks sem autoridade
  skills/                      # procedimentos sem autoridade
  config/
    policy.json                # versionado e protegido por ownership
    sensors.json               # definições declarativas, sem shell livre
  nexus/
    facts/*.yaml               # fatos estruturados com proveniência
    invariants/*.yaml
    regressions/*.yaml
```

Runtime não entra no Git:

```text
<userData>/projects/<projectId>/checkouts/<checkoutId>/
  runtime.db
  index.db
  events/
  evidence/
  artifacts/
  worktrees/
```

## Contrato executável de missão

```ts
interface MissionContract {
  schemaVersion: 1;
  projectId: string;
  checkoutId: string;
  missionId: string;
  baseCommit: string;
  contextRevision: string;
  goal: string;
  nonGoals: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  businessInvariantRefs: string[];
  impactedDomains: string[];
  impactedSymbols: string[];
  requiredSensors: string[];
  requiredArtifacts: string[];
  reviewerPolicy: ReviewerPolicy;
  risk: 'low' | 'medium' | 'high' | 'critical';
  phase: 'planning' | 'review' | 'execution' | 'validation' | 'confirmation';
  contractHash: string;
}
```

O contrato nasce de uma proposta e é verificado por outro agente contra fontes.
Após congelado, alteração relevante cria nova revisão e invalida evidências.

`mission_set_status(done)` deixa de ser uma transição livre. A operação pública
vira `workflow_advance`; o runtime calcula se os pré-requisitos foram cumpridos.

## PREVC orientado por risco

| Risco | Fases mínimas | Exemplos |
| --- | --- | --- |
| low | E → V | texto, ajuste local sem comportamento |
| medium | P → E → V | feature simples e isolada |
| high | P → R → E → V → C | auth, dados, concorrência, migração, IPC |
| critical | P → R1 → R2 → E → V1 → V2 → C | billing, tenant, update, policy, secrets |

Quantidade de arquivos nunca reduz risco. Tags como auth, pagamento, RLS,
webhook, IPC, update, rede e exclusão elevam automaticamente a rota.

## Worktrees e merge queue

Cada task recebe:

```text
branch: nexus/<missionId>/<taskId>
worktree: <runtime>/worktrees/<missionId>/<taskId>
baseSha: SHA congelado da branch de integração
ownership: domínios/símbolos/arquivos previstos
```

Fluxo:

```text
contrato congelado
  → worktrees independentes
  → implementação
  → diff real calculado pelo Nexus
  → sensores no HEAD da task
  → revisão estruturada
  → merge serial na branch de integração
  → sensores novamente
  → revisão final de base...HEAD
```

Sobreposição de arquivo, símbolo ou domínio cria dependência explícita ou envia
o merge a um integrador. Nenhum worker integra diretamente.

## Sensor Broker e evidência confiável

Sensores executam em processo/utility sandboxed pelo Nexus:

- argv declarativo, sem interpolação de shell;
- cwd derivado do scope;
- ambiente mínimo e sem secrets por padrão;
- rede desabilitada por padrão;
- timeout, CPU, memória e output limitados;
- configuração assinada/hashada;
- resultado capturado pelo processo principal.

```ts
interface TrustedEvidence {
  id: string;
  producer: 'nexus';
  projectId: string;
  checkoutId: string;
  missionId: string;
  sensorId: string;
  baseSha: string;
  headSha: string;
  diffHash: string;
  contextHash: string;
  contractHash: string;
  sensorConfigHash: string;
  command: string[];
  exitCode: number;
  stdoutHash: string;
  stderrHash: string;
  startedAt: string;
  finishedAt: string;
}
```

Handoffs só referenciam evidence IDs. Um objeto `{exitCode: 0}` enviado pelo
worker não vale como evidência.

Sensores base:

- typecheck, lint, unit, integração, build e coverage;
- secret scan e dependency audit;
- schema/migration drift;
- isolamento tenant/RLS quando aplicável;
- E2E, acessibilidade e screenshot diff para UI;
- regressões ligadas às invariantes do contrato.

## Review Council

Review é uma execução independente sobre o diff e contrato congelados. Autor e
reviewer não compartilham sessão. Para risco alto, usa provider/modelo diferente.

```ts
interface ReviewFinding {
  fingerprint: string;
  reviewId: string;
  reviewerId: string;
  reviewerProvider: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'correctness' | 'business' | 'security' | 'data' | 'performance' | 'ux';
  file: string;
  line?: number;
  criterionRefs: string[];
  invariantRefs: string[];
  evidence: string;
  recommendation: string;
  status: 'open' | 'resolved' | 'accepted-risk';
  diffHash: string;
}
```

Regras:

- `critical/high` bloqueiam;
- accepted-risk é capacidade administrativa, não argumento MCP;
- divergência relevante chama adjudicador;
- correção altera diffHash, invalida review e executa sensores novamente;
- findings recorrentes viram regressões/sensores;
- o último review sempre usa o diff integrado `base...HEAD`.

## Event/Evidence Ledger

Eventos possuem sequência monotônica e hash encadeado:

```text
eventHash = sha256(previousHash + canonicalEvent)
```

O ledger registra contrato, tool effects, Git, sensores, findings, merges,
transições e atualização de contexto. Código/prompts/secrets não entram por
padrão; artefatos sensíveis têm retenção e acesso separados.

Replay usa versões imutáveis de contexto, contrato, policy e avaliadores.

## Multi-PC e sincronização

Identidades:

- `installationId`: aleatório, local, nunca fingerprint de hardware;
- `projectId`: portátil e versionado;
- `checkoutId`: clone/worktree local;
- `missionId`: pertence a projeto;
- `contextRevision`: hash do conhecimento usado;
- `worktreeId`: execução isolada.

Git é a fonte de verdade do contexto authored. Sync opcional transporta apenas
eventos/metadados permitidos, com optimistic concurrency e conflitos explícitos.

Cron compartilhado precisa de lease distribuído. Sem lease, job permanece
device-local. Dois computadores nunca executam o mesmo schedule silenciosamente.

Mover repo atualiza o registro local sem trocar checkout quando existe prova por
git-dir ou inode. Clone/worktree novo recebe checkout novo. Manifesto copiado com
origem incompatível entra em quarentena.

## Adapters e compatibilidade

```ts
interface ContextAdapter {
  detect(scope: ProjectExecutionScope): Promise<AdapterState>;
  import(scope: ProjectExecutionScope): Promise<ContextCandidate[]>;
  project(snapshot: ContextSnapshot, target: ContextTarget): Promise<Projection>;
}
```

Adapters previstos:

- Dotcontext `.context`;
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor/Windsurf;
- Graphify/code graph;
- GitHub issues/PRs;
- docs e conectores de negócio.

Projection nunca dá autoridade ao formato de destino. Skills ensinam processo;
policies e evidências continuam no Nexus.

## Plano de implementação

### P0-A — escopo e identidade (em implementação nesta mudança)

- manifesto portátil e installation ID;
- `ProjectExecutionScope` imutável no token MCP;
- filesystem, Git, editor, terminal, mídia, preview e cron presos ao scope;
- confirmação, auditoria e pane auth com projeto/checkout;
- child capabilities atenuadas;
- cron registra raiz e cwd separadamente;
- scope persistido no binding de pane para resume;
- request de orquestração expirado falha fechado.

Aceite: trocar A→B na UI não muda execução A; pane/processo/permissão B não é
acessível por A; resume não volta como `user`.

### P0-B — isolamento total dos stores

Alterar schema e APIs de:

- missions, mission_panes, handoffs, tasks, todos;
- layouts, notes, usage e gamification;
- audit/transcript/memory;
- remote bridge e browser artifacts.

Toda query recebe scope obrigatório. Remover fallback global. Persistência
crítica deixa de degradar para memória.

### P0-C — worktree e integração

Criar `src/main/runtime/worktree-manager.ts` e merge queue transacional. Capturar
base SHA, detectar dirty tree, ownership e sobreposição. Revalidar após merge.

### P1-A — contratos e PREVC

Criar `context/contract-compiler`, state machine e migrations. Corrigir a atual
menção a status `review`, inexistente no enum. Retirar conclusão livre.

### P1-B — Sensor Broker

Substituir verification artifacts autodeclarados. Começar por typecheck/test/
lint/build com hashes e utility process. Handoff referencia evidence ID.

### P2-A — contexto canônico

Ingestor, doctor, proveniência, Truth Graph, snapshot e cápsula por task. Importar
os documentos existentes do Nexus como primeiro corpus, sem marcá-los verdadeiros
apenas porque existem.

### P2-B — Review Council

Findings estruturados, independência, quorum/adjudicação e loop automático de
correção até não haver bloqueadores ou atingir budget.

### P3 — ledger, replay, regressões e sync

Event store verificável, promoção de falhas a testes, suporte multi-PC opcional,
leases e resolução explícita de conflitos.

## Testes de aceite do produto

1. Agente A continua lendo/escrevendo A após UI abrir B.
2. Mesmo `projectId`, checkouts diferentes, continuam isolados.
3. Pane retomado recupera scope/mission/role/allowlists originais.
4. `orchRequestId` expirado não cria sessão.
5. Cron A dispara com B aberto e restaura cwd interno correto.
6. Dois workers nunca compartilham worktree.
7. Diff alterado após sensor invalida evidence set.
8. Diff alterado após review reabre gate.
9. Autor não consegue registrar sensor verde nem mudar policy.
10. `critical/high` impede confirmação.
11. Critério sem evidência impede confirmação.
12. Invariante contraditória impede execução antes do código.
13. Contexto obsoleto por símbolo removido é marcado stale/conflict.
14. Projeto clonado em outro PC mantém projectId e recebe checkoutId novo.
15. Missões/memória/bridge nunca aparecem em outro projeto.
16. Falha de DB crítico entra em safe mode.
17. Sync concorrente produz conflito explícito, nunca last-write-wins silencioso.
18. Replay reconstrói a decisão usando os mesmos hashes e versões.

## Definition of Done

O gargalo de code review estará resolvido somente quando uma feature puder sair
de solicitação para integração sem intervenção rotineira e o Nexus demonstrar:

- qual verdade de negócio foi usada e de onde veio;
- qual contrato foi congelado;
- qual diff foi produzido em qual worktree;
- quais sensores o Nexus realmente executou;
- quem revisou e com qual versão do diff;
- como cada finding foi resolvido;
- que o diff integrado é exatamente o validado;
- que nenhum outro projeto/checkout participou do processo.

Até isso existir, “squad de review” continua sendo assistência inteligente, não
garantia autônoma.
