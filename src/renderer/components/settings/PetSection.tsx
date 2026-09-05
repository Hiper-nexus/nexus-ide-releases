import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
  detectSheetGrid,
  PET_PRESETS,
  SHEET_DATA_URL_MAX,
  type PetGalleryEntry,
  type PetInstalledEntry,
  type PetLibraryEntry,
  type PetPrefs,
  type PetPreset,
  type PetSheet,
} from '../../../shared/pet-types';
import { OperatorSprite } from '../OperatorSprite';
import { ActionCard } from '../ActionCard';
import { CustomPetSprite } from '../../pet/CustomPetSprite';
import { SheetPetSprite } from '../../pet/SheetPetSprite';
import { filterPaletteActions } from '../../lib/command-palette-filter';
import {
  hatchPetIntent,
  preparePetHatchMission,
  petSlugFromImagePath,
} from '../../pet/pet-hatch-flow';
import { useToastStore } from '../../state/toast-store';
import { askConfirm } from '../../state/confirm-store';
import { PixelIcon } from '../PixelIcon';

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
  libraryList?(): Promise<{
    ok: boolean;
    items?: PetLibraryEntry[];
    error?: string;
  }>;
  libraryApply?(id: string): Promise<{
    ok: boolean;
    name?: string;
    prefs?: PetPrefs;
    error?: string;
  }>;
  libraryPreview?(id: string): Promise<{
    ok: boolean;
    name?: string;
    sheet?: PetSheet;
    error?: string;
  }>;
  installedList?(): Promise<{
    ok: boolean;
    items?: PetInstalledEntry[];
    error?: string;
  }>;
  installedApply?(id: string): Promise<{
    ok: boolean;
    name?: string;
    prefs?: PetPrefs;
    error?: string;
  }>;
  installedPreview?(id: string): Promise<{
    ok: boolean;
    name?: string;
    sheet?: PetSheet;
    error?: string;
  }>;
  installedDelete?(id: string): Promise<{
    ok: boolean;
    name?: string;
    error?: string;
  }>;
  pickSheet?(): Promise<{
    ok: boolean;
    canceled?: boolean;
    dataUrl?: string;
    error?: string;
  }>;
  pickImage?(): Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    error?: string;
  }>;
};

/** Slug de pet a partir do nome do arquivo-base (ex.: "Meu Gato.png" → meu-gato). */
export { hatchPetIntent, petSlugFromImagePath };

/** Card da biblioteca / meus pets com preview idle (lazy). */
function LibraryPetCard({
  entry,
  busy,
  active,
  onPick,
  onDelete,
  loadPreview,
}: {
  entry: PetLibraryEntry | PetInstalledEntry;
  busy: boolean;
  active: boolean;
  onPick: () => void;
  /** Só pets do utilizador (~/.codex/pets) — biblioteca inclusa não apaga. */
  onDelete?: () => void;
  loadPreview?: (id: string) => Promise<{
    ok: boolean;
    sheet?: PetSheet;
  }>;
}) {
  const [sheet, setSheet] = useState<PetSheet | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!loadPreview || sheet || failed) return;
    let cancelled = false;
    void loadPreview(entry.id).then((result) => {
      if (cancelled) return;
      if (result.ok && result.sheet) setSheet(result.sheet);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [entry.id, loadPreview, sheet, failed]);

  return (
    <div
      role="listitem"
      className={[
        'settings-pet-library__card',
        active ? 'settings-pet-library__card--active' : '',
        onDelete ? 'settings-pet-library__card--mine' : '',
        busy ? 'settings-pet-library__card--busy' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {active && (
        <span className="settings-pet-library__badge" aria-label="Pet em uso">
          Em uso
        </span>
      )}
      {onDelete && (
        <button
          type="button"
          className="settings-pet-library__delete nodrag"
          disabled={busy}
          aria-label={`Apagar pet ${entry.label}`}
          title="Apagar de ~/.codex/pets"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onDelete();
          }}
        >
          <PixelIcon name="close" size={10} />
        </button>
      )}
      <button
        type="button"
        className="settings-pet-library__pick"
        disabled={busy}
        title={
          entry.note
            ? `${entry.label} — ${entry.note}`
            : `Usar ${entry.label}`
        }
        onClick={onPick}
      >
        <span className="settings-pet-library__preview" aria-hidden>
          {sheet ? (
            <SheetPetSprite sheet={sheet} anim="idle" size={64} />
          ) : (
            <span className="settings-pet-library__preview-placeholder">
              {failed ? '?' : '…'}
            </span>
          )}
        </span>
        <span className="settings-pet-library__name">
          {busy ? '…' : entry.label}
        </span>
        {entry.note && (
          <span className="settings-pet-library__note">{entry.note}</span>
        )}
      </button>
    </div>
  );
}

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

