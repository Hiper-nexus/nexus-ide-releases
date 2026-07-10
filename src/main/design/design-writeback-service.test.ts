import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDesignAction,
  designWritebackStatus,
  redoDesignAction,
  startDesignWriteback,
  stopDesignWriteback,
  undoDesignAction,
} from "./design-writeback-service";

const APP = `export function App() {
  return (
    <section className="grid">
      <article className="card">Um</article>
      <article className="card">Dois</article>
    </section>
  );
}
`;

let root = "";
let additionalRoots: string[] = [];

beforeEach(() => {
  additionalRoots = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-writeback-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".nexus"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "App.jsx"), APP);
  fs.writeFileSync(
    path.join(root, ".nexus", "design.json"),
    JSON.stringify({ writeBack: { enabled: true, styleMode: "tailwind" } }),
  );
});

afterEach(async () => {
  await Promise.allSettled([
    stopDesignWriteback(),
    stopDesignWriteback("scope-a:owner-a"),
    stopDesignWriteback("scope-b:owner-b"),
  ]);
  fs.rmSync(root, { recursive: true, force: true });
  for (const extraRoot of additionalRoots) {
    fs.rmSync(extraRoot, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function appCode(): string {
  return fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8");
}

function idsInApp(): string[] {
  return [...appCode().matchAll(/data-nexus-id="([^"]+)"/g)].map((m) => m[1]);
}

describe("design write-back service", () => {
  it("refuses to start without the per-project opt-in", async () => {
    fs.rmSync(path.join(root, ".nexus", "design.json"));
    expect(designWritebackStatus(root).enabled).toBe(false);
    await expect(startDesignWriteback(root)).rejects.toThrow(/opt-in|enabled/i);
  });

  it("start instruments, style actions persist through stop, undo/redo work", async () => {
    const summary = await startDesignWriteback(root);
    expect(summary.elements).toBe(3);
    expect(designWritebackStatus(root)).toMatchObject({
      enabled: true,
      active: true,
      canUndo: false,
    });

    const [, firstCard] = idsInApp();
    const result = await applyDesignAction({
      kind: "style",
      nexusId: firstCard,
      styles: { "background-color": "#16a34a" },
    });
    expect(result.ok).toBe(true);
    expect(appCode()).toContain("bg-[#16a34a]");

    await undoDesignAction();
    expect(appCode()).not.toContain("bg-[#16a34a]");
    await redoDesignAction();
    expect(appCode()).toContain("bg-[#16a34a]");

    await stopDesignWriteback();
    const final = appCode();
    // Ephemeral ids are gone; the applied edit persists.
    expect(final).not.toContain("data-nexus-id");
    expect(final).toContain("bg-[#16a34a]");
    expect(designWritebackStatus(root).active).toBe(false);
  });

  it("move reorders without synthetic keys and undo restores exact bytes", async () => {
    await startDesignWriteback(root);
    const instrumented = appCode();
    const [, firstCard] = idsInApp();
    await applyDesignAction({
      kind: "move",
      nexusId: firstCard,
      direction: "down",
    });
    const moved = appCode();
    expect(moved.indexOf("Dois")).toBeLessThan(moved.indexOf("Um"));
    expect(moved).not.toContain('key="nx-');
    await undoDesignAction();
    expect(appCode()).toBe(instrumented);
    await redoDesignAction();
    expect(appCode()).toBe(moved);
  });

  it("text, duplicate and delete flow through with undo", async () => {
    await startDesignWriteback(root);
    const [, firstCard] = idsInApp();
    await applyDesignAction({ kind: "text", nexusId: firstCard, text: "Uno" });
    expect(appCode()).toContain("Uno");
    await applyDesignAction({ kind: "duplicate", nexusId: firstCard });
    expect(appCode().split("Uno").length - 1).toBe(2);
    // The duplicate got re-tagged by refresh: 4 unique ids now.
    expect(new Set(idsInApp()).size).toBe(4);
    await undoDesignAction();
    expect(appCode().split("Uno").length - 1).toBe(1);
  });

  it("serializes concurrent starts and leaves no orphan instrumentation", async () => {
    const secondRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-writeback-2-"),
    );
    additionalRoots.push(secondRoot);
    fs.mkdirSync(path.join(secondRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(secondRoot, ".nexus"), { recursive: true });
    fs.writeFileSync(path.join(secondRoot, "src", "App.jsx"), APP);
    fs.writeFileSync(
      path.join(secondRoot, ".nexus", "design.json"),
      JSON.stringify({ writeBack: { enabled: true, styleMode: "tailwind" } }),
    );

    await Promise.all([
      startDesignWriteback(root),
      startDesignWriteback(secondRoot),
    ]);
    await stopDesignWriteback();

    expect(appCode()).toBe(APP);
    expect(
      fs.readFileSync(path.join(secondRoot, "src", "App.jsx"), "utf8"),
    ).toBe(APP);
  });

  it("isolates simultaneous write-back sessions by project-owner key", async () => {
    const secondRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-writeback-scope-b-"),
    );
    additionalRoots.push(secondRoot);
    fs.mkdirSync(path.join(secondRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(secondRoot, ".nexus"), { recursive: true });
    fs.writeFileSync(path.join(secondRoot, "src", "App.jsx"), APP);
    fs.writeFileSync(
      path.join(secondRoot, ".nexus", "design.json"),
      JSON.stringify({ writeBack: { enabled: true, styleMode: "tailwind" } }),
    );

    await Promise.all([
      startDesignWriteback(root, "scope-a:owner-a"),
      startDesignWriteback(secondRoot, "scope-b:owner-b"),
    ]);

    expect(designWritebackStatus(root, "scope-a:owner-a").active).toBe(true);
    expect(designWritebackStatus(secondRoot, "scope-b:owner-b").active).toBe(
      true,
    );
    expect(appCode()).toContain("data-nexus-id");
    expect(
      fs.readFileSync(path.join(secondRoot, "src", "App.jsx"), "utf8"),
    ).toContain("data-nexus-id");

    await stopDesignWriteback("scope-a:owner-a");
    expect(appCode()).toBe(APP);
    expect(designWritebackStatus(root, "scope-a:owner-a").active).toBe(false);
    expect(designWritebackStatus(secondRoot, "scope-b:owner-b").active).toBe(
      true,
    );

    await stopDesignWriteback("scope-b:owner-b");
    expect(
      fs.readFileSync(path.join(secondRoot, "src", "App.jsx"), "utf8"),
    ).toBe(APP);
  });

  it("rolls back partial start when a watcher cannot be established", async () => {
    const original = APP.replace(
      '<section className="grid">',
      '<section data-nexus-id="user-owned" className="grid">',
    );
    fs.writeFileSync(path.join(root, "src", "App.jsx"), original);
    vi.spyOn(fs, "watch").mockImplementation(() => {
      throw new Error("watch unavailable");
    });

    await expect(startDesignWriteback(root)).rejects.toThrow(
      /watch unavailable/,
    );
    expect(designWritebackStatus(root).active).toBe(false);
    expect(appCode()).toBe(original);
  });

  it("rolls back files already instrumented when a later start write fails", async () => {
    const firstOriginal = APP.replace(
      '<section className="grid">',
      '<section data-nexus-id="user-owned" className="grid">',
    );
    const secondOriginal = "export const Zed = () => <aside>later</aside>;\n";
    fs.writeFileSync(path.join(root, "src", "App.jsx"), firstOriginal);
    fs.writeFileSync(path.join(root, "src", "Zed.jsx"), secondOriginal);
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    let instrumentationWrites = 0;
    vi.spyOn(fs.promises, "writeFile").mockImplementation(
      async (file, data, options) => {
        if (
          path.basename(file.toString()).includes(".nexus-instrument-") &&
          data.toString().includes("data-nexus-id")
        ) {
          instrumentationWrites += 1;
          if (instrumentationWrites === 2)
            throw new Error("second write failed");
        }
        await originalWriteFile(file, data, options);
      },
    );

    await expect(startDesignWriteback(root)).rejects.toThrow(
      /second write failed/,
    );
    expect(fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8")).toBe(
      firstOriginal,
    );
    expect(fs.readFileSync(path.join(root, "src", "Zed.jsx"), "utf8")).toBe(
      secondOriginal,
    );
  });

  it("fails closed and cleans owned ids when an active watcher errors", async () => {
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(),
    }) as unknown as fs.FSWatcher;
    vi.spyOn(fs, "watch").mockImplementation(
      (() => watcher) as typeof fs.watch,
    );
    await startDesignWriteback(root);
    expect(appCode()).toContain("data-nexus-id");

    expect(() =>
      watcher.emit("error", new Error("watcher failed")),
    ).not.toThrow();
    await vi.waitFor(() => {
      expect(designWritebackStatus(root).active).toBe(false);
    });
    expect(appCode()).toBe(APP);
    expect(watcher.close).toHaveBeenCalled();
  });

  it("fails closed when a watched file vanishes during reconciliation", async () => {
    let notify: fs.WatchListener<string> = () => {
      throw new Error("watch listener was not registered");
    };
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(),
    }) as unknown as fs.FSWatcher;
    vi.spyOn(fs, "watch").mockImplementation(((
      _filename: fs.PathLike,
      listener: fs.WatchListener<string>,
    ) => {
      notify = listener;
      return watcher;
    }) as typeof fs.watch);
    await startDesignWriteback(root);
    fs.rmSync(path.join(root, "src", "App.jsx"));

    notify("rename", "App.jsx");
    await vi.waitFor(
      () => {
        expect(designWritebackStatus(root).active).toBe(false);
      },
      { timeout: 1_000 },
    );
    expect(watcher.close).toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a file swapped to an external symlink before read/write",
    async () => {
      await startDesignWriteback(root);
      const [, firstCard] = idsInApp();
      const projectFile = path.join(root, "src", "App.jsx");
      const instrumented = appCode();
      const outsideRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-outside-"),
      );
      additionalRoots.push(outsideRoot);
      const outsideFile = path.join(outsideRoot, "Outside.jsx");
      fs.writeFileSync(outsideFile, instrumented);
      fs.rmSync(projectFile);
      fs.symlinkSync(outsideFile, projectFile);

      await expect(
        applyDesignAction({
          kind: "text",
          nexusId: firstCard,
          text: "Compromised",
        }),
      ).rejects.toThrow(/symlink|outside|containment/i);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe(instrumented);

      fs.rmSync(projectFile);
      fs.writeFileSync(projectFile, instrumented);
    },
  );

  it.skipIf(process.platform === "win32")(
    "never follows a swapped symlink while cleaning session-owned ids",
    async () => {
      await startDesignWriteback(root);
      const projectFile = path.join(root, "src", "App.jsx");
      const instrumented = appCode();
      const outsideRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-cleanup-outside-"),
      );
      additionalRoots.push(outsideRoot);
      const outsideFile = path.join(outsideRoot, "Outside.jsx");
      fs.writeFileSync(outsideFile, instrumented);
      fs.rmSync(projectFile);
      fs.symlinkSync(outsideFile, projectFile);

      await expect(stopDesignWriteback()).rejects.toThrow(
        /symlink|containment/i,
      );
      expect(fs.readFileSync(outsideFile, "utf8")).toBe(instrumented);
      expect(designWritebackStatus(root).active).toBe(true);

      fs.rmSync(projectFile);
      fs.writeFileSync(projectFile, instrumented);
      await stopDesignWriteback();
      expect(designWritebackStatus(root).active).toBe(false);
      expect(appCode()).toBe(APP);
    },
  );

  it("keeps the original file when the atomic rename fails", async () => {
    await startDesignWriteback(root);
    const [, firstCard] = idsInApp();
    const before = appCode();
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(
      new Error("atomic rename failed"),
    );

    await expect(
      applyDesignAction({ kind: "text", nexusId: firstCard, text: "Uno" }),
    ).rejects.toThrow(/atomic rename failed/);
    expect(appCode()).toBe(before);
    expect(
      fs
        .readdirSync(path.join(root, "src"))
        .filter((name) => name.includes(".nexus-writeback-")),
    ).toEqual([]);
  });

  it("fsyncs write-back temp bytes before the atomic commit", async () => {
    await startDesignWriteback(root);
    const [, firstCard] = idsInApp();
    const originalOpen = fs.promises.open.bind(fs.promises);
    let tempSynced = false;
    const openSpy = vi
      .spyOn(fs.promises, "open")
      .mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (path.basename(file.toString()).startsWith(".nexus-writeback-")) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            tempSynced = true;
            await originalSync();
          };
        }
        return handle;
      });

    await applyDesignAction({
      kind: "text",
      nexusId: firstCard,
      text: "Durable",
    });

    expect(tempSynced).toBe(true);
    openSpy.mockRestore();
  });

  it("rechecks CAS after preparing the temp file and preserves an intervening external edit", async () => {
    await startDesignWriteback(root);
    const [, firstCard] = idsInApp();
    const target = path.join(root, "src", "App.jsx");
    const external = appCode().replace("Um", "External edit");
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation(
      async (file, data, options) => {
        await originalWriteFile(file, data, options);
        if (path.basename(file.toString()).startsWith(".nexus-writeback-")) {
          fs.writeFileSync(target, external);
        }
      },
    );

    await expect(
      applyDesignAction({ kind: "text", nexusId: firstCard, text: "Uno" }),
    ).rejects.toThrow(/conflict|externally/i);
    expect(appCode()).toBe(external);
  });

  it("reattaches fs.watch after an atomic rename replaces the inode", async () => {
    const watchers: Array<fs.FSWatcher & { close: ReturnType<typeof vi.fn> }> =
      [];
    vi.spyOn(fs, "watch").mockImplementation((() => {
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(),
      }) as unknown as fs.FSWatcher & { close: ReturnType<typeof vi.fn> };
      watchers.push(watcher);
      return watcher;
    }) as typeof fs.watch);
    await startDesignWriteback(root);
    const [, firstCard] = idsInApp();

    await applyDesignAction({ kind: "text", nexusId: firstCard, text: "Uno" });

    expect(watchers).toHaveLength(2);
    expect(watchers[0].close).toHaveBeenCalled();
  });

  it("fails closed when watcher reattachment fails after an atomic commit", async () => {
    const firstWatcher = Object.assign(new EventEmitter(), {
      close: vi.fn(),
    }) as unknown as fs.FSWatcher;
    let watchCalls = 0;
    vi.spyOn(fs, "watch").mockImplementation((() => {
      watchCalls += 1;
      if (watchCalls === 1) return firstWatcher;
      throw new Error("watch reattach failed");
    }) as typeof fs.watch);
    await startDesignWriteback(root);
    const [, firstCard] = idsInApp();

    const result = await applyDesignAction({
      kind: "text",
      nexusId: firstCard,
      text: "Uno",
    });
    expect(result).toMatchObject({
      ok: true,
      maintenanceWarning: expect.stringMatching(/watch reattach failed/),
    });
    expect(designWritebackStatus(root).active).toBe(false);
    expect(appCode()).toContain("Uno");
    expect(appCode()).not.toContain("data-nexus-id");
  });

  it("fails closed when structural re-instrumentation cannot commit", async () => {
    await startDesignWriteback(root);
    const [, firstCard] = idsInApp();
    const originalRename = fs.promises.rename.bind(fs.promises);
    let rejectedRefresh = false;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (
        !rejectedRefresh &&
        path.basename(from.toString()).includes(".nexus-instrument-")
      ) {
        rejectedRefresh = true;
        throw new Error("refresh commit failed");
      }
      await originalRename(from, to);
    });

    const result = await applyDesignAction({
      kind: "duplicate",
      nexusId: firstCard,
    });
    expect(result).toMatchObject({
      ok: true,
      maintenanceWarning: expect.stringMatching(/refresh commit failed/),
    });
    expect(designWritebackStatus(root).active).toBe(false);
    expect(appCode()).not.toContain("data-nexus-id");
  });

  it("keeps a failed cleanup session active but closed until stop retry succeeds", async () => {
    await startDesignWriteback(root);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let failedOnce = false;
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        if (
          !failedOnce &&
          path.basename(from.toString()).includes(".nexus-deinstrument-")
        ) {
          failedOnce = true;
          throw new Error("cleanup retry required");
        }
        await originalRename(from, to);
      });

    await expect(stopDesignWriteback()).rejects.toThrow(
      /cleanup retry required/,
    );
    expect(designWritebackStatus(root).active).toBe(true);
    await expect(
      applyDesignAction({
        kind: "text",
        nexusId: idsInApp()[0],
        text: "must not run",
      }),
    ).rejects.toThrow(/not active/);

    renameSpy.mockRestore();
    await stopDesignWriteback();
    expect(designWritebackStatus(root).active).toBe(false);
    expect(appCode()).toBe(APP);
  });
});
