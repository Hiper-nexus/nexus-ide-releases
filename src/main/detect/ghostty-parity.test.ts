// DSK-03: the libghostty-vt grid must classify every existing detector fixture
// the same as the stripped-text stream (or better), and fix the stale-frame
// cases the text stream gets wrong. Fixtures below are the screens from
// evaluator.test.ts / detector.test.ts; PTY output carries CRLF (ONLCR), so
// the grid receives `\r\n` where a fixture wrote `\n`.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compileManifest, type CompiledManifest } from './compiler';
import { AgentScreenDetector, type ScreenDetectionRecord } from './detector-core';
import { evaluateManifest, type DetectionExplain } from './evaluator';
import { GhosttyRuntime } from './ghostty-runtime';
import { GhosttyScreen } from './ghostty-screen';
import { loadManifestDir, parseManifest } from './manifest';
import { GhosttyScreenBuffer, SessionScreenBuffer, type ScreenSource } from './screen-buffer';

const REPO = path.resolve(__dirname, '../../..');
const runtime = GhosttyRuntime.fromBytes(
  new Uint8Array(fs.readFileSync(path.join(REPO, 'resources/ghostty/ghostty-vt.wasm'))),
);
const bundled = new Map(
  loadManifestDir(path.join(REPO, 'resources/agent-detection')).map(({ manifest }) => [
    manifest.id,
    compileManifest(manifest),
  ]),
);
const manifest = (id: string): CompiledManifest => {
  const compiled = bundled.get(id);
  if (!compiled) throw new Error(`manifest ${id} not bundled`);
  return compiled;
};
const crlf = (text: string) => text.replaceAll('\n', '\r\n');

function renderGrid(screen: string, cols = 120, rows = 30): string {
  const grid = GhosttyScreen.create(runtime, cols, rows);
  try {
    grid.write(crlf(screen));
    return grid.plainText();
  } finally {
    grid.dispose();
  }
}

const verdict = (explain: DetectionExplain) => ({
  state: explain.state,
  rule: explain.matchedRule?.id ?? null,
  fallback: explain.fallbackReason,
  visibleIdle: explain.visibleIdle,
  visibleBlocker: explain.visibleBlocker,
  visibleWorking: explain.visibleWorking,
  skip: explain.skipStateUpdate,
});

/** Screen fixtures of evaluator.test.ts (bundled manifests, real controls). */
const SCREEN_FIXTURES: Array<{ name: string; manifest: string; screen: string }> = [
  { name: 'claude spinner footer', manifest: 'claude', screen: ['⏺ Reading files…', '', '⏵⏵ Accomplishing… (esc to interrupt · 12s)', ''].join('\n') },
  {
    name: 'claude prompt box',
    manifest: 'claude',
    screen: ['⏺ Done with the change.', '', '────────────────────────────────────────────', '❯ ', '────────────────────────────────────────────', '  ? for shortcuts', ''].join('\n'),
  },
  {
    name: 'claude bash permission',
    manifest: 'claude',
    screen: ['⏺ Bash(ls -la /tmp)', '', 'Do you want to proceed?', '❯ 1. Yes', "  2. Yes, and don't ask again for: ls", '  3. No', 'esc to cancel', ''].join('\n'),
  },
  { name: 'claude model picker', manifest: 'claude', screen: ['Select model', 'enter to set as default · esc to cancel', ''].join('\n') },
  { name: 'codex working footer', manifest: 'codex', screen: ['• Explored codebase', '• Working (12s • esc to interrupt) · 2.1k tokens', ''].join('\n') },
  {
    name: 'codex trust directory',
    manifest: 'codex',
    screen: ['> You are in /Users/dev/project', '', 'Do you trust the contents of this directory?', '', '› 1. Yes, continue', ''].join('\n'),
  },
  { name: 'codex idle prompt', manifest: 'codex', screen: ['• Work complete', '', '› ', ''].join('\n') },
  {
    name: 'codex transcript viewer',
    manifest: 'codex',
    screen: ['› open transcript', '', '↑/↓ to scroll · pgup/pgdn to jump · home/end to jump · q to quit', 'esc to edit prev', ''].join('\n'),
  },
  {
    name: 'minimax running turn',
    manifest: 'minimax-code',
    screen: [
      '  × Tasks · 2 failed · 1 background active · 8 results ready · 2 cancelled · /tasks details',
      '  ✶ Running 57min44s · ⚡ 3268 tok/s · Alt+Enter queue · Ctrl+O details · Esc stop',
      '  › Ask Mcode to do anything',
      '  t-b31220d4a9bb1c7f555d76e2 │ nexus… · wt │ Full access │ ✦ M3.1-Flash-Preview │ Ctx 48%',
    ].join('\n'),
  },
  { name: 'minimax background task', manifest: 'minimax-code', screen: ['  Tasks · 1 background active · 3 results ready · /tasks details', '  › Ask Mcode to do anything'].join('\n') },
  { name: 'minimax parked composer', manifest: 'minimax-code', screen: ['  Tasks · 8 results ready · /tasks details', '  › Ask Mcode to do anything'].join('\n') },
];

describe('grid vs text parity on the existing screen fixtures', () => {
  it('every fixture classifies identically (divergences: none)', () => {
    const divergences = SCREEN_FIXTURES.flatMap(({ name, manifest: id, screen }) => {
      const text = verdict(evaluateManifest(manifest(id), { screen, oscTitle: '', oscProgress: '' }));
      const grid = verdict(evaluateManifest(manifest(id), { screen: renderGrid(screen), oscTitle: '', oscProgress: '' }));
      return JSON.stringify(text) === JSON.stringify(grid) ? [] : [{ name, text, grid }];
    });
    expect(divergences).toEqual([]);
  });
});

