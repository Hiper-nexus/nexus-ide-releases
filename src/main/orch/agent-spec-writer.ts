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

// No path separators, no leading dot, no traversal — the name maps 1:1 to a
// filename inside ~/.claude/agents.
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
// Frontmatter scalar values live on a single line; a comma-list token must not
// smuggle a list separator either.
const SCALAR_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\- ]{0,127}$/;
const LIST_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$/;
const KNOWN_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function assertName(name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes('..')) {
    throw new Error('invalid agent spec name');
  }
  return name;
}

function targetPath(name: string): string {
  return path.join(os.homedir(), '.claude', 'agents', `${assertName(name)}.md`);
}

/** Reject any value that could break out of a single frontmatter line. */
function assertScalar(field: string, value: string): string {
  const trimmed = value.trim();
  if (!SCALAR_RE.test(trimmed)) {
    throw new Error(`invalid ${field} value`);
  }
  return trimmed;
}

function assertList(field: string, values: string[]): string[] {
  return values.map((raw) => {
    const token = raw.trim();
    if (!LIST_TOKEN_RE.test(token)) {
      throw new Error(`invalid ${field} entry: ${raw}`);
    }
    return token;
  });
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
    if (patch.tools) data.tools = assertList('tools', patch.tools).join(', ');
    if (patch.skills) data.skills = assertList('skills', patch.skills).join(', ');
    if (patch.model !== undefined) data.model = assertScalar('model', patch.model);
    if (patch.effort !== undefined) {
      const effort = patch.effort.trim().toLowerCase();
      if (!KNOWN_EFFORTS.has(effort)) throw new Error('invalid effort value');
      data.effort = effort;
    }
    if (patch.category !== undefined) {
      data.category = assertScalar('category', patch.category);
    }
    const body =
      patch.systemPrompt ??
      parsed.body ??
      `# ${patch.name}\n\nDescribe this agent's operating contract here.`;
    const serialized = serialize(data, body);
    // Frontmatter must not have been broken out of by any injected value.
    if (serialized.split('\n---', 2).length < 2) {
      throw new Error('refusing to write malformed frontmatter');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAgentSpecFile(file, serialized);
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function writeAgentSpecFile(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
