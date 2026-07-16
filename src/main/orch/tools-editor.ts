import type { McpToolDef } from './mcp-protocol';
import { executionScopeFor } from './gate';
import { num, requireStr } from './tool-util';
import {
  readWorkspaceTextFile,
  updateWorkspaceTextFile,
} from './workspace-file';
import { assertAgentReadablePath } from './agent-path-policy';

/**
 * Editor manipulation MCP tools for Jarvis agent.
 * These operate on workspace files — the agent can open, read, and modify
 * source code through the editor.
 */

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith('\n')
    ? content.slice(0, -1).split('\n').length
    : content.split('\n').length;
}

const editorFocus: McpToolDef = {
  name: 'nexus_editor_focus',
  description:
    'Focus the editor on a specific file. Opens the file in the IDE ' +
    'editor pane and returns its current content. Use this before ' +
    'making edits to a file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      line: {
        type: 'number',
        description: 'Line number to jump to (1-based)',
      },
      column: {
        type: 'number',
        description: 'Column number to jump to (1-based)',
      },
    },
    required: ['path'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    assertAgentReadablePath(relativePath);
    const { content } = readWorkspaceTextFile(executionScopeFor(ctx), relativePath);
    const line = typeof args.line === 'number' ? args.line : undefined;
    const column = typeof args.column === 'number' ? args.column : undefined;
    return {
      path: relativePath,
      line: line ?? null,
      column: column ?? null,
      content,
      lines: countLines(content),
    };
  },
};

const editorInsert: McpToolDef = {
  name: 'nexus_editor_insert',
  description:
    'Insert text at a specific line and column in a file. ' +
    'The text is inserted at the given position without overwriting. ' +
    'Line numbers are 1-based. Use column 0 to insert at the beginning ' +
    'of a line.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      text: {
        type: 'string',
        description: 'Text to insert',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based) to insert at',
      },
      column: {
        type: 'number',
        description: 'Column number (1-based) to insert at (default: 0)',
      },
    },
    required: ['path', 'text', 'line'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    const text = requireStr(args, 'text');
    const lineNum = num(args, 'line') ?? parseInt(requireStr(args, 'line'), 10);
    if (isNaN(lineNum) || lineNum < 1) {
      throw new Error('line must be a positive integer');
    }
    const column =
      typeof args.column === 'number' && args.column >= 0
        ? args.column
        : 0;
    return updateWorkspaceTextFile(executionScopeFor(ctx), relativePath, (raw) => {
      const lines = raw.split('\n');
      const targetIdx = lineNum - 1;
      if (targetIdx >= lines.length) {
        while (lines.length <= targetIdx) lines.push('');
      }
      const targetLine = lines[targetIdx];
      lines[targetIdx] =
        targetLine.slice(0, column) + text + targetLine.slice(column);
      return {
        content: lines.join('\n'),
        result: {
          path: relativePath,
          line: lineNum,
          column,
          inserted: text.length,
        },
      };
    });
  },
};

const editorReplaceSelection: McpToolDef = {
  name: 'nexus_editor_replace_selection',
  description:
    'Replace a range of text in a file. Provide the exact old string to ' +
    'replace and the new string. The first occurrence is replaced. ' +
    'Set replaceAll: true to replace all occurrences.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      oldText: {
        type: 'string',
        description: 'Exact text to find and replace',
      },
      newText: {
        type: 'string',
        description: 'Replacement text',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
      },
    },
    required: ['path', 'oldText', 'newText'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    const oldText = requireStr(args, 'oldText');
    const newText = requireStr(args, 'newText');
    const replaceAll = args.replaceAll === true;
    return updateWorkspaceTextFile(executionScopeFor(ctx), relativePath, (raw) => {
      if (!raw.includes(oldText)) {
        throw new Error(`old text not found in file: ${relativePath}`);
      }
      let count = 0;
      const content = replaceAll
        ? (() => {
            const parts = raw.split(oldText);
            count = parts.length - 1;
            return parts.join(newText);
          })()
        : (() => {
            count = 1;
            return raw.replace(oldText, newText);
          })();
      return {
        content,
        result: {
          path: relativePath,
          replaced: count,
          replaceAll,
        },
      };
    });
  },
};

const editorGotoLine: McpToolDef = {
  name: 'nexus_editor_goto_line',
  description:
    'Navigate the editor cursor to a specific line and optionally column ' +
    'in a file. This does not modify the file — it only moves the cursor.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      line: {
        type: 'number',
        description: 'Line number to navigate to (1-based)',
      },
      column: {
        type: 'number',
        description: 'Column number to navigate to (1-based, default: 1)',
      },
    },
    required: ['path', 'line'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    const lineNum = typeof args.line === 'number' ? args.line : parseInt(requireStr(args, 'line'), 10);
    if (isNaN(lineNum) || lineNum < 1) {
      throw new Error('line must be a positive integer');
    }
    const column =
      typeof args.column === 'number' && args.column >= 1
        ? args.column
        : 1;
    assertAgentReadablePath(relativePath);
    const { content: raw } = readWorkspaceTextFile(executionScopeFor(ctx), relativePath);
    const lines = raw.split('\n');
    const targetLine = lineNum <= lines.length ? lines[lineNum - 1] : '';
    return {
      path: relativePath,
      line: lineNum,
      column,
      totalLines: countLines(raw),
      lineContent: targetLine,
    };
  },
};

export function buildEditorTools(): McpToolDef[] {
  return [editorFocus, editorInsert, editorReplaceSelection, editorGotoLine];
}
