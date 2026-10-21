import { useCallback, useEffect, useRef, useState } from 'react';
import {
  VIDEO_EXPORT_PRESETS,
  VIDEO_EXPORT_PRESET_IDS,
  type PublishChecklistItem,
  type VideoExportPresetId,
} from '../../shared/video-export-presets';
import type {
  VideoDoctorView,
  VideoFileInfo,
  VideoProjectInfo,
} from '../../shared/video-studio-types';
import type { VoiceCloneReceiptView } from '../../shared/voice-clone-types';
import { usePanePickerStore } from '../state/pane-picker-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useLayoutStore } from '../state/layout-store';
import { reportLicenseDenial } from '../state/access-guard';
import { waitForBrowserPaneCreated } from '../browser/browser-host';
import {
  BRIEF_FIELD_LIMITS,
  briefFieldOverflow,
  buildPresentationBrief,
  type BriefAttachment,
  type BriefFieldName,
  type BriefVoice,
} from './video-brief';
import {
  VIDEO_STYLE_PRESETS,
  matchVideoStylePreset,
  toggleVideoStylePreset,
} from './video-style-presets';
import { CharacterBudget } from './CharacterBudget';
import { useObjectiveDictation } from './mission/use-objective-dictation';
import { BriefAttachments } from './BriefAttachments';
import { NarrationRecorder } from './NarrationRecorder';
import { requestMyVoiceFocus } from './settings/my-voice-focus';

/**
 * Estúdio de Mídia → "Vídeos do projeto" (F-1596). The person sees the
 * HyperFrames projects of the open workspace, renders (draft or final),
 * exports per network, watches the result (streamed with Range, no size cap)
 * and starts a new presentation video: a short brief that opens the "+ Pane"
 * and becomes the agent's first prompt. Creation stays with the agent in the
 * pane (DESIGN.md §13); no timeline editor (GSAP license, study §1.3).
 */

type JobState = { readonly kind: 'render' | 'export'; readonly jobId: string; readonly pct: number | null; readonly stage: string | null };
type Notice = { readonly tone: 'ok' | 'danger'; readonly text: string; readonly detail?: readonly string[] };

function newJobId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fileName(file: VideoFileInfo): string {
  return file.path.split('/').pop() ?? file.path;
}

/**
 * Campo de texto com teto à vista. O teto NÃO vira `maxLength`: o navegador
 * cortaria o texto colado em silêncio (defeito de 21/10/2026, um roteiro de
 * 1.800 caracteres virou 1.500 sem aviso). O campo aceita tudo, o contador
 * mostra onde está e o envio trava com o excesso escrito por extenso.
 */
