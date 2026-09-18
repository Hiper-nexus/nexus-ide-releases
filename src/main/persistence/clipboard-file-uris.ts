import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * F-582: arquivos copiados no Finder/Explorer vivem no pasteboard do sistema
 * como referências de arquivo que o Chromium nem sempre expõe ao evento de
 * paste do renderer (macOS `public.file-url`; Windows `FileNameW`, UTF-16LE).
 * O Main lê SOMENTE os endereços — nunca conteúdo — e devolve `file://` URIs
 * para o fluxo normal de `importDroppedUri`. Qualquer leitura quebrada ou
 * vazia vira `[]`; nunca logamos caminhos do usuário.
 */
export function readClipboardFileUris(
  deps: {
    platform?: NodeJS.Platform;
    read?: (format: string) => string;
    readBuffer?: (format: string) => Buffer;
    availableFormats?: () => string[];
  } = {},
): string[] {
  try {
    const platform = deps.platform ?? process.platform;
    // require lazily: a função pura aceita deps injetadas nos testes sem
    // carregar o módulo 'electron'.
    const clipboard = () =>
      (require('electron') as typeof import('electron')).clipboard;
    const read = deps.read ?? ((format: string) => clipboard().read(format));
    const readBuffer =
      deps.readBuffer ?? ((format: string) => clipboard().readBuffer(format));
    const availableFormats =
      deps.availableFormats ?? (() => clipboard().availableFormats());

    const uris: string[] = [];
    const pushFileUri = (uri: string): void => {
      const trimmed = uri.trim();
      if (/^file:/i.test(trimmed)) uris.push(trimmed);
    };
    const isAbsolute =
      platform === 'win32' ? path.win32.isAbsolute : path.isAbsolute;
    const pushAbsolutePath = (candidate: string): void => {
      if (!isAbsolute(candidate)) return;
      if (platform === 'win32') {
        // URI montada à mão, independente do host: pathToFileURL resolveria
        // '/C:/…' contra o drive atual num Windows real.
        uris.push(
          `file:///${encodeURI(candidate.replace(/\\/g, '/')).replace(
            /[?#]/g,
            (c) => encodeURIComponent(c),
          )}`,
        );
        return;
      }
      uris.push(pathToFileURL(candidate).href);
    };

    if (platform === 'darwin') {
      if (!availableFormats().includes('public.file-url')) return [];
      pushFileUri(read('public.file-url'));
      return uris;
    }
    if (platform === 'win32') {
      const raw = readBuffer('FileNameW');
      if (raw.length === 0) return [];
      const first = (
        raw.toString('utf16le').split(String.fromCharCode(0))[0] ?? ''
      ).trim();
      pushAbsolutePath(first);
      return uris;
    }
    // Linux e demais: melhor esforço via text/uri-list.
    for (const line of read('text/uri-list').split(/\r?\n/)) {
      if (line.startsWith('file://')) uris.push(line.trim());
    }
    return uris;
  } catch {
    return [];
  }
}
