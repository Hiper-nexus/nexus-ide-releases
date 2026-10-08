import { describe, expect, it } from 'vitest';
import {
  redactBugReportPayload,
  redactBugReportText,
} from './bug-report-redaction';
import type { BugReportPayload } from '../../shared/bug-report';

/**
 * Os segredos de teste são MONTADOS em runtime (prefixo + corpo): nenhum
 * literal com formato de credencial entra no repositório, e o scanner de
 * segredos do git não confunde fixture com vazamento.
 */
const body = (length: number, alphabet = 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY'): string =>
  alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);

const SECRETS: Record<string, string> = {
  bearerLong: `Bearer ${body(40)}`,
  bearerShort: `Bearer ${body(10)}`,
  jwt: `ey${'J'}hbGciOiJIUzI1NiJ9.${body(24)}.${body(24)}`,
  openai: `sk-${body(32)}`,
  anthropic: `sk-ant-api03-${body(40)}`,
  github: `ghp_${body(36)}`,
  githubFine: `github_pat_${body(40)}`,
  google: `AIza${body(35)}`,
  aws: `AKIA${'ABCDEFGHIJKLMNOP'}`,
  slack: `xox${'b'}-${body(24)}`,
  stripeLive: `sk_${'live'}_${body(24)}`,
  stripeWebhook: `whsec_${body(32)}`,
  hf: `hf_${body(34)}`,
  opaqueSession: body(48),
};

function sensitiveSubstring(secret: string): string {
  return secret.replace(/^Bearer\s+/, '');
}

describe('redactBugReportText — credentials', () => {
  it.each(Object.entries(SECRETS))('masks %s', (_name, secret) => {
    const text = `antes ${secret} depois`;
    const out = redactBugReportText(text);
    expect(out).not.toContain(sensitiveSubstring(secret));
    expect(out.startsWith('antes ')).toBe(true);
    expect(out.endsWith(' depois')).toBe(true);
  });

  it('masks KEY=value and Authorization headers', () => {
    const out = redactBugReportText(
      `API_KEY=${body(20)} e Authorization: Basic ${body(24)} e token: "${body(24)}"`,
    );
    expect(out).not.toContain(body(20));
    expect(out).not.toContain(body(24));
  });

  it('masks private key blocks', () => {
    const pem = `-----BEGIN ${'PRIVATE'} KEY-----\n${body(64)}\n-----END ${'PRIVATE'} KEY-----`;
    expect(redactBugReportText(`chave:\n${pem}`)).not.toContain(body(64));
  });

  it('masks credentials embedded in URLs but keeps the host', () => {
    const out = redactBugReportText(`clone https://usuario:${body(20)}@github.com/org/repo.git`);
    expect(out).not.toContain(body(20));
    expect(out).not.toContain('usuario:');
    expect(out).toContain('github.com/org/repo.git');
  });

  it('keeps ordinary prose and short identifiers untouched', () => {
    const text = 'O terminal 3 travou no commit abc1234 depois de colar texto (v0.76.161).';
    expect(redactBugReportText(text)).toBe(text);
  });

  it('never leaks the secret when it spans several lines of a log', () => {
    const log = [`GET /v1/me`, `authorization: Bearer ${body(44)}`, `status 200`].join('\n');
    expect(redactBugReportText(log)).not.toContain(body(44));
  });
});

