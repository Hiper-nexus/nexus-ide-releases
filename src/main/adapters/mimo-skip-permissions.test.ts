import { describe, expect, it } from 'vitest';
import {
  MIMO_SKIP_PERMISSIONS_ENV,
  mimoSkipPermissionsViaEnv,
} from './mimo-skip-permissions';

describe('MiMo: modo sem permissões pela variável, sem o diálogo (F-742)', () => {
  it('troca a flag pela variável e mantém o resto do argv na ordem', () => {
    const result = mimoSkipPermissionsViaEnv([
      '--trust',
      '--dangerously-skip-permissions',
      '--model',
      'xiaomi/mimo-v2.6-pro',
      '--session',
      'ses_123',
    ]);
    expect(result.args).toEqual([
      '--trust',
      '--model',
      'xiaomi/mimo-v2.6-pro',
      '--session',
      'ses_123',
    ]);
    expect(result.env).toEqual({ [MIMO_SKIP_PERMISSIONS_ENV]: '1' });
  });

  it('o alias --yolo também vira a variável', () => {
    const result = mimoSkipPermissionsViaEnv(['--trust', '--yolo']);
    expect(result.args).toEqual(['--trust']);
    expect(result.env).toEqual({ [MIMO_SKIP_PERMISSIONS_ENV]: '1' });
  });

  it('sem a flag nada muda: o operador que escolheu pedir permissão continua pedindo', () => {
    const args = ['--trust', '--prompt', 'revise o handoff'];
    const result = mimoSkipPermissionsViaEnv(args);
    expect(result.args).toEqual(args);
    expect(result.args).not.toBe(args);
    expect(result.env).toEqual({});
  });
});
