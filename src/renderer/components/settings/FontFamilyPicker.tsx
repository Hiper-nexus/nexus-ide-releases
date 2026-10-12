import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  discoverInstalledFonts,
  readFontEnumeration,
  subscribeFontEnumeration,
  type FontEnumerationState,
} from '../../styles/appearance-fonts';

/**
 * Shared enumeration for every font row in Settings → Aparência. Once one
 * picker learns the installed families (or learns the permission is blocked),
 * the others follow without re-querying.
 */
export function useFontEnumeration(): FontEnumerationState {
  // Subscribe before the discovery effect so a fast resolve cannot notify
  // into the void; the store is module-shared across every row.
  const state = useSyncExternalStore(subscribeFontEnumeration, readFontEnumeration);
  useEffect(() => {
    // Where the permission is already granted (or Electron approved silently),
    // discovery can start without a gesture. A failure just leaves the typed
    // input in place; focusing the select still covers the interactive
    // prompt path via `onFocus`.
    discoverInstalledFonts();
  }, []);
  return state;
}

const DEFAULT_OPTION = '__default__';
const CUSTOM_OPTION = '__custom__';

/**
 * Font family row: a native select over installed families when the Local
 * Font Access API is available, a typed input otherwise — and always a typed
 * path for a family the enumeration does not list.
 */
export function FontFamilyPicker({
  id,
  label,
  defaultLabel,
  value,
  onChange,
  note,
}: {
  id: string;
  label: string;
  /** What an unset preference renders as, e.g. "Inter". */
  defaultLabel: string;
  /** Committed family name; empty string means the default is in use. */
  value: string;
  onChange: (family: string) => void;
  note?: string;
}) {
  const enumeration = useFontEnumeration();
  const canEnumerate = enumeration.status === 'granted';
  const families = canEnumerate ? enumeration.families : [];
  const trimmed = value.trim();
  const listed = canEnumerate && trimmed !== '' && families.includes(trimmed);
  const [customOpen, setCustomOpen] = useState(!canEnumerate && trimmed !== '');
  const selectValue =
    trimmed === '' ? DEFAULT_OPTION : listed ? trimmed : CUSTOM_OPTION;
  const showCustomInput = !canEnumerate || customOpen || (trimmed !== '' && !listed);

  return (
    <div className="settings-field settings-font-row">
      <label className="settings-field__label" htmlFor={`${id}-family`}>
        {label}
      </label>
      {canEnumerate ? (
        <select
          id={`${id}-family`}
          className="settings-input"
          value={selectValue}
          onFocus={() => discoverInstalledFonts()}
          onChange={(event) => {
            const next = event.target.value;
            if (next === DEFAULT_OPTION) {
              setCustomOpen(false);
              onChange('');
            } else if (next === CUSTOM_OPTION) {
              setCustomOpen(true);
            } else {
              setCustomOpen(false);
              onChange(next);
            }
          }}
        >
          <option value={DEFAULT_OPTION}>Padrão — {defaultLabel}</option>
          {families.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
          <option value={CUSTOM_OPTION}>Outro…</option>
        </select>
      ) : null}
      {showCustomInput ? (
        <input
          id={`${id}-family${canEnumerate ? '-custom' : ''}`}
          className="settings-input"
          type="text"
          value={value}
          placeholder={defaultLabel}
          spellCheck={false}
          aria-label={`${label} — nome da família`}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      {note ? <span className="settings-field__note">{note}</span> : null}
    </div>
  );
}

/**
 * Font size row (range + live value). Bounds match the shared clamps in
 * appearance-fonts / TerminalSettings.
 */
export function FontSizePicker({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (size: number) => void;
}) {
  return (
    <div className="settings-field settings-font-row">
      <label className="settings-field__label" htmlFor={`${id}-size`}>
        {label}: <span className="sys-range-value">{value}px</span>
      </label>
      <input
        id={`${id}-size`}
        className="settings-range"
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
