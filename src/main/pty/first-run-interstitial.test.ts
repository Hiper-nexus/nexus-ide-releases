import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ANSWERS,
  ANSWER_DISMISS,
  ANSWER_FIRST_NUMBERED_OPTION,
  decideFirstRunInterstitial,
  FIRST_RUN_INTERSTITIAL_PATTERNS,
  FIRST_RUN_WINDOW_MS,
  FirstRunInterstitialResponder,
  screenNamesOwnCwd,
  type FirstRunInterstitialContext,
} from './first-run-interstitial';
import { cpuTimeMs } from '../../test/cpu-time';

const CWD = '/Users/op/dev/nexus-ide';
const HOME = '/Users/op';

function context(
  overrides: Partial<FirstRunInterstitialContext> = {},
): FirstRunInterstitialContext {
  return {
    adapterId: 'claude',
    missionId: 'mission-42',
    cwd: CWD,
    homeDir: HOME,
    msSinceSpawn: 1_200,
    answeredPatterns: [],
    agentWorkObserved: false,
    ...overrides,
  };
}

/** Claude Code 2.1.2xx workspace-trust gate, as a real TUI paints it. */
function trustScreen(directory = CWD): string {
  return [
    '╭──────────────────────────────────────────────────────────╮',
    '│ Do you trust the contents of this directory?             │',
    '│                                                          │',
    `│ ${directory}`.padEnd(60, ' ') + '│',
    '│                                                          │',
    '│ Working with untrusted contents comes with a higher risk │',
    '│ of prompt injection. Only continue if this directory is  │',
    '│ one you created or otherwise trust.                      │',
    '│                                                          │',
    '│ 1. Yes, continue                                         │',
    '│ 2. No, quit                                              │',
    '│                                                          │',
    '│ Press enter to continue                                  │',
    '╰──────────────────────────────────────────────────────────╯',
  ].join('\n');
}

/** Verbatim copy from the grok binary's first-run data-sharing gate. */
const GROK_CONSENT_SCREEN = [
  '  Help improve Grok',
  '',
  '  Off by default. Opt-in to allow SpaceXAI to retain coding data, e.g.,',
  '  prompts, traces, & metrics, for training and debugging purposes.',
  '  Change anytime via settings.',
  '',
  '  Read Terms and Privacy Policy',
  '',
  '  [Opt in]   [Opt out]',
].join('\n');

/** Verbatim copy from the kimi-code binary's first-launch migration offer. */
const KIMI_MIGRATION_SCREEN = [
  '────────────────────────────────────────────',
  ' Migrate from kimi-cli',
  ' Found an existing kimi-cli installation:',
  '   42 sessions · config.toml · mcp.json',
  '',
  ' Migrate this data to kimi-code?',
  '',
  '  ▸ Migrate now',
  '    Ask me later',
  '    Never ask again',
  '',
  ' ↑↓ move  ↵ select  esc later',
  '────────────────────────────────────────────',
].join('\n');

describe('workspace-trust screen', () => {
  it('answers with option 1 when the printed directory is the pane cwd', () => {
    expect(decideFirstRunInterstitial(trustScreen(), context())).toEqual({
      answer: ANSWER_FIRST_NUMBERED_OPTION,
      pattern: 'workspace-trust-directory-contents',
    });
  });

  it('does NOT answer when the printed path differs from the pane cwd', () => {
    const decision = decideFirstRunInterstitial(
      trustScreen('/Users/op/dev/some-other-repo'),
      context(),
    );
    expect(decision).toBeNull();
  });

  it('does NOT answer when the screen prints a parent of the pane cwd', () => {
    expect(
      decideFirstRunInterstitial(trustScreen('/Users/op/dev'), context()),
    ).toBeNull();
  });

  it('does NOT answer when the screen prints a child of the pane cwd', () => {
    expect(
      decideFirstRunInterstitial(
        trustScreen(`${CWD}/src/main`),
        context(),
      ),
    ).toBeNull();
  });

  it('does NOT answer when no directory is printed at all', () => {
    const withoutPath = trustScreen().replace(CWD, '(this folder)');
    expect(decideFirstRunInterstitial(withoutPath, context())).toBeNull();
  });

  it('accepts a ~-abbreviated directory that expands to the pane cwd', () => {
    const decision = decideFirstRunInterstitial(
      trustScreen('~/dev/nexus-ide'),
      context(),
    );
    expect(decision?.answer).toBe(ANSWER_FIRST_NUMBERED_OPTION);
  });

  it('does NOT answer when the trust signals are only partially present', () => {
    const partial = trustScreen().replace(
      'of prompt injection. Only continue if this directory is',
      'that you should read carefully before continuing.',
    );
    expect(decideFirstRunInterstitial(partial, context())).toBeNull();
  });

  it('does NOT answer for a CLI that never shows this screen', () => {
    expect(
      decideFirstRunInterstitial(
        trustScreen(),
        context({ adapterId: 'codex' }),
      ),
    ).toBeNull();
  });
});

