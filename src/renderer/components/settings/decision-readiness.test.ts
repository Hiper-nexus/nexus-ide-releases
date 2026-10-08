import { describe, expect, it } from 'vitest';
import { decisionNotices } from './decision-readiness';
import type { DecisionModelStatus, DecisionSettings } from '../../../shared/decision-models';

type StatusOverrides = Omit<Partial<DecisionModelStatus>, 'settings'> & { settings?: Partial<DecisionSettings> };

function status(overrides: StatusOverrides = {}): DecisionModelStatus {
  const { settings, ...rest } = overrides;
  return {
    settings: { mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false, ...settings },
    accountId: '0123456789abcdef0123456789abcdef', accountIdSource: 'settings', hasStoredKey: true, hasEnv: false,
    keyMasked: 'clo…3456', secureStorageAvailable: true, isReady: true, jevReady: true, lunaReady: false, ...rest,
  };
}
const ids = (value: DecisionModelStatus) => decisionNotices(value).map(notice => notice.id);

describe('decision model readiness notices', () => {
  it('stays quiet when the selected provider is ready', () => {
    expect(ids(status())).toEqual([]);
    expect(ids(status({ settings: { mode: 'jev' } }))).toEqual([]);
  });

  it('warns that Jev-only without a key hides the decision tools', () => {
    const [notice] = decisionNotices(status({ settings: { mode: 'jev' }, jevReady: false }));
    expect(notice).toMatchObject({ id: 'jev-not-ready', tone: 'warn' });
    expect(notice.text).toContain('chave TypeSafe');
  });

  it('names exactly what Clef-only is missing', () => {
    const missingToken = decisionNotices(status({ settings: { mode: 'clef' }, isReady: false, hasStoredKey: false }));
    expect(missingToken[0]).toMatchObject({ id: 'clef-not-ready', tone: 'warn' });
    expect(missingToken[0].text).toContain('API Token');
    expect(missingToken[0].text).not.toContain('Account ID');
    const missingBoth = decisionNotices(status({ settings: { mode: 'clef', cloudflareAccountId: '' }, isReady: false, hasStoredKey: false, accountId: '', accountIdSource: 'missing' }));
    expect(missingBoth[0].text).toContain('Account ID');
    expect(missingBoth[0].text).toContain('API Token');
  });

  it('explains that Clef-only switches the Jev-calibrated safeguards off', () => {
    const notice = decisionNotices(status({ settings: { mode: 'clef' } })).find(entry => entry.id === 'clef-only-scope');
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toMatch(/guarda de despacho/i);
    expect(notice?.text).toContain('sem rota');
    expect(notice?.text).toContain('sem julgamento do Jev');
    expect(notice?.text).not.toContain('só rodam no Jev');
  });

  it('warns when Automatic would silently send Jev tasks to Cloudflare for lack of a Jev key', () => {
    const notice = decisionNotices(status({ jevReady: false })).find(entry => entry.id === 'credential-fallback');
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toContain('Cloudflare');
    expect(ids(status({ jevReady: false, isReady: false, hasStoredKey: false }))).toEqual(['no-provider']);
  });

  it('says Automatic decides only through Jev while Cloudflare is not ready', () => {
    expect(ids(status({ isReady: false, hasStoredKey: false }))).toEqual(['auto-jev-only']);
  });

  it('treats Luna as a real provider: missing key hides tools, and automatic does not call that no provider', () => {
    const missing = decisionNotices(status({ settings: { mode: 'luna' }, lunaReady: false }));
    expect(missing[0]).toMatchObject({ id: 'luna-not-ready', tone: 'warn' });
    expect(missing[0].text).toContain('Chaves de API');
    const pins = decisionNotices(status({ settings: { mode: 'luna' }, lunaReady: true, jevReady: false }));
    expect(pins.find(entry => entry.id === 'luna-pins')?.text).toContain('não volta para o Jev');
    expect(ids(status({ jevReady: false, isReady: false, hasStoredKey: false, lunaReady: true }))).toEqual(['luna-fallback']);
  });

  it('says together costs more than one call and names who is missing', () => {
    const ready = decisionNotices(status({ settings: { mode: 'together' }, lunaReady: true }));
    expect(ready.find(entry => entry.id === 'together-cost')?.text).toContain('mais de uma chamada');
    const partial = decisionNotices(status({ settings: { mode: 'together' }, lunaReady: true, isReady: false, hasStoredKey: false }));
    expect(partial.find(entry => entry.id === 'together-partial')?.text).toContain('Cloudflare');
    expect(partial.find(entry => entry.id === 'together-partial')?.text).toContain('mais de uma chamada');
    const alone = decisionNotices(status({ settings: { mode: 'together' }, lunaReady: true, jevReady: false, isReady: false, hasStoredKey: false }));
    expect(alone.find(entry => entry.id === 'together-short')?.tone).toBe('warn');
  });

  it('warns that image analysis is on while Cloudflare is not ready', () => {
    expect(ids(status({ settings: { visionEnabled: true }, isReady: false, hasStoredKey: false }))).toContain('vision-not-ready');
    expect(ids(status({ settings: { visionEnabled: true } }))).not.toContain('vision-not-ready');
  });
});
