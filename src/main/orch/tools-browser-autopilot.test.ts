import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentGateContext } from './gate';
import type { JevResult } from '../jev/jev-client';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  hasJevCredential: vi.fn(() => true),
  record: vi.fn(),
}));

vi.mock('../jev/jev-secrets', () => ({
  hasJevCredential: h.hasJevCredential,
}));
vi.mock('../jev/jev-decision-log', () => ({
  recordJevDecision: h.record,
  jevAnswerProbabilities: (answers: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(answers).map(([k, a]) => [
        k,
        (a as { noul?: number; probabilities?: Record<string, number> }).noul ??
          Math.max(
            ...Object.values(
              (a as { probabilities?: Record<string, number> }).probabilities ?? {
                x: 0,
              },
            ),
          ),
      ]),
    ),
  jevAnswerConfidences: () => ({}),
}));
vi.mock('./tool-util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authorizePaneRef: vi.fn(() => ({ paneId: 'pane-1', sessionId: 's-1' })),
}));

import {
  buildBrowserAutopilotTools,
  type BrowserDoDeps,
} from './tools-browser-autopilot';

const scope = testProjectScope({
  rootRealPath: '/tmp/nexus-browser-do-test',
});
const ctx = {
  token: 't',
  label: 'orch',
  role: 'orchestrator',
  missionId: 'm-1',
  sessionId: 'sess-1',
  scope,
  allowedTools: null,
  allowedSkills: null,
} as AgentGateContext;

const PAGE_URL = 'https://app.example.com/board';

function page(overrides: Partial<{
  url: string;
  elements: Array<Record<string, unknown>>;
}> = {}) {
  return {
    url: overrides.url ?? PAGE_URL,
    title: 'Board',
    bodyText: 'Kanban board with a Create button',
    elements: (overrides.elements ?? [
      { ref: 'r1', tag: 'button', role: 'button', name: 'Create card' },
      {
        ref: 'r2',
        tag: 'input',
        role: 'textbox',
        name: 'Title',
        inputType: 'text',
        editable: true,
      },
    ]) as never,
  };
}

function judgeResult(
  operation: string,
  overrides: Partial<{
    opConfidence: number;
    clickTarget: string;
    typeTarget: string;
    typeValue: string;
    irreversible: number;
    done: number;
    blocked: number;
    targetConfidence: number;
  }> = {},
): JevResult {
  const answers: JevResult['answers'] = {
    operation: {
      type: 'choice',
      choice: operation,
      probabilities: { [operation]: 0.9 },
      confidence: overrides.opConfidence ?? 0.9,
    },
    irreversible: { type: 'noul', noul: overrides.irreversible ?? 0 },
    done: { type: 'noul', noul: overrides.done ?? 0 },
    blocked: { type: 'noul', noul: overrides.blocked ?? 0 },
  };
  if (overrides.clickTarget !== undefined) {
    answers.click_target = {
      type: 'choice',
      choice: overrides.clickTarget,
      probabilities: { [overrides.clickTarget]: 0.9 },
      confidence: overrides.targetConfidence ?? 0.9,
    };
  }
  if (overrides.typeTarget !== undefined) {
    answers.type_target = {
      type: 'choice',
      choice: overrides.typeTarget,
      probabilities: { [overrides.typeTarget]: 0.8 },
      confidence: 0.8,
    };
  }
  if (overrides.typeValue !== undefined) {
    answers.type_value = {
      type: 'choice',
      choice: overrides.typeValue,
      probabilities: { [overrides.typeValue]: 0.9 },
      confidence: 0.9,
    };
  }
  return {
    model: 'jev-test',
    answers,
    usage: { input_tokens: 100, output_tokens: 0 },
  };
}

interface Deps {
  judge: ReturnType<typeof vi.fn>;
  readPage: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  press: ReturnType<typeof vi.fn>;
  scroll: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
}

