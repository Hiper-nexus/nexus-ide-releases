/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanePickerStore } from '../state/pane-picker-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useLayoutStore } from '../state/layout-store';
import { useVoiceStore } from '../voice/voice-store';
import { deliverDictationToClaim, resetDictationTargetForTests } from '../voice/dictation-target';
import { requestDictationStart } from '../voice/manual-dictation';
import { BRIEF_FIELD_LIMITS } from './video-brief';
import { VIDEO_STYLE_PRESETS } from './video-style-presets';

vi.mock('../browser/browser-host', () => ({ waitForBrowserPaneCreated: vi.fn(async () => undefined) }));
// O ditado de verdade abriria o microfone; aqui só provamos o caminho.
vi.mock('../voice/manual-dictation', () => ({
  requestDictationStart: vi.fn(),
  requestDictationStop: vi.fn(),
}));
import { VideoProjectsSection } from './VideoProjectsSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let progress: ((event: { jobId: string; pct: number; stage: string | null }) => void) | null = null;
const studio = {
  listProjects: vi.fn(),
  doctor: vi.fn(),
  render: vi.fn(),
  cancel: vi.fn(async () => ({ ok: true })),
  exportVideo: vi.fn(),
  mediaUrl: vi.fn(async (path: string) => ({ ok: true, url: `nexus-media://media/${'a'.repeat(31)}${path.length % 10}` })),
  reveal: vi.fn(async () => ({ ok: true })),
  previewStart: vi.fn(),
  previewStop: vi.fn(async () => ({ ok: true })),
  onProgress: vi.fn((callback) => {
    progress = callback;
    return () => {
      progress = null;
    };
  }),
};
const voiceClone = { list: vi.fn(async () => [] as unknown[]) };
const browser = { load: vi.fn(async () => undefined) };

const PROMO = {
  name: 'promo',
  path: 'videos/promo',
  engine: 'hyperframes',
  renders: [{ path: 'videos/promo/renders/a.mp4', sizeBytes: 3_400_000, modifiedAt: Date.parse('2026-10-19T15:00:00Z') }],
  exports: [],
  hasNarration: true,
  hasMusic: false,
};

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text || item.textContent?.includes(text));
  if (!found) throw new Error(`botão "${text}" ausente: ${host.textContent}`);
  return found;
}

async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}

async function render(onRequestClose = vi.fn()) {
  await act(async () => {
    root.render(<VideoProjectsSection onRequestClose={onRequestClose} />);
  });
  return onRequestClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.listProjects.mockResolvedValue({ ok: true, projects: [PROMO] });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { videoStudio: studio, voiceClone, browser } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'nexus');
  usePanePickerStore.setState({ pendingOpen: false, pendingAccountsAdapterId: null, pendingBrief: null });
  resetDictationTargetForTests();
  useVoiceStore.setState({ info: null, status: 'idle' });
});

