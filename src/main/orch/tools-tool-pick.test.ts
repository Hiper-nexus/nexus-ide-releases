import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jev/jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: () => ({}),
  jevAnswerConfidences: () => ({}),
}));
vi.mock('../jev/jev-secrets', () => ({ hasJevCredential: vi.fn(() => true) }));

import { hasJevCredential } from '../jev/jev-secrets';
import { resetJevRateLimitsForTesting } from '../jev/jev-rate-limit';
import type { JevResult, JudgeInput } from '../jev/jev-client';
import type { McpToolDef } from './mcp-protocol';
import { mintToken, resetGateForTests } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  buildToolPickTools,
  prefilterCandidates,
  runToolPick,
  tokenize,
  visibleToolsFor,
} from './tools-tool-pick';

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;

const scope = testProjectScope({ rootRealPath: '/tmp/nexus-tool-pick-test' });

function tool(name: string, description: string, extra: Partial<McpToolDef> = {}): McpToolDef {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({}),
    ...extra,
  };
}

const TOOLS: McpToolDef[] = [
  tool('nexus_pane_read', 'Read the recent terminal output of ONE pane by id.'),
  tool('nexus_pane_read_many', 'Read the recent output of SEVERAL panes at once.'),
  tool('nexus_pane_write', 'Type text into another pane (effectful).'),
  tool('nexus_file_write', 'Write a file in the workspace.'),
  tool('nexus_git_commit', 'Create a git commit with the staged changes.'),
  tool('nexus_browser_open', 'Open a URL in the Nexus browser pane.'),
  tool('nexus_memory_recall', 'Recall notes from the agentic memory.'),
  tool('nexus_handoff_submit', 'Submit your work handoff to the orchestrator.'),
  tool('nexus_pane_list', 'List the panes of the mission.'),
  tool('nexus_terminal_run', 'Run a shell command in the workspace.'),
  tool('nexus_tool_pick', 'itself'),
  tool('nexus_secret_tool', 'Hidden without credential', { available: () => false }),
];

function userCtx(allowedTools: string[] | null = null, readOnly = false) {
  resetGateForTests();
  return mintToken({
    label: 'tool-pick-test',
    role: 'worker',
    missionId: 'm1',
    scope,
    allowedTools,
    allowedSkills: null,
    readOnly,
  });
}

function choice(probabilities: Record<string, number>, confidence = 0.7): JevResult {
  const [choiceId] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return {
    model: 'jev-test',
    answers: { tool: { type: 'choice', choice: choiceId, probabilities, confidence } },
    usage: { input_tokens: 400, output_tokens: 30 },
  };
}

beforeEach(() => {
  resetJevRateLimitsForTesting();
  vi.mocked(hasJevCredential).mockReturnValue(true);
});

describe('tokenize / prefilter', () => {
  it('normalizes accents and expands pt-BR synonyms', () => {
    const tokens = tokenize('ver o que outro pane está fazendo agora');
    expect(tokens).toEqual(expect.arrayContaining(['ver', 'read', 'inspect', 'pane', 'peer']));
    expect(tokens).not.toContain('o');
  });

  it('ranks tools whose NAME matches above description-only matches and fills to 8', () => {
    const candidates = prefilterCandidates('ver o que outro pane está fazendo', TOOLS.slice(0, 10));
    expect(candidates[0]!.name).toMatch(/nexus_pane_read/);
    expect(candidates.length).toBeGreaterThanOrEqual(8);
    expect(candidates.some((c) => c.name === 'nexus_git_commit')).toBe(true); // filler
  });
});

describe('visibleToolsFor', () => {
  it('excludes itself, unavailable tools and tools outside the allowlist', () => {
    const visible = visibleToolsFor(userCtx(['nexus_pane_read', 'nexus_file_write']), TOOLS).map(
      (t) => t.name,
    );
    expect(visible).not.toContain('nexus_tool_pick');
    expect(visible).not.toContain('nexus_secret_tool');
    expect(visible).toContain('nexus_pane_read');
    expect(visible).toContain('nexus_file_write');
    // ALWAYS_ALLOWED observation tools stay visible even with a strict allowlist.
    expect(visible).toContain('nexus_pane_list');
    expect(visible).not.toContain('nexus_git_commit');
  });

  it('hides effectful tools from a read-only context', () => {
    const visible = visibleToolsFor(userCtx(null, true), TOOLS).map((t) => t.name);
    expect(visible).toContain('nexus_pane_read');
    expect(visible).not.toContain('nexus_terminal_run');
  });
});

