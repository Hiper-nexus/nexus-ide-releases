/**
 * `nexus_computer_do` — autopilot de desktop ("Jev decide, Nexus executa").
 *
 * Lê a árvore de acessibilidade do app alvo (fallback: OCR local da janela —
 * pixels nunca saem da máquina), o TypeSafe Jev escolhe operação + elemento,
 * e o Nexus executa via System Events. Só a mão do operador ou o orquestrador
 * podem dirigir a área de trabalho: um worker (potencialmente injetado por
 * conteúdo web) nunca dirige o desktop do usuário.
 *
 * Mesmas garantias do `nexus_browser_do`: uma confirmação humana por objetivo,
 * valores digitados são apenas os fornecidos (o Jev recebe só os rótulos),
 * irreversível sempre para, trava de app, detector de travamento, log por
 * passo, fail-open.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
  type JevAnswer,
  type JevQuestion,
  type JevResult,
} from '../jev/jev-client';
import { hasJevCredential } from '../jev/jev-secrets';
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
import type { AgentGateContext } from './gate';
import {
  desktopControl,
  DesktopControlUnsupported,
  DesktopElementGone,
  DesktopSensitiveField,
  type DesktopControl,
  type DesktopElement,
  type DesktopFrame,
  type DesktopWindowCapture,
} from '../vision/desktop-control';
import {
  getScreenPermissionStatus,
} from '../vision/screen-capture';
import { recognizeLinesWithBoxes, type OcrLine } from '../vision/ocr';
import { removeTreeSync } from '../util/remove-tree';

const JUDGE_TIMEOUT_MS = 8_000;
const SETTLE_MS = 800;
const WAIT_MS = 1_500;
const HISTORY_LEN = 5;
const MIN_AX_ELEMENTS = 3;
const ELEMENTS_MAX = 150;

/**
 * Terminais são proibidos como alvo do computer_do. `System Events` digita no
 * app em FOCO: rodar contra Terminal/iTerm/etc. é o vazamento de conteúdo
 * para fora do Nexus (um claude externo recebia prompts do agente). Escrita em
 * terminal é exclusiva do PTY do Nexus (`nexus_pane_write` / `terminal_run`).
 */
const TERMINAL_APP_DENYLIST: readonly string[] = [
  'terminal',
  'iterm',
  'iterm2',
  'ghostty',
  'alacritty',
  'wezterm',
  'warp',
  'warp terminal',
  'kitty',
  'hyper',
  'tabby',
  'termius',
  'windows terminal',
  'conhost',
];

export function isTerminalApp(app: string): boolean {
  const bare = app.trim().toLowerCase();
  return TERMINAL_APP_DENYLIST.some(
    (name) => bare === name || bare.startsWith(`${name} `),
  );
}

export const computerDoArgsSchema = z.object({
  app: z.string().min(1).max(128),
  goal: z.string().min(1).max(2_000),
  values: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(2_000))
    .refine((v) => Object.keys(v).length <= 12, {
      message: 'at most 12 values',
    })
    .optional(),
  maxSteps: z.number().int().min(1).max(40).default(20),
});

type StopStatus =
  | 'done'
  | 'blocked'
  | 'needs_confirmation'
  | 'uncertain'
  | 'max_steps'
  | 'focus_lost'
  | 'permission_required'
  | 'error';

interface StepRecord {
  n: number;
  operation: string;
  target?: { role: string; name: string };
  valueLabel?: string;
  window: string;
  probabilities: {
    operation: Record<string, number>;
    target?: Record<string, number>;
  };
  irreversible: number;
  done: number;
  blocked: number;
}

export interface ComputerDoDeps {
  judge?: typeof judge;
  control?: DesktopControl;
  recognizeLines?: (png: Buffer) => Promise<OcrLine[]>;
  settle?: (ms: number) => Promise<void>;
  screenPermission?: () => 'granted' | 'denied' | 'not-determined' | 'restricted';
  userDataDir?: () => string | undefined;
}

const defaultSettle = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

function defaultUserDataDir(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron');
    return electron.app?.getPath('userData');
  } catch {
    return undefined;
  }
}

/** Elemento indexado para a tabela do passo (frames ficam locais). */
interface TableElement {
  i: number;
  role: string;
  name: string;
  enabled: boolean;
  sensitive: boolean;
  kind: 'clickable' | 'textfield' | 'other';
}

