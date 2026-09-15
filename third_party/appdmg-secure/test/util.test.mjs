import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
// appdmg-secure is a macOS packager; its utility module imports the native
// fs-xattr binding, which is intentionally not installed on Linux/Windows.
// Keep the parser contract covered on its owning platform without making the
// cross-platform workspace suite fail during module evaluation.
const util = process.platform === 'darwin' ? require('../lib/util.js') : null;
const originalShell = util?.sh;

afterEach(() => {
  if (util) util.sh = originalShell;
  vi.restoreAllMocks();
});

function readDimensions(filePath) {
  if (!util) throw new Error('appdmg-secure utilities require macOS');
  return new Promise((resolve, reject) => {
    util.imageSize(filePath, (error, dimensions) => {
      if (error) reject(error);
      else resolve(dimensions);
    });
  });
}

describe.runIf(process.platform === 'darwin')('secure appdmg image dimensions', () => {
  it('reads bounded background dimensions through the native macOS parser', async () => {
    util.sh = vi.fn((_program, _args, callback) => {
      callback(null, {
        stdout:
          '/tmp/background.png\n  pixelWidth: 1440\n  pixelHeight: 900\n',
        stderr: '',
      });
    });

    await expect(readDimensions('/tmp/background.png')).resolves.toEqual({
      width: 1440,
      height: 900,
    });
    expect(util.sh).toHaveBeenCalledWith(
      '/usr/bin/sips',
      ['-g', 'pixelWidth', '-g', 'pixelHeight', '/tmp/background.png'],
      expect.any(Function),
    );
  });

  it('rejects malformed native parser output instead of guessing dimensions', async () => {
    util.sh = vi.fn((_program, _args, callback) => {
      callback(null, { stdout: 'pixelWidth: unknown\n', stderr: '' });
    });

    await expect(readDimensions('/tmp/background.png')).rejects.toThrow(
      /dimensions/i,
    );
  });
});