describe('mission boundary', () => {
  it('ignores the exact same screen in a non-mission (operator) pane', () => {
    expect(
      decideFirstRunInterstitial(
        trustScreen(),
        context({ missionId: undefined }),
      ),
    ).toBeNull();
    expect(
      decideFirstRunInterstitial(trustScreen(), context({ missionId: '  ' })),
    ).toBeNull();
  });

  it('ignores a non-mission pane for the dismiss-only screens too', () => {
    expect(
      decideFirstRunInterstitial(
        GROK_CONSENT_SCREEN,
        context({ adapterId: 'grok', missionId: undefined }),
      ),
    ).toBeNull();
  });
});

describe('time window and agent work', () => {
  it('answers inside the post-spawn window', () => {
    expect(
      decideFirstRunInterstitial(
        trustScreen(),
        context({ msSinceSpawn: FIRST_RUN_WINDOW_MS - 1 }),
      ),
    ).not.toBeNull();
  });

  it('stops answering once the window has elapsed', () => {
    expect(
      decideFirstRunInterstitial(
        trustScreen(),
        context({ msSinceSpawn: FIRST_RUN_WINDOW_MS + 1 }),
      ),
    ).toBeNull();
  });

  it('never answers once the pane produced real agent work', () => {
    expect(
      decideFirstRunInterstitial(
        trustScreen(),
        context({ agentWorkObserved: true }),
      ),
    ).toBeNull();
  });
});

