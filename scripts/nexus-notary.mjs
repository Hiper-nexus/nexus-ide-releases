#!/usr/bin/env node
/**
 * nexus-notary — um comando para criar uma versão nova quando tudo estiver
 * perfeito. Orquestra a cadeia de release da casa na ordem obrigatória:
 *
 *   1. typecheck                     (tsc --noEmit)
 *   2. security:renderer-sinks       (0 executable DOM sinks)
 *   3. make:release                  (build limpo + codesign + notarytool
 *                                     profile "nexus-notary" + staple + smoke
 *                                     do ZIP + receipt — scripts/make-release.mjs)
 *   4. release:candidate             (gate do candidato: manifest, snapshot,
 *                                     receipt — scripts/release-candidate-gate.mjs)
 *
 * Autoridade de publicação exigida no ambiente (mesma doutrina dos gates):
 *   NEXUS_MAC_PUBLISH_RELEASE=1
 *   APPLE_TEAM_ID=35P5XL3JN6
 *   APPLE_KEYCHAIN_PROFILE=nexus-notary
 *
 * A worktree precisa estar limpa (apenas release-artifacts/ é permitido) e o
 * package.json já deve estar com a versão nova — este script NÃO comita nem
 * empurra; versionamento e push continuam decisões humanas/explícitas.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  {
    name: 'typecheck',
    command: process.execPath,
    args: [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
    ],
  },
  {
    name: 'security:renderer-sinks',
    command: process.execPath,
    args: [path.join(root, 'scripts', 'check-renderer-sinks.mjs')],
  },
  {
    name: 'make:release',
    command: process.execPath,
    args: [path.join(root, 'scripts', 'make-release.mjs')],
  },
  {
    name: 'release:candidate',
    command: process.execPath,
    args: [path.join(root, 'scripts', 'release-candidate-gate.mjs')],
  },
];

function runStep(step) {
  const label = `[nexus-notary] ▶ ${step.name}`;
  process.stdout.write(`${label}\n`);
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0 || result.error) {
    process.stderr.write(
      `[nexus-notary] FAIL em ${step.name}` +
        `${result.status !== null ? ` (exit ${result.status})` : ''}` +
        `${result.error ? `: ${result.error.message}` : ''}\n`,
    );
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

function assertPublishEnvironment(environment) {
  const problems = [];
  if (environment.NEXUS_MAC_PUBLISH_RELEASE !== '1') {
    problems.push('NEXUS_MAC_PUBLISH_RELEASE deve ser exatamente "1"');
  }
  if (!environment.APPLE_TEAM_ID) {
    problems.push('APPLE_TEAM_ID ausente');
  }
  if (environment.APPLE_KEYCHAIN_PROFILE !== 'nexus-notary') {
    problems.push('APPLE_KEYCHAIN_PROFILE deve ser exatamente "nexus-notary"');
  }
  if (environment.APPLE_ID || environment.APPLE_APP_SPECIFIC_PASSWORD) {
    problems.push(
      'credenciais Apple pertencem ao keychain profile — remova APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD',
    );
  }
  if (problems.length > 0) {
    process.stderr.write(
      `[nexus-notary] ambiente de publicação inválido:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\n',
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectRun) {
  if (!assertPublishEnvironment(process.env)) {
    process.exit(process.exitCode || 1);
  }
  for (const step of steps) {
    if (!runStep(step)) break;
  }
  // A cadeia de release deixa os nativos no ABI do ELECTRON — e o dev/teste
  // local quebra até um `rebuild:node` manual (mordeu 2× em 23/08: suite
  // inteira vermelha por ERR_DLOPEN_FAILED logo após o PASS da release).
  // Restaura o ABI do Node SEMPRE, passe a cadeia verde ou vermelha.
  const rebuild = spawnSync('npm', ['run', 'rebuild:node'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (rebuild.status !== 0) {
    process.stderr.write(
      '[nexus-notary] aviso: rebuild:node pós-release falhou — ' +
        ' rode `npm run rebuild:node` antes de testar no dev.\n',
    );
  }
}
