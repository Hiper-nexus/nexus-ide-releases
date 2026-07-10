import { describe, expect, it } from "vitest";
import type { InstrumentIndexEntry } from "./design-instrument";
import { createDesignActionSession } from "./design-actions";

const CARDS = `export function Cards() {
  return (
    <section data-nexus-id="parent1" className="grid">
      <article data-nexus-id="c1" className="pt-2 bg-red-500">Um</article>
      <article data-nexus-id="c2">Dois</article>
    </section>
  );
}
`;

const PLAIN = `export const B = () => (
  <button data-nexus-id="b1" style={{ color: '#fff' }}>Salvar</button>
);
`;

function makeSession(initialFiles: Record<string, string>) {
  const files = new Map(Object.entries(initialFiles));
  const writes: string[] = [];
  const lookup = (nexusId: string): InstrumentIndexEntry | null => {
    for (const [file, content] of files) {
      if (content.includes(`data-nexus-id="${nexusId}"`)) {
        return { id: nexusId, file, line: 1, column: 0, tagName: "x" };
      }
    }
    return null;
  };
  const session = createDesignActionSession({
    lookup,
    readFile: async (file) => {
      const content = files.get(file);
      if (content === undefined) throw new Error(`no file: ${file}`);
      return content;
    },
    writeFile: async (file, content) => {
      files.set(file, content);
      writes.push(file);
    },
  });
  return { session, files, writes };
}

