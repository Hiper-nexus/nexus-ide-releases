/** Borda real (fs, processos, rede) do shot-installer; a lógica vive em shot-installer.ts. */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SHOT_APP_PATH, type ShotInstallerDeps } from './shot-installer';

const execFileAsync = promisify(execFile);
const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 60_000;
const RECENT_CRASH_MS = 7 * 24 * 60 * 60 * 1000;

function run(cmd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { timeout: NETWORK_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function createShotInstallerDeps(log: (msg: string) => void): ShotInstallerDeps {
  const crashDir = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  return {
    platform: process.platform,
    arch: process.arch,
    appPath: SHOT_APP_PATH,
    appExists: existsSync,
    readBundleVersion: async (appPath) => {
      try {
        // plutil é assíncrono e local; o plist do bundle é binário ou XML.
        const { stdout } = await execFileAsync(
          '/usr/bin/plutil',
          ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
          { encoding: 'utf8', timeout: 5000 },
        );
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
    isShotRunning: async () => (await run('/usr/bin/pgrep', ['-f', 'Nexus Shot.app/Contents/MacOS'])).code === 0,
    hasRecentShotCrash: () => {
      try {
        return readdirSync(crashDir).some(
          (f) => /^nexus-shot.*\.ips$/i.test(f) && Date.now() - statSync(join(crashDir, f)).mtimeMs < RECENT_CRASH_MS,
        );
      } catch {
        return false;
      }
    },
    fetchText: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    downloadTo: async (url, dest) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS * 5) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > DOWNLOAD_MAX_BYTES) throw new Error('download acima do limite');
      writeFileSync(dest, buf);
    },
    run,
    makeStagingDir: (parent) => mkdtempSync(join(parent, '.nexus-shot-staging-')),
    rename: renameSync,
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    log,
  };
}
