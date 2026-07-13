# Auditoria sênior — Overclock, ORCA e Nexus

**Data:** 2026-07-13  
**Escopo:** Harness/enriquecimento, Recipes, MCP, Jarvis, ClockVoice e cruzamento com ORCA  
**Instalação analisada:** Overclock 1.1.0 em `/Applications/Overclock.app`

## Executive Summary

O conceito de uma página Harness faz sentido para o Nexus, mas a implementação do
Overclock não deve ser copiada como arquitetura. Ela é boa como embalagem de
produto: reúne inventário, enriquecimento e recipes em uma superfície compreensível.
O Nexus já possuía os componentes técnicos mais fortes — descoberta real de agents e
skills, enriquecimento com fallback, recipes validadas, Squad Architect, contratos de
contexto, PREVC, evidências e política de efeitos — porém estavam distribuídos.

Foi implementada uma página Harness própria, integrada às configurações do Nexus,
com inventário unificado, busca, filtros, origem real, cobertura de enriquecimento,
contagem MCP e acesso às recipes. Também foi adicionado `nexus_pane_whoami`, uma
ferramenta MCP de introspecção de autoridade que não expõe o bearer token.

Para voz, não há justificativa técnica para portar o núcleo de Jarvis ou ClockVoice.
O Nexus já é superior em wake word local, AEC, full duplex, barge-in, cascata de STT,
fallback de TTS, memória versionada por projeto, execução MCP segura e observabilidade.
A principal lição do concorrente é de UX: oferecer um preset explícito de “Ditado
direto”, separado visualmente da conversa com Jarvis.

ORCA e Overclock devem continuar servindo a papéis diferentes na estratégia:
ORCA é referência de robustez de infraestrutura; Overclock é referência de
empacotamento e descoberta; o Nexus deve preservar como núcleo diferencial sua
autoridade verificável, contexto, voz e orquestração segura.

## Key Findings

1. **Harness é uma boa superfície, não um novo motor.** O Nexus já tinha o motor de
   enriquecimento. A lacuna era tornar a capacidade instalada visível e operável em
   um lugar único.
2. **As três categorias fixas não devem controlar a arquitetura.** `scout`, `builder`
   e `reviewer` são úteis como facetas de busca, mas insuficientes como modelo de
   autoridade, qualidade ou execução.
3. **Nexus possui maior superfície MCP e controles mais fortes.** A build atual
   registra 109 ferramentas únicas após esta mudança. O site do Overclock anuncia
   52 e o registro local 1.1.0 contém cerca de 62 nomes. Contagem não é vantagem por
   si só; o diferencial real do Nexus é token por agente, escopo imutável de projeto,
   allowlists, política default-effectful, PREVC, confirmação e auditoria fail-closed.
4. **`pane_whoami` é uma ideia válida e foi incorporada com segurança.** O agente
   agora consegue saber sua identidade e seus grants efetivos sem receber segredo.
5. **Jarvis/ClockVoice não justificam transplante.** A pilha do Nexus é mais completa.
   O que vale absorver é a clareza do modo de ditado e a configuração orientada a
   intenção, não o motor.
6. **Memória genérica compartilhada é um risco.** O OverMemory é simples de explicar,
   mas copiar uma memória textual global enfraqueceria isolamento e proveniência. A
   memória estruturada e project-scoped do Nexus deve permanecer canônica.

## Detailed Analysis

### Matriz estratégica

| Dimensão | Overclock 1.1.0 | ORCA | Nexus |
|---|---|---|---|
| Força principal | Descoberta e embalagem do produto | Robustez de terminal, worktree e integração remota | Contexto verificável, autoridade, voz e orquestração |
| Harness | Página clara, enriquecimento e recipes | Não é o foco | Motor mais profundo; agora também possui superfície unificada |
| MCP | Amplo e simples de usar | Integração de infraestrutura | Mais amplo e com política de segurança/effects mais madura |
| Voz | Jarvis + ClockVoice bem separados na UX | Fora do núcleo | Stack mais completa e segura; precisa simplificar descoberta |
| Memória | Persistência genérica fácil de entender | Infra/estado | Estruturada, versionada e isolada por projeto |
| Melhor uso como referência | UX e posicionamento | Confiabilidade operacional | Produto-alvo e arquitetura canônica |

### Harness e enriquecimento