function toTable(elements: DesktopElement[]): TableElement[] {
  return elements.map((el, i) => ({
    i,
    role: el.role,
    name: el.name,
    enabled: el.enabled,
    sensitive: el.sensitive,
    kind: el.kind,
  }));
}

/** Fingerprint da tabela — base do detector de travamento. */
function tableHash(table: TableElement[]): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(table.map((e) => [e.role, e.name, e.enabled])),
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

function ocrLinesToElements(lines: OcrLine[], capture: DesktopWindowCapture): DesktopElement[] {
  const scale = capture.scale > 0 ? capture.scale : 1;
  return lines.map((line, i) => {
    const frame: DesktopFrame = {
      x: capture.frame.x + line.bbox.x0 / scale,
      y: capture.frame.y + line.bbox.y0 / scale,
      w: (line.bbox.x1 - line.bbox.x0) / scale,
      h: (line.bbox.y1 - line.bbox.y0) / scale,
    };
    return {
      i,
      role: 'text',
      name: line.text,
      enabled: true,
      frame,
      sensitive: /password|senha|passcode/i.test(line.text),
      actions: [],
      kind: 'clickable',
    };
  });
}

function buildQuestions(
  clickables: TableElement[],
  textfields: TableElement[],
  valueLabels: string[],
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    operation: {
      type: 'choice',
      instructions:
        'Which single operation best advances the goal in this application window?',
      criteria: {
        CLICK: 'click a button, link, checkbox, menu item or visible text',
        DOUBLE_CLICK: 'open an item that needs a double click',
        TYPE_TEXT: 'type one of the provided values into a text field',
        PRESS_ENTER: 'press Enter to confirm or submit',
        PRESS_ESCAPE: 'press Escape to dismiss a dialog or cancel',
        SCROLL_DOWN: 'scroll down (Page Down) to reveal more content',
        SCROLL_UP: 'scroll up (Page Up)',
        WAIT: 'wait for the application to finish loading or updating',
        DONE: 'the goal is already fully achieved on the current screen',
        BLOCKED:
          'progress is impossible without the human: login, captcha, error, missing information',
      },
    },
    irreversible: {
      type: 'noul',
      instructions:
        'Would the most likely next action cause an irreversible or costly ' +
        'effect: purchase, payment, sending a message or email, deleting or ' +
        'moving files to trash, publishing, changing system settings or accounts?',
    },
    done: {
      type: 'noul',
      instructions:
        'Is the goal already fully achieved on the current screen?',
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

async function observe(
  control: DesktopControl,
  recognizeLines: (png: Buffer) => Promise<OcrLine[]>,
  app: string,
): Promise<{ windowTitle: string; elements: DesktopElement[] }> {
  const ax = await control.listElements(app, { max: ELEMENTS_MAX });
  if (ax.elements.length >= MIN_AX_ELEMENTS) return ax;

  // Árvore pobre → OCR local da janela (pixels nunca saem da máquina).
  const capture = await control.captureWindow(app);
  if (!capture) return ax;
  const lines = await recognizeLines(capture.png);
  const elements = ocrLinesToElements(lines, capture);
  return { windowTitle: ax.windowTitle || app, elements };
}

function saveConfirmationCapture(
  capture: DesktopWindowCapture | null,
  userDataDir: () => string | undefined,
  runId: string,
): string | undefined {
  if (!capture) return undefined;
  const base = userDataDir();
  if (!base) return undefined;
  try {
    const root = path.join(base, 'jev', 'computer');
    pruneOldCaptures(root);
    const dir = path.join(root, runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'confirm.png');
    fs.writeFileSync(file, capture.png);
    return file;
  } catch {
    return undefined;
  }
}

const CAPTURE_TTL_MS = 24 * 60 * 60_000;

/**
 * Capturas de confirmação são sensíveis (tela do usuário): vivem só o
 * suficiente para a decisão. Toda nova gravação apaga as de mais de 24 h.
 */
function pruneOldCaptures(root: string, now = Date.now()): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (now - fs.statSync(dir).mtimeMs > CAPTURE_TTL_MS) {
        removeTreeSync(dir, { recursive: true, force: true });
      }
    } catch {
      // best-effort: uma pasta que não dá para ler não bloqueia a captura nova
    }
  }
}

