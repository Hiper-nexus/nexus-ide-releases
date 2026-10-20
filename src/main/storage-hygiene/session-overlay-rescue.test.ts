import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CLAUDE_AUTH_SYNCBACK_MARKER } from '../orch/hooks-gen';
import { rescueOrphanSessionOverlay } from './session-overlay-rescue';

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-overlay-rescue-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function credentials(home: string, token: string): string {
  const file = path.join(home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token }));
  return file;
}

it('overlay com marcador: login feito no pane volta ao perfil real antes de sair', () => {
  const realHome = tmp();
  const overlay = tmp();
  credentials(overlay, 'login-do-pane');
  fs.writeFileSync(path.join(overlay, CLAUDE_AUTH_SYNCBACK_MARKER), '');
  expect(rescueOrphanSessionOverlay(overlay, realHome)).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(realHome, '.claude', '.credentials.json'), 'utf8')).token)
    .toBe('login-do-pane');
});

it('overlay sem marcador: nada é copiado para o perfil real', () => {
  const realHome = tmp();
  const overlay = tmp();
  credentials(overlay, 'stub');
  expect(rescueOrphanSessionOverlay(overlay, realHome)).toBe(true);
  expect(fs.existsSync(path.join(realHome, '.claude', '.credentials.json'))).toBe(false);
});
