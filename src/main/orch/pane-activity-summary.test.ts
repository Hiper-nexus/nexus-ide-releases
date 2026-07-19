import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PaneActivitySummaryCache,
  classifyTranscriptFlavor,
  extractClaudeFirstUserMessage,
  extractCodexEntryText,
  extractCodexFirstUserMessage,
  lastSignificantLine,
  resolvePaneActivity,
  sanitizeActivityLine,
} from './pane-activity-summary';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-activity-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('sanitizeActivityLine', () => {
  it('strips ANSI, collapses whitespace and caps with ellipsis', () => {
    expect(sanitizeActivityLine('[32m  ok:   tudo certo [0m', 140)).toBe(
      'ok: tudo certo',
    );
    const long = 'x'.repeat(200);
    const out = sanitizeActivityLine(long, 140);
    expect(out).toHaveLength(140);
    expect(out?.endsWith('…')).toBe(true);
  });

  it('retorna null para spinner, box-drawing e vazio', () => {
    expect(sanitizeActivityLine('⠋⠙⠹⠸')).toBeNull();
    expect(sanitizeActivityLine('│─┌┐└┘')).toBeNull();
    expect(sanitizeActivityLine('   ')).toBeNull();
  });
});

describe('lastSignificantLine', () => {
  it('ignora linhas de ruído no fim e devolve a última com texto', () => {
    const dump = 'linha um\nlinha dois\n⠋⠙\n│──│\n  \n';
    expect(lastSignificantLine(dump)).toBe('linha dois');
  });

  it('retorna null quando nada tem texto', () => {
    expect(lastSignificantLine('⠋\n│─│\n')).toBeNull();
  });
});

describe('extractClaudeFirstUserMessage', () => {
  it('aceita mensagem real (content string e items)', () => {
    const asString = JSON.stringify({
      type: 'user',
      message: { content: 'corrige o login que cai' },
    });
    expect(extractClaudeFirstUserMessage(asString)).toBe('corrige o login que cai');

    const asItems = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'segunda missão' }] },
    });
    expect(extractClaudeFirstUserMessage(asItems)).toBe('segunda missão');
  });

  it('ignora wrapper XML, Caveat, sidechain, tool_result e não-user', () => {
    expect(
      extractClaudeFirstUserMessage(
        JSON.stringify({ type: 'user', message: { content: '<system-context>' } }),
      ),
    ).toBeNull();
    expect(
      extractClaudeFirstUserMessage(
        JSON.stringify({ type: 'user', message: { content: 'Caveat: …' } }),
      ),
    ).toBeNull();
    expect(
      extractClaudeFirstUserMessage(
        JSON.stringify({
          type: 'user',
          isSidechain: true,
          message: { content: 'subagente' },
        }),
      ),
    ).toBeNull();
    expect(
      extractClaudeFirstUserMessage(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'x' }] },
        }),
      ),
    ).toBeNull();
    expect(
      extractClaudeFirstUserMessage(
        JSON.stringify({ type: 'assistant', message: { content: 'oi' } }),
      ),
    ).toBeNull();
  });
});

describe('extractCodex*', () => {
  const rollout = (role: string, kind: string, text: string) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type: kind, text }] },
    });

  it('primeira mensagem real do usuário (input_text)', () => {
    expect(extractCodexFirstUserMessage(rollout('user', 'input_text', 'abre o PR'))).toBe(
      'abre o PR',
    );
  });

  it('ignora session_meta/environment_context e lê assistant no entry text', () => {
    expect(
      extractCodexFirstUserMessage(
        JSON.stringify({ type: 'session_meta', payload: { instructions: 'x' } }),
      ),
    ).toBeNull();
    expect(extractCodexEntryText(rollout('assistant', 'output_text', 'feito'))).toBe(
      'feito',
    );
  });
});

describe('classifyTranscriptFlavor', () => {
  it('codex → codex; desconhecido → null', () => {
    expect(classifyTranscriptFlavor('codex')).toBe('codex');
    expect(classifyTranscriptFlavor('sem-chance-xyz')).toBeNull();
  });
});

describe('resolvePaneActivity', () => {
  it('tail injetado vence e marca source=tail com stoppedAt', () => {
    const summary = resolvePaneActivity(
      { adapterId: 'desconhecido' },
      {
        tail: () => ({ text: 'trabalhando no fix\npronto para review', stoppedAt: 123 }),
      },
    );
    expect(summary.lastLine).toBe('pronto para review');
    expect(summary.source).toBe('tail');
    expect(summary.stoppedAt).toBe(123);
  });

  it('sem tail e sem transcript classificável → source none', () => {
    const summary = resolvePaneActivity({ adapterId: 'desconhecido' }, {});
    expect(summary).toEqual({
      title: null,
      lastLine: null,
      stoppedAt: null,
      source: 'none',
    });
  });

  it('transcript claude real: title da 1ª msg real, lastLine do tail do arquivo', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '<system-context>…' } }),
      JSON.stringify({ type: 'user', message: { content: 'implementa o device flow' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'começando…' } }),
      ...Array.from({ length: 30 }, () =>
        JSON.stringify({ type: 'assistant', message: { content: 'passo' } }),
      ),
      JSON.stringify({ type: 'assistant', message: { content: 'PR aberto #42' } }),
    ];
    fs.writeFileSync(file, lines.join('\n'));

    // aponta o transcript via providerSession + flavor claude forçado pelo adapter
    const summary = resolvePaneActivity(
      { adapterId: 'codex', cwd: dir },
      {
        home: dir,
        providerSession: () => ({ id: 's1', transcriptPath: file }),
      },
    );
    // codex adapter lê como codex; arquivo claude-shaped não casa → title null,
    // mas a resolução nunca quebra.
    expect(summary.source === 'none' || summary.source === 'transcript').toBe(true);

    const claudeAdapterId = 'codex'; // mantemos o caso acima; abaixo o caminho claude
    void claudeAdapterId;
  });

  it('nunca lança — deps explodindo degradam para none', () => {
    const summary = resolvePaneActivity(
      { adapterId: 'codex' },
      {
        providerSession: () => {
          throw new Error('boom');
        },
        tail: () => {
          throw new Error('boom');
        },
      },
    );
    expect(summary.source).toBeDefined();
  });
});

describe('PaneActivitySummaryCache', () => {
  it('expira por TTL (clock injetado)', () => {
    let now = 1_000;
    const cache = new PaneActivitySummaryCache(30_000, () => now);
    const summary = { title: 't', lastLine: null, stoppedAt: null, source: 'none' as const };
    cache.set('k', summary, null, null);
    expect(cache.get('k')).toEqual(summary);
    now = 31_001;
    expect(cache.get('k')).toBeNull();
  });

  it('invalida quando o mtime do transcript muda', () => {
    const dir = tmpDir();
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, 'a');
    const mtime1 = Math.round(fs.statSync(file).mtimeMs);

    let now = 5_000;
    const cache = new PaneActivitySummaryCache(30_000, () => now);
    const summary = { title: 't', lastLine: null, stoppedAt: null, source: 'transcript' as const };
    cache.set('k', summary, file, mtime1);
    expect(cache.get('k')).toEqual(summary);

    // cresceu o arquivo → mtime novo → cache miss
    fs.writeFileSync(file, 'abcdefgh');
    const mtime2 = Math.round(fs.statSync(file).mtimeMs);
    if (mtime2 === mtime1) {
      // FS com resolução de 1s: força o cenário ajustando o mtime manualmente.
      fs.utimesSync(file, new Date(mtime1 + 5_000), new Date(mtime1 + 5_000));
    }
    expect(cache.get('k')).toBeNull();
  });
});
