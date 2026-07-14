import fs from 'node:fs';
import type { McpToolDef } from './mcp-protocol';
import { executionScopeFor } from './gate';
import { str } from './tool-util';
import { openWorkspaceFileForRead } from './workspace-file';
import {
  auditContent,
  CONTENT_PROVENANCES,
  CONTENT_AUDIT_MAX_CHARS,
  type ContentProvenance,
} from '../security/content-audit';
import { auditSourceCode } from '../security/source-audit';

const MAX_AUDIT_BYTES = CONTENT_AUDIT_MAX_CHARS;

interface AuditInput {
  content: string;
  source: string;
  artifactName?: string;
}

function resolveAuditInput(
  args: Record<string, unknown>,
  ctx: Parameters<NonNullable<McpToolDef['handler']>>[1],
): AuditInput {
  const relativePath = str(args, 'path');
  const inlineContent = str(args, 'content');
  if (relativePath && inlineContent) {
    throw new Error('provide either path or content, not both');
  }
  if (relativePath) {
    const handle = openWorkspaceFileForRead(executionScopeFor(ctx), relativePath);
    try {
      if (handle.stat.size > MAX_AUDIT_BYTES) {
        throw new Error(`audit target exceeds ${MAX_AUDIT_BYTES} bytes`);
      }
      return {
        content: fs.readFileSync(handle.fd, 'utf8'),
        source: relativePath,
        artifactName: relativePath,
      };
    } finally {
      handle.close();
    }
  }
  if (!inlineContent) throw new Error('missing required argument: path or content');
  return {
    content: inlineContent,
    source: str(args, 'source') ?? 'inline-content',
  };
}

function provenance(args: Record<string, unknown>): ContentProvenance {
  const value = str(args, 'provenance') ?? 'unknown';
  if ((CONTENT_PROVENANCES as readonly string[]).includes(value)) {
    return value as ContentProvenance;
  }
  throw new Error(`unsupported content provenance: ${value}`);
}

const contentAuditTool: McpToolDef = {
  name: 'nexus_content_audit',
  description:
    'Read-only BridgeWard-style audit for prompt injection and repo-poisoning signals. ' +
    'Audits inline content or a workspace-relative file; never executes or modifies it.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file to audit' },
      content: { type: 'string', description: 'Inline content to audit' },
      source: { type: 'string', description: 'Human-readable source label' },
      provenance: { type: 'string', enum: [...CONTENT_PROVENANCES] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const input = resolveAuditInput(args, ctx);
    return auditContent(input.content, {
      source: input.source,
      provenance: provenance(args),
      artifactName: input.artifactName,
    });
  },
};

const sourceSecurityAuditTool: McpToolDef = {
  name: 'nexus_security_audit',
  description:
    'Read-only BridgeSecurity-style source audit for secret-like credentials, dynamic execution, ' +
    'sensitive file reads, unsafe HTML sinks, and prompt-injection indicators.',
  inputSchema: contentAuditTool.inputSchema,
  handler: async (args, ctx) => {
    const input = resolveAuditInput(args, ctx);
    return auditSourceCode(input.content, {
      source: input.source,
      provenance: provenance(args),
      artifactName: input.artifactName,
    });
  },
};

export function buildSecurityTools(): McpToolDef[] {
  return [contentAuditTool, sourceSecurityAuditTool];
}
