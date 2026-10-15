import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_XP_MAX_PROJECTS,
  GlobalXpLedger,
  globalProjectKey,
  globalProjectLabel,
} from './global-xp-ledger';

const dirs: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-gxp-'));
  dirs.push(dir);
  return path.join(dir, 'gamification', 'global-xp.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NOON = new Date(2026, 9, 15, 12).getTime();

describe('GlobalXpLedger', () => {
  it('soma o poder dos projetos e deriva patente e próximo marco', () => {
    const ledger = new GlobalXpLedger({ file: tmpFile(), now: () => NOON });
    ledger.record('a', 'nexus-ide', 6_886, 100);
    ledger.record('b', 'hipergo', 99_000, 500);
    const summary = ledger.summary('a');
    expect(summary.powerLevel).toBe(105_886);
    expect(summary.tier).toBe('INICIADO');
    expect(summary.nextTierAt).toBe(400_000);
    expect(summary.todayXp).toBe(600);
    expect(summary.projectCount).toBe(2);
    expect(summary.projects.map((p) => p.label)).toEqual(['hipergo', 'nexus-ide']);
    expect(summary.projects.find((p) => p.label === 'nexus-ide')?.current).toBe(true);
  });

  it('record é idempotente: valor absoluto, nunca acumula', () => {
    const ledger = new GlobalXpLedger({ file: tmpFile(), now: () => NOON });
    ledger.record('a', 'x', 1_000, 10);
    ledger.record('a', 'x', 1_000, 10);
    ledger.record('a', 'x', 1_200, 30);
    expect(ledger.summary().powerLevel).toBe(1_200);
    expect(ledger.summary().todayXp).toBe(30);
  });

  it('XP de hoje de outro dia não entra na soma', () => {
    let now = NOON;
    const ledger = new GlobalXpLedger({ file: tmpFile(), now: () => now });
    ledger.record('a', 'x', 1_000, 40);
    now += 2 * 86_400_000;
    expect(ledger.summary().todayXp).toBe(0);
    expect(ledger.summary().powerLevel).toBe(1_000);
  });

  it('persiste de forma atômica e relê em outra instância', () => {
    const file = tmpFile();
    const first = new GlobalXpLedger({ file, now: () => NOON });
    first.record('a', 'x', 2_500, 5);
    first.flush();
    const second = new GlobalXpLedger({ file, now: () => NOON });
    expect(second.summary().powerLevel).toBe(2_500);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(os.tmpdir());
  });

  it('arquivo corrompido ou fora do contrato recomeça vazio', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":2,"projects":{"a":{"power":-1}}}');
    expect(new GlobalXpLedger({ file }).summary().powerLevel).toBe(0);
    fs.writeFileSync(file, 'não é json');
    expect(new GlobalXpLedger({ file }).summary().projectCount).toBe(0);
  });

  it('ignora poder inválido e respeita o teto de projetos', () => {
    const ledger = new GlobalXpLedger({ file: tmpFile(), now: () => NOON });
    ledger.record('a', 'x', Number.NaN, 0);
    ledger.record('a', 'x', -5, 0);
    expect(ledger.summary().projectCount).toBe(0);
    for (let i = 0; i < GLOBAL_XP_MAX_PROJECTS + 5; i += 1) ledger.record(`k${i}`, 'p', i, 0);
    expect(ledger.summary().projectCount).toBe(GLOBAL_XP_MAX_PROJECTS);
  });

  it('chave é hash estável sem caminho e rótulo é só a pasta', () => {
    const key = globalProjectKey({ installationId: 'i', projectId: 'p', checkoutId: 'c' });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(globalProjectKey({ installationId: 'i', projectId: 'p', checkoutId: 'c' }));
    expect(globalProjectLabel(path.join('home', 'x', 'hipergo'))).toBe('hipergo');
  });
});
