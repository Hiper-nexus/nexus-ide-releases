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

  // F-1636 (3ª revisão do Codex no PR 159): mover o armar para antes da entrega
  // o deixou ANTES da guarda de replay que o `onHandoffSubmitted` sempre teve.
  // Replay cujo handoff já saiu de `queued` pode estar CONSUMIDO (o Maestro
  // devolveu `rework`): armar ali espera um ACK que nunca chega e, como o armar
  // limpa a espera da sessão primeiro, apaga a espera da rodada NOVA (F-239).
  it("só arma na primeira entrega da rodada, nunca em replay já entregue", () => {
    const guard = source.indexOf("const firstDeliveryAttempt =");
    const arm = source.indexOf("scheduleAutoCloseAfterHandoff(");
    const visible = source.indexOf("onHandoffSubmitted(handoff");
    expect(guard, "a guarda de primeira entrega desapareceu").toBeGreaterThan(0);
    expect(
      source.slice(guard, arm),
      "a guarda tem de ser `!replayed || deliveryState === queued`",
    ).toContain('!replayed || handoff.deliveryState === "queued"');
    expect(guard, "a guarda precisa vir antes do armar").toBeLessThan(arm);
    expect(
      source.slice(guard, arm),
      "o armar não está sob a guarda: replay consumido instalaria espera morta",
    ).toContain("if (firstDeliveryAttempt)");
    // O MESMO nome governa a republicação: nomes separados divergem com o tempo.
    expect(
      source.slice(arm, visible + 40),
      "o onHandoffSubmitted deixou de usar a mesma guarda",
    ).toContain("const petStudioCompletion = firstDeliveryAttempt");
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
