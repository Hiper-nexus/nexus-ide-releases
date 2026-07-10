import crypto from "node:crypto";
import { styleDiffToTailwind } from "./css-to-tailwind";
import {
  applyClassNameEdit,
  applyDelete,
  applyDeleteAt,
  applyDuplicate,
  applyInlineStyleEdit,
  applyReorder,
  applyRestore,
  applyTextEdit,
  getClassNames,
  type DeleteRestoreInfo,
  type InlineStyleEdit,
} from "./design-code-edit";
import type { InstrumentIndexEntry } from "./design-instrument";

/**
 * Invertible design actions with undo/redo (VISUAL-EDIT-001, F3 — modelo do
 * history manager do Onlook): every execution yields its semantic inverse,
 * undo pushes onto redo, a fresh apply clears redo. File IO goes through
 * injected deps so the wiring layer owns anti-echo bookkeeping.
 */

export type DesignAction =
  | {
      kind: "style";
      nexusId: string;
      mode: "tailwind" | "inline";
      /** kebab-case CSS properties, as edited in the sidebar. */
      styles: Record<string, string>;
    }
  | { kind: "text"; nexusId: string; text: string }
  | {
      kind: "reorder";
      parentNexusId: string;
      fromIndex: number;
      toIndex: number;
    }
  | { kind: "delete"; nexusId: string }
  | { kind: "duplicate"; nexusId: string };

type InternalAction =
  | DesignAction
  | { kind: "classes"; nexusId: string; add: string[]; remove: string[] }
  | { kind: "inlineStyle"; nexusId: string; edit: InlineStyleEdit }
  | { kind: "replaceFile"; file: string; content: string }
  | { kind: "restore"; restore: DeleteRestoreInfo }
  | { kind: "deleteAt"; parentNexusId: string; index: number };

export interface DesignActionDeps {
  lookup(nexusId: string): InstrumentIndexEntry | null;
  readFile(relPath: string): Promise<string>;
  writeFile(
    relPath: string,
    content: string,
    expectedContent: string,
  ): Promise<void>;
}

export class DesignWriteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignWriteConflictError";
  }
}

export interface DesignActionResult {
  ok: true;
  file: string;
  kind: DesignAction["kind"] | "undo" | "redo";
}

export interface DesignActionSession {
  apply(action: DesignAction): Promise<DesignActionResult>;
  undo(): Promise<DesignActionResult | null>;
  redo(): Promise<DesignActionResult | null>;
  canUndo(): boolean;
  canRedo(): boolean;
  reset(): void;
  /**
   * After a structural write the service may re-instrument (new tags on
   * duplicates). Sync the top history entry so undo still CAS-matches.
   */
  acknowledgeWrittenContent(file: string, content: string): void;
}

const MAX_STACK = 100;

interface HistoryEntry {
  action: InternalAction;
  file: string;
  expectedHash: string;
}

interface ExecutionPrecondition {
  file: string;
  hash: string;
}

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** First utility segment: 'pt-2' → 'pt', 'bg-red-500' → 'bg'. Two classes on
 * the same segment conflict — the new one replaces the old (twMerge-lite). */
function utilityStem(cls: string): string {
  const base = cls.includes(":") ? cls.slice(cls.lastIndexOf(":") + 1) : cls;
  const dash = base.indexOf("-");
  return dash === -1 ? base : base.slice(0, dash);
}

