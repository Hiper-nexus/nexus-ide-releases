import { z } from 'zod';

export interface ProfileCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}
export interface ProfileCookiePeer {
  revision(): number;
  read(): Promise<ProfileCookie[]>;
  clear(): Promise<void>;
  apply(changed: ProfileCookie[], removed: ProfileCookie[]): Promise<void>;
  failed(): void;
}
export function profileCookieKey(cookie: ProfileCookie): string {
  return JSON.stringify([cookie.domain, cookie.path, cookie.name,
    cookie.partitionKey?.topLevelSite ?? null, cookie.partitionKey?.hasCrossSiteAncestor ?? null]);
}

// CDP preserves partition keys; Electron's Cookies converter currently drops
// them. Never round-trip profile cookies through session.cookies.get/set.
export const profileCookieSchema = z.object({
  name: z.string().max(4096),
  value: z.string().max(16384),
  domain: z.string().min(1).max(253).regex(/^\.?[a-z0-9.[\]:-]+$/i),
  path: z.string().startsWith('/').max(4096),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  expires: z.number().finite().optional(),
  partitionKey: z.object({
    topLevelSite: z.string().url().max(2048).refine((value) => /^https?:\/\//.test(value)),
    hasCrossSiteAncestor: z.boolean(),
  }).optional(),
});
export const profileCookiesSchema = z.array(profileCookieSchema).max(10_000);

function cookieMap(cookies: ProfileCookie[]): Map<string, ProfileCookie> {
  return new Map(cookies.map((cookie) => [profileCookieKey(cookie), cookie]));
}

/** One serialized cookie ledger; each pane keeps its own network authority. */
export class BrowserCookieProfile {
  private cookies: Map<string, ProfileCookie>;
  private readonly peers = new Map<ProfileCookiePeer, Map<string, ProfileCookie>>();
  private pending: Promise<void> = Promise.resolve();

  constructor(initial: ProfileCookie[], private readonly save: (cookies: ProfileCookie[]) => void) {
    this.cookies = cookieMap(profileCookiesSchema.parse(initial));
  }

  get size(): number { return this.cookies.size; }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }

  connect(peer: ProfileCookiePeer): Promise<void> {
    return this.enqueue(async () => {
      await this.reconcile();
      // A reopened pane is a replica, never a source of stale login cookies.
      await peer.clear();
      await peer.apply([...this.cookies.values()], []);
      this.peers.set(peer, new Map(this.cookies));
    });
  }

  disconnect(peer: ProfileCookiePeer): void { this.peers.delete(peer); }

  refresh(peer: ProfileCookiePeer): Promise<void> {
    return this.enqueue(async () => {
      if (this.peers.has(peer)) await this.reconcile();
    });
  }

  importCookies(cookies: ProfileCookie[], assertCurrent: () => void = () => {}): Promise<void> {
    const valid = profileCookiesSchema.parse(cookies);
    return this.enqueue(async () => {
      await this.reconcile();
      assertCurrent();
      const next = new Map(this.cookies);
      for (const cookie of valid) next.set(profileCookieKey(cookie), cookie);
      await this.publish(next);
    });
  }

  private async reconcile(): Promise<void> {
    // Observe every pane before writing to any of them. A pending logout
    // wins over an unobserved rotation of the same cookie in this batch.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = new Map(this.cookies);
      const removed = new Set<string>();
      const snapshots = new Map<ProfileCookiePeer, Map<string, ProfileCookie>>();
      const revisions = new Map<ProfileCookiePeer, number>();
      for (const [peer, baseline] of [...this.peers]) {
        try {
          const revision = peer.revision();
          const snapshot = cookieMap(profileCookiesSchema.parse(await peer.read()));
          if (this.peers.get(peer) !== baseline) continue;
          for (const [key, cookie] of snapshot) {
            if (JSON.stringify(cookie) !== JSON.stringify(baseline.get(key))) next.set(key, cookie);
          }
          for (const key of baseline.keys()) if (!snapshot.has(key)) removed.add(key);
          snapshots.set(peer, snapshot);
          revisions.set(peer, revision);
        } catch {
          this.disconnect(peer);
          peer.failed();
        }
      }
      // CDP reads await the browser process. An earlier snapshot may have
      // changed while another pane was being read; never consume that delta.
      if ([...revisions].some(([peer, revision]) => peer.revision() !== revision)) continue;
      for (const key of removed) next.delete(key);
      if (await this.publish(next, snapshots, revisions)) return;
    }
    // Continuous page traffic gets another turn from its cookie event; do
    // not starve the queue or overwrite a snapshot that never settled.
  }

  private async publish(next: Map<string, ProfileCookie>, snapshots = this.peers, revisions?: Map<ProfileCookiePeer, number>): Promise<boolean> {
    if (next.size !== this.cookies.size || [...next].some(([key, cookie]) => JSON.stringify(cookie) !== JSON.stringify(this.cookies.get(key)))) {
      this.save(profileCookiesSchema.parse([...next.values()]));
      this.cookies = next;
    }
    let settled = true;
    for (const [peer, snapshot] of [...snapshots]) {
      if (!this.peers.has(peer)) continue;
      if (revisions && peer.revision() !== revisions.get(peer)) { settled = false; continue; }
      try {
        const removed = [...snapshot].filter(([key]) => !next.has(key)).map(([, cookie]) => cookie);
        const changed = [...next].filter(([key, cookie]) => JSON.stringify(cookie) !== JSON.stringify(snapshot.get(key))).map(([, cookie]) => cookie);
        // A single browser-side cookie batch prevents a local logout from
        // slipping between awaited deletion and upsert commands.
        if (changed.length || removed.length) await peer.apply(changed, removed);
        if (this.peers.has(peer)) this.peers.set(peer, new Map(next));
      } catch {
        this.disconnect(peer);
        peer.failed();
      }
    }
    return settled;
  }
}
