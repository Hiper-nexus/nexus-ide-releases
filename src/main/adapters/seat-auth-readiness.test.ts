import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_READINESS,
  SEAT_AUTH_READINESS,
  SILENT_REMINT_HINT,
  canSeat,
  canSeatFromProvider,
  classifyKimiCredentialBlob,
  classifyKimiProviderList,
  classifySeatAuth,
  firstWaveCanSeat,
  isApiKeyPasteToast,
  isAuthPresent,
  mergeKimiProviderListReadiness,
  peekKimiSeatReadiness,
  rememberKimiSeatReadiness,
  seatFailureHint,
  shouldToastApiKeyPaste,
  type AuthReadiness,
} from './seat-auth-readiness';

afterEach(() => {
  rememberKimiSeatReadiness(undefined);
});

describe('canSeat — só AuthReadiness=present senta', () => {
  it('expõe os 5 estados', () => {
    expect([...AUTH_READINESS]).toEqual([
      'present',
      'incomplete',
      'missing',
      'unreadable',
      'no-credential',
    ]);
    expect(SEAT_AUTH_READINESS).toBe(AUTH_READINESS);
  });

  it.each(
    AUTH_READINESS.map((state) => [state, state === 'present'] as const),
  )('%s → seat=%s', (state, seated) => {
    expect(isAuthPresent(state)).toBe(seated);
    expect(canSeat(state)).toBe(seated);
  });
});

describe('classifySeatAuth — roster auth-only', () => {
  it('subscription / credentialless / api-key+hasKey = present', () => {
    expect(
      classifySeatAuth({ adapterId: 'codex', authStrategy: 'subscription' }),
    ).toBe('present');
    expect(
      classifySeatAuth({ adapterId: 'opencode', authStrategy: 'credentialless' }),
    ).toBe('present');
    expect(
      classifySeatAuth({
        adapterId: 'glm',
        authStrategy: 'api-key',
        hasKey: true,
      }),
    ).toBe('present');
  });

  it('login-needed / api-key sem chave = no-credential', () => {
    expect(
      classifySeatAuth({ adapterId: 'codex', authStrategy: 'login-needed' }),
    ).toBe('no-credential');
    expect(
      classifySeatAuth({ adapterId: 'glm', authStrategy: 'api-key' }),
    ).toBe('no-credential');
  });

  it('LongCat sem chave é no-credential — nunca present', () => {
    expect(
      classifySeatAuth({ adapterId: 'longcat', authStrategy: 'api-key' }),
    ).toBe('no-credential');
    expect(
      classifySeatAuth({
        adapterId: 'longcat',
        authStrategy: 'api-key',
        hasKey: true,
      }),
    ).toBe('present');
  });

  it('Kimi file-only (sem provider list) é incomplete — o falso positivo de 19 Ago', () => {
    expect(
      classifySeatAuth({ adapterId: 'kimi', authStrategy: 'subscription' }),
    ).toBe('incomplete');
    expect(
      firstWaveCanSeat({ adapterId: 'kimi', authStrategy: 'subscription' }),
    ).toBe(false);
  });

  it('first-wave só senta AuthReadiness=present', () => {
    expect(
      firstWaveCanSeat({
        adapterId: 'kimi',
        authStrategy: 'subscription',
        kimiListReadiness: 'present',
      }),
    ).toBe(true);
    expect(
      firstWaveCanSeat({
        adapterId: 'kimi',
        authStrategy: 'subscription',
        kimiListReadiness: 'incomplete',
      }),
    ).toBe(false);
    expect(
      firstWaveCanSeat({ adapterId: 'longcat', authStrategy: 'api-key' }),
    ).toBe(false);
    expect(
      firstWaveCanSeat({
        adapterId: 'codex',
        authStrategy: 'subscription',
      }),
    ).toBe(true);
  });

  it('Kimi com source=oauth (list) senta; missing/unreadable/disabled não', () => {
    expect(
      classifySeatAuth({
        adapterId: 'kimi',
        authStrategy: 'subscription',
        kimiListReadiness: 'present',
      }),
    ).toBe('present');
    for (const blocked of [
      'incomplete',
      'missing',
      'unreadable',
      'no-credential',
    ] as const) {
      expect(
        canSeat(
          classifySeatAuth({
            adapterId: 'kimi',
            authStrategy: 'subscription',
            kimiListReadiness: blocked,
          }),
        ),
      ).toBe(false);
    }
  });

  it('Kimi api-key+hasKey senta mesmo sem list oauth', () => {
    expect(
      classifySeatAuth({
        adapterId: 'kimi',
        authStrategy: 'api-key',
        hasKey: true,
        kimiListReadiness: 'missing',
      }),
    ).toBe('present');
  });
});

