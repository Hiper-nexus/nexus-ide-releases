import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runDependencyAuditSensor,
  runDependencyFreshnessSensor,
  runTestCoverageSensor,
  runTypecheckSensor,
} from './mechanical-sensors';

describe('dependency freshness advice', () => {
  const root = '/advisory-project';
  const files = {
    manifest: { dependencies: { legacy: '^1.0.0', local: 'file:../private', gitdep: 'git+https://private/token', workspace: 'workspace:*', privatepkg: '2.0.0' } },
    lock: { packages: { 'node_modules/legacy': { version: '1.0.0', resolved: 'https://registry.npmjs.org/legacy/-/legacy-1.0.0.tgz' },
      'node_modules/privatepkg': { version: '2.0.0', resolved: 'https://token@private.registry/package.tgz' } } },
  };
  it('reports deprecated/newer public direct versions as advice without requesting private/local specs', async () => {
    const requests: string[] = [];
    const result = await runDependencyFreshnessSensor(root, {
      allowNetwork: () => true,
      readJson: async (file) => file.endsWith('package.json') ? files.manifest : files.lock,
      metadata: async (name, version) => { requests.push(`${name}:${version}`); return { name, version: version === 'latest' ? '2.0.0' : version, ...(version !== 'latest' ? { deprecated: 'Use the maintained version.' } : {}) }; },
    });
    expect(requests.sort()).toEqual(['legacy:1.0.0', 'legacy:latest']);
    expect(result.status).toBe('passed');
    expect(result.findings.every((finding) => finding.severity === 'low')).toBe(true);
    expect(result.findings.map((finding) => finding.evidence).join(' ')).toContain('2.0.0');
    expect(result.findings.map((finding) => finding.evidence).join(' ')).toContain('descontinuad');
  });
  it('opt-out and offline are explicitly unverified and never a failed check', async () => {
    let requests = 0;
    const deps = { readJson: async () => ({ dependencies: { legacy: '1.0.0' } }), metadata: async () => { requests++; return null; } };
    const off = await runDependencyFreshnessSensor(root, { ...deps, allowNetwork: () => false });
    expect(requests).toBe(0);
    expect(off.status).toBe('unavailable');
    const offline = await runDependencyFreshnessSensor(root, { allowNetwork: () => true,
      readJson: async (file) => file.endsWith('package.json') ? files.manifest : files.lock,
      metadata: async () => null,
    });
    expect(offline.status).toBe('unavailable');
    expect(offline.summary).toContain('não verificada');
    expect(offline.findings).toEqual([]);
  });
  it('never requests token-like package names and caps public dependency inspection', async () => {
    const dependencies: Record<string, string> = {};
    const packages: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      dependencies[`safe-${i}`] = '1.0.0';
      packages[`node_modules/safe-${i}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/safe-${i}/-/safe-${i}-1.0.0.tgz` };
    }
    const token = `npm_${'a'.repeat(30)}`;
    dependencies[token] = '1.0.0';
    packages[`node_modules/${token}`] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/token/-/token-1.0.0.tgz' };
    const names: string[] = [];
    const result = await runDependencyFreshnessSensor(root, { allowNetwork: () => true,
      readJson: async (file) => file.endsWith('package.json') ? { dependencies } : { packages },
      metadata: async (name, version) => { names.push(name); return { name, version: version === 'latest' ? '1.0.0' : version }; },
    });
    expect(new Set(names).size).toBe(24);
    expect(names).not.toContain(token);
    expect(result.summary).toContain('7 não verificadas');
  });
  it('reads real files without mutation and refuses a symlinked manifest before egress', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-advice-')));
    const manifest = path.join(directory, 'package.json');
    const lock = path.join(directory, 'package-lock.json');
    fs.writeFileSync(manifest, JSON.stringify({ dependencies: { legacy: '1.0.0' } }));
    fs.writeFileSync(lock, JSON.stringify(files.lock));
    const original = [fs.readFileSync(manifest, 'utf8'), fs.readFileSync(lock, 'utf8')];
    let calls = 0;
    const metadata = async (name: string, version: string) => { calls++; return { name, version: version === 'latest' ? '1.0.0' : version }; };
    try {
      expect((await runDependencyFreshnessSensor(directory, { allowNetwork: () => true, metadata })).status).toBe('passed');
      expect([fs.readFileSync(manifest, 'utf8'), fs.readFileSync(lock, 'utf8')]).toEqual(original);
      expect(fs.readdirSync(directory).sort()).toEqual(['package-lock.json', 'package.json']);
      fs.renameSync(manifest, path.join(directory, 'private.json'));
      fs.symlinkSync(path.join(directory, 'private.json'), manifest);
      calls = 0;
      expect((await runDependencyFreshnessSensor(directory, { allowNetwork: () => true, metadata })).status).toBe('unavailable');
      expect(calls).toBe(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('refuses an invalid full manifest even when a short read returns a valid JSON prefix', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-short-read-')));
    const manifest = path.join(directory, 'package.json');
    fs.writeFileSync(manifest, '{} invalid trailing content');
    fs.writeFileSync(path.join(directory, 'package-lock.json'), '{}');
    const open = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (file === manifest) {
        const read = handle.read.bind(handle);
        let first = true;
        Object.defineProperty(handle, 'read', { value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const count = first ? Math.min(2, length) : length;
          first = false;
          return read(buffer, offset, count, position);
        } });
      }
      return handle;
    });
    const metadata = vi.fn(async () => null);
    try {
      expect((await runDependencyFreshnessSensor(directory, { allowNetwork: () => true, metadata })).status).toBe('unavailable');
      expect(metadata).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

const execOk = async () => ({ stdout: '', stderr: '' });
const execFail = (stdout: string, code = 1) => async () => {
  throw Object.assign(new Error('tsc failed'), { code, stdout, killed: false });
};

/** exists falso: raízes "com-*" têm os arquivos esperados; "sem-nada" não. */
function fakeExists(path: string): boolean {
  path = path.replaceAll('\\', '/');
  if (path.includes('sem-nada')) return false;
  if (path.endsWith('tsconfig.json')) return true;
  if (path.endsWith('package.json')) return true;
  if (path.endsWith('node_modules/.bin/tsc')) return true;
  if (/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(path)) {
    return true;
  }
  return false;
}

// These fake POSIX projects have no native Windows compiler package.
const depsWithFs = { exec: execOk, exists: fakeExists, platform: 'linux' as const };

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
      vulnerabilities: {
        'moderate-a': { severity: 'moderate' },
        'moderate-b': { severity: 'moderate' },
        'low-a': { severity: 'low' },
      },
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
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 1, low: 1 } },
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

  it.each(['ENOLOCK', 'EAI_AGAIN'])(
    'erro JSON %s do npm audit não é um relatório aprovado',
    async (code) => {
      const result = await runDependencyAuditSensor('/com-lockfile', {
        exists: fakeExists,
        exec: execFail(JSON.stringify({ error: { code, summary: 'Audit failed.' } })),
      });

      expect(result.status).toBe('unavailable');
      expect(result.findings).toEqual([]);
      expect(result.summary).not.toContain('✓');
    },
  );

  it.each([
    { critical: 1, high: 0 },
    { critical: 0, high: 2 },
    { critical: 1, high: 2 },
  ])('contagens bloqueantes $critical/$high sem registros não aprovam a auditoria', async (counts) => {
    const payload = {
      metadata: { vulnerabilities: { ...counts, moderate: 0, low: 0 } },
      vulnerabilities: {},
    };
    const result = await runDependencyAuditSensor('/com-lockfile', {
      exists: fakeExists,
      exec: execFail(JSON.stringify(payload)),
    });

    // F-408: este teste asserava `unavailable` com `findings: []`, que é o
    // desfecho NÃO bloqueante — civilian-auto-review monta `blocking` só a
    // partir de `result.findings`, então um controle que reportou contagens
    // críticas mas não conseguiu nomear os pacotes não barrava a entrega, e ela
    // era gravada como `proof.status: 'verified'`. O nome do teste sempre disse
    // "não aprovam"; agora o desfecho acompanha o nome.
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe(
      counts.critical > 0 ? 'critical' : 'high',
    );
    expect(result.summary).not.toContain('✓');
    expect(result.summary).toContain('não puderam ser lidos');
  });

  it('lockfile que não é package-lock.json bloqueia em vez de passar por auditado (F-408)', async () => {
    // `npm audit` exige package-lock.json. Num projeto pnpm/yarn/bun ele sai com
    // ENOLOCK sem produzir dado nenhum, e o resultado era `unavailable` com
    // `findings: []` — não bloqueante. A auditoria não executou, então a entrega
    // não pode ser registrada como verificada.
    const result = await runDependencyAuditSensor('/so-pnpm', {
      exists: (target: string) =>
        target.endsWith('package.json') || target.endsWith('pnpm-lock.yaml'),
      exec: async () => {
        throw new Error('npm audit should not be reached for a pnpm-only project');
      },
    });

    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('high');
    expect(result.summary).toContain('pnpm-lock.yaml');
  });

  it.each(['critical', 'high', 'moderate', 'low'] as const)(
    'contagem %s divergente dos registros torna o relatório indisponível',
    async (severity) => {
      const payload = {
        metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } },
        vulnerabilities: { lib: { severity } },
      };
      const result = await runDependencyAuditSensor('/com-lockfile', {
        exists: fakeExists,
        exec: async () => ({ stdout: JSON.stringify(payload), stderr: '' }),
      });

      expect(result.status).toBe('unavailable');
      expect(result.findings).toEqual([]);
    },
  );

  it.each([
    ['objeto vazio', {}],
    ['null', null],
    ['lista', []],
    ['relatório sem contagens', { vulnerabilities: {} }],
    ['vulnerabilidade malformada', {
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } },
      vulnerabilities: { lib: null },
    }],
    ['erro mesmo com campos de relatório', {
      error: { code: 'ENOLOCK' },
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } },
      vulnerabilities: {},
    }],
  ])('JSON inválido (%s) é indisponível mesmo com exit zero', async (_label, payload) => {
    const result = await runDependencyAuditSensor('/com-lockfile', {
      exists: fakeExists,
      exec: async () => ({ stdout: JSON.stringify(payload), stderr: '' }),
    });

    expect(result.status).toBe('unavailable');
    expect(result.findings).toEqual([]);
  });
});