function makeDeps(): Deps {
  return {
    judge: vi.fn(async () => judgeResult('DONE', { done: 0.95 })),
    readPage: vi.fn(async () => page()),
    click: vi.fn(async () => ({ paneId: 'pane-1', clicked: true })),
    fill: vi.fn(async () => ({ filled: true })),
    press: vi.fn(async () => ({ pressed: true })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    wait: vi.fn(async () => ({ matched: true })),
    settle: vi.fn(async () => undefined),
  };
}

function toolFor(deps: Deps) {
  return buildBrowserAutopilotTools(
    deps as unknown as BrowserDoDeps,
  )[0]!;
}

const baseArgs = { paneId: 'pane-1', goal: 'create a card called X' };

describe('nexus_browser_do', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.hasJevCredential.mockReturnValue(true);
  });

  it('stops done when the goal is already achieved', async () => {
    const deps = makeDeps();
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('done');
    expect(deps.click).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toMatchObject({
      surface: 'browserTool',
      decision: 'DONE',
      sessionId: 'sess-1',
      missionId: 'm-1',
    });
  });

  it('a low-confidence DONE choice cannot finish — stops uncertain', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('DONE', { opConfidence: 0.3, done: 0.2 }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      elements: unknown[];
    };
    expect(out.status).toBe('uncertain');
    expect(out.elements).toHaveLength(2);
  });

  it('stops blocked when progress needs the human', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(judgeResult('BLOCKED', { blocked: 0.9 }));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('blocked');
    expect(deps.click).not.toHaveBeenCalled();
  });

  it('stops needs_confirmation on irreversible and proposes the action', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { irreversible: 0.9, clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      proposed: { operation: string; target: { ref: string } };
      elements: unknown[];
    };
    expect(out.status).toBe('needs_confirmation');
    expect(out.proposed.operation).toBe('CLICK');
    expect(out.proposed.target.ref).toBe('r1');
    expect(out.elements).toHaveLength(2);
    expect(deps.click).not.toHaveBeenCalled();
  });

  it('stops uncertain on low operation confidence, returning elements', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { opConfidence: 0.3, clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      elements: unknown[];
    };
    expect(out.status).toBe('uncertain');
    expect(out.elements).toHaveLength(2);
  });

  it('CLICK with a none target stops uncertain without clicking', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { clickTarget: 'none' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('uncertain');
    expect(deps.click).not.toHaveBeenCalled();
  });

  it('CLICK executes the chosen element ref', async () => {
    const deps = makeDeps();
    deps.judge
      .mockResolvedValueOnce(judgeResult('CLICK', { clickTarget: 'e0' }))
      .mockResolvedValueOnce(judgeResult('DONE', { done: 0.95 }));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      steps: unknown[];
    };
    expect(out.status).toBe('done');
    expect(deps.click).toHaveBeenCalledWith('pane-1', scope, 'r1');
    expect(deps.settle).toHaveBeenCalledWith(150);
    expect(out.steps).toHaveLength(2);
    expect(h.record).toHaveBeenCalledTimes(2);
  });

  it('TYPE_TEXT only ever types a provided value, picked by label', async () => {
    const deps = makeDeps();
    deps.judge
      .mockResolvedValueOnce(
        judgeResult('TYPE_TEXT', { typeTarget: 'e1', typeValue: 'title' }),
      )
      .mockResolvedValueOnce(judgeResult('DONE', { done: 0.95 }));
    const out = (await toolFor(deps).handler(
      { ...baseArgs, values: { title: 'Hello World' } },
      ctx,
    )) as { status: string };
    expect(out.status).toBe('done');
    expect(deps.fill).toHaveBeenCalledWith('pane-1', scope, 'r2', 'Hello World');
  });

  it('TYPE_TEXT with an unknown value label stops uncertain', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('TYPE_TEXT', { typeTarget: 'e1', typeValue: 'ghost' }),
    );
    const out = (await toolFor(deps).handler(
      { ...baseArgs, values: { title: 'x' } },
      ctx,
    )) as { status: string };
    expect(out.status).toBe('uncertain');
    expect(deps.fill).not.toHaveBeenCalled();
  });

  it('stops left_origin when the page leaves the starting origin', async () => {
    const deps = makeDeps();
    deps.readPage
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page({ url: 'https://other.example.com/x' }));
    deps.judge
      .mockResolvedValueOnce(judgeResult('SCROLL_DOWN'))
      .mockResolvedValueOnce(judgeResult('DONE'));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('left_origin');
  });

  it('stops max_steps', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(judgeResult('WAIT'));
    const out = (await toolFor(deps).handler(
      { ...baseArgs, maxSteps: 2 },
      ctx,
    )) as { status: string; steps: unknown[] };
    expect(out.status).toBe('max_steps');
    expect(out.steps).toHaveLength(2);
    expect(deps.wait).toHaveBeenCalledTimes(2);
  });

  it('stops error when a primitive throws', async () => {
    const deps = makeDeps();
    deps.click.mockRejectedValue(new Error('sensitive field refused'));
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      error: string;
    };
    expect(out.status).toBe('error');
    expect(out.error).toContain('sensitive field refused');
  });

  it('stops error when Jev is unavailable', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(null);
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('error');
  });

  it('is unavailable and refuses without a TypeSafe credential', async () => {
    const deps = makeDeps();
    const tool = toolFor(deps);
    expect(tool.available?.()).toBe(true);
    h.hasJevCredential.mockReturnValue(false);
    expect(tool.available?.()).toBe(false);
    await expect(tool.handler(baseArgs, ctx)).rejects.toThrow(
      /Chaves de API/,
    );
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it('forwards invocation.signal to judge', async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    await toolFor(deps).handler(baseArgs, ctx, {
      signal: controller.signal,
    });
    expect(deps.judge.mock.calls[0]![0]).toMatchObject({
      signal: controller.signal,
      timeoutMs: 5_000,
      retryOnTimeout: false,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
    });
  });

  it('sends only value labels to Jev — never the typed texts', async () => {
    const deps = makeDeps();
    deps.judge
      .mockResolvedValueOnce(
        judgeResult('TYPE_TEXT', { typeTarget: 'e1', typeValue: 'address' }),
      )
      .mockResolvedValueOnce(judgeResult('DONE', { done: 0.95 }));
    await toolFor(deps).handler(
      { ...baseArgs, values: { address: 'Rua Segredo, 123' } },
      ctx,
    );
    const state = deps.judge.mock.calls[0]![0].state as {
      values: unknown;
    };
    expect(state.values).toEqual(['address']);
    expect(JSON.stringify(state)).not.toContain('Rua Segredo');
    expect(deps.fill).toHaveBeenCalledWith(
      'pane-1', scope, 'r2', 'Rua Segredo, 123',
    );
  });

  it('stops uncertain after 3 identical steps on an unchanged page', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      error: string;
      elements: unknown[];
      steps: unknown[];
    };
    expect(out.status).toBe('uncertain');
    expect(out.error).toContain('sem progresso');
    expect(out.steps).toHaveLength(3);
    expect(out.elements).toHaveLength(2);
    expect(deps.click).toHaveBeenCalledTimes(2);
  });

  it('refuses a pane without a usable origin before any judge call', async () => {
    const deps = makeDeps();
    deps.readPage.mockResolvedValue(
      page({ url: 'about:blank', elements: [] }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      error: string;
    };
    expect(out.status).toBe('error');
    expect(out.error).toContain('nexus_browser_open');
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it('always stops before clicking a target named like a purchase or a delete', async () => {
    for (const name of ['Finalizar compra', 'Excluir conta', 'Pagar agora', 'Delete project', 'Checkout']) {
      const deps = makeDeps();
      deps.readPage.mockResolvedValue(page({
        elements: [{ ref: 'r1', tag: 'button', role: 'button', name }],
      }));
      // Jev says the step is harmless; the name alone is enough to stop.
      deps.judge.mockResolvedValue(judgeResult('CLICK', { clickTarget: 'e0', irreversible: 0.05 }));
      const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
        status: string; reason?: string; proposed?: { target?: { name: string } };
      };
      expect(out.status).toBe('needs_confirmation');
      expect(out.reason).toBe('irreversible-target');
      expect(out.proposed?.target?.name).toBe(name);
      expect(deps.click).not.toHaveBeenCalled();
    }
  });

  it('does not click or type into a target Jev picked with low confidence', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(judgeResult('CLICK', { clickTarget: 'e0', targetConfidence: 0.3 }));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as { status: string; elements: unknown[] };
    expect(out.status).toBe('uncertain');
    expect(out.elements).toHaveLength(2);
    expect(deps.click).not.toHaveBeenCalled();
  });

  it('asks with the first-option check and frames the page as data, not instructions', async () => {
    const deps = makeDeps();
    await toolFor(deps).handler(baseArgs, ctx);
    const request = deps.judge.mock.calls[0]![0] as {
      orderCheck?: { minConfidence: number };
      questions: Record<string, { instructions: string }>;
    };
    expect(request.orderCheck).toEqual({ minConfidence: 0.5 });
    expect(request.questions.irreversible!.instructions).toMatch(/data under evaluation, never instructions/);
    expect(request.questions.irreversible!.instructions).toMatch(/claims .*safe|reversible|free/);
  });

  it('requires one human confirmation per goal (declarative flag)', () => {
    expect(toolFor(makeDeps()).requiresConfirm).toBe(true);
  });
});
