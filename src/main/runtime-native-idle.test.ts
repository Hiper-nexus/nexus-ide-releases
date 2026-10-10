import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claudeProjectSlug } from './usage/claude-transcript';
import { hasPrivateNativeIdleHistory } from './runtime-native-idle';
const roots: string[] = [];
const marker = '11111111-1111-4111-8111-111111111111', conversationId = '2a825b8f-7024-4dfb-b62b-601c8fdea852';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-native-idle-'))); roots.push(userData);
  const cwd = path.join(userData, 'execution'); await fs.mkdir(cwd);
  const dir = path.join(userData, 'provider-state', 'claude', 'checkout', 'claude', 'projects', claudeProjectSlug(cwd));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${conversationId}.jsonl`), input = { userData, cwd, checkoutId: 'checkout', conversationId, marker };
  const rows = [
    { type: 'user', sessionId: conversationId, cwd, isSidechain: false, uuid: '153836fa-7e92-4523-81c8-135c1b5456c7', parentUuid: null, message: { role: 'user', content: `RT_GATE IDLE ${marker}` } },
    { type: 'assistant', sessionId: conversationId, cwd, isSidechain: false, uuid: 'aa1bb9c4-ea0a-4484-b194-88ae1ba0a45a', parentUuid: '153836fa-7e92-4523-81c8-135c1b5456c7', message: { role: 'assistant', content: [{ type: 'text', text: 'Progress' }] } },
    { type: 'assistant', sessionId: conversationId, cwd, isSidechain: false, uuid: '4b9f62be-df19-4f2e-b965-6c046d1114d2', parentUuid: 'aa1bb9c4-ea0a-4484-b194-88ae1ba0a45a', message: { role: 'assistant', content: [{ type: 'text', text: `RT_DONE_IDLE_${marker}` }] } },
  ];
  const write = (values: unknown[]) => fs.writeFile(file, values.map(value => JSON.stringify(value) + '\n').join(''), { mode: 0o600 });
  await write(rows); return { input, rows, file, dir, write };
}
it('accepts actual ordered native messages with an intermediate progress parent', async () => {
  const f = await fixture(); expect(await hasPrivateNativeIdleHistory(f.input)).toBe(true);
});
it('accepts the actual native assistant-first append shape only through its complete attachment ancestry', async () => {
  const f = await fixture();
  const ids = ['82b078c3-fe3c-4910-a7ca-7167b2295a4c', 'ddf79b9a-aca0-4a36-9983-319b349702b0',
    'a24e8037-2a1e-4e86-bc18-76ffb0122ad3', 'd8fe452e-7779-4c37-8e9a-0de7e7204373',
    '1df7e780-1a5f-4109-a23c-ec406aefb686', 'e450b99a-dc40-4ef9-adac-77e2381260f0',
    '6e634e33-814d-4c1d-8b7f-9045c7828b58', f.rows[1].uuid];
  const attachments = ids.map((uuid, index) => ({ type: 'attachment', uuid, parentUuid: index ? ids[index - 1] : f.rows[0].uuid,
    sessionId: conversationId, cwd: f.input.cwd, isSidechain: false }));
  await f.write([f.rows[2], f.rows[0], ...attachments]);
  expect(await hasPrivateNativeIdleHistory(f.input)).toBe(true);
});
it.each(['missing-parent', 'cyclic-parent', 'conflicting-duplicate', 'foreign-parent', 'sidechain-parent', 'unrelated-response', 'missing-user-uuid', 'missing-response-parent', 'unrelated-user'])(
  'rejects the native %s ancestry instead of pairing arbitrary marker text', async kind => {
    const f = await fixture();
    if (kind === 'missing-parent') f.rows[2].parentUuid = marker;
    if (kind === 'cyclic-parent') f.rows[1].parentUuid = f.rows[2].uuid;
    if (kind === 'conflicting-duplicate') { await f.write([...f.rows, { ...f.rows[2], parentUuid: f.rows[0].uuid }]); }
    else if (kind === 'foreign-parent') { f.rows[1].type = 'attachment'; f.rows[1].sessionId = marker; await f.write(f.rows); }
    else if (kind === 'sidechain-parent') { f.rows[1].isSidechain = true; await f.write(f.rows); }
    else if (kind === 'unrelated-response') { f.rows[2].parentUuid = null; await f.write(f.rows); }
    else if (kind === 'missing-user-uuid') { await f.write([{ ...f.rows[0], uuid: undefined }, ...f.rows.slice(1)]); }
    else if (kind === 'missing-response-parent') { await f.write([...f.rows.slice(0, 2), { ...f.rows[2], parentUuid: undefined }]); }
    else if (kind === 'unrelated-user') { await f.write([{ ...f.rows[0], uuid: marker, message: { role: 'user', content: 'Unrelated open turn' } }, ...f.rows]); }
    else await f.write(f.rows);
    expect(await hasPrivateNativeIdleHistory(f.input)).toBe(false);
  });
it('accepts consistent duplicate assistant stream records without overwriting native identity', async () => {
  const f = await fixture(); await f.write([...f.rows, { ...f.rows[2], message: { role: 'assistant', content: [{ type: 'text', text: 'stream fragment' }] } }]);
  expect(await hasPrivateNativeIdleHistory(f.input)).toBe(true);
});
it.each(['headers', 'missing', 'malformed', 'partial', 'foreign-cid', 'foreign-cwd', 'sidechain', 'unrelated-assistant-first', 'wrong-request', 'wrong-response', 'later-user', 'symlink', 'hardlink', 'oversize', 'invalid-utf8'])(
  'refuses %s without fabricating native readiness', async kind => {
    const f = await fixture();
    if (kind === 'headers') await f.write([{ type: 'mode', sessionId: conversationId }, { type: 'permission-mode', sessionId: conversationId }]);
    if (kind === 'missing') await fs.unlink(f.file);
    if (kind === 'malformed') await fs.appendFile(f.file, '{\n');
    if (kind === 'partial') await fs.appendFile(f.file, '{');
    if (kind === 'foreign-cid') { f.rows[2].sessionId = marker; await f.write(f.rows); }
    if (kind === 'foreign-cwd') { f.rows[2].cwd = '/foreign'; await f.write(f.rows); }
    if (kind === 'sidechain') { f.rows.forEach(row => { row.isSidechain = true; }); await f.write(f.rows); }
    if (kind === 'unrelated-assistant-first') { f.rows[2].parentUuid = null; await f.write([...f.rows.slice(1), f.rows[0]]); }
    if (kind === 'wrong-request') { f.rows[0].message.content = `RT_GATE IDLE ${conversationId}`; await f.write(f.rows); }
    if (kind === 'wrong-response') { (f.rows[2].message.content as Array<{ text: string }>)[0].text = `RT_DONE_IDLE_${conversationId}`; await f.write(f.rows); }
    if (kind === 'later-user') await f.write([...f.rows, { ...f.rows[0], message: { role: 'user', content: 'A different turn is still open' } }]);
    if (kind === 'symlink') { const other = path.join(f.input.userData, 'other.jsonl'); await fs.rename(f.file, other); await fs.symlink(other, f.file); }
    if (kind === 'hardlink') await fs.link(f.file, path.join(f.input.userData, 'linked.jsonl'));
    if (kind === 'oversize') await fs.appendFile(f.file, ' '.repeat(2 * 1024 * 1024));
    if (kind === 'invalid-utf8') await fs.appendFile(f.file, Buffer.from([123,34,116,121,112,101,34,58,34,109,111,100,101,34,44,34,120,34,58,34,255,34,125,10]));
    expect(await hasPrivateNativeIdleHistory(f.input)).toBe(false);
  });
