import { describe, expect, it, vi } from 'vitest';
import type { AxNode, ScreenCaptureResultInternal } from '../../shared/vision-ipc';
import { ScreenRecordingPermissionDenied } from '../../shared/vision-ipc';
import { buildVisionPrompt, collectVisionContext } from './vision-orchestrator';

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

/** Synthetic secrets for redaction tests — never log these strings. */
const SK = 'sk-testleakvalueabcdef1234567890';
const GEMINI = 'AIzaSyD-testleakvalueabcdef1234567';
const GHP = 'ghp_testleakvalueabcdef123456789012';
const NPM = 'npm_testleakvalueabcdef123456789012';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC\n-----END PRIVATE KEY-----';
const URL_CRED = 'https://user:p4ssw0rdLeak99@db.example.com/path';
const BEARER_TOKEN = 'ya29.testleakvalueabcdefTOKEN';

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

  it('redacts secrets from llmPrompt while keeping benign AX labels', async () => {
    const tree: AxNode = {
      tag: 'body',
      role: null,
      aria: {},
      text: null,
      children: [
        {
          tag: 'h1',
          role: 'heading',
          aria: {},
          text: 'Dashboard',
          children: [],
        },
        {
          tag: 'p',
          role: null,
          aria: {},
          text: `token budget and password policy — key ${SK}`,
          children: [],
        },
      ],
    };

    const context = await collectVisionContext(
      {},
      {
        now: () => new Date('2026-07-07T12:00:01.000Z'),
        readAxTree: vi.fn(async () => tree),
        capture: vi.fn(async () => CAPTURE),
        ocr: vi.fn(async () => ({
          text: [
            'Visible heading',
            SK,
            GEMINI,
            GHP,
            NPM,
            JWT,
            PEM,
            URL_CRED,
            `Bearer ${BEARER_TOKEN}`,
            'password=SuperSecretLeak99',
            'OPENAI_API_KEY=sk-env-assignment-leak-1234567890',
            'CUSTOM_SECRET=opaque-custom-secret-leak',
            'token budget remains high',
          ].join('\n'),
          confidence: 88,
        })),
      },
    );

    expect(context.llmPrompt).toContain('Dashboard');
    expect(context.llmPrompt).toContain('token budget');
    expect(context.llmPrompt).toContain('password policy');
    expect(context.llmPrompt).not.toContain(SK);
    expect(context.llmPrompt).not.toContain(GEMINI);
    expect(context.llmPrompt).not.toContain(GHP);
    expect(context.llmPrompt).not.toContain(NPM);
    expect(context.llmPrompt).not.toContain(JWT);
    expect(context.llmPrompt).not.toContain('MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC');
    expect(context.llmPrompt).not.toContain('p4ssw0rdLeak99');
    expect(context.llmPrompt).not.toContain(BEARER_TOKEN);
    expect(context.llmPrompt).not.toContain('SuperSecretLeak99');
    expect(context.llmPrompt).not.toContain('sk-env-assignment-leak-1234567890');
    expect(context.llmPrompt).not.toContain('opaque-custom-secret-leak');
    expect(context.llmPrompt).not.toContain(PNG_BASE64);
    expect('imageBase64' in context.screenshot).toBe(false);
  });
});

describe('buildVisionPrompt', () => {
  it('never embeds original secret values from OCR or AX text', () => {
    const prompt = buildVisionPrompt({
      capturedAt: '2026-07-07T12:00:01.000Z',
      ax: {
        status: 'ok',
        tree: {
          tag: 'body',
          role: null,
          aria: {},
          text: null,
          children: [
            {
              tag: 'code',
              role: null,
              aria: {},
              text: SK,
              children: [],
            },
          ],
        },
      },
      ocr: {
        status: 'ok',
        text: `paste ${JWT} and ${GHP}`,
        confidence: 70,
      },
      screenshot: {
        status: 'ok',
        format: 'png',
        width: 10,
        height: 10,
        capturedAt: '2026-07-07T12:00:01.000Z',
        sourceId: 'window:nexus:1',
        hasImage: true,
        cloudAllowed: false,
      },
    });

    expect(prompt).not.toContain(SK);
    expect(prompt).not.toContain(JWT);
    expect(prompt).not.toContain(GHP);
    expect(prompt).toMatch(/\[REDACTED/);
  });

  it('bounds prompt size for enormous OCR/AX payloads', () => {
    const huge = 'benign word '.repeat(20_000);
    const prompt = buildVisionPrompt({
      capturedAt: '2026-07-07T12:00:01.000Z',
      ax: {
        status: 'ok',
        tree: {
          tag: 'body',
          role: null,
          aria: {},
          text: huge,
          children: Array.from({ length: 40 }, (_, i) => ({
            tag: 'p',
            role: null,
            aria: {},
            text: `paragraph-${i} ${huge.slice(0, 200)}`,
            children: [],
          })),
        },
      },
      ocr: { status: 'ok', text: huge, confidence: 50 },
      screenshot: {
        status: 'unavailable',
        format: null,
        width: null,
        height: null,
        capturedAt: null,
        sourceId: null,
        hasImage: false,
        cloudAllowed: false,
      },
    });

    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).toContain('benign word');
  });
});
