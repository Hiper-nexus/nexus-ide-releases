import { describe, expect, it } from 'vitest';
import { describeWorkspaceOpenError } from './workspace-open-error';

describe('describeWorkspaceOpenError', () => {
  it('traduz quarentena de identidade em instrução acionável', () => {
    // Caso de campo 20/08: rename do repo quarentenava a pasta e a UI só
    // mostrava o genérico, escondendo a remediação.
    const cause = new Error(
      "Error invoking remote method 'workspace:pick': ProjectIdentityQuarantineError: " +
        'project manifest is incompatible with this repository: repository origin does not match the manifest',
    );
    const message = describeWorkspaceOpenError(cause);
    expect(message).toContain('Não foi possível abrir a pasta escolhida.');
    expect(message).toContain('.nexus/project.json');
    expect(message).not.toContain('Error invoking remote method');
  });

  it('grant expirado orienta a escolher de novo', () => {
    const cause = new Error(
      "Error invoking remote method 'workspace:open': Error: workspace path was not authorized by the folder picker",
    );
    expect(describeWorkspaceOpenError(cause)).toContain(
      'Escolha a pasta novamente',
    );
  });

  it('erro desconhecido mantém o detalhe visível entre parênteses', () => {
    const cause = new Error(
      "Error invoking remote method 'workspace:pick': Error: EPERM: operation not permitted",
    );
    const message = describeWorkspaceOpenError(cause);
    expect(message).toContain('Não foi possível abrir a pasta escolhida.');
    expect(message).toContain('EPERM');
  });

  it('causa vazia cai no genérico puro', () => {
    expect(describeWorkspaceOpenError(undefined)).toBe(
      'Não foi possível abrir a pasta escolhida.',
    );
  });
});
