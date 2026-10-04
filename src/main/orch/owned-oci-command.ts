import { execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ScopedShellPlan } from '../runtime/process-sandbox';

export interface OwnedOciCommand {
  readonly plan: ScopedShellPlan;
  waitForExit(proc: ChildProcess): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

const OWNER_LABEL = 'app.nexuside.owned-command';
const FULL_ID = /^[a-f0-9]{64}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/i;
const POLL_MS = 250;
const INSPECT_FORMAT = [
  '{{json .Id}}', '{{json .Name}}', `{{json (index .Config.Labels "${OWNER_LABEL}")}}`,
  '{{json .State.Running}}', '{{json .State.Status}}',
].join('\n');

/** Only accepts the confinement plan produced by windowsOciPlan, never a caller's Docker argv. */
function snapshotPlan(plan: ScopedShellPlan): ScopedShellPlan {
  const args = [...plan.args];
  const fixed: ReadonlyArray<readonly [number, string]> = [
    [0, 'run'], [1, '--rm'], [2, '--network'], [4, '--read-only'],
    [5, '--cap-drop'], [6, 'ALL'], [7, '--security-opt'], [8, 'no-new-privileges'],
    [9, '--pids-limit'], [10, '512'], [11, '--memory'], [12, '4g'],
    [13, '--mount'], [15, '--mount'], [17, '--workdir'],
    [19, '--env'], [20, 'HOME=/nexus-runtime/home'],
    [21, '--env'], [22, 'TMPDIR=/nexus-runtime/tmp'],
    [23, '--env'], [24, 'CI=true'], [25, '--env'], [26, 'NO_COLOR=1'],
  ];
  if (
    !path.isAbsolute(plan.file) || plan.file.includes('\0') ||
    fixed.some(([index, value]) => args[index] !== value) ||
    !['none', 'bridge'].includes(args[3]) ||
    !/^type=bind,src=[^,\r\n\0]+,dst=\/workspace(?:,readonly)?$/.test(args[14] ?? '') ||
    !/^type=bind,src=[^,\r\n\0]+,dst=\/nexus-runtime$/.test(args[16] ?? '') ||
    !/^\/workspace(?:\/[^\r\n\0]*)?$/.test(args[18] ?? '') ||
    !IMAGE.test(args[27] ?? '') || !args[28] ||
    args.some((arg) => arg.includes('\0'))
  ) {
    throw new Error('Unsupported owned OCI sandbox plan');
  }
  return { ...plan, args, env: { ...plan.env } };
}

function ids(output: string): string[] | null {
  const values = output.trim() ? output.trim().split(/\r?\n/) : [];
  return values.every((value) => FULL_ID.test(value)) ? values : null;
}

interface ContainerProof {
  running: boolean;
}

function readProof(output: string, id: string, name: string, nonce: string): ContainerProof | null {
  try {
    const values = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
    if (
      values.length !== 5 || values[0] !== id || values[1] !== `/${name}` || values[2] !== nonce ||
      typeof values[3] !== 'boolean' ||
      !['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(values[4] as string)
    ) return null;
    // Only final or never-started states authorize non-force removal.
    return { running: values[3] || !['created', 'exited', 'dead'].includes(values[4] as string) };
  } catch {
    return null;
  }
}

const poll = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

/**
 * Main creates the container before exposing a start plan. Ownership stays in
 * memory: no cidfile/name/nonce can be written through the agent's runtime mount.
 * Call waitForExit immediately after the actual spawn, before yielding control.
 * Its fulfillment is the physical-exit proof; client error/exit alone is not one.
 * stop/dispose retry unknown engine state and never release ownership on error.
 */
export async function prepareOwnedOciCommand(input: ScopedShellPlan): Promise<OwnedOciCommand> {
  const original = snapshotPlan(input);
  const nonce = randomBytes(32).toString('hex');
  const name = `nexus-owned-command-${nonce}`;
  const run = (args: string[]) => new Promise<{ ok: boolean; output: string; spawned: boolean }>((resolve) => {
    let spawned = false;
    try {
      const proc = execFile(original.file, args, {
        cwd: original.cwd, env: original.env, windowsHide: true,
        timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8',
      }, (error, stdout) => resolve({ ok: !error, output: error ? '' : stdout, spawned }));
      proc.once('spawn', () => { spawned = true; });
    } catch {
      resolve({ ok: false, output: '', spawned });
    }
  });
  const inspect = async (id: string) => {
    const result = await run(['container', 'inspect', '--format', INSPECT_FORMAT, id]);
    return { ok: result.ok, proof: result.ok ? readProof(result.output, id, name, nonce) : null };
  };
  const list = async (filter: string) => {
    const result = await run(['container', 'ls', '--all', '--no-trunc', '--filter', filter, '--format', '{{.ID}}']);
    return result.ok ? ids(result.output) : null;
  };
  const creation = await run(['create', '--name', name, '--label', `${OWNER_LABEL}=${nonce}`, ...original.args.slice(2)]);
  if (!creation.spawned) throw new Error('Owned OCI container creation could not be proved');

  // A lost create response can leave a dormant container. Discover only by our
  // private nonce, then prove its full ID/name/label before any mutation.
  let id: string | null = null;
  for (;;) {
    const matches = await list(`label=${OWNER_LABEL}=${nonce}`);
    if (matches?.length === 0) {
      throw new Error('Owned OCI container creation could not be proved');
    }
    if (matches?.length === 1) {
      const result = await inspect(matches[0]);
      if (result.proof) {
        id = matches[0];
        break;
      }
    }
    await poll();
  }
  const ownedId = id;
  let removed = false;
  let stopRequested = false;
  let settling: Promise<void> | null = null;
  let child: ChildProcess | null = null;
  let physicalExit: Promise<void> | null = null;

  const settle = (): Promise<void> => {
    settling ??= (async () => {
      while (!removed) {
        const result = await inspect(ownedId);
        if (result.proof) {
          if (result.proof.running) {
            if (stopRequested) await run(['container', 'stop', '--time', '2', ownedId]);
          } else {
            // Never force-remove running work. Removing the immutable ID also
            // fences a delayed start request from a client killed in transit.
            await run(['container', 'rm', ownedId]);
          }
        } else if (!result.ok) {
          const matches = await list(`id=${ownedId}`);
          // A successful full-ID query is absence proof. Transport failure,
          // malformed output, substituted identity and partial IDs are unknown.
          removed = matches !== null && matches.length === 0;
        }
        if (!removed) await poll();
      }
    })();
    return settling;
  };
  const stop = async () => {
    stopRequested = true;
    await settle();
  };

  if (!creation.ok || creation.output.trim() !== ownedId) {
    await stop();
    throw new Error('Owned OCI container creation could not be proved');
  }
  return {
    plan: { ...original, args: ['start', '--attach', ownedId], env: { ...original.env } },
    waitForExit(proc) {
      if (child && child !== proc) throw new Error('Owned OCI command already has an attach client');
      child = proc;
      physicalExit ??= new Promise<void>((resolve) => {
        // Spawn errors still emit close. Neither error nor exit proves closure.
        const ignoreSpawnError = () => undefined;
        proc.on('error', ignoreSpawnError);
        proc.once('close', () => {
          proc.removeListener('error', ignoreSpawnError);
          resolve();
        });
      }).then(settle);
      return physicalExit;
    },
    stop,
    async dispose() {
      await stop();
      if (physicalExit) await physicalExit;
    },
  };
}
