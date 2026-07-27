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
  const showMessageBox = vi.fn((_options: MessageBoxOptions) => {
    const dialog = deferred<MessageBoxReturnValue>();
    dialogs.push(dialog);
    return dialog.promise;
  });
  return {
    dialogs,
    deps: {
      isShutdownComplete: vi.fn(() => false),
      focusApp: vi.fn(),
      showMessageBox,
      revokeQuitAuthorization: vi.fn(),
      authorizeQuit: vi.fn(),
      requestQuit: vi.fn(),
      restartDockWatchdog: vi.fn(),
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

    dialogs[0]?.resolve({ response: 0, checkboxChecked: false });
    await dialogs[0]?.promise;
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

  it("keeps quit revoked unless the operator explicitly retries", async () => {
    const { deps, dialogs } = createDeps();
    const controller = createShutdownNoticeController(deps);

    controller.showFailure(new Error("physical proof pending"));
    expect(deps.revokeQuitAuthorization).toHaveBeenCalledOnce();
    expect(deps.restartDockWatchdog).toHaveBeenCalledOnce();
    dialogs[0]?.resolve({ response: 0, checkboxChecked: false });
    await dialogs[0]?.promise;
    expect(deps.authorizeQuit).not.toHaveBeenCalled();

    controller.showFailure(new Error("retry"));
    dialogs[1]?.resolve({ response: 1, checkboxChecked: false });
    await dialogs[1]?.promise;
    expect(deps.authorizeQuit).toHaveBeenCalledOnce();
    expect(deps.requestQuit).toHaveBeenCalledOnce();
  });
});
