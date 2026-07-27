import { describe, expect, it } from 'vitest';
import {
  governedOmpArgs,
  stripExecutableProfileConfig,
} from './governed-cli-profile';

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

  it('uses OMP native hard-deny flags and only an explicit skill allowlist', () => {
    expect(governedOmpArgs([])).toEqual([
      '--no-extensions',
      '--no-rules',
      '--tools=read,bash,edit,ast_grep,ast_edit,ask,debug,eval,github,glob,grep,lsp,inspect_image,browser,checkpoint,rewind,hub,todo,web_search,write,memory_edit,retain,recall,reflect,learn,manage_skill,yield,goal',
      '--no-skills',
    ]);
    expect(governedOmpArgs(['check-work', 'impeccable'])).toEqual([
      '--no-extensions',
      '--no-rules',
      '--tools=read,bash,edit,ast_grep,ast_edit,ask,debug,eval,github,glob,grep,lsp,inspect_image,browser,checkpoint,rewind,hub,todo,web_search,write,memory_edit,retain,recall,reflect,learn,manage_skill,yield,goal',
      '--skills=check-work,impeccable',
    ]);
    expect(governedOmpArgs([]).join(',')).not.toMatch(
      /(?:^|,)task(?:,|$)/,
    );
  });
});
