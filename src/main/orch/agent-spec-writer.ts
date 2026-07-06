import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentSpecPatch {
  name: string;
  tools?: string[];
  skills?: string[];
  model?: string;
  effort?: string;
  category?: string;
  systemPrompt?: string;
}

const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]{1,96}$/;

function targetPath(name: string): string {
  if (!SAFE_NAME_RE.test(name)) throw new Error('invalid agent spec name');
  return path.join(os.homedir(), '.claude', 'agents', `${name}.md`);
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { data: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: raw };
  const block = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const data: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    data[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { data, body };
}

function serialize(data: Record<string, string>, body: string): string {
  const lines = Object.entries(data)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

export function writeAgentSpec(patch: AgentSpecPatch): { ok: boolean; path?: string; error?: string } {
  try {
    const file = targetPath(patch.name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const parsed = parseFrontmatter(current);
    const data = { ...parsed.data };
    if (patch.tools) data.tools = patch.tools.join(', ');
    if (patch.skills) data.skills = patch.skills.join(', ');
    if (patch.model !== undefined) data.model = patch.model;
    if (patch.effort !== undefined) data.effort = patch.effort;
    if (patch.category !== undefined) data.category = patch.category;
    const body =
      patch.systemPrompt ??
      parsed.body ??
      `# ${patch.name}\n\nDescribe this agent's operating contract here.`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serialize(data, body), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
