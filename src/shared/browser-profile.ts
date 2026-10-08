export type BrowserProfileMode = 'personal' | 'isolated';
/** A profile of another browser on this machine; `id` is opaque and only valid while the source still reports it. */
export interface BrowserImportProfile { id: string; name: string; browser: string }
export interface BrowserImportSite { domain: string; cookies: number }
export interface BrowserProfileStatus {
  mode: BrowserProfileMode;
  enabled: boolean;
  shareWithAgents: boolean;
  storedCookies: number | null;
  notice?: string;
}
export interface BrowserProfileChange {
  mode?: BrowserProfileMode;
  shareWithAgents?: boolean;
}
export interface BrowserImportResult {
  importedCookies: number;
  importedSites: number;
  skipped: { partitioned: number; encrypted: number; expired: number; invalid: number };
}
