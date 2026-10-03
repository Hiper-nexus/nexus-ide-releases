import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences';
import { compileManifest } from '../detect/compiler';
import { evaluateManifest } from '../detect/evaluator';
import { loadManifestDir } from '../detect/manifest';
import { OscTracker } from '../detect/osc';
import { SessionScreenBuffer } from '../detect/screen-buffer';
import {
  CliPromptAutoResponder,
  codexFolderAccessResponse,
  codexFolderTrustResponse,
  focusedMenuResponse,
} from '../orch/cli-prompt-autoresponder';
import { detectDevServerUrls } from '../orch/dev-server-detect';
import {
  extractJsonObject,
  extractLegacyHandoffsFromText,
  LegacyHandoffParser,
  repairTerminalLineWrap,
} from '../orch/legacy-handoff';
import { detectLimit } from '../orch/limit-detector';
import {
  MissionMarkerObserver,
  scanMissionMarker,
  trimLineDecoration,
} from '../orch/mission-completion-marker';
import { extractCompleteLines, sanitizeForInjection } from '../orch/pane-pipe-core';
import {
  newOutputSince,
  readSessionOutput,
  recordPaneSessionData,
  stripAnsi,
} from '../orch/pane-session-output';
import { CODEX_PASTE_MARKER, DEVIN_PASTE_MARKER } from '../orch/paste-ingest';
import { estimateTokens } from '../orch/pricing';
import { PtyStreamMissionControl } from '../orch/pty-stream-mission-control';
import {
  clearRemoteTerminalStreams,
  encodeRemoteTerminalOutput,
} from '../remote/remote-terminal-streams';
import { Osc133Scanner } from '../terminal/shell-integration-osc133';
import { cpuTimeMs } from '../../test/cpu-time';
import {
  isPromptEcho as isTokenPromptEcho,
  isTuiNoise,
  TokenSpeedMeter,
  visibleText,
} from '../usage/token-speed-meter';
import {
  FirstRunInterstitialResponder,
  normalizeScreenText,
  screenNamesOwnCwd,
} from './first-run-interstitial';

/**
 * F-764 C.3 — teto de tempo para as funções de texto de CADA tap de dados do
 * PTY (e da avaliação dos manifestos de detecção que o tap do detector agenda).
 *
 * Por que 16 KB: é o maior pedaço que um tap de análise recebe em regime — o
 * lote fecha em 32 KB só quando a sessão despeja de uma vez, e sob inundação
 * (C.2) os taps de análise recebem só o tail de 16 KB. Linear, 16 KB custa
 * ~1 ms; o teto de 50 ms só estoura com regex/varredura quadrática — foi isso
 * que travou o main em 03/10 (detectLimit: 300 ms por janela de TUI em branco,
 * a cada chunk).
 *
 * As entradas imitam o que TUIs emitem (espaço sem quebra de cursor absoluto,
 * linhas em branco, molduras, OSC/CSI cortados, JSON aninhado) e as formas
 * clássicas de backtracking (corrida de caracteres entre letras).
 *
 * Coberto por medição fora daqui: a regex privada de erro transitório do
 * failover (`TRANSIENT_NOISE_LINE`, < 1 ms nas mesmas formas). Os taps de
 * contagem do tool-util são O(1) por chunk e não leem o texto.
 */

const SIZE = 16_384;
const BUDGET_MS = 50;

const rows = (row: () => string, count: number) =>
  Array.from({ length: count }, row).join('\n').slice(-SIZE);

