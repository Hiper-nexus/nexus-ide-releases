/**
 * Desktop pet (companion flutuante sobre o desktop). Tipos e canais IPC —
 * módulo dependency-free (sem zod/node) para o preload sandboxado importar,
 * no mesmo espírito de channels.ts.
 */

export const PET_CHANNELS = {
  /** invoke: renderer (qualquer janela) → main. Lê as prefs atuais. */
  getPrefs: 'pet:getPrefs',
  /** invoke: renderer → main. Merge parcial validado + persistência. */
  setPrefs: 'pet:setPrefs',
  /** event: main → todas as janelas. Prefs após qualquer mudança. */
  prefsChanged: 'pet:prefsChanged',
  /** event: main → janela do pet. Evento operacional para o balão/mood. */
  event: 'pet:event',
  /** send: janela do pet → main. Cursor entrou/saiu de área interativa. */
  setInteractive: 'pet:setInteractive',
  /** send: janela do pet → main. Começa a arrastar (offset do cursor). */
  dragBegin: 'pet:dragBegin',
  /** send: janela do pet → main. Solta o arrasto (snap + persiste). */
  dragEnd: 'pet:dragEnd',
  /** send: janela do pet → main. Foca a janela principal do app. */
  focusMain: 'pet:focusMain',
  /** send: janela do pet → main. Foca a principal E pede o Settings. */
  requestSettings: 'pet:requestSettings',
  /** event: main → janela principal. Pedido do pet para abrir Settings. */
  openSettings: 'pet:openSettings',
} as const;

/** Presets do OperatorSprite (skins), pet pixelizado ou spritesheet Codex. */
export type PetPreset =
  | 'operator'
  | 'gold'
  | 'flame'
  | 'centurion'
  | 'prestige'
  | 'custom'
  | 'sheet';

export const PET_PRESETS: readonly PetPreset[] = [
  'operator',
  'gold',
  'flame',
  'centurion',
  'prestige',
  'custom',
  'sheet',
];

/**
 * Spritesheet no contrato Codex v2 (8 colunas × 11 linhas; spriteVersionNumber
 * 2 do hatch-pet): o pet criado no Codex funciona aqui sem conversão. A imagem
 * vive como data URL nas prefs — funciona sob a CSP (img-src data:) e não
 * depende de ~/.codex continuar existindo.
 */
export const CODEX_SHEET_COLS = 8;
export const CODEX_SHEET_ROWS = 11;
/** Animações do contrato v2 que o pet usa: linha e nº de frames. */
export const SHEET_ANIMS = {
  idle: { row: 0, frames: 6 },
  wave: { row: 3, frames: 4 },
  failed: { row: 5, frames: 8 },
} as const;
/** Frame neutro (parado) do contrato v2: linha 0, coluna 6. */
export const SHEET_NEUTRAL = { row: 0, col: 6 } as const;

const SHEET_DATA_URL_RE = /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/;
/** Teto do data URL do sheet — exportado para a UI diagnosticar rejeições. */
export const SHEET_DATA_URL_MAX = 3_500_000;

export interface PetSheet {
  dataUrl: string;
  cols: number;
  rows: number;
}

/** Lado da grade do pet custom (mesma malha 16×16 do OperatorSprite). */
export const PET_CUSTOM_GRID_SIZE = 16;

/** Célula da grade custom: cor `#rrggbb` ou null (transparente). */
export type PetCustomCell = string | null;
export type PetCustomGrid = PetCustomCell[][];

export interface PetPosition {
  x: number;
  y: number;
}

export interface PetPrefs {
  /** Desligado por padrão: o pet é opt-in (não afeta smoke/CI). */
  enabled: boolean;
  /** Dormindo: sem balões/notificações; sprite apaga o visor. */
  sleeping: boolean;
  preset: PetPreset;
  /** Pixel-grid do pet custom (gerado localmente de uma imagem do usuário). */
  customGrid: PetCustomGrid | null;
  /** Spritesheet Codex v2 importado (ex.: pet criado no Codex/hatch-pet). */
  sheet: PetSheet | null;
  /** Canto superior-esquerdo da janela do pet, em coordenadas de tela. */
  position: PetPosition | null;
  /**
   * Fundo sólido (cartão) em vez de transparência real — fallback para
   * compositors Linux sem ARGB; escolhível em qualquer plataforma.
   */
  solidBackground: boolean;
}

