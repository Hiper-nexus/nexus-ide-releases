import crypto from 'node:crypto';
import { z } from 'zod';
import {
  clickBrowserElement,
  fillBrowserElement,
  pressBrowserKey,
  readBrowserPage,
  scrollBrowserPane,
  waitForBrowser,
} from '../browser/browser-manager';
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
  type JevAnswer,
  type JevQuestion,
  type JevResult,
} from '../jev/jev-client';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from './mcp-protocol';
import { authorizePaneRef, requireStr } from './tool-util';
import type { AgentGateContext } from './gate';
import type { ProjectExecutionScope } from '../../shared/types';

const JUDGE_TIMEOUT_MS = 8_000;
const READ_MAX_CHARS = 3_000;
const READ_MAX_ELEMENTS = 120;
const SETTLE_MS = 2_000;
const WAIT_MS = 3_000;
const HISTORY_LEN = 5;

export const browserDoArgsSchema = z.object({
  paneId: z.string().min(1),
  goal: z.string().min(1).max(2_000),
  values: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(2_000))
    .refine((v) => Object.keys(v).length <= 12, {
      message: 'at most 12 values',
    })
    .optional(),
  maxSteps: z.number().int().min(1).max(40).default(25),
});

interface IndexedElement {
  i: number;
  ref: string;
  role: string;
  name: string;
  value?: string;
  kind: 'clickable' | 'textfield' | 'other';
}

interface PageRead {
  url: string;
  title: string;
  bodyText: string;
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    name: string;
    inputType?: string;
    editable?: boolean;
    disabled?: boolean;
  }>;
}

const CLICKABLE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'combobox',
  'listbox',
  'treeitem',
]);

function classifyElement(el: PageRead['elements'][number]): IndexedElement['kind'] {
  if (el.disabled) return 'other';
  const tag = el.tag.toLowerCase();
  if (
    el.editable === true ||
    tag === 'textarea' ||
    (tag === 'input' &&
      !['button', 'submit', 'checkbox', 'radio', 'file', 'hidden', 'image', 'reset'].includes(
        (el.inputType ?? 'text').toLowerCase(),
      ))
  ) {
    return 'textfield';
  }
  const role = el.role.toLowerCase();
  if (tag === 'a' || tag === 'button' || CLICKABLE_ROLES.has(role)) {
    return 'clickable';
  }
  return 'other';
}

function buildElementTable(read: PageRead): IndexedElement[] {
  return read.elements.map((el, i) => ({
    i,
    ref: el.ref,
    role: el.role || el.tag,
    name: el.name,
    kind: classifyElement(el),
  }));
}

/** Fingerprint da tabela de elementos — base do detector de travamento. */
function tableHash(table: IndexedElement[]): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(table.map((e) => [e.ref, e.role, e.name, e.value ?? ''])),
    )
    .digest('hex');
}

function choiceAnswer(
  answers: Record<string, JevAnswer>,
  key: string,
): { choice: string; probabilities: Record<string, number>; confidence: number } | null {
  const a = answers[key];
  return a && a.type === 'choice' ? a : null;
}

function noulAnswer(answers: Record<string, JevAnswer>, key: string): number {
  const a = answers[key];
  return a && a.type === 'noul' ? a.noul : 0;
}

type StopStatus =
  | 'done'
  | 'blocked'
  | 'needs_confirmation'
  | 'uncertain'
  | 'max_steps'
  | 'left_origin'
  | 'error';

interface StepRecord {
  n: number;
  operation: string;
  target?: { ref: string; name: string };
  valueLabel?: string;
  url: string;
  probabilities: {
    operation: Record<string, number>;
    target?: Record<string, number>;
  };
  irreversible: number;
  done: number;
  blocked: number;
}

export interface BrowserDoDeps {
  judge?: typeof judge;
  readPage?: typeof readBrowserPage;
  click?: typeof clickBrowserElement;
  fill?: typeof fillBrowserElement;
  press?: typeof pressBrowserKey;
  scroll?: typeof scrollBrowserPane;
  wait?: typeof waitForBrowser;
  settle?: (ms: number) => Promise<void>;
}

const defaultSettle = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

