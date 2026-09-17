/**
 * Desktop control adapter — `nexus_computer_do` (macOS only).
 *
 * Todo acesso ao SO sai por `/usr/bin/osascript -l JavaScript` (JXA) via
 * execFile — nunca shell, nunca interpolação de strings do usuário no script:
 * dados vão como argv depois de `--` e o script os lê em `run(argv)`. Cada
 * chamada tem timeout de 8 s e devolve JSON no stdout.
 *
 * Campos seguros (AXSecureTextField) nunca têm o valor lido nem recebem texto.
 * Nomes/valores passam por redactVisibleSecrets + redactSecrets antes de sair
 * do adapter. Pixels de captura nunca saem da máquina.
 */
import { execFile } from 'node:child_process';
import { redactVisibleSecrets } from '../../shared/vision-ipc';
import { ScreenRecordingPermissionDenied } from '../../shared/vision-ipc';
import { redactSecrets } from '../jev/jev-client';
import { getScreenPermissionStatus } from './screen-capture';

const OSASCRIPT = '/usr/bin/osascript';
const JXA_TIMEOUT_MS = 8_000;
const JXA_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_MAX_ELEMENTS = 150;
const MATCH_TOLERANCE_PT = 4;
const ACTIVATE_DELAY_MS = 500;
const DOUBLE_CLICK_GAP_MS = 150;

export class DesktopControlUnsupported extends Error {
  constructor() {
    super('nexus_computer_do: controle de desktop só existe no macOS');
    this.name = 'DesktopControlUnsupported';
  }
}

export class DesktopElementGone extends Error {
  constructor() {
    super('o elemento sumiu da tela — a tela mudou');
    this.name = 'DesktopElementGone';
  }
}

export class DesktopSensitiveField extends Error {
  constructor() {
    super('campo sensível recusado');
    this.name = 'DesktopSensitiveField';
  }
}

export interface DesktopFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DesktopElement {
  i: number;
  role: string;
  subrole?: string;
  name: string;
  value?: string;
  enabled: boolean;
  frame: DesktopFrame;
  sensitive: boolean;
  actions: string[];
  kind: 'clickable' | 'textfield' | 'other';
}

export interface DesktopElementList {
  windowTitle: string;
  elements: DesktopElement[];
}

export interface DesktopTarget {
  role: string;
  name: string;
  frame: DesktopFrame;
}

export interface DesktopWindowCapture {
  png: Buffer;
  /** Posição/tamanho da janela em pontos de tela. */
  frame: DesktopFrame;
  /** pixels do PNG ÷ pontos da janela (para converter bbox do OCR). */
  scale: number;
}

export type DesktopKeyName =
  | 'enter'
  | 'escape'
  | 'tab'
  | 'pagedown'
  | 'pageup';

export interface DesktopControl {
  accessibilityStatus(): 'granted' | 'denied';
  requestAccessibility(): 'granted' | 'denied';
  frontmostApp(): Promise<string>;
  activate(app: string): Promise<void>;
  listElements(app: string, opts?: { max?: number }): Promise<DesktopElementList>;
  press(app: string, target: DesktopTarget): Promise<void>;
  doubleClick(app: string, target: DesktopTarget): Promise<void>;
  setValue(app: string, target: DesktopTarget, text: string): Promise<void>;
  pressKey(name: DesktopKeyName): Promise<void>;
  captureWindow(app: string): Promise<DesktopWindowCapture | null>;
}

const SENSITIVE_NAME_RE = /password|senha|passcode/i;
const CLICKABLE_ROLES = new Set([
  'AXButton',
  'AXLink',
  'AXCheckBox',
  'AXRadioButton',
  'AXMenuItem',
  'AXMenuButton',
  'AXPopUpButton',
  'AXTab',
  'AXCell',
]);
const TEXTFIELD_ROLES = new Set([
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXSearchField',
]);

function kindOf(role: string, actions: string[], enabled: boolean): DesktopElement['kind'] {
  if (!enabled) return 'other';
  if (TEXTFIELD_ROLES.has(role)) return 'textfield';
  if (actions.includes('AXPress') || CLICKABLE_ROLES.has(role)) return 'clickable';
  return 'other';
}

function redactField(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return value;
  return redactSecrets(redactVisibleSecrets(value)).replace(/\s+/g, ' ').trim();
}

function requireDarwin(): void {
  if (process.platform !== 'darwin') throw new DesktopControlUnsupported();
}

type ExecFileFn = typeof execFile;
let execFileImpl: ExecFileFn = execFile;

/** Test seam — troca a implementação de execFile sem mexer no fs. */
export function setExecFileForTesting(fn: ExecFileFn | null): void {
  execFileImpl = fn ?? execFile;
}

