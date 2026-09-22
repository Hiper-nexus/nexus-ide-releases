import { afterAll, beforeAll, describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentGateContext } from './gate';
import type { JevResult } from '../jev/jev-client';
import type { DesktopControl, DesktopElement } from '../vision/desktop-control';
import { DesktopElementGone } from '../vision/desktop-control';
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

import {
  buildComputerAutopilotTools,
  isTerminalApp,
  type ComputerDoDeps,
} from './tools-computer-autopilot';

// A ferramenta só existe no macOS; o CI roda em Linux. A suíte exercita o
// laço com o DesktopControl mockado, então fixa a plataforma como darwin e
// restaura no fim (o caso não-darwin tem teste próprio em desktop-control).
const ORIGINAL_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
});

const scope = testProjectScope({ rootRealPath: '/tmp/nexus-computer-do-test' });
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

const WORKER_CTX = { ...ctx, role: 'worker' } as AgentGateContext;

function el(overrides: Partial<DesktopElement>): DesktopElement {
  return {
    i: 0,
    role: 'AXButton',
    name: 'Save',
    enabled: true,
    frame: { x: 100, y: 100, w: 80, h: 30 },
    sensitive: false,
    actions: ['AXPress'],
    kind: 'clickable',
    ...overrides,
  };
}

const AX_ELEMENTS: DesktopElement[] = [
  el({ i: 0, role: 'AXButton', name: 'Save', kind: 'clickable' }),
  el({ i: 1, role: 'AXTextField', name: 'Name', actions: [], kind: 'textfield' }),
  el({
    i: 2,
    role: 'AXSecureTextField',
    name: 'Password',
    actions: [],
    kind: 'textfield',
    sensitive: true,
  }),
];

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function fakeControl(overrides: Partial<DesktopControl> = {}): DesktopControl {
  return {
    accessibilityStatus: vi.fn(() => 'granted' as const),
    requestAccessibility: vi.fn(() => 'granted' as const),
    frontmostApp: vi.fn(async () => 'MyApp'),
    activate: vi.fn(async () => undefined),
    listElements: vi.fn(async () => ({
      windowTitle: 'MyApp — Doc',
      elements: AX_ELEMENTS,
    })),
    press: vi.fn(async () => undefined),
    doubleClick: vi.fn(async () => undefined),
    setValue: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => undefined),
    captureWindow: vi.fn(async () => null),
    ...overrides,
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
      confidence: 0.9,
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
  control: DesktopControl;
  recognizeLines: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  screenPermission: ReturnType<typeof vi.fn>;
  userDataDir: ReturnType<typeof vi.fn>;
}

function makeDeps(controlOverrides: Partial<DesktopControl> = {}): Deps {
  return {
    judge: vi.fn(async () => judgeResult('DONE', { done: 0.95 })),
    control: fakeControl(controlOverrides),
    recognizeLines: vi.fn(async () => []),
    settle: vi.fn(async () => undefined),
    screenPermission: vi.fn(() => 'denied'),
    userDataDir: vi.fn(() => '/tmp/nexus-computer-do-userdata'),
  };
}

function toolFor(deps: Deps) {
  return buildComputerAutopilotTools(
    deps as unknown as ComputerDoDeps,
  )[0]!;
}

const baseArgs = { app: 'MyApp', goal: 'save the document' };

