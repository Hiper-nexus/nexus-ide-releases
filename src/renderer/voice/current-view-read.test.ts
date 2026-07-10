import { describe, expect, it } from 'vitest';
import type { VisionContext } from '../../shared/vision-ipc';
import { currentViewNarration, currentViewToolOutput } from './current-view-read';

/** Synthetic secrets for redaction tests — never log these strings. */
const SECRETS = {
  sk: 'sk-testleakvalueabcdef1234567890',
  gemini: 'AIzaSyD-testleakvalueabcdef1234567',
  ghp: 'ghp_testleakvalueabcdef123456789012',
  gho: 'gho_testleakvalueabcdef123456789012',
  ghu: 'ghu_testleakvalueabcdef123456789012',
  ghs: 'ghs_testleakvalueabcdef123456789012',
  ghr: 'ghr_testleakvalueabcdef123456789012',
  npm: 'npm_testleakvalueabcdef123456789012',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  bearer: 'Bearer ya29.testleakvalueabcdefTOKEN',
  pem: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC\n-----END PRIVATE KEY-----',
  url: 'https://user:p4ssw0rdLeak99@db.example.com/path',
  env: 'OPENAI_API_KEY=sk-env-assignment-leak-1234567890',
  assignment: 'password=SuperSecretLeak99',
  customEnv: 'CUSTOM_SECRET=opaque-custom-secret-leak',
} as const;

const ALL_SECRET_VALUES = [
  SECRETS.sk,
  SECRETS.gemini,
  SECRETS.ghp,
  SECRETS.gho,
  SECRETS.ghu,
  SECRETS.ghs,
  SECRETS.ghr,
  SECRETS.npm,
  SECRETS.jwt,
  'ya29.testleakvalueabcdefTOKEN',
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC',
  'p4ssw0rdLeak99',
  'sk-env-assignment-leak-1234567890',
  'SuperSecretLeak99',
  'opaque-custom-secret-leak',
];

const context: VisionContext = {
  capturedAt: '2026-07-10T15:00:00.000Z',
  ax: {
    status: 'ok',
    tree: {
      tag: 'body',
      role: null,
      aria: {},
      text: 'texto do corpo que não deve duplicar todos os filhos',
      children: [
        {
          tag: 'h1',
          role: 'heading',
          aria: { level: '1' },
          text: 'Nova Missão',
          children: [],
        },
        {
          tag: 'button',
          role: 'button',
          aria: { label: 'Modo Agêntico', selected: 'true' },
          text: 'Modo Agêntico',
          ref: 'u123e456',
          children: [],
        },
        {
          tag: 'input',
          role: 'textbox',
          aria: { label: 'OPENAI_API_KEY' },
          text: null,
          children: [],
        },
        {
          tag: 'p',
          role: null,
          aria: {},
          text: 'token budget and password policy apply',
          children: [],
        },
      ],
    },
  },
  ocr: {
    status: 'ok',
    text: [
      'OBJETIVO',
      'Auditar o wake word',
      `OPENAI_API_KEY=${SECRETS.sk}`,
      SECRETS.gemini,
      SECRETS.ghp,
      SECRETS.gho,
      SECRETS.ghu,
      SECRETS.ghs,
      SECRETS.ghr,
      SECRETS.npm,
      SECRETS.jwt,
      SECRETS.bearer,
      SECRETS.pem,
      SECRETS.url,
      SECRETS.env,
      SECRETS.assignment,
      SECRETS.customEnv,
      'api_key: leaked-api-key-value-999',
      'token budget remains high',
      'password policy is strict',
    ].join('\n'),
    confidence: 92,
  },
  screenshot: {
    status: 'ok',
    format: 'png',
    width: 1280,
    height: 720,
    capturedAt: '2026-07-10T15:00:00.000Z',
    sourceId: 'window:nexus:1',
    hasImage: true,
    cloudAllowed: false,
  },
  llmPrompt: 'unused by the voice action',
};

