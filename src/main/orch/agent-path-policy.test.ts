import { describe, expect, it } from 'vitest';
import {
  assertAgentReadablePath,
  isAgentDeniedReadPath,
} from './agent-path-policy';

describe('isAgentDeniedReadPath', () => {
  it('denies the MCP hub secret store', () => {
    expect(isAgentDeniedReadPath('.nexus/mcp-hub.json')).toBe(true);
    expect(isAgentDeniedReadPath('./.nexus/mcp-hub.json')).toBe(true);
    expect(isAgentDeniedReadPath('.nexus/mcp-hub.json.bak')).toBe(true);
    expect(isAgentDeniedReadPath('.NEXUS/MCP-HUB.JSON')).toBe(true);
  });

  it('denies traversal-normalized paths to the hub secret', () => {
    expect(isAgentDeniedReadPath('src/../.nexus/mcp-hub.json')).toBe(true);
  });

  it('denies the secrets vault and credential-suffixed files under .nexus', () => {
    expect(isAgentDeniedReadPath('.nexus/secrets.enc')).toBe(true);
    expect(isAgentDeniedReadPath('.nexus/foo.credentials')).toBe(true);
    expect(isAgentDeniedReadPath('.nexus/server.pem')).toBe(true);
  });

  it('allows ordinary workspace files', () => {
    expect(isAgentDeniedReadPath('src/main/index.ts')).toBe(false);
    expect(isAgentDeniedReadPath('package.json')).toBe(false);
    expect(isAgentDeniedReadPath('.env')).toBe(false); // legit agent reads
    expect(isAgentDeniedReadPath('.nexus/context/notes.md')).toBe(false);
  });

  it('assertAgentReadablePath throws only for denied paths', () => {
    expect(() => assertAgentReadablePath('README.md')).not.toThrow();
    expect(() => assertAgentReadablePath('.nexus/mcp-hub.json')).toThrow(
      /access denied/,
    );
  });
});