describe('Vídeos do projeto', () => {
  it('lista o projeto com o último render e as ações', async () => {
    await render();
    expect(host.textContent).toContain('promo');
    expect(host.textContent).toContain('videos/promo · HyperFrames · com narração');
    expect(host.textContent).toContain('Último render: a.mp4 · 3,2 MB');
    for (const label of ['Renderizar rascunho', 'Renderizar final', 'Exportar', 'Assistir', 'Abrir pasta']) {
      expect(button(label)).toBeTruthy();
    }
  });

  it('renderiza com progresso e cancelamento, depois toca o arquivo pelo nexus-media', async () => {
    let finish!: (value: unknown) => void;
    studio.render.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await render();
    await click('Renderizar final');
    const request = studio.render.mock.calls[0][0] as { jobId: string; quality: string; projectPath: string };
    expect(request).toMatchObject({ projectPath: 'videos/promo', quality: 'final' });
    await act(async () => progress?.({ jobId: request.jobId, pct: 42, stage: 'capture' }));
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(host.textContent).toContain('Renderizando 42%');
    await click('Cancelar');
    expect(studio.cancel).toHaveBeenCalledWith(request.jobId);
    await act(async () => {
      finish({ ok: true, path: 'videos/promo/renders/b.mp4', durationSec: 27, width: 1080, height: 1920, renderMs: 15_000, networkAccess: ['Fetched fonts from Google Fonts'] });
    });
    expect(host.textContent).toContain('Renderizado: 27 s, 1080×1920, em 15 s.');
    expect(host.textContent).toContain('O render buscou coisas na rede');
    const video = host.querySelector('video');
    expect(video?.getAttribute('src')).toMatch(/^nexus-media:\/\/media\//u);
    expect(studio.mediaUrl).toHaveBeenCalledWith('videos/promo/renders/b.mp4');
  });

  it('exporta para a rede escolhida e mostra loudness, rótulo e checklist', async () => {
    studio.exportVideo.mockResolvedValue({
      ok: true,
      files: { video: 'videos/promo/exports/a-vertical-9x16.mp4' },
      loudness: { integratedLufs: -14, truePeakDb: -1, withinTarget: true },
      label: { burned: true, reason: 'narração com voz clonada' },
      aspectMismatch: false,
      publishChecklist: [{ network: 'tiktok', title: 'TikTok', steps: ['Ative "Conteúdo gerado por IA" ao publicar.'] }],
    });
    await render();
    await click('Exportar');
    expect(studio.exportVideo.mock.calls[0][0]).toMatchObject({ inputPath: 'videos/promo/renders/a.mp4', preset: 'vertical-9x16', label: 'auto' });
    expect(host.textContent).toContain('Áudio em -14,0 LUFS');
    expect(host.textContent).toContain('Rótulo de IA: na tela (narração com voz clonada)');
    expect(host.textContent).toContain('Conteúdo gerado por IA');
  });

  it('erro do render aparece com as últimas linhas do log', async () => {
    studio.render.mockResolvedValue({ ok: false, error: 'o HyperFrames terminou com código 1', log: ['Error: lint failed'] });
    await render();
    await click('Renderizar rascunho');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('código 1');
    expect(host.textContent).toContain('Error: lint failed');
  });

  it('Novo vídeo de apresentação vai para Terminais e abre o + Pane com o brief', async () => {
    const openTerminal = vi.spyOn(useProductNavigationStore.getState(), 'openTerminal');
    const close = await render();
    await click('Novo vídeo de apresentação');
    const submit = button('Escolher o agente no + Pane');
    expect(submit.disabled).toBe(true);
    const textarea = host.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(textarea, 'Agendify, agenda online para barbearias');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Escolher o agente no + Pane');
    expect(openTerminal).toHaveBeenCalled();
    expect(usePanePickerStore.getState().pendingOpen).toBe(true);
    expect(usePanePickerStore.getState().pendingBrief).toContain('Produto: Agendify, agenda online para barbearias');
    expect(close).toHaveBeenCalled();
  });

  it('F-1616: sem voz própria, a Narração leva a Serviços de mídia já no cartão Minha voz', async () => {
    const openSettings = vi.spyOn(useProductNavigationStore.getState(), 'openSettings');
    const close = await render();
    await click('Novo vídeo de apresentação');
    expect(host.textContent).toContain('Quer narrar com a sua própria voz?');
    await click('Criar minha voz');
    expect(openSettings).toHaveBeenCalledWith('media');
    expect(close).toHaveBeenCalled();
    const { consumeMyVoiceFocus } = await import('./settings/my-voice-focus');
    expect(consumeMyVoiceFocus()).toBe(true);
    expect(consumeMyVoiceFocus()).toBe(false);
    openSettings.mockRestore();
  });

  it('F-1616: com voz própria, a voz vem escolhida e o atalho vira "Minha voz"', async () => {
    voiceClone.list.mockResolvedValueOnce([{ id: 'r1', voiceName: 'Voz de Ana', provider: 'elevenlabs', voiceId: 'v1', createdAt: 1 }]);
    await render();
    await click('Novo vídeo de apresentação');
    const select = [...host.querySelectorAll('select')].find((node) => node.textContent?.includes('Voz de biblioteca'))!;
    expect(select.value).toBe('mine:r1');
    expect(host.textContent).toContain('Para gravar outra voz ou apagar uma, use Minha voz.');
    expect(host.textContent).not.toContain('Criar minha voz');
  });

  it('Prévia ao vivo abre o Studio num painel do navegador; com prévia aberta, oferece parar (F-1603)', async () => {
    studio.previewStart.mockResolvedValue({ ok: true, id: 'vpreview-1', url: 'http://127.0.0.1:4000/#project/promo', reused: false });
    const addBrowserPane = vi.spyOn(useLayoutStore.getState(), 'addBrowserPane').mockReturnValue('pane-b');
    const openTerminal = vi.spyOn(useProductNavigationStore.getState(), 'openTerminal');
    const close = await render();
    await click('Prévia ao vivo');
    expect(studio.previewStart).toHaveBeenCalledWith('videos/promo');
    expect(openTerminal).toHaveBeenCalled();
    expect(addBrowserPane).toHaveBeenCalledWith('about:blank');
    expect(browser.load).toHaveBeenCalledWith('pane-b', 'http://127.0.0.1:4000/#project/promo');
    expect(close).toHaveBeenCalled();
    addBrowserPane.mockRestore();

    studio.listProjects.mockResolvedValue({ ok: true, projects: [{ ...PROMO, preview: { id: 'vpreview-1', url: 'http://127.0.0.1:4000/' } }] });
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    expect(button('Abrir prévia')).toBeTruthy();
    await click('Parar prévia');
    expect(studio.previewStop).toHaveBeenCalledWith('vpreview-1');
  });

  it('falha da prévia aparece com o log e não abre painel', async () => {
    studio.previewStart.mockResolvedValue({ ok: false, error: 'o Studio do HyperFrames não respondeu a tempo', log: ['porta ocupada'] });
    const addBrowserPane = vi.spyOn(useLayoutStore.getState(), 'addBrowserPane');
    await render();
    await click('Prévia ao vivo');
    expect(host.textContent).toContain('não respondeu a tempo');
    expect(host.textContent).toContain('porta ocupada');
    expect(addBrowserPane).not.toHaveBeenCalled();
    addBrowserPane.mockRestore();
  });

  it('a verificação da máquina mostra o comando que resolve', async () => {
    studio.doctor.mockResolvedValue({
      ok: false,
      engineVersion: '0.8.177',
      checks: [
        { id: 'node', ok: true, detail: 'Node.js v22.23.2' },
        { id: 'ffmpeg', ok: false, detail: 'ffmpeg não encontrado no PATH', fix: 'winget install --id Gyan.FFmpeg -e' },
      ],
    });
    await render();
    await click('Verificar máquina');
    expect(host.textContent).toContain('Falta algo para renderizar');
    expect(host.textContent).toContain('winget install --id Gyan.FFmpeg -e');
    expect(button('Copiar comando')).toBeTruthy();
  });

  it('projeto Remotion explica a licença e não oferece render', async () => {
    studio.listProjects.mockResolvedValue({ ok: true, projects: [{ ...PROMO, name: 'reel', path: 'reel', engine: 'remotion', renders: [] }] });
    await render();
    expect(host.textContent).toContain('o Nexus não renderiza Remotion');
    expect([...host.querySelectorAll('button')].some((item) => item.textContent?.includes('Renderizar'))).toBe(false);
  });

  it('sem projeto aberto e sem projetos de vídeo dizem o que fazer', async () => {
    studio.listProjects.mockResolvedValue({ ok: false, error: 'renderer has no authorized workspace scope' });
    await render();
    expect(host.textContent).toContain('Abra um projeto para ver os vídeos dele.');
    act(() => root.unmount());
    root = createRoot(host);
    studio.listProjects.mockResolvedValue({ ok: true, projects: [] });
    await render();
    expect(host.textContent).toContain('Nenhum projeto de vídeo neste projeto ainda');
  });
});

/** Escreve num campo controlado como o navegador escreveria. */
function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function productField(): HTMLTextAreaElement {
  return host.querySelector('textarea')!;
}

/** O campo pode ser input (Site, Público) ou textarea (Estilo). */
function fieldByLabel(label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label));
  if (!found) throw new Error(`campo "${label}" ausente`);
  const control = found.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (!control) throw new Error(`campo "${label}" sem controle`);
  return control;
}

