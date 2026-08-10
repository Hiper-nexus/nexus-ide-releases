import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const util = require('../lib/util.js');
const originalShell = util.sh;

afterEach(() => {
  util.sh = originalShell;
  vi.restoreAllMocks();
});

function readDimensions(filePath) {
  return new Promise((resolve, reject) => {
    util.imageSize(filePath, (error, dimensions) => {
      if (error) reject(error);
      else resolve(dimensions);
    });
  });
}

describe('secure appdmg image dimensions', () => {
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
