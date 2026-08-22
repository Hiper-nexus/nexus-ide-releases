import { describe, expect, it } from 'vitest';
import {
  runDependencyAuditSensor,
  runTypecheckSensor,
} from './mechanical-sensors';

const execOk = async () => ({ stdout: '', stderr: '' });
const execFail = (stdout: string, code = 1) => async () => {
  throw Object.assign(new Error('tsc failed'), { code, stdout, killed: false });
};

/** exists falso: raízes "com-*" têm os arquivos esperados; "sem-nada" não. */
function fakeExists(path: string): boolean {
  if (path.includes('sem-nada')) return false;
  if (path.endsWith('tsconfig.json')) return true;
  if (path.endsWith('package.json')) return true;
  if (path.endsWith('node_modules/.bin/tsc')) return true;
  if (/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(path)) {
    return true;
  }
  return false;
}

const depsWithFs = { exec: execOk, exists: fakeExists };

describe('runTypecheckSensor', () => {
  const root = '/projeto-com-tsconfig';

  it('sem tsconfig → indisponível, nunca bloqueio', async () => {
    const result = await runTypecheckSensor('/sem-nada', depsWithFs);
    expect(result.status).toBe('unavailable');
    expect(result.findings).toEqual([]);
  });

  it('compilação limpa → passed', async () => {
    const result = await runTypecheckSensor(root, depsWithFs);
    expect(result.status).toBe('passed');
    expect(result.summary).toContain('✓');
  });

  it('erros de tsc viram findings high por arquivo:linha', async () => {
    const stdout = [
      'src/app.ts(10,5): error TS2304: Cannot find name "x".',
      'src/pagamento.ts(22,1): error TS2345: Argument of type "string" is not assignable.',
      'linha que não casa o padrão',
    ].join('\n');
    const result = await runTypecheckSensor(root, {
      ...depsWithFs,
      exec: execFail(stdout),
    });
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.file).toBe('src/app.ts');
    expect(result.findings[0]!.evidence).toContain('TS2304');
    expect(result.findings[1]!.file).toBe('src/pagamento.ts');
  });

  it('ENOENT (sem TypeScript instalado) → indisponível', async () => {
    const result = await runTypecheckSensor(root, {
      exists: fakeExists,
      exec: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(result.status).toBe('unavailable');
    expect(result.findings).toEqual([]);
  });
});

describe('runDependencyAuditSensor', () => {
  it('sem package.json → indisponível', async () => {
    const result = await runDependencyAuditSensor('/sem-nada', depsWithFs);
    expect(result.status).toBe('unavailable');
  });

  it('audit limpo → passed com contagens quando existem', async () => {
    const payload = {
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 2, low: 1 } },
      vulnerabilities: {},
    };
    const result = await runDependencyAuditSensor('/com-lockfile', {
      ...depsWithFs,
      exec: async () => ({ stdout: JSON.stringify(payload), stderr: '' }),
    });
    expect(result.status).toBe('passed');
    expect(result.summary).toContain('2 média(s)');
  });

  it('vulnerabilidade crítica/alta vira finding bloqueante — mesmo com exit ≠ 0', async () => {
    const payload = {
      metadata: { vulnerabilities: { critical: 1, high: 1, moderate: 0, low: 0 } },
      vulnerabilities: {
        'lib-malvada': { name: 'lib-malvada', severity: 'critical' },
        'outra-lib': { name: 'outra-lib', severity: 'high' },
      },
    };
    // npm audit sai com código != 0 quando acha vulnerabilidade; o JSON vem.
    const result = await runDependencyAuditSensor('/com-lockfile', {
      exists: fakeExists,
      exec: execFail(JSON.stringify(payload)),
    });
    expect(result.status).toBe('failed');
    expect(result.findings.map((f) => f.severity)).toEqual([
      'critical',
      'high',
    ]);
    expect(result.findings[0]!.file).toContain('lib-malvada');
  });

  it('moderate/low não bloqueiam', async () => {
    const payload = {
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 3, low: 2 } },
      vulnerabilities: {
        a: { severity: 'moderate' },
        b: { severity: 'low' },
      },
    };
    const result = await runDependencyAuditSensor('/com-lockfile', {
      exists: fakeExists,
      exec: execFail(JSON.stringify(payload)),
    });
    expect(result.status).toBe('passed');
  });

  it('saída não-JSON (registry offline) → indisponível', async () => {
    const result = await runDependencyAuditSensor('/com-lockfile', {
      exists: fakeExists,
      exec: execFail('npm ERR! network'),
    });
    expect(result.status).toBe('unavailable');
  });
});