async function runComputerDo(
  args: z.infer<typeof computerDoArgsSchema>,
  ctx: AgentGateContext,
  invocation: McpToolInvocation | undefined,
  deps: ComputerDoDeps,
): Promise<Record<string, unknown>> {
  const judgeFn = deps.judge ?? judge;
  const control = deps.control ?? desktopControl;
  const recognizeLines = deps.recognizeLines ?? recognizeLinesWithBoxes;
  const settle = deps.settle ?? defaultSettle;
  const screenPermission = deps.screenPermission ?? getScreenPermissionStatus;
  const userDataDir = deps.userDataDir ?? defaultUserDataDir;

  const app = args.app;
  const values = args.values ?? {};
  const valueLabels = Object.keys(values);
  const steps: StepRecord[] = [];
  const history: Array<{
    operation: string;
    target?: string;
    value?: string;
    window: string;
  }> = [];
  const tableHashes: string[] = [];
  const runId = crypto.randomUUID();
  let lastWindow = '';

  const finish = (
    status: StopStatus,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    status,
    app,
    steps,
    ...extra,
  });

  // Terminal proibido: conteúdo jamais sai para um terminal fora do Nexus.
  if (isTerminalApp(app)) {
    return finish('error', {
      error:
        `computer_do: "${app}" é um terminal — recusado. ` +
        'Escrita em terminal é pelo PTY do Nexus (nexus_pane_write / terminal_run); ' +
        'nunca System Events num terminal externo.',
    });
  }

  // Pré-condições: permissão de Acessibilidade e app em primeiro plano.
  if (control.accessibilityStatus() !== 'granted') {
    control.requestAccessibility();
    return finish('permission_required', {
      permission: 'accessibility',
      howTo:
        'Ajustes do Sistema → Privacidade e Segurança → Acessibilidade → ' +
        'ativar NexusIDE',
    });
  }
  try {
    await control.activate(app);
  } catch (err) {
    return finish('error', {
      error: `computer_do: não consegui ativar "${app}": ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if ((await control.frontmostApp()) !== app) {
    return finish('error', { error: 'app não ficou em primeiro plano' });
  }

  for (let n = 1; n <= args.maxSteps; n += 1) {
    assertMcpInvocationCurrent(invocation);

    // Trava de app: o foco saiu do alvo, a tela não é mais nossa.
    if ((await control.frontmostApp()) !== app) {
      return finish('focus_lost');
    }

    let observed: { windowTitle: string; elements: DesktopElement[] };
    try {
      observed = await observe(control, recognizeLines, app);
    } catch (err) {
      return finish('error', {
        error: `computer_do: leitura da tela falhou: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    lastWindow = observed.windowTitle;
    const elements = observed.elements;
    if (elements.length === 0) {
      return finish('uncertain', {
        error: 'computer_do: nenhum elemento legível na tela',
      });
    }
    const table = toTable(elements);
    tableHashes.push(tableHash(table));
    if (tableHashes.length > 3) tableHashes.shift();

    const clickables = table.filter((el) => el.kind === 'clickable');
    const textfields = table.filter((el) => el.kind === 'textfield');
    const questions = buildQuestions(clickables, textfields, valueLabels);

    const result: JevResult | null = await judgeFn({
      state: {
        goal: args.goal,
        app,
        window: lastWindow,
        // Privacidade: só os rótulos — os textos fornecidos nunca saem.
        values: valueLabels,
        elements: table.map((el) => ({
          i: el.i,
          role: el.role,
          name: capText(el.name, 200),
          kind: el.kind,
          enabled: el.enabled,
          sensitive: el.sensitive,
        })),
        history: history.slice(-HISTORY_LEN),
      },
      questions,
      timeoutMs: JUDGE_TIMEOUT_MS,
      signal: invocation?.signal,
      surface: 'computerTool',
    });
    assertMcpInvocationCurrent(invocation);

    if (!result) {
      return finish('error', {
        error: 'computer_do: serviço TypeSafe (Jev) indisponível agora',
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
      pool: TableElement[],
    ): DesktopElement | null => {
      if (!answer || answer.choice === 'none') return null;
      const idx = Number(answer.choice.replace(/^e/, ''));
      const hit = pool.find((el) => el.i === idx);
      return hit ? elements[hit.i]! : null;
    };
    const clickEl = resolveTarget(clickTarget, clickables);
    const typeEl = resolveTarget(typeTarget, textfields);
    const valueLabel =
      typeValue && typeValue.choice !== 'none' ? typeValue.choice : null;

    recordJevDecision({
      surface: 'computerTool',
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
      window: lastWindow,
      probabilities: {
        operation: op?.probabilities ?? {},
        ...(clickTarget ? { target: clickTarget.probabilities } : {}),
      },
      irreversible,
      done,
      blocked,
    };
    if (clickEl) step.target = { role: clickEl.role, name: clickEl.name };
    if (valueLabel) step.valueLabel = valueLabel;
    steps.push(step);

    // Política em código, nesta ordem — Jev propõe, Nexus decide.
    if (done >= 0.8) return finish('done');
    if (blocked >= 0.8) return finish('blocked');
    if ((op?.confidence ?? 0) < 0.5) {
      return finish('uncertain', { elements: table });
    }
    if (operation === 'DONE') return finish('done');
    if (operation === 'BLOCKED') return finish('blocked');
    if (irreversible >= 0.5) {
      const proposed: Record<string, unknown> = { operation };
      if ((operation === 'CLICK' || operation === 'DOUBLE_CLICK') && clickEl) {
        proposed.target = { role: clickEl.role, name: clickEl.name };
      }
      if (operation === 'TYPE_TEXT' && typeEl) {
        proposed.target = { role: typeEl.role, name: typeEl.name };
        if (valueLabel) proposed.valueLabel = valueLabel;
      }
      // Best-effort: uma captura para o humano conferir a ação proposta.
      // Nunca guardamos capturas em outro caminho.
      let capturePath: string | undefined;
      if (screenPermission() === 'granted') {
        try {
          capturePath = saveConfirmationCapture(
            await control.captureWindow(app),
            userDataDir,
            runId,
          );
        } catch {
          capturePath = undefined;
        }
      }
      return finish('needs_confirmation', {
        proposed,
        elements: table,
        ...(capturePath ? { capturePath } : {}),
      });
    }

    // Detector de travamento: 3 passos iguais (op + alvo + janela) sobre a
    // mesma tabela — o agente retoma o controle.
    if (steps.length >= 3 && tableHashes.length >= 3) {
      const [a, b, c] = steps.slice(-3);
      const sameStep = (x: StepRecord, y: StepRecord) =>
        x.operation === y.operation &&
        (x.target?.name ?? null) === (y.target?.name ?? null) &&
        (x.target?.role ?? null) === (y.target?.role ?? null) &&
        x.window === y.window;
      const [h1, h2, h3] = tableHashes.slice(-3);
      if (sameStep(a, b) && sameStep(b, c) && h1 === h2 && h2 === h3) {
        return finish('uncertain', {
          error: 'computer_do: sem progresso após 3 passos iguais',
          elements: table,
        });
      }
    }

    try {
      switch (operation) {
        case 'CLICK': {
          if (!clickEl) return finish('uncertain', { elements: table });
          await control.press(app, {
            role: clickEl.role,
            name: clickEl.name,
            frame: clickEl.frame,
          });
          history.push({ operation, target: clickEl.name, window: lastWindow });
          break;
        }
        case 'DOUBLE_CLICK': {
          if (!clickEl) return finish('uncertain', { elements: table });
          await control.doubleClick(app, {
            role: clickEl.role,
            name: clickEl.name,
            frame: clickEl.frame,
          });
          history.push({ operation, target: clickEl.name, window: lastWindow });
          break;
        }
        case 'TYPE_TEXT': {
          if (!typeEl || !valueLabel || !(valueLabel in values)) {
            return finish('uncertain', { elements: table });
          }
          if (typeEl.sensitive) {
            return finish('error', { error: 'campo sensível recusado' });
          }
          await control.setValue(
            app,
            { role: typeEl.role, name: typeEl.name, frame: typeEl.frame },
            values[valueLabel]!,
          );
          history.push({
            operation,
            target: typeEl.name,
            value: valueLabel,
            window: lastWindow,
          });
          break;
        }
        case 'PRESS_ENTER': {
          await control.pressKey(app, 'enter');
          history.push({ operation, window: lastWindow });
          break;
        }
        case 'PRESS_ESCAPE': {
          await control.pressKey(app, 'escape');
          history.push({ operation, window: lastWindow });
          break;
        }
        case 'SCROLL_DOWN': {
          await control.pressKey(app, 'pagedown');
          history.push({ operation, window: lastWindow });
          break;
        }
        case 'SCROLL_UP': {
          await control.pressKey(app, 'pageup');
          history.push({ operation, window: lastWindow });
          break;
        }
        case 'WAIT': {
          await settle(WAIT_MS);
          history.push({ operation, window: lastWindow });
          break;
        }
        default:
          return finish('uncertain', { elements: table });
      }
    } catch (err) {
      if (err instanceof DesktopElementGone) {
        return finish('uncertain', {
          error: 'computer_do: a tela mudou — o elemento sumiu',
          elements: table,
        });
      }
      if (err instanceof DesktopSensitiveField) {
        return finish('error', { error: 'campo sensível recusado' });
      }
      if (err instanceof DesktopControlUnsupported) {
        return finish('error', {
          error: 'computer_do: controle de desktop só existe no macOS',
        });
      }
      return finish('error', {
        error: `computer_do: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    await settle(SETTLE_MS);
  }

  return finish('max_steps');
}

const computerDoTool: McpToolDef = {
  name: 'nexus_computer_do',
  requiresConfirm: true,
  available: () => process.platform === 'darwin' && hasJevCredential(),
  description:
    'Autopilot for ONE goal in a macOS application: reads the app\'s ' +
    'accessibility tree (fallback: local OCR of the window — pixels never ' +
    'leave the machine, only element labels go to TypeSafe Jev), Jev picks ' +
    'operation + element, Nexus presses/types through System Events. Supply ' +
    '`app`, `goal` and the exact `values` that may be typed. One human ' +
    'confirmation per goal; stops and hands back on done / blocked / low ' +
    'confidence / any irreversible or costly action (needs_confirmation) / ' +
    'focus leaving the app / maxSteps. Only the operator\'s own pane or the ' +
    'orchestrator may call it. Requires macOS Accessibility permission for ' +
    'NexusIDE. `done` is Jev\'s judgment — verify the outcome yourself ' +
    '(read the app) before reporting success.',
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string' },
      goal: { type: 'string' },
      values: { type: 'object' },
      maxSteps: { type: 'number' },
    },
    required: ['app', 'goal'],
  },
  handler: async (args, ctx, invocation) => {
    const parsed = computerDoArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `nexus_computer_do: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    if (ctx.role !== 'user' && ctx.role !== 'orchestrator') {
      throw new Error(
        'nexus_computer_do: só a mão do operador ou o orquestrador podem ' +
          'dirigir a área de trabalho',
      );
    }
    if (!hasJevCredential()) {
      throw new Error(
        'nexus_computer_do: configure a chave TypeSafe em Ajustes → Chaves de API',
      );
    }
    if (process.platform !== 'darwin') {
      throw new Error('nexus_computer_do: só está disponível no macOS');
    }
    return runComputerDo(parsed.data, ctx, invocation, {});
  },
};

export function buildComputerAutopilotTools(
  deps: ComputerDoDeps = {},
): McpToolDef[] {
  if (Object.keys(deps).length === 0) return [computerDoTool];
  return [
    {
      ...computerDoTool,
      handler: async (args, ctx, invocation) => {
        const parsed = computerDoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(
            `nexus_computer_do: argumentos inválidos: ${parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')}`,
          );
        }
        if (ctx.role !== 'user' && ctx.role !== 'orchestrator') {
          throw new Error(
            'nexus_computer_do: só a mão do operador ou o orquestrador podem ' +
              'dirigir a área de trabalho',
          );
        }
        if (!hasJevCredential()) {
          throw new Error(
            'nexus_computer_do: configure a chave TypeSafe em Ajustes → Chaves de API',
          );
        }
        if (process.platform !== 'darwin') {
          throw new Error('nexus_computer_do: só está disponível no macOS');
        }
        return runComputerDo(parsed.data, ctx, invocation, deps);
      },
    },
  ];
}
