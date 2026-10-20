import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildEngineEnv,
  detectVideoProject,
  ENGINE_POLICY_ENV,
  npmCliCandidates,
  videoEnginePaths,
} from './video-engine';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-video-engine-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('caminhos do motor', () => {
  it('nomes curtos sob userData, HOME e cwd próprios', () => {
    const paths = videoEnginePaths(path.join('C:', 'Users', 'a', 'AppData', 'Roaming', 'NexusIDE'));
    expect(path.basename(paths.engineDir)).toBe('hf-0.8.177');
    expect(paths.cliEntry.endsWith(path.join('node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'))).toBe(true);
    expect(path.dirname(paths.home)).toBe(paths.root);
    expect(path.dirname(paths.workDir)).toBe(paths.root);
  });
});

describe('ambiente do motor (critério de aceite: nenhuma chave, nenhuma telemetria)', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    TEMP: 'C:\\Temp',
    LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    HOME: '/home/real',
    USERPROFILE: 'C:\\Users\\a',
    ELEVENLABS_API_KEY: 'xi-secret',
    GEMINI_API_KEY: 'AIza-secret',
    OPENAI_API_KEY: 'sk-secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    REPLICATE_API_TOKEN: 'r8-secret',
    HEYGEN_API_KEY: 'hg-secret',
    GITHUB_TOKEN: 'ghp-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NODE_OPTIONS: '--require /tmp/evil.js',
    NEXUS_MCP_TOKEN: 'nexus-secret',
    HYPERFRAMES_NO_TELEMETRY: '0',
    DO_NOT_TRACK: '0',
  };

  it('só herda a lista de permissão e nenhum valor secreto', () => {
    const env = buildEngineEnv({ base, pathValue: '/opt/bin:/usr/bin', home: '/engine/home', platform: 'linux' });
    const values = Object.values(env).join('\n');
    for (const secret of ['xi-secret', 'AIza-secret', 'sk-secret', 'sk-ant-secret', 'r8-secret', 'hg-secret', 'ghp-secret', 'aws-secret', 'nexus-secret', 'evil.js']) {
      expect(values).not.toContain(secret);
    }
    expect(Object.keys(env).some((key) => /KEY|TOKEN|SECRET|NODE_OPTIONS/u.test(key))).toBe(false);
    expect(env.PATH).toBe('/opt/bin:/usr/bin');
    expect(env.HOME).toBe('/engine/home');
    expect(env.TEMP).toBe('C:\\Temp');
  });

  it('telemetria, skills, atualização e cor desligadas, mesmo que o usuário tenha ligado', () => {
    const env = buildEngineEnv({ base, pathValue: 'x', home: 'h', platform: 'linux' });
    expect(env).toMatchObject(ENGINE_POLICY_ENV);
    expect(env.HYPERFRAMES_NO_TELEMETRY).toBe('1');
    expect(env.DO_NOT_TRACK).toBe('1');
    expect(env.HYPERFRAMES_SKIP_SKILLS).toBe('1');
    expect(env.HYPERFRAMES_NO_UPDATE_CHECK).toBe('1');
  });

  it('no Windows o USERPROFILE também é a pasta do motor e o PATH vai como Path', () => {
    const env = buildEngineEnv({ base, pathValue: 'C:\\bin', home: 'C:\\engine\\home', platform: 'win32' });
    expect(env.USERPROFILE).toBe('C:\\engine\\home');
    expect(env.Path).toBe('C:\\bin');
    expect(env.LOCALAPPDATA).toBe('C:\\Users\\a\\AppData\\Local');
  });
});

describe('detectVideoProject', () => {
  it('reconhece HyperFrames por hyperframes.json ou pelo index.html', () => {
    fs.writeFileSync(path.join(dir, 'hyperframes.json'), '{}');
    expect(detectVideoProject(dir)).toBe('hyperframes');
    fs.rmSync(path.join(dir, 'hyperframes.json'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<div data-composition-id="main"></div>');
    expect(detectVideoProject(dir)).toBe('hyperframes');
  });

  it('Remotion vence até ao lado de um index.html', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), '<div data-composition-id="main"></div>');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@remotion/cli': '4.0.0' } }));
    expect(detectVideoProject(dir)).toBe('remotion');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'remotion.config.ts'), 'export {}');
    expect(detectVideoProject(dir)).toBe('remotion');
  });

  it('pasta qualquer é desconhecida', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>site</h1>');
    expect(detectVideoProject(dir)).toBe('unknown');
  });
});

describe('npm ao lado do Node', () => {
  it('Windows procura node_modules/npm ao lado do node.exe; POSIX em lib/', () => {
    expect(npmCliCandidates('C:\\nodejs\\node.exe', 'win32')[0]).toBe(
      path.win32.join('C:\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
    expect(npmCliCandidates('/usr/local/bin/node', 'darwin')[0]).toBe(
      path.posix.join('/usr/local/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  });
});
