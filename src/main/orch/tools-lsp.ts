import path from 'node:path';
import type { McpToolDef } from './mcp-protocol';
import { executionScopeFor } from './gate';
import { assertAgentReadablePath } from './agent-path-policy';
import { openWorkspaceFileForRead } from './workspace-file';
import {
  LSP_LIMITS,
  runScopedLspQuery,
  type LspQuery,
} from './lsp-sidecar';
import { requireStr } from './tool-util';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

function maxResults(args: Record<string, unknown>): number | undefined {
  return typeof args.maxResults === 'number'
    ? Math.trunc(args.maxResults)
    : undefined;
}

function position(args: Record<string, unknown>, key: 'line' | 'column'): number {
  const value = args[key];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value as number;
}

function validateTarget(
  args: Record<string, unknown>,
  ctx: Parameters<McpToolDef['handler']>[1],
): string {
  const sourcePath = requireStr(args, 'path');
  if (!SOURCE_EXTENSION.test(path.basename(sourcePath))) {
    throw new Error('LSP target must be a JavaScript or TypeScript source file');
  }
  const scope = executionScopeFor(ctx);
  assertAgentReadablePath(scope, sourcePath);
  const handle = openWorkspaceFileForRead(scope, sourcePath);
  try {
    if (handle.stat.size > LSP_LIMITS.maxFileBytes) {
      throw new Error(
        `LSP target exceeds ${LSP_LIMITS.maxFileBytes} bytes`,
      );
    }
  } finally {
    handle.close();
  }
  return sourcePath;
}

function queryHandler(kind: LspQuery['kind']): McpToolDef['handler'] {
  return async (args, ctx) => {
    const sourcePath = validateTarget(args, ctx);
    let query: LspQuery;
    if (kind === 'definition' || kind === 'references') {
      query = {
        kind,
        path: sourcePath,
        maxResults: maxResults(args),
        line: position(args, 'line'),
        column: position(args, 'column'),
      };
    } else {
      query = {
        kind,
        path: sourcePath,
        maxResults: maxResults(args),
      };
    }
    return runScopedLspQuery(executionScopeFor(ctx), query);
  };
}

const pathProperty = {
  type: 'string',
  description:
    'JavaScript/TypeScript source path relative to this pane execution scope',
};
const maxResultsProperty = {
  type: 'integer',
  minimum: 1,
  maximum: LSP_LIMITS.maxResults,
  description: `Maximum result count (hard max ${LSP_LIMITS.maxResults})`,
};
const positionProperties = {
  line: {
    type: 'integer',
    minimum: 1,
    description: '1-based source line',
  },
  column: {
    type: 'integer',
    minimum: 1,
    description: '1-based source column',
  },
};

const symbolsTool: McpToolDef = {
  name: 'nexus_lsp_symbols',
  description:
    'List document symbols from one scoped JavaScript/TypeScript source. ' +
    'Read-only, bounded, no global watcher or cross-project index.',
  inputSchema: {
    type: 'object',
    properties: {
      path: pathProperty,
      maxResults: maxResultsProperty,
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: queryHandler('symbols'),
};

const definitionTool: McpToolDef = {
  name: 'nexus_lsp_definition',
  description:
    'Resolve definitions at a scoped JavaScript/TypeScript source position. ' +
    'Results outside this pane execution scope are omitted.',
  inputSchema: {
    type: 'object',
    properties: {
      path: pathProperty,
      ...positionProperties,
      maxResults: maxResultsProperty,
    },
    required: ['path', 'line', 'column'],
    additionalProperties: false,
  },
  handler: queryHandler('definition'),
};

const referencesTool: McpToolDef = {
  name: 'nexus_lsp_references',
  description:
    'Find references at a scoped JavaScript/TypeScript source position. ' +
    'Read-only with hard result, file, byte and time limits.',
  inputSchema: {
    type: 'object',
    properties: {
      path: pathProperty,
      ...positionProperties,
      maxResults: maxResultsProperty,
    },
    required: ['path', 'line', 'column'],
    additionalProperties: false,
  },
  handler: queryHandler('references'),
};

const diagnosticsTool: McpToolDef = {
  name: 'nexus_lsp_diagnostics',
  description:
    'Return syntactic and semantic TypeScript diagnostics for one scoped ' +
    'JavaScript/TypeScript source. Never emits or modifies files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: pathProperty,
      maxResults: maxResultsProperty,
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: queryHandler('diagnostics'),
};

export function buildLspTools(): McpToolDef[] {
  return [symbolsTool, definitionTool, referencesTool, diagnosticsTool];
}