describe('never auto-answers anything outside the closed list', () => {
  const SAMPLES: ReadonlyArray<readonly [string, string, string]> = [
    [
      'file-write permission prompt',
      'claude',
      [
        '╭─────────────────────────────────────────────────────────╮',
        '│ Edit file                                               │',
        `│ ${CWD}/src/main/main.ts`.padEnd(59, ' ') + '│',
        '│                                                         │',
        '│ Do you want to make this edit to main.ts?               │',
        '│ 1. Yes                                                  │',
        '│ 2. Yes, allow all edits during this session             │',
        '│ 3. No, and tell Claude what to do differently (esc)     │',
        '╰─────────────────────────────────────────────────────────╯',
      ].join('\n'),
    ],
    [
      'run-this-command approval',
      'claude',
      [
        '╭─────────────────────────────────────────────────────────╮',
        '│ Bash command                                            │',
        `│ rm -rf ${CWD}/dist`.padEnd(59, ' ') + '│',
        '│                                                         │',
        '│ Do you want to proceed?                                 │',
        '│ 1. Yes                                                  │',
        '│ 2. No, and tell Claude what to do differently (esc)     │',
        '╰─────────────────────────────────────────────────────────╯',
      ].join('\n'),
    ],
    [
      'destructive confirmation reusing the same option labels',
      'claude',
      [
        `This will permanently delete 128 files under ${CWD}`,
        'and force-push the rewritten history to origin/main.',
        '',
        '1. Yes, continue',
        '2. No, quit',
        'Press enter to continue',
      ].join('\n'),
    ],
    [
      'generic (y/N) question naming the pane cwd',
      'claude',
      `Overwrite existing config at ${CWD}/.nexus/config.json? (y/N) `,
    ],
    [
      'login / credential screen',
      'claude',
      [
        'Select login method:',
        '',
        '1. Yes, continue with the Claude account with subscription',
        '2. No, quit and use an Anthropic Console API key instead',
      ].join('\n'),
    ],
    [
      'legacy folder-trust screen owned by cli-prompt-autoresponder',
      'claude',
      [
        'Do you trust the files in this folder?',
        CWD,
        'Claude Code may read files in this folder.',
        '1. Yes, proceed',
        '2. No, exit',
      ].join('\n'),
    ],
    [
      'legacy bypass-permissions banner owned by cli-prompt-autoresponder',
      'claude',
      [
        'Claude Code running in Bypass Permissions mode',
        '1. No, exit',
        '2. Yes, I accept',
      ].join('\n'),
    ],
    [
      'legacy quick-safety-check owned by cli-prompt-autoresponder',
      'claude',
      [
        'Quick safety check: is this a project you created or one you trust?',
        CWD,
        '1. Yes, I trust this folder',
        '2. No, exit',
      ].join('\n'),
    ],
    [
      'legacy agy project-trust owned by cli-prompt-autoresponder',
      'agy',
      [
        'Do you trust the contents of this project?',
        CWD,
        'Antigravity CLI requires permission to read, edit, and execute files here.',
        '1. Yes, I trust this folder',
      ].join('\n'),
    ],
    [
      'legacy grok folder-trust owned by cli-prompt-autoresponder',
      'grok',
      [
        'Do you trust the contents of this directory?',
        CWD,
        'Grok Build may run or modify contents in this directory.',
        '1. Yes, proceed',
        '2. No, quit',
      ].join('\n'),
    ],
    ['ordinary agent output', 'claude', 'Reading src/main/main.ts (412 lines)'],
  ];

  it.each(SAMPLES)('does not answer: %s', (_label, adapterId, screen) => {
    expect(
      decideFirstRunInterstitial(screen, context({ adapterId })),
    ).toBeNull();
  });
});

describe('dismiss-only first-run screens', () => {
  it('dismisses the Grok coding-data consent gate with Esc, never opting in', () => {
    const decision = decideFirstRunInterstitial(
      GROK_CONSENT_SCREEN,
      context({ adapterId: 'grok' }),
    );
    expect(decision).toEqual({
      answer: ANSWER_DISMISS,
      pattern: 'grok-coding-data-consent',
    });
  });

  it('defers the Kimi migration offer with Esc, never migrating', () => {
    const decision = decideFirstRunInterstitial(
      KIMI_MIGRATION_SCREEN,
      context({ adapterId: 'kimi' }),
    );
    expect(decision).toEqual({
      answer: ANSWER_DISMISS,
      pattern: 'kimi-migrate-from-kimi-cli',
    });
  });

  it('does not answer the Kimi migration screen for another CLI', () => {
    expect(
      decideFirstRunInterstitial(
        KIMI_MIGRATION_SCREEN,
        context({ adapterId: 'claude' }),
      ),
    ).toBeNull();
  });
});

