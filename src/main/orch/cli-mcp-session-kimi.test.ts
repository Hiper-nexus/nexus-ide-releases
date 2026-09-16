import {
  cleanupCliMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-artifacts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareKimiMcpSession } from './cli-mcp-session-kimi';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kimi-overlay-'));
  tempDirs.push(dir);
  return dir;
}

describe('F-566 kimi checkout session isolation', () => {
  it.each([false, true])(
    'isolates conversations and preserves auth (governed=%s)',
    (governed) => {
      const root = tempDir();
      const home = path.join(root, 'home');
      const providerHome = path.join(home, '.kimi-code');
      const userDataPath = path.join(root, 'user-data');
      const artifactRoot = path.join(root, 'ephemeral');
      const write = (file: string, value: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
      };
      write(
        path.join(providerHome, 'sessions', 'external.json'),
        'external conversation',
      );
      write(path.join(providerHome, 'credentials/auth.json'), '{}');
      write(path.join(providerHome, 'session_index.jsonl'), 'external index');
      write(
        path.join(providerHome, 'user-history', 'external'),
        'external prompt',
      );
      const options = {
        home,
        providerHome,
        artifactRoot,
        userDataPath,
        checkoutId: 'checkout-a',
        governed,
      };
      const token = `kimi-isolation-${governed}`;
      const first = prepareKimiMcpSession(
        'http://127.0.0.1:9/mcp',
        token,
        options,
      );
      const overlay = first.artifactDir!;
      const state = path.join(
        userDataPath,
        'provider-state',
        'kimi',
        'checkout-a',
      );
      try {
        expect(fs.realpathSync(path.join(overlay, 'sessions'))).not.toBe(
          fs.realpathSync(path.join(providerHome, 'sessions')),
        );
        expect(fs.realpathSync(path.join(overlay, 'sessions'))).toBe(
          fs.realpathSync(path.join(state, 'sessions')),
        );
        expect(
          fs.existsSync(path.join(overlay, 'sessions', 'external.json')),
        ).toBe(false);
        expect(
          fs.realpathSync(path.join(overlay, 'credentials/auth.json')),
        ).toBe(
          fs.realpathSync(path.join(providerHome, 'credentials/auth.json')),
        );
        expect(fs.realpathSync(path.join(overlay, 'session_index.jsonl'))).toBe(
          fs.realpathSync(path.join(state, 'session_index.jsonl')),
        );
        expect(
          fs.readFileSync(path.join(overlay, 'session_index.jsonl'), 'utf8'),
        ).not.toContain('external');
        expect(fs.realpathSync(path.join(overlay, 'user-history'))).toBe(
          fs.realpathSync(path.join(state, 'user-history')),
        );
        write(path.join(overlay, 'sessions', 'pane.json'), 'pane conversation');
        write(path.join(overlay, 'user-history', 'pane'), 'pane prompt');
        expect(
          fs.existsSync(path.join(providerHome, 'sessions', 'pane.json')),
        ).toBe(false);
        // CLI atomic writes may replace a file link: never sync that index to the real home.
        fs.unlinkSync(path.join(overlay, 'session_index.jsonl'));
        write(path.join(overlay, 'session_index.jsonl'), 'pane index');
        const other = prepareKimiMcpSession(
          'http://127.0.0.1:9/mcp',
          `${token}-other`,
          { ...options, checkoutId: 'checkout-b' },
        );
        try {
          expect(
            fs.realpathSync(path.join(other.artifactDir!, 'sessions')),
          ).toBe(
            fs.realpathSync(
              path.join(
                userDataPath,
                'provider-state',
                'kimi',
                'checkout-b',
                'sessions',
              ),
            ),
          );
          expect(
            fs.existsSync(
              path.join(other.artifactDir!, 'sessions', 'pane.json'),
            ),
          ).toBe(false);
        } finally {
          cleanupCliMcpSession(`${token}-other`);
        }
      } finally {
        cleanupCliMcpSession(token);
      }
      expect(
        fs.readFileSync(path.join(providerHome, 'session_index.jsonl'), 'utf8'),
      ).toBe('external index');
      expect(
        fs.readFileSync(
          path.join(providerHome, 'sessions', 'external.json'),
          'utf8',
        ),
      ).toBe('external conversation');
      expect(
        fs.existsSync(path.join(providerHome, 'user-history', 'pane')),
      ).toBe(false);
      // A different token and artifact root model a fresh process after stale overlay purge.
      purgeStaleCliMcpSessions({ home, artifactRoot });
      const resumed = prepareKimiMcpSession(
        'http://127.0.0.1:9/mcp',
        `${token}-resume`,
        { ...options, artifactRoot: path.join(root, 'new-ephemeral') },
      );
      try {
        expect(
          fs.readFileSync(
            path.join(resumed.artifactDir!, 'sessions', 'pane.json'),
            'utf8',
          ),
        ).toBe('pane conversation');
        expect(
          fs.readFileSync(
            path.join(resumed.artifactDir!, 'user-history', 'pane'),
            'utf8',
          ),
        ).toBe('pane prompt');
      } finally {
        cleanupCliMcpSession(`${token}-resume`);
      }
    },
  );
});
