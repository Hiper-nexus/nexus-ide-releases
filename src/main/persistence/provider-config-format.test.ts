import { describe, expect, it } from 'vitest';

import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
  isDangerousPermissionMode,
} from './provider-config-format';
import type { ProviderConfig } from '../../shared/provider-settings-types';

describe('provider config format', () => {
  it('migrates old implicit safe values to the new adapter automatic default', () => {
    const decoded = decodeProviderConfigFile({
      codex: { permissionMode: '' },
      claude: {},
      reviewer: { permissionMode: 'plan' },
    });
    expect(decoded.migrated).toBe(true);
    expect(decoded.providers.codex.permissionMode).toBeUndefined();
    expect(decoded.providers.claude.permissionMode).toBeUndefined();
    expect(decoded.providers.reviewer.permissionMode).toBe('plan');
  });

  it('preserves an explicitly confirmed mode in the versioned format', () => {
    const config = {
      adapterId: 'codex',
      enabled: true,
      binPath: '',
      defaultModel: '',
      extraArgs: [],
      upstream: 'anthropic',
      baseUrl: '',
      permissionMode: 'yolo',
      effort: '',
      verbose: false,
    } satisfies ProviderConfig;
    const decoded = decodeProviderConfigFile(
      encodeProviderConfigFile({ codex: config }),
    );
    expect(decoded.migrated).toBe(false);
    expect(decoded.providers.codex.permissionMode).toBe('yolo');
  });

  it('classifies every auto-operation mode as dangerous', () => {
    expect(['yolo', 'bypass', 'auto'].every(isDangerousPermissionMode)).toBe(true);
    expect(isDangerousPermissionMode('plan')).toBe(false);
    expect(isDangerousPermissionMode('')).toBe(false);
  });
});
