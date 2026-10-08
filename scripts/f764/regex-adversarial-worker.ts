import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compileManifest, type CompiledGate, type CompiledManifest } from '../../src/main/detect/compiler';
import { loadManifestDir } from '../../src/main/detect/manifest';
import { evaluateManifest, type DetectionExplain } from '../../src/main/detect/evaluator';
import { sliceRegion } from '../../src/main/detect/regions';
import { OscTracker } from '../../src/main/detect/osc';
import { SessionScreenBuffer, createDetectorScreenSource } from '../../src/main/detect/screen-buffer';
import { PtyAnalysisCore } from '../../src/main/pty/pty-analysis-core';
import type { AnalysisInput } from '../../src/main/pty/pty-analysis-protocol';
const port = parentPort!;
const root = workerData.root as string;
// The audit bundle lives in a private temp directory; resolve the pinned
// compiler from the repository instead of requiring a /tmp installation.
const ts = createRequire(path.join(root, 'package.json'))('typescript') as typeof import('typescript');
const compiled = loadManifestDir(path.join(root, 'resources/agent-detection')).map(({ manifest }) => compileManifest(manifest));
const shapes = [ ['space-x', ' '.repeat(999_999) + 'x'], ['dots-x', '.'.repeat(999_999) + 'x'], ['tabs-between', 'a' + '\t'.repeat(999_998) + 'b'], ['frames-x', '─'.repeat(333_333) + 'x'], ['digits-suffix', '9'.repeat(999_999) + '!'] ] as const;
const files = [
 'src/main/orch/limit-detector.ts', 'src/main/orch/failover-text-core.ts',
 'src/vendor/omp/rate-limit/classify.ts', 'src/vendor/omp/rate-limit/retry-after-text.ts',
 'src/main/detect/osc.ts', 'src/main/detect/screen-buffer.ts', 'src/main/detect/regions.ts',
 'src/shared/ansi-text.ts', 'src/shared/ansi-escape-sequences.ts',
 'src/main/orch/dev-server-detect.ts', 'src/main/orch/legacy-handoff.ts',
 'src/main/orch/mission-completion-marker-core.ts', 'src/main/orch/cli-prompt-autoresponder-core.ts',
 'src/main/pty/first-run-interstitial.ts', 'src/main/usage/token-speed-meter.ts',
 'src/main/usage/token-speed-input.ts', 'src/main/terminal/shell-integration-osc133.ts',
 'src/shared/secret-redaction.ts', 'src/main/orch/pane-pipe-core.ts',
];
const literals: { id: string; regex: RegExp; cap: number }[] = [];
for (const file of files) {
 const source = fs.readFileSync(path.join(root, file), 'utf8');
 const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
 const visit = (node: import('typescript').Node) => {
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
   const literal = node.getText(tree); const slash = literal.lastIndexOf('/');
   literals.push({ id: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`, regex: new RegExp(literal.slice(1, slash), literal.slice(slash + 1)), cap: file.includes('limit') || file.includes('failover') ? 4_000 : 32_768 });
  }
  ts.forEachChild(node, visit);
 }; visit(tree);
}
let maxMs = 0; let tests = 0; let semanticCases = 0;
function measure(id: string, run: () => void) {
 port.postMessage({ kind: 'start', id }); const start = performance.now(); run(); const ms = performance.now() - start;
 maxMs = Math.max(maxMs, ms); tests++; port.postMessage({ kind: 'end', id, ms });
 if (ms >= 250) throw new Error(`time cap exceeded: ${id}`);
}
function gates(gate: CompiledGate, collect: RegExp[]) { collect.push(...gate.regex, ...gate.lineRegex); for (const child of [...gate.all, ...gate.any, ...gate.not]) gates(child, collect); }
// F-1020: desde o F-998/DSK-03 o detector de produção lê a grade libghostty-vt
// (tela visível 80×24, wraps reunidos) e o texto sem ANSI virou o fallback dela
// (wasm ausente, teto de grades, trap). A paridade confere os dois modos, cada
// um contra a referência do mesmo modelo de tela; as regexes seguem medidas na
// janela de texto de 32 KiB, a maior que o detector avalia.
const wasm = path.join(root, 'resources/ghostty/ghostty-vt.wasm');
const missingWasm = path.join(root, 'resources/ghostty/f1020-ausente.wasm');
function parity(id: string, manifest: CompiledManifest, raw: string, expected: DetectionExplain, ghosttyWasmPath: string, grid: boolean) {
 let observed: unknown = null; const fallbacks: string[] = [];
 const core = new PtyAnalysisCore([manifest], (result) => { for (const event of result.events) if (event.consumer === 'screen' && (event.value as { explain?: unknown }).explain) observed = (event.value as { explain: unknown }).explain; }, undefined, { ghosttyWasmPath, trace: (event) => fallbacks.push(event.reason) });
 let seq = 0; const feed = (body: object) => core.process({ sessionId: 's', workerEpoch: 1, generation: 1, eventSeq: ++seq, observedAt: Date.now(), ...body } as AnalysisInput);
 feed({ kind: 'bind', binding: { adapterId: manifest.manifest.id } }); feed({ kind: 'arm', consumer: 'screen', registration: 1 });
 for (let offset = 0; offset < raw.length; offset += 16_384) feed({ kind: 'data', data: raw.slice(offset, offset + 16_384) });
 feed({ kind: 'flush' }); core.close();
 if ((fallbacks.length === 0) !== grid) throw new Error(`screen model mismatch: ${id} grid=${grid} fallbacks=${fallbacks.join(',')}`);
 if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`semantic parity failed: ${id}`);
 semanticCases++;
}
for (const [shape, raw] of shapes) {
 const screen = new SessionScreenBuffer(); const osc = new OscTracker();
 let gridFallback: string | null = null;
 const grid = createDetectorScreenSource({ wasmPath: wasm, eligible: () => true, onFallback: (reason) => { gridFallback ??= reason; } });
 for (let offset = 0; offset < raw.length; offset += 16_384) { const part = raw.slice(offset, offset + 16_384); screen.append('s', part); grid.append('s', part); osc.feed('s', part); }
 const input = { screen: screen.tail('s', 32_768), oscTitle: osc.title('s'), oscProgress: osc.progress('s') };
 const gridInput = { ...input, screen: grid.tail('s', 32_768) };
 if (gridFallback) throw new Error(`ghostty grid reference fell back: ${shape}:${gridFallback}`);
 for (const literal of literals) measure(`${shape}:${literal.id}`, () => { literal.regex.lastIndex = 0; literal.regex.test(input.screen.slice(-literal.cap)); });
 for (const manifest of compiled) {
  for (const { rule, gate } of manifest.rules) {
   const patterns: RegExp[] = []; gates(gate, patterns); const region = sliceRegion(input, rule.region);
   for (let i = 0; i < patterns.length; i++) measure(`${shape}:${manifest.manifest.id}:${rule.id}:${i}`, () => { patterns[i].lastIndex = 0; patterns[i].test(region); });
  }
  measure(`${shape}:${manifest.manifest.id}:production-evaluator`, () => parity(`${manifest.manifest.id}:${shape}`, manifest, raw, evaluateManifest(manifest, gridInput), wasm, true));
  measure(`${shape}:${manifest.manifest.id}:production-evaluator-text`, () => parity(`${manifest.manifest.id}:${shape}:text`, manifest, raw, evaluateManifest(manifest, input), missingWasm, false));
 }
}
port.postMessage({ kind: 'done', result: { label: 'C3 actual production windows + dedicated Worker audit', screenModels: ['ghostty-grid', 'text-fallback'], rawBytesPerShape: shapes.map(([name, raw]) => ({ name, bytes: Buffer.byteLength(raw) })), manifestCount: compiled.length, literalRegexCount: literals.length, tests, semanticCases, maxMs } });
