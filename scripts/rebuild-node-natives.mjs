#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CREDENTIAL_NAME =
  /(?:^|_)(?:TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SECRET)(?:$|_)/i;

export function sanitizeBuildEnvironment(environment) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment).filter(([name]) => !CREDENTIAL_NAME.test(name)),
    ),
  );
}

export function rebuildNodeNatives(
  environment = process.env,
  run = spawnSync,
  nodeExecutable = process.execPath,
) {
  const npmCli = environment.npm_execpath;
  if (!npmCli || !/\.(?:c?js|mjs)$/iu.test(npmCli)) {
    throw new Error('npm_execpath must identify the npm JavaScript CLI.');
  }
  const result = run(nodeExecutable, [npmCli, 'rebuild', 'better-sqlite3'], {
    cwd: process.cwd(),
    env: sanitizeBuildEnvironment(environment),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `better-sqlite3 Node rebuild failed (${result.signal ?? result.status ?? 'unknown'})`,
    );
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) rebuildNodeNatives();
