/**
 * Desktop pet (companion flutuante sobre o desktop). Tipos e canais IPC —
 * módulo dependency-free (sem zod/node) para o preload sandboxado importar,
 * no mesmo espírito de channels.ts.
 */

// Import APENAS de tipo: apagado na compilação, o preload segue sem runtime.
import type { MissionBlockCauseCode } from './mission-block-cause';

export type SpriteAnimation = {
  row: number;
  frames: number;
  frameDurationsMs?: number[];
};

export type CustomPet = {
  id: string;
  label: string;
  fileName: string;
  mimeType: string;
  kind?: 'image' | 'bundle';
  sprite?: {
    frameWidth: number;
    frameHeight: number;
    columns: number;
    rows: number;
    sheetWidth: number;
    sheetHeight: number;
    fps: number;
    defaultAnimation?: string;
    animations?: Record<string, SpriteAnimation>;
  };
  spriteFps?: number;
};

export const PET_CHANNELS = {
  /** invoke: renderer (qualquer janela) → main. Lê as prefs atuais. */
  getPrefs: 'pet:getPrefs',
  /** invoke: renderer → main. Merge parcial validado + persistência. */
  setPrefs: 'pet:setPrefs',
  /** event: main → todas as janelas. Prefs após qualquer mudança. */
  prefsChanged: 'pet:prefsChanged',
  /** event: main → janela do pet. Evento operacional para o balão/mood. */
  event: 'pet:event',
  /** send: pet → main. React já assinou eventos; agora a fila pode ser solta. */
  rendererReady: 'pet:rendererReady',
  /** send: pet → main. O balão entrou no ciclo de renderização local. */
  eventShown: 'pet:eventShown',
  /** event: main → janela do pet. Direção de "look" (0..15) ou null. */
  look: 'pet:look',
  /** event: main → janela do pet. Alinha o conteúdo ao canto sem overhang. */
  placement: 'pet:placement',
  /** send: janela do pet → main. Cursor entrou/saiu de área interativa. */
  setInteractive: 'pet:setInteractive',
  /**
   * event: main → janela do pet. Sonda de hit-test (coords cliente) enviada
   * quando o main revive o forward do ignore-mouse (Bug 7: “de vidro”) ou o
   * cursor entra nos bounds — cursor parado não gera mousemove encaminhado.
   */
  cursorProbe: 'pet:cursorProbe',
  /** send: janela do pet → main. Começa a arrastar (offset do cursor). */
  dragBegin: 'pet:dragBegin',
  /** send: janela do pet → main. Solta o arrasto (snap + persiste). */
  dragEnd: 'pet:dragEnd',
  /**
   * event: main → janela do pet. Estado da patrulha autônoma (andando /
   * escalando borda / parado) — o renderer troca a animação do sprite.
   */
  roam: 'pet:roam',
  /**
   * send: janela do pet → main. Veto do renderer à patrulha: balão aberto,
   * menu aberto, arrasto em curso ou prefers-reduced-motion seguram o pet.
   */
  roamHold: 'pet:roamHold',
  /** event: main → janela do pet. Contadores de vida útil (HUD gamificado). */
  stats: 'pet:stats',
  /** send: janela do pet → main. Foca a janela principal do app. */
  focusMain: 'pet:focusMain',
  /** send: janela do pet → main. Foca a principal E pede o Settings. */
  requestSettings: 'pet:requestSettings',
  /**
   * send: janela do pet → main. Foca a principal e navega para o grid de terminais.
   */
  requestOpenTerminal: 'pet:requestOpenTerminal',
  /** event: main → janela principal. Navegar para os terminais. */
  openTerminal: 'pet:openTerminal',
  /**
   * send: janela do pet → main. Foca a principal e pede o Ops Board
   * (missão terminou / precisa de intervenção humana).
   */
  requestOpenOps: 'pet:requestOpenOps',
  /** event: main → janela principal. Abrir Ops Board / pipeline de missões. */
  openOps: 'pet:openOps',
  /**
   * event: main → janela principal. Intervenção (missão blocked / agent waiting)
   * e conclusão de missão. Espelhado em toast mesmo com pet off ou ainda a
   * carregar.
   */
  attention: 'pet:attention',
  /** invoke: janela principal → main. Importa um pet da galeria petdex. */
  galleryImport: 'pet:galleryImport',
  /** invoke: janela principal → main. Catálogo ao vivo da galeria. */
  galleryList: 'pet:galleryList',
  /** invoke: janela principal → main. Biblioteca embutida (~15 pets). */
  libraryList: 'pet:libraryList',
  /** invoke: janela principal → main. Aplica um pet da biblioteca embutida. */
  libraryApply: 'pet:libraryApply',
  /** invoke: janela principal → main. Sheet (data URL) para preview na UI. */
  libraryPreview: 'pet:libraryPreview',
  /** invoke: janela principal → main. Lista pacotes em ~/.codex/pets. */
  installedList: 'pet:installedList',
  /** invoke: janela principal → main. Aplica um pacote local instalado. */
  installedApply: 'pet:installedApply',
  /** invoke: janela principal → main. Preview de pacote local instalado. */
  installedPreview: 'pet:installedPreview',
  /** invoke: janela principal → main. Apaga pacote em ~/.codex/pets/<id>. */
  installedDelete: 'pet:installedDelete',
  /** invoke: janela principal → main. Dialog nativo já em ~/.codex/pets. */
  pickSheet: 'pet:pickSheet',
  /** invoke: janela principal → main. Escolhe a imagem-base (só o PATH). */
  pickImage: 'pet:pickImage',
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
 * 2 do Nexus Pet Studio): o pet criado no Codex funciona aqui sem conversão. A imagem
 * vive como data URL nas prefs — funciona sob a CSP (img-src data:) e não
 * depende de ~/.codex continuar existindo.
 */
