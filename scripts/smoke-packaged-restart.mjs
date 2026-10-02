import path from 'node:path';
import {
  createPackagedSmokeSession,
  disposePackagedSmokeSession,
  runPackagedSmoke,
} from './smoke-packaged-app.mjs';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseRestartSmokeArguments(args) {
  let app = null;
  let expectedVersion = null;
  let restart = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--verify-restart' && !restart) {
      restart = true;
    } else if ((flag === '--app' && app === null) ||
               (flag === '--expected-version' && expectedVersion === null)) {
      const value = args[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new Error(`missing value for ${flag}`);
      }
      if (flag === '--app') app = path.resolve(value);
      else expectedVersion = value;
    } else {
      throw new Error(`invalid or duplicate restart smoke argument: ${String(flag)}`);
    }
  }
  if (!restart || typeof expectedVersion !== 'string' || !VERSION_RE.test(expectedVersion)) {
    throw new Error('restart smoke requires --verify-restart --expected-version <version>');
  }
  return { app, expectedVersion };
}

function assertPhaseProof(result, phase, expectedVersion) {
  const proof = result?.runtimeProof;
  if (!proof || proof.phase !== phase || proof.appVersion !== expectedVersion ||
      proof.packaged !== true || proof.pixelMode !== true ||
      !Number.isInteger(proof.pid) || proof.pid <= 0 || result?.treeProof?.ok !== true ||
      !Array.isArray(result?.processTreeProof?.orphans) || result.processTreeProof.orphans.length !== 0) {
    throw new Error(`packaged restart ${phase} phase did not prove version, preference and clean process exit`);
  }
  return proof;
}

/** Two completed application launches sharing only one private test profile. */
export async function runPackagedRestartSmoke(targetPath, {
  expectedVersion,
  runSmoke = runPackagedSmoke,
  probeImpl = null,
  ...smokeOptions
} = {}) {
  if (typeof expectedVersion !== 'string' || !VERSION_RE.test(expectedVersion)) {
    throw new Error('packaged restart smoke requires an expected release version');
  }
  const probe = probeImpl ?? (await import('./smoke-packaged-restart-probe.mjs')).probeRestartPreferences;
  const session = await createPackagedSmokeSession();
  try {
    const proofs = [];
    for (const phase of ['write', 'read']) {
      const result = await runSmoke(targetPath, {
        ...smokeOptions,
        smokeSession: session,
        remoteDebugging: true,
        runtimeProbe: (child, { userData, signal }) => probe(child, {
          userData, signal, phase, expectedVersion,
        }),
      });
      proofs.push(assertPhaseProof(result, phase, expectedVersion));
      process.stdout.write(`[smoke] restart-phase ${JSON.stringify(proofs.at(-1))}\n`);
    }
    if (proofs[0].pid === proofs[1].pid) {
      throw new Error('packaged restart smoke did not observe two distinct application processes');
    }
    const proof = {
      schema: 'nexus.packaged-restart/v1', appVersion: expectedVersion,
      preference: 'pixelMode', launches: proofs, processTreesClean: true,
    };
    process.stdout.write(`[smoke] restartProof ${JSON.stringify(proof)}\n`);
    return proof;
  } finally {
    await disposePackagedSmokeSession(session);
  }
}
