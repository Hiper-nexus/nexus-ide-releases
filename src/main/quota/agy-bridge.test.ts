import { describe, expect, it } from 'vitest';
import {
  discoverAgyBridge,
  fetchAgyBridgeUsage,
  parseAgyQuotaSummary,
} from './agy-bridge';

const NOW = Date.parse('2026-09-20T20:00:00Z');
const IN_5H = new Date(NOW + 5 * 3600 * 1000).toISOString();
const IN_7D = new Date(NOW + 7 * 86400 * 1000).toISOString();

describe('discoverAgyBridge', () => {
  it('acha o language server do IDE e extrai o --csrf_token', () => {
    const table = [
      '  PID COMMAND',
      '  100 /Applications/Antigravity.app/Contents/Resources/app/extensions/language_server_macos_arm --csrf_token abc123 --random_port',
      '  200 /usr/bin/other',
    ].join('\n');
    const ep = discoverAgyBridge({
      processTable: table,
      portsOfPid: (pid) => (pid === 100 ? [51111, 52222] : []),
    });
    expect(ep).toEqual({ ports: [51111, 52222], csrfToken: 'abc123' });
  });

  it('cai no `agy` CLI (sem token) quando o IDE não está na tabela', () => {
    const table = [
      '  PID COMMAND',
      '  300 /Users/x/.local/bin/agy serve',
    ].join('\n');
    const ep = discoverAgyBridge({
      processTable: table,
      portsOfPid: (pid) => (pid === 300 ? [47890] : []),
    });
    expect(ep).toEqual({ ports: [47890], csrfToken: null });
  });

  it('não casa "agy" dentro de palavras/paths — só o executável', () => {
    const table = [
      '  PID COMMAND',
      '  400 /bin/sh -c echo agyptian stuff',
      '  401 node /tmp/agy-related/server.js',
    ].join('\n');
    expect(
      discoverAgyBridge({ processTable: table, portsOfPid: () => [1] }),
    ).toBeNull();
  });

  it('NUNCA disca o language server de outro IDE (Windsurf/Devin usam o mesmo protocolo)', () => {
    // Processo real desta máquina: Devin.app roda language_server_macos_arm
    // da família Codeium — quota dele é Windsurf, não Antigravity.
    const table = [
      '  PID COMMAND',
      '  98183 /Applications/Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm --api_server_url https://server.codeium.com --ide_name windsurf --csrf_token deadbeef',
      '  98200 /Applications/Windsurf.app/Contents/Resources/extensions/codeium/bin/language_server --csrf_token cafe',
    ].join('\n');
    expect(
      discoverAgyBridge({ processTable: table, portsOfPid: () => [9999] }),
    ).toBeNull();
  });

  it('sem processo e sem porta → null honesto', () => {
    expect(
      discoverAgyBridge({ processTable: ' PID COMMAND\n', portsOfPid: () => [1] }),
    ).toBeNull();
    expect(
      discoverAgyBridge({
        processTable: '  500 /Users/x/.local/bin/agy',
        portsOfPid: () => [],
      }),
    ).toBeNull();
  });
});