function BriefField({
  field,
  label,
  value,
  onChange,
  required,
  children,
  multiline,
  rows,
  placeholder,
  inputRef,
}: {
  field: BriefFieldName;
  label: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  children?: React.ReactNode;
  multiline?: boolean;
  rows?: number;
  placeholder: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const limit = BRIEF_FIELD_LIMITS[field];
  const over = briefFieldOverflow(value, field) > 0;
  const budgetId = `vp-budget-${field}`;
  const shared = {
    value,
    placeholder,
    'aria-describedby': budgetId,
    ...(over ? { 'aria-invalid': true as const } : {}),
  };
  return (
    <label className={multiline ? 'vp-field vp-field--wide' : 'vp-field'}>
      <span className="vp-field__label">
        {label}
        <span className={required ? 'vp-field__tag vp-field__tag--required' : 'vp-field__tag'}>
          {required ? 'obrigatório' : 'opcional'}
        </span>
      </span>
      {multiline ? (
        <textarea
          {...shared}
          ref={inputRef}
          className={over ? 'ms-prompt ms-prompt--over' : 'ms-prompt'}
          rows={rows ?? 6}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          {...shared}
          className={over ? 'settings-input settings-input--over' : 'settings-input'}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {/* O contador fica COLADO no campo: com a borda vermelha ao lado, o
          número e o excesso se leem como uma coisa só. */}
      <CharacterBudget value={value} limit={limit} id={budgetId} label={label} />
      {children}
    </label>
  );
}

function BriefForm({
  onClose,
  onSent,
  onOpenMyVoice,
}: {
  onClose: () => void;
  onSent: () => void;
  onOpenMyVoice: () => void;
}) {
  const [product, setProduct] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [audience, setAudience] = useState('');
  const [style, setStyle] = useState('');
  const [durationSec, setDurationSec] = useState(45);
  const [preset, setPreset] = useState<VideoExportPresetId>('vertical-9x16');
  const [voiceChoice, setVoiceChoice] = useState('library');
  const [music, setMusic] = useState(true);
  const [voices, setVoices] = useState<VoiceCloneReceiptView[]>([]);
  const [attachments, setAttachments] = useState<BriefAttachment[]>([]);
  const [writing, setWriting] = useState(false);
  const [writeNote, setWriteNote] = useState<string | null>(null);
  const productRef = useRef<HTMLTextAreaElement | null>(null);
  // Ver MediaStudioPanel: a reescrita demora e o campo segue editável; a
  // resposta do texto antigo não pode apagar o que foi escrito depois.
  const liveProductRef = useRef(product);
  liveProductRef.current = product;

  useEffect(() => {
    let alive = true;
    void window.nexus.voiceClone
      ?.list()
      .then((list) => {
        if (!alive) return;
        setVoices(list);
        if (list[0]) setVoiceChoice(`mine:${list[0].id}`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Ditado do pedido (pedido do operador, 21/10): a fala APENSA ao que já
  // está escrito, nunca substitui. O claim é próprio deste campo.
  const dictation = useObjectiveDictation({
    enabled: true,
    claimId: 'video-brief-product',
    onTranscript: (text) => {
      setProduct((current) => (current.trim() ? `${current.replace(/\s+$/u, '')} ${text}` : text));
      setWriteNote(null);
      productRef.current?.focus();
    },
  });

  /**
   * "Escrever meu pedido": uma LLM barata organiza o que foi digitado ou
   * ditado. Fail-open — qualquer falha mantém o texto da pessoa e o aviso
   * diz isso; ninguém perde o que escreveu.
   */
  async function writePrompt() {
    const source = product.trim();
    if (!source || writing) return;
    setWriting(true);
    setWriteNote(null);
    try {
      const result = await window.nexus.media?.writePrompt({
        text: source,
        task: 'product',
        durationSec,
      });
      if (result?.written) {
        if (liveProductRef.current.trim() !== source) {
          setWriteNote('Você mexeu no texto enquanto eu escrevia, então mantive o seu.');
          return;
        }
        setProduct(result.text);
        setWriteNote('Reescrito. Leia e ajuste o que não ficou do seu jeito — nada foi enviado ainda.');
      } else {
        setWriteNote('Não consegui reescrever agora; o seu texto está como estava.');
      }
    } catch {
      setWriteNote('Não consegui reescrever agora; o seu texto está como estava.');
    } finally {
      setWriting(false);
    }
  }

  function voice(): BriefVoice {
    if (voiceChoice === 'none') return { kind: 'none' };
    const mine = voices.find((receipt) => `mine:${receipt.id}` === voiceChoice);
    return mine ? { kind: 'mine', voiceId: mine.voiceId, name: mine.voiceName } : { kind: 'library' };
  }

  function send() {
    const brief = buildPresentationBrief({ product, siteUrl, audience, style, durationSec, preset, voice: voice(), music, attachments });
    useProductNavigationStore.getState().openTerminal();
    usePanePickerStore.getState().requestOpen(undefined, { brief });
    onSent();
  }

  // Nenhum campo pode estar acima do teto: o brief sai inteiro ou não sai.
  const overflowing: readonly BriefFieldName[] = (
    [
      ['product', product],
      ['siteUrl', siteUrl],
      ['audience', audience],
      ['style', style],
    ] as const
  )
    .filter(([field, value]) => briefFieldOverflow(value, field) > 0)
    .map(([field]) => field);
  const tooShort = product.trim().length < 3;
  const blocked = tooShort || overflowing.length > 0;
  const activePreset = matchVideoStylePreset(style);

  return (
    <form
      className="vp-brief"
      aria-label="Novo vídeo de apresentação"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) send();
      }}
    >
      <p className="vp-brief__lead">
        Conte o que o produto faz e anexe o que quiser no vídeo: logo, mascote, prints do sistema e um vídeo de exemplo do
        estilo. Você escolhe o agente no &quot;+ Pane&quot; e ele recebe este pedido; antes de gastar, ele mostra o roteiro
        e o custo.
      </p>

      <BriefField
        field="product"
        label="Produto e o que ele resolve"
        value={product}
        onChange={(next) => {
          setProduct(next);
          setWriteNote(null);
        }}
        required
        multiline
        inputRef={productRef}
        placeholder="Ex.: Agendify, agenda online para barbearias: o cliente marca pelo celular e a barbearia para de perder horário."
      >
        <div className="vp-tools">
          {dictation.available && (
            <button
              type="button"
              className={dictation.state === 'listening' ? 'ms-button ms-button--sm ms-button--on' : 'ms-button ms-button--sm'}
              aria-pressed={dictation.state === 'listening'}
              onClick={dictation.toggle}
            >
              {dictation.state === 'listening' ? 'Ouvindo… toque para parar' : dictation.state === 'busy' ? 'Transcrevendo…' : 'Ditar'}
            </button>
          )}
          <button
            type="button"
            className="ms-button ms-button--sm"
            disabled={writing || product.trim().length < 3}
            onClick={() => void writePrompt()}
          >
            {writing ? 'Escrevendo…' : 'Escrever meu pedido'}
          </button>
          <span className="vp-tools__hint">
            Fale ou escreva do seu jeito; &quot;Escrever meu pedido&quot; organiza o texto sem inventar nada.
          </span>
        </div>
        {writeNote && (
          <p className="vp-tools__note" role="status">
            {writeNote}
          </p>
        )}
      </BriefField>

      <BriefAttachments attachments={attachments} onChange={setAttachments} />

      <BriefField
        field="siteUrl"
        label="Site do produto"
        value={siteUrl}
        onChange={setSiteUrl}
        placeholder="agendify.com.br"
      />
      <BriefField
        field="audience"
        label="Público"
        value={audience}
        onChange={setAudience}
        placeholder="donos de barbearia"
      />

      <div className="vp-field vp-field--wide">
        <BriefField
          field="style"
          label="Estilo"
          value={style}
          onChange={setStyle}
          multiline
          rows={3}
          placeholder="escuro, enérgico, cores do site — ou escolha um começo abaixo"
        />
        {/* Predefinições (pedido do operador, 21/10): quem não sabe descrever
            estilo escolhe um ponto de partida e edita o texto depois. */}
        <div className="ms-chips vp-styles" role="group" aria-label="Predefinições de estilo">
          {VIDEO_STYLE_PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activePreset === item.id ? 'ms-chip ms-chip--on' : 'ms-chip'}
              aria-pressed={activePreset === item.id}
              title={item.hint}
              onClick={() => setStyle((current) => toggleVideoStylePreset(current, item.id))}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <label className="vp-field">
        <span className="vp-field__label">Duração</span>
        <select className="ms-select" value={durationSec} onChange={(event) => setDurationSec(Number(event.target.value))}>
          {[30, 45, 60, 90].map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds} s
            </option>
          ))}
        </select>
      </label>
      <label className="vp-field">
        <span className="vp-field__label">Formato</span>
        <select className="ms-select" value={preset} onChange={(event) => setPreset(event.target.value as VideoExportPresetId)}>
          {VIDEO_EXPORT_PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {VIDEO_EXPORT_PRESETS[id].label}
            </option>
          ))}
        </select>
      </label>
      <label className="vp-field">
        <span className="vp-field__label">Narração</span>
        <select className="ms-select" value={voiceChoice} onChange={(event) => setVoiceChoice(event.target.value)}>
          {voices.map((receipt) => (
            <option key={receipt.id} value={`mine:${receipt.id}`}>
              Minha voz: {receipt.voiceName}
            </option>
          ))}
          <option value="library">Voz de biblioteca (o agente pergunta qual)</option>
          <option value="none">Sem narração</option>
        </select>
      </label>
      {/* F-1616: a voz própria é criada em Serviços de mídia; daqui se chega lá direto. */}
      <p className="settings-detail__hint vp-field--wide">
        {voices.length === 0 ? 'Quer narrar com a sua própria voz? ' : 'Para gravar outra voz ou apagar uma, use '}
        <button type="button" className="settings-link vp-voice-link" onClick={onOpenMyVoice}>
          {voices.length === 0 ? 'Criar minha voz' : 'Minha voz'}
        </button>
        {voices.length === 0 ? ' (grava e clona com consentimento, na ElevenLabs ou no Gemini).' : '.'}
      </p>
      <label className="vp-music-check vp-field--wide">
        <input type="checkbox" checked={music} onChange={(event) => setMusic(event.target.checked)} />
        <span>Música instrumental de fundo</span>
      </label>
      <div className="settings-row vp-field--wide">
        <button type="submit" className="ms-button ms-button--primary" disabled={blocked}>
          Escolher o agente no + Pane
        </button>
        <button type="button" className="ms-button" onClick={onClose}>
          Cancelar
        </button>
        {overflowing.length > 0 && (
          <span className="vp-brief__blocked" role="alert">
            Tire o excesso do campo em vermelho para enviar.
          </span>
        )}
      </div>
    </form>
  );
}