describe('classifyKimiProviderList', () => {
  it('source=oauth habilitado é present', () => {
    expect(
      classifyKimiProviderList(
        JSON.stringify({
          providers: [{ source: 'oauth', enabled: true }],
        }),
      ),
    ).toBe('present');
  });

  it('"No providers configured" é missing', () => {
    expect(classifyKimiProviderList('No providers configured')).toBe('missing');
  });

  it('stale "No providers configured" não sobrescreve source=oauth ao vivo', () => {
    const mixed =
      'No providers configured\n' +
      JSON.stringify({ providers: [{ source: 'oauth' }] });
    expect(classifyKimiProviderList(mixed)).toBe('present');
    expect(
      mergeKimiProviderListReadiness('present', 'missing'),
    ).toBe('present');
    expect(
      mergeKimiProviderListReadiness('missing', 'present'),
    ).toBe('missing');
    // `unreadable` é falha de leitura, não veredito: não pode derrubar um
    // `present` quente (senão um timeout de 4 s tira o Kimi de todos os
    // assentos seguintes do processo).
    expect(
      mergeKimiProviderListReadiness('unreadable', 'present'),
    ).toBe('present');
    expect(mergeKimiProviderListReadiness('unreadable', undefined)).toBe(
      'unreadable',
    );
  });

  it('erro de parse é unreadable', () => {
    expect(classifyKimiProviderList('{not-json')).toBe('unreadable');
    expect(classifyKimiProviderList(null)).toBe('unreadable');
  });

  it('oauth desabilitado é no-credential', () => {
    expect(
      classifyKimiProviderList(
        JSON.stringify({
          providers: [{ source: 'oauth', enabled: false }],
        }),
      ),
    ).toBe('no-credential');
    expect(
      classifyKimiProviderList(
        JSON.stringify([{ source: 'oauth', disabled: true }]),
      ),
    ).toBe('no-credential');
  });

  it('providers sem oauth são incomplete', () => {
    expect(
      classifyKimiProviderList(
        JSON.stringify({ providers: [{ source: 'api-key' }] }),
      ),
    ).toBe('incomplete');
  });
});

describe('toast de API key — só pick civil explícito', () => {
  const civilianHint = 'Cole sua API key do LongCat em Configurações › Contas de IA';

  it('autopilot remint nunca tosta Cole sua API key', () => {
    expect(
      shouldToastApiKeyPaste({
        readiness: 'no-credential',
        explicitCivilianPick: false,
      }),
    ).toBe(false);
    expect(
      seatFailureHint({
        readiness: 'no-credential',
        explicitCivilianPick: false,
        civilianHint,
      }),
    ).toBe(SILENT_REMINT_HINT);
    expect(isApiKeyPasteToast(SILENT_REMINT_HINT)).toBe(false);
  });

  it('pick civil explícito de LongCat/no-credential pode tostar', () => {
    expect(
      shouldToastApiKeyPaste({
        readiness: 'no-credential',
        explicitCivilianPick: true,
      }),
    ).toBe(true);
    expect(
      seatFailureHint({
        readiness: 'no-credential',
        explicitCivilianPick: true,
        civilianHint,
      }),
    ).toBe(civilianHint);
    expect(isApiKeyPasteToast(civilianHint)).toBe(true);
  });

  it('estados que não são no-credential nunca tostam a key', () => {
    const blocked: AuthReadiness[] = [
      'present',
      'incomplete',
      'missing',
      'unreadable',
    ];
    for (const readiness of blocked) {
      expect(
        shouldToastApiKeyPaste({
          readiness,
          explicitCivilianPick: true,
        }),
      ).toBe(false);
    }
  });
});

