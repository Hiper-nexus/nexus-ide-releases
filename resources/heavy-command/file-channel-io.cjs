// Bounded bytes and inode checks only. Authentication/admission belong to Main.
const fs = require('node:fs');
const path = require('node:path');
const MAX = 2048, SLOTS = 16;
const name = (kind, slot) => `${kind}-${String(slot).padStart(2, '0')}.json`;
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
function inspect(fd, file, limit = MAX) {
  const stat = fs.fstatSync(fd), current = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || current.isSymbolicLink() || !same(stat, current) || stat.size > limit) throw new Error('file_identity_invalid');
  return stat;
}
function open(file, flags) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { return { fd, identity: inspect(fd, file) }; } catch (error) { fs.closeSync(fd); throw error; }
}
function read(fd, file) {
  const before = inspect(fd, file), buffer = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < buffer.length) { const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
  const after = inspect(fd, file);
  if (!same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || offset !== buffer.length) throw new Error('file_changed');
  return buffer.toString('utf8');
}
function write(fd, file, raw) {
  const bytes = Buffer.from(raw); if (bytes.length > MAX) throw new Error('file_payload_large');
  inspect(fd, file); fs.ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
  inspect(fd, file);
}
function unlink(file, identity) {
  let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !same(stat, identity)) throw new Error('file_identity_changed');
  fs.unlinkSync(file);
}
function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory);
  if (fs.realpathSync(directory) !== directory || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory_invalid');
  return stat;
}
function checkDirectory(directory, identity) { if (!same(directoryIdentity(directory), identity)) throw new Error('directory_changed'); }
module.exports = { fs, path, MAX, SLOTS, name, same, open, read, write, inspect, unlink, directoryIdentity, checkDirectory };