function buildQuestions(
  clickables: IndexedElement[],
  textfields: IndexedElement[],
  valueLabels: string[],
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    operation: {
      type: 'choice',
      instructions:
        'Which single operation best advances the goal on this page?',
      criteria: {
        CLICK: 'click a button, link, checkbox, radio or option',
        TYPE_TEXT: 'type one of the provided values into a text field',
        PRESS_ENTER: 'press Enter in the focused field to submit',
        SCROLL_DOWN: 'scroll down to reveal more of the page',
        SCROLL_UP: 'scroll up',
        WAIT: 'wait for the page to finish loading or updating',
        DONE: 'the goal is already fully achieved on the current page',
        BLOCKED:
          'progress is impossible without the human: login, captcha, error, missing information',
      },
    },
    irreversible: {
      type: 'noul',
      instructions:
        'Would the most likely next action cause an irreversible or costly ' +
        'effect: purchase, payment, sending a message or email, deleting, ' +
        'publishing, or submitting a binding form?',
    },
    done: {
      type: 'noul',
      instructions:
        'Is the goal already fully achieved on the current page?',
    },
    blocked: {
      type: 'noul',
      instructions:
        'Is progress impossible without the human (login, captcha, error, ' +
        'missing information)?',
    },
  };
  if (clickables.length > 0) {
    questions.click_target = {
      type: 'choice',
      instructions: 'Which element should be clicked to advance the goal?',
      criteria: {
        ...Object.fromEntries(
          clickables.map((el) => [`e${el.i}`, el.name || el.role]),
        ),
        none: 'no listed element should be clicked now',
      },
    };
  }
  if (textfields.length > 0) {
    questions.type_target = {
      type: 'choice',
      instructions: 'Which text field should receive the typed value?',
      criteria: {
        ...Object.fromEntries(
          textfields.map((el) => [`e${el.i}`, el.name || el.role]),
        ),
        none: 'no listed field should receive text now',
      },
    };
  }
  if (valueLabels.length > 0) {
    questions.type_value = {
      type: 'choice',
      instructions: 'Which provided value should be typed?',
      criteria: {
        ...Object.fromEntries(valueLabels.map((l) => [l, `the value labelled "${l}"`])),
        none: 'no provided value should be typed now',
      },
    };
  }
  return questions;
}

