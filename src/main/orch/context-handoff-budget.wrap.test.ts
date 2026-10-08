/**
 * F-999 achado 7: o redator ancorado em prefixo (sk-, ghp_, Bearer, eyJ, PEM)
 * não reconhece a continuação de uma chave que a TUI partiu em linhas (Ink
 * emite \n por linha visual), nem a cauda que começa no meio dela. Segredos
 * sintéticos; os falsos positivos (hash curto, caminho, identificador) também
 * são cobrados aqui.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeHandoffHistoryText, terminalHistoryItems } from './context-handoff-budget';
import {
  SECRETS,
  dotenvDump,
  expectNoSecretFragment,
  hardWrap,
  inkWrap,
} from '../../shared/__tests__/synthetic-secrets';

const tail = (scrollback: string): string =>
  terminalHistoryItems(scrollback).map((item) => item.text).join('\n');

describe('F-999 achado 7: chave partida pela quebra de linha da TUI', () => {
  it('OPENAI_API_KEY=sk-proj-… a 80 colunas: nenhuma linha de continuação vaza', () => {
    const echo = hardWrap(`OPENAI_API_KEY=${SECRETS.openai}\nfim do comando`, 80);
    expect(echo.split('\n').length).toBeGreaterThan(3);
    const text = sanitizeHandoffHistoryText(echo);
    expect(text).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(text).toContain('fim do comando');
    expectNoSecretFragment(text);
  });

  it('`cat .env` inteiro: quebra dura, quebra Ink com moldura de ferramenta e 100 colunas', () => {
    for (const echo of [
      hardWrap(dotenvDump(), 80),
      inkWrap(dotenvDump(), 80, '  ⎿  ', '     '),
      inkWrap(dotenvDump(), 100),
    ]) {
      const text = tail(echo);
      expectNoSecretFragment(text);
      // Os nomes das variáveis e o que não é segredo continuam legíveis.
      for (const name of ['OPENAI_API_KEY=', 'GITHUB_TOKEN=', 'AWS_SECRET_ACCESS_KEY=', 'DATABASE_URL=postgres://app:', 'cat .env', 'ok']) {
        expect(text).toContain(name);
      }
    }
  });

  it('prefixo partido antes de casar sozinho: ghp_ curto, sk-pr no fim da linha, Bearer', () => {
    const ghp = hardWrap(`${'x'.repeat(60)} ${SECRETS.github} feito`, 80);
    expect(ghp.split('\n')[0]).toMatch(/ ghp_[A-Za-z0-9]{15}$/);
    const skpr = hardWrap(`${'p'.repeat(74)} ${SECRETS.openai} no .env`, 80);
    expect(skpr.split('\n')[0]).toMatch(/ sk-pr$/);
    const bearer = hardWrap(`curl -H "Authorization: Bearer ${SECRETS.jwt}" https://api.example.com`, 80);
    for (const echo of [ghp, skpr, bearer]) {
      const text = sanitizeHandoffHistoryText(echo);
      expectNoSecretFragment(text);
    }
  });

  it('cauda que começa no meio da chave ("oj-…"): o 1º token longo é tratado como parcial', () => {
    const cut = `${SECRETS.openai.slice(5)}\n$ npm test\n✓ 12 passed`;
    expect(cut.startsWith('oj-')).toBe(true);
    const text = tail(cut);
    expectNoSecretFragment(text);
    expect(text).toContain('12 passed');
    // Mesmo partida em várias linhas depois do corte.
    expectNoSecretFragment(tail(hardWrap(`${SECRETS.openai.slice(9)} resto`, 80)));
  });
});

describe('F-999 achado 7: falsos positivos do redator', () => {
  it('hash curto, caminho, identificador, data e versão no início da cauda ficam', () => {
    for (const head of [
      '9a3f2c1 fix(orch): F-999 pacote de continuidade',
      'rc/main/orch/failover-mission-respawn.ts:226:5 - error TS2345',
      'src/renderer/orch/failover-controller.ts | 12 +++---',
      'useFailoverControllerHarness();',
      'MAX_CONTINUITY_PACK_CHARS = 6_000',
      '2026-10-08T00:29:43.123Z INFO boot completo',
      'node_modules/.pnpm/vitest@3.2.4/node_modules/vitest',
      'v0.76.209-rc.1 publicado',
    ]) {
      const text = tail(`${head}\nlinha seguinte`);
      expect(text, head).toContain(head.split(' ')[0]!.replace(/[();]+$/, ''));
      expect(text, head).not.toContain('[REDACTED]');
    }
  });

  it('linha depois de um segredo que terminou na linha: caminho, comando e nome de variável ficam', () => {
    const text = tail([
      `export API_KEY=${SECRETS.openai}`,
      'src/main/orch/failover.ts | 12 +-',
      `GITHUB_TOKEN=${SECRETS.github}`,
      'diff --git a/src/login.ts b/src/login.ts',
      'a1b2c3d4e5f6 fix: login',
      `AWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}`,
      'DATABASE_URL=postgres://app@db:5432/app',
      `ANTHROPIC_API_KEY=${SECRETS.anthropic}`,
      'useFailoverControllerHarness();',
    ].join('\n'));
    expectNoSecretFragment(text);
    expect(text).toContain('src/main/orch/failover.ts | 12 +-');
    expect(text).toContain('GITHUB_TOKEN=[REDACTED]');
    expect(text).toContain('diff --git a/src/login.ts');
    expect(text).toContain('a1b2c3d4e5f6 fix: login');
    expect(text).toContain('DATABASE_URL=postgres://app@db:5432/app');
    expect(text).toContain('useFailoverControllerHarness();');
  });

  it('prosa quebrada pela TUI não perde palavras', () => {
    const prose =
      'O agente revisou o módulo de failover, rodou a suíte inteira e confirmou que o pacote de ' +
      'continuidade chega ao pane novo com os arquivos tocados, o diff e o próximo passo concreto.';
    const text = tail(inkWrap(prose, 80, '  ⎿  ', '     '));
    for (const word of prose.split(' ')) expect(text).toContain(word);
    expect(text).not.toContain('[REDACTED]');
  });
});

describe('F-999 (baixo): neutralizar sem mutilar identificador em prosa', () => {
  it('RateLimitError e resource_exhausted ficam legíveis (só quebrados), sem máscara paralela', () => {
    const text = sanitizeHandoffHistoryText('o SDK lançou RateLimitError e depois resource_exhausted');
    expect(text).not.toContain('rate cap');
    expect(text).not.toContain('[esgotado — citado]');
    expect(text).toMatch(/R.ateLimitError/);
    expect(text).toMatch(/r.esource_exhausted/);
  });
});