const INPUTS: ReadonlyArray<readonly [string, string]> = [
  ['espaço sem quebra', ' '.repeat(SIZE)],
  ['espaço sem quebra + x', `${' '.repeat(SIZE - 1)}x`],
  ['espaços entre letras', `a${' '.repeat(SIZE - 2)}b`],
  ['tabs entre letras', `a${'\t'.repeat(SIZE - 2)}b`],
  ['linhas em branco', '\n'.repeat(SIZE)],
  ['linhas de espaço', rows(() => ' '.repeat(131), 140)],
  ['caixa │…│', rows(() => `│${' '.repeat(129)}│`, 140)],
  ['moldura ⎿', rows(() => `  ⎿${' '.repeat(128)}`, 140)],
  ['moldura ─ + x', `${'─'.repeat(SIZE - 1)}x`],
  ['moldura entre letras', `a${'─'.repeat(SIZE - 2)}b`],
  ['pontos + x', `/${'.'.repeat(SIZE - 2)}x`],
  ['barras + x', `/${'/'.repeat(SIZE - 2)}x`],
  ['tabs e CR', '\t \r'.repeat(SIZE / 3)],
  ['ESC ] sem terminador', '\x1b]'.repeat(SIZE / 2)],
  ['ESC ] 0; título sem fim', `\x1b]0;${'a'.repeat(SIZE - 4)}`],
  ['OSC com BEL, sem ST', '\x1b]0;t\x07'.repeat(Math.floor(SIZE / 6))],
  ['OSC com ST, sem BEL', '\x1b]0;t\x1b\\'.repeat(Math.floor(SIZE / 7))],
  ['ESC [ sem final', '\x1b['.repeat(SIZE / 2)],
  ['CSI ; longo', `\x1b[${';'.repeat(SIZE - 2)}`],
  ['DCS ESC P sem ST', '\x1bP'.repeat(SIZE / 2)],
  ['C1 de 8 bits sem ST', '\u0090\u009d'.repeat(SIZE / 2)],
  ['ESC solto', '\x1b'.repeat(SIZE)],
  ['{ aninhado', '{'.repeat(SIZE)],
  ['{"a": aninhado', '{"a":'.repeat(Math.floor(SIZE / 5))],
  ['aspas e barra invertida', '"\\'.repeat(SIZE / 2)],
  ['marcador de handoff + {}', 'NEXUS_HANDOFF{}'.repeat(Math.floor(SIZE / 15))],
  ['marcador de handoff + {', `NEXUS_HANDOFF ${'{'.repeat(SIZE - 14)}`],
  ['PRONTO: repetido', 'PRONTO: x\n'.repeat(SIZE / 10)],
  ['PRONTO: no meio da linha', `x ${'PRONTO: '.repeat(Math.floor(SIZE / 8) - 1)}`],
  ['http://localhost: repetido', 'http://localhost:'.repeat(Math.floor(SIZE / 17))],
  ['Pasted Content sem fim', 'Pasted Content '.repeat(Math.floor(SIZE / 15))],
  ['❯ e espaços', rows(() => `❯${' '.repeat(100)}`, 170)],
  ['spinner braille', rows(() => `⠋ ${' '.repeat(100)}x`, 160)],
  ['opção de menu repetida', '› 1. '.repeat(Math.floor(SIZE / 5))],
  ['opencode repetido', 'opencode '.repeat(Math.floor(SIZE / 9))],
  ['kimi thinking repetido', 'kimi thinking '.repeat(Math.floor(SIZE / 14))],
  ['esc to interrupt repetido', 'esc to interrupt '.repeat(Math.floor(SIZE / 17))],
  ['status ( repetido', 'status ((((('.repeat(Math.floor(SIZE / 12))],
];

type Subject = readonly [string, (text: string) => unknown];

const BYPASS_BANNER = 'claude code running in bypass permissions mode';
const BUNDLED_MANIFESTS = loadManifestDir(
  path.resolve(__dirname, '../../../resources/agent-detection'),
).map(({ manifest }) => compileManifest(manifest));

