export type BrowserProfileMode = 'personal' | 'isolated';
export interface ChromeProfileSummary { id: string; name: string }
export interface ChromeSiteSummary { domain: string; cookies: number }
export interface BrowserProfileStatus {
  mode: BrowserProfileMode;
  enabled: boolean;
  shareWithAgents: boolean;
  storedCookies: number | null;
  importSupported: boolean;
  notice?: string;
}
export interface BrowserProfileChange {
  mode?: BrowserProfileMode;
  shareWithAgents?: boolean;
}
export interface ChromeImportResult {
  importedCookies: number;
  importedSites: number;
  skipped: { partitioned: number; encrypted: number; expired: number; invalid: number };
}
