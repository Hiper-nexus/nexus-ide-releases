# Release notes — rascunho

> Rascunho em linguagem de usuário para a próxima release. **Não** editar o `CHANGELOG.md` real a partir daqui — este arquivo é apenas o esboço. Onde o commit ainda não fechou, o hash aparece como `<hash>`.

## 0.26.0 (rascunho) — O loop que fecha: da largura ao encerramento

Data: 2026-08-05 (rascunho)

### Missão que fecha sozinha (integridade do loop)

- **Worker que entrega, encerra.** O TTL pós-handoff passa a vir **ligado por padrão** em missões guiadas/autopiloto (com opt-out preservado para os testes E2E): um worker que terminou e entregou o resultado é encerrado e acorda o orquestrador, sem depender de flag. Antes esse fechamento vinha desligado e a missão podia ficar pendurada esperando um worker que nunca fechava.
- **A rota vira lei, não conselho.** No caminho agêntico o squad e a rota resolvidos agora **vinculam** o dispatch: o loop não consegue mais ignorar o roster salvo e cair em monocultura ou no tier errado. O `pane_spawn` respeita o roster da missão.
- **Fan-out de verdade.** O plano guiado deixa de ser "um escritor por construção": a decomposição emite propriedade **disjunta por story**, então dois ou mais workers escrevem em paralelo sem colidir, e o merge serial passa a ser uma escolha explícita — não um gargalo acidental.
- **Objetivo em linguagem natural também paraleliza.** Uma meta escrita em texto livre não é mais forçada ao executor único: ela fica elegível para uma topologia de fan-out, alcançando a mesma cadência de ≥2 escritores. _(commit `<hash>`)_
- **Fan-out largo drena até o fim.** O dreno de ondas deixa de parar em 64 e passa a fechar frentes mais largas (até as 85 stories da campanha), sem deixar uma cauda de tarefas presas depois do handoff. _(commit `<hash>`)_
- **Revisor travado não prende mais o plano.** Uma tarefa de QA/revisão bloqueada por dependência agora tem um desfecho terminal, em vez de ficar `blocked` para sempre segurando uma missão inteira aberta. _(commit `<hash>`)_

### Sair do app sem travar

- **Encerramento confiável.** O comando de sair passou a ter um prazo global e um backstop de `app.exit`, e a finalização dos processos de terminal escala de forma limitada de SIGTERM para SIGKILL. Sair do app deixa de pendurar quando um processo filho demora a morrer.

### Voz

- **Ditado que chega no pane.** A entrega do ditado ao pane foi corrigida com instrumentação de confirmação: o texto ditado chega ao destino certo, com sinalização de que a entrega ocorreu. _(commit `<hash>`)_

### Squads

- **Editor de squad — primeira fatia.** Primeira parte da revisão do editor de squad: base para que a edição do roster reflita o que a missão de fato consegue usar, em vez de ser silenciosamente reescrita. As fatias seguintes (opções mortas no seletor, trava governada e reconstrução silenciosa do roster) seguem no radar.

---

### Notas de engenharia (referência de hashes — não é conteúdo de usuário)

| Item | Status | Hash(es) |
|------|--------|----------|
| TTL de worker default-on (P0-1) | fechado | `568c1324` |
| Rota/squad autoritativa no agêntico (P0-2) | fechado | `492920e0` |
| Fan-out por propriedade disjunta (P0-3, seams A/B/D) | fechado | `007888ae` · `17096105` · `1c495e85` |
| Encerramento sem travar (quit-hang) | fechado | `76d405d1` · `a78dbc21` |
| Ditado entregue no pane | pendente | `<hash>` |
| Editor de squad — fatia 1 | ver campanha | `<hash>` |
| Fan-out de meta em linguagem natural (P0-8) | pendente | `<hash>` |
| Dreno de fan-out além de 64 (P0-9) | pendente | `<hash>` |
| Terminalidade de tarefa técnica bloqueada (P0-10) | pendente | `<hash>` |

Detalhe técnico completo e proveniência em `docs/analysis/2026-08-05-overclock-parity-gap.md` (§(a) mecanismos, §(d) ledger de status).
