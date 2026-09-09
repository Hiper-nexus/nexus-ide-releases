import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPaneTerminalIdentity,
  getPaneTerminalIdentity,
  resetPaneTerminalIdentityForTests,
  setPaneTerminalIdentity,
} from './pane-terminal-identity';

afterEach(() => resetPaneTerminalIdentityForTests());

describe('pane terminal identity', () => {
  it('apresenta o pane como Nexus, nunca como o terminal que subiu o app', () => {
    // Campo 09/09: TERM_PROGRAM=Termius vazava para os panes no dev.
    const env = applyPaneTerminalIdentity({ TERM_PROGRAM: 'Termius', TERM_PROGRAM_VERSION: '9.1' });
    expect(env.TERM_PROGRAM).toBe('NexusIDE');
    expect(env.TERM_PROGRAM_VERSION).toBe('0.0.0');
  });

  it('carrega a versão do app quando configurada no boot', () => {
    setPaneTerminalIdentity({ version: '0.76.8' });
    expect(getPaneTerminalIdentity()).toEqual({ name: 'NexusIDE', version: '0.76.8' });
    expect(applyPaneTerminalIdentity({}).TERM_PROGRAM_VERSION).toBe('0.76.8');
  });

  it('ignora nome/versão vazios em vez de apagar a identidade', () => {
    setPaneTerminalIdentity({ name: '  ', version: '' });
    expect(getPaneTerminalIdentity()).toEqual({ name: 'NexusIDE', version: '0.0.0' });
  });

  it('não muta o env recebido', () => {
    const input = { PATH: '/bin' };
    const out = applyPaneTerminalIdentity(input);
    expect(input).toEqual({ PATH: '/bin' });
    expect(out.PATH).toBe('/bin');
  });
});
