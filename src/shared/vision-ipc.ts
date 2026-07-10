/**
 * Vision IPC channels and types — shared between main / preload / renderer.
 * Fase 5 Jarvis Vision: screen capture + AX tree + OCR.
 */

const VISIBLE_SECRET_REDACTED = '[REDACTED]';
const PRIVATE_KEY_RE =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi;
const UNTERMINATED_PRIVATE_KEY_RE =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*$/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
const PROVIDER_KEY_RE = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g;
const GEMINI_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const GITHUB_KEY_RE = /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g;
const NPM_KEY_RE = /\bnpm_[A-Za-z0-9_]{16,}\b/g;
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{12,}\b/g;
/** JSON JWTs start with base64url `{"`; anchoring avoids redacting long hostnames. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const ENV_ASSIGNMENT_RE =
  /(^|[\r\n])(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)([^\r\n]*)/g;
const SECRET_ENV_NAME_RE =
  /(^|_)(token|secret|password|pass|key|credential|auth|bearer|cookie)($|_)/i;
const URL_CREDENTIAL_RE =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const SECRET_ASSIGNMENT_RE =
  /(\b(?:api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|auth)\b\s*[:=]\s*)(["'`]?)([^\s,"'`;]+)/gi;

/**
 * Pure, reusable redaction for visible text that may leave the machine via
 * vision prompts, OCR summaries, AX digests or MCP-shaped tool output.
 * Never mutates the input string; only values are redacted, labels preserved.
 */
export function redactVisibleSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY_RE, '[REDACTED_PRIVATE_KEY]')
    .replace(UNTERMINATED_PRIVATE_KEY_RE, '[REDACTED_PRIVATE_KEY]')
    .replace(
      ENV_ASSIGNMENT_RE,
      (match, lineStart: string, prefix: string, name: string) =>
        SECRET_ENV_NAME_RE.test(name)
          ? `${lineStart}${prefix}${VISIBLE_SECRET_REDACTED}`
          : match,
    )
    .replace(URL_CREDENTIAL_RE, `$1${VISIBLE_SECRET_REDACTED}@`)
    .replace(BEARER_RE, `Bearer ${VISIBLE_SECRET_REDACTED}`)
    .replace(PROVIDER_KEY_RE, VISIBLE_SECRET_REDACTED)
    .replace(GEMINI_KEY_RE, VISIBLE_SECRET_REDACTED)
    .replace(GITHUB_KEY_RE, VISIBLE_SECRET_REDACTED)
    .replace(NPM_KEY_RE, VISIBLE_SECRET_REDACTED)
    .replace(AWS_ACCESS_KEY_RE, VISIBLE_SECRET_REDACTED)
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(
      SECRET_ASSIGNMENT_RE,
      (_match, prefix: string, quote: string) =>
        `${prefix}${quote}${VISIBLE_SECRET_REDACTED}`,
    );
}

export const VISION_CHANNELS = {
  /** invoke: renderer → main. Captura screenshot da janela Nexus. */
  capture: 'vision:capture',
  /** invoke: renderer → main. Retorna imagem bruta somente com consentimento. */
  getImage: 'vision:getImage',
  /** invoke: renderer → main. Ativa/desativa consentimento para imagem bruta. */
  setImageConsent: 'vision:setImageConsent',
  /** invoke: renderer → main. Combina screenshot, AX tree e OCR local. */
  context: 'vision:context',
  /** invoke: renderer → main. Extrai accessibility tree do DOM. */
  axTree: 'vision:ax-tree',
  /** invoke: renderer → main. OCR de uma imagem (buffer). */
  ocr: 'vision:ocr',
  /** event: main → renderer. Screenshot capturado com sucesso. */
  captured: 'vision:captured',
  /** invoke: renderer → main. Checa status da permissão de Screen Recording. */
  permission: 'vision:permission',
} as const;

/** Nó da accessibility tree extraído do DOM. */
export interface AxNode {
  tag: string;
  role: string | null;
  aria: Record<string, string>;
  text: string | null;
  /** Opaque capability valid only for the snapshot that produced this tree. */
  ref?: string;
  children: AxNode[];
}

export type AxActionKind = 'click' | 'focus' | 'fill' | 'select';

export interface AxActionRequest {
  action: AxActionKind;
  ref: string;
  /** Required only by fill/select. Never included in the action result. */
  text?: string;
}

export type AxActionError =
  | 'invalid_request'
  | 'invalid_ref'
  | 'stale_ref'
  | 'unknown_ref'
  | 'detached_control'
  | 'hidden_control'
  | 'disabled_control'
  | 'readonly_control'
  | 'sensitive_control'
  | 'unsupported_action'
  | 'option_not_found';

