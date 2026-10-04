import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compileManifest, type CompiledGate } from '../../src/main/detect/compiler';
import { loadManifestDir } from '../../src/main/detect/manifest';
import { evaluateManifest } from '../../src/main/detect/evaluator';
import { sliceRegion } from '../../src/main/detect/regions';
import { OscTracker } from '../../src/main/detect/osc';
import { SessionScreenBuffer } from '../../src/main/detect/screen-buffer';
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
 'src/main/terminal/command-redaction.ts', 'src/main/orch/pane-pipe-core.ts',
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
for (const [shape, raw] of shapes) {
 const screen = new SessionScreenBuffer(); const osc = new OscTracker();
 for (let offset = 0; offset < raw.length; offset += 16_384) { const part = raw.slice(offset, offset + 16_384); screen.append('s', part); osc.feed('s', part); }
 const input = { screen: screen.tail('s', 32_768), oscTitle: osc.title('s'), oscProgress: osc.progress('s') };
 for (const literal of literals) measure(`${shape}:${literal.id}`, () => { literal.regex.lastIndex = 0; literal.regex.test(input.screen.slice(-literal.cap)); });
 for (const manifest of compiled) {
  for (const { rule, gate } of manifest.rules) {
   const patterns: RegExp[] = []; gates(gate, patterns); const region = sliceRegion(input, rule.region);
   for (let i = 0; i < patterns.length; i++) measure(`${shape}:${manifest.manifest.id}:${rule.id}:${i}`, () => { patterns[i].lastIndex = 0; patterns[i].test(region); });
  }
  measure(`${shape}:${manifest.manifest.id}:production-evaluator`, () => {
   const expected = evaluateManifest(manifest, input); let observed: unknown = null;
   const core = new PtyAnalysisCore([manifest], (result) => { for (const event of result.events) if (event.consumer === 'screen' && (event.value as { explain?: unknown }).explain) observed = (event.value as { explain: unknown }).explain; });
   let seq = 0; const feed = (body: object) => core.process({ sessionId: 's', workerEpoch: 1, generation: 1, eventSeq: ++seq, observedAt: Date.now(), ...body } as AnalysisInput);
   feed({ kind: 'bind', binding: { adapterId: manifest.manifest.id } }); feed({ kind: 'arm', consumer: 'screen', registration: 1 });
   for (let offset = 0; offset < raw.length; offset += 16_384) feed({ kind: 'data', data: raw.slice(offset, offset + 16_384) });
   feed({ kind: 'flush' }); core.close();
   if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`semantic parity failed: ${manifest.manifest.id}:${shape}`);
   semanticCases++;
  });
 }
}
port.postMessage({ kind: 'done', result: { label: 'C3 actual production windows + dedicated Worker audit', rawBytesPerShape: shapes.map(([name, raw]) => ({ name, bytes: Buffer.byteLength(raw) })), manifestCount: compiled.length, literalRegexCount: literals.length, tests, semanticCases, maxMs } });