export const CODEX_SHEET_COLS = 8;
export const CODEX_SHEET_ROWS = 11;

/**
 * Detecta malha de um spritesheet a partir das dimensões.
 * Célula canônica Codex/petdex em 1536px: 192×208 (razão 192:208).
 * Codex full = 8×11; petdex costuma ser 8×9 (sem linhas de look).
 * Escolhe o nº de linhas pela razão da célula — não bastar “dividir
 * exatamente” (935÷11=85 corta o pet; o certo é ~9 linhas × ~104px).
 */
export function detectSheetGrid(
  width: number,
  height: number,
): { cols: number; rows: number } {
  const cols =
    width >= CODEX_SHEET_COLS && width % CODEX_SHEET_COLS === 0
      ? CODEX_SHEET_COLS
      : Math.max(1, width);
  if (width % cols !== 0 || width < cols) {
    return { cols: CODEX_SHEET_COLS, rows: CODEX_SHEET_ROWS };
  }
  const cellW = width / cols;
  // 208/192 = razão da célula nos packs oficiais.
  const idealCellH = cellW * (208 / 192);
  let bestExact: { rows: number; score: number } | null = null;
  for (const rows of [11, 9, 12, 10, 13, 8, 14, 15, 16]) {
    if (height % rows !== 0) continue;
    const score = Math.abs(height / rows - idealCellH);
    if (!bestExact || score < bestExact.score) {
      bestExact = { rows, score };
    }
  }
  const approxRows = Math.min(
    16,
    Math.max(1, Math.round(height / idealCellH)),
  );
  const approxScore = Math.abs(height / approxRows - idealCellH);
  // Exact só vence se a célula ficar perto da razão canônica (≤ 8px).
  if (bestExact && bestExact.score <= 8) {
    return { cols, rows: bestExact.rows };
  }
  if (!bestExact || approxScore < bestExact.score) {
    return { cols, rows: approxRows };
  }
  return { cols, rows: bestExact.rows };
}
/** Animações do contrato v2 que o pet usa: linha e nº de frames. */
export const SHEET_ANIMS = {
  idle: { row: 0, frames: 6 },
  'run-right': { row: 1, frames: 8 },
  'run-left': { row: 2, frames: 8 },
  wave: { row: 3, frames: 4 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
} as const;
/** Frame neutro (parado) do contrato v2: linha 0, coluna 6. */
export const SHEET_NEUTRAL = { row: 0, col: 6 } as const;

/**
 * Linhas de "look" do contrato v2: 16 direções em passos de 22,5°, no
 * sentido horário a partir de CIMA (000=cima, 090=direita da tela,
 * 180=baixo, 270=esquerda). Direções 0-7 moram na linha 9 (000-157.5),
 * 8-15 na linha 10 (180-337.5) — contrato look-mechanics do Pet Studio.
 */
export const SHEET_LOOK = {
  rowA: 9,
  rowB: 10,
  directions: 16,
  stepDeg: 22.5,
} as const;

/** Converte a direção quantizada (0..15) em {row, col} do spritesheet. */
export function sheetLookFrame(dir: number): { row: number; col: number } {
  const clamped = ((Math.round(dir) % SHEET_LOOK.directions) +
    SHEET_LOOK.directions) % SHEET_LOOK.directions;
  return clamped < 8
    ? { row: SHEET_LOOK.rowA, col: clamped }
    : { row: SHEET_LOOK.rowB, col: clamped - 8 };
}

const SHEET_DATA_URL_RE = /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/;
/** Teto do data URL do sheet — exportado para a UI diagnosticar rejeições. */
export const SHEET_DATA_URL_MAX = 3_500_000;

export interface PetSheet {
  dataUrl: string;
  cols: number;
  rows: number;
}

/** Lado da grade do pet custom. 32 dá detalhe suficiente para fotos; grids
    16 antigos continuam válidos (compat com prefs já salvas). */
export const PET_CUSTOM_GRID_SIZE = 32;
export const PET_CUSTOM_GRID_SIZES: readonly number[] = [16, 32];

/** Célula da grade custom: cor `#rrggbb` ou null (transparente). */
export type PetCustomCell = string | null;
export type PetCustomGrid = PetCustomCell[][];

export interface PetPosition {
  x: number;
  y: number;
}

export interface PetPlacement {
  horizontal: 'left' | 'center' | 'right';
  vertical: 'top' | 'bottom';
}

export interface PetPrefs {
  /** Desligado por padrão: o pet é opt-in (não afeta smoke/CI). */
  enabled: boolean;
  /** Dormindo: sem balões/notificações; sprite apaga o visor. */
  sleeping: boolean;
  preset: PetPreset;
  /** Pixel-grid do pet custom (gerado localmente de uma imagem do usuário). */
  customGrid: PetCustomGrid | null;
  /** Spritesheet Codex v2 importado (ex.: pet criado no Nexus Pet Studio). */
  sheet: PetSheet | null;
  /** Canto superior-esquerdo da janela do pet, em coordenadas de tela. */
  position: PetPosition | null;
  /**
   * Fundo sólido (cartão) em vez de transparência real — fallback para
   * compositors Linux sem ARGB; escolhível em qualquer plataforma.
   */
  solidBackground: boolean;
  /**
   * Patrulha autônoma OPT-IN: o pet caminha/escala pelas bordas e interior do
   * monitor quando acordado. Default parado — o dono decide no menu do pet;
   * pausa sozinho em balão, menu, arrasto e sono.
   */
  roam: boolean;
  /** Ticker compacto de stats sob o sprite (tokens, USD, panes, nível). */
  hudTicker: boolean;
}

/** Estado de patrulha enviado ao renderer (troca a animação do sprite). */
export interface PetRoamState {
  phase: 'idle' | 'walk' | 'climb';
  /** Direção de face durante walk/climb; null parado. */
  dir: 'left' | 'right' | null;
  /** Sentido vertical durante climb (sprite gira 90°); null fora de climb. */
  climb: 'up' | 'down' | null;
}

/**
 * Contadores de vida útil do companion — soma de TODOS os escopos de
 * telemetria conhecidos, com piso persistido (o HUD nunca regride se um
 * banco de escopo for apagado). USD = equivalente de API pública, isto é,
 * o que o mesmo consumo custaria fora da assinatura.
 */
export interface PetLifetimeStats {
  /** input+output+cache-read somados em todos os escopos. */
  tokensBurned: number;
  /** Custo equivalente em API paga (assinatura já cobre). */
  usdEquivalent: number;
  /** USD acumulado de geração de mídia (imagem/vídeo/áudio). */
  mediaUsd: number;
  /** Panes distintos que o companion já acompanhou. */
  panesServed: number;
  /** Turnos de agente com saída real entregue. */
  turns: number;
  /** Missões concluídas observadas pelo pet nesta instalação. */
  missionsDone: number;
  /**
   * Entregas por tipo somadas em TODOS os escopos (xp_events por checkout,
   * com piso persistido por tipo). O `powerLevel`/tier do perfil continuam
   * por projeto — estes são os totais de vida do operador.
   */
  counters: Record<string, number>;
  /** Nível da jornada (deriva de XP = entregas + tokens). */
  level: number;
  /** Progresso 0..1 até o próximo nível. */
  levelProgress: number;
  /** Título do nível (mesma escala de tier da gamificação). */
  tier: PetTier;
  updatedAt: number;
}

/** Tier do companion — espelha a escala da gamificação de projeto. */
export type PetTier =
  | 'RECRUTA'
  | 'INICIADO'
  | 'VETERANO'
  | 'ELITE'
  | 'MAESTRO'
  | 'LENDA';

/** Resultado do import da galeria petdex (codex-pets.net). */
export interface PetGalleryImportResult {
  ok: boolean;
  name?: string;
  dataUrl?: string;
  error?: string;
}

/** Item do catálogo ao vivo da galeria (sitemap → slugs publicados). */
export interface PetGalleryEntry {
  slug: string;
  label: string;
}

export interface PetGalleryListResult {
  ok: boolean;
  items?: PetGalleryEntry[];
  error?: string;
}

/** Pet do pacote embutido (resources/pets) — disponível offline. */
export interface PetLibraryEntry {
  id: string;
  slug: string;
  label: string;
  note?: string;
}

export interface PetLibraryListResult {
  ok: boolean;
  items?: PetLibraryEntry[];
  error?: string;
}

export interface PetLibraryApplyResult {
  ok: boolean;
  name?: string;
  prefs?: PetPrefs;
  error?: string;
}

/** Preview do sheet embutido (mesmo payload de apply, sem mutar prefs). */
export interface PetLibraryPreviewResult {
  ok: boolean;
  name?: string;
  sheet?: PetSheet;
  error?: string;
}

/** Pet local criado pelo Pet Studio / Codex em ~/.codex/pets/<id>. */
export interface PetInstalledEntry {
  id: string;
  slug: string;
  label: string;
  note?: string;
}

export interface PetInstalledListResult {
  ok: boolean;
  items?: PetInstalledEntry[];
  error?: string;
}

export interface PetInstalledApplyResult {
  ok: boolean;
  name?: string;
  prefs?: PetPrefs;
  error?: string;
}

export interface PetInstalledPreviewResult {
  ok: boolean;
  name?: string;
  sheet?: PetSheet;
  error?: string;
}

export interface PetInstalledDeleteResult {
  ok: boolean;
  name?: string;
  error?: string;
}

/** Resultado do dialog nativo de spritesheet (abre em ~/.codex/pets). */
export interface PetPickSheetResult {
  ok: boolean;
  /** false + canceled=true quando o usuário fechou o dialog sem escolher. */
  canceled?: boolean;
  dataUrl?: string;
  error?: string;
}

/** Resultado do picker de imagem-base para GERAÇÃO (path, sem bytes). */
export interface PetPickImageResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

export type PetEventKind =
  | 'mission-done'
  | 'mission-failed'
  /** Recuperação automática de uma falha técnica foi esgotada. */
  | 'mission-technical-failure'
  /** Missão travou aguardando decisão/ação humana — o aviso mais importante. */
  | 'mission-blocked'
  /** Um agente pediu permissão/input (hook waiting/blocked). */
  | 'agent-waiting'
  | 'agent-exited'
  | 'agent-idle'
  | 'goal-wave-started'
  | 'goal-wave-completed'
  | 'goal-gate-passed'
  | 'goal-finished';

/** Ação que o pet pede à janela principal quando o usuário interage. */
export type PetOpenAction = 'focus-main' | 'open-ops' | 'open-terminal';

/**
 * POR QUE a missão parou, já apresentado. Viaja com o evento porque a janela
 * do pet não tem acesso às lojas: sem isto o balão só sabia dizer "a missão
 * parou esperando uma decisão", que não deixa ninguém agir. Campos já
 * truncados e saneados em `mission-block-cause.ts`.
 */
export interface PetEventCause {
  code: MissionBlockCauseCode;
  /** O que aconteceu, em uma frase. */
  headline: string;
  /** O que o operador faz agora. */
  action: string;
}

export interface PetEvent {
  kind: PetEventKind;
  /** Título curto para o balão (nome da missão / título do pane). */
  title: string;
  at: number;
  /**
   * Missão exata do evento, quando ele nasce de uma única missão. Permite ao
   * renderer navegar direto para o diagnóstico em vez de abrir uma lista.
   */
  missionId?: string;
  /** Razão do bloqueio/falha, quando o evento nasce de uma missão. */
  cause?: PetEventCause;
}

/** Atenção operacional: atravessa o modo "dormindo" e abre o Ops Board. */
export function isPetUrgentEvent(kind: PetEventKind): boolean {
  return (
    kind === 'mission-blocked' ||
    kind === 'mission-technical-failure' ||
    kind === 'agent-waiting'
  );
}

export function petOpenActionFor(kind: PetEventKind): PetOpenAction {
  if (
    kind === 'goal-wave-started' ||
    kind === 'goal-wave-completed' ||
    kind === 'goal-gate-passed' ||
    kind === 'goal-finished'
  ) {
    return 'open-terminal';
  }
  if (
    kind === 'mission-blocked' ||
    kind === 'mission-technical-failure' ||
    kind === 'agent-waiting' ||
    kind === 'mission-failed' ||
    kind === 'mission-done' ||
    kind === 'agent-exited'
  ) {
    return 'open-ops';
  }
  return 'focus-main';
}

/** Contrato exposto pelo pet-preload como `window.nexusPet` (janela do pet). */
export interface NexusPetApi {
  getPrefs(): Promise<PetPrefs>;
  setPrefs(patch: Partial<PetPrefs>): Promise<PetPrefs>;
  onPrefsChanged(cb: (prefs: PetPrefs) => void): () => void;
  onEvent(cb: (event: PetEvent) => void): () => void;
  /** Handshake após registrar onEvent; impede perder avisos durante o boot. */
  ready(): void;
  /** Confirma localmente que o balão entrou na renderização. */
  eventShown(kind: PetEventKind): void;
  /** Direção do olhar (0..15, horário a partir de cima) ou null = idle. */
  onLook(cb: (dir: number | null) => void): () => void;
  /** Ancoragem visual dentro da janela transparente segura. */
  onPlacement(cb: (placement: PetPlacement) => void): () => void;
  setInteractive(interactive: boolean): void;
  /**
   * Sonda do main (Bug 7): hit-test das coords do cursor do SO quando o
   * forward do click-through pode ter morrido — o renderer decide se está
   * sobre zona interativa e re-arma a interatividade via setInteractive.
   */
  onCursorProbe(cb: (point: { x: number; y: number }) => void): () => void;
  dragBegin(offset: { x: number; y: number }): void;
  dragEnd(): void;
  /** Foca a janela principal (clique no balão) — sem abrir Settings. */
  focusMain(): void;
  /** Foca a principal e abre Settings → Aparência (menu "Configurar…"). */
  openSettings(): void;
  /**
   * Foca a principal e navega para o grid de terminais.
   */
  openTerminal(): void;
  /**
   * Foca a principal e pede o Ops Board (missão pronta / precisa de você).
   * Usado no clique do balão e no menu do pet.
   */
  openOps(): void;
  /** Patrulha autônoma: fase + direção atuais para a animação do sprite. */
  onRoam(cb: (state: PetRoamState) => void): () => void;
  /** Veto do renderer à patrulha (balão/menu/arrasto/reduced-motion). */
  setRoamHold(held: boolean): void;
  /** Contadores de vida útil para o HUD gamificado. */
  onStats(cb: (stats: PetLifetimeStats) => void): () => void;
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
    roam: false,
    hudTicker: true,
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
  if (!Array.isArray(value) || !PET_CUSTOM_GRID_SIZES.includes(value.length)) {
    return false;
  }
  const side = value.length;
  return value.every(
    (row) =>
      Array.isArray(row) &&
      row.length === side &&
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
  if (typeof patch.roam === 'boolean') out.roam = patch.roam;
  if (typeof patch.hudTicker === 'boolean') out.hudTicker = patch.hudTicker;
  return out;
}