function kebabToCamel(property: string): string {
  return property.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

export function createDesignActionSession(
  deps: DesignActionDeps,
): DesignActionSession {
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  let operationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function fileOf(nexusId: string): string {
    const entry = deps.lookup(nexusId);
    if (!entry) throw new Error(`unknown design element: ${nexusId}`);
    return entry.file;
  }

  async function execute(
    action: InternalAction,
    precondition?: ExecutionPrecondition,
  ): Promise<{ inverse: InternalAction; file: string; afterHash: string }> {
    switch (action.kind) {
      case "style": {
        if (action.mode === "tailwind") {
          const conversion = styleDiffToTailwind(action.styles);
          const unsupported = Object.keys(conversion.unsupported);
          if (unsupported.length) {
            throw new Error(
              `no deterministic tailwind mapping for: ${unsupported.join(", ")} — send to the agent instead`,
            );
          }
          const current = await currentClasses(action.nexusId);
          return execute(
            {
              kind: "classes",
              nexusId: action.nexusId,
              add: conversion.classes,
              remove: conflictingClasses(current.classes, conversion.classes),
            },
            precondition ?? {
              file: current.file,
              hash: contentHash(current.code),
            },
          );
        }
        const edit: InlineStyleEdit = {};
        for (const [property, value] of Object.entries(action.styles)) {
          edit[kebabToCamel(property)] = value;
        }
        return execute(
          { kind: "inlineStyle", nexusId: action.nexusId, edit },
          precondition,
        );
      }
      case "classes": {
        const file = fileOf(action.nexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyClassNameEdit(code, action.nexusId, {
          add: action.add,
          remove: action.remove,
        });
        await deps.writeFile(file, result.code, code);
        return {
          file,
          afterHash: contentHash(result.code),
          inverse: {
            kind: "classes",
            nexusId: action.nexusId,
            ...result.inverse,
          },
        };
      }
      case "inlineStyle": {
        const file = fileOf(action.nexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyInlineStyleEdit(code, action.nexusId, action.edit);
        await deps.writeFile(file, result.code, code);
        return {
          file,
          afterHash: contentHash(result.code),
          inverse: {
            kind: "inlineStyle",
            nexusId: action.nexusId,
            edit: result.inverse,
          },
        };
      }
      case "text": {
        const file = fileOf(action.nexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyTextEdit(code, action.nexusId, action.text);
        await deps.writeFile(file, result.code, code);
        return {
          file,
          afterHash: contentHash(result.code),
          inverse: {
            kind: "text",
            nexusId: action.nexusId,
            text: result.previousText,
          },
        };
      }
      case "reorder": {
        const file = fileOf(action.parentNexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyReorder(
          code,
          action.parentNexusId,
          action.fromIndex,
          action.toIndex,
        );
        await deps.writeFile(file, result.code, code);
        return {
          file,
          afterHash: contentHash(result.code),
          inverse: {
            kind: "reorder",
            parentNexusId: action.parentNexusId,
            ...result.inverse,
          },
        };
      }
      case "delete": {
        const file = fileOf(action.nexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyDelete(code, action.nexusId);
        await deps.writeFile(file, result.code, code);
        return {
          file,
          afterHash: contentHash(result.code),
          inverse: { kind: "replaceFile", file, content: code },
        };
      }
      case "replaceFile": {
        const code = await deps.readFile(action.file);
        assertPrecondition(action.file, code, precondition);
        await deps.writeFile(action.file, action.content, code);
        return {
          file: action.file,
          afterHash: contentHash(action.content),
          inverse: {
            kind: "replaceFile",
            file: action.file,
            content: code,
          },
        };
      }
      case "restore": {
        const file = fileOf(action.restore.parentNexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyRestore(
          code,
          action.restore.parentNexusId,
          action.restore.index,
          action.restore.snippet,
        );
        await deps.writeFile(file, result.code, code);
        const inverse: InternalAction = action.restore.deletedNexusId
          ? { kind: "delete", nexusId: action.restore.deletedNexusId }
          : {
              kind: "deleteAt",
              parentNexusId: action.restore.parentNexusId,
              index: action.restore.index,
            };
        return { file, afterHash: contentHash(result.code), inverse };
      }
      case "deleteAt": {
        const file = fileOf(action.parentNexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyDeleteAt(code, action.parentNexusId, action.index);
        await deps.writeFile(file, result.code, code);
        return {
          file,
          afterHash: contentHash(result.code),
          inverse: { kind: "restore", restore: result.restore },
        };
      }
      case "duplicate": {
        const file = fileOf(action.nexusId);
        const code = await deps.readFile(file);
        assertPrecondition(file, code, precondition);
        const result = applyDuplicate(code, action.nexusId);
        await deps.writeFile(file, result.code, code);
        return {
          file,
          afterHash: contentHash(result.code),
          inverse: {
            kind: "deleteAt",
            parentNexusId: result.parentNexusId,
            index: result.duplicatedFromIndex + 1,
          },
        };
      }
      default: {
        const never: never = action;
        throw new Error(`unknown design action: ${JSON.stringify(never)}`);
      }
    }
  }

  function assertPrecondition(
    file: string,
    code: string,
    precondition?: ExecutionPrecondition,
  ): void {
    if (!precondition) return;
    if (file !== precondition.file || contentHash(code) !== precondition.hash) {
      throw new DesignWriteConflictError(
        `design history conflict: ${file} changed externally`,
      );
    }
  }

  async function currentClasses(
    nexusId: string,
  ): Promise<{ classes: string[]; code: string; file: string }> {
    const file = fileOf(nexusId);
    const code = await deps.readFile(file);
    return { classes: getClassNames(code, nexusId), code, file };
  }

  function conflictingClasses(current: string[], next: string[]): string[] {
    const stems = new Set(next.map(utilityStem));
    return current.filter((cls) => stems.has(utilityStem(cls)));
  }

  return {
    apply(action) {
      return serialize(async () => {
        try {
          const { inverse, file, afterHash } = await execute(action);
          undoStack.push({ action: inverse, file, expectedHash: afterHash });
          if (undoStack.length > MAX_STACK) undoStack.shift();
          redoStack.length = 0;
          return { ok: true, file, kind: action.kind };
        } catch (error) {
          if (error instanceof DesignWriteConflictError) {
            undoStack.length = 0;
            redoStack.length = 0;
          }
          throw error;
        }
      });
    },

    undo() {
      return serialize(async () => {
        const entry = undoStack.at(-1);
        if (!entry) return null;
        try {
          const { inverse, file, afterHash } = await execute(entry.action, {
            file: entry.file,
            hash: entry.expectedHash,
          });
          undoStack.pop();
          redoStack.push({ action: inverse, file, expectedHash: afterHash });
          return { ok: true, file, kind: "undo" };
        } catch (error) {
          if (error instanceof DesignWriteConflictError) {
            undoStack.length = 0;
            redoStack.length = 0;
          }
          throw error;
        }
      });
    },

    redo() {
      return serialize(async () => {
        const entry = redoStack.at(-1);
        if (!entry) return null;
        try {
          const { inverse, file, afterHash } = await execute(entry.action, {
            file: entry.file,
            hash: entry.expectedHash,
          });
          redoStack.pop();
          undoStack.push({ action: inverse, file, expectedHash: afterHash });
          return { ok: true, file, kind: "redo" };
        } catch (error) {
          if (error instanceof DesignWriteConflictError) {
            undoStack.length = 0;
            redoStack.length = 0;
          }
          throw error;
        }
      });
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    reset: () => {
      undoStack.length = 0;
      redoStack.length = 0;
    },
    acknowledgeWrittenContent(file, content) {
      const hash = contentHash(content);
      for (const top of [undoStack.at(-1), redoStack.at(-1)]) {
        if (top?.file === file) top.expectedHash = hash;
      }
    },
  };
}
