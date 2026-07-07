import { describe, expect, it, vi } from 'vitest';
import type { AxNode, ScreenCaptureResultInternal } from '../../shared/vision-ipc';
import { ScreenRecordingPermissionDenied } from '../../shared/vision-ipc';
import { collectVisionContext } from './vision-orchestrator';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const AX_TREE: AxNode = {
  tag: 'body',
  role: null,
  aria: {},
  text: null,
  children: [
    {
      tag: 'button',
      role: null,
      aria: { label: 'Run mission' },
      text: 'Start',
      children: [],
    },
  ],
};

const CAPTURE: ScreenCaptureResultInternal = {
  imageBase64: PNG_BASE64,
  format: 'png',
  width: 1,
  height: 1,
  capturedAt: '2026-07-07T12:00:00.000Z',
  sourceId: 'window:nexus:1',
};

describe('collectVisionContext', () => {
  it('combines AX tree, screen capture, and local OCR without exposing raw image by default', async () => {
    const context = await collectVisionContext(
      {},
      {
        now: () => new Date('2026-07-07T12:00:01.000Z'),
        readAxTree: vi.fn(async () => AX_TREE),
        capture: vi.fn(async () => CAPTURE),
        ocr: vi.fn(async () => ({ text: 'HELLO VISION', confidence: 91 })),
      },
    );

    expect(context.capturedAt).toBe('2026-07-07T12:00:01.000Z');
    expect(context.ax.status).toBe('ok');
    expect(context.ocr).toMatchObject({
      status: 'ok',
      text: 'HELLO VISION',
      confidence: 91,
    });
    expect(context.screenshot).toMatchObject({
      status: 'ok',
      format: 'png',
      width: 1,
      height: 1,
      sourceId: 'window:nexus:1',
      hasImage: true,
      cloudAllowed: false,
    });
    expect(context.llmPrompt).toContain('Use this local vision context');
    expect(context.llmPrompt).toContain('Raw image included for cloud vision: no');
    expect(context.llmPrompt).toContain('HELLO VISION');
  });

  it('keeps raw screenshot out of context even when cloud image is allowed', async () => {
    const context = await collectVisionContext(
      { allowCloudImage: true, includeOcr: false },
      {
        readAxTree: vi.fn(async () => AX_TREE),
        capture: vi.fn(async () => CAPTURE),
        ocr: vi.fn(),
        now: () => new Date('2026-07-07T12:00:01.000Z'),
      },
    );

    expect(context.screenshot.cloudAllowed).toBe(true);
    expect('imageBase64' in context.screenshot).toBe(false);
    expect(context.ocr.status).toBe('unavailable');
    expect(context.llmPrompt).toContain('Raw image included for cloud vision: no');
  });

  it('degrades gracefully when AX permission is denied', async () => {
    const axError = Object.assign(new Error('AX permission denied'), {
      name: 'AxPermissionDenied',
    });

    const context = await collectVisionContext(
      {},
      {
        readAxTree: vi.fn(async () => {
          throw axError;
        }),
        capture: vi.fn(async () => CAPTURE),
        ocr: vi.fn(async () => ({ text: 'screen text', confidence: 82 })),
        now: () => new Date('2026-07-07T12:00:01.000Z'),
      },
    );

    expect(context.ax.status).toBe('permission-denied');
    expect(context.ax.tree).toBeNull();
    expect(context.ocr.status).toBe('ok');
    expect(context.llmPrompt).toContain('Accessibility tree unavailable');
  });

  it('degrades gracefully when screen recording permission is denied', async () => {
    const context = await collectVisionContext(
      {},
      {
        readAxTree: vi.fn(async () => AX_TREE),
        capture: vi.fn(async () => {
          throw new ScreenRecordingPermissionDenied();
        }),
        ocr: vi.fn(),
        now: () => new Date('2026-07-07T12:00:01.000Z'),
      },
    );

    expect(context.screenshot.status).toBe('permission-denied');
    expect(context.ocr.status).toBe('unavailable');
    expect(context.ax.status).toBe('ok');
  });
});
