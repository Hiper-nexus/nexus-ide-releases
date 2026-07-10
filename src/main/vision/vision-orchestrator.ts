import type {
  AxNode,
  OcrResult,
  ScreenCaptureResultInternal,
  VisionContext,
  VisionContextOptions,
  VisionSourceStatus,
} from '../../shared/vision-ipc';
import {
  redactVisibleSecrets,
  ScreenRecordingPermissionDenied,
} from '../../shared/vision-ipc';
import { captureNexusWindow } from './screen-capture';
import { ocrImage } from './ocr';

interface VisionOrchestratorDeps {
  capture: () => Promise<ScreenCaptureResultInternal>;
  readAxTree: () => Promise<AxNode>;
  ocr: (buffer: Buffer) => Promise<OcrResult>;
  now: () => Date;
}

export type VisionOrchestratorOverrides = Partial<VisionOrchestratorDeps>;

const DEFAULT_OPTIONS: Required<VisionContextOptions> = {
  includeScreenshot: true,
  includeOcr: true,
  allowCloudImage: false,
};

const EMPTY_AX: AxNode = {
  tag: 'body',
  role: null,
  aria: {},
  text: null,
  children: [],
};

function defaultReadAxTree(): Promise<AxNode> {
  return Promise.resolve(EMPTY_AX);
}