describe('classifyKimiCredentialBlob — 5 estados do arquivo, nunca present', () => {
  it('ENOENT é missing; EPERM é unreadable; JSON inválido é unreadable', () => {
    expect(classifyKimiCredentialBlob(null, 'ENOENT')).toBe('missing');
    expect(classifyKimiCredentialBlob('{}', 'EPERM')).toBe('unreadable');
    expect(classifyKimiCredentialBlob('{not-json')).toBe('unreadable');
  });

  it('objeto vazio / sem tokens é no-credential', () => {
    expect(classifyKimiCredentialBlob('{}')).toBe('no-credential');
    expect(classifyKimiCredentialBlob('{"expires_at":1}')).toBe('no-credential');
  });

  it('tokens parciais ou usáveis são incomplete — first-wave não senta no blob', () => {
    expect(
      classifyKimiCredentialBlob(
        JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: 9_999_999_999 }),
      ),
    ).toBe('incomplete');
    expect(
      firstWaveCanSeat({
        adapterId: 'kimi',
        authStrategy: 'subscription',
        kimiListReadiness: classifyKimiCredentialBlob(
          JSON.stringify({ access_token: 'tok', refresh_token: 'r' }),
        ),
      }),
    ).toBe(false);
  });
});

describe('canSeatFromProvider usa o cache Kimi quando aquecido', () => {
  it('Kimi subscription fria (sem list) não senta', () => {
    expect(
      canSeatFromProvider({
        adapterId: 'kimi',
        authStrategy: 'subscription',
      }),
    ).toBe(false);
  });

  it('Kimi com list oauth senta; list missing não', () => {
    rememberKimiSeatReadiness('present');
    expect(
      canSeatFromProvider({
        adapterId: 'kimi',
        authStrategy: 'subscription',
      }),
    ).toBe(true);
    rememberKimiSeatReadiness('missing');
    expect(
      canSeatFromProvider({
        adapterId: 'kimi',
        authStrategy: 'subscription',
      }),
    ).toBe(false);
    expect(peekKimiSeatReadiness()).toBe('missing');
  });

  it('Codex subscription senta; login-needed não', () => {
    expect(
      canSeatFromProvider({
        adapterId: 'codex',
        authStrategy: 'subscription',
      }),
    ).toBe(true);
    expect(
      canSeatFromProvider({
        adapterId: 'codex',
        authStrategy: 'login-needed',
      }),
    ).toBe(false);
  });
});

describe('classifyKimiProviderList — formato real do Kimi CLI 0.38', () => {
  // Payload capturado da máquina do operador (23/08) com `kimi login` feito:
  // `providers` é MAPA e o assento OAuth é objeto aninhado, sem campo `source`.
  const REAL_038 = JSON.stringify({
    providers: {
      'managed:kimi-code': {
        baseUrl: 'https://api.kimi.com/coding/v1',
        type: 'kimi',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    },
    models: { 'kimi-code/k3': { provider: 'managed:kimi-code' } },
  });

  it('reconhece o assento logado que o produto dizia estar deslogado', () => {
    expect(classifyKimiProviderList(REAL_038)).toBe('present');
  });

  it('providers como mapa sem oauth não é assento', () => {
    expect(
      classifyKimiProviderList(
        JSON.stringify({
          providers: { 'managed:kimi-code': { type: 'kimi', apiKey: '' } },
        }),
      ),
    ).not.toBe('present');
  });

  it('objeto oauth VAZIO não conta como assento', () => {
    expect(
      classifyKimiProviderList(
        JSON.stringify({
          providers: { 'managed:kimi-code': { type: 'kimi', oauth: {} } },
        }),
      ),
    ).not.toBe('present');
  });

  it('a saída de TEXTO com source=oauth continua valendo', () => {
    expect(
      classifyKimiProviderList(
        'managed:kimi-code  type=kimi  models=4  source=oauth',
      ),
    ).toBe('present');
  });

  it('"No providers configured" continua sendo ausência', () => {
    expect(classifyKimiProviderList('No providers configured')).toBe('missing');
  });
});
