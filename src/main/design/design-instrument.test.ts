import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSource,
  createDesignInstrumentation,
  instrumentSource,
} from "./design-instrument";

function idFactory(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `id${sequence}`;
  };
}

const APP = `export function App() {
  return (
    <main className="p-4">
      <h1>Painel</h1>
      <Card title="a" />
    </main>
  );
}
`;

describe("instrumentSource / cleanupSource", () => {
  it("tags every JSX element with an ephemeral id and indexes file:line", () => {
    const result = instrumentSource(APP, idFactory());
    expect(result.changed).toBe(true);
    expect(result.code).toContain('<main data-nexus-id="id1" className="p-4">');
    expect(result.code).toContain('<h1 data-nexus-id="id2">Painel</h1>');
    expect(result.code).toContain('<Card data-nexus-id="id3" title="a" />');
    expect(result.entries).toEqual([
      { id: "id1", line: 3, column: 4, tagName: "main" },
      { id: "id2", line: 4, column: 6, tagName: "h1" },
      { id: "id3", line: 5, column: 6, tagName: "Card" },
    ]);
  });

  it("preserves existing ids (idempotent) and cleanup restores the original bytes", () => {
    const first = instrumentSource(APP, idFactory());
    const second = instrumentSource(first.code, idFactory());
    expect(second.changed).toBe(false);
    expect(second.code).toBe(first.code);
    // The non-negotiable contract: nothing persists in the user's code.
    expect(cleanupSource(first.code, first.insertedIds)).toBe(APP);
  });

  it("removes only ids inserted by Nexus and preserves user-owned attributes byte-for-byte", () => {
    const original =
      '<main data-nexus-id="user-owned"><span>ok</span><aside data-nexus-id="also-user-owned" /></main>\n';

    const result = instrumentSource(original, idFactory());

    expect(result.insertedIds).toEqual(["id1"]);
    expect(result.code).toContain('<main data-nexus-id="user-owned">');
    expect(result.code).toContain('<span data-nexus-id="id1">');
    expect(result.code).toContain('<aside data-nexus-id="also-user-owned" />');
    expect(cleanupSource(result.code, result.insertedIds)).toBe(original);
  });

  it("does not claim or remove a user id when the id factory collides with it", () => {
    const original = '<main data-nexus-id="id1"><span>ok</span></main>\n';
    const result = instrumentSource(original, idFactory());

    expect(result.insertedIds).toEqual(["id2"]);
    expect(result.code).toContain('<main data-nexus-id="id1">');
    expect(result.code).toContain('<span data-nexus-id="id2">');
    expect(cleanupSource(result.code, result.insertedIds)).toBe(original);
  });

  it("leaves the source untouched when the factory cannot produce an unowned id", () => {
    const original = '<main data-nexus-id="reserved"><span>ok</span></main>\n';
    let calls = 0;
    const result = instrumentSource(original, () => {
      calls += 1;
      if (calls > 100) throw new Error("id factory was called without a bound");
      return "reserved";
    });

    expect(result).toMatchObject({
      code: original,
      insertedIds: [],
      changed: false,
    });
    expect(calls).toBe(100);
  });

  it("fails closed when cleanup has no session ownership record", () => {
    const source = '<main data-nexus-id="unknown-owner" />\n';
    expect(cleanupSource(source)).toBe(source);
  });

  it("returns the source untouched on syntax errors (never break the project)", () => {
    const broken = "export const x = <div;;;\n";
    const result = instrumentSource(broken, idFactory());
    expect(result.changed).toBe(false);
    expect(result.code).toBe(broken);
    expect(cleanupSource(broken)).toBe(broken);
  });

  it("does not issue runtime-duplicate ids inside array map templates", () => {
    const source = `export const List = ({ items }) => (
  <section>
    {items.map((item) => <article><span>{item.name}</span></article>)}
  </section>
);
`;

    const result = instrumentSource(source, idFactory());

    expect(result.insertedIds).toEqual(["id1"]);
    expect(result.code).toContain('<section data-nexus-id="id1">');
    expect(result.code).toContain("<article><span>");
    expect(result.entries).toEqual([
      { id: "id1", line: 2, column: 2, tagName: "section" },
    ]);
  });

  it("leaves a file containing only dynamic array JSX untouched", () => {
    const source =
      "export const rows = items.flatMap((item) => [<Row value={item} />]);\n";
    expect(instrumentSource(source, idFactory())).toEqual({
      code: source,
      entries: [],
      insertedIds: [],
      changed: false,
    });
  });
});