describe('currentViewToolOutput', () => {
  it('combines accessible controls with local OCR while avoiding duplicate container text', () => {
    const output = currentViewToolOutput(context);
    const serialized = JSON.stringify(output);

    expect(serialized).toContain('Nova Missão');
    expect(serialized).toContain('Modo Agêntico');
    expect(serialized).toContain('Auditar o wake word');
    expect(serialized).toContain('u123e456');
    expect(serialized).not.toContain('texto do corpo que não deve duplicar');
    expect(serialized).toContain('confidence');
  });

  it('redacts every supported secret format from OCR before it leaves the renderer', () => {
    const serialized = JSON.stringify(currentViewToolOutput(context));

    expect(serialized).toMatch(/\[REDACTED/);
    for (const secret of ALL_SECRET_VALUES) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('leaked-api-key-value-999');
  });

  it('preserves benign headings and non-secret terminology', () => {
    const serialized = JSON.stringify(currentViewToolOutput(context));

    expect(serialized).toContain('Nova Missão');
    expect(serialized).toContain('token budget');
    expect(serialized).toContain('password policy');
  });

  it('does not mutate the original vision context object', () => {
    const originalOcr = context.ocr.text;
    const originalAxText = context.ax.tree?.children[0]?.text;
    currentViewToolOutput(context);
    expect(context.ocr.text).toBe(originalOcr);
    expect(context.ax.tree?.children[0]?.text).toBe(originalAxText);
  });

  it('never includes raw screenshot bytes in the tool output', () => {
    const output = currentViewToolOutput(context) as Record<string, unknown>;
    const screenshot = output.screenshot as Record<string, unknown>;
    expect(screenshot.hasImage).toBe(true);
    expect(screenshot.cloudAllowed).toBe(false);
    expect(JSON.stringify(output)).not.toContain('imageBase64');
    expect(JSON.stringify(output)).not.toContain('data:image');
  });

  it('keeps the Classic spoken fallback useful without voicing OCR secrets', () => {
    const narration = currentViewNarration(context);

    expect(narration).toContain('Nova Missão');
    for (const secret of ALL_SECRET_VALUES) {
      expect(narration).not.toContain(secret);
    }
  });

  it('redacts secrets when narration falls back to OCR text', () => {
    const ocrOnly: VisionContext = {
      ...context,
      ax: { status: 'ok', tree: null },
      ocr: {
        status: 'ok',
        text: `Visible heading then ${SECRETS.sk}`,
        confidence: 80,
      },
    };
    const narration = currentViewNarration(ocrOnly);
    expect(narration).not.toContain(SECRETS.sk);
    expect(narration).toMatch(/\[REDACTED|O texto visível/);
  });

  it('remains useful when macOS blocks screen recording and OCR is unavailable', () => {
    const output = currentViewToolOutput({
      ...context,
      ocr: {
        status: 'unavailable',
        text: null,
        confidence: null,
        error: 'No screenshot was available for local OCR.',
      },
      screenshot: {
        ...context.screenshot,
        status: 'permission-denied',
        format: null,
        width: null,
        height: null,
        capturedAt: null,
        sourceId: null,
        hasImage: false,
        error: 'Screen Recording denied',
      },
    });

    expect(JSON.stringify(output)).toContain('Nova Missão');
    expect(JSON.stringify(output)).toContain('permission-denied');
  });

  it('omits sensitive controls from action targets even if a ref leaked into context', () => {
    const withSensitiveRef: VisionContext = {
      ...context,
      ax: {
        status: 'ok',
        tree: {
          tag: 'body',
          role: null,
          aria: {},
          text: null,
          children: [
            {
              tag: 'input',
              role: 'textbox',
              aria: { label: 'API key' },
              text: null,
              ref: 'u999e111',
              children: [],
            },
            {
              tag: 'button',
              role: 'button',
              aria: { label: 'Save' },
              text: 'Save',
              ref: 'u999e222',
              children: [],
            },
          ],
        },
      },
    };
    const output = currentViewToolOutput(withSensitiveRef) as {
      actions: Array<{ ref: string; label: string }>;
    };
    expect(output.actions.map((a) => a.ref)).toEqual(['u999e222']);
    expect(output.actions.every((a) => !/api|key|password|token|secret/i.test(a.label))).toBe(
      true,
    );
  });
});