describe("createDesignActionSession", () => {
  it("applies a tailwind style action, undoes byte-perfectly, redoes", async () => {
    const { session, files } = makeSession({ "Cards.jsx": CARDS });
    const result = await session.apply({
      kind: "style",
      nexusId: "c1",
      mode: "tailwind",
      styles: { "padding-top": "24px", "background-color": "#16a34a" },
    });
    expect(result.file).toBe("Cards.jsx");
    const after = files.get("Cards.jsx")!;
    // Conflicting utilities are replaced, not stacked.
    expect(after).toContain("pt-[24px]");
    expect(after).toContain("bg-[#16a34a]");
    expect(after).not.toContain("pt-2");
    expect(after).not.toContain("bg-red-500");

    expect(session.canUndo()).toBe(true);
    await session.undo();
    expect(files.get("Cards.jsx")).toBe(CARDS);
    expect(session.canRedo()).toBe(true);
    await session.redo();
    expect(files.get("Cards.jsx")).toContain("pt-[24px]");
  });

  it("applies inline style + text actions with undo", async () => {
    const { session, files } = makeSession({ "B.jsx": PLAIN });
    await session.apply({
      kind: "style",
      nexusId: "b1",
      mode: "inline",
      styles: { "background-color": "#16a34a" },
    });
    expect(files.get("B.jsx")).toContain("backgroundColor: '#16a34a'");
    await session.apply({ kind: "text", nexusId: "b1", text: "Enviar" });
    expect(files.get("B.jsx")).toContain("Enviar");
    await session.undo();
    expect(files.get("B.jsx")).toContain("Salvar");
    await session.undo();
    expect(files.get("B.jsx")).toBe(PLAIN);
  });

  it("reorder undo restores exact bytes and redo restores the deterministic move", async () => {
    const { session, files } = makeSession({ "Cards.jsx": CARDS });
    await session.apply({
      kind: "reorder",
      parentNexusId: "parent1",
      fromIndex: 0,
      toIndex: 1,
    });
    const moved = files.get("Cards.jsx")!;
    expect(moved.indexOf("Dois")).toBeLessThan(moved.indexOf("Um"));
    expect(moved).not.toContain('key="nx-');
    await session.undo();
    expect(files.get("Cards.jsx")).toBe(CARDS);
    await session.redo();
    expect(files.get("Cards.jsx")).toBe(moved);
  });

  it("delete restores on undo; duplicate deletes the copy on undo", async () => {
    const { session, files } = makeSession({ "Cards.jsx": CARDS });
    await session.apply({ kind: "delete", nexusId: "c2" });
    expect(files.get("Cards.jsx")).not.toContain("Dois");
    await session.undo();
    expect(files.get("Cards.jsx")).toContain("Dois");

    await session.apply({ kind: "duplicate", nexusId: "c1" });
    expect(files.get("Cards.jsx")!.split(">Um<").length - 1).toBe(2);
    await session.undo();
    expect(files.get("Cards.jsx")!.split(">Um<").length - 1).toBe(1);
  });

  it("delete undo restores exact bytes around expressions, comments and text", async () => {
    const source = `export const Mixed = ({ cond }) => (
  <section data-nexus-id="parent1">
    before
    <article data-nexus-id="c1">Um</article>
    {cond && <aside>Expressão</aside>}
    {/* between */}
    <article data-nexus-id="c2">Dois</article>
  </section>
);
`;
    const { session, files } = makeSession({ "Mixed.jsx": source });

    await session.apply({ kind: "delete", nexusId: "c1" });
    expect(files.get("Mixed.jsx")).not.toContain(">Um<");
    await session.undo();

    expect(files.get("Mixed.jsx")).toBe(source);
  });

  it("a fresh apply clears the redo stack; unknown ids fail", async () => {
    const { session } = makeSession({ "Cards.jsx": CARDS });
    await session.apply({ kind: "text", nexusId: "c2", text: "Zwei" });
    await session.undo();
    expect(session.canRedo()).toBe(true);
    await session.apply({ kind: "text", nexusId: "c2", text: "Two" });
    expect(session.canRedo()).toBe(false);
    await expect(
      session.apply({ kind: "text", nexusId: "ghost", text: "x" }),
    ).rejects.toThrow(/ghost/);
  });

  it("serializes concurrent read-modify-write actions without losing updates", async () => {
    let content = PLAIN;
    let releaseFirstRead!: () => void;
    let markFirstReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let isFirstRead = true;
    const session = createDesignActionSession({
      lookup: (id) =>
        id === "b1"
          ? { id, file: "B.jsx", line: 1, column: 0, tagName: "button" }
          : null,
      readFile: async () => {
        const snapshot = content;
        if (isFirstRead) {
          isFirstRead = false;
          markFirstReadStarted();
          await firstReadGate;
        }
        return snapshot;
      },
      writeFile: async (_file, next) => {
        content = next;
      },
    });

    const background = session.apply({
      kind: "style",
      nexusId: "b1",
      mode: "inline",
      styles: { "background-color": "#16a34a" },
    });
    await firstReadStarted;
    const border = session.apply({
      kind: "style",
      nexusId: "b1",
      mode: "inline",
      styles: { "border-color": "#111827" },
    });
    releaseFirstRead();
    await Promise.all([background, border]);

    expect(content).toContain("backgroundColor: '#16a34a'");
    expect(content).toContain("borderColor: '#111827'");
  });

  it("invalidates undo instead of overwriting an external edit", async () => {
    const { session, files } = makeSession({ "Cards.jsx": CARDS });
    await session.apply({ kind: "text", nexusId: "c2", text: "Two" });
    const external = files.get("Cards.jsx")!.replace("Two", "External edit");
    files.set("Cards.jsx", external);

    await expect(session.undo()).rejects.toThrow(/conflict|externally/i);
    expect(files.get("Cards.jsx")).toBe(external);
    expect(session.canUndo()).toBe(false);
    expect(session.canRedo()).toBe(false);
  });

  it("invalidates redo instead of overwriting an external edit", async () => {
    const { session, files } = makeSession({ "Cards.jsx": CARDS });
    await session.apply({ kind: "text", nexusId: "c2", text: "Two" });
    await session.undo();
    const external = files.get("Cards.jsx")!.replace("Dois", "External edit");
    files.set("Cards.jsx", external);

    await expect(session.redo()).rejects.toThrow(/conflict|externally/i);
    expect(files.get("Cards.jsx")).toBe(external);
    expect(session.canUndo()).toBe(false);
    expect(session.canRedo()).toBe(false);
  });
});
