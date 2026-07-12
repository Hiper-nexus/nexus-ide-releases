import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
  PET_PRESETS,
  SHEET_DATA_URL_MAX,
  type PetGalleryEntry,
  type PetPrefs,
  type PetPreset,
} from '../../../shared/pet-types';
import { OperatorSprite } from '../OperatorSprite';
import { CustomPetSprite } from '../../pet/CustomPetSprite';
import { SheetPetSprite } from '../../pet/SheetPetSprite';
import { imageFileToGrid } from '../../pet/pixelize';
import { filterPaletteActions } from '../../lib/command-palette-filter';

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
  galleryImport?(slugOrUrl: string): Promise<{
    ok: boolean;
    name?: string;
    dataUrl?: string;
    error?: string;
  }>;
  galleryList?(): Promise<{
    ok: boolean;
    items?: PetGalleryEntry[];
    error?: string;
  }>;
  pickSheet?(): Promise<{
    ok: boolean;
    canceled?: boolean;
    dataUrl?: string;
    error?: string;
  }>;
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
  const [gallerySlug, setGallerySlug] = useState('');
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [catalog, setCatalog] = useState<PetGalleryEntry[] | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sheetRef = useRef<HTMLInputElement | null>(null);

  const filteredCatalog = useMemo(() => {
    if (!catalog) return [];
    const matched = filterPaletteActions(
      catalog.map((entry) => ({ ...entry, keywords: entry.slug })),
      catalogFilter,
    );
    return matched.slice(0, 48);
  }, [catalog, catalogFilter]);

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
      setImportNote(
        'Pet criado da imagem e selecionado ✓ — funciona melhor com um personagem em fundo limpo/transparente.',
      );
    } catch {
      setImportNote('Não consegui ler essa imagem. Tente outra (png/jpg).');
    }
  };

  /** Aplica um dataUrl de spritesheet validado (dialog nativo ou arquivo). */
  const applySheetDataUrl = async (dataUrl: string) => {
    if (!(await imageIsCodexSheet(dataUrl))) {
      setImportNote(
        `O arquivo não bate com o contrato Codex v2 (malha ${CODEX_SHEET_COLS}×${CODEX_SHEET_ROWS}).`,
      );
      return;
    }
    const applied = await petApi.setPrefs({
      sheet: { dataUrl, cols: CODEX_SHEET_COLS, rows: CODEX_SHEET_ROWS },
      preset: 'sheet',
    });
    setImportNote(
      applied.preset === 'sheet' && applied.sheet
        ? 'Spritesheet importado e selecionado ✓'
        : dataUrl.length > SHEET_DATA_URL_MAX
          ? 'O arquivo é grande demais para importar (limite ~2,5 MB).'
          : 'Formato não suportado — use png, webp ou jpeg.',
    );
  };

  /** Dialog nativo abrindo direto em ~/.codex/pets (mac/win/linux). */
  const onPickSheetNative = async () => {
    if (!petApi.pickSheet) {
      sheetRef.current?.click();
      return;
    }
    const picked = await petApi.pickSheet();
    if (picked.canceled) return;
    if (!picked.ok || !picked.dataUrl) {
      setImportNote(picked.error ?? 'Não consegui ler esse arquivo.');
      return;
    }
    await applySheetDataUrl(picked.dataUrl);
  };

  const onOpenCatalog = async () => {
    if (!petApi.galleryList) return;
    if (catalogOpen) {
      setCatalogOpen(false);
      return;
    }
    setCatalogOpen(true);
    if (catalog) return;
    setImportNote('Carregando a galeria…');
    const result = await petApi.galleryList();
    if (result.ok && result.items) {
      setCatalog(result.items);
      setImportNote(null);
    } else {
      setImportNote(result.error ?? 'Galeria indisponível agora.');
      setCatalogOpen(false);
    }
  };

  const onGalleryImport = async (slugOverride?: string) => {
    const query = (slugOverride ?? gallerySlug).trim();
    if (!query || !petApi.galleryImport || galleryBusy) return;
    setGalleryBusy(true);
    setImportNote(`Baixando "${query}" da galeria…`);
    try {
      const result = await petApi.galleryImport(query);
      if (!result.ok || !result.dataUrl) {
        setImportNote(result.error ?? 'Não consegui importar esse pet.');
        return;
      }
      if (!(await imageIsCodexSheet(result.dataUrl))) {
        setImportNote(
          `O pet baixado não bate com a malha ${CODEX_SHEET_COLS}×${CODEX_SHEET_ROWS} do contrato v2.`,
        );
        return;
      }
      const applied = await petApi.setPrefs({
        sheet: {
          dataUrl: result.dataUrl,
          cols: CODEX_SHEET_COLS,
          rows: CODEX_SHEET_ROWS,
        },
        preset: 'sheet',
      });
      setImportNote(
        applied.preset === 'sheet' && applied.sheet
          ? `"${result.name ?? query}" importado da galeria.`
          : 'O pet baixado é grande demais para importar.',
      );
      if (applied.preset === 'sheet' && applied.sheet) setGallerySlug('');
    } finally {
      setGalleryBusy(false);
    }
  };

  const onPickSheet = async (file: File | undefined) => {
    if (!file) return;
    setImportNote('Validando spritesheet…');
    try {
      await applySheetDataUrl(await fileToDataUrl(file));
    } catch {
      setImportNote('Não consegui ler esse arquivo.');
    }
  };

  /** Remove o conteúdo de um pet criado/importado (volta para o Operador). */
  const onRemovePet = (which: 'custom' | 'sheet') => {
    patch({
      ...(which === 'custom' ? { customGrid: null } : { sheet: null }),
      ...(prefs.preset === which ? { preset: 'operator' as const } : {}),
    });
    setImportNote(
      which === 'custom' ? 'Pet de imagem removido.' : 'Spritesheet removido.',
    );
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
              const removable =
                (preset === 'custom' && prefs.customGrid) ||
                (preset === 'sheet' && prefs.sheet);
              return (
                <div className="settings-pet-wrap" key={preset}>
                {removable && (
                  <button
                    type="button"
                    className="settings-pet__remove"
                    title={`Remover ${PRESET_LABEL[preset]}`}
                    aria-label={`Remover ${PRESET_LABEL[preset]}`}
                    onClick={() => onRemovePet(preset as 'custom' | 'sheet')}
                  >
                    ×
                  </button>
                )}
                <button
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
                </div>
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
              onClick={() => void onPickSheetNative()}
            >
              Importar spritesheet do Codex…
            </button>
            <span className="settings-field__note">
              Tudo local; nada é enviado. Spritesheets no contrato Codex v2
              (8×11) funcionam direto — inclusive os de ~/.codex/pets.
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
          {petApi.galleryImport && (
            <div className="settings-pet-gallery">
              <input
                className="settings-input settings-pet-gallery__input"
                type="text"
                value={gallerySlug}
                placeholder="Slug ou URL do pet (codex-pets.net)"
                aria-label="Slug ou URL do pet na galeria petdex"
                disabled={galleryBusy}
                onChange={(e) => setGallerySlug(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onGalleryImport();
                }}
              />
              <button
                type="button"
                className="settings-pet-import__btn"
                disabled={galleryBusy || !gallerySlug.trim()}
                onClick={() => void onGalleryImport()}
              >
                {galleryBusy ? 'Baixando…' : 'Importar da galeria'}
              </button>
              {petApi.galleryList && (
                <button
                  type="button"
                  className="settings-pet-import__btn"
                  onClick={() => void onOpenCatalog()}
                >
                  {catalogOpen ? 'Fechar galeria' : 'Ver galeria…'}
                </button>
              )}
              <span className="settings-field__note">
                Galeria da comunidade (codex-pets.net / petdex.dev). A arte é
                de quem publicou — importe só o que você tem direito de usar.
              </span>
            </div>
          )}
          {catalogOpen && catalog && (
            <div className="settings-pet-catalog">
              <input
                className="settings-input settings-pet-gallery__input"
                type="text"
                value={catalogFilter}
                placeholder={`Filtrar ${catalog.length} pets publicados…`}
                aria-label="Filtrar pets da galeria"
                onChange={(e) => setCatalogFilter(e.target.value)}
              />
              <div className="settings-pet-catalog__chips" role="list">
                {filteredCatalog.map((entry) => (
                  <button
                    key={entry.slug}
                    type="button"
                    role="listitem"
                    className="settings-pet-catalog__chip"
                    disabled={galleryBusy}
                    title={`Importar "${entry.label}" (${entry.slug})`}
                    onClick={() => void onGalleryImport(entry.slug)}
                  >
                    {entry.label}
                  </button>
                ))}
                {filteredCatalog.length === 0 && (
                  <span className="settings-field__note">
                    Nada com esse nome na galeria.
                  </span>
                )}
              </div>
            </div>
          )}
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
