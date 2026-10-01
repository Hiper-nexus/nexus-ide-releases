import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

export interface LicenseCodeFormProps {
  /** O resgate exige conta logada — sem ela o backend nem lê o código. */
  enabled: boolean;
  busy: boolean;
  /** Resgate concluído nesta sessão: a licença nova assume na sequência. */
  succeeded: boolean;
  error: string | null;
  onSubmit(code: string): void;
}

/**
 * "Tenho um código": ação quieta que expande para o campo de resgate.
 * Presentacional — rede e estado do pedido ficam no componente pai, para a
 * mesma forma servir a tela de bloqueio e a aba Minha Conta.
 *
 * É um <form> de verdade: Enter envia pelo próprio navegador (sem tratar tecla,
 * o que também enviava no Enter que confirma composição de IME). O foco é
 * gerenciado: ao abrir vai para o campo e, se o pedido falha, volta para ele.
 */
export function LicenseCodeForm({ enabled, busy, succeeded, error, onSubmit }: LicenseCodeFormProps) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const wasBusy = useRef(false);
  const inputId = useId();
  const messageId = useId();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    // O botão desabilitado durante o pedido tira o foco do teclado: ao terminar com erro, devolve ao campo.
    if (wasBusy.current && !busy && error) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    wasBusy.current = busy;
  }, [busy, error]);

  if (!open) {
    return (
      <button
        type="button"
        className="access-btn access-btn--quiet license-code__toggle"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        Tenho um código
      </button>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = code.trim();
    if (value && enabled && !busy && !succeeded) onSubmit(value);
  };

  const message = succeeded || error;

  return (
    <form className="license-code" onSubmit={submit} noValidate>
      <label className="license-code__label" htmlFor={inputId}>
        Código de licença
      </label>
      <div className="license-code__row">
        <input
          ref={inputRef}
          id={inputId}
          className="settings-input license-code__input"
          placeholder="NEXUS-XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          value={code}
          readOnly={busy || succeeded}
          aria-busy={busy || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          onChange={(event) => setCode(event.target.value)}
        />
        <button
          type="submit"
          className="access-btn"
          disabled={busy || succeeded || !enabled || !code.trim()}
        >
          {busy ? 'Ativando…' : 'Ativar'}
        </button>
      </div>
      {!enabled && (
        <p className="license-code__hint">Entre na sua conta para resgatar um código.</p>
      )}
      {succeeded ? (
        <p id={messageId} className="license-code__ok" role="status">Licença ativada — liberando o acesso…</p>
      ) : error ? (
        <p id={messageId} className="license-code__error" role="alert">{error}</p>
      ) : null}
    </form>
  );
}