describe('runToolPick', () => {
  it('returns ranked picks with margin, none and confidence; records one decision', async () => {
    const judge = vi.fn<JudgeMock>(async () =>
      choice({ pane_read: 0.6, pane_read_many: 0.3, pane_list: 0.05, none: 0.05 }, 0.55),
    );
    const out = await runToolPick(
      { need: 'ver o que outro pane está fazendo agora', limit: 2 },
      userCtx(),
      undefined,
      { judge, tools: TOOLS },
    );
    expect(out.top).toBe('nexus_pane_read');
    expect(out.picks).toEqual([
      expect.objectContaining({ tool: 'nexus_pane_read', probability: 0.6 }),
      expect.objectContaining({ tool: 'nexus_pane_read_many', probability: 0.3 }),
    ]);
    expect(out.margin).toBeCloseTo(0.3);
    expect(out.none).toBe(0.05);
    expect(out.confidence).toBe(0.55);
    // The question offered the candidates by canonical id plus `none`.
    const question = judge.mock.calls[0]![0].questions.tool;
    expect(question.type).toBe('choice');
    if (question.type === 'choice') {
      expect(Object.keys(question.criteria)).toContain('pane_read');
      expect(Object.keys(question.criteria)).toContain('none');
      expect(Object.keys(question.criteria)).not.toContain('tool_pick');
      expect(question.criteria.pane_read).toContain('nexus_pane_read:');
    }
  });

  it('never recommends a tool the caller cannot see', async () => {
    const judge = vi.fn<JudgeMock>(async (input) => {
      const q = input.questions.tool;
      const ids = q.type === 'choice' ? Object.keys(q.criteria) : [];
      expect(ids).not.toContain('git_commit');
      return choice({ pane_read: 0.9, none: 0.1 });
    });
    await runToolPick(
      { need: 'fazer commit das mudanças' },
      userCtx(['nexus_pane_read', 'nexus_file_write']),
      undefined,
      { judge, tools: TOOLS },
    );
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('rejects bad arguments, missing credential and rate-limit exhaustion', async () => {
    const judge = vi.fn<JudgeMock>(async () => choice({ pane_read: 1 }));
    await expect(
      runToolPick({ need: '' }, userCtx(), undefined, { judge, tools: TOOLS }),
    ).rejects.toThrow(/argumentos inválidos/);
    vi.mocked(hasJevCredential).mockReturnValue(false);
    await expect(
      runToolPick({ need: 'x' }, userCtx(), undefined, { judge, tools: TOOLS }),
    ).rejects.toThrow(/indisponível/);
    vi.mocked(hasJevCredential).mockReturnValue(true);
    const ctx = userCtx();
    for (let i = 0; i < 30; i += 1) {
      await runToolPick({ need: 'ler pane' }, ctx, undefined, { judge, tools: TOOLS });
    }
    await expect(
      runToolPick({ need: 'ler pane' }, ctx, undefined, { judge, tools: TOOLS }),
    ).rejects.toThrow(/limite de 30 chamadas/);
  });

  it('service unavailable → error telling the agent to choose itself', async () => {
    await expect(
      runToolPick({ need: 'ler pane' }, userCtx(), undefined, {
        judge: vi.fn(async () => null),
        tools: TOOLS,
      }),
    ).rejects.toThrow(/indisponível agora/);
  });

  it('o toggle "Recomendação de ferramenta" desligado tira a ferramenta e explica onde religar', async () => {
    const judge = vi.fn<JudgeMock>(async () => choice({ pane_read: 1 }));
    const [def] = buildToolPickTools();
    process.env.NEXUS_JEV_SURFACE_TOOLPICK = '0';
    try {
      expect(def!.available?.()).toBe(false);
      await expect(
        runToolPick({ need: 'ler pane' }, userCtx(), undefined, { judge, tools: TOOLS }),
      ).rejects.toThrow(/Recomendação de ferramenta/);
      expect(judge).not.toHaveBeenCalled();
    } finally {
      delete process.env.NEXUS_JEV_SURFACE_TOOLPICK;
    }
    expect(def!.available?.()).toBe(true);
  });

  it('exposes the tool def with the availability predicate', () => {
    const [def] = buildToolPickTools();
    expect(def!.name).toBe('nexus_tool_pick');
    expect(def!.available?.()).toBe(true);
    vi.mocked(hasJevCredential).mockReturnValue(false);
    expect(def!.available?.()).toBe(false);
  });
});
