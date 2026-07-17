---
name: bmad-templates
description: Templates e checklists do método BMAD para planejamento e implementação disciplinados — PRD, arquitetura (spine), épicos, stories autossuficientes e Definition of Done. Use ao escrever um PRD, plano de arquitetura, épicos/stories, ao preparar uma story para implementação, ou ao validar documento/story pronto contra checklist.
license: MIT
metadata:
  upstream: bmad-code-org/bmad-method
  based_on: "src/bmm-skills (BMAD Method, MIT)"
---

# BMAD Templates

Subset curado do método BMAD (bmad-code-org/bmad-method, MIT) para uso pelos
squads de planejamento e implementação. Preencha os templates de verdade —
seção a seção, sem pular a elicitação — e valide com o checklist
correspondente ANTES de declarar o documento pronto.

## Arquivos

| Fase | Arquivo | Uso |
|---|---|---|
| PRD | `prd/prd-template.md` | Estrutura do PRD (vision, JTBD, FRs aninhados por feature, NFRs, assumptions indexadas) |
| PRD | `prd/prd-validation-checklist.md` | Gate de qualidade do PRD — rode item a item antes de aprovar |
| Arquitetura | `architecture/spine-template.md` | Espinha do documento de arquitetura ancorado no estado real |
| Épicos | `stories/epics-template.md` | Quebra do PRD em épicos com sequenciamento |
| Story | `stories/story-template.md` | Story autossuficiente (contexto, tasks, Dev Notes, File List, Dev Agent Record) |
| Story | `stories/story-checklist.md` | Valida a story ANTES de entregá-la a um dev (draft gate) |
| Implementação | `implementation/dev-story-checklist.md` | Definition of Done — valida a story implementada antes de fechá-la |

## Regras de uso

1. **Template não é sugestão de prosa** — é a estrutura do documento final.
   Substitua os `{placeholders}` e apague instruções entre colchetes.
2. **Checklist é gate, não decoração**: percorra item a item e registre o
   resultado (✓/✗/N.A. com justificativa) no fim do documento validado.
3. **Brownfield primeiro**: cada seção referencia o estado REAL do código do
   workspace; suposição que o código contradiz é defeito do documento.
4. **Stories são o contrato do dev**: uma story pronta contém tudo que um
   agente precisa para implementar SEM reler o PRD inteiro — contexto,
   critérios de aceite verificáveis, tasks, e as seções Dev Agent Record /
   File List que o implementador DEVE manter atualizadas.
