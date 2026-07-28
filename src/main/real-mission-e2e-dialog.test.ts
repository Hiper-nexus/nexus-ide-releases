import { dialog } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showMessageBoxSync: vi.fn(),
}));

const realMissionE2E = vi.hoisted(() => ({
  isCurrentProcessRealMissionE2E: vi.fn(() => false),
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: electron.showMessageBox,
    showMessageBoxSync: electron.showMessageBoxSync,
  },
}));

vi.mock("../shared/real-mission-e2e", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/real-mission-e2e")>()),
  isCurrentProcessRealMissionE2E: () =>
    realMissionE2E.isCurrentProcessRealMissionE2E(),
}));

import {
  installRealMissionDialogInstrumentation,
  readRealMissionApprovalDialogTiming,
  realMissionInteractionCapture,
  resetRealMissionInteractionCapture,
} from "./real-mission-e2e-lifecycle";

const approvalOptions = {
  title: "Nexus IDE — iniciar missão",
  buttons: ["Negar", "Aprovar e iniciar"],
  message: "bounded test copy",
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRealMissionInteractionCapture();
  realMissionE2E.isCurrentProcessRealMissionE2E.mockReturnValue(false);
  electron.showMessageBox.mockReset();
  electron.showMessageBoxSync.mockReset();
});

describe("real mission native approval timing instrumentation", () => {
  it("records main-owned open and acceptance times around the awaited native dialog", async () => {
    let resolveDialog:
      | ((result: { response: number }) => void)
      | undefined;
    electron.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDialog = resolve;
        }),
    );
    installRealMissionDialogInstrumentation();

    vi.setSystemTime(200);
    const result = (
      dialog.showMessageBox as unknown as (
        options: typeof approvalOptions,
      ) => Promise<{ response: number }>
    )(approvalOptions);
    expect(readRealMissionApprovalDialogTiming()).toEqual({
      openedAt: 200,
      acceptedAt: null,
    });

    vi.setSystemTime(207);
    resolveDialog?.({ response: 1 });
    await expect(result).resolves.toMatchObject({ response: 1 });
    expect(readRealMissionApprovalDialogTiming()).toEqual({
      openedAt: 200,
      acceptedAt: 207,
    });
    expect(realMissionInteractionCapture).toEqual({
      nativeDialogCount: 1,
      missionApprovalDialogCount: 1,
      missionApprovalAcceptedCount: 1,
    });
  });

  it("resets timings and never treats a denial as acceptance", () => {
    electron.showMessageBoxSync.mockReturnValueOnce(0);
    installRealMissionDialogInstrumentation();

    vi.setSystemTime(300);
    expect(
      (
        dialog.showMessageBoxSync as unknown as (
          options: typeof approvalOptions,
        ) => number
      )(approvalOptions),
    ).toBe(0);
    expect(readRealMissionApprovalDialogTiming()).toEqual({
      openedAt: 300,
      acceptedAt: null,
    });

    resetRealMissionInteractionCapture();
    expect(readRealMissionApprovalDialogTiming()).toEqual({
      openedAt: null,
      acceptedAt: null,
    });
  });

  it("auto-accepts mission approval dialogs during real-mission e2e", async () => {
    realMissionE2E.isCurrentProcessRealMissionE2E.mockReturnValue(true);
    installRealMissionDialogInstrumentation();
    vi.setSystemTime(400);
    const pending = (
      dialog.showMessageBox as unknown as (
        options: typeof approvalOptions,
      ) => Promise<{ response: number }>
    )(approvalOptions);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toMatchObject({ response: 1 });
    expect(electron.showMessageBox).not.toHaveBeenCalled();
    expect(realMissionInteractionCapture).toEqual({
      nativeDialogCount: 1,
      missionApprovalDialogCount: 1,
      missionApprovalAcceptedCount: 1,
    });
    expect(readRealMissionApprovalDialogTiming().openedAt).toBe(400);
    expect(readRealMissionApprovalDialogTiming().acceptedAt).toBe(425);
  });
});
