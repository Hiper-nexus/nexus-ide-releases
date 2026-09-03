import { describe, expect, it, vi } from "vitest";
import {
  TerminalInputState,
  TerminalGhostAssist,
  sanitizeGhostTail,
  isRedundantCd,
} from "./terminal-ghost-assist";

describe("TerminalInputState", () => {
  it("tracks phase across OSC 133 markers", () => {
    const state = new TerminalInputState();
    expect(state.phase).toBe("unknown");

    state.ingestPtyMarkers("hello\x1b]133;A\x07");
    expect(state.phase).toBe("typing");
    expect(state.buffer).toBe("");

    state.ingestUserInput("git st");
    expect(state.buffer).toBe("git st");

    state.ingestPtyMarkers("\x1b]133;B\x07");
    expect(state.phase).toBe("executing");
    expect(state.buffer).toBe("");

    state.ingestPtyMarkers("\x1b]133;D;0\x07");
    expect(state.phase).toBe("executing");
  });

  it("handles backspace, enter, and esc correctly", () => {
    const state = new TerminalInputState();
    state.ingestPtyMarkers("\x1b]133;A\x07");
    state.ingestUserInput("cargo buidl");
    expect(state.buffer).toBe("cargo buidl");

    // Backspace twice
    state.ingestUserInput("\x7f\x7f");
    expect(state.buffer).toBe("cargo bui");

    // ESC clears buffer
    state.ingestUserInput("\x1b");
    expect(state.buffer).toBe("");
    expect(state.phase).toBe("unknown");
  });

  it("computes visibleTail and invalidates on divergence", () => {
    const state = new TerminalInputState();
    state.ingestPtyMarkers("\x1b]133;A\x07");
    state.ingestUserInput("npm r");

    state.setGhost({
      prefix: "npm r",
      tail: "un test",
      source: "local-history",
      fullCommand: "npm run test",
    });

    expect(state.visibleTail()).toBe("un test");

    // User types "u" -> tail becomes "n test"
    state.ingestUserInput("u");
    expect(state.visibleTail()).toBe("n test");

    // User types "x" (diverges from "n test") -> ghost invalidated
    state.ingestUserInput("x");
    expect(state.visibleTail()).toBeNull();
    expect(state.ghost).toBeNull();
  });
});

describe("sanitizeGhostTail", () => {
  it("strips control characters and keeps standard text", () => {
    expect(sanitizeGhostTail("un dev\x1b[C\x07")).toBe("un dev[C");
    expect(sanitizeGhostTail("commit -m \x22fix\x22")).toBe("commit -m \x22fix\x22");
    expect(sanitizeGhostTail("")).toBe("");
  });
});

describe("isRedundantCd", () => {
  it("identifies redundant directory changes", () => {
    expect(isRedundantCd("cd .", "/Users/nexus/app")).toBe(true);
    expect(isRedundantCd("cd ./", "/Users/nexus/app")).toBe(true);
    expect(isRedundantCd("cd app", "/Users/nexus/app")).toBe(true);
    expect(isRedundantCd("cd /Users/nexus/app", "/Users/nexus/app")).toBe(true);
    expect(isRedundantCd("cd src", "/Users/nexus/app")).toBe(false);
  });
});

describe("TerminalGhostAssist", () => {
  function createMockTerminal() {
    return {
      buffer: {
        active: {
          cursorX: 5,
          cursorY: 2,
        },
      },
      onCursorMove: vi.fn(() => ({ dispose: vi.fn() })),
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
    } as any;
  }

  it("triggers local lookup and accepts ghost suggestion on tryAcceptGhost", async () => {
    const written: string[] = [];
    const accepted: any[] = [];
    const term = createMockTerminal();

    const assist = new TerminalGhostAssist({
      terminal: term,
      screenElement: null as any,
      context: {
        getCwd: () => "/Users/dev/nexus",
        getShell: () => "/bin/zsh",
      },
      writeToPty: (data) => written.push(data),
      localLookup: async (prefix) => {
        if (prefix === "git") return "git status -s";
        return null;
      },
      onAccepted: (info) => accepted.push(info),
    });

    assist.ingestPtyData("\x1b]133;A\x07");
    assist.ingestUserInput("git");

    // Wait for microtask/lookup resolution
    await new Promise((r) => setTimeout(r, 10));

    expect(assist.state.ghost).toMatchObject({
      prefix: "git",
      tail: " status -s",
      fullCommand: "git status -s",
    });

    const didAccept = assist.tryAcceptGhost();
    expect(didAccept).toBe(true);
    expect(written).toEqual([" status -s"]);
    expect(accepted).toEqual([
      { source: "local-history", command: "git status -s" },
    ]);
    expect(assist.state.ghost).toBeNull();

    assist.dispose();
  });

  it("supports partial word acceptance via tryAcceptGhostWord", async () => {
    const written: string[] = [];
    const term = createMockTerminal();

    const assist = new TerminalGhostAssist({
      terminal: term,
      screenElement: null as any,
      context: {
        getCwd: () => "/Users/dev/nexus",
      },
      writeToPty: (data) => written.push(data),
      localLookup: async (prefix) => {
        if (prefix === "docker") return "docker compose up -d";
        return null;
      },
    });

    assist.ingestPtyData("\x1b]133;A\x07");
    assist.ingestUserInput("docker");
    await new Promise((r) => setTimeout(r, 10));

    expect(assist.state.visibleTail()).toBe(" compose up -d");

    // Accept first word
    assist.tryAcceptGhostWord();
    expect(written).toEqual([" compose"]);

    assist.dispose();
  });
});