function runJxa(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      OSASCRIPT,
      ['-l', 'JavaScript', '-e', script, '--', ...args],
      { timeout: JXA_TIMEOUT_MS, maxBuffer: JXA_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : err.message;
          reject(new Error(`osascript: ${detail}`));
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout));
      },
    );
  });
}

function parseJson<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`osascript: resposta inválida em ${what}`);
  }
}

/* ------------------------------------------------------------------ */
/* JXA scripts — dados do usuário chegam SÓ por argv (run(argv)).       */
/* ------------------------------------------------------------------ */

const SCRIPT_FRONTMOST = `
function run() {
  var se = Application('System Events');
  var procs = se.processes.whose({ frontmost: true })();
  return JSON.stringify({ app: procs.length ? String(procs[0].name()) : '' });
}`;

const SCRIPT_ACTIVATE = `
function run(argv) {
  var app = Application(argv[0]);
  app.activate();
  delay(${ACTIVATE_DELAY_MS / 1000});
  return JSON.stringify({ ok: true });
}`;

const SCRIPT_LIST = `
function run(argv) {
  var app = argv[0];
  var max = parseInt(argv[1], 10);
  var se = Application('System Events');
  var proc = se.processes.byName(app);
  var win = proc.windows[0];
  var title = '';
  try { title = String(win.name() || ''); } catch (e) {}
  var all = [];
  try { all = win.entireContents(); } catch (e) {}
  var out = [];
  for (var k = 0; k < all.length; k++) {
    var el = all[k];
    var role = '';
    try { role = String(el.role() || ''); } catch (e) {}
    if (!role) continue;
    var subrole = null;
    try { subrole = el.subrole(); } catch (e) {}
    var name = '';
    try { name = el.name(); } catch (e) {}
    if (!name) { try { name = el.title(); } catch (e) {} }
    if (!name) { try { name = el.description(); } catch (e) {} }
    var value = null;
    if (role !== 'AXSecureTextField') {
      try { var v = el.value(); if (v !== null && v !== undefined) value = String(v); } catch (e) {}
    }
    var enabled = true;
    try { enabled = !!el.enabled(); } catch (e) {}
    var pos = [0, 0], size = [0, 0];
    try { var p = el.position(); pos = [p[0], p[1]]; } catch (e) {}
    try { var s = el.size(); size = [s[0], s[1]]; } catch (e) {}
    var actions = [];
    try { actions = el.actions().map(function (a) { return String(a.name()); }); } catch (e) {}
    out.push({
      role: role,
      subrole: subrole ? String(subrole) : null,
      name: String(name || ''),
      value: value,
      enabled: enabled,
      frame: { x: pos[0], y: pos[1], w: size[0], h: size[1] },
      actions: actions
    });
    if (out.length >= max) break;
  }
  return JSON.stringify({ title: title, elements: out });
}`;

const SCRIPT_WINDOW_FRAME = `
function run(argv) {
  var se = Application('System Events');
  var proc = se.processes.byName(argv[0]);
  var win = proc.windows[0];
  var title = '';
  try { title = String(win.name() || ''); } catch (e) {}
  var p = win.position(), s = win.size();
  return JSON.stringify({ title: title, x: p[0], y: p[1], w: s[0], h: s[1] });
}`;

/* Localiza o elemento (role+name+frame ±4pt) e executa ação:
   argv = [app, targetJson, mode]  mode: 'press' | 'double' | 'click' */
const SCRIPT_PRESS = `
function run(argv) {
  var app = argv[0];
  var t = JSON.parse(argv[1]);
  var mode = argv[2];
  var se = Application('System Events');
  var proc = se.processes.byName(app);
  var els = [];
  try { els = proc.windows[0].entireContents(); } catch (e) {}
  var found = null;
  for (var k = 0; k < els.length; k++) {
    var el = els[k];
    var role = '';
    try { role = String(el.role() || ''); } catch (e) {}
    if (role !== t.role) continue;
    var name = '';
    try { name = el.name(); } catch (e) {}
    if (!name) { try { name = el.title(); } catch (e) {} }
    if (!name) { try { name = el.description(); } catch (e) {} }
    if (String(name || '') !== t.name) continue;
    var p;
    try { p = el.position(); } catch (e) { continue; }
    if (Math.abs(p[0] - t.frame.x) <= ${MATCH_TOLERANCE_PT} &&
        Math.abs(p[1] - t.frame.y) <= ${MATCH_TOLERANCE_PT}) { found = el; break; }
  }
  if (!found) return JSON.stringify({ ok: false, gone: true });
  if (mode !== 'click') {
    try {
      var acts = found.actions().map(function (a) { return String(a.name()); });
      if (acts.indexOf('AXPress') >= 0) {
        found.actions.byName('AXPress').perform();
        if (mode === 'double') { delay(${(DOUBLE_CLICK_GAP_MS / 1000)}); found.actions.byName('AXPress').perform(); }
        return JSON.stringify({ ok: true });
      }
    } catch (e) {}
  }
  var cx = Math.round(t.frame.x + t.frame.w / 2);
  var cy = Math.round(t.frame.y + t.frame.h / 2);
  se.click({ at: { x: cx, y: cy } });
  if (mode === 'double') { delay(${DOUBLE_CLICK_GAP_MS / 1000}); se.click({ at: { x: cx, y: cy } }); }
  return JSON.stringify({ ok: true });
}`;