describe('brief: o texto nunca é cortado calado (21/10/2026)', () => {
  async function openBrief() {
    await render();
    await click('Novo vídeo de apresentação');
  }

  it('um roteiro de 1.800 caracteres entra inteiro e chega inteiro ao agente', async () => {
    await openBrief();
    const roteiro = `Narração do vídeo: ${'a'.repeat(1_800)}`;
    const field = productField();
    // O campo não pode ter maxLength: era ele que cortava a colagem em silêncio.
    expect(field.getAttribute('maxlength')).toBeNull();
    type(field, roteiro);
    expect(field.value).toHaveLength(roteiro.length);
    await click('Escolher o agente no + Pane');
    expect(usePanePickerStore.getState().pendingBrief).toContain(roteiro);
  });

  it('o contador mostra quanto já se escreveu e quanto cabe', async () => {
    await openBrief();
    type(productField(), 'x'.repeat(1_234));
    expect(host.textContent).toContain(`1.234 / ${BRIEF_FIELD_LIMITS.product.toLocaleString('pt-BR')}`);
  });

  it('passar do teto trava o envio, diz o excesso e NÃO apaga nada', async () => {
    await openBrief();
    const excesso = 'y'.repeat(BRIEF_FIELD_LIMITS.product + 12);
    const field = productField();
    type(field, excesso);
    // O texto continua todo lá: quem decide o que tirar é a pessoa.
    expect(field.value).toHaveLength(excesso.length);
    expect(button('Escolher o agente no + Pane').disabled).toBe(true);
    expect(host.textContent).toContain('Passou 12 caracteres do limite');
    expect(host.textContent).toContain('Tire o excesso do campo em vermelho');
    expect(usePanePickerStore.getState().pendingBrief).toBeNull();
    // Tirou o excesso: volta a enviar.
    type(field, 'y'.repeat(BRIEF_FIELD_LIMITS.product));
    expect(button('Escolher o agente no + Pane').disabled).toBe(false);
  });

  it('o teto dos campos opcionais também avisa em vez de cortar', async () => {
    await openBrief();
    type(productField(), 'Agendify');
    const publico = fieldByLabel('Público');
    type(publico, 'p'.repeat(BRIEF_FIELD_LIMITS.audience + 5));
    expect(publico.value).toHaveLength(BRIEF_FIELD_LIMITS.audience + 5);
    expect(button('Escolher o agente no + Pane').disabled).toBe(true);
    expect(host.textContent).toContain('Passou 5 caracteres do limite');
  });

  it('diz o que é obrigatório e o que é opcional', async () => {
    await openBrief();
    expect(host.textContent).toContain('obrigatório');
    expect(host.textContent).toContain('opcional');
  });
});

