import { useEffect, useRef, useState } from 'react';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
  PET_PRESETS,
  SHEET_DATA_URL_MAX,
  type PetPrefs,
  type PetPreset,
} from '../../../shared/pet-types';
import { OperatorSprite } from '../OperatorSprite';
import { CustomPetSprite } from '../../pet/CustomPetSprite';
import { SheetPetSprite } from '../../pet/SheetPetSprite';
import { imageFileToGrid } from '../../pet/pixelize';

/**
 * Settings → Aparência → Pet de mesa: liga/desliga o companion, escolhe o
 * preset e cria um pet personalizado pixelizando uma imagem local (nada sai
 * da máquina). As prefs vivem no main (pet.json) e sincronizam ao vivo.
 */

/** Fatia do window.nexus.pet que esta seção usa (tipada como opcional). */
type PetSectionApi = {
  getPrefs(): Promise<PetPrefs>;
  setPrefs(patch: Partial<PetPrefs>): Promise<PetPrefs>;
  onPrefsChanged(cb: (prefs: PetPrefs) => void): () => void;
};

const PRESET_LABEL: Record<PetPreset, string> = {
  operator: 'Operador',
  gold: 'Ouro',
  flame: 'Chama',
  centurion: 'Centurião',
  prestige: 'Prestígio',
  custom: 'Seu pet',
  sheet: 'Sprite Codex',
};