/* argv = [app, targetJson, text] — nunca escreve em AXSecureTextField. */
const SCRIPT_SET_VALUE = `
function run(argv) {
  var app = argv[0];
  var t = JSON.parse(argv[1]);
  var text = argv[2];
  var se = Application('System Events');
  var proc = se.processes.byName(app);
  var els = [];
  try { els = proc.windows[0].entireContents(); } catch (e) {}
  var found = null;
  for (var k = 0; k < els.length; k++) {
    var el = els[k];
    var role = '';
    try { role = String(el.role() || ''); } catch (e) {}
    if (role !== t.role) continue;
    var name = '';
    try { name = el.name(); } catch (e) {}
    if (!name) { try { name = el.title(); } catch (e) {} }
    if (!name) { try { name = el.description(); } catch (e) {} }
    if (String(name || '') !== t.name) continue;
    var p;
    try { p = el.position(); } catch (e) { continue; }
    if (Math.abs(p[0] - t.frame.x) <= ${MATCH_TOLERANCE_PT} &&
        Math.abs(p[1] - t.frame.y) <= ${MATCH_TOLERANCE_PT}) { found = el; break; }
  }
  if (!found) return JSON.stringify({ ok: false, gone: true });
  if (t.role === 'AXSecureTextField') return JSON.stringify({ ok: false, sensitive: true });
  try { found.value = text; } catch (e) {}
  var read = null;
  try { var v = found.value(); read = v === null || v === undefined ? '' : String(v); } catch (e) {}
  if (read === text) return JSON.stringify({ ok: true });
  try { found.actions.byName('AXRaise').perform(); } catch (e) {}
  var cx = Math.round(t.frame.x + t.frame.w / 2);
  var cy = Math.round(t.frame.y + t.frame.h / 2);
  try { se.click({ at: { x: cx, y: cy } }); } catch (e) {}
  delay(0.15);
  se.keystroke('a', { using: 'command down' });
  var ascii = /^[\x20-\x7E\n\t]*$/.test(text);
  if (ascii) {
    se.keystroke(text);
  } else {
    var std = Application.currentApplication();
    std.includeStandardAdditions = true;
    var prev = '';
    try { prev = std.theClipboard(); } catch (e) {}
    std.setTheClipboardTo(text);
    se.keystroke('v', { using: 'command down' });
    delay(0.1);
    try { std.setTheClipboardTo(prev || ' '); } catch (e) {}
  }
  var read2 = null;
  try { var v2 = found.value(); read2 = v2 === null || v2 === undefined ? '' : String(v2); } catch (e) {}
  return JSON.stringify({ ok: true, verified: read2 === text });
}`;

const SCRIPT_KEY = `
function run(argv) {
  Application('System Events').keyCode(parseInt(argv[0], 10));
  return JSON.stringify({ ok: true });
}`;

const KEY_CODES: Record<DesktopKeyName, number> = {
  enter: 36,
  escape: 53,
  tab: 48,
  pagedown: 121,
  pageup: 116,
};

/* ------------------------------------------------------------------ */
/* Implementação                                                       */
/* ------------------------------------------------------------------ */

let electronOverride: typeof import('electron') | null = null;

/** Test seam — injeta o módulo electron mockado (require() não passa no mock). */
export function setElectronForTesting(
  electron: typeof import('electron') | null,
): void {
  electronOverride = electron;
}

function electronModule(): typeof import('electron') {
  if (electronOverride) return electronOverride;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('electron') as typeof import('electron');
}

function accessibilityStatus(): 'granted' | 'denied' {
  requireDarwin();
  const trusted = electronModule().systemPreferences.isTrustedAccessibilityClient(false);
  return trusted ? 'granted' : 'denied';
}

function requestAccessibility(): 'granted' | 'denied' {
  requireDarwin();
  const trusted = electronModule().systemPreferences.isTrustedAccessibilityClient(true);
  return trusted ? 'granted' : 'denied';
}

async function frontmostApp(): Promise<string> {
  requireDarwin();
  const out = parseJson<{ app: string }>(await runJxa(SCRIPT_FRONTMOST, []), 'frontmostApp');
  return out.app;
}