describe('redactBugReportText — pasted configs, flags and headers', () => {
  it('masks values of quoted JSON / dict keys regardless of length or digits', () => {
    const json = redactBugReportText('{"password":"hunter2","apiKey":"abcd1234efgh5678ijkl","name":"Ana","note":"ok"}');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('abcd1234efgh5678ijkl');
    expect(json).toContain('"name":"Ana"');
    expect(json).toContain('"note":"ok"');
    const dict = redactBugReportText("{'secret': 'valor-curto', 'user': 'ana'}");
    expect(dict).not.toContain('valor-curto');
    expect(dict).toContain("'user': 'ana'");
  });

  it('masks key=value assignments and URL query credentials without a length floor', () => {
    const out = redactBugReportText('password=MySecretPass e GET /cb?access_token=zzz999&page=2');
    expect(out).not.toContain('MySecretPass');
    expect(out).not.toContain('zzz999');
    expect(out).toContain('page=2');
  });

  it('does not mistake token counts or tokenizers for credentials', () => {
    const text = 'max_tokens=4096 e tokenizer=bpe';
    expect(redactBugReportText(text)).toBe(text);
  });

  it('masks the value that follows CLI credential flags', () => {
    const out = redactBugReportText('rodei com --password hunter2 --api-key valor123 --token=abc e --verbose');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('valor123');
    expect(out).not.toContain('=abc');
    expect(out).toContain('--verbose');
  });

  it('masks the whole value of Authorization, Cookie and Set-Cookie lines for any scheme', () => {
    const lines = [
      `Authorization: Negotiate ${body(30)}`,
      `Authorization: ApiKey ${body(20)}`,
      `Cookie: session=${body(32)}; theme=dark`,
      `Set-Cookie: sid=${body(24)}; HttpOnly`,
    ].join('\n');
    const out = redactBugReportText(lines);
    expect(out).not.toContain(body(20));
    expect(out).not.toContain('theme=dark');
    expect(out).toContain('Authorization:');
    expect(out.split('\n')).toHaveLength(4);
  });

  it('masks long credentials in chunks instead of leaving a tail', () => {
    const blob = body(450);
    const out = redactBugReportText(`chave ${blob} fim`);
    expect(out).not.toContain(body(60));
  });
});

describe('redactBugReportText — adversarial input stays fast', () => {
  const cases: Array<[string, string]> = [
    ['long run of letters', 'a'.repeat(4000)],
    ['dashed run', 'a-'.repeat(2000)],
    ['dotted local parts', 'a.'.repeat(2000)],
    ['many at signs', 'a@'.repeat(2000)],
    ['digit run', '1'.repeat(4000)],
    ['spaced assignments', 'token = '.repeat(500)],
  ];
  it.each(cases)('finishes quickly on %s', (_label, input) => {
    const started = performance.now();
    redactBugReportText(input);
    expect(performance.now() - started).toBeLessThan(750);
  });
});

describe('redactBugReportText — personal data', () => {
  it('masks e-mail addresses', () => {
    const out = redactBugReportText('fale com maria.silva+nexus@exemplo.com.br ou joao@x.io');
    expect(out).not.toContain('maria');
    expect(out).not.toContain('exemplo.com.br');
    expect(out).not.toContain('joao@x.io');
    expect(out).toContain('[email]');
  });

  it('collapses POSIX home directories to ~', () => {
    const out = redactBugReportText(
      'erro em /Users/cleofasrocha/dev/nexus-ide/src/main.ts e /home/ana/projetos/app',
    );
    expect(out).not.toContain('cleofasrocha');
    expect(out).not.toContain('/home/ana');
    expect(out).toContain('~/dev/nexus-ide/src/main.ts');
    expect(out).toContain('~/projetos/app');
  });

  it('collapses Windows home directories (both slash styles) to ~', () => {
    const out = redactBugReportText(
      String.raw`falhou em C:\Users\Joao Silva\AppData\Roaming\Nexus e c:/Users/Maria/dev`,
    );
    expect(out).not.toContain('Maria');
    expect(out).not.toContain('Silva');
    expect(out).toContain('~');
  });

  it('handles JSON-escaped Windows paths and does not swallow the sentence after a bare username', () => {
    const escaped = redactBugReportText(String.raw`{"path":"C:\\Users\\Joao\\dev\\app"}`);
    expect(escaped).not.toContain('Joao');
    const bare = redactBugReportText(String.raw`o erro foi em C:\Users\Joao e depois travou`);
    expect(bare).not.toContain('Joao');
    expect(bare).toContain('e depois travou');
  });

  it('handles Git Bash, WSL, file URLs and punctuation after a literal home', () => {
    expect(redactBugReportText('em /c/Users/Maria/proj')).not.toContain('Maria');
    expect(redactBugReportText(String.raw`em \\wsl$\Ubuntu\home\maria\proj`)).not.toContain('maria');
    const fileUrl = redactBugReportText('abri file:///Users/ana/doc.txt agora');
    expect(fileUrl).not.toContain('ana');
    expect(fileUrl).toContain('file://');
    const punctuated = redactBugReportText('(veja /data/joao), ou /data/joao: ou /data/joao.', {
      homeDir: '/data/joao',
    });
    expect(punctuated).not.toContain('joao');
  });

  it('masks a home directory at the very end of the text', () => {
    expect(redactBugReportText('pasta: /Users/ana')).toBe('pasta: ~');
  });

  it('masks the literal home directory of this machine even when non-standard', () => {
    const out = redactBugReportText('abri /srv/perfis/operador01/notas.txt', {
      homeDir: '/srv/perfis/operador01',
    });
    expect(out).not.toContain('operador01');
    expect(out).toContain('~/notas.txt');
  });

  it('is idempotent', () => {
    const once = redactBugReportText(
      `${SECRETS.openai} ana@x.com /Users/ana/proj`,
    );
    expect(redactBugReportText(once)).toBe(once);
  });
});