const PETDEX_SHEET_ROWS = 9;
const GALLERY_COMPACT_CELL_WIDTHS = [96, 64] as const;
const GALLERY_COMPACT_QUALITIES = [0.92, 0.8] as const;

interface PreparedPetSheet {
  ok: boolean;
  sheet?: PetSheet;
  error?: string;
}

function compactSheetDataUrl(
  image: HTMLImageElement,
  cols: number,
  rows: number,
): string | null {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sourceCellWidth = sourceWidth / cols;
  const sourceCellHeight = sourceHeight / rows;

  for (const cellWidth of GALLERY_COMPACT_CELL_WIDTHS) {
    if (cellWidth >= sourceCellWidth) continue;
    const cellHeight = Math.max(
      1,
      Math.round(sourceCellHeight * (cellWidth / sourceCellWidth)),
    );
    const canvas = document.createElement('canvas');
    canvas.width = cellWidth * cols;
    canvas.height = cellHeight * rows;
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of GALLERY_COMPACT_QUALITIES) {
      const candidate = canvas.toDataURL('image/webp', quality);
      if (candidate.length <= SHEET_DATA_URL_MAX) return candidate;
    }
  }
  return null;
}

/** Decodifica e normaliza contratos Codex v2 (8×11) e petdex (8×9). */
export function preparePetSheetDataUrl(dataUrl: string): Promise<PreparedPetSheet> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const grid = detectSheetGrid(width, height);
      if (
        grid.cols !== CODEX_SHEET_COLS ||
        (grid.rows !== CODEX_SHEET_ROWS && grid.rows !== PETDEX_SHEET_ROWS)
      ) {
        resolve({
          ok: false,
          error: 'O arquivo não usa uma malha compatível 8×9 ou 8×11.',
        });
        return;
      }
      const normalized = dataUrl.length <= SHEET_DATA_URL_MAX
        ? dataUrl
        : compactSheetDataUrl(img, grid.cols, grid.rows);
      if (!normalized) {
        resolve({
          ok: false,
          error: 'Não consegui compactar o spritesheet para o limite local.',
        });
        return;
      }
      resolve({
        ok: true,
        sheet: { dataUrl: normalized, cols: grid.cols, rows: grid.rows },
      });
    };
    img.onerror = () => resolve({
      ok: false,
      error: 'O arquivo não é uma imagem compatível.',
    });
    img.src = dataUrl;
  });
}