describe('nexus_computer_do', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.hasJevCredential.mockReturnValue(true);
  });

  it('returns permission_required and asks once when Accessibility is missing', async () => {
    const deps = makeDeps({
      accessibilityStatus: vi.fn(() => 'denied' as const),
      requestAccessibility: vi.fn(() => 'denied' as const),
    });
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      permission: string;
      howTo: string;
    };
    expect(out.status).toBe('permission_required');
    expect(out.permission).toBe('accessibility');
    expect(out.howTo).toContain('Acessibilidade');
    expect(deps.control.requestAccessibility).toHaveBeenCalledTimes(1);
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it.each(['Terminal', 'iTerm2', 'Ghostty', 'warp', 'Termius', '  WezTerm  '])(
    'recusa o terminal externo %s antes de tocar o desktop (conteúdo nunca vaza para um terminal)',
    async (app) => {
      expect(isTerminalApp(app)).toBe(true);
      const deps = makeDeps();
      const out = (await toolFor(deps).handler({ ...baseArgs, app }, ctx)) as {
        status: string;
        error: string;
      };
      expect(out.status).toBe('error');
      expect(out.error).toContain('é um terminal');
      expect(deps.control.activate).not.toHaveBeenCalled();
      expect(deps.judge).not.toHaveBeenCalled();
    },
  );

  it('não confunde app comum com terminal', () => {
    expect(isTerminalApp('Safari')).toBe(false);
    expect(isTerminalApp('Terminator Notes')).toBe(false);
  });

  it('refuses workers — only operator/orchestrator drive the desktop', async () => {
    const deps = makeDeps();
    await expect(toolFor(deps).handler(baseArgs, WORKER_CTX)).rejects.toThrow(
      /só a mão do operador ou o orquestrador/,
    );
    expect(deps.control.activate).not.toHaveBeenCalled();
  });

  it('errors when the app does not come to the foreground', async () => {
    const deps = makeDeps({
      frontmostApp: vi.fn(async () => 'Finder'),
    });
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      error: string;
    };
    expect(out.status).toBe('error');
    expect(out.error).toContain('primeiro plano');
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it('stops done when the goal is achieved; logs one entry per step', async () => {
    const deps = makeDeps();
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      steps: unknown[];
    };
    expect(out.status).toBe('done');
    expect(out.steps).toHaveLength(1);
    expect(deps.control.press).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toMatchObject({
      surface: 'computerTool',
      decision: 'DONE',
      sessionId: 'sess-1',
      missionId: 'm-1',
    });
  });

  it('stops blocked when progress needs the human', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(judgeResult('BLOCKED', { blocked: 0.9 }));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('blocked');
  });

  it('low-confidence DONE cannot finish — stops uncertain with elements', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('DONE', { opConfidence: 0.3, done: 0.2 }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      elements: Array<Record<string, unknown>>;
    };
    expect(out.status).toBe('uncertain');
    expect(out.elements).toHaveLength(3);
    expect(out.elements[0]).not.toHaveProperty('frame');
  });

  it('stops needs_confirmation on irreversible and saves one capture when granted', async () => {
    const deps = makeDeps({
      captureWindow: vi.fn(async () => ({
        png: VALID_PNG,
        frame: { x: 0, y: 0, w: 400, h: 300 },
        scale: 2,
      })),
    });
    deps.screenPermission.mockReturnValue('granted');
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { irreversible: 0.9, clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      proposed: { operation: string; target: { name: string } };
      capturePath?: string;
    };
    expect(out.status).toBe('needs_confirmation');
    expect(out.proposed.operation).toBe('CLICK');
    expect(out.proposed.target.name).toBe('Save');
    expect(out.capturePath).toContain('/tmp/nexus-computer-do-userdata/jev/computer/');
    expect(out.capturePath).toMatch(/confirm\.png$/);
    expect(deps.control.press).not.toHaveBeenCalled();
  });

  it('needs_confirmation without screen permission has no capturePath', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { irreversible: 0.9, clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      capturePath?: string;
    };
    expect(out.status).toBe('needs_confirmation');
    expect(out.capturePath).toBeUndefined();
    expect(deps.control.captureWindow).not.toHaveBeenCalled();
  });

  it('CLICK presses the chosen element', async () => {
    const deps = makeDeps();
    deps.judge
      .mockResolvedValueOnce(judgeResult('CLICK', { clickTarget: 'e0' }))
      .mockResolvedValueOnce(judgeResult('DONE', { done: 0.95 }));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('done');
    expect(deps.control.press).toHaveBeenCalledWith('MyApp', {
      role: 'AXButton',
      name: 'Save',
      frame: { x: 100, y: 100, w: 80, h: 30 },
    });
    expect(h.record).toHaveBeenCalledTimes(2);
  });

  it('TYPE_TEXT into a sensitive field stops error without typing', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('TYPE_TEXT', { typeTarget: 'e2', typeValue: 'pw' }),
    );
    const out = (await toolFor(deps).handler(
      { ...baseArgs, values: { pw: 'segredo123' } },
      ctx,
    )) as { status: string; error: string };
    expect(out.status).toBe('error');
    expect(out.error).toContain('sensível');
    expect(deps.control.setValue).not.toHaveBeenCalled();
  });

  it('TYPE_TEXT types only a provided value; Jev sees labels only', async () => {
    const deps = makeDeps();
    deps.judge
      .mockResolvedValueOnce(
        judgeResult('TYPE_TEXT', { typeTarget: 'e1', typeValue: 'name' }),
      )
      .mockResolvedValueOnce(judgeResult('DONE', { done: 0.95 }));
    const out = (await toolFor(deps).handler(
      { ...baseArgs, values: { name: 'Ana Souza' } },
      ctx,
    )) as { status: string };
    expect(out.status).toBe('done');
    expect(deps.control.setValue).toHaveBeenCalledWith(
      'MyApp',
      { role: 'AXTextField', name: 'Name', frame: { x: 100, y: 100, w: 80, h: 30 } },
      'Ana Souza',
    );
    const state = deps.judge.mock.calls[0]![0].state as { values: unknown };
    expect(state.values).toEqual(['name']);
    expect(JSON.stringify(state)).not.toContain('Ana Souza');
  });

  it('stops focus_lost when the app loses the foreground mid-loop', async () => {
    const frontmost = vi
      .fn()
      .mockResolvedValueOnce('MyApp') // precondition
      .mockResolvedValueOnce('MyApp') // step 1 check
      .mockResolvedValue('OtherApp');
    const deps = makeDeps({ frontmostApp: frontmost });
    deps.judge.mockResolvedValue(judgeResult('WAIT'));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('focus_lost');
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
  });

  it('falls back to local OCR when AX yields < 3 elements (px→pt conversion)', async () => {
    const deps = makeDeps({
      listElements: vi.fn(async () => ({ windowTitle: 'Win', elements: [] })),
      captureWindow: vi.fn(async () => ({
        png: VALID_PNG,
        frame: { x: 50, y: 60, w: 400, h: 300 },
        scale: 2,
      })),
    });
    deps.recognizeLines.mockResolvedValue([
      {
        text: 'Open File',
        confidence: 90,
        bbox: { x0: 20, y0: 40, x1: 120, y1: 60 },
      },
    ]);
    deps.judge
      .mockResolvedValueOnce(judgeResult('CLICK', { clickTarget: 'e0' }))
      .mockResolvedValueOnce(judgeResult('DONE', { done: 0.95 }));
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('done');
    expect(deps.control.captureWindow).toHaveBeenCalledWith('MyApp');
    // bbox (20,40)-(120,60)px ÷ scale 2 → (10,20)-(60,30)pt + origem (50,60).
    expect(deps.control.press).toHaveBeenCalledWith('MyApp', {
      role: 'text',
      name: 'Open File',
      frame: { x: 60, y: 80, w: 50, h: 10 },
    });
    // O Jev viu a linha OCR como elemento clicável, sem frame.
    const state = deps.judge.mock.calls[0]![0].state as {
      elements: Array<Record<string, unknown>>;
    };
    expect(state.elements[0]).toMatchObject({
      role: 'text',
      name: 'Open File',
      kind: 'clickable',
    });
    expect(state.elements[0]).not.toHaveProperty('frame');
  });

  it('stops uncertain when neither AX nor OCR yields elements', async () => {
    const deps = makeDeps({
      listElements: vi.fn(async () => ({ windowTitle: 'Win', elements: [] })),
      captureWindow: vi.fn(async () => null),
    });
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
    };
    expect(out.status).toBe('uncertain');
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it('stops uncertain after 3 identical steps on an unchanged screen', async () => {
    const deps = makeDeps();
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      error: string;
      steps: unknown[];
    };
    expect(out.status).toBe('uncertain');
    expect(out.error).toContain('sem progresso');
    expect(out.steps).toHaveLength(3);
    expect(deps.control.press).toHaveBeenCalledTimes(2);
  });

  it('DesktopElementGone stops uncertain (a tela mudou)', async () => {
    const deps = makeDeps({
      press: vi.fn(async () => {
        throw new DesktopElementGone();
      }),
    });
    deps.judge.mockResolvedValue(
      judgeResult('CLICK', { clickTarget: 'e0' }),
    );
    const out = (await toolFor(deps).handler(baseArgs, ctx)) as {
      status: string;
      error: string;
    };
    expect(out.status).toBe('uncertain');
    expect(out.error).toContain('tela mudou');
  });

  it('is unavailable without credential or on non-darwin', async () => {
    const deps = makeDeps();
    const tool = toolFor(deps);
    expect(tool.available?.()).toBe(process.platform === 'darwin');
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
      timeoutMs: 8_000,
    });
  });

  it('requires one human confirmation per goal (declarative flag)', () => {
    expect(toolFor(makeDeps()).requiresConfirm).toBe(true);
  });
});