export type AxActionResult =
  | {
      ok: true;
      action: AxActionKind;
      ref: string;
    }
  | {
      ok: false;
      action: AxActionKind;
      ref: string;
      error: AxActionError;
    };

/** Resultado interno da captura de tela. Nunca deve ser enviado por broadcast. */
export interface ScreenCaptureResultInternal {
  imageBase64: string;
  format: 'png';
  width: number;
  height: number;
  capturedAt: string;
  sourceId: string;
  ocrText?: string;
  axSummary?: string;
}

/** Payload público seguro para renderer/preload. */
export interface ScreenCaptureMetadata {
  format: 'png';
  width: number;
  height: number;
  capturedAt: string;
  sourceId: string;
  hasImage: boolean;
  hasOcr: boolean;
}

/** Resultado do OCR. */
export interface OcrResult {
  text: string;
  confidence: number;
}

/** Resultado de cada fonte do contexto de visão. */
export type VisionSourceStatus =
  | 'ok'
  | 'unavailable'
  | 'permission-denied'
  | 'error';

/** Opções do orquestrador de visão. */
export interface VisionContextOptions {
  /** Capturar screenshot da janela. Default: true. */
  includeScreenshot?: boolean;
  /** Rodar OCR local sobre a captura. Default: true. */
  includeOcr?: boolean;
  /**
   * Consentimento explícito para disponibilizar a imagem bruta a um fluxo de
   * LLM vision/cloud. Default: false.
   */
  allowCloudImage?: boolean;
}

export interface VisionAxContext {
  status: VisionSourceStatus;
  tree: AxNode | null;
  error?: string;
}

export interface VisionOcrContext {
  status: VisionSourceStatus;
  text: string | null;
  confidence: number | null;
  error?: string;
}

export interface VisionScreenshotContext {
  status: VisionSourceStatus;
  format: ScreenCaptureMetadata['format'] | null;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  sourceId: string | null;
  hasImage: boolean;
  cloudAllowed: boolean;
  error?: string;
}

export interface VisionContext {
  capturedAt: string;
  ax: VisionAxContext;
  ocr: VisionOcrContext;
  screenshot: VisionScreenshotContext;
  /** English-only prompt fragment suitable for a text LLM. */
  llmPrompt: string;
}

/** Status da permissão macOS Screen Recording. */
export type ScreenPermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted';

/** Erro específico para permissão negada. */
export class ScreenRecordingPermissionDenied extends Error {
  constructor() {
    super(
      'Permissão de Screen Recording negada. ' +
        'Vá em Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela ' +
        'e habilite o NexusIDE.',
    );
    this.name = 'ScreenRecordingPermissionDenied';
  }
}

export interface VisionGetImageRequest {
  consentToken: string;
}

export type VisionGetImageResult =
  | {
      imageBase64: string;
      format: 'png';
      width: number;
      height: number;
      capturedAt: string;
      sourceId: string;
    }
  | { error: 'consent_required' | 'not_found' };

export interface VisionImageConsentRequest {
  allowCloudImage: boolean;
}

export type VisionImageConsentResult =
  | { allowCloudImage: true; consentToken: string }
  | { allowCloudImage: false; consentToken: null };

/** API exposta no window.nexus.vision */
export interface VisionApi {
  /** Captura screenshot da janela Nexus IDE e retorna somente metadata segura. */
  capture(): Promise<ScreenCaptureMetadata>;
  /** Retorna a última imagem bruta somente com consentimento explícito válido. */
  getImage(request: VisionGetImageRequest): Promise<VisionGetImageResult>;
  /** Ativa/desativa consentimento para acesso à imagem bruta. */
  setImageConsent(
    allowCloudImage: boolean,
  ): Promise<VisionImageConsentResult>;
  /** Combina AX tree, screenshot e OCR local. */
  context(options?: VisionContextOptions): Promise<VisionContext>;
  /** Extrai a accessibility tree do DOM atual. */
  getAxTree(): AxNode;
  /** Executa uma ação somente por ref opaca retornada pelo snapshot atual. */
  performAxAction(request: AxActionRequest): AxActionResult;
  /** OCR de uma imagem PNG (base64). */
  ocr(imageBase64: string): Promise<OcrResult>;
  /** Checa status da permissão de Screen Recording. */
  checkPermission(): Promise<ScreenPermissionStatus>;
  /** Escuta evento de captura concluída. */
  onCaptured(cb: (result: ScreenCaptureMetadata) => void): () => void;
}
