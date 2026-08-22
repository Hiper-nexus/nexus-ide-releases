---
name: superpowers
description: Fluxo Superpowers (obra/superpowers, MIT) vendorado para squads Nexus — brainstorming → writing-plans → executing-plans/subagent-driven-development, com TDD, debugging sistemático e verificação antes de concluir. Use os arquivos das subpastas conforme a etapa da missão.
---

# Superpowers (ciclo de engenharia)

Metodologia vendorada de `obra/superpowers` (ver
`third_party/provenance/superpowers.json`). Cada subpasta é uma skill oficial;
leia o `SKILL.md` da etapa ANTES de executá-la — são workflows obrigatórios,
não sugestões.

## O ciclo

1. **brainstorming/** — antes de planejar: refine a ideia por perguntas,
   explore alternativas, valide o design em seções curtas.
   `spec-document-reviewer-prompt.md` é o revisor do documento de design.
2. **writing-plans/** — com design aprovado: plano de implementação em
   tarefas pequenas (2–5 min), cada uma com caminhos de arquivo exatos,
   código completo e passo de verificação. `plan-document-reviewer-prompt.md`
   revisa o plano. OVERRIDE Nexus: a skill upstream sugere
   `docs/superpowers/plans/` — aqui NÃO. O plano final vive em
   `docs/plan.md` (a promoção lê DELE; um arquivo datado em
   docs/superpowers/plans/ é opcional e nunca substitui o plan.md) e cada
   tarefa usa heading `### Task N: título` — é esse heading que o wave-pack
   fatia em panes paralelos.
3. **executing-plans/** ou **subagent-driven-development/** — execução:
   um implementador por tarefa com revisão em dois estágios (conformidade com
   o plano, depois qualidade). No Nexus, "subagent" = pane worker da missão;
   os prompts `implementer-prompt.md` / `task-reviewer-prompt.md` /
   `re-review-prompt.md` são os moldes de dispatch e revisão.
4. **test-driven-development/** — RED-GREEN-REFACTOR durante a
   implementação; `writing-good-tests.md` é a referência de qualidade.
5. **systematic-debugging/** — qualquer bug/falha: processo de 4 fases até a
   causa raiz (root-cause-tracing, defense-in-depth, condition-based-waiting).
6. **verification-before-completion/** — antes de declarar pronto: rode o
   comando de verificação e confira a saída; evidência antes de afirmação.
7. **requesting-code-review/** + **receiving-code-review/** — revisão entre
   tarefas, por severidade; crítico bloqueia.
8. **using-git-worktrees/** + **finishing-a-development-branch/** — isolamento
   e fechamento de branch (no Nexus, o isolamento de worktree é main-owned;
   estes guiam o fluxo do agente).
9. **dispatching-parallel-agents/** — quando 2+ tarefas independentes podem
   correr em panes simultâneos.

## Regras de uso no Nexus

- O plano aprovado é o contrato: tarefa sem heading `### Task N:` não vira
  pane. Não renomeie o formato.
- TDD não é opcional em código novo: teste que falha primeiro, depois o
  mínimo que passa.
- Nenhuma entrega sem evidência: comando de verificação executado e saída
  citada no handoff.
