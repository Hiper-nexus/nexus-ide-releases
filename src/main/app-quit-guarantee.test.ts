import { describe, expect, it, vi } from "vitest";

import {
  buildFailureQuitNotice,
  buildSlowQuitNotice,
  createUnclearableQuitCeiling,
  QUIT_CEILING_MS,
  selectOrphanSupervisorPids,
} from "./app-quit-guarantee";
import { APP_SHUTDOWN_PTY_TERMINATION } from "./pty/pty-manager";

describe("teto de quit inarredável", () => {
  // TOMBSTONE (relato do dono, 06/08): o backstop de 45s era CANCELADO pelo
  // próprio caminho de erro que ele existe para cobrir — o .catch do shutdown
  // limpava o timer de app.exit e o app ficava aberto para sempre. Um backstop
  // com escotilha não é backstop: o teto dispara INDEPENDENTE do que a promise
  // de shutdown fizer, e o módulo não expõe NENHUMA API para limpá-lo.
  it("dispara mesmo com o shutdown rejeitando — nenhum catch consegue limpar", async () => {
    vi.useFakeTimers();
    const exitApp = vi.fn();
    const record = vi.fn();
    const ceiling = createUnclearableQuitCeiling({
      ceilingMs: 45_000,
      exitApp,
      record,
    });

    ceiling.arm();
    // O fluxo real: shutdown rejeita e o catch faz o que quiser — registrar,
    // abrir diálogo — mas não existe método de clear para ele chamar.
    const shutdown = Promise.reject(new Error("PTY proof failed"));
    await shutdown.catch(() => {
      const surface = ceiling as unknown as Record<string, unknown>;
      expect(surface.clear).toBeUndefined();
      expect(surface.cancel).toBeUndefined();
      expect(surface.dispose).toBeUndefined();
    });

    vi.advanceTimersByTime(44_999);
    expect(exitApp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ceiling-fired" }),
    );
    vi.useRealTimers();
  });

  it("arm é idempotente enquanto armado e o disparo é único", () => {
    vi.useFakeTimers();
    const exitApp = vi.fn();
    const ceiling = createUnclearableQuitCeiling({
      ceilingMs: 1_000,
      exitApp,
      record: () => {},
    });
    ceiling.arm();
    vi.advanceTimersByTime(600);
    ceiling.arm();
    // Re-arm durante a mesma tentativa NÃO reinicia o prazo.
    vi.advanceTimersByTime(400);
    expect(exitApp).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(exitApp).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("só a decisão explícita do operador de ficar aberto desarma — e registra", () => {
    vi.useFakeTimers();
    const exitApp = vi.fn();
    const record = vi.fn();
    const ceiling = createUnclearableQuitCeiling({
      ceilingMs: 1_000,
      exitApp,
      record,
    });
    ceiling.arm();
    ceiling.abandonQuitByUser("manter-aberto");
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "quit-abandoned-by-user" }),
    );
    vi.advanceTimersByTime(10_000);
    expect(exitApp).not.toHaveBeenCalled();
    // Uma nova intenção de sair re-arma um prazo novo.
    ceiling.arm();
    vi.advanceTimersByTime(1_000);
    expect(exitApp).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("F-240: o incidente ceiling-fired descreve a fase do shutdown em curso", () => {
    vi.useFakeTimers();
    const record = vi.fn();
    const ceiling = createUnclearableQuitCeiling({
      ceilingMs: 1_000,
      exitApp: () => {},
      record,
      describeProgress: () =>
        "fase atual=terminateAllSessions (há 3.200ms); concluídas: stopCronLoop=12ms",
    });
    ceiling.arm();
    vi.advanceTimersByTime(1_000);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ceiling-fired",
        detail:
          "quit excedeu o teto de 1000ms | fase atual=terminateAllSessions " +
          "(há 3.200ms); concluídas: stopCronLoop=12ms",
      }),
    );
    vi.useRealTimers();
  });

  it("F-240: sem describeProgress o detail do teto não muda", () => {
    vi.useFakeTimers();
    const record = vi.fn();
    const ceiling = createUnclearableQuitCeiling({
      ceilingMs: 1_000,
      exitApp: () => {},
      record,
    });
    ceiling.arm();
    vi.advanceTimersByTime(1_000);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ceiling-fired",
        detail: "quit excedeu o teto de 1000ms",
      }),
    );
    vi.useRealTimers();
  });

  it("F-240: o orçamento do PTY fica abaixo do teto do quit", () => {
    // Pior caso por sessão: term + kill (escalação) + kill de novo (lag do
    // evento de exit em drivePhysicalTermination).
    expect(
      APP_SHUTDOWN_PTY_TERMINATION.termTimeoutMs +
        APP_SHUTDOWN_PTY_TERMINATION.killTimeoutMs * 2,
    ).toBeLessThan(QUIT_CEILING_MS);
  });

  it("expõe o restante do prazo para o countdown do aviso", () => {
    vi.useFakeTimers();
    const ceiling = createUnclearableQuitCeiling({
      ceilingMs: 30_000,
      exitApp: () => {},
      record: () => {},
    });
    expect(ceiling.remainingMs()).toBeNull();
    ceiling.arm();
    vi.advanceTimersByTime(12_000);
    expect(ceiling.remainingMs()).toBe(18_000);
    vi.useRealTimers();
  });
});

describe("avisos de quit com prazo e saída", () => {
  it("aviso lento nunca é espera aberta: mostra o prazo e oferece forçar", () => {
    const notice = buildSlowQuitNotice({ remainingMs: 18_400 });
    expect(notice.message).toContain("19s");
    expect(notice.buttons[notice.forceButtonIndex]).toBe(
      "Forçar encerramento agora",
    );
    expect(notice.buttons).toContain("Continuar aguardando");
  });

  it("aviso de falha oferece forçar, tentar de novo e ficar — nessa ordem de agência", () => {
    const notice = buildFailureQuitNotice({
      error: new Error("PTY process-tree exit was not proven for: pty-1"),
      remainingMs: null,
    });
    expect(notice.buttons).toEqual([
      "Forçar encerramento agora",
      "Tentar novamente",
      "Manter o NexusIDE aberto",
    ]);
    expect(notice.detail).toContain("pty-1");
  });
});

describe("varredura de supervisores órfãos no boot", () => {
  const RESOURCES = "/Applications/NexusIDE.app/Contents/Resources";

  it("seleciona só supervisores do PRÓPRIO install", () => {
    const ps = [
      `  101     1 ${RESOURCES}/nexus-pty-supervisor __run-disclaimed`,
      `  102     1 /other/install/Resources/nexus-pty-supervisor __run-disclaimed`,
      `  103     1 /usr/bin/grep nexus-pty-supervisor`,
      `  104   400 ${RESOURCES}/nexus-pty-supervisor __run-disclaimed`,
    ].join("\n");
    expect(selectOrphanSupervisorPids(ps, RESOURCES)).toEqual([101, 104]);
  });

  it("nunca seleciona linhas que só citam o nome sem ser o binário", () => {
    const ps = `  201     1 /bin/zsh -c tail -f ${RESOURCES}/nexus-pty-supervisor.log`;
    expect(selectOrphanSupervisorPids(ps, RESOURCES)).toEqual([]);
  });
});
