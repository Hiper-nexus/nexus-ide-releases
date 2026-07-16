import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAgentReadablePath,
  isAgentDeniedReadPath,
} from './agent-path-policy';
import type { ProjectExecutionScope } from '../../shared/types';

describe('isAgentDeniedReadPath (relative form)', () => {
  it('denies the MCP hub secret store', () => {
    expect(isAgentDeniedReadPath('.nexus/mcp-hub.json')).toBe(true);
    expect(isAgentDeniedReadPath('./.nexus/mcp-hub.json')).toBe(true);
    expect(isAgentDeniedReadPath('.nexus/mcp-hub.json.bak')).toBe(true);
    expect(isAgentDeniedReadPath('.NEXUS/MCP-HUB.JSON')).toBe(true);
  });

  it('denies the secrets vault and credential-suffixed files under .nexus', () => {
    expect(isAgentDeniedReadPath('.nexus/secrets.enc')).toBe(true);
    expect(isAgentDeniedReadPath('.nexus/foo.credentials')).toBe(true);
    expect(isAgentDeniedReadPath('.nexus/server.pem')).toBe(true);
  });

  it('allows ordinary workspace files', () => {
    expect(isAgentDeniedReadPath('src/main/index.ts')).toBe(false);
    expect(isAgentDeniedReadPath('package.json')).toBe(false);
    expect(isAgentDeniedReadPath('.env')).toBe(false);
    expect(isAgentDeniedReadPath('.nexus/context/notes.md')).toBe(false);
  });
});

describe('assertAgentReadablePath (resolved form — bypass resistance)', () => {
  const root = path.resolve('/ws/project');
  const scope = {
    version: 1,
    installationId: 'i',
    projectId: 'p',
    checkoutId: 'c',
    rootRealPath: root,
    identitySource: 'manifest',
  } as ProjectExecutionScope;

  it('allows an ordinary file', () => {
    expect(() => assertAgentReadablePath(scope, 'README.md')).not.toThrow();
  });

  it('denies the relative secret path', () => {
    expect(() => assertAgentReadablePath(scope, '.nexus/mcp-hub.json')).toThrow(
      /access denied/,
    );
  });

  it('denies an ABSOLUTE path to the secret (bypass fixed)', () => {
    expect(() =>
      assertAgentReadablePath(scope, path.join(root, '.nexus/mcp-hub.json')),
    ).toThrow(/access denied/);
  });

  it('denies a re-entrant ../<workspace-name>/ path to the secret (bypass fixed)', () => {
    const reentrant = `../${path.basename(root)}/.nexus/mcp-hub.json`;
    expect(() => assertAgentReadablePath(scope, reentrant)).toThrow(
      /access denied/,
    );
  });

  it('does not throw for paths that escape the workspace (reader handles them)', () => {
    expect(() =>
      assertAgentReadablePath(scope, '../../../etc/passwd'),
    ).not.toThrow();
  });
});
