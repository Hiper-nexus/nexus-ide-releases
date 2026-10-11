import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { importCliHistoryForScope } from './cli-history-import-service';
import { CommandBlockStore } from './command-block-store';

let userData = '';
let runtimeDir = '';
const managers: ProjectRuntimeManager[] = [];
const CHECKOUT = 'checkout-abc';

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clihist-ud-'));
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clihist-rt-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

function makeStore(): CommandBlockStore {
  const manager = new ProjectRuntimeManager({
    baseDir: fs.mkdtempSync(path.join(runtimeDir, 'db-')),
    appVersion: '0.15.5',
  });
  managers.push(manager);
  return new CommandBlockStore(manager, testProjectScope());
}

function claudeLine(command: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    cwd: '/workspace',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });
}

function writeTranscript(adapter: string, rel: string, lines: string[], checkout = CHECKOUT) {
  const file = path.join(userData, 'provider-state', adapter, checkout, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function deps(store: CommandBlockStore, extra: Record<string, unknown> = {}) {
  return {
    userDataPath: userData,
    checkoutId: CHECKOUT,
    target: { workspaceId: CHECKOUT, projectRoot: '/workspace' },
    fallbackCwd: '/workspace',
    insert: (input: Parameters<CommandBlockStore['insertWithOutcome']>[0]) =>
      store.insertWithOutcome(input).inserted,
    ...extra,
  };
}

describe('importCliHistoryForScope', () => {
  it('importa, conta e é idempotente ao reimportar', async () => {
    const store = makeStore();
    writeTranscript('claude', 'projects/p/s1.jsonl', [
      claudeLine('npm test', '2026-10-01T10:00:00Z'),
      claudeLine('git status', '2026-10-01T10:01:00Z'),
    ]);
    writeTranscript('codex', 'sessions/r.jsonl', [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-10-02T10:00:00Z',
        payload: { type: 'function_call', name: 'shell', arguments: { command: ['bash', '-lc', 'ls -la'], workdir: '/workspace' } },
      }),
    ]);

    const first = await importCliHistoryForScope(deps(store));
    expect(first).toEqual({
      files: 2,
      filesSkipped: 0,
      found: 3,
      imported: 3,
      duplicates: 0,
      skipped: 0,
      capped: false,
    });
    const second = await importCliHistoryForScope(deps(store));
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(3);
    expect(store.search({}).length).toBe(3);
  });

  it('linha sem cwd usa a raiz do projeto: reimportar de outro pane/pasta não duplica', async () => {
    const store = makeStore();
    // function_call do Codex sem workdir e linha Claude sem cwd.
    writeTranscript('codex', 'sessions/r.jsonl', [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-10-02T10:00:00Z',
        payload: { type: 'function_call', name: 'shell', arguments: { command: ['bash', '-lc', 'ls'] } },
      }),
      JSON.stringify({
        timestamp: '2026-10-02T10:01:00Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] },
      }),
    ]);
    const first = await importCliHistoryForScope(deps(store, { fallbackCwd: '/workspace/app' }));
    expect(first.imported).toBe(2);
    // O cwd vivo do pane mudou (OSC 7) ou o pedido veio de outro pane.
    const second = await importCliHistoryForScope(deps(store, { fallbackCwd: '/tmp/outra' }));
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(store.search({}).map((b) => b.cwd)).toEqual(['/workspace', '/workspace']);
  });

  it('só lê o checkout do escopo (outros projetos ficam de fora)', async () => {
    const store = makeStore();
    writeTranscript('claude', 'a.jsonl', [claudeLine('echo mine', '2026-10-01T10:00:00Z')]);
    writeTranscript('claude', 'b.jsonl', [claudeLine('echo other', '2026-10-01T10:00:00Z')], 'checkout-other');
    const counts = await importCliHistoryForScope(deps(store));
    expect(counts.imported).toBe(1);
    expect(store.search({}).map((b) => b.command)).toEqual(['echo mine']);
  });

  it('redige segredos antes de gravar', async () => {
    const store = makeStore();
    writeTranscript('claude', 'a.jsonl', [
      claudeLine('curl -H "Authorization: Bearer abcd.efgh.ijkl" https://x', '2026-10-01T10:00:00Z'),
    ]);
    await importCliHistoryForScope(deps(store));
    const [row] = store.search({});
    expect(row?.command).not.toContain('abcd.efgh');
    expect(row?.redaction.redacted).toBe(true);
  });

  it('arquivo corrompido ou ilegível não aborta a importação', async () => {
    const store = makeStore();
    writeTranscript('claude', 'bad.jsonl', ['{nao é json', 'null', '[1,2]']);
    const unreadable = writeTranscript('claude', 'locked.jsonl', [claudeLine('echo x', '2026-10-01T10:00:00Z')]);
    writeTranscript('claude', 'good.jsonl', [claudeLine('echo ok', '2026-10-01T10:00:00Z')]);
    const readFile = vi.fn(async (file: string) => {
      if (file === unreadable) throw new Error('EACCES');
      return fs.promises.readFile(file, 'utf8');
    });
    const counts = await importCliHistoryForScope(deps(store, { readFile }));
    expect(counts.files).toBe(2);
    expect(counts.filesSkipped).toBe(1);
    expect(counts.imported).toBe(1);
  });

  it('respeita os tetos de arquivos, bytes e comandos', async () => {
    const store = makeStore();
    writeTranscript('claude', 'big.jsonl', [claudeLine('echo big '.repeat(80), '2026-10-01T10:00:00Z')]);
    for (let i = 0; i < 3; i += 1) {
      writeTranscript('claude', `f${i}.jsonl`, [
        claudeLine(`echo ${i}a`, `2026-10-0${i + 1}T10:00:00Z`),
        claudeLine(`echo ${i}b`, `2026-10-0${i + 1}T10:01:00Z`),
      ]);
    }
    const bytes = await importCliHistoryForScope(deps(store, { maxBytesPerFile: 500 }));
    expect(bytes.filesSkipped).toBe(1);

    const store2 = makeStore();
    const files = await importCliHistoryForScope(deps(store2, { maxFiles: 2, maxBytesPerFile: 500 }));
    expect(files.capped).toBe(true);
    expect(files.files + files.filesSkipped).toBe(2);

    const store3 = makeStore();
    const blocks = await importCliHistoryForScope(deps(store3, { maxBlocks: 3, maxBytesPerFile: 500 }));
    expect(blocks.capped).toBe(true);
    expect(blocks.imported).toBe(3);
    expect(blocks.imported + blocks.duplicates + blocks.skipped).toBe(blocks.found);
    // Duplicado não gasta o teto: rodar de novo avança no que faltou.
    const again = await importCliHistoryForScope(deps(store3, { maxBlocks: 3, maxBytesPerFile: 500 }));
    expect(again.duplicates).toBe(3);
    expect(again.imported).toBe(3);
    expect(store3.search({}).length).toBe(6);
  });

  it('com mais transcripts que o teto, importa os mais recentes (não os primeiros do alfabeto)', async () => {
    const store = makeStore();
    const old = writeTranscript('claude', 'a-old.jsonl', [claudeLine('echo velho', '2026-09-01T10:00:00Z')]);
    const recent = writeTranscript('claude', 'z-new.jsonl', [claudeLine('echo novo', '2026-10-10T10:00:00Z')]);
    fs.utimesSync(old, new Date('2026-09-01T10:00:00Z'), new Date('2026-09-01T10:00:00Z'));
    fs.utimesSync(recent, new Date('2026-10-10T10:00:00Z'), new Date('2026-10-10T10:00:00Z'));
    const result = await importCliHistoryForScope(deps(store, { maxFiles: 1 }));
    expect(result.capped).toBe(true);
    expect(store.search({}).map(block => block.command)).toEqual(['echo novo']);
  });

  it('sem provider-state devolve zeros sem erro', async () => {
    const store = makeStore();
    const counts = await importCliHistoryForScope(deps(store));
    expect(counts.files).toBe(0);
    expect(counts.found).toBe(0);
  });

  it('cede o event loop entre arquivos (não trava o main)', async () => {
    const store = makeStore();
    for (let i = 0; i < 4; i += 1) {
      writeTranscript('claude', `f${i}.jsonl`, [claudeLine(`echo ${i}`, '2026-10-01T10:00:00Z')]);
    }
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 0);
    const yieldFn = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 2)));
    await importCliHistoryForScope(deps(store, { yieldToLoop: yieldFn }));
    clearInterval(timer);
    expect(yieldFn.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(ticks).toBeGreaterThan(0);
  });

  it('insert que falha conta como ignorado e segue', async () => {
    writeTranscript('claude', 'a.jsonl', [
      claudeLine('echo 1', '2026-10-01T10:00:00Z'),
      claudeLine('echo 2', '2026-10-01T10:01:00Z'),
    ]);
    let calls = 0;
    const counts = await importCliHistoryForScope({
      ...deps(makeStore()),
      insert: () => {
        calls += 1;
        if (calls === 1) throw new Error('conflict');
        return true;
      },
    });
    expect(counts.skipped).toBe(1);
    expect(counts.imported).toBe(1);
  });
});