async function runBrowserDo(
  args: z.infer<typeof browserDoArgsSchema>,
  ctx: AgentGateContext,
  invocation: McpToolInvocation | undefined,
  deps: BrowserDoDeps,
): Promise<Record<string, unknown>> {
  const judgeFn = deps.judge ?? judge;
  const readPage = deps.readPage ?? readBrowserPage;
  const click = deps.click ?? clickBrowserElement;
  const fill = deps.fill ?? fillBrowserElement;
  const press = deps.press ?? pressBrowserKey;
  const scroll = deps.scroll ?? scrollBrowserPane;
  const wait = deps.wait ?? waitForBrowser;
  const settle = deps.settle ?? defaultSettle;

  const paneId = args.paneId;
  const scope: ProjectExecutionScope = ctx.scope;
  const values = args.values ?? {};
  const valueLabels = Object.keys(values);
  const steps: StepRecord[] = [];
  const history: Array<{
    operation: string;
    target?: string;
    value?: string;
    url: string;
  }> = [];
  let lockedOrigin: string | null = null;
  let lastUrl = '';
  const tableHashes: string[] = [];

  const finish = (
    status: StopStatus,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    status,
    steps,
    finalUrl: lastUrl,
    ...extra,
  });

  for (let n = 1; n <= args.maxSteps; n += 1) {
    assertMcpInvocationCurrent(invocation);
    let read: PageRead;
    try {
      read = (await readPage(paneId, scope, {
        maxChars: READ_MAX_CHARS,
        maxElements: READ_MAX_ELEMENTS,
      })) as PageRead;
    } catch (err) {
      return finish('error', {
        error: `browser_do: leitura da página falhou: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    lastUrl = read.url;

    // Trava de origem: o primeiro read bem-sucedido fixa a origem do objetivo.
    let origin: string | null = null;
    try {
      origin = new URL(read.url).origin;
    } catch {
      origin = null;
    }
    if (lockedOrigin === null) {
      // Sem origem utilizável (about:blank, vazia, 'null') não há objetivo:
      // o agente precisa navegar o pane antes — erro antes de qualquer Jev.
      if (origin === null || origin === 'null') {
        return finish('error', {
          error:
            'browser_do: navegue o pane até o site alvo antes ' +
            '(nexus_browser_open/navigate)',
        });
      }
      lockedOrigin = origin;
    } else if (origin !== lockedOrigin) {
      return finish('left_origin');
    }

    const table = buildElementTable(read);
    tableHashes.push(tableHash(table));
    if (tableHashes.length > 3) tableHashes.shift();
    const clickables = table.filter((el) => el.kind === 'clickable');
    const textfields = table.filter((el) => el.kind === 'textfield');

    const questions = buildQuestions(clickables, textfields, valueLabels);
    const result: JevResult | null = await judgeFn({
      state: {
        goal: args.goal,
        // Privacidade: o Jev só mapeia label → campo. Os textos fornecidos
        // (dados do usuário) nunca saem da máquina por essa chamada.
        values: valueLabels,
        page: {
          url: read.url,
          title: read.title,
          text: capText(read.bodyText, READ_MAX_CHARS),
          elements: table,
        },
        history: history.slice(-HISTORY_LEN),
      },
      questions,
      timeoutMs: JUDGE_TIMEOUT_MS,
      signal: invocation?.signal,
      surface: 'browserTool',
    });
    assertMcpInvocationCurrent(invocation);

    if (!result) {
      return finish('error', {
        error: 'browser_do: modelo de decisão selecionado indisponível agora',
      });
    }

    const op = choiceAnswer(result.answers, 'operation');
    const operation = op?.choice ?? 'BLOCKED';
    const clickTarget = choiceAnswer(result.answers, 'click_target');
    const typeTarget = choiceAnswer(result.answers, 'type_target');
    const typeValue = choiceAnswer(result.answers, 'type_value');
    const irreversible = noulAnswer(result.answers, 'irreversible');
    const done = noulAnswer(result.answers, 'done');
    const blocked = noulAnswer(result.answers, 'blocked');

    const resolveTarget = (
      answer: { choice: string } | null,
      pool: IndexedElement[],
    ): IndexedElement | null => {
      if (!answer || answer.choice === 'none') return null;
      const idx = Number(answer.choice.replace(/^e/, ''));
      return pool.find((el) => el.i === idx) ?? null;
    };
    const clickEl = resolveTarget(clickTarget, clickables);
    const typeEl = resolveTarget(typeTarget, textfields);
    const valueLabel =
      typeValue && typeValue.choice !== 'none' ? typeValue.choice : null;

    recordJevDecision({
      surface: 'browserTool',
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: operation,
      inputTokens: result.usage.input_tokens,
      usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
    });

    const step: StepRecord = {
      n,
      operation,
      url: read.url,
      probabilities: {
        operation: op?.probabilities ?? {},
        ...(clickTarget ? { target: clickTarget.probabilities } : {}),
      },
      irreversible,
      done,
      blocked,
    };
    if (clickEl) step.target = { ref: clickEl.ref, name: clickEl.name };
    if (valueLabel) step.valueLabel = valueLabel;
    steps.push(step);

    // Política em código, nesta ordem — Jev propõe, Nexus decide: nouls fortes
    // primeiro; op com baixa confiança não pode decidir nem DONE nem BLOCKED.
    if (done >= 0.8) return finish('done');
    if (blocked >= 0.8) return finish('blocked');
    if ((op?.confidence ?? 0) < 0.5) {
      return finish('uncertain', { elements: table });
    }
    if (operation === 'DONE') return finish('done');
    if (operation === 'BLOCKED') return finish('blocked');
    if (irreversible >= 0.5) {
      const proposed: Record<string, unknown> = { operation };
      if (operation === 'CLICK' && clickEl) {
        proposed.target = { ref: clickEl.ref, name: clickEl.name };
      }
      if (operation === 'TYPE_TEXT' && typeEl) {
        proposed.target = { ref: typeEl.ref, name: typeEl.name };
        if (valueLabel) proposed.valueLabel = valueLabel;
      }
      return finish('needs_confirmation', {
        proposed,
        elements: table,
      });
    }

    // Detector de travamento: 3 passos iguais (op + alvo + url) sobre a mesma
    // tabela de elementos — o agente retoma com as tools normais.
    if (steps.length >= 3 && tableHashes.length >= 3) {
      const [a, b, c] = steps.slice(-3);
      const sameStep = (x: StepRecord, y: StepRecord) =>
        x.operation === y.operation &&
        (x.target?.ref ?? null) === (y.target?.ref ?? null) &&
        x.url === y.url;
      const [h1, h2, h3] = tableHashes.slice(-3);
      if (sameStep(a, b) && sameStep(b, c) && h1 === h2 && h2 === h3) {
        return finish('uncertain', {
          error: 'browser_do: sem progresso após 3 passos iguais',
          elements: table,
        });
      }
    }

    try {
      switch (operation) {
        case 'CLICK': {
          if (!clickEl) return finish('uncertain', { elements: table });
          await click(paneId, scope, clickEl.ref);
          history.push({ operation, target: clickEl.name, url: read.url });
          break;
        }
        case 'TYPE_TEXT': {
          if (!typeEl || !valueLabel || !(valueLabel in values)) {
            return finish('uncertain', { elements: table });
          }
          await fill(paneId, scope, typeEl.ref, values[valueLabel]);
          history.push({
            operation,
            target: typeEl.name,
            value: valueLabel,
            url: read.url,
          });
          break;
        }
        case 'PRESS_ENTER': {
          await press(paneId, scope, { key: 'Enter' });
          history.push({ operation, url: read.url });
          break;
        }
        case 'SCROLL_DOWN': {
          await scroll(paneId, scope, { dy: 800 });
          history.push({ operation, url: read.url });
          break;
        }
        case 'SCROLL_UP': {
          await scroll(paneId, scope, { dy: -800 });
          history.push({ operation, url: read.url });
          break;
        }
        case 'WAIT': {
          await wait(paneId, scope, { condition: 'load', timeoutMs: WAIT_MS });
          history.push({ operation, url: read.url });
          break;
        }
        default:
          return finish('uncertain', { elements: table });
      }
    } catch (err) {
      return finish('error', {
        error: `browser_do: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    await settle(SETTLE_MS);
  }

  return finish('max_steps');
}

const browserDoTool: McpToolDef = {
  name: 'nexus_browser_do',
  requiresConfirm: true,
  available: () => hasDecisionCredential('browserTool'),
  description:
    'Autopilot for ONE browser goal inside the Nexus browser pane: TypeSafe ' +
    'Jev picks the operation and the target element from the page\'s element ' +
    'table; Nexus executes with its own click/fill/scroll/press primitives. ' +
    'You supply `goal` and the exact `values` that may be typed (Jev never ' +
    'writes text). One human confirmation covers the whole goal. It stops ' +
    'and hands back on: goal achieved (done), blocked (login/captcha/error), ' +
    'low confidence (uncertain), any irreversible or costly action such as ' +
    'purchase/payment/send/delete/publish (needs_confirmation — perform ' +
    'that single step yourself with nexus_browser_click/fill), leaving the ' +
    'starting site (left_origin), or maxSteps. Never use it for payments ' +
    'or account changes without the human present. `done` is Jev\'s ' +
    'judgment — verify the outcome yourself (read the page) before ' +
    'reporting success.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      goal: { type: 'string' },
      values: { type: 'object' },
      maxSteps: { type: 'number' },
    },
    required: ['paneId', 'goal'],
  },
  handler: async (args, ctx, invocation) => {
    const parsed = browserDoArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `nexus_browser_do: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const paneId = requireStr(parsed.data, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    if (!hasDecisionCredential('browserTool')) {
      throw new Error(
        'nexus_browser_do: configure Jev ou Clef em Ajustes → Chaves de API',
      );
    }
    return runBrowserDo(parsed.data, ctx, invocation, {});
  },
};

export function buildBrowserAutopilotTools(deps: BrowserDoDeps = {}): McpToolDef[] {
  if (Object.keys(deps).length === 0) return [browserDoTool];
  return [
    {
      ...browserDoTool,
      handler: async (args, ctx, invocation) => {
        const parsed = browserDoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(
            `nexus_browser_do: argumentos inválidos: ${parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')}`,
          );
        }
        const paneId = requireStr(parsed.data, 'paneId');
        authorizePaneRef(ctx, paneId, 'write');
        if (!hasDecisionCredential('browserTool')) {
          throw new Error(
            'nexus_browser_do: configure Jev ou Clef em Ajustes → Chaves de API',
          );
        }
        return runBrowserDo(parsed.data, ctx, invocation, deps);
      },
    },
  ];
}
