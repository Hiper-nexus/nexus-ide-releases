import { describe, expect, it } from 'vitest';
import { missionProjectContextPathSchema } from '../../shared/mission-intent';
import {
  buildMissionAttachmentsContext,
  classifyMissionAttachment,
  filesFromClipboardData,
  inferImageMimeTypeFromName,
  isMissionContextAttachmentPath,
  missionAttachmentContentKey,
  namePastedMissionFile,
  normalizeMissionImageFileMimeType,
  validateMissionAttachment,
  type MissionAttachment,
} from './mission-attachments';

function file(name: string, type: string, size = 1000) {
  return { name, type, size };
}

function realFile(name: string, type: string, body = 'png-bytes'): File {
  return new File([body], name, { type });
}

const attachment: MissionAttachment = {
  id: 'one',
  name: 'erro.png',
  kind: 'image',
  mime: 'image/png',
  size: 1000,
  path: '/Users/test/.nexus/dropped/erro.png',
};

describe('mission attachments', () => {
  it('classifies screenshots, audio, and code/text files by mime or extension', () => {
    expect(classifyMissionAttachment(file('erro.png', ''))).toBe('image');
    expect(classifyMissionAttachment(file('falha.m4a', ''))).toBe('audio');
    expect(classifyMissionAttachment(file('notes.txt', 'text/plain'))).toBe('file');
    expect(classifyMissionAttachment(file('app.ts', ''))).toBe('file');
    expect(classifyMissionAttachment(file('binario.exe', 'application/x-msdownload'))).toBeNull();
  });

  it('áudio de WhatsApp/Telegram (.opus, MIME vazio do paste do Finder) é áudio', () => {
    // Screenshot 2026-08-18: colar "WhatsApp Audio ....opus" num pane não
    // colava NADA — o classificador recusava .opus com MIME ausente e o
    // paste morria em silêncio ("não cola e não mostra").
    expect(
      classifyMissionAttachment(
        file('WhatsApp Audio 2026-08-17 at 17.18.49 (1).opus', ''),
      ),
    ).toBe('audio');
    expect(classifyMissionAttachment(file('telegram.voice.ogg', ''))).toBe(
      'audio',
    );
    expect(classifyMissionAttachment(file('nota.oga', ''))).toBe('audio');
    expect(classifyMissionAttachment(file('entrevista.aiff', ''))).toBe(
      'audio',
    );
  });

  it('HEIC/HEIF do Finder com MIME vazio ou genérico são imagem', () => {
    // `.heif` com MIME vazio era recusado ("Use uma imagem…") e o paste
    // descartava a foto em silêncio.
    expect(classifyMissionAttachment(file('retrato.heif', ''))).toBe('image');
    expect(classifyMissionAttachment(file('IMG_0001.HEIC', ''))).toBe('image');
    expect(
      classifyMissionAttachment(file('IMG_0001.heic', 'application/octet-stream')),
    ).toBe('image');
    expect(
      filesFromClipboardData({ files: [realFile('retrato.heif', '', 'heif-bytes')] }),
    ).toHaveLength(1);
  });

  it('normaliza o MIME de imagem só quando ele falta ou é genérico', () => {
    const heif = normalizeMissionImageFileMimeType(realFile('retrato.HEIF', ''));
    expect(heif.type).toBe('image/heif');
    expect(heif.name).toBe('retrato.HEIF');
    expect(
      normalizeMissionImageFileMimeType(realFile('a.heic', 'application/octet-stream')).type,
    ).toBe('image/heic');
    expect(normalizeMissionImageFileMimeType(realFile('a.jpg', '')).type).toBe('image/jpeg');
    const typed = realFile('a.png', 'image/webp');
    expect(normalizeMissionImageFileMimeType(typed)).toBe(typed);
    const unknown = realFile('notas.txt', '');
    expect(normalizeMissionImageFileMimeType(unknown)).toBe(unknown);
    expect(inferImageMimeTypeFromName('.heic')).toBeNull();
  });

  it('rejects unsupported, oversized, and empty files', () => {
    expect(validateMissionAttachment(file('binario.exe', 'application/x-msdownload'), [])).toMatch(/imagem/);
    expect(validateMissionAttachment(file('erro.png', 'image/png', 0), [])).toMatch(/vazio/);
    expect(validateMissionAttachment(file('erro.png', 'image/png', 15 * 1024 * 1024), [])).toMatch(/14 MB/);
  });

  it('PDF e documentos de escritório são documento (drop real 19/08)', () => {
    // Voo real: "Cópia de [Versão limpa] Contrato Parceria BaaS Asaas.pdf"
    // arrastado no wizard e no pane morria em silêncio — PDF não era imagem,
    // áudio nem texto e o classificador devolvia null em todo caminho.
    expect(
      classifyMissionAttachment(
        file('Cópia de [Versão limpa] Contrato Parceria BaaS Asaas.pdf', ''),
      ),
    ).toBe('document');
    expect(
      classifyMissionAttachment(file('contrato.pdf', 'application/pdf')),
    ).toBe('document');
    expect(classifyMissionAttachment(file('proposta.docx', ''))).toBe('document');
    expect(classifyMissionAttachment(file('planilha.xlsx', ''))).toBe('document');
    expect(classifyMissionAttachment(file('slides.pptx', ''))).toBe('document');
    expect(validateMissionAttachment(file('contrato.pdf', '', 1000), [])).toBeNull();
  });

  it('drop de PDF entra pelo clipboard/dataTransfer', () => {
    const files = filesFromClipboardData({
      files: [realFile('contrato.pdf', 'application/pdf', 'pdf-bytes')],
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('contrato.pdf');
  });

  it('context block rotula documento como documento', () => {
    const doc: MissionAttachment = {
      ...attachment,
      name: 'contrato.pdf',
      kind: 'document',
      mime: 'application/pdf',
      path: '.nexus/attachments/mission-context/x-contrato.pdf',
    };
    expect(buildMissionAttachmentsContext([doc])).toContain('documento:');
  });

  it('builds a bounded context block for the mission agents', () => {
    expect(buildMissionAttachmentsContext([attachment])).toContain('erro.png');
    expect(buildMissionAttachmentsContext([])).toBe('');
  });

  it('recognizes imported mission-context paths', () => {
    expect(
      isMissionContextAttachmentPath(
        '.nexus/attachments/mission-context/token-cliente.m4a',
      ),
    ).toBe(true);
    expect(isMissionContextAttachmentPath('src/App.tsx')).toBe(false);
    expect(
      missionProjectContextPathSchema.safeParse(
        '.nexus/attachments/mission-context/token-cliente.m4a',
      ).success,
    ).toBe(true);
  });

  it('extracts screenshot pastes and ignores text-only clipboard', () => {
    const shot = realFile('image.png', 'image/png');
    const files = filesFromClipboardData({
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => shot,
        },
        {
          kind: 'string',
          type: 'text/plain',
          getAsFile: () => null,
        },
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/^print-.*\.png$/);
    expect(filesFromClipboardData({ items: [] })).toEqual([]);
    expect(
      filesFromClipboardData({
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      }),
    ).toEqual([]);
  });

  it('conta UMA vez a imagem que o clipboard expõe em items E em files', () => {
    // Chromium entrega o mesmo print pelos dois acessores, e cada chamada
    // sintetiza um File novo — com `lastModified` do instante da chamada.
    // Quando as duas caem em milissegundos diferentes, uma chave que inclui
    // `lastModified` deixa de casar e o mesmo print é anexado duas vezes
    // (campo 09/09: dois `print-...T12-36-22.png` na mesma colagem).
    const fromItems = new File(['png-bytes'], 'image.png', {
      type: 'image/png',
      lastModified: 1_757_419_000_000,
    });
    const fromFiles = new File(['png-bytes'], 'image.png', {
      type: 'image/png',
      lastModified: 1_757_419_000_001,
    });

    const files = filesFromClipboardData({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => fromItems }],
      files: [fromFiles],
    });

    expect(files).toHaveLength(1);
  });

  it('ainda separa arquivos distintos que chegam juntos na mesma colagem', () => {
    const files = filesFromClipboardData({
      files: [
        realFile('erro.png', 'image/png', 'a'),
        realFile('log.png', 'image/png', 'bb'),
      ],
    });
    expect(files.map((entry) => entry.name)).toEqual(['erro.png', 'log.png']);
  });

  it('renames generic clipboard dumps but keeps real filenames', () => {
    const generic = namePastedMissionFile(realFile('image.png', 'image/png'), 'image');
    expect(generic.name).toMatch(/^print-.*\.png$/);
    const blank = namePastedMissionFile(realFile('', 'image/png'), 'image');
    expect(blank.name).toMatch(/^print-.*\.png$/);
    const kept = namePastedMissionFile(realFile('stack-trace.png', 'image/png'), 'image');
    expect(kept.name).toBe('stack-trace.png');
  });

  it('content key is stable across renamed clipboard dumps of the same bytes', async () => {
    const first = realFile('a.png', 'image/png', 'same-png-bytes');
    const second = realFile('b.png', 'image/png', 'same-png-bytes');
    expect(await missionAttachmentContentKey(first)).toBe(
      await missionAttachmentContentKey(second),
    );
    expect(
      await missionAttachmentContentKey(realFile('other.png', 'image/png', 'other')),
    ).not.toBe(await missionAttachmentContentKey(first));
  });

  it('dedupes the same clipboard file exposed via items and files', () => {
    const shot = realFile('image.png', 'image/png');
    const files = filesFromClipboardData({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => shot }],
      files: [shot],
    });
    expect(files).toHaveLength(1);
  });

  it('collects Finder audio drops from the files list even when items also exist', () => {
    const audio = realFile('cliente.m4a', 'audio/mp4', 'm4a-bytes');
    const files = filesFromClipboardData({
      items: [
        {
          kind: 'file',
          type: 'audio/mp4',
          getAsFile: () => null,
        },
      ],
      files: [audio],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('cliente.m4a');
  });
});

describe('filesFromClipboardData — anyKind (pane F-582)', () => {
  it('anyKind aceita vídeo como kind file preservando o nome real', () => {
    const files = filesFromClipboardData(
      { files: [realFile('filme.mp4', 'video/mp4')] },
      { anyKind: true },
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('filme.mp4');
  });

  it('anyKind renomeia blob genérico de vídeo para anexo-<stamp>.mp4', () => {
    const files = filesFromClipboardData(
      { files: [realFile('blob', 'video/mp4')] },
      { anyKind: true },
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toMatch(/^anexo-.*\.mp4$/);
  });

  it('sem anyKind o vídeo continua descartado (wizard/App)', () => {
    expect(
      filesFromClipboardData({ files: [realFile('filme.mp4', 'video/mp4')] }),
    ).toEqual([]);
  });
});
