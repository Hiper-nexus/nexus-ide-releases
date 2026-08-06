import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createShutdownNoticeController } from "./app-shutdown-ui";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createDeps() {
  const dialogs: Array<ReturnType<typeof deferred<MessageBoxReturnValue>>> = [];
  const options: MessageBoxOptions[] = [];
  const showMessageBox = vi.fn((raw: MessageBoxOptions) => {
    options.push(raw);
    const dialog = deferred<MessageBoxReturnValue>();
    dialogs.push(dialog);
    return dialog.promise;
  });
  return {
    dialogs,
    options,
    deps: {
      isShutdownComplete: vi.fn(() => false),
      focusApp: vi.fn(),
      showMessageBox,
      revokeQuitAuthorization: vi.fn(),
      authorizeQuit: vi.fn(),
      requestQuit: vi.fn(),
      restartDockWatchdog: vi.fn(),
      remainingMs: vi.fn(() => 30_000),
      forceExit: vi.fn(),
      abandonQuit: vi.fn(),
    },
  };
}

describe("shutdown notice controller", () => {
  it("deduplicates a slow-shutdown notice until its native dialog settles", async () => {
    const { deps, dialogs } = createDeps();
    const controller = createShutdownNoticeController(deps);

    controller.showSlowNotice();
    controller.showSlowNotice();
    expect(deps.showMessageBox).toHaveBeenCalledOnce();

    dialogs[0]?.resolve({ response: 1, checkboxChecked: false });
    await dialogs[0]?.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.showSlowNotice();
    expect(deps.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("does not show a slow notice after shutdown already completed", () => {
    const { deps } = createDeps();
    deps.isShutdownComplete.mockReturnValue(true);
    createShutdownNoticeController(deps).showSlowNotice();
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });

  // DIRETIVA (06/08): o aviso de demora nunca é espera aberta — mostra o
  // prazo do teto e SEMPRE oferece forçar o encerramento (registro, não veto).
  it("aviso lento traz countdown e o botão de forçar encerra na hora", async () => {
    const { deps, dialogs, options } = createDeps();
    const controller = createShutdownNoticeController(deps);

    controller.showSlowNotice();
    expect(options[0]?.message).toContain("30s");
    expect(options[0]?.buttons?.[0]).toBe("Forçar encerramento agora");

    dialogs[0]?.resolve({ response: 0, checkboxChecked: false });
    await dialogs[0]?.promise;
    await Promise.resolve();
    expect(deps.forceExit).toHaveBeenCalledWith("slow-notice");
  });

  it("falha: forçar encerra, tentar de novo re-autoriza, ficar aberto é a ÚNICA revogação", async () => {
    const { deps, dialogs } = createDeps();
    const controller = createShutdownNoticeController(deps);

    controller.showFailure(new Error("physical proof pending"));
    // A intenção de sair continua de pé sob o teto: nada é revogado na entrada.
    expect(deps.revokeQuitAuthorization).not.toHaveBeenCalled();
    dialogs[0]?.resolve({ response: 0, checkboxChecked: false });
    await dialogs[0]?.promise;
    await Promise.resolve();
    expect(deps.forceExit).toHaveBeenCalledWith("failure-notice");

    controller.showFailure(new Error("retry"));
    dialogs[1]?.resolve({ response: 1, checkboxChecked: false });
    await dialogs[1]?.promise;
    await Promise.resolve();
    expect(deps.authorizeQuit).toHaveBeenCalledOnce();
    expect(deps.requestQuit).toHaveBeenCalledOnce();

    controller.showFailure(new Error("keep open"));
    dialogs[2]?.resolve({ response: 2, checkboxChecked: false });
    await dialogs[2]?.promise;
    await Promise.resolve();
    expect(deps.revokeQuitAuthorization).toHaveBeenCalledOnce();
    expect(deps.restartDockWatchdog).toHaveBeenCalledOnce();
    expect(deps.abandonQuit).toHaveBeenCalledOnce();
  });
});
