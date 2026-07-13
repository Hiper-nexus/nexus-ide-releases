/**
 * Extract provider API keys from OpenCode auth.json (any platform path).
 * Shape varies: string key, or { apiKey|key|token|accessToken }.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OpenCodeKeyEntry {
  providerId: string;
  key: string;
}

function extractKeyFromEntry(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.trim()) return entry.trim();
  if (!entry || typeof entry !== 'object') return null;
  const obj = entry as Record<string, unknown>;
  for (const name of [
    'apiKey',
    'api_key',
    'key',
    'token',
    'accessToken',
    'access_token',
    'auth_token',
  ]) {
    const v = obj[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Nested type:api
  if (obj.type === 'api' || obj.type === 'apikey') {
    for (const name of ['key', 'apiKey', 'token']) {
      const v = obj[name];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

export function parseOpenCodeAuthJson(blob: string): OpenCodeKeyEntry[] {
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const out: OpenCodeKeyEntry[] = [];
    const seen = new Set<string>();
    for (const [providerId, entry] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (providerId === '__proto__' || providerId === 'constructor') continue;
      const key = extractKeyFromEntry(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ providerId, key });
    }
    return out;
  } catch {
    return [];
  }
}

/** Candidate OpenCode auth.json paths (XDG + macOS Application Support). */
export function openCodeAuthPaths(home = os.homedir()): string[] {
  return [
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    path.join(home, 'Library', 'Application Support', 'opencode', 'auth.json'),
    path.join(home, '.config', 'opencode', 'auth.json'),
    path.join(home, '.opencode', 'auth.json'),
  ];
}

export function loadOpenCodeAuthKeys(home = os.homedir()): OpenCodeKeyEntry[] {
  const out: OpenCodeKeyEntry[] = [];
  const seen = new Set<string>();
  for (const p of openCodeAuthPaths(home)) {
    try {
      const blob = fs.readFileSync(p, 'utf8');
      for (const e of parseOpenCodeAuthJson(blob)) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
        out.push(e);
      }
    } catch {
      // missing/unreadable
    }
  }
  return out;
}