async function activate(app: string): Promise<void> {
  requireDarwin();
  await runJxa(SCRIPT_ACTIVATE, [app]);
}

async function listElements(
  app: string,
  opts: { max?: number } = {},
): Promise<DesktopElementList> {
  requireDarwin();
  const max = opts.max ?? DEFAULT_MAX_ELEMENTS;
  const out = parseJson<{
    title: string;
    elements: Array<{
      role: string;
      subrole: string | null;
      name: string;
      value: string | null;
      enabled: boolean;
      frame: DesktopFrame;
      actions: string[];
    }>;
  }>(await runJxa(SCRIPT_LIST, [app, String(max)]), 'listElements');

  const elements = out.elements
    .filter((el) => el.frame.w > 0 && el.frame.h > 0)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
    .slice(0, max)
    .map((el, i) => {
      const name = redactField(el.name) ?? '';
      const value = redactField(el.value ?? undefined);
      const sensitive =
        el.role === 'AXSecureTextField' || SENSITIVE_NAME_RE.test(name);
      return {
        i,
        role: el.role,
        ...(el.subrole ? { subrole: el.subrole } : {}),
        name,
        // Campo sensível por nome também não carrega valor para o Jev.
        ...(value !== undefined && !sensitive ? { value } : {}),
        enabled: el.enabled,
        frame: el.frame,
        sensitive,
        actions: el.actions,
        kind: kindOf(el.role, el.actions, el.enabled),
      } satisfies DesktopElement;
    });
  return { windowTitle: redactField(out.title) ?? '', elements };
}

async function runPress(
  app: string,
  target: DesktopTarget,
  mode: 'press' | 'double' | 'click',
): Promise<void> {
  requireDarwin();
  const out = parseJson<{ ok: boolean; gone?: boolean }>(
    await runJxa(SCRIPT_PRESS, [app, JSON.stringify(target), mode]),
    'press',
  );
  if (out.gone) throw new DesktopElementGone();
  if (!out.ok) throw new Error('osascript: ação não executada');
}

async function press(app: string, target: DesktopTarget): Promise<void> {
  await runPress(app, target, 'press');
}

async function doubleClick(app: string, target: DesktopTarget): Promise<void> {
  await runPress(app, target, 'double');
}

async function setValue(app: string, target: DesktopTarget, text: string): Promise<void> {
  requireDarwin();
  const out = parseJson<{ ok: boolean; gone?: boolean; sensitive?: boolean }>(
    await runJxa(SCRIPT_SET_VALUE, [app, JSON.stringify(target), text]),
    'setValue',
  );
  if (out.gone) throw new DesktopElementGone();
  if (out.sensitive) throw new DesktopSensitiveField();
  if (!out.ok) throw new Error('osascript: valor não aplicado');
}

async function pressKey(name: DesktopKeyName): Promise<void> {
  requireDarwin();
  await runJxa(SCRIPT_KEY, [String(KEY_CODES[name])]);
}

function pngPixelSize(png: Buffer): { w: number; h: number } {
  // IHDR: largura/altura big-endian nos bytes 16..23.
  if (png.length < 24) return { w: 0, h: 0 };
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

async function captureWindow(app: string): Promise<DesktopWindowCapture | null> {
  requireDarwin();
  if (getScreenPermissionStatus() === 'denied') {
    throw new ScreenRecordingPermissionDenied();
  }
  const frame = parseJson<{ title: string; x: number; y: number; w: number; h: number }>(
    await runJxa(SCRIPT_WINDOW_FRAME, [app]),
    'captureWindow',
  );
  if (frame.w <= 0 || frame.h <= 0) return null;

  const { desktopCapturer, screen } = electronModule();
  const display = screen.getDisplayNearestPoint({ x: frame.x, y: frame.y });
  const scaleFactor = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: {
      width: Math.round(frame.w * scaleFactor),
      height: Math.round(frame.h * scaleFactor),
    },
    fetchWindowIcons: false,
  });
  const source =
    sources.find((s) => s.name === frame.title) ??
    sources.find((s) => s.name.includes(app));
  if (!source) return null;

  const png = source.thumbnail.toPNG();
  const size = pngPixelSize(png);
  const scale = size.w > 0 && frame.w > 0 ? size.w / frame.w : 1;
  return { png, frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h }, scale };
}

/** Adapter de produção — todas as funções verificam a plataforma. */
export const desktopControl: DesktopControl = {
  accessibilityStatus,
  requestAccessibility,
  frontmostApp,
  activate,
  listElements,
  press,
  doubleClick,
  setValue,
  pressKey,
  captureWindow,
};

export function createDesktopControl(
  overrides: Partial<DesktopControl> = {},
): DesktopControl {
  return { ...desktopControl, ...overrides };
}