describe('brief: predefinições de estilo (21/10/2026)', () => {
  it('escolher uma escreve a direção no campo e ela vai no brief', async () => {
    await render();
    await click('Novo vídeo de apresentação');
    type(productField(), 'Agendify, agenda para barbearias');
    const motion = VIDEO_STYLE_PRESETS[0]!;
    await click(motion.label);
    expect(fieldByLabel('Estilo').value).toBe(motion.text);
    await click('Escolher o agente no + Pane');
    expect(usePanePickerStore.getState().pendingBrief).toContain(motion.text);
  });

  it('a predefinição é ponto de partida: dá para editar por cima', async () => {
    await render();
    await click('Novo vídeo de apresentação');
    type(productField(), 'Agendify');
    const preset = VIDEO_STYLE_PRESETS[1]!;
    await click(preset.label);
    const estilo = fieldByLabel('Estilo');
    type(estilo, `${preset.text} e com o logo no canto`);
    // Editado deixa de estar marcado, e o texto editado é o que viaja.
    expect(button(preset.label).getAttribute('aria-pressed')).toBe('false');
    await click('Escolher o agente no + Pane');
    expect(usePanePickerStore.getState().pendingBrief).toContain('e com o logo no canto');
  });

  it('clicar de novo na mesma predefinição limpa o campo', async () => {
    await render();
    await click('Novo vídeo de apresentação');
    const preset = VIDEO_STYLE_PRESETS[2]!;
    await click(preset.label);
    expect(fieldByLabel('Estilo').value).toBe(preset.text);
    await click(preset.label);
    expect(fieldByLabel('Estilo').value).toBe('');
  });
});

describe('brief: ditar e escrever o pedido (pedido do operador, 21/10/2026)', () => {
  it('sem microfone disponível o botão de ditar nem aparece', async () => {
    await render();
    await click('Novo vídeo de apresentação');
    expect(host.textContent).not.toContain('Ditar');
  });

  it('a fala entra no campo sem apagar o que já estava escrito', async () => {
    useVoiceStore.setState({ info: { captureAllowed: true } as never, status: 'idle' });
    await render();
    await click('Novo vídeo de apresentação');
    type(productField(), 'Agendify.');
    await click('Ditar');
    expect(requestDictationStart).toHaveBeenCalled();
    await act(async () => {
      // O claim é deste campo: a fala não pode cair num pane escondido.
      expect(deliverDictationToClaim('Agenda online para barbearias.')).toEqual({
        paneId: 'ui:video-brief-product',
      });
    });
    expect(productField().value).toBe('Agendify. Agenda online para barbearias.');
  });

  it('"Escrever meu pedido" troca o texto pelo reescrito', async () => {
    const writePrompt = vi.fn(async () => ({ text: 'Agendify é uma agenda online para barbearias.', written: true }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { videoStudio: studio, voiceClone, browser, media: { writePrompt } },
    });
    await render();
    await click('Novo vídeo de apresentação');
    type(productField(), 'agendify ai é tipo uma agenda sabe pra barbearia');
    await click('Escrever meu pedido');
    expect(writePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'product', text: 'agendify ai é tipo uma agenda sabe pra barbearia' }),
    );
    expect(productField().value).toBe('Agendify é uma agenda online para barbearias.');
    expect(host.textContent).toContain('nada foi enviado ainda');
  });

  it('falhar ao reescrever mantém o texto da pessoa e diz isso', async () => {
    const writePrompt = vi.fn(async () => ({ text: 'o original', written: false, reason: 'no key' }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { videoStudio: studio, voiceClone, browser, media: { writePrompt } },
    });
    await render();
    await click('Novo vídeo de apresentação');
    type(productField(), 'o original');
    await click('Escrever meu pedido');
    expect(productField().value).toBe('o original');
    expect(host.textContent).toContain('o seu texto está como estava');
  });
});
