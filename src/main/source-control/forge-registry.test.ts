import { describe, expect, it } from 'vitest';
import { selectForge } from './forge-registry';

describe('selectForge', () => {
  it('reconhece um remote GitHub (https e ssh)', () => {
    expect(selectForge('https://github.com/acme/widgets.git')).toMatchObject({
      providerId: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
      enabled: true,
    });
    expect(selectForge('git@github.com:acme/widgets.git')).toMatchObject({
      providerId: 'github',
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('reconhece um remote GitLab (habilitado por default)', () => {
    expect(selectForge('https://gitlab.com/group/proj.git')).toMatchObject({
      providerId: 'gitlab',
      owner: 'group',
      name: 'proj',
      enabled: true,
    });
  });

  it('marca Bitbucket como reconhecido porém desabilitado por flag (default off)', () => {
    const sel = selectForge('https://bitbucket.org/team/repo.git');
    expect(sel?.providerId).toBe('bitbucket');
    expect(sel?.enabled).toBe(false);
  });

  it('retorna null para remote não-hospedado ou vazio', () => {
    expect(selectForge(null)).toBeNull();
    expect(selectForge('/local/path/repo')).toBeNull();
    expect(selectForge('https://github.com/incompleto')).toBeNull();
  });
});