const SUBJECTS: readonly Subject[] = [
  // ── detector (tap) ────────────────────────────────────────────────────────
  ['detector: OscTracker.feed', (t) => new OscTracker().feed('s', t)],
  ['detector: SessionScreenBuffer.append', (t) => new SessionScreenBuffer().append('s', t)],
  // ── command-block-tracker ─────────────────────────────────────────────────
  ['command-blocks: Osc133Scanner.push', (t) => new Osc133Scanner().push(t)],
  // ── mcp-server ────────────────────────────────────────────────────────────
  ['mcp-server: stripAnsi', (t) => stripAnsi(t)],
  ['mcp-server: LegacyHandoffParser.feed', (t) => new LegacyHandoffParser(() => {}).feed('s', t)],
  [
    'mcp-server: LegacyHandoffParser.feed coletando',
    (t) => {
      const parser = new LegacyHandoffParser(() => {});
      parser.feed('s', '### NEXUS_HANDOFF v1\n');
      parser.feed('s', t);
    },
  ],
  ['mcp-server: extractLegacyHandoffsFromText', (t) => extractLegacyHandoffsFromText(t)],
  ['mcp-server: extractJsonObject', (t) => extractJsonObject(t)],
  ['mcp-server: repairTerminalLineWrap', (t) => repairTerminalLineWrap(t)],
  [
    'mcp-server: cliPromptAutoResponder.observe',
    (t) => {
      const responder = new CliPromptAutoResponder(() => true, () => {});
      responder.bind('s', 'claude', Date.now(), { governed: false });
      responder.observe('s', t);
    },
  ],
  [
    'mcp-server: focusedMenuResponse',
    (t) =>
      focusedMenuResponse(
        `${BYPASS_BANNER}\n${t}`,
        BYPASS_BANNER,
        ['no, exit', 'yes, i accept'],
        'yes, i accept',
      ),
  ],
  ['mcp-server: codexFolderAccessResponse', (t) => codexFolderAccessResponse(`Folder access\n${t}`)],
  ['mcp-server: codexFolderTrustResponse', (t) => codexFolderTrustResponse(`Trust this folder?\n${t}`)],
  [
    'mcp-server: firstRunInterstitial.observe',
    (t) => {
      const responder = new FirstRunInterstitialResponder(() => true);
      responder.bind('s', { adapterId: 'kimi', missionId: 'm', cwd: '/tmp/x' });
      responder.observe('s', t);
    },
  ],
  ['mcp-server: normalizeScreenText', (t) => normalizeScreenText(t)],
  ['mcp-server: screenNamesOwnCwd', (t) => screenNamesOwnCwd(t, '/tmp/x')],
  [
    'mcp-server: missionMarkerObserver.observe',
    (t) => {
      const observer = new MissionMarkerObserver();
      observer.registerPrompt('s', 'Faça X e escreva PRONTO: resumo');
      observer.observe('s', t);
    },
  ],
  [
    'mcp-server: scanMissionMarker (sessão selada)',
    (t) => scanMissionMarker(t, ['p PRONTO: x'], { allowPartialLastLine: true }),
  ],
  ['mcp-server: trimLineDecoration', (t) => trimLineDecoration(t)],
  [
    'mcp-server: missionControl.feed',
    (t) => {
      const control = new PtyStreamMissionControl({
        createChannelId: () => 'canal',
        invoke: async () => ({ ok: true }) as never,
        isAuthorized: () => true,
        isInjectableIdle: () => false,
        write: () => true,
      });
      control.ensureChannel('s');
      control.feed('s', t);
    },
  ],
  // ── pane-registry (anel de saída + devServerScanner) ──────────────────────
  [
    'pane-registry: anel + readSessionOutput',
    (t) => {
      recordPaneSessionData('budget-ring', t);
      readSessionOutput('budget-ring', 400);
    },
  ],
  ['pane-registry: detectDevServerUrls', (t) => detectDevServerUrls(t)],
  ['pane-registry: newOutputSince', (t) => newOutputSince(t, `${t}\nnovo`)],
  // ── pane-pipe ─────────────────────────────────────────────────────────────
  [
    'pane-pipe: linhas completas',
    (t) => {
      const { lines } = extractCompleteLines('', t);
      for (const line of lines) sanitizeForInjection(stripAnsi(line));
    },
  ],
  // ── failover ──────────────────────────────────────────────────────────────
  ['failover: detectLimit', (t) => detectLimit(stripAnsi(t))],
  // ── paste-ingest ──────────────────────────────────────────────────────────
  [
    'paste-ingest: marcadores',
    (t) => {
      const plain = stripAnsi(t.slice(-8_192));
      CODEX_PASTE_MARKER.test(plain);
      DEVIN_PASTE_MARKER.test(plain);
    },
  ],
  // ── token-speed ───────────────────────────────────────────────────────────
  ['token-speed: stripAnsiEscapeSequences', (t) => stripAnsiEscapeSequences(t)],
  ['token-speed: visibleText', (t) => visibleText(t)],
  ['token-speed: isTuiNoise', (t) => isTuiNoise(visibleText(t))],
  ['token-speed: isPromptEcho', (t) => isTokenPromptEcho(visibleText(t), 'prompt de exemplo')],
  [
    'token-speed: noteOutput',
    (t) => {
      const meter = new TokenSpeedMeter();
      meter.noteSubmit('pane', 1, 'prompt');
      meter.noteOutput('pane', 2, t, 'modelo');
    },
  ],
  // ── cost-tracker ──────────────────────────────────────────────────────────
  ['cost-tracker: estimateTokens', (t) => estimateTokens(t)],
  // ── remote-output-bus ─────────────────────────────────────────────────────
  ['remote-output-bus: encodeRemoteTerminalOutput', (t) => encodeRemoteTerminalOutput('s', t)],
  // ── avaliação dos manifestos que o tap do detector agenda ─────────────────
  ...BUNDLED_MANIFESTS.map(
    (compiled): Subject => [
      `detector: manifesto ${compiled.manifest.id}`,
      (t) => evaluateManifest(compiled, { screen: stripAnsi(t), oscTitle: '', oscProgress: '' }),
    ],
  ),
];

describe('F-764 C.3: funções de texto dos taps de PTY com teto de tempo', () => {
  afterAll(() => {
    clearRemoteTerminalStreams();
  });

  it.each(SUBJECTS)('%s: < 50 ms em cada entrada adversarial de 16 KB', (_name, subject) => {
    const slow: string[] = [];
    for (const [label, text] of INPUTS) {
      // CPU do processo, melhor de duas depois do aquecimento: carga da
      // máquina não reprova função linear, quadrática estoura com qualquer carga.
      const ms = cpuTimeMs(() => subject(text));
      if (ms >= BUDGET_MS) slow.push(`${label}: ${ms.toFixed(1)} ms`);
    }
    expect(slow).toEqual([]);
  });
});