describe('parseAgyQuotaSummary', () => {
  it('envelope de groups (LS): remainingFraction → usedRatio invertido', () => {
    const windows = parseAgyQuotaSummary(
      {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                displayName: 'Five Hour Limit',
                remaining: { case: 'remainingFraction', value: 0.25 },
                resetTime: IN_5H,
                window: 'session',
              },
              {
                displayName: 'Weekly Limit',
                remainingFraction: 0.6,
                resetTime: IN_7D,
                window: 'weekly',
              },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                displayName: 'Weekly Limit',
                remainingFraction: 0.9,
                resetTime: IN_7D,
                window: 'weekly',
              },
            ],
          },
        ],
      },
      NOW,
    );
    const g5 = windows.find((w) => w.label === 'Gemini Models · 5 Horas');
    const gw = windows.find((w) => w.label === 'Gemini Models · Semanal');
    const cgw = windows.find((w) => w.label === 'Claude and GPT models · Semanal');
    expect(g5?.usedRatio).toBeCloseTo(0.75, 5);
    expect(gw?.usedRatio).toBeCloseTo(0.4, 5);
    expect(gw?.kind).toBe('weekly');
    expect(cgw?.usedRatio).toBeCloseTo(0.1, 5);
  });

  it('buckets por modelo (Cloud Code) agregam nas 4 janelas padrão', () => {
    const windows = parseAgyQuotaSummary(
      {
        buckets: [
          {
            modelId: 'gemini-2.5-pro',
            remainingFraction: 0.5,
            resetTime: IN_5H,
          },
          {
            modelId: 'gemini-2.5-flash',
            remainingFraction: 0.3,
            resetTime: IN_5H,
          },
          {
            modelId: 'claude-sonnet',
            remainingFraction: 0.8,
            resetTime: IN_7D,
          },
        ],
      },
      NOW,
    );
    // Gemini hourly = pior bucket (menor remaining = mais apertado)
    const gh = windows.find((w) => w.label === 'Gemini · 5 Horas');
    const cw = windows.find((w) => w.label === 'Claude/GPT · Semanal');
    expect(gh?.usedRatio).toBeCloseTo(0.7, 5);
    expect(cw?.usedRatio).toBeCloseTo(0.2, 5);
  });

  it('resetTime > 24h classifica como semanal mesmo sem marcador', () => {
    const windows = parseAgyQuotaSummary(
      {
        buckets: [
          { modelId: 'gemini-x', remainingFraction: 0.9, resetTime: IN_7D },
        ],
      },
      NOW,
    );
    expect(windows[0]?.label).toBe('Gemini · Semanal');
    expect(windows[0]?.kind).toBe('weekly');
  });

  it('envelope legado used/limit vira janela direta', () => {
    const windows = parseAgyQuotaSummary(
      {
        buckets: [
          { bucketId: 'req-weekly', used: 40, limit: 100, resetTime: IN_7D },
        ],
      },
      NOW,
    );
    expect(windows[0]?.usedRatio).toBeCloseTo(0.4, 5);
  });

  it('payload estranho → [] (nunca inventa)', () => {
    expect(parseAgyQuotaSummary(null, NOW)).toEqual([]);
    expect(parseAgyQuotaSummary({}, NOW)).toEqual([]);
    expect(parseAgyQuotaSummary({ buckets: [] }, NOW)).toEqual([]);
    expect(
      parseAgyQuotaSummary({ buckets: [{ modelId: 'chat_ui', remainingFraction: 0.1 }] }, NOW),
    ).toEqual([]);
  });
});

describe('fetchAgyBridgeUsage', () => {
  it('percorre as portas até uma responder com janelas', async () => {
    const asked: number[] = [];
    const windows = await fetchAgyBridgeUsage({
      now: NOW,
      endpoint: { ports: [1111, 2222], csrfToken: 'tok' },
      postImpl: async (port) => {
        asked.push(port);
        if (port === 1111) throw new Error('essa porta não serve o RPC');
        return {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                { displayName: 'Five Hour Limit', remainingFraction: 0.5 },
              ],
            },
          ],
        };
      },
    });
    expect(asked).toEqual([1111, 2222]);
    expect(windows?.[0]?.usedRatio).toBeCloseTo(0.5, 5);
  });

  it('resposta sem janelas não encerra a varredura de portas', async () => {
    const windows = await fetchAgyBridgeUsage({
      now: NOW,
      endpoint: { ports: [1, 2], csrfToken: null },
      postImpl: async (port) => (port === 1 ? {} : { groups: [
        { displayName: 'Gemini', buckets: [{ remainingFraction: 0.2 }] },
      ] }),
    });
    expect(windows?.[0]?.usedRatio).toBeCloseTo(0.8, 5);
  });

  it('endpoint null (nada rodando) → null sem chamar a rede', async () => {
    let calls = 0;
    const windows = await fetchAgyBridgeUsage({
      endpoint: null,
      postImpl: async () => {
        calls += 1;
        return {};
      },
    });
    expect(windows).toBeNull();
    expect(calls).toBe(0);
  });
});