O Overclock apresenta Arsenal e Receitas juntos, com busca, contagem, filtros de rank,
tier e origem, e uma ação de enriquecimento. Internamente, seu catálogo enriquecido
usa três tiers e armazena descrições de quando usar cada item. Recipes referenciam
agents, skills, modelo, tools, artefatos produzidos, paralelismo e gaps.

O Nexus já fazia trabalho adicional antes desta auditoria:

- descobre agents e skills realmente instalados em múltiplas CLIs;
- enriquece nomes exatos usando uma cadeia de providers, retry por chunk e fallback
  determinístico;
- remove entradas obsoletas e persiste de forma atômica;
- valida recipes contra tools/skills reais e exige gaps explícitos;
- alimenta o Squad Architect e contratos de execução.

Decisão: manter tiers como metadado pesquisável e não como autorização. A nova tela
mostra origem real por ecossistema (`Claude`, `Codex`, `Agents`, `Gemini`, `Kimi`,
`Grok`, `Nexus` ou `Local`) em vez de um badge ambíguo “próprio/terceiro”.

### MCP

O Overclock local oferece operações de panes, handoffs, missions, squads, catálogo,
recipes, stacks, cron, memória, observação do app, screenshots, eventos, mídia e
marketplace. O escopo de pane pode aceitar metadados do chamador e flags explícitas
para cruzar fronteiras. Não foi identificado no registro local um wrapper genérico
equivalente ao conjunto do Nexus de token bound a role, allowlist, effect policy,
PREVC, confirmação e auditoria fail-closed.

O Nexus trata ferramentas novas como effectful por padrão, salvo classificação
explícita. Isso reduz o risco de uma ferramenta recém-adicionada escapar de controles.
`nexus_pane_whoami` foi classificada como read-only e devolve apenas:

- identidade lógica, role, sessão, missão e revisão de contexto;
- provider/agent e flag read-only;
- escopo imutável e raiz de execução;
- grants de tools e skills.

O token de autenticação é deliberadamente omitido e coberto por teste.

### Jarvis e ClockVoice

ClockVoice oferece uma separação simples entre push-to-talk e conversa, STT local via
whisper.cpp ou remoto, atalho hold/toggle, idioma, prompt e modos de interação.
Jarvis usa áudio em tempo real, memória persistente, wake lock, contexto da tela e da
missão, detecção de perguntas pendentes, menus falados e reaproveitamento de sessão.

O Nexus já cobre e amplia essas capacidades:

- openWakeWord/ONNX local e gates multi-head;
- wake lock local, AEC nativo/WASM/Chromium, full duplex e barge-in;
- Gemini Live, OpenAI Realtime e fallback Classic;
- STT Groq → OpenAI → whisper local;
- TTS OpenAI → Piper → `say` do macOS;
- VAD, supressão de eco, filtros de transcript e observabilidade;
- memória versionada por projeto;
- dispatch MCP com escopo e política de efeitos;
- atalhos hold/toggle e roteamento para Jarvis, pane focado, orquestrador ou ask.

Decisão: não copiar o core do concorrente. Próximo ganho recomendado: preset de UX
“Ditado direto” que configure automaticamente push-to-talk, destino no pane focado,
sem resposta falada e comportamento de inserção previsível.

### ORCA

A estratégia existente de selective harvest permanece correta. ORCA deve ser usado
como referência para robustez de terminal, remoção segura de worktrees, recuperação
de crash, SSH/remoto, integração com forges e cross-platform. Não deve virar o modelo
de Harness, memória ou autoridade do Nexus.

As análises anteriores de 10 e 11 de julho registram como áreas a revalidar: instalação
gerenciada de hooks, persistência quando child process/GPU desaparece, APIs de forge,
produção SSH/FS/Git/PTY e protocolo mobile. Como a árvore de trabalho atual contém
evoluções posteriores, esses itens são backlog de revalidação e não afirmações de
paridade atual.

## Changes Implemented

1. **Harness first-class nas configurações**
   - inventário agregado de agents e skills;
   - busca por nome, tier, descrição e “quando usar”;
   - filtros por tipo, tier e origem real;
   - métricas de agents, skills, tools MCP e cobertura;
   - ação de enriquecimento e aba de recipes.
2. **`nexus_pane_whoami`**
   - introspecção MCP da autoridade efetiva;
   - política read-only explícita;
   - nenhum token ou segredo na resposta.
3. **Testes focados**
   - view-model e filtros do Harness;
   - navegação das configurações;
   - identidade/autoridade MCP e ausência de token;
   - regressões de scope, effect policy, sync e estilos.

