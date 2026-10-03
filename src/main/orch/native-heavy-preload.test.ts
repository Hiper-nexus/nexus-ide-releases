import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { appendHeavyCommandPreload } from './native-heavy-preload';
it('preserves existing NODE_OPTIONS and quotes resource paths with spaces', () => {
 expect(appendHeavyCommandPreload('--max-old-space-size=256', '/tmp/Application Support/preload.cjs')).toBe('--max-old-space-size=256 --require "/tmp/Application Support/preload.cjs"');
});
it('does not intercept outside-mission operator Node processes', () => {
 const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload('--max-old-space-size=256', path.join(process.cwd(), 'resources/heavy-command/preload.cjs')) };
 delete env.NEXUS_MISSION_ID; delete env.NEXUS_HEAVY_COMMAND_URL;
 const result = spawnSync(process.execPath, ['-e', 'console.log("operator-unmodified")'], { env, encoding: 'utf8' });
 expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('operator-unmodified'); expect(result.stderr).toBe('');
});
it('worker threads inherit the scoped preload but never request a second compiler lease', () => {
 const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload('--max-old-space-size=256', path.join(process.cwd(), 'resources/heavy-command/preload.cjs')), NEXUS_MISSION_ID: 'finite', NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 const result = spawnSync(process.execPath, ['-e', 'const {Worker}=require("node:worker_threads");new Worker("require(\\"node:worker_threads\\").parentPort.postMessage(\\"thread-ok\\")",{eval:true}).on("message",console.log)'], { env, encoding: 'utf8' });
 expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('thread-ok'); expect(result.stderr).toBe('');
});
