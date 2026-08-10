import { useDictationMode } from '../voice/use-dictation-mode';

/**
 * Chip CODE/CHAT da barra superior (paridade Overclock: o modo do ditado fica
 * sempre visível, não escondido atrás do HUD). Mesmo comportamento do chip do
 * HUD do Jarvis — um clique alterna e persiste.
 */
export function DictationModeChip(): React.JSX.Element {
  const { mode, label, title, toggle } = useDictationMode();
  return (
    <button
      type="button"
      className={`dictation-mode-chip${
        mode === 'english' ? ' dictation-mode-chip--code' : ''
      }`}
      title={title}
      aria-label="Alternar modo do ditado entre Code e Chat"
      aria-pressed={mode === 'english'}
      onClick={() => void toggle()}
    >
      {label}
    </button>
  );
}
