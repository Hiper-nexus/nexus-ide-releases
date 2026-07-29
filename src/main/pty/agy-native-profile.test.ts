import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveAgyNativeProfile,
  resolveNativeUserHome,
} from "./agy-native-profile";

const created: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-agy-native-profile-"),
  );
  created.push(directory);
  return fs.realpathSync.native(directory);
}

function currentUserInfo(homedir: string): { homedir: string; uid: number } {
  return { homedir, uid: os.userInfo().uid };
}

afterEach(() => {
  while (created.length > 0) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
});

describe("resolveNativeUserHome", () => {
  it("prefers the OS account home over an inherited isolated HOME", () => {
    const root = tempDirectory();
    const nativeHome = path.join(root, "native-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(nativeHome);
    fs.mkdirSync(isolatedHome);

    expect(
      resolveNativeUserHome({
        inheritedHome: isolatedHome,
        userInfo: () => currentUserInfo(nativeHome),
      }),
    ).toBe(fs.realpathSync.native(nativeHome));
  });

  it("accepts an owned fallback only when it differs from inherited HOME", () => {
    const root = tempDirectory();
    const nativeHome = path.join(root, "native-home");
    const isolatedHome = path.join(root, "isolated-home");
    fs.mkdirSync(nativeHome);
    fs.mkdirSync(isolatedHome);

    expect(
      resolveNativeUserHome({
        inheritedHome: isolatedHome,
        userInfo: () => {
          throw new Error("account database unavailable");
        },
        fallbackHome: () => nativeHome,
      }),
    ).toBe(fs.realpathSync.native(nativeHome));

    expect(() =>
      resolveNativeUserHome({
        inheritedHome: isolatedHome,
        userInfo: () => {
          throw new Error("account database unavailable");
        },
        fallbackHome: () => isolatedHome,
      }),
    ).toThrow(/cannot resolve the native OS account HOME safely/i);
  });
});

describe("resolveAgyNativeProfile", () => {
  it("returns the exact read and write grants for AGY 1.1", () => {
    const root = tempDirectory();
    const nativeHome = path.join(root, "native-home");
    const geminiHome = path.join(nativeHome, ".gemini");
    const antigravityState = path.join(geminiHome, "antigravity-cli");
    const keychains = path.join(nativeHome, "Library", "Keychains");
    fs.mkdirSync(antigravityState, { recursive: true });
    fs.mkdirSync(keychains, { recursive: true });

    expect(
      resolveAgyNativeProfile({
        inheritedHome: path.join(root, "isolated-home"),
        userInfo: () => currentUserInfo(nativeHome),
      }),
    ).toEqual({
      processHome: fs.realpathSync.native(nativeHome),
      providerStateReadPaths: [
        fs.realpathSync.native(geminiHome),
        fs.realpathSync.native(keychains),
      ],
      providerStateWritePaths: [fs.realpathSync.native(antigravityState)],
    });
  });
});