const TEST_MANIFEST = [
  'id = "testcli"',
  '[[rules]]',
  'id = "spinner_working"',
  'state = "working"',
  'priority = 100',
  'visible_working = true',
  'region = "bottom_non_empty_lines(1)"',
  'contains = ["working..."]',
  '[[rules]]',
  'id = "prompt_idle"',
  'state = "idle"',
  'priority = 50',
  'visible_idle = true',
  'region = "bottom_non_empty_lines(1)"',
  'contains = ["ready>"]',
].join('\n');

function detectorOn(
  screen: ScreenSource | undefined,
  manifests: CompiledManifest[],
  adapterId: string,
) {
  const published: ScreenDetectionRecord[] = [];
  const detector = new AgentScreenDetector({
    manifests,
    getAgentInfo: () => ({ adapterId, paneId: 'p1' }),
    publish: (record) => published.push(record),
    now: () => Date.now(),
    ...(screen ? { screen } : {}),
  });
  return { detector, published };
}

/** Feed steps through a detector and return its published states. */
function run(
  engine: 'text' | 'grid',
  manifests: CompiledManifest[],
  adapterId: string,
  steps: string[],
): Array<Pick<ScreenDetectionRecord, 'state' | 'matchedRuleId' | 'visibleBlocker'>> {
  const screen = engine === 'text' ? new SessionScreenBuffer() : new GhosttyScreenBuffer(runtime);
  const { detector, published } = detectorOn(screen, manifests, adapterId);
  for (const step of steps) {
    detector.onData('s', step);
    vi.advanceTimersByTime(1_000);
  }
  detector.onExit('s');
  return published.map(({ state, matchedRuleId, visibleBlocker }) => ({ state, matchedRuleId, visibleBlocker }));
}

describe('detector streams: grid vs text', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('detector.test.ts streams publish the same states on both engines', () => {
    const testcli = [compileManifest(parseManifest(TEST_MANIFEST))];
    const scenarios = [
      ['some output\r\nWorking...\r\n'],
      ['Working...\r\n', '\r\nAll done output without markers\r\n'],
      ['Working...\r\n', '\r\nready> \r\n'],
      ['Working...\r\n', '\r\nquiet\r\n', 'Working...\r\n'],
      ['ready> \r\n', '\x1b]0;new title\x07'],
    ];
    const divergences = scenarios.flatMap((steps) => {
      const text = run('text', testcli, 'testcli', steps);
      const grid = run('grid', testcli, 'testcli', steps);
      return JSON.stringify(text) === JSON.stringify(grid) ? [] : [{ steps, text, grid }];
    });
    expect(divergences).toEqual([]);
  });

  it('the default detector screen is the grid for manifest-backed sessions', () => {
    const { detector } = detectorOn(undefined, [manifest('claude')], 'claude');
    detector.onData('s', 'line one\r\n\x1b[1Aline ONE');
    // The text stream would hold "line one\nline ONE"; the grid rewrote row 0.
    expect(detector.getScreenText('s')).toBe('line ONE');
    detector.onExit('s');
  });

  it('claude: an approved permission dialog redrawn in place stops reading as blocked', () => {
    const dialog = crlf(['⏺ Bash(ls -la /tmp)', '', 'Do you want to proceed?', '❯ 1. Yes', "  2. Yes, and don't ask again for: ls", '  3. No', 'esc to cancel'].join('\n'));
    // Ink repaints the dynamic area: up 6 rows to the tool line, erase below, redraw.
    const approved = `\x1b[6A\r\x1b[J${crlf(['⏺ Bash(ls -la /tmp)', '  ⎿  total 0'].join('\n'))}`;
    const claude = [manifest('claude')];
    expect(run('grid', claude, 'claude', [dialog, approved])).toEqual([
      { state: 'blocked', matchedRuleId: 'bash_permission_prompt', visibleBlocker: true },
      { state: 'idle', matchedRuleId: null, visibleBlocker: false },
    ]);
    // Text stream: the erased dialog is still in the tail, so it stays blocked
    // (re-published by the stable-blocker refresh, never released).
    const text = run('text', claude, 'claude', [dialog, approved]);
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((record) => record.state === 'blocked')).toBe(true);
  });

  it('codex: a confirmed approval replaced by the working footer reads as working', () => {
    const approval = crlf(['• Ran git status', '', 'Allow command?', '', '  $ ls -la', '', '› 1. Yes, proceed', '  2. No, and tell Codex what to do differently', '', 'Press enter to confirm or esc to cancel'].join('\n'));
    // Ratatui inline viewport: cursor up to the approval block, clear, redraw.
    const working = `\x1b[9A\r\x1b[J${crlf(['• Ran git status', '', '• Working (2s • esc to interrupt)'].join('\n'))}`;
    const codex = [manifest('codex')];
    expect(run('grid', codex, 'codex', [approval, working])).toEqual([
      { state: 'blocked', matchedRuleId: 'live_strong_blocker', visibleBlocker: true },
      { state: 'working', matchedRuleId: 'screen_working_fallback', visibleBlocker: false },
    ]);
    const text = run('text', codex, 'codex', [approval, working]);
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((record) => record.state === 'blocked')).toBe(true);
  });
});