export type PetEventKind =
  | 'mission-done'
  | 'mission-failed'
  | 'agent-exited'
  | 'agent-idle';

export interface PetEvent {
  kind: PetEventKind;
  /** Título curto para o balão (nome da missão / título do pane). */
  title: string;
  at: number;
}

/** Contrato exposto pelo pet-preload como `window.nexusPet` (janela do pet). */
export interface NexusPetApi {
  getPrefs(): Promise<PetPrefs>;
  setPrefs(patch: Partial<PetPrefs>): Promise<PetPrefs>;
  onPrefsChanged(cb: (prefs: PetPrefs) => void): () => void;
  onEvent(cb: (event: PetEvent) => void): () => void;
  setInteractive(interactive: boolean): void;
  dragBegin(offset: { x: number; y: number }): void;
  dragEnd(): void;
  /** Foca a janela principal (clique no balão) — sem abrir Settings. */
  focusMain(): void;
  /** Foca a principal e abre Settings → Aparência (menu "Configurar…"). */
  openSettings(): void;
}

export function defaultPetPrefs(platform: NodeJS.Platform): PetPrefs {
  return {
    enabled: false,
    sleeping: false,
    preset: 'operator',
    customGrid: null,
    sheet: null,
    position: null,
    solidBackground: platform === 'linux',
  };
}

function isValidSheet(value: unknown): value is PetSheet {
  if (typeof value !== 'object' || value === null) return false;
  const sheet = value as Record<string, unknown>;
  return (
    typeof sheet.dataUrl === 'string' &&
    sheet.dataUrl.length <= SHEET_DATA_URL_MAX &&
    SHEET_DATA_URL_RE.test(sheet.dataUrl) &&
    typeof sheet.cols === 'number' &&
    Number.isInteger(sheet.cols) &&
    sheet.cols >= 1 &&
    sheet.cols <= 16 &&
    typeof sheet.rows === 'number' &&
    Number.isInteger(sheet.rows) &&
    sheet.rows >= 1 &&
    sheet.rows <= 16
  );
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

function isValidCustomGrid(value: unknown): value is PetCustomGrid {
  if (!Array.isArray(value) || value.length !== PET_CUSTOM_GRID_SIZE) {
    return false;
  }
  return value.every(
    (row) =>
      Array.isArray(row) &&
      row.length === PET_CUSTOM_GRID_SIZE &&
      row.every(
        (cell) =>
          cell === null || (typeof cell === 'string' && HEX_COLOR_RE.test(cell)),
      ),
  );
}

function isValidPosition(value: unknown): value is PetPosition {
  if (typeof value !== 'object' || value === null) return false;
  const pos = value as Record<string, unknown>;
  return (
    typeof pos.x === 'number' &&
    Number.isFinite(pos.x) &&
    typeof pos.y === 'number' &&
    Number.isFinite(pos.y)
  );
}

/**
 * Valida um patch vindo de IPC (input não confiável) e devolve só os campos
 * reconhecidos e bem-formados — nunca lança, nunca deixa passar lixo.
 */
export function sanitizePetPrefsPatch(raw: unknown): Partial<PetPrefs> {
  if (typeof raw !== 'object' || raw === null) return {};
  const patch = raw as Record<string, unknown>;
  const out: Partial<PetPrefs> = {};
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
  if (typeof patch.sleeping === 'boolean') out.sleeping = patch.sleeping;
  if (
    typeof patch.preset === 'string' &&
    (PET_PRESETS as readonly string[]).includes(patch.preset)
  ) {
    out.preset = patch.preset as PetPreset;
  }
  if (patch.customGrid === null) out.customGrid = null;
  else if (isValidCustomGrid(patch.customGrid)) out.customGrid = patch.customGrid;
  if (patch.sheet === null) out.sheet = null;
  else if (isValidSheet(patch.sheet)) {
    out.sheet = {
      dataUrl: patch.sheet.dataUrl,
      cols: patch.sheet.cols,
      rows: patch.sheet.rows,
    };
  }
  if (patch.position === null) out.position = null;
  else if (isValidPosition(patch.position)) {
    out.position = { x: patch.position.x, y: patch.position.y };
  }
  if (typeof patch.solidBackground === 'boolean') {
    out.solidBackground = patch.solidBackground;
  }
  return out;
}
