import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const manifestPath = valueFor('--manifest');
const journalPath = valueFor('--journal');

if (!manifestPath || !journalPath) {
  console.error('usage: npm run eval:benchmark:verify -- --manifest <file> --journal <file>');
  process.exitCode = 2;
} else {
  const { verifyBenchmarkJournal } = await import('../src/main/eval/benchmark-contract.ts');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  const entries = fs
    .readFileSync(path.resolve(journalPath), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const verified = verifyBenchmarkJournal(entries, manifest);
  console.log(`verified ${verified.entries.length} benchmark entries for ${verified.runId}`);
}
