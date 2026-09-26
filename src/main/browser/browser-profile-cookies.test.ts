import { describe, expect, it } from 'vitest';
import { BrowserCookieProfile, profileCookieKey, type ProfileCookie, type ProfileCookiePeer } from './browser-profile-cookies';

const cookie = (value: string): ProfileCookie => ({ name: 'session', value, domain: 'example.com', path: '/', secure: true, httpOnly: true });
function peer(initial: ProfileCookie[] = []): ProfileCookiePeer & { jar: Map<string, ProfileCookie>; set(cookies: ProfileCookie[]): Promise<void>; remove(cookie: ProfileCookie): Promise<void> } {
  const jar = new Map(initial.map((item) => [profileCookieKey(item), item]));
  let revision = 0;
  return {
    jar,
    revision: () => revision,
    read: async () => [...jar.values()],
    clear: async () => { if (jar.size) revision += 1; jar.clear(); },
    apply: async (changed, removed) => {
      for (const cookie of removed) if (jar.delete(profileCookieKey(cookie))) revision += 1;
      for (const cookie of changed) { jar.set(profileCookieKey(cookie), cookie); revision += 1; }
    },
    set: async (items) => { for (const item of items) { if (JSON.stringify(jar.get(profileCookieKey(item))) !== JSON.stringify(item)) revision += 1; jar.set(profileCookieKey(item), item); } },
    remove: async (item) => { if (jar.delete(profileCookieKey(item))) revision += 1; },
    failed: () => {},
  };
}

describe('shared Nexus browser cookies', () => {
  it('propagates login changes and logout, including a stale pane opened later', async () => {
    let saved: ProfileCookie[] = [];
    const profile = new BrowserCookieProfile([], (items) => { saved = items; });
    const a = peer(); const b = peer();
    await profile.connect(a); await profile.connect(b);
    await a.set([cookie('new-login')]);
    await profile.refresh(a);
    expect([...b.jar.values()]).toEqual([cookie('new-login')]);
    expect(saved).toEqual([cookie('new-login')]);
    await a.remove(cookie('new-login'));
    await profile.refresh(a);
    expect(b.jar.size).toBe(0);
    const stale = peer([cookie('old-login')]);
    await profile.connect(stale);
    expect(stale.jar.size).toBe(0);
    expect(saved).toEqual([]);
  });

  it('preserves separate top-level partitions for equal cookie names', async () => {
    const a = cookie('ordinary');
    const b = { ...cookie('partitioned'), partitionKey: { topLevelSite: 'https://other.example', hasCrossSiteAncestor: true } };
    const profile = new BrowserCookieProfile([a, b], () => {});
    const tab = peer();
    await profile.connect(tab);
    expect([...tab.jar.values()]).toEqual([a, b]);
    await tab.remove(b); await profile.refresh(tab);
    const next = peer(); await profile.connect(next);
    expect([...next.jar.values()]).toEqual([a]);
  });

  it('does not turn a sync echo from another pane into a new write', async () => {
    let writes = 0;
    const profile = new BrowserCookieProfile([], () => { writes += 1; });
    const a = peer(); const b = peer();
    await profile.connect(a); await profile.connect(b);
    await profile.importCookies([cookie('imported')]);
    await profile.refresh(a); await profile.refresh(b);
    expect(writes).toBe(1);
    expect([...a.jar.values()]).toEqual([cookie('imported')]);
  });

  it('preserves a pending logout when another pane rotates the same cookie', async () => {
    let saved: ProfileCookie[] = [cookie('initial')];
    const profile = new BrowserCookieProfile(saved, (items) => { saved = items; });
    const a = peer(); const b = peer();
    await profile.connect(a); await profile.connect(b);
    await a.set([cookie('rotated')]);
    await b.remove(cookie('initial'));
    await Promise.all([profile.refresh(a), profile.refresh(b)]);
    expect(a.jar.size).toBe(0);
    expect(b.jar.size).toBe(0);
    expect(saved).toEqual([]);
  });

  it('does not overwrite a logout that happens while another snapshot is being read', async () => {
    let saved = [cookie('initial')];
    const profile = new BrowserCookieProfile(saved, (cookies) => { saved = cookies; });
    const a = peer(); const b = peer();
    await profile.connect(a); await profile.connect(b);
    await b.set([cookie('rotated')]);
    const read = b.read;
    b.read = async () => { await a.remove(cookie('initial')); return read(); };
    await profile.refresh(b);
    await profile.refresh(a);
    expect(a.jar.size).toBe(0);
    expect(b.jar.size).toBe(0);
    expect(saved).toEqual([]);
  });

  it('sends cookie deletions and rotations as one browser mutation batch', async () => {
    const tracking = { ...cookie('tracked'), name: 'tracking' };
    const profile = new BrowserCookieProfile([cookie('initial'), tracking], () => {});
    const a = peer(); const b = peer();
    await profile.connect(a); await profile.connect(b);
    const batches: Array<{ changed: ProfileCookie[]; removed: ProfileCookie[] }> = [];
    const apply = a.apply;
    a.apply = async (changed, removed) => { batches.push({ changed, removed }); await apply(changed, removed); };
    await b.set([cookie('rotated')]); await b.remove(tracking);
    await profile.refresh(b);
    expect(batches).toEqual([{ changed: [cookie('rotated')], removed: [tracking] }]);
    expect([...a.jar.values()]).toEqual([cookie('rotated')]);
  });

  it('never publishes imports when secure persistence fails', async () => {
    const profile = new BrowserCookieProfile([], () => { throw new Error('locked'); });
    const tab = peer(); await profile.connect(tab);
    await expect(profile.importCookies([cookie('secret')])).rejects.toThrow('locked');
    expect(tab.jar.size).toBe(0);
  });

  it('can retry a pending logout after the secure store becomes writable again', async () => {
    let locked = true;
    let saved = [cookie('initial')];
    const profile = new BrowserCookieProfile(saved, (cookies) => { if (locked) throw new Error('locked'); saved = cookies; });
    const tab = peer(); await profile.connect(tab);
    await tab.remove(cookie('initial'));
    await expect(profile.refresh(tab)).rejects.toThrow('locked');
    locked = false;
    await profile.refresh(tab);
    expect(saved).toEqual([]);
  });

  it('rechecks the import authority inside the serialized write', async () => {
    const saved: ProfileCookie[][] = [];
    const profile = new BrowserCookieProfile([], (cookies) => { saved.push(cookies); });
    let authorized = true;
    const pending = profile.importCookies([cookie('private')], () => { if (!authorized) throw new Error('revoked'); });
    authorized = false;
    await expect(pending).rejects.toThrow('revoked');
    expect(saved).toEqual([]);
  });
});
