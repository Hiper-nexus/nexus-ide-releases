import { describe, expect, it } from 'vitest';
import { readClipboardFileUris } from './clipboard-file-uris';

describe('readClipboardFileUris (F-582)', () => {
  it('darwin: returns the file:// from public.file-url', () => {
    expect(
      readClipboardFileUris({
        platform: 'darwin',
        availableFormats: () => ['public.file-url', 'NSStringPboardType'],
        read: (format) =>
          format === 'public.file-url' ? ' file:///Users/ana/foto.jpg ' : '',
      }),
    ).toEqual(['file:///Users/ana/foto.jpg']);
  });

  it('darwin: empty when the format is not on the pasteboard', () => {
    expect(
      readClipboardFileUris({
        platform: 'darwin',
        availableFormats: () => ['NSStringPboardType'],
        read: () => 'file:///Users/ana/foto.jpg',
      }),
    ).toEqual([]);
  });

  it('darwin: drops non-file payloads from public.file-url', () => {
    expect(
      readClipboardFileUris({
        platform: 'darwin',
        availableFormats: () => ['public.file-url'],
        read: () => 'https://example.com/not-a-file',
      }),
    ).toEqual([]);
  });

  it('win32: decodes a UTF-16LE FileNameW path into a file:// URI', () => {
    const path = 'C:\\Users\\ana\\video.mp4';
    const buffer = Buffer.concat([
      Buffer.from(path, 'utf16le'),
      Buffer.from('\0resto', 'utf16le'),
    ]);
    expect(
      readClipboardFileUris({
        platform: 'win32',
        readBuffer: () => buffer,
      }),
    ).toEqual(['file:///C:/Users/ana/video.mp4']);
  });

  it('win32: escapes spaces and # in the file:// URI (host-independent)', () => {
    const path = 'C:\\Users\\ana\\a b#1.mp4';
    expect(
      readClipboardFileUris({
        platform: 'win32',
        readBuffer: () => Buffer.from(path, 'utf16le'),
      }),
    ).toEqual(['file:///C:/Users/ana/a%20b%231.mp4']);
  });

  it('win32: empty buffer and non-absolute path return nothing', () => {
    expect(
      readClipboardFileUris({ platform: 'win32', readBuffer: () => Buffer.alloc(0) }),
    ).toEqual([]);
    expect(
      readClipboardFileUris({
        platform: 'win32',
        readBuffer: () => Buffer.from('relativo.txt', 'utf16le'),
      }),
    ).toEqual([]);
  });

  it('linux: keeps file:// lines from text/uri-list, ignores the rest', () => {
    expect(
      readClipboardFileUris({
        platform: 'linux',
        read: (format) =>
          format === 'text/uri-list'
            ? '# comentário\nfile:///home/ana/a.png\nhttps://x.com/b\nfile:///home/ana/c.pdf\n'
            : '',
      }),
    ).toEqual(['file:///home/ana/a.png', 'file:///home/ana/c.pdf']);
  });

  it('any platform: a throwing clipboard never propagates', () => {
    expect(
      readClipboardFileUris({
        platform: 'darwin',
        availableFormats: () => {
          throw new Error('pasteboard morto');
        },
      }),
    ).toEqual([]);
  });
});