function deps(overrides: VisionOrchestratorOverrides): VisionOrchestratorDeps {
  return {
    capture: captureNexusWindow,
    readAxTree: defaultReadAxTree,
    ocr: ocrImage,
    now: () => new Date(),
    ...overrides,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyError(err: unknown): VisionSourceStatus {
  if (err instanceof ScreenRecordingPermissionDenied) {
    return 'permission-denied';
  }

  const name = err instanceof Error ? err.name : '';
  const message = errorMessage(err).toLowerCase();
  if (
    /permission|denied|not authorized|not authorised|ax/i.test(name) ||
    message.includes('permission') ||
    message.includes('denied') ||
    message.includes('not authorized') ||
    message.includes('not authorised')
  ) {
    return 'permission-denied';
  }
  return 'error';
}

async function readAx(
  readAxTree: () => Promise<AxNode>,
): Promise<VisionContext['ax']> {
  try {
    return { status: 'ok', tree: await readAxTree() };
  } catch (err) {
    return {
      status: classifyError(err),
      tree: null,
      error: errorMessage(err),
    };
  }
}

async function captureScreen(
  capture: () => Promise<ScreenCaptureResultInternal>,
  allowCloudImage: boolean,
): Promise<{
  capture: ScreenCaptureResultInternal | null;
  context: VisionContext['screenshot'];
}> {
  try {
    const result = await capture();
    return {
      capture: result,
      context: {
        status: 'ok',
        format: result.format,
        width: result.width,
        height: result.height,
        capturedAt: result.capturedAt,
        sourceId: result.sourceId,
        hasImage: result.imageBase64.length > 0,
        cloudAllowed: allowCloudImage,
      },
    };
  } catch (err) {
    return {
      capture: null,
      context: {
        status: classifyError(err),
        format: null,
        width: null,
        height: null,
        capturedAt: null,
        sourceId: null,
        hasImage: false,
        cloudAllowed: allowCloudImage,
        error: errorMessage(err),
      },
    };
  }
}

async function runOcr(
  imageBase64: string | null,
  shouldRun: boolean,
  ocr: (buffer: Buffer) => Promise<OcrResult>,
): Promise<VisionContext['ocr']> {
  if (!shouldRun) {
    return {
      status: 'unavailable',
      text: null,
      confidence: null,
      error: 'OCR was not requested.',
    };
  }
  if (!imageBase64) {
    return {
      status: 'unavailable',
      text: null,
      confidence: null,
      error: 'No screenshot was available for local OCR.',
    };
  }

  try {
    const result = await ocr(Buffer.from(imageBase64, 'base64'));
    return {
      status: 'ok',
      text: result.text,
      confidence: result.confidence,
    };
  } catch (err) {
    return {
      status: classifyError(err),
      text: null,
      confidence: null,
      error: errorMessage(err),
    };
  }
}

const MAX_PROMPT_AX_ITEMS = 12;
const MAX_PROMPT_AX_CHARS = 2_400;
const MAX_PROMPT_OCR_CHARS = 2_400;
const MAX_PROMPT_TOTAL_CHARS = 8_000;

function flattenAxText(node: AxNode | null, out: string[] = [], chars = { n: 0 }): string[] {
  if (!node || out.length >= MAX_PROMPT_AX_ITEMS || chars.n >= MAX_PROMPT_AX_CHARS) return out;
  const rawLabel = node.aria.label ?? node.aria.labelledby ?? node.text;
  if (rawLabel) {
    const label = redactVisibleSecrets(rawLabel).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (label) {
      const line = `${node.tag}${node.role ? `:${node.role}` : ''} "${label}"`;
      if (chars.n + line.length + 3 > MAX_PROMPT_AX_CHARS) {
        out.push('[TRUNCATED]');
        chars.n = MAX_PROMPT_AX_CHARS;
        return out;
      }
      out.push(line);
      chars.n += line.length + 3;
    }
  }
  for (const child of node.children) {
    flattenAxText(child, out, chars);
    if (out.length >= MAX_PROMPT_AX_ITEMS || chars.n >= MAX_PROMPT_AX_CHARS) break;
  }
  return out;
}

function boundedRedactedText(text: string | null | undefined, maxChars: number): string {
  const normalized = text
    ? redactVisibleSecrets(text).replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return '(empty)';
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars)}… [TRUNCATED]`;
}

export function buildVisionPrompt(context: Omit<VisionContext, 'llmPrompt'>): string {
  const axLines = flattenAxText(context.ax.tree);
  const screenshotLine =
    context.screenshot.status === 'ok'
      ? `Screenshot: ${context.screenshot.width}x${context.screenshot.height} ${context.screenshot.format}. Raw image included for cloud vision: no.`
      : `Screenshot unavailable: ${context.screenshot.status}${
          context.screenshot.error
            ? ` (${redactVisibleSecrets(context.screenshot.error).slice(0, 200)})`
            : ''
        }.`;
  const ocrLine =
    context.ocr.status === 'ok'
      ? `Local OCR text: ${boundedRedactedText(context.ocr.text, MAX_PROMPT_OCR_CHARS)}`
      : `Local OCR unavailable: ${context.ocr.status}${
          context.ocr.error
            ? ` (${redactVisibleSecrets(context.ocr.error).slice(0, 200)})`
            : ''
        }.`;
  const axLine =
    context.ax.status === 'ok'
      ? `Accessibility summary: ${axLines.join(' | ') || '(empty tree)'}`
      : `Accessibility tree unavailable: ${context.ax.status}${
          context.ax.error
            ? ` (${redactVisibleSecrets(context.ax.error).slice(0, 200)})`
            : ''
        }.`;

  const prompt = [
    'Use this local vision context to understand the current NexusIDE workspace.',
    'Do not assume information that is not present in the accessibility tree or OCR text.',
    screenshotLine,
    axLine,
    ocrLine,
  ].join('\n');

  if (prompt.length <= MAX_PROMPT_TOTAL_CHARS) return prompt;
  return `${prompt.slice(0, MAX_PROMPT_TOTAL_CHARS)}… [TRUNCATED]`;
}

export async function collectVisionContext(
  options: VisionContextOptions = {},
  overrides: VisionOrchestratorOverrides = {},
): Promise<VisionContext> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const runtime = deps(overrides);
  const capturedAt = runtime.now().toISOString();

  const [ax, screen] = await Promise.all([
    readAx(runtime.readAxTree),
    resolved.includeScreenshot
      ? captureScreen(runtime.capture, resolved.allowCloudImage)
      : Promise.resolve({
          capture: null,
          context: {
            status: 'unavailable' as const,
            format: null,
            width: null,
            height: null,
            capturedAt: null,
            sourceId: null,
            hasImage: false,
            cloudAllowed: resolved.allowCloudImage,
            error: 'Screenshot capture was not requested.',
          },
        }),
  ]);

  const ocr = await runOcr(
    screen.capture?.imageBase64 ?? null,
    resolved.includeScreenshot && resolved.includeOcr,
    runtime.ocr,
  );

  const context = {
    capturedAt,
    ax,
    ocr,
    screenshot: screen.context,
  };

  return {
    ...context,
    llmPrompt: buildVisionPrompt(context),
  };
}