export function PetSection() {
  const [prefs, setPrefs] = useState<PetPrefs | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [gallerySlug, setGallerySlug] = useState('');
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [galleryCandidate, setGalleryCandidate] = useState<{
    query: string;
    name: string;
    sheet: PetSheet;
  } | null>(null);
  const [catalog, setCatalog] = useState<PetGalleryEntry[] | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [library, setLibrary] = useState<PetLibraryEntry[] | null>(null);
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null);
  const [libraryActiveId, setLibraryActiveId] = useState<string | null>(null);
  const [installed, setInstalled] = useState<PetInstalledEntry[] | null>(null);
  const [installedBusyId, setInstalledBusyId] = useState<string | null>(null);
  const [installedActiveId, setInstalledActiveId] = useState<string | null>(null);
  const [hatchBusy, setHatchBusy] = useState(false);
  const sheetRef = useRef<HTMLInputElement | null>(null);

  const filteredCatalog = useMemo(() => {
    if (!catalog) return [];
    const matched = filterPaletteActions(
      catalog.map((entry) => ({ ...entry, keywords: entry.slug })),
      catalogFilter,
    );
    // Sem teto artificial: a área de chips já tem scroll; 48 escondia a maioria.
    return matched;
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
    if (petApi.libraryList) {
      void petApi.libraryList().then((result) => {
        if (cancelled) return;
        if (result.ok && result.items) {
          setLibrary(result.items);
          return;
        }
        setLibrary([]);
        if (result.error) {
          setImportNote(result.error);
        }
      });
    }
    if (petApi.installedList) {
      void petApi.installedList().then((result) => {
        if (cancelled) return;
        if (result.ok && result.items) {
          setInstalled(result.items);
          return;
        }
        setInstalled([]);
        if (result.error) setImportNote(result.error);
      });
    }
    return () => {
      cancelled = true;
      off();
    };
    // petApi é estável por sessão (contextBridge); petApiReady cobre o gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petApiReady]);

  const onApplyLibraryPet = async (id: string) => {
    if (!petApi?.libraryApply || libraryBusyId) return;
    setLibraryBusyId(id);
    setImportNote('Aplicando pet da biblioteca…');
    try {
      const result = await petApi.libraryApply(id);
      if (!result.ok) {
        setImportNote(result.error ?? 'Não consegui aplicar esse pet.');
        return;
      }
      if (result.prefs) setPrefs(result.prefs);
      setLibraryActiveId(id);
      setInstalledActiveId(null);
      setImportNote(
        `"${result.name ?? id}" da biblioteca aplicado — pet ligado.`,
      );
    } catch (err) {
      setImportNote(
        `Falha ao aplicar pet (${err instanceof Error ? err.message : 'erro'}).`,
      );
    } finally {
      setLibraryBusyId(null);
    }
  };

  const onApplyInstalledPet = async (id: string) => {
    if (!petApi?.installedApply || installedBusyId) return;
    setInstalledBusyId(id);
    setImportNote('Aplicando pet criado…');
    try {
      const result = await petApi.installedApply(id);
      if (!result.ok) {
        setImportNote(result.error ?? 'Não consegui aplicar esse pet.');
        return;
      }
      if (result.prefs) setPrefs(result.prefs);
      setInstalledActiveId(id);
      setLibraryActiveId(null);
      setImportNote(`"${result.name ?? id}" aplicado — pet ligado.`);
    } catch (err) {
      setImportNote(
        `Falha ao aplicar pet (${err instanceof Error ? err.message : 'erro'}).`,
      );
    } finally {
      setInstalledBusyId(null);
    }
  };

  const refreshInstalled = async () => {
    if (!petApi?.installedList) return;
    const result = await petApi.installedList();
    if (result.ok && result.items) setInstalled(result.items);
    else setInstalled([]);
  };

  const onDeleteInstalledPet = async (entry: PetInstalledEntry) => {
    if (!petApi?.installedDelete || installedBusyId) return;
    const ok = await askConfirm({
      title: `Apagar “${entry.label}”?`,
      body: `Remove o pacote de ~/.codex/pets/${entry.id}. Não dá para desfazer. A biblioteca inclusa do app não é afectada.`,
      confirmLabel: 'Apagar pet',
      danger: true,
    });
    if (!ok) return;
    setInstalledBusyId(entry.id);
    setImportNote(`A apagar “${entry.label}”…`);
    try {
      const result = await petApi.installedDelete(entry.id);
      if (!result.ok) {
        setImportNote(result.error ?? 'Não consegui apagar esse pet.');
        return;
      }
      if (installedActiveId === entry.id) {
        setInstalledActiveId(null);
        // Se era o pet activo no companion, volta ao operador (evita sheet órfão).
        if (prefs?.preset === 'sheet') {
          void petApi.setPrefs({ preset: 'operator' });
        }
      }
      await refreshInstalled();
      setImportNote(`“${result.name ?? entry.label}” apagado de ~/.codex/pets.`);
    } catch (err) {
      setImportNote(
        `Falha ao apagar (${err instanceof Error ? err.message : 'erro'}).`,
      );
    } finally {
      setInstalledBusyId(null);
    }
  };

  if (!petApiReady || !petApi || !prefs) return null;

  const patch = (partial: Partial<PetPrefs>) => {
    void petApi.setPrefs(partial);
  };

  /** Aplica um dataUrl de spritesheet validado (dialog nativo ou arquivo). */
  const applySheetDataUrl = async (dataUrl: string) => {
    const prepared = await preparePetSheetDataUrl(dataUrl);
    if (!prepared.ok || !prepared.sheet) {
      setImportNote(prepared.error ?? 'Spritesheet incompatível.');
      return;
    }
    const applied = await petApi.setPrefs({
      sheet: prepared.sheet,
      preset: 'sheet',
    });
    setImportNote(
      applied.preset === 'sheet' && applied.sheet
        ? 'Spritesheet importado e selecionado ✓'
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

  const onGalleryPreview = async (slugOverride?: string) => {
    const query = (slugOverride ?? gallerySlug).trim();
    if (!query || !petApi.galleryImport || galleryBusy) return;
    setGalleryBusy(true);
    setGalleryCandidate(null);
    setImportNote(`Carregando preview de "${query}"…`);
    try {
      const result = await petApi.galleryImport(query);
      if (!result.ok || !result.dataUrl) {
        setImportNote(result.error ?? 'Não consegui importar esse pet.');
        return;
      }
      const prepared = await preparePetSheetDataUrl(result.dataUrl);
      if (!prepared.ok || !prepared.sheet) {
        setImportNote(prepared.error ?? 'O pet baixado é incompatível.');
        return;
      }
      setGallerySlug(query);
      setGalleryCandidate({
        query,
        name: result.name ?? query,
        sheet: prepared.sheet,
      });
      setImportNote('Preview carregado — confira o pet antes de importar.');
    } catch (error) {
      setImportNote(
        `Falha ao carregar preview (${error instanceof Error ? error.message : 'erro'}).`,
      );
    } finally {
      setGalleryBusy(false);
    }
  };

  const onApplyGalleryCandidate = async () => {
    if (!galleryCandidate || galleryBusy) return;
    setGalleryBusy(true);
    setImportNote(`Importando "${galleryCandidate.name}"…`);
    try {
      const applied = await petApi.setPrefs({
        sheet: galleryCandidate.sheet,
        preset: 'sheet',
      });
      const wasApplied = applied.preset === 'sheet' && Boolean(applied.sheet);
      setImportNote(
        wasApplied
          ? `"${galleryCandidate.name}" importado da galeria.`
          : 'Não consegui salvar esse pet no perfil local.',
      );
      if (wasApplied) setGalleryCandidate(null);
    } catch (error) {
      setImportNote(
        `Falha ao importar (${error instanceof Error ? error.message : 'erro'}).`,
      );
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

  /**
   * Escolhe a imagem-base e abre a revisão canônica do Pet Studio. Nenhuma
   * missão inicia antes da aceitação explícita na etapa Revisar.
   */
  const onHatchPet = async () => {
    if (!petApi.pickImage || hatchBusy) return;
    setHatchBusy(true);
    try {
      const picked = await petApi.pickImage();
      if (picked.canceled) return;
      if (!picked.ok || !picked.path) {
        setImportNote(picked.error ?? 'Não consegui usar essa imagem.');
        return;
      }
      setImportNote('Preparando a revisão segura do Pet Studio…');
      const prepared = await preparePetHatchMission(picked.path);
      if (!prepared.ok) {
        const message =
          prepared.error ?? 'Não consegui preparar a revisão do pet.';
        setImportNote(message);
        useToastStore.getState().push('error', 'Pet não preparado', message);
        return;
      }
      setImportNote('Revisão do pet pronta para sua confirmação.');
      useToastStore.getState().push(
        'success',
        'Revisão do pet pronta',
        'Confira a imagem, a sessão Codex e as permissões antes de iniciar.',
      );
    } finally {
      setHatchBusy(false);
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
        Um mascote acompanha suas missões na área de trabalho.
        Arraste para mover e clique para abrir as opções.
      </p>

      <label className="settings-toggle-card">
        <span className="settings-toggle-card__copy">
          <strong>Mostrar o pet</strong>
          <span>O mascote aparece sobre as outras janelas.</span>
        </span>
        <input
          type="checkbox"
          checked={prefs.enabled}
          aria-label="Mostrar o pet de mesa"
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
      </label>

          {installed && installed.length > 0 && (
            <div className="settings-pet-library settings-pet-library--mine">
              <div className="settings-pet-library__head">
                <p className="settings-appearance__label">
                  Meus pets ({installed.length})
                </p>
                <span className="settings-pet-library__path" title="Pasta local">
                  ~/.codex/pets
                </span>
              </div>
              <p className="settings-field__note">
                Criados no Pet Studio. Clique para usar · × para apagar do
                disco. O companion só muda quando você escolher.
              </p>
              <div className="settings-pet-library__grid" role="list">
                {installed.map((entry) => (
                  <LibraryPetCard
                    key={entry.id}
                    entry={entry}
                    busy={installedBusyId === entry.id}
                    active={
                      installedActiveId === entry.id && prefs.preset === 'sheet'
                    }
                    onPick={() => void onApplyInstalledPet(entry.id)}
                    onDelete={
                      petApi.installedDelete
                        ? () => void onDeleteInstalledPet(entry)
                        : undefined
                    }
                    loadPreview={
                      petApi.installedPreview
                        ? (id) => petApi.installedPreview!(id)
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <div className="settings-pet-import" aria-label="Criar e importar pets">
            <p className="settings-appearance__label">Criar e importar</p>

            <div className="settings-row">
              {petApi.pickImage && <button type="button" className="settings-btn settings-btn--primary" disabled={hatchBusy} onClick={() => void onHatchPet()}>{hatchBusy ? 'Preparando revisão…' : 'Criar pet com IA'}</button>}
              <button type="button" className="settings-btn" onClick={() => void onPickSheetNative()}>Importar pet</button>
            </div>
            <details className="settings-advanced-field"><summary>Como criar e importar</summary>
              <p className="settings-field__note">A criação com IA usa uma foto e começa após revisar a missão. Para importar, escolha uma imagem de poses do Codex ou petdex.</p>
            </details>
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
      <>
          <details className="settings-advanced-field"><summary>Opções de exibição do mascote</summary>
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
                    <PixelIcon name="close" size={10} />
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

          </details>
          {library && library.length > 0 && (
            <details className="settings-pet-library">
              <summary>Biblioteca inclusa ({library.length})</summary>
              <p className="settings-field__note">
                Pets diversos já no app — um clique aplica o spritesheet e liga
                o companion. Offline, sem baixar da galeria.
              </p>
              <div className="settings-pet-library__grid" role="list">
                {library.map((entry) => (
                  <LibraryPetCard
                    key={entry.id}
                    entry={entry}
                    busy={libraryBusyId === entry.id}
                    active={
                      libraryActiveId === entry.id && prefs.preset === 'sheet'
                    }
                    onPick={() => void onApplyLibraryPet(entry.id)}
                    loadPreview={
                      petApi.libraryPreview
                        ? (id) => petApi.libraryPreview!(id)
                        : undefined
                    }
                  />
                ))}
              </div>
            </details>
          )}

          {petApi.galleryImport && (
            <div className="settings-pet-gallery">
              <p className="settings-appearance__label">Galeria da comunidade</p>
              <div className="settings-pet-gallery__row">
                <input
                  className="settings-input settings-pet-gallery__input"
                  type="text"
                  value={gallerySlug}
                  placeholder="Slug ou URL do pet (codex-pets.net)"
                  aria-label="Slug ou URL do pet na galeria petdex"
                  disabled={galleryBusy}
                  onChange={(e) => {
                    setGallerySlug(e.target.value);
                    setGalleryCandidate(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onGalleryPreview();
                  }}
                />
                <ActionCard
                  icon="star"
                  title={galleryBusy ? 'Carregando…' : 'Ver preview'}
                  size="sm"
                  disabled={galleryBusy || !gallerySlug.trim()}
                  onClick={() => void onGalleryPreview()}
                />
                {petApi.galleryList && (
                  <ActionCard
                    icon="users"
                    title={catalogOpen ? 'Fechar galeria' : 'Ver galeria…'}
                    size="sm"
                    onClick={() => void onOpenCatalog()}
                  />
                )}
              </div>
              <p className="settings-field__note">
                Galeria da comunidade (codex-pets.net / petdex.dev). A arte é
                de quem publicou — importe só o que você tem direito de usar.
              </p>
              {galleryCandidate && (
                <div className="settings-pet-gallery__preview" aria-label="Pré-visualização do pet">
                  <span className="settings-pet-gallery__preview-stage" aria-hidden>
                    <SheetPetSprite
                      sheet={galleryCandidate.sheet}
                      anim="idle"
                      size={96}
                    />
                  </span>
                  <span className="settings-pet-gallery__preview-copy">
                    <strong>Pré-visualização · {galleryCandidate.name}</strong>
                    <small>
                      Compatível {galleryCandidate.sheet.cols}×{galleryCandidate.sheet.rows}
                    </small>
                  </span>
                  <ActionCard
                    icon="star"
                    title={galleryBusy ? 'Importando…' : 'Importar este pet'}
                    subtitle="Aplicar no companion"
                    size="sm"
                    variant="primary"
                    disabled={galleryBusy}
                    onClick={() => void onApplyGalleryCandidate()}
                  />
                </div>
              )}
            </div>
          )}
          {catalogOpen && catalog && (
            <div className="settings-pet-catalog">
              <input
                className="settings-input settings-pet-catalog__filter"
                type="search"
                value={catalogFilter}
                placeholder={`Filtrar ${catalog.length} pets publicados…`}
                aria-label="Filtrar pets da galeria"
                onChange={(e) => setCatalogFilter(e.target.value)}
              />
              <p className="settings-field__note">
                {filteredCatalog.length} de {catalog.length} — clique no nome
                para ver o preview. Prefira a biblioteca inclusa se quiser offline.
              </p>
              <div className="settings-pet-catalog__chips" role="list">
                {filteredCatalog.map((entry) => (
                  <button
                    key={entry.slug}
                    type="button"
                    role="listitem"
                    className={`settings-pet-catalog__chip ${galleryCandidate?.query === entry.slug ? 'settings-pet-catalog__chip--selected' : ''}`}
                    disabled={galleryBusy}
                    aria-pressed={galleryCandidate?.query === entry.slug}
                    title={`Ver preview de "${entry.label}" (${entry.slug})`}
                    onClick={() => void onGalleryPreview(entry.slug)}
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
    </div>
  );
}