## Contrarian Views and Risks

- **“Mais ferramentas MCP = produto melhor.”** Falso. Superfície grande aumenta
  descoberta e também risco, colisão semântica e custo de manutenção. O Nexus deve
  medir sucesso de tool calling, taxa de confirmação, reversibilidade e auditoria.
- **“Tier deve selecionar automaticamente qualquer capacidade.”** Só se inventory,
  contratos e autoridade coincidirem. Um tier sem evidência não deve conceder tools.
- **“Memória global torna Jarvis mais inteligente.”** Também torna vazamento entre
  projetos e contaminação por fatos obsoletos mais prováveis.
- **“Copiar o core de voz reduz tempo.”** Aumentaria duplicidade e regrediria AEC,
  fallback, segurança e observabilidade já existentes.
- **Risco de UX do novo Harness.** Ele pode virar apenas mais um catálogo se não for
  ligado progressivamente ao planejamento de missão e aos sinais reais de qualidade.

## Prioritized Roadmap

### P0 — concluído nesta auditoria

- tornar Harness uma superfície de primeira classe;
- acrescentar introspecção MCP segura;
- preservar tiers como metadado, não autoridade.

### P1 — alto retorno

- criar preset “Ditado direto” no Voice Lab;
- exibir no Harness compatibilidade real de cada recipe e gaps bloqueantes;
- conectar cards do Harness ao Squad Architect com preview do contrato;
- mostrar saúde por capacidade: últimas execuções, falhas e evidências.

### P2 — diferenciação

- recomendação de recipe baseada em missão com explicação e confidence;
- benchmark interno por capacidade/modelo/effort, sem ranking meramente cosmético;
- revalidar lacunas ORCA contra a árvore atual e importar somente primitives robustas.

### Não fazer

- não copiar memória textual global;
- não usar `scout/builder/reviewer` como ACL;
- não duplicar o motor de Jarvis/ClockVoice;
- não priorizar contagem bruta de MCP sobre segurança e taxa de sucesso.

## Open Questions

1. O preset “Ditado direto” deve apenas preencher o pane focado ou também executar
   automaticamente o envio? A opção segura é preencher e exigir confirmação.
2. A recomendação automática de recipe deve ser informativa ou poderá iniciar uma
   squad? Recomendação pode ser automática; execução deve respeitar PREVC/confirm.
3. Quais sinais formarão a saúde de uma capability: sucesso, custo, latência,
   evidência produzida e taxa de intervenção humana?

## Evidence and Sources

### Artefatos locais

- `/Applications/Overclock.app/Contents/Resources/sidecar/node_modules/@overclock-app`
- `/Applications/Overclock.app/Contents/Resources/sidecar/dist`
- `/Users/cleofaspereirarocha/.overclock-app/harness-enriched-catalog.json`
- `src/main/orch/harness-enrich.ts`
- `src/main/orch/catalog-overlay.ts`
- `src/main/orch/recipe-overlay.ts`
- `src/main/orch/squad-architect.ts`
- `src/main/orch/mcp-effect-policy.ts`
- `docs/analysis/2026-07-10-nexus-orca-integration-map.md`
- `docs/analysis/2026-07-11-orca-parity-remaining-goal.md`

### Fontes oficiais

- [Overclock — Harness](https://overclock.sh/features/harness)
- [Overclock — MCP](https://overclock.sh/features/mcp)
- [Overclock — Recipes](https://overclock.sh/features/receitas)
- [Overclock — Jarvis](https://overclock.sh/features/jarvis)
- [Overclock — ClockVoice](https://overclock.sh/features/clockvoice)
- [Overclock — OverMemory](https://overclock.sh/features/overmemory)
- [Overclock — integrações](https://overclock.sh/integracoes)
- [Releases oficiais](https://github.com/ustoppble/overclock-releases/releases)

## Rerun Inputs

```yaml
workflow: firecrawl-deep-research
topic: >-
  Comparar Overclock 1.1.0, ORCA e Nexus em Harness/enrichment, Recipes, MCP,
  Jarvis, ClockVoice, memória, autoridade e segurança; recomendar o que absorver,
  rejeitar ou superar.
depth: thorough
output_format: markdown
local_artifacts:
  - /Applications/Overclock.app
  - /Users/cleofaspereirarocha/.overclock-app
  - /Users/cleofaspereirarocha/nexus-ide
```