describe('pattern table invariants', () => {
  it('only ever emits keystrokes declared in ALLOWED_ANSWERS', () => {
    for (const pattern of FIRST_RUN_INTERSTITIAL_PATTERNS) {
      expect(ALLOWED_ANSWERS.has(pattern.answer)).toBe(true);
    }
  });

  it('keeps every affirmative answer fenced by the cwd proof', () => {
    const affirmative = FIRST_RUN_INTERSTITIAL_PATTERNS.filter(
      (pattern) => pattern.answer !== ANSWER_DISMISS,
    );
    expect(affirmative).toHaveLength(1);
    for (const pattern of affirmative) {
      expect(pattern.directoryProof).toBe('cwd-match');
    }
  });

  it('requires at least three independent signals per screen', () => {
    for (const pattern of FIRST_RUN_INTERSTITIAL_PATTERNS) {
      expect(pattern.requireAll.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('uses unique pattern names', () => {
    const names = FIRST_RUN_INTERSTITIAL_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('screenNamesOwnCwd', () => {
  it('matches through TUI frame borders and trailing punctuation', () => {
    expect(screenNamesOwnCwd(`│ ${CWD}.  │`, CWD, HOME)).toBe(true);
  });

  it('does not match a path that merely shares a prefix', () => {
    expect(screenNamesOwnCwd(`${CWD}-backup`, CWD, HOME)).toBe(false);
  });

  it('tolerates a trailing slash on the printed path', () => {
    expect(screenNamesOwnCwd(`${CWD}/`, CWD, HOME)).toBe(true);
  });

  it('refuses an empty cwd', () => {
    expect(screenNamesOwnCwd(trustScreen(), '   ', HOME)).toBe(false);
  });
});

describe('FirstRunInterstitialResponder', () => {
  // `missionId: null` models an operator pane. A defaulted `undefined`
  // parameter would silently fall back to the mission id and hide the case.
  function bound(
    adapterId = 'claude',
    missionId: string | null = 'mission-42',
  ): { responder: FirstRunInterstitialResponder; now: number } {
    const responder = new FirstRunInterstitialResponder();
    const now = 1_000;
    responder.bind(
      'session-1',
      {
        adapterId,
        ...(missionId ? { missionId } : {}),
        cwd: CWD,
        homeDir: HOME,
      },
      now,
    );
    return { responder, now };
  }

  it('answers a whitelisted screen at most once per session', () => {
    const { responder, now } = bound();
    expect(
      responder.observe('session-1', trustScreen(), { now: now + 500 }),
    ).not.toBeNull();
    expect(
      responder.observe('session-1', trustScreen(), { now: now + 900 }),
    ).toBeNull();
    expect(
      responder.observe('session-1', trustScreen(), { now: now + 5_000 }),
    ).toBeNull();
  });

  it('stops watching once every applicable pattern is answered', () => {
    const { responder, now } = bound('kimi');
    expect(responder.isWatching('session-1', now + 10)).toBe(true);
    expect(
      responder.observe('session-1', KIMI_MIGRATION_SCREEN, { now: now + 10 }),
    ).not.toBeNull();
    expect(responder.isWatching('session-1', now + 20)).toBe(false);
  });

  it('reassembles a screen split across PTY chunks', () => {
    const { responder, now } = bound();
    const screen = trustScreen();
    const half = Math.floor(screen.length / 2);
    expect(
      responder.observe('session-1', screen.slice(0, half), { now: now + 10 }),
    ).toBeNull();
    expect(
      responder.observe('session-1', screen.slice(half), { now: now + 20 }),
    ).toEqual({
      answer: ANSWER_FIRST_NUMBERED_OPTION,
      pattern: 'workspace-trust-directory-contents',
    });
  });

  it('stops watching after the post-spawn window elapses', () => {
    const { responder, now } = bound();
    const late = now + FIRST_RUN_WINDOW_MS + 1;
    expect(responder.isWatching('session-1', late)).toBe(false);
    expect(
      responder.observe('session-1', trustScreen(), { now: late }),
    ).toBeNull();
  });

  it('closes the session as soon as real agent work is reported', () => {
    const { responder, now } = bound();
    expect(
      responder.observe('session-1', trustScreen(), {
        now: now + 10,
        agentWorkObserved: true,
      }),
    ).toBeNull();
    expect(responder.isWatching('session-1', now + 20)).toBe(false);
  });

  it('never binds a CLI with no first-run screen of its own', () => {
    const responder = new FirstRunInterstitialResponder();
    responder.bind('session-2', { adapterId: 'codex', cwd: CWD }, 1_000);
    expect(responder.isWatching('session-2', 1_010)).toBe(false);
    expect(responder.watchedCount()).toBe(0);
  });

  it('stays silent for a bound pane with no mission', () => {
    const { responder, now } = bound('claude', null);
    expect(
      responder.observe('session-1', trustScreen(), { now: now + 10 }),
    ).toBeNull();
  });

  it('drops per-session state on exit', () => {
    const { responder } = bound();
    expect(responder.watchedCount()).toBe(1);
    responder.drop('session-1');
    expect(responder.watchedCount()).toBe(0);
    expect(responder.missionOf('session-1')).toBeNull();
  });

  it('exposes the mission id for the observability log line', () => {
    const { responder } = bound();
    expect(responder.missionOf('session-1')).toBe('mission-42');
  });
});

describe('operator kill switch', () => {
  function killSwitched(
    enabled: () => boolean,
  ): FirstRunInterstitialResponder {
    const responder = new FirstRunInterstitialResponder(enabled);
    responder.bind(
      'session-1',
      { adapterId: 'claude', missionId: 'mission-42', cwd: CWD, homeDir: HOME },
      1_000,
    );
    return responder;
  }

  it('answers nothing while the kill switch is off', () => {
    const responder = killSwitched(() => false);
    expect(responder.isWatching('session-1', 1_010)).toBe(false);
    expect(
      responder.observe('session-1', trustScreen(), { now: 1_010 }),
    ).toBeNull();
  });

  it('fails closed when the settings read throws', () => {
    const responder = killSwitched(() => {
      throw new Error('settings unreadable');
    });
    expect(responder.isWatching('session-1', 1_010)).toBe(false);
    expect(
      responder.observe('session-1', trustScreen(), { now: 1_010 }),
    ).toBeNull();
  });

  it('answers normally while the kill switch is on', () => {
    const responder = killSwitched(() => true);
    expect(
      responder.observe('session-1', trustScreen(), { now: 1_010 }),
    ).toEqual({
      answer: ANSWER_FIRST_NUMBERED_OPTION,
      pattern: 'workspace-trust-directory-contents',
    });
  });
});

describe('prova de cwd em tempo linear (F-764 C.3)', () => {
  /** A versão anterior, só como referência: `[…]+$` sem âncora de início. */
  function referenceNamesOwnCwd(screenText: string, cwd: string): boolean {
    const strip = (text: string) => text.replace(/[─-▟|]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalize = (raw: string) => {
      let value = raw.trim().replace(/[.,;:!?)\]}…]+$/, '');
      value = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
      if (value.length > 1) value = value.replace(/\/+$/, '');
      return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
    };
    if (!cwd.trim()) return false;
    const haystack = strip(screenText);
    const target = normalize(cwd);
    const candidates = [
      ...(haystack.match(/(?:~|\/)[^\s"'`,;:()[\]{}<>]+/g) ?? []),
      ...(haystack.match(/[A-Za-z]:[\\/][^\s"'`,;()[\]{}<>]*/g) ?? []),
    ];
    return candidates.some((candidate) => normalize(candidate) === target);
  }

  it('decide igual à versão anterior em 20 mil telas aleatórias', () => {
    const pieces = ['/tmp', '/x', '.', '.', '!', '?', '…', ')', ']', '}', ' ', '/', 'C:\\x', 'a'];
    let seed = 99;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 20_000; round += 1) {
      let screen = '';
      const length = Math.floor(random() * 10);
      for (let i = 0; i < length; i += 1) screen += pieces[Math.floor(random() * pieces.length)];
      for (const cwd of ['/tmp', '/tmp/x', 'C:/x']) {
        expect(screenNamesOwnCwd(screen, cwd), `${JSON.stringify(screen)} ${cwd}`).toBe(
          referenceNamesOwnCwd(screen, cwd),
        );
      }
    }
  });

  it('16 KB de pontuação antes de uma letra: tempo linear', () => {
    const screen = `/${'.'.repeat(16_382)}x`;
    // A versão anterior custava ~190 ms com esta tela.
    expect(cpuTimeMs(() => screenNamesOwnCwd(screen, '/tmp/x'))).toBeLessThan(20);
  });
});
