import { describe, expect, it } from 'vitest';
import {
  acrossToolsBanner,
  countAcrossDrift,
  normalizeMcpServerKey,
  type McpAcrossRow,
} from './mcp-across-tools';

describe('mcp-across-tools helpers', () => {
  it('countAcrossDrift só conta presents+absents mistos', () => {
    const rows: McpAcrossRow[] = [
      {
        serverKey: 'a',
        label: 'a',
        cells: {
          nexus: 'present',
          cursor: 'present',
          'claude-code': 'absent',
          codex: 'unknown',
          opencode: 'unknown',
          cline: 'unknown',
        },
      },
      {
        serverKey: 'b',
        label: 'b',
        cells: {
          nexus: 'present',
          cursor: 'present',
          'claude-code': 'present',
          codex: 'present',
          opencode: 'present',
          cline: 'unknown',
        },
      },
    ];
    expect(countAcrossDrift(rows)).toBe(1);
  });

  it('banner kicker estável; status na pill/line', () => {
    expect(acrossToolsBanner(0, 3).kicker).toBe('Across Tools');
    expect(acrossToolsBanner(2, 3).kicker).toBe('Across Tools');
    expect(acrossToolsBanner(2, 3).line).toMatch(/2 servers/);
    expect(normalizeMcpServerKey('  Foo_Bar  ')).toBe('foo_bar');
  });
});