/** Lê um arquivo de imagem como data URL (mantém o formato original). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('leitura falhou'));
    reader.readAsDataURL(file);
  });
}

/** Confere se a imagem tem a malha 8×11 do contrato Codex v2. */
function imageIsCodexSheet(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve(
        img.width % CODEX_SHEET_COLS === 0 &&
          img.height % CODEX_SHEET_ROWS === 0 &&
          img.width > 0 &&
          img.height > 0,
      );
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

export function PetSection() {
  const [prefs, setPrefs] = useState<PetPrefs | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sheetRef = useRef<HTMLInputElement | null>(null);

  // Skew preload/renderer (HMR recarrega o renderer, não o preload; ou
  // instalação antiga): a API do pet pode não existir em runtime, mesmo que
  // o tipo diga que sim — a seção some em vez de derrubar toda a Aparência.
  const petApi = (window as { nexus?: { pet?: PetSectionApi } }).nexus?.pet;
  const petApiReady = typeof petApi?.getPrefs === 'function';

  useEffect(() => {
    if (!petApiReady || !petApi) return undefined;
    let cancelled = false;
    void petApi.getPrefs().then((loaded) => {
      if (!cancelled) setPrefs(loaded);
    });
    const off = petApi.onPrefsChanged(setPrefs);
    return () => {
      cancelled = true;
      off();
    };
    // petApi é estável por sessão (contextBridge); petApiReady cobre o gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petApiReady]);

  if (!petApiReady || !petApi || !prefs) return null;

  const patch = (partial: Partial<PetPrefs>) => {
    void petApi.setPrefs(partial);
  };

  const onPickImage = async (file: File | undefined) => {
    if (!file) return;
    setImportNote('Pixelizando…');
    try {
      const grid = await imageFileToGrid(file);
      patch({ customGrid: grid, preset: 'custom' });
      setImportNote(null);
    } catch {
      setImportNote('Não consegui ler essa imagem. Tente outra (png/jpg).');
    }
  };

  const onPickSheet = async (file: File | undefined) => {
    if (!file) return;
    setImportNote('Validando spritesheet…');
    try {
      const dataUrl = await fileToDataUrl(file);
      if (!(await imageIsCodexSheet(dataUrl))) {
        setImportNote(
          `O arquivo não bate com o contrato Codex v2 (malha ${CODEX_SHEET_COLS}×${CODEX_SHEET_ROWS}).`,
        );
        return;
      }
      const applied = await petApi.setPrefs({
        sheet: {
          dataUrl,
          cols: CODEX_SHEET_COLS,
          rows: CODEX_SHEET_ROWS,
        },
        preset: 'sheet',
      });
      // O sanitizador rejeita por TAMANHO ou por FORMATO — diagnostica certo.
      setImportNote(
        applied.preset === 'sheet' && applied.sheet
          ? null
          : dataUrl.length > SHEET_DATA_URL_MAX
            ? 'O arquivo é grande demais para importar (limite ~2,5 MB).'
            : 'Formato não suportado — use png, webp ou jpeg.',
      );
    } catch {
      setImportNote('Não consegui ler esse arquivo.');
    }
  };

  return (
    <div className="settings-appearance__block">
      <p className="settings-appearance__label">Pet de mesa</p>
      <p className="settings-field__note settings-appearance__note">
        Um companion pixel flutua sobre o desktop, avisa quando missões
        terminam ou um agente morre, e dorme quando você quiser. Arraste-o
        pela tela; clique nele para o menu.
      </p>

      <label className="settings-toggle-card">
        <span className="settings-toggle-card__copy">
          <strong>Mostrar o pet</strong>
          <span>Janela flutuante sempre no topo, fora da taskbar.</span>
        </span>
        <input
          type="checkbox"
          checked={prefs.enabled}
          aria-label="Mostrar o pet de mesa"
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
      </label>

      {prefs.enabled && (
        <>
          <label className="settings-toggle-card">
            <span className="settings-toggle-card__copy">
              <strong>Dormir</strong>
              <span>Silencia balões e avisos; o sprite apaga o visor.</span>
            </span>
            <input
              type="checkbox"
              checked={prefs.sleeping}
              aria-label="Pet dormindo"
              onChange={(e) => patch({ sleeping: e.target.checked })}
            />
          </label>

          <label className="settings-toggle-card">
            <span className="settings-toggle-card__copy">
              <strong>Fundo sólido</strong>
              <span>
                Cartão opaco em vez de transparência — necessário em alguns
                Linux sem compositor ARGB.
              </span>
            </span>
            <input
              type="checkbox"
              checked={prefs.solidBackground}
              aria-label="Pet com fundo sólido"
              onChange={(e) => patch({ solidBackground: e.target.checked })}
            />
          </label>

          <div className="settings-pet-grid" role="radiogroup" aria-label="Pet">
            {PET_PRESETS.map((preset) => {
              const disabled =
                (preset === 'custom' && !prefs.customGrid) ||
                (preset === 'sheet' && !prefs.sheet);
              return (
                <button
                  key={preset}
                  type="button"
                  className={`settings-pet ${
                    prefs.preset === preset ? 'settings-pet--active' : ''
                  }`}
                  role="radio"
                  aria-checked={prefs.preset === preset}
                  disabled={disabled}
                  title={
                    disabled
                      ? preset === 'sheet'
                        ? 'Importe um spritesheet do Codex abaixo'
                        : 'Crie seu pet personalizado com uma imagem abaixo'
                      : `Usar o pet ${PRESET_LABEL[preset]}`
                  }
                  onClick={() => patch({ preset })}
                >
                  {preset === 'sheet' ? (
                    prefs.sheet ? (
                      <SheetPetSprite sheet={prefs.sheet} anim="idle" size={32} />
                    ) : (
                      <span className="settings-pet__placeholder" aria-hidden>
                        ?
                      </span>
                    )
                  ) : preset === 'custom' ? (
                    prefs.customGrid ? (
                      <CustomPetSprite grid={prefs.customGrid} size={32} />
                    ) : (
                      <span className="settings-pet__placeholder" aria-hidden>
                        ?
                      </span>
                    )
                  ) : (
                    <OperatorSprite
                      size={32}
                      tier="ELITE"
                      branch="base"
                      skin={preset === 'operator' ? null : preset}
                      mood="idle"
                    />
                  )}
                  <span className="settings-pet__label">
                    {PRESET_LABEL[preset]}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="settings-pet-import">
            <button
              type="button"
              className="settings-pet-import__btn"
              onClick={() => fileRef.current?.click()}
            >
              Criar pet de uma imagem…
            </button>
            <button
              type="button"
              className="settings-pet-import__btn"
              onClick={() => sheetRef.current?.click()}
            >
              Importar spritesheet do Codex…
            </button>
            <span className="settings-field__note">
              Tudo local; nada é enviado. Spritesheets no contrato Codex v2
              (8×11) funcionam direto — inclusive os de ~/.codex/pets e os
              baixados da galeria codex-pets.net.
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                void onPickImage(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <input
              ref={sheetRef}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              hidden
              onChange={(e) => {
                void onPickSheet(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
          {importNote && (
            <p className="settings-field__note" role="status">
              {importNote}
            </p>
          )}
        </>
      )}
    </div>
  );
}
