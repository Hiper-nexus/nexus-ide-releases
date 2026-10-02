import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  BUG_REPORT_CATEGORIES,
  BUG_REPORT_CATEGORY_LABELS,
  BUG_REPORT_IMPACTS,
  BUG_REPORT_IMPACT_LABELS,
  BUG_REPORT_LIMITS,
  formatBugReportMarkdown,
  validateBugReportDraft,
  type BugReportFailureCode,
  type BugReportMarkdownInput,
  type BugReportPayload,
} from '../../../shared/bug-report';
import { focusableWithin } from '../../lib/focus-trap';
import { useBugReportDialogStore } from '../../state/bug-report-dialog-store';
import { askConfirm } from '../../state/confirm-store';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import {
  INITIAL_BUG_REPORT_FORM,
  toBugReportRequest,
  toMarkdownDraft,
  type BugReportFormState,
} from './bug-report-form';

/**
 * "Reportar um problema": diálogo modal do idioma `.confirm__*`.
 *
 * O renderer só junta o que a pessoa digita e escolhe. Quem monta o
 * diagnóstico, redige e envia (com a sessão, que nunca passa por aqui) é o
 * Main. O botão "Ver exatamente o que será enviado" mostra o corpo que o Main
 * devolve, já redigido: o texto na tela é o texto que sai. Todo conteúdo é
 * renderizado como texto — nenhum HTML vindo do Main ou da pessoa é
 * interpretado.
 */

type Phase = 'editing' | 'sending' | 'sent';
type CopyState = 'idle' | 'copied' | 'copied-raw' | 'failed';
type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string; digest: string }
  | { status: 'error'; message: string };

interface Failure {
  code: BugReportFailureCode;
  message: string;
  payload?: BugReportPayload;
}

const LIMITS = BUG_REPORT_LIMITS;

const GENERIC_SEND_FAILURE = 'Não consegui enviar o relato. Verifique a conexão e tente de novo.';
const GENERIC_PREVIEW_FAILURE = 'Não consegui montar a prévia agora. Tente de novo.';
const COPIED_RAW =
  'Copiei o que você digitou, sem a limpeza automática de chaves, e-mails e caminhos. Revise antes de colar em outro lugar.';
const COPY_FAILED =
  'Não foi possível copiar. Abra "Ver exatamente o que será enviado" e copie o texto de lá.';

export function BugReportDialog() {
  const isOpen = useBugReportDialogStore((state) => state.isOpen);
  const close = useBugReportDialogStore((state) => state.close);
  // O formulário só existe enquanto o diálogo está aberto: cada abertura nasce
  // vazia e nada digitado sobrevive ao fechamento.
  return isOpen ? <BugReportForm onClose={close} /> : null;
}

