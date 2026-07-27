import { dialog } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showMessageBoxSync: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: electron.showMessageBox,
    showMessageBoxSync: electron.showMessageBoxSync,
  },
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
});
