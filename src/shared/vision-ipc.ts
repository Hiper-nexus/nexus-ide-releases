/**
 * Vision IPC channels and types — shared between main / preload / renderer.
 * Fase 5 Jarvis Vision: screen capture + AX tree + OCR.
 */

export const VISION_CHANNELS = {
  /** invoke: renderer → main. Captura screenshot da janela Nexus. */
  capture: 'vision:capture',
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

/** Resultado da captura de tela. */
export interface ScreenCaptureResult {
  imageBase64: string;
  format: 'png';
  width: number;
  height: number;
  capturedAt: string;
}

/** Resultado do OCR. */
export interface OcrResult {
  text: string;
  confidence: number;
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

/** API exposta no window.nexus.vision */
export interface VisionApi {
  /** Captura screenshot da janela Nexus IDE. */
  capture(): Promise<ScreenCaptureResult>;
  /** Extrai a accessibility tree do DOM atual. */
  getAxTree(): AxNode;
  /** OCR de uma imagem PNG (base64). */
  ocr(imageBase64: string): Promise<OcrResult>;
  /** Checa status da permissão de Screen Recording. */
  checkPermission(): Promise<ScreenPermissionStatus>;
  /** Escuta evento de captura concluída. */
  onCaptured(cb: (result: ScreenCaptureResult) => void): () => void;
}