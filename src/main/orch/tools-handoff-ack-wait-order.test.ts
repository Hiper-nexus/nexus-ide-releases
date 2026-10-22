import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F-1636 (3ª revisão do Codex no PR 159): a espera pelo ACK tem de ser armada
 * ANTES de a entrega ficar visível ao Maestro.
 *
 * Armada depois havia uma janela de corrida: `onHandoffSubmitted` entrega ao
 * Maestro, o `collectFilesModified` adiante espera, e o ACK podia chegar nesse
 * meio. `closeAfterNonSuccessHandoffAck` não achava espera nenhuma — num
 * `rework` a nota era entregue, o worker voltava a trabalhar, e só então a
 * chamada armava uma espera OBSOLETA para um handoff já consumido, que podia
 * fechar o writer no meio do trabalho.
 *
 * A invariante é de ORDEM dentro de uma função que o teste não consegue
 * exercitar isolada (ela exige missão, stores, PTY e o despachante inteiros),
 * então ela é travada no fonte — como `action-names.test.ts` já faz. Trocar a
 * ordem reprova aqui, com o motivo escrito.
 */
describe("tools-handoff: ordem de armar a espera do ACK", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "tools-handoff.ts"),
    "utf8",
  );

  it("arma a espera antes de entregar o handoff ao Maestro", () => {
    const arm = source.indexOf("scheduleAutoCloseAfterHandoff(");
    const visible = source.indexOf("onHandoffSubmitted(handoff");
    expect(arm, "chamada de scheduleAutoCloseAfterHandoff não encontrada").toBeGreaterThan(0);
    expect(visible, "chamada de onHandoffSubmitted não encontrada").toBeGreaterThan(0);
    expect(
      arm,
      "a espera do ACK está sendo armada DEPOIS de a entrega ficar visível: " +
        "um ACK de rework nesse meio não acha espera e a que for armada depois " +
        "fica obsoleta, podendo fechar o writer no meio do trabalho (F-1636)",
    ).toBeLessThan(visible);
  });

  it("armar não pode derrubar o handoff: a chamada está protegida", () => {
    const arm = source.indexOf("scheduleAutoCloseAfterHandoff(");
    const prefix = source.slice(0, arm);
    const openedTry = prefix.lastIndexOf("try {");
    const closedAfter = source.indexOf("agendar o fechamento após o handoff falhou", arm);
    expect(openedTry, "nenhum try antes da chamada").toBeGreaterThan(0);
    expect(
      closedAfter,
      "a chamada corre antes da entrega: um lançamento dela abortaria o handoff " +
        "antes de ele chegar ao Maestro, então ela precisa do catch com aviso",
    ).toBeGreaterThan(arm);
  });
});