describe("createDesignInstrumentation", () => {
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-instrument-"));
    fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "App.jsx"), APP);
    fs.writeFileSync(
      path.join(root, "src", "components", "Card.tsx"),
      "export const Card = ({ title }: { title: string }) => <article>{title}</article>;\n",
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "lib", "X.jsx"),
      "export const X = () => <div/>;\n",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("instruments the tree, indexes ids, and stop() restores every byte", async () => {
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });
    const summary = await instrumentation.start();
    expect(summary.files).toBe(2);
    expect(summary.elements).toBe(4);

    const appCode = fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8");
    expect(appCode).toContain("data-nexus-id");
    // node_modules is never touched.
    expect(
      fs.readFileSync(path.join(root, "node_modules", "lib", "X.jsx"), "utf8"),
    ).not.toContain("data-nexus-id");

    const entry = instrumentation.lookup("id1");
    expect(entry).toMatchObject({
      file: path.join("src", "App.jsx"),
      line: 3,
      tagName: "main",
    });

    await instrumentation.stop();
    expect(fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8")).toBe(
      APP,
    );
    expect(instrumentation.lookup("id1")).toBeNull();
  });

  it("never traverses tool metadata or nested git worktrees", async () => {
    const nestedRoot = path.join(root, ".claude", "worktrees", "other");
    const nestedSource = path.join(nestedRoot, "src", "Foreign.jsx");
    const foreignOriginal = "export const Foreign = () => <aside />;\n";
    fs.mkdirSync(path.dirname(nestedSource), { recursive: true });
    fs.writeFileSync(path.join(nestedRoot, ".git"), "gitdir: /tmp/foreign\n");
    fs.writeFileSync(nestedSource, foreignOriginal);
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });

    const summary = await instrumentation.start();

    expect(summary.files).toBe(2);
    expect(fs.readFileSync(nestedSource, "utf8")).toBe(foreignOriginal);
    await instrumentation.stop();
    expect(fs.readFileSync(nestedSource, "utf8")).toBe(foreignOriginal);
  });

  it("persists recoverable ownership before committing ids into source", async () => {
    const originalRename = fs.promises.rename.bind(fs.promises);
    let observedLedgerBeforeSourceCommit = false;
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        if (path.basename(from.toString()).includes(".nexus-instrument-")) {
          const ledgerDir = path.join(root, ".nexus", "design-instrumentation");
          const ledgers = fs.readdirSync(ledgerDir);
          expect(ledgers).toHaveLength(1);
          const ledger = JSON.parse(
            fs.readFileSync(path.join(ledgerDir, ledgers[0]), "utf8"),
          ) as { files: Record<string, string[]> };
          expect(ledger.files[path.join("src", "App.jsx")]).toEqual([
            "id1",
            "id2",
            "id3",
          ]);
          observedLedgerBeforeSourceCommit = true;
        }
        await originalRename(from, to);
      });
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
      sessionId: "11111111-1111-4111-8111-111111111111",
    });

    await instrumentation.start();

    expect(observedLedgerBeforeSourceCommit).toBe(true);
    renameSpy.mockRestore();
    await instrumentation.stop();
  });

  it("fsyncs instrumented source temp bytes before atomic rename", async () => {
    const originalOpen = fs.promises.open.bind(fs.promises);
    let sourceTempSynced = false;
    const openSpy = vi
      .spyOn(fs.promises, "open")
      .mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (path.basename(file.toString()).includes(".nexus-instrument-")) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            sourceTempSynced = true;
            await originalSync();
          };
        }
        return handle;
      });
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });

    await instrumentation.start();

    expect(sourceTempSynced).toBe(true);
    openSpy.mockRestore();
    await instrumentation.stop();
  });

  it("recovers a stale crash ledger, removes only owned ids, and preserves user ids", async () => {
    const appPath = path.join(root, "src", "App.jsx");
    const original =
      'export const App = () => <main data-nexus-id="user-owned"><span /></main>;\n';
    fs.writeFileSync(
      appPath,
      original.replace("<span />", '<span data-nexus-id="stale-owned" />'),
    );
    const ledgerDir = path.join(root, ".nexus", "design-instrumentation");
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(
      path.join(ledgerDir, "22222222-2222-4222-8222-222222222222.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "22222222-2222-4222-8222-222222222222",
        files: { [path.join("src", "App.jsx")]: ["stale-owned"] },
      }),
    );
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
      sessionId: "33333333-3333-4333-8333-333333333333",
    });

    await instrumentation.start();

    const activeSource = fs.readFileSync(appPath, "utf8");
    expect(activeSource).toContain('data-nexus-id="user-owned"');
    expect(activeSource).not.toContain('data-nexus-id="stale-owned"');
    expect(
      fs.existsSync(
        path.join(ledgerDir, "22222222-2222-4222-8222-222222222222.json"),
      ),
    ).toBe(false);
    await instrumentation.stop();
    expect(fs.readFileSync(appPath, "utf8")).toBe(original);
  });

  it("retains failed cleanup ownership and active state so stop can retry", async () => {
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
      sessionId: "44444444-4444-4444-8444-444444444444",
    });
    await instrumentation.start();
    const originalRename = fs.promises.rename.bind(fs.promises);
    let failedOnce = false;
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        if (
          !failedOnce &&
          path.basename(from.toString()).includes(".nexus-deinstrument-") &&
          to.toString().endsWith(path.join("components", "Card.tsx"))
        ) {
          failedOnce = true;
          throw new Error("cleanup commit failed");
        }
        await originalRename(from, to);
      });

    await expect(instrumentation.stop()).rejects.toThrow(
      /cleanup commit failed/,
    );

    expect(instrumentation.active).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8")).toBe(
      APP,
    );
    expect(
      fs.readFileSync(path.join(root, "src", "components", "Card.tsx"), "utf8"),
    ).toContain("data-nexus-id");
    const ledgerPath = path.join(
      root,
      ".nexus",
      "design-instrumentation",
      "44444444-4444-4444-8444-444444444444.json",
    );
    const pending = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      files: Record<string, string[]>;
    };
    expect(Object.keys(pending.files)).toEqual([
      path.join("src", "components", "Card.tsx"),
    ]);

    renameSpy.mockRestore();
    await instrumentation.stop();
    expect(instrumentation.active).toBe(false);
    expect(fs.existsSync(ledgerPath)).toBe(false);
    expect(
      fs.readFileSync(path.join(root, "src", "components", "Card.tsx"), "utf8"),
    ).not.toContain("data-nexus-id");
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when the ledger directory is a symlink",
    async () => {
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-ledger-outside-"),
      );
      try {
        fs.mkdirSync(path.join(root, ".nexus"), { recursive: true });
        fs.symlinkSync(
          outside,
          path.join(root, ".nexus", "design-instrumentation"),
        );
        const instrumentation = createDesignInstrumentation(root, {
          idFactory: idFactory(),
        });

        await expect(instrumentation.start()).rejects.toThrow(/symlink/i);
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8")).toBe(
          APP,
        );
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("anti-echo: recognizes its own writes by content hash", async () => {
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });
    await instrumentation.start();
    const relPath = path.join("src", "App.jsx");
    const written = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(instrumentation.isSelfWrite(relPath, written)).toBe(true);
    expect(
      instrumentation.isSelfWrite(relPath, written + "\n// user edit"),
    ).toBe(false);
    // Write-back edits register through the same anti-echo bookkeeping.
    instrumentation.noteSelfWrite(relPath, written + "\n// action edit");
    expect(
      instrumentation.isSelfWrite(relPath, written + "\n// action edit"),
    ).toBe(true);
    await instrumentation.stop();
  });

  it("refreshFile re-instruments an externally edited file and updates the index", async () => {
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });
    await instrumentation.start();
    const relPath = path.join("src", "App.jsx");
    // Agent/HMR rewrote the file WITHOUT ids (e.g. new element added).
    fs.writeFileSync(
      path.join(root, relPath),
      APP.replace("<h1>Painel</h1>", "<h1>Painel</h1>\n      <p>novo</p>"),
    );
    await instrumentation.refreshFile(relPath);
    const refreshed = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(refreshed).toContain("<p data-nexus-id=");
    // Every id in the refreshed file resolves through the index.
    const ids = [...refreshed.matchAll(/data-nexus-id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(ids.length).toBe(4);
    for (const id of ids) {
      expect(instrumentation.lookup(id)?.file).toBe(relPath);
    }
    await instrumentation.stop();
    expect(fs.readFileSync(path.join(root, relPath), "utf8")).not.toContain(
      "data-nexus-id",
    );
  });

  it("tracks owned ids across refresh and preserves mixed user attributes on stop", async () => {
    const relPath = path.join("src", "App.jsx");
    const original = `export const App = () => (
  <main data-nexus-id="user-main">
    <span>before</span>
  </main>
);
`;
    fs.writeFileSync(path.join(root, relPath), original);
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });
    await instrumentation.start();

    const instrumented = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(instrumented).toContain('<main data-nexus-id="user-main">');
    expect(instrumented).toContain('<span data-nexus-id="id1">');

    const externallyEdited = instrumented.replace(
      '    <span data-nexus-id="id1">before</span>',
      '    <span data-nexus-id="id1">before</span>\n    <aside>after</aside>',
    );
    fs.writeFileSync(path.join(root, relPath), externallyEdited);
    await instrumentation.refreshFile(relPath);

    await instrumentation.stop();
    expect(fs.readFileSync(path.join(root, relPath), "utf8")).toBe(
      original.replace(
        "    <span>before</span>",
        "    <span>before</span>\n    <aside>after</aside>",
      ),
    );
  });

  it("fails closed before writing when user-owned ids collide across files", async () => {
    const appPath = path.join(root, "src", "App.jsx");
    const cardPath = path.join(root, "src", "components", "Card.tsx");
    const appOriginal =
      'export const App = () => <main data-nexus-id="shared-user-id" />;\n';
    const cardOriginal =
      'export const Card = () => <article data-nexus-id="shared-user-id" />;\n';
    fs.writeFileSync(appPath, appOriginal);
    fs.writeFileSync(cardPath, cardOriginal);
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });

    await expect(instrumentation.start()).rejects.toThrow(
      /duplicate data-nexus-id/i,
    );

    expect(fs.readFileSync(appPath, "utf8")).toBe(appOriginal);
    expect(fs.readFileSync(cardPath, "utf8")).toBe(cardOriginal);
    expect(instrumentation.active).toBe(false);
    expect(instrumentation.lookup("shared-user-id")).toBeNull();
  });

  it("quarantines the index when refresh introduces a cross-file id collision", async () => {
    const appPath = path.join(root, "src", "App.jsx");
    const cardPath = path.join(root, "src", "components", "Card.tsx");
    fs.writeFileSync(
      appPath,
      'export const App = () => <main data-nexus-id="user-app"><span /></main>;\n',
    );
    fs.writeFileSync(
      cardPath,
      'export const Card = () => <article data-nexus-id="user-card" />;\n',
    );
    const instrumentation = createDesignInstrumentation(root, {
      idFactory: idFactory(),
    });
    await instrumentation.start();
    expect(instrumentation.lookup("user-app")?.file).toBe(
      path.join("src", "App.jsx"),
    );

    const externallyEdited = fs
      .readFileSync(cardPath, "utf8")
      .replace('data-nexus-id="user-card"', 'data-nexus-id="user-app"');
    fs.writeFileSync(cardPath, externallyEdited);

    await expect(
      instrumentation.refreshFile(path.join("src", "components", "Card.tsx")),
    ).rejects.toThrow(/duplicate data-nexus-id/i);
    expect(instrumentation.lookup("user-app")).toBeNull();
    expect(instrumentation.lookup("user-card")).toBeNull();

    await instrumentation.stop();
    expect(fs.readFileSync(appPath, "utf8")).toContain(
      'data-nexus-id="user-app"',
    );
    expect(fs.readFileSync(cardPath, "utf8")).toContain(
      'data-nexus-id="user-app"',
    );
  });
});
