import { describe, expect, it } from 'vitest';
import { stripExecutableProfileConfig } from './governed-cli-profile';

describe('governed CLI profile policy', () => {
  it('removes every executable extension root while preserving ordinary preferences', () => {
    expect(
      stripExecutableProfileConfig({
        model: 'provider/model',
        ui: { compact: true },
        mcpServers: { external: { command: 'external-mcp' } },
        mcp_servers: { second: { command: 'second-mcp' } },
        plugins: ['external-plugin'],
        hooks: [{ command: 'external-hook' }],
        skills: ['/external/skill'],
        agents: { external: {} },
      }),
    ).toEqual({
      model: 'provider/model',
      ui: { compact: true },
    });
  });
});