function BugReportForm({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<BugReportFormState>(INITIAL_BUG_REPORT_FORM);
  const [phase, setPhase] = useState<Phase>('editing');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [copy, setCopy] = useState<CopyState>('idle');
  // Região viva única e persistente: leitor de tela só anuncia o que MUDA numa
  // região que já existia, não um nó inserido já com o texto.
  const [announcement, setAnnouncement] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [returnFocus] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // Congelado na abertura: prévia e envio descrevem o MESMO agente em foco,
  // mesmo que o foco dos panes mude com o diálogo aberto.
  const [activePaneId] = useState<string | null>(() => useLayoutStore.getState().focusedPaneId);

  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const stepsRef = useRef<HTMLTextAreaElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previewPanelRef = useRef<HTMLElement>(null);
  const previewSeq = useRef(0);
  const mounted = useRef(true);

  const ids = {
    heading: useId(),
    intro: useId(),
    title: useId(),
    titleError: useId(),
    titleCount: useId(),
    description: useId(),
    descriptionError: useId(),
    descriptionCount: useId(),
    steps: useId(),
    stepsError: useId(),
    stepsCount: useId(),
    category: useId(),
    impact: useId(),
    consent: useId(),
    consentHint: useId(),
    previewTitle: useId(),
  };

  const errors = useMemo(() => validateBugReportDraft(form), [form]);
  const hasErrors = Boolean(errors.title || errors.description || errors.steps);
  const sending = phase === 'sending';
  const dirty = Boolean(form.title.trim() || form.description.trim() || form.steps.trim());

  useEffect(() => {
    mounted.current = true;
    titleRef.current?.focus();
    return () => {
      mounted.current = false;
      previewSeq.current += 1;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);

  useEffect(() => {
    if (phase === 'sending') panelRef.current?.focus();
    if (phase === 'sent') closeRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  // A prévia nasce abaixo da dobra num painel com rolagem: traz-la à vista sem
  // roubar o foco de quem acionou o botão.
  useEffect(() => {
    if (preview.status === 'ready') previewPanelRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [preview.status]);

  const invalidatePreview = useCallback(() => {
    previewSeq.current += 1;
    setPreview({ status: 'idle' });
  }, []);

  const update = (patch: Partial<BugReportFormState>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setCopy('idle');
    // O corpo que veio com a falha descreve o texto ANTIGO (e o consentimento
    // antigo): ao copiar, o Main refaz uma versão redigida do que está na tela.
    setFailure((current) => (current?.payload ? { ...current, payload: undefined } : current));
    // O que a prévia mostrava deixou de ser o que sairia.
    invalidatePreview();
  };

  const buildRequest = (previewDigest?: string) =>
    toBugReportRequest(form, activePaneId, previewDigest);

  const focusFirstInvalid = (): void => {
    const target = errors.title
      ? titleRef.current
      : errors.description
        ? descriptionRef.current
        : errors.steps
          ? stepsRef.current
          : null;
    target?.focus();
  };

  const send = async (): Promise<void> => {
    if (sending) return;
    if (hasErrors) {
      setShowErrors(true);
      focusFirstInvalid();
      return;
    }
    setPhase('sending');
    setFailure(null);
    setCopy('idle');
    setAnnouncement('Enviando relato…');
    try {
      const shown = preview.status === 'ready' ? preview.digest : undefined;
      const result = await window.nexus.bugReport.submit(buildRequest(shown));
      if (!mounted.current) return;
      if (result.ok) {
        setSentId(result.id);
        setAnnouncement(`Relato enviado, obrigado. Código: ${result.id}`);
        setPhase('sent');
        return;
      }
      setAnnouncement('');
      // Corpo diferente do conferido: a prévia na tela deixou de valer.
      if (result.code === 'stale-preview') invalidatePreview();
      setFailure({ code: result.code, message: result.message, payload: result.payload });
    } catch {
      // Nunca mostra o texto da exceção do IPC.
      if (!mounted.current) return;
      setAnnouncement('');
      setFailure({ code: 'network', message: GENERIC_SEND_FAILURE });
    }
    setPhase('editing');
  };

  const togglePreview = async (): Promise<void> => {
    if (preview.status === 'loading') return;
    if (preview.status !== 'idle') {
      invalidatePreview();
      return;
    }
    if (hasErrors) {
      setShowErrors(true);
      focusFirstInvalid();
      return;
    }
    previewSeq.current += 1;
    const seq = previewSeq.current;
    setPreview({ status: 'loading' });
    let next: PreviewState;
    try {
      const result = await window.nexus.bugReport.preview(buildRequest());
      next = result.ok
        ? { status: 'ready', text: JSON.stringify(result.payload, null, 2), digest: result.digest }
        : { status: 'error', message: result.message };
    } catch {
      next = { status: 'error', message: GENERIC_PREVIEW_FAILURE };
    }
    if (mounted.current && seq === previewSeq.current) setPreview(next);
  };

  const copyReport = async (): Promise<void> => {
    try {
      let report: BugReportMarkdownInput | undefined = failure?.payload;
      let redacted = report !== undefined;
      if (!report) {
        // Texto mudou depois da falha: pede ao Main uma versão redigida do
        // que está na tela; se não der, cai no que foi digitado (sem limpeza).
        const rebuilt = await window.nexus.bugReport.preview(buildRequest()).catch(() => null);
        redacted = rebuilt?.ok === true;
        report = rebuilt?.ok ? rebuilt.payload : toMarkdownDraft(form);
      }
      await navigator.clipboard.writeText(formatBugReportMarkdown(report));
      if (!mounted.current) return;
      setCopy(redacted ? 'copied' : 'copied-raw');
      setAnnouncement(redacted ? 'Relato copiado para a área de transferência.' : COPIED_RAW);
    } catch {
      if (!mounted.current) return;
      setCopy('failed');
      setAnnouncement(COPY_FAILED);
    }
  };

  const hasUnsavedText = phase === 'editing' && dirty;

  /** Pergunta antes de perder texto digitado; devolve o foco se a pessoa desistir. */
  const askToDiscard = async (title: string, body: string, confirmLabel: string): Promise<boolean> => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ok = await askConfirm({
      title,
      body,
      confirmLabel,
      cancelLabel: 'Continuar editando',
      danger: true,
    });
    if (!ok && mounted.current) before?.focus();
    return ok && mounted.current;
  };

  const dismiss = (): void => {
    if (sending) return;
    if (!hasUnsavedText) {
      onClose();
      return;
    }
    void askToDiscard('Descartar o relato?', 'O que você digitou será perdido.', 'Descartar relato').then(
      (ok) => {
        if (ok) onClose();
      },
    );
  };

  const openAccount = (): void => {
    const go = (): void => {
      onClose();
      useProductNavigationStore.getState().openSettings('account');
    };
    if (!hasUnsavedText) {
      go();
      return;
    }
    void askToDiscard(
      'Sair do relato?',
      'Para entrar na conta, o relato digitado será descartado. Use "Copiar relato" antes se quiser guardá-lo.',
      'Descartar e abrir conta',
    ).then((ok) => {
      if (ok) go();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Esc que confirma uma composição (IME, tecla morta) não é "fechar".
      if (event.nativeEvent.isComposing) return;
      // Nada atravessa o diálogo: o Esc não fecha o overlay de baixo.
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = focusableWithin(event.currentTarget);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    const outside = !event.currentTarget.contains(active) || active === panelRef.current;
    if (event.shiftKey ? active === first || outside : active === last || outside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  // Enviar é um clique deliberado no botão: Enter num campo não envia.
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
  };

  const titleLength = form.title.trim().length;
  const descriptionLength = form.description.trim().length;
  const stepsLength = form.steps.trim().length;

  const previewOpen = preview.status !== 'idle';
  const previewLabel =
    preview.status === 'loading'
      ? 'Montando prévia…'
      : previewOpen
        ? 'Ocultar o que será enviado'
        : 'Ver exatamente o que será enviado';

  return (
    <div
      ref={dialogRef}
      className="confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={ids.heading}
      aria-describedby={ids.intro}
      aria-busy={sending ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <div
        className="confirm__overlay"
        // Um relato digitado não se perde por um clique fora do diálogo.
        onClick={() => {
          if (!sending && (phase === 'sent' || !dirty)) onClose();
        }}
      />
      <div ref={panelRef} tabIndex={-1} className="confirm__panel confirm__panel--bug-report">
        <div role="status" aria-live="polite" className="settings-visually-hidden">
          {announcement}
        </div>
        <h2 id={ids.heading} className="confirm__title">
          Reportar um problema
        </h2>
        <p id={ids.intro} className="confirm__body bug-report__intro">
          Conte o que aconteceu. Nada é enviado até você clicar em &ldquo;Enviar relato&rdquo;, e dá
          para conferir o texto exato antes.
        </p>

        {phase === 'sent' ? (
          <div className="bug-report__sent">
            <p className="bug-report__sent-text">
              Relato enviado, obrigado. Código: <strong>{sentId}</strong>
            </p>
            <p className="bug-report__hint">
              Guarde o código se precisar falar com a gente sobre este relato.
            </p>
            <div className="confirm__actions">
              <button
                ref={closeRef}
                type="button"
                className="confirm__btn confirm__btn--primary"
                onClick={onClose}
              >
                Fechar
              </button>
            </div>
          </div>
        ) : (
          <form className="bug-report__form" onSubmit={onSubmit} noValidate>
            <fieldset className="bug-report__fields" disabled={sending}>
              <div className="bug-report__field">
                <label className="bug-report__label" htmlFor={ids.title}>
                  Título
                </label>
                <input
                  ref={titleRef}
                  id={ids.title}
                  className="settings-input bug-report__control"
                  type="text"
                  value={form.title}
                  autoComplete="off"
                  aria-invalid={showErrors && errors.title ? 'true' : undefined}
                  aria-describedby={`${showErrors && errors.title ? `${ids.titleError} ` : ''}${ids.titleCount}`}
                  onChange={(event) => update({ title: event.target.value })}
                />
                <span id={ids.titleCount} className="bug-report__counter">
                  {titleLength}/{LIMITS.titleMax}
                </span>
                {showErrors && errors.title ? (
                  <p id={ids.titleError} className="bug-report__error">
                    {errors.title}
                  </p>
                ) : null}
              </div>

              <div className="bug-report__field">
                <label className="bug-report__label" htmlFor={ids.description}>
                  O que aconteceu?
                </label>
                <textarea
                  ref={descriptionRef}
                  id={ids.description}
                  className="settings-input bug-report__control bug-report__textarea"
                  rows={5}
                  value={form.description}
                  aria-invalid={showErrors && errors.description ? 'true' : undefined}
                  aria-describedby={`${showErrors && errors.description ? `${ids.descriptionError} ` : ''}${ids.descriptionCount}`}
                  onChange={(event) => update({ description: event.target.value })}
                />
                <span id={ids.descriptionCount} className="bug-report__counter">
                  {descriptionLength}/{LIMITS.descriptionMax}
                </span>
                {showErrors && errors.description ? (
                  <p id={ids.descriptionError} className="bug-report__error">
                    {errors.description}
                  </p>
                ) : null}
              </div>

              <div className="bug-report__field">
                <label className="bug-report__label" htmlFor={ids.steps}>
                  Passos para reproduzir <span className="bug-report__optional">(opcional)</span>
                </label>
                <textarea
                  ref={stepsRef}
                  id={ids.steps}
                  className="settings-input bug-report__control bug-report__textarea"
                  rows={3}
                  value={form.steps}
                  aria-invalid={showErrors && errors.steps ? 'true' : undefined}
                  aria-describedby={`${showErrors && errors.steps ? `${ids.stepsError} ` : ''}${ids.stepsCount}`}
                  onChange={(event) => update({ steps: event.target.value })}
                />
                <span id={ids.stepsCount} className="bug-report__counter">
                  {stepsLength}/{LIMITS.stepsMax}
                </span>
                {showErrors && errors.steps ? (
                  <p id={ids.stepsError} className="bug-report__error">
                    {errors.steps}
                  </p>
                ) : null}
              </div>

              <div className="bug-report__row">
                <div className="bug-report__field bug-report__field--grow">
                  <label className="bug-report__label" htmlFor={ids.category}>
                    Categoria
                  </label>
                  <select
                    id={ids.category}
                    className="settings-input bug-report__control"
                    value={form.category}
                    onChange={(event) =>
                      update({ category: event.target.value as BugReportFormState['category'] })
                    }
                  >
                    {BUG_REPORT_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {BUG_REPORT_CATEGORY_LABELS[category]}
                      </option>
                    ))}
                  </select>
                </div>

                <fieldset className="bug-report__impact" aria-labelledby={ids.impact}>
                  <legend id={ids.impact} className="bug-report__label">
                    Impacto
                  </legend>
                  <div className="bug-report__impact-options">
                    {BUG_REPORT_IMPACTS.map((impact) => (
                      <label key={impact} className="bug-report__choice">
                        <input
                          type="radio"
                          name={ids.impact}
                          value={impact}
                          checked={form.impact === impact}
                          onChange={() => update({ impact })}
                        />
                        <span>{BUG_REPORT_IMPACT_LABELS[impact]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>

              <div className="bug-report__consent">
                <label className="bug-report__choice" htmlFor={ids.consent}>
                  <input
                    id={ids.consent}
                    type="checkbox"
                    checked={form.includeDiagnostics}
                    aria-describedby={ids.consentHint}
                    onChange={(event) => update({ includeDiagnostics: event.target.checked })}
                  />
                  <span>Incluir diagnóstico técnico (sem prompts, sem código e sem chaves)</span>
                </label>
                <p id={ids.consentHint} className="bug-report__hint">
                  Desligado por padrão. Ligado, anexa o agente ativo, o número de panes e só os tipos
                  dos eventos recentes do app. Em qualquer caso vão junto a versão do app e do sistema.
                </p>
              </div>
            </fieldset>

            <div className="bug-report__preview-block">
              <button
                type="button"
                className="confirm__btn bug-report__preview-toggle"
                aria-expanded={previewOpen}
                aria-busy={preview.status === 'loading' ? 'true' : undefined}
                // Não desabilita enquanto monta: botão desabilitado perde o foco.
                disabled={sending}
                onClick={() => void togglePreview()}
              >
                {previewLabel}
              </button>
              {preview.status === 'ready' ? (
                <section
                  ref={previewPanelRef}
                  aria-labelledby={ids.previewTitle}
                  className="bug-report__preview-panel"
                >
                  <h3 id={ids.previewTitle} className="bug-report__preview-title">
                    O que será enviado
                  </h3>
                  <p className="bug-report__hint">
                    A limpeza automática troca por marcadores e-mails, caminhos de pasta e chaves de
                    formatos conhecidos, mas não pega tudo: confira o texto antes de enviar. O envio usa
                    exatamente este conteúdo.
                  </p>
                  <pre
                    className="bug-report__preview"
                    role="region"
                    tabIndex={0}
                    aria-labelledby={ids.previewTitle}
                  >
                    {preview.text}
                  </pre>
                </section>
              ) : null}
              {preview.status === 'error' ? (
                <p role="alert" className="bug-report__error">
                  {preview.message}
                </p>
              ) : null}
            </div>

            {failure ? (
              <div ref={failureRef} tabIndex={-1} className="bug-report__failure">
                <p role="alert" className="bug-report__failure-text">
                  {failure.message}
                </p>
                <div className="bug-report__failure-actions">
                  <button type="button" className="confirm__btn" onClick={() => void copyReport()}>
                    Copiar relato
                  </button>
                  {failure.code === 'no-session' ? (
                    <button type="button" className="confirm__btn" onClick={openAccount}>
                      Abrir Minha conta
                    </button>
                  ) : null}
                </div>
                {copy === 'copied' ? (
                  <p className="bug-report__hint">Relato copiado para a área de transferência.</p>
                ) : null}
                {copy === 'copied-raw' ? <p className="bug-report__error">{COPIED_RAW}</p> : null}
                {copy === 'failed' ? (
                  <p className="bug-report__error">{COPY_FAILED}</p>
                ) : null}
              </div>
            ) : null}

            <div className="confirm__actions bug-report__actions">
              <button
                type="button"
                className="confirm__btn"
                disabled={sending}
                onClick={dismiss}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="confirm__btn confirm__btn--primary"
                disabled={sending}
                onClick={() => void send()}
              >
                {sending ? 'Enviando…' : 'Enviar relato'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