describe('runTestCoverageSensor', () => {
  it('dispensa verificação se nenhum arquivo de código foi alterado', async () => {
    const result = await runTestCoverageSensor('/app', ['README.md', 'docs/plan.md']);
    expect(result.kind).toBe('test-coverage');
    expect(result.status).toBe('passed');
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('dispensada');
  });

  it('aprova quando arquivos de código possuem testes correspondentes', async () => {
    const result = await runTestCoverageSensor(
      '/app',
      ['src/foo.ts', 'src/foo.test.ts'],
      { exists: () => false },
    );
    expect(result.status).toBe('passed');
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('possuem testes');
  });

  it('detecta arquivos de código sem teste sibling existente', async () => {
    const result = await runTestCoverageSensor(
      '/app',
      ['src/bar.ts'],
      { exists: () => false },
    );
    expect(result.status).toBe('passed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe('src/bar.ts');
    expect(result.findings[0]?.severity).toBe('medium');
    expect(result.findings[0]?.recommendation).toContain('src/bar.test.ts');
  });
});

describe('declared typecheck configurations', () => {
  it.each(['tsc', 'vue-tsc'] as const)('runs only declared %s argv with an alternative local config', async compiler => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-typecheck-project-')));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: `${compiler} --noEmit -p "tsconfig.app.json"` } }));
      fs.writeFileSync(path.join(root, 'tsconfig.app.json'), '{}');
      fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules/.bin', compiler), 'fixture');
      const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
      const result = await runTypecheckSensor(root, { exec, platform: 'linux' });
      expect(result.status).toBe('passed');
      expect(exec).toHaveBeenCalledWith(path.join(root, 'node_modules/.bin', compiler), ['--project', path.join(root, 'tsconfig.app.json'), '--noEmit', '--pretty', 'false'], expect.objectContaining({ cwd: root, timeout: 120000 }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['echo success', 'tsc -p ../outside.json', 'tsc --noEmit && echo done', 'nx typecheck',
    'node ./scripts/typecheck.js', 'node --require ./hook.js ./node_modules/typescript/bin/tsc',
    'node ./node_modules/typescript/bin/tsserver', 'node --max-old-space-size=999999 ./node_modules/typescript/bin/tsc',
  ])('unsupported/unsafe script never claims execution: %s', async command => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-typecheck-denied-')));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: command } })); fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
      const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
      expect((await runTypecheckSensor(root, { exec })).status).toBe('unavailable'); expect(exec).not.toHaveBeenCalled();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

it.each(['tsc', 'vue-tsc'] as const)('Windows launches %s via native Node and package entry, never .cmd or shell', async compiler => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus windows compiler ')));
  try {
    const name = compiler === 'tsc' ? 'typescript' : 'vue-tsc';
    const pkg = path.join(root, 'node_modules', name);
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, bin: { [compiler]: 'bin/compiler.js' } }));
    fs.writeFileSync(path.join(pkg, 'bin/compiler.js'), 'fixture compiler entry');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: `${compiler} -p tsconfig.app.json` } }));
    fs.writeFileSync(path.join(root, 'tsconfig.app.json'), '{}');
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await runTypecheckSensor(root, { platform: 'win32', nodeExecutable: () => '/installed/node.exe', exec });
    expect(result.status).toBe('passed');
    expect(exec).toHaveBeenCalledWith('/installed/node.exe', [path.join(pkg, 'bin/compiler.js'), '--project', path.join(root, 'tsconfig.app.json'), '--noEmit', '--pretty', 'false'], expect.objectContaining({ cwd: root, windowsHide: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('supports the actual Nexus Node-wrapped typecheck without running an arbitrary script', async () => {
  const script = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).scripts.typecheck as string;
  expect(script).toContain('node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus own compiler ')));
  try {
    fs.mkdirSync(path.join(root, 'node_modules/typescript/bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/typescript/package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc' } }));
    fs.writeFileSync(path.join(root, 'node_modules/typescript/bin/tsc'), 'fixture');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: script } }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    expect((await runTypecheckSensor(root, { exec, nodeExecutable: () => process.execPath })).status).toBe('passed');
    expect(exec).toHaveBeenCalledWith(process.execPath, ['--max-old-space-size=4096', path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false'], expect.objectContaining({ cwd: root }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each([
  ['Makefile', 'all:\n\tprintf build-only\n'],
  ['pyproject.toml', '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n'],
  ['Cargo.toml', '[package]\nname = "fixture"\nversion = "0.1.0"\n'],
  ['go.mod', 'module example.invalid/fixture\ngo 1.23\n'],
])('build-only %s does not invent applicable tests', async (file, content) => {
  const { mechanicalProjectRequirements } = await import('./mechanical-sensors');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus build-only ')));
  try { fs.writeFileSync(path.join(root, file), content); expect((await mechanicalProjectRequirements(root)).tests).toBe(false); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each([
  ['pytest.ini', '[pytest]\n'],
  ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"\n'],
  ['Makefile', 'test:\n\tpython -m unittest\n'],
  ['Cargo.toml', '[[test]]\nname = "integration"\n'],
  ['calc_test.go', 'package fixture\n'],
  ['package.json', JSON.stringify({ scripts: { test: 'node tests/check.cjs' } })],
])('positive test declaration %s remains applicable', async (file, content) => {
  const { mechanicalProjectRequirements } = await import('./mechanical-sensors');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus declared tests ')));
  try { fs.writeFileSync(path.join(root, file), content); expect((await mechanicalProjectRequirements(root)).tests).toBe(true); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('rejects a Node wrapper when the installed package bin points to another entry', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus compiler mismatch ')));
  try {
    fs.mkdirSync(path.join(root, 'node_modules/typescript/bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/typescript/package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: './bin/other.js' } }));
    fs.writeFileSync(path.join(root, 'node_modules/typescript/bin/tsc'), 'fixture');
    fs.writeFileSync(path.join(root, 'node_modules/typescript/bin/other.js'), 'fixture');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node ./node_modules/typescript/bin/tsc --noEmit' } }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    expect((await runTypecheckSensor(root, { exec, nodeExecutable: () => process.execPath })).status).toBe('unavailable');
    expect(exec).not.toHaveBeenCalled();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each([
  ['go.mod', 'internal/calc_test.go', 'package internal\n'],
  ['Cargo.toml', 'src/calc.rs', '#[test]\nfn addition() {}\n'],
  ['Cargo.toml', 'tests/addition.rs', 'fn helper() {}\n'],
])('unchanged nested native tests remain applicable: %s / %s', async (manifest, test, content) => {
  const { mechanicalProjectRequirements } = await import('./mechanical-sensors');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus nested native tests ')));
  try {
    fs.writeFileSync(path.join(root, manifest), '');
    fs.mkdirSync(path.dirname(path.join(root, test)), { recursive: true });
    fs.writeFileSync(path.join(root, test), content);
    expect((await mechanicalProjectRequirements(root, ['src/changed-source.rs'])).tests).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('Cargo source without test declarations does not invent a regression suite', async () => {
  const { mechanicalProjectRequirements } = await import('./mechanical-sensors');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus rust build only ')));
  try {
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="fixture"\n');
    fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/main.rs'), 'fn main() {}\n');
    expect((await mechanicalProjectRequirements(root)).tests).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

describe('mechanicalProjectRequirements subtracts by the complete candidate diff', () => {
  const withTypedTestedProject = async (run: (root: string) => Promise<void>) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus diff subtraction ')));
    try {
      fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' },
        devDependencies: { typescript: '^6.0.0', vitest: '^5.0.0' } }));
      await run(root);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };

  it('a diff of only styles, prose and assets cannot affect the compiler', async () => {
    const { mechanicalProjectRequirements } = await import('./mechanical-sensors');
    await withTypedTestedProject(async root => {
      const requirements = await mechanicalProjectRequirements(root, ['src/theme.css'], ['src/theme.css', 'README.md', 'public/logo.svg']);
      expect(requirements).toMatchObject({ typecheck: false, tests: false, diffClass: 'non-executable' });
      expect(requirements.audit).toBe(true); // Dependency audit stays a project property.
    });
  });

  it.each([
    ['an edited TS file', ['src/theme.css', 'src/theme.ts']],
    ['a deleted module the read set no longer lists', ['src/theme.css', 'src/legacy.tsx']],
    ['an empty diff', []],
  ])('%s keeps every project requirement', async (_label, diff) => {
    const { mechanicalProjectRequirements } = await import('./mechanical-sensors');
    await withTypedTestedProject(async root => {
      expect(await mechanicalProjectRequirements(root, ['src/theme.css'], diff))
        .toMatchObject({ typecheck: true, tests: true, audit: true, diffClass: 'code' });
    });
  });

  it('without a complete diff nothing is subtracted (legacy callers)', async () => {
    const { mechanicalProjectRequirements } = await import('./mechanical-sensors');
    await withTypedTestedProject(async root => {
      expect(await mechanicalProjectRequirements(root, ['src/theme.css'])).toMatchObject({ typecheck: true, tests: true, diffClass: 'code' });
    });
  });
});
