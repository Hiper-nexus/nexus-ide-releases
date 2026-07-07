/**
 * Vision IPC channels and types — shared between main / preload / renderer.
 * Fase 5 Jarvis Vision: screen capture + AX tree + OCR.
 */

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
  children: AxNode[];
}

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
  /** OCR de uma imagem PNG (base64). */
  ocr(imageBase64: string): Promise<OcrResult>;
  /** Checa status da permissão de Screen Recording. */
  checkPermission(): Promise<ScreenPermissionStatus>;
  /** Escuta evento de captura concluída. */
  onCaptured(cb: (result: ScreenCaptureMetadata) => void): () => void;
}