function DoctorReport({ report }: { report: VideoDoctorView }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!('checks' in report)) return <p className="settings-error" role="alert">{report.error}</p>;
  return (
    <section className="vp-doctor" aria-label="Verificação da máquina">
      <p className="vp-doctor__summary">
        {report.ok ? 'Tudo pronto para renderizar.' : 'Falta algo para renderizar:'} Motor HyperFrames {report.engineVersion}.
      </p>
      <ul className="vp-doctor__list">
        {report.checks.map((check) => (
          <li key={check.id} className={check.ok ? 'vp-check' : 'vp-check vp-check--fail'}>
            <span className="vp-check__state">{check.ok ? 'OK' : 'Falta'}</span>
            <span className="vp-check__detail">{check.detail}</span>
            {check.fix && (
              <span className="vp-check__fix">
                <code>{check.fix}</code>
                <button
                  type="button"
                  className="ms-button ms-button--sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(check.fix ?? '').then(() => setCopied(check.id));
                  }}
                >
                  {copied === check.id ? 'Copiado' : 'Copiar comando'}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Checklist({ items }: { items: readonly PublishChecklistItem[] }) {
  return (
    <div className="vp-checklist">
      {items.map((item) => (
        <div key={item.network}>
          <p className="vp-checklist__title">{item.title}</p>
          <ul>
            {item.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  onChanged,
  onOpenedPreview,
}: {
  project: VideoProjectInfo;
  onChanged: () => void;
  onOpenedPreview: () => void;
}) {
  const [job, setJob] = useState<JobState | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [narrationOpen, setNarrationOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preset, setPreset] = useState<VideoExportPresetId>('vertical-9x16');
  const [label, setLabel] = useState<'auto' | 'on' | 'off'>('auto');
  const [player, setPlayer] = useState<{ path: string; url: string } | null>(null);
  const [checklist, setChecklist] = useState<readonly PublishChecklistItem[] | null>(null);
  const jobRef = useRef<JobState | null>(null);
  jobRef.current = job;

  useEffect(
    () =>
      window.nexus.videoStudio.onProgress((event) => {
        const current = jobRef.current;
        if (current && current.jobId === event.jobId) setJob({ ...current, pct: event.pct, stage: event.stage });
      }),
    [],
  );

  const latestRender = project.renders[0] ?? null;

  async function watch(path: string) {
    const granted = await window.nexus.videoStudio.mediaUrl(path);
    if (granted.ok) setPlayer({ path, url: granted.url });
    else setNotice({ tone: 'danger', text: granted.error });
  }

  /** F-1603: o Studio ao vivo num painel do navegador (URL já confiável, sem pergunta de rede privada). */
  async function openPreview() {
    setPreviewBusy(true);
    setNotice(null);
    try {
      const started = await window.nexus.videoStudio.previewStart(project.path);
      if (!started.ok) {
        setNotice({ tone: 'danger', text: started.error, ...(started.log ? { detail: started.log } : {}) });
        return;
      }
      onChanged();
      useProductNavigationStore.getState().openTerminal();
      const paneId = useLayoutStore.getState().addBrowserPane('about:blank');
      await waitForBrowserPaneCreated(paneId);
      await window.nexus.browser.load(paneId, started.url);
      onOpenedPreview();
    } catch (error) {
      reportLicenseDenial(error);
      setNotice({ tone: 'danger', text: 'Não consegui abrir a prévia num painel do navegador.' });
    } finally {
      setPreviewBusy(false);
    }
  }

  async function stopPreview() {
    if (!project.preview) return;
    await window.nexus.videoStudio.previewStop(project.preview.id);
    onChanged();
  }

  async function render(quality: 'draft' | 'final') {
    const jobId = newJobId();
    setJob({ kind: 'render', jobId, pct: null, stage: null });
    setNotice(null);
    try {
      const result = await window.nexus.videoStudio.render({ projectPath: project.path, quality, jobId });
      if (result.ok) {
        const seconds = result.durationSec ? `${Math.round(result.durationSec)} s` : 'vídeo';
        setNotice({
          tone: 'ok',
          text: `Renderizado: ${seconds}, ${result.width}×${result.height}, em ${Math.round(result.renderMs / 1000)} s.`,
          ...(result.networkAccess.length
            ? { detail: ['O render buscou coisas na rede (deixe fontes e scripts no projeto):', ...result.networkAccess] }
            : {}),
        });
        onChanged();
        void watch(result.path);
      } else {
        setNotice({ tone: result.canceled ? 'ok' : 'danger', text: result.error, ...(result.log ? { detail: result.log } : {}) });
      }
    } catch {
      setNotice({ tone: 'danger', text: 'O render não respondeu. Tente de novo.' });
    } finally {
      setJob(null);
    }
  }

  async function exportLatest() {
    if (!latestRender) return;
    const jobId = newJobId();
    setJob({ kind: 'export', jobId, pct: null, stage: null });
    setNotice(null);
    setChecklist(null);
    try {
      const result = await window.nexus.videoStudio.exportVideo({ inputPath: latestRender.path, preset, label, jobId });
      if (result.ok) {
        const loud = result.loudness
          ? ` Áudio em ${result.loudness.integratedLufs.toFixed(1).replace('.', ',')} LUFS${result.loudness.withinTarget ? '' : ' (fora da meta de -14)'}.`
          : '';
        setNotice({
          tone: 'ok',
          text: `Exportado para ${VIDEO_EXPORT_PRESETS[preset].label}.${loud} Rótulo de IA: ${result.label.burned ? 'na tela' : 'não'} (${result.label.reason}).`,
          ...(result.aspectMismatch
            ? { detail: ['O render tem outra proporção: o export pôs tarjas. Para ocupar a tela toda, renderize uma versão neste formato.'] }
            : {}),
        });
        setChecklist(result.publishChecklist);
        onChanged();
        if (result.files.video) void watch(result.files.video);
      } else {
        setNotice({ tone: result.canceled ? 'ok' : 'danger', text: result.error, ...(result.log ? { detail: result.log } : {}) });
      }
    } catch {
      setNotice({ tone: 'danger', text: 'A exportação não respondeu. Tente de novo.' });
    } finally {
      setJob(null);
    }
  }

  return (
    <article className="vp-card" aria-label={`Projeto de vídeo ${project.name}`}>
      <header className="vp-card__head">
        <div>
          <p className="vp-card__name">{project.name}</p>
          <p className="vp-card__meta">
            {project.path === '.' ? 'raiz do projeto' : project.path} · {project.engine === 'hyperframes' ? 'HyperFrames' : 'Remotion'}
            {project.hasNarration ? ' · com narração' : ''}
            {project.hasMusic ? ' · com música' : ''}
          </p>
        </div>
        <button type="button" className="ms-button ms-button--sm" onClick={() => void window.nexus.videoStudio.reveal(project.path)}>
          Abrir pasta
        </button>
      </header>

      {project.engine === 'remotion' ? (
        <p className="ms-dim">
          Projeto Remotion: o Nexus não renderiza Remotion (licença paga para empresa com 4 pessoas ou mais). O agente
          pode renderizar pelo shell do pane com o Remotion do próprio projeto.
        </p>
      ) : (
        <>
          <p className="vp-card__meta">
            {latestRender
              ? `Último render: ${fileName(latestRender)} · ${formatBytes(latestRender.sizeBytes)} · ${formatWhen(latestRender.modifiedAt)}`
              : 'Ainda sem render.'}
          </p>
          {job ? (
            <div className="vp-progress">
              <div
                className="vp-progress__bar"
                role="progressbar"
                aria-label={job.kind === 'render' ? 'Progresso do render' : 'Exportando'}
                aria-valuemin={0}
                aria-valuemax={100}
                {...(job.pct !== null ? { 'aria-valuenow': job.pct } : {})}
              >
                <span className="vp-progress__fill" style={{ transform: `scaleX(${(job.pct ?? 4) / 100})` }} />
              </div>
              <span className="vp-progress__text">
                {job.kind === 'render' ? 'Renderizando' : 'Exportando'}
                {job.pct !== null ? ` ${job.pct}%` : '…'}
              </span>
              <button type="button" className="ms-button ms-button--sm" onClick={() => void window.nexus.videoStudio.cancel(job.jobId)}>
                Cancelar
              </button>
            </div>
          ) : (
            <div className="vp-actions">
              <button type="button" className="ms-button" onClick={() => void render('draft')}>
                Renderizar rascunho
              </button>
              <button type="button" className="ms-button ms-button--primary" onClick={() => void render('final')}>
                Renderizar final
              </button>
              <button type="button" className="ms-button" disabled={previewBusy} onClick={() => void openPreview()}>
                {previewBusy ? 'Abrindo prévia…' : project.preview ? 'Abrir prévia' : 'Prévia ao vivo'}
              </button>
              {project.preview && (
                <button type="button" className="ms-button" onClick={() => void stopPreview()}>
                  Parar prévia
                </button>
              )}
              <button type="button" className="ms-button" aria-expanded={narrationOpen} onClick={() => setNarrationOpen((open) => !open)}>
                {narrationOpen ? 'Fechar gravação' : 'Gravar narração'}
              </button>
              {latestRender && (
                <>
                  <select className="ms-select" aria-label="Rede do export" value={preset} onChange={(event) => setPreset(event.target.value as VideoExportPresetId)}>
                    {VIDEO_EXPORT_PRESET_IDS.map((id) => (
                      <option key={id} value={id}>
                        {VIDEO_EXPORT_PRESETS[id].label}
                      </option>
                    ))}
                  </select>
                  <select className="ms-select" aria-label="Rótulo de IA" value={label} onChange={(event) => setLabel(event.target.value as 'auto' | 'on' | 'off')}>
                    <option value="auto">Rótulo de IA: automático</option>
                    <option value="on">Rótulo de IA: sempre</option>
                    <option value="off">Rótulo de IA: não</option>
                  </select>
                  <button type="button" className="ms-button" onClick={() => void exportLatest()}>
                    Exportar
                  </button>
                  <button type="button" className="ms-button" onClick={() => void watch(latestRender.path)}>
                    Assistir
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {narrationOpen && project.engine === 'hyperframes' && <NarrationRecorder projectPath={project.path} onDone={onChanged} />}

      {notice && (
        <div className={notice.tone === 'danger' ? 'vp-notice vp-notice--danger' : 'vp-notice'} role={notice.tone === 'danger' ? 'alert' : 'status'}>
          <p>{notice.text}</p>
          {notice.detail && (
            <ul>
              {notice.detail.map((line) => (
                <li key={line}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {player && (
        <figure className="vp-player">
          <video key={player.url} src={player.url} controls preload="metadata" aria-label={`Vídeo ${player.path}`} />
          <figcaption className="vp-card__meta">{player.path}</figcaption>
        </figure>
      )}

      {project.exports.length > 0 && (
        <details className="settings-advanced-field">
          <summary>Exports ({project.exports.length})</summary>
          <ul className="vp-files">
            {project.exports.map((file) => (
              <li key={file.path}>
                <button type="button" className="ms-button ms-button--sm" onClick={() => void watch(file.path)}>
                  Assistir
                </button>
                <span>{fileName(file)}</span>
                <span className="vp-card__meta">{formatBytes(file.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {checklist && (
        <details className="settings-advanced-field" open>
          <summary>O que declarar ao publicar</summary>
          <Checklist items={checklist} />
        </details>
      )}
    </article>
  );
}

export function VideoProjectsSection({ onRequestClose }: { onRequestClose: () => void }) {
  const [projects, setProjects] = useState<readonly VideoProjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [doctor, setDoctor] = useState<VideoDoctorView | null>(null);
  const [checking, setChecking] = useState(false);

  const reload = useCallback(async () => {
    try {
      const result = await window.nexus.videoStudio.listProjects();
      if (result.ok) {
        setProjects(result.projects);
        setError(null);
      } else {
        setProjects([]);
        setError(/scope|workspace/iu.test(result.error) ? 'Abra um projeto para ver os vídeos dele.' : result.error);
      }
    } catch {
      setProjects([]);
      setError('Não consegui ler os vídeos do projeto.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function check() {
    setChecking(true);
    try {
      setDoctor(await window.nexus.videoStudio.doctor());
    } catch {
      setDoctor({ ok: false, error: 'A verificação não respondeu.' });
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="vp-section" aria-label="Vídeos do projeto">
      <div className="vp-section__head">
        <p className="ms-dim">
          Vídeos motion de apresentação feitos por um agente: narração com legenda no tempo certo, música, render e export
          por rede.
        </p>
        <div className="vp-actions">
          <button type="button" className="ms-button ms-button--primary" onClick={() => setBriefOpen((open) => !open)} aria-expanded={briefOpen}>
            Novo vídeo de apresentação
          </button>
          <button type="button" className="ms-button" disabled={checking} onClick={() => void check()}>
            {checking ? 'Verificando…' : 'Verificar máquina'}
          </button>
        </div>
      </div>

      {briefOpen && (
        <BriefForm
          onClose={() => setBriefOpen(false)}
          onSent={onRequestClose}
          onOpenMyVoice={() => {
            requestMyVoiceFocus();
            useProductNavigationStore.getState().openSettings('media');
            onRequestClose();
          }}
        />
      )}
      {doctor && <DoctorReport report={doctor} />}
      {error && <p className="ms-dim" role="status">{error}</p>}

      {projects === null ? (
        <p className="ms-dim" role="status">
          Procurando projetos de vídeo…
        </p>
      ) : projects.length === 0 && !error ? (
        <div className="ms-empty">
          <p className="ms-empty__title">Nenhum projeto de vídeo neste projeto ainda</p>
          <p className="ms-dim">Comece um vídeo de apresentação: o agente cria o projeto, narra, renderiza e exporta.</p>
          {!briefOpen && (
            <button type="button" className="ms-button ms-button--primary ms-empty__cta" onClick={() => setBriefOpen(true)}>
              Novo vídeo de apresentação
            </button>
          )}
        </div>
      ) : (
        <div className="vp-list">
          {projects.map((project) => (
            <ProjectCard key={project.path} project={project} onChanged={() => void reload()} onOpenedPreview={onRequestClose} />
          ))}
        </div>
      )}
    </section>
  );
}
