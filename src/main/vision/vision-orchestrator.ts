import type {
  AxNode,
  OcrResult,
  ScreenCaptureResult,
  VisionContext,
  VisionContextOptions,
  VisionSourceStatus,
} from '../../shared/vision-ipc';
import { ScreenRecordingPermissionDenied } from '../../shared/vision-ipc';
import { captureNexusWindow } from './screen-capture';
import { ocrImage } from './ocr';

interface VisionOrchestratorDeps {
  capture: () => Promise<ScreenCaptureResult>;
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
  capture: () => Promise<ScreenCaptureResult>,
  allowCloudImage: boolean,
): Promise<{
  capture: ScreenCaptureResult | null;
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
        cloudAllowed: allowCloudImage,
        ...(allowCloudImage ? { imageBase64: result.imageBase64 } : {}),
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

function flattenAxText(node: AxNode | null, out: string[] = []): string[] {
  if (!node || out.length >= 12) return out;
  const label = node.aria.label ?? node.aria.labelledby ?? node.text;
  if (label) out.push(`${node.tag}${node.role ? `:${node.role}` : ''} "${label}"`);
  for (const child of node.children) {
    flattenAxText(child, out);
    if (out.length >= 12) break;
  }
  return out;
}

export function buildVisionPrompt(context: Omit<VisionContext, 'llmPrompt'>): string {
  const axLines = flattenAxText(context.ax.tree);
  const screenshotLine =
    context.screenshot.status === 'ok'
      ? `Screenshot: ${context.screenshot.width}x${context.screenshot.height} ${context.screenshot.format}. Raw image included for cloud vision: ${context.screenshot.imageBase64 ? 'yes' : 'no'}.`
      : `Screenshot unavailable: ${context.screenshot.status}${context.screenshot.error ? ` (${context.screenshot.error})` : ''}.`;
  const ocrLine =
    context.ocr.status === 'ok'
      ? `Local OCR text: ${context.ocr.text || '(empty)'}`
      : `Local OCR unavailable: ${context.ocr.status}${context.ocr.error ? ` (${context.ocr.error})` : ''}.`;
  const axLine =
    context.ax.status === 'ok'
      ? `Accessibility summary: ${axLines.join(' | ') || '(empty tree)'}`
      : `Accessibility tree unavailable: ${context.ax.status}${context.ax.error ? ` (${context.ax.error})` : ''}.`;

  return [
    'Use this local vision context to understand the current NexusIDE workspace.',
    'Do not assume information that is not present in the accessibility tree or OCR text.',
    screenshotLine,
    axLine,
    ocrLine,
  ].join('\n');
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