describe('redactBugReportPayload', () => {
  const dirty: BugReportPayload = {
    title: 'Falha ao entrar com ana@exemplo.com',
    description: `Meu token ${SECRETS.github} aparece em /Users/ana/log.txt`,
    steps: `1. rodar com ${SECRETS.openai}`,
    category: 'crash',
    impact: 'blocks_work',
    app: { version: '0.76.161', platform: 'darwin', arch: 'arm64', osVersion: '27.2.0' },
    context: { adapter: 'claude', model: 'opus', paneCount: 2, missionActive: false },
    consent: { diagnostics: true },
    diagnostics: {
      events: [{ t: 1, kind: 'main-boot', code: `E_${SECRETS.opaqueSession}` }],
      errors: [`falha ${SECRETS.stripeLive}`],
    },
  };

  it('redacts every free-text field of the payload and leaks nothing', () => {
    const out = redactBugReportPayload(dirty);
    const serialized = JSON.stringify(out);
    for (const secret of [SECRETS.github, SECRETS.openai, SECRETS.opaqueSession, SECRETS.stripeLive]) {
      expect(serialized).not.toContain(sensitiveSubstring(secret));
    }
    expect(serialized).not.toContain('ana@exemplo.com');
    expect(serialized).not.toContain('/Users/ana');
  });

  it('keeps structural fields (enums, numbers, booleans) untouched', () => {
    const out = redactBugReportPayload(dirty);
    expect(out.category).toBe('crash');
    expect(out.impact).toBe('blocks_work');
    expect(out.app).toEqual(dirty.app);
    expect(out.context).toEqual(dirty.context);
    expect(out.consent).toEqual({ diagnostics: true });
    expect(out.diagnostics?.events[0]?.t).toBe(1);
  });

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(dirty);
    redactBugReportPayload(dirty);
    expect(JSON.stringify(dirty)).toBe(snapshot);
  });

  it('keeps text within the contract limits after masking', () => {
    const longEmails = 'a@b.co '.repeat(700);
    const out = redactBugReportPayload({ ...dirty, description: longEmails });
    expect(out.description.length).toBeLessThanOrEqual(4000);
  });
});

describe('redactBugReportText — formatos que a revisão de segurança apontou', () => {
  it('masks a private key block even when the END line was cut off', () => {
    const lines = [body(64), `${body(60, 'aB3+/dE5')}`, body(64), body(40)];
    const text = `log:\n-----BEGIN ${'RSA'} PRIVATE KEY-----\n${lines.join('\n')}\nfim do relato`;
    const out = redactBugReportText(text);
    for (const line of lines) expect(out).not.toContain(line.slice(0, 24));
    expect(out).toContain('log:');
  });

  it('masks session-like query parameters but keeps ordinary "code=" prose', () => {
    const url = `https://app.exemplo.com/cb?session=${body(20)}&sid=${body(12)}&auth=${body(14)}&key=${body(16)}&page=2`;
    const out = redactBugReportText(url);
    for (const secret of [body(20), body(12), body(14), body(16)]) expect(out).not.toContain(secret);
    expect(out).toContain('page=2');
    expect(redactBugReportText('o processo saiu com exit code=76 ao colar')).toContain('code=76');
  });

  it('masks Slack webhooks, Telegram bot tokens and Mailgun keys', () => {
    const slack = `https://hooks.${'slack'}.com/services/T${body(8)}/B${body(8)}/${body(24)}`;
    const telegram = `${'123456789'}:${body(35)}`;
    const mailgun = `key-${'0123456789abcdef'.repeat(2)}`;
    const out = redactBugReportText(`${slack} ${telegram} ${mailgun}`);
    expect(out).not.toContain(body(24));
    expect(out).not.toContain(body(35).slice(0, 20));
    expect(out).not.toContain('0123456789abcdef0123');
  });
});
