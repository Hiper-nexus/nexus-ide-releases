// Compara dois relatórios JSON do vitest: falhas novas na release × base.
import fs from 'node:fs';
import path from 'node:path';

const [, , basePath, relPath] = process.argv;
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function failures(report, root) {
  const out = new Map();
  for (const file of report.testResults) {
    const rel = path.relative(root, file.name).replaceAll('\\', '/');
    const asserts = file.assertionResults ?? [];
    if (asserts.length === 0 && file.status === 'failed') {
      out.set(`${rel} :: <suite não carregou>`, file.message?.slice(0, 300) ?? '');
    }
    for (const a of asserts) {
      if (a.status === 'failed') {
        out.set(`${rel} :: ${a.fullName}`, (a.failureMessages?.[0] ?? '').split('\n')[0].slice(0, 300));
      }
    }
  }
  return out;
}

const base = load(basePath);
const rel = load(relPath);
const baseRoot = path.dirname(base.testResults[0]?.name ?? '').split(/[\\/]src[\\/]|[\\/]companion[\\/]|[\\/]server[\\/]/)[0];
const relRoot = path.dirname(rel.testResults[0]?.name ?? '').split(/[\\/]src[\\/]|[\\/]companion[\\/]|[\\/]server[\\/]/)[0];
const bf = failures(base, baseRoot);
const rf = failures(rel, relRoot);

const fresh = [...rf.keys()].filter((k) => !bf.has(k));
const fixed = [...bf.keys()].filter((k) => !rf.has(k));
console.log(`base: ${base.numTotalTests} testes, ${base.numFailedTests} falhas | release: ${rel.numTotalTests} testes, ${rel.numFailedTests} falhas`);
console.log(`falhas novas na release: ${fresh.length} | falhas da base que sumiram: ${fixed.length}`);
const byFile = new Map();
for (const k of fresh) {
  const f = k.split(' :: ')[0];
  byFile.set(f, (byFile.get(f) ?? 0) + 1);
}
console.log('\n== falhas novas por arquivo ==');
for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${f}`);
console.log('\n== falhas novas (até 80) ==');
for (const k of fresh.slice(0, 80)) console.log(`- ${k}\n    ${rf.get(k)}`);
