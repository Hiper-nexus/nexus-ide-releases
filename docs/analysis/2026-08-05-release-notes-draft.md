# Release notes — rascunho

> Rascunho em linguagem de usuário para a próxima release. **Não** editar o `CHANGELOG.md` real a partir daqui — este arquivo é apenas o esboço. Onde o commit ainda não fechou, o hash aparece como `<hash>`.

## 0.26.0 (rascunho) — O loop que fecha: da largura ao encerramento

Data: 2026-08-05 (rascunho)

### Missão que fecha sozinha (integridade do loop)

- **Worker que entrega, encerra.** O TTL pós-handoff passa a vir **ligado por padrão** em missões guiadas/autopiloto (com opt-out preservado para os testes E2E): um worker que terminou e entregou o resultado é encerrado e acorda o orquestrador, sem depender de flag. Antes esse fechamento vinha desligado e a missão podia ficar pendurada esperando um worker que nunca fechava.
- **A rota vira lei, não conselho.** No caminho agêntico o squad e a rota resolvidos agora **vinculam** o dispatch: o loop não consegue mais ignorar o roster salvo e cair em monocultura ou no tier errado. O `pane_spawn` respeita o roster da missão.
- **Fan-out de verdade.** O plano guiado deixa de ser "um escritor por construção": a decomposição emite propriedade **disjunta por story**, então dois ou mais workers escrevem em paralelo sem colidir, e o merge serial passa a ser uma escolha explícita — não um gargalo acidental.
- **Objetivo em linguagem natural também paraleliza.** Uma meta escrita em texto livre não é mais forçada ao executor único: ela fica elegível para uma topologia de fan-out, alcançando a mesma cadência de ≥2 escritores. _(commit `4048324e`)_
- **Fan-out largo drena até o fim.** O dreno de ondas deixa de parar em 64 e passa a fechar frentes mais largas (até as 85 stories da campanha), sem deixar uma cauda de tarefas presas depois do handoff. _(commit `a25318e2`)_
- **Revisor travado não prende mais o plano.** Uma tarefa de QA/revisão bloqueada por dependência agora tem um desfecho terminal, em vez de ficar `blocked` para sempre segurando uma missão inteira aberta. _(commit `cbed95c5`)_

### Sair do app sem travar

- **Encerramento confiável.** O comando de sair passou a ter um prazo global e um backstop de `app.exit`, e a finalização dos processos de terminal escala de forma limitada de SIGTERM para SIGKILL. Sair do app deixa de pendurar quando um processo filho demora a morrer.

### Voz

- **Ditado que chega no pane.** A entrega do ditado ao pane foi corrigida com instrumentação de confirmação: o texto ditado chega ao destino certo, com sinalização de que a entrega ocorreu. _(commit `550b135e`)_

### Squads

- **Editor de squad — primeira fatia.** A revisão do editor de squad fechou as três frentes da fatia: o seletor não desabilita mais a opção já selecionada (fim do picker morto, `c45ac046`); a trava governada de CLI+modelo virou sugestão preenchida, com qualquer provider **credenciado** selecionável e o não-credenciado ainda bloqueado por "login necessário" (`b57464c4`); e trocar modo/política deixou de reconstruir o roster em silêncio, preservando as edições não salvas do operador (`1b3577c6`). O roster editado fica travado à reserva de rota do dispatch (`bdf852ea`).

---

### Notas de engenharia (referência de hashes — não é conteúdo de usuário)

| Item | Status | Hash(es) |
|------|--------|----------|
| TTL de worker default-on (P0-1) | fechado | `568c1324` |
| Rota/squad autoritativa no agêntico (P0-2) | fechado | `492920e0` |
| Fan-out por propriedade disjunta (P0-3, seams A/B/D) | fechado | `007888ae` · `17096105` · `1c495e85` |
| Encerramento sem travar (quit-hang) | fechado | `76d405d1` · `a78dbc21` |
| Ditado entregue no pane | fechado | `550b135e` |
| Editor de squad — fatia 1 | fechado | `c45ac046` · `b57464c4` · `1b3577c6` · `bdf852ea` |
| Fan-out de meta em linguagem natural (P0-8) | fechado | `4048324e` (spike `316edbf5`) |
| Dreno de fan-out além de 64 (P0-9) | fechado | `a25318e2` |
| Terminalidade de tarefa técnica bloqueada (P0-10) | fechado | `cbed95c5` |
| Reroute antes do waiver (P0-4) | landed pré-campanha | sem commit novo — `failover.ts:493` |
| Contrato selado antes da fence (P0-5) | landed pré-campanha | `5b93ec6e` |
| Worker que nasce executando (P0-6) | fechado nesta campanha | `8aa113e2` |
| Freeze C4 greenfield (P0-7) | landed pré-campanha | sem commit novo — `inspectContextReadiness` |

Detalhe técnico completo e proveniência em `docs/analysis/2026-08-05-overclock-parity-gap.md` (§(a) mecanismos, §(d) ledger de status).
