import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
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
import { useSettingsStore } from '../../state/settings-store';
import {
  hatchPetIntent,
  launchPetHatchMission,
  petSlugFromImagePath,
} from '../../pet/pet-hatch-flow';
import { useToastStore } from '../../state/toast-store';
import { askConfirm } from '../../state/confirm-store';

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
          ×
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

  /**
   * "Gerar pet com IA": escolhe a imagem-base e inicia o Pet Studio fixo —
   * um único Codex executa a skill hatch-pet sem abrir reviewers/worktrees.
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
      setImportNote('Montando o executor visual e iniciando a missão…');
      const launched = await launchPetHatchMission(picked.path);
      if (!launched.ok) {
        const message = launched.error ?? 'Não consegui iniciar a criação do pet.';
        setImportNote(message);
        useToastStore.getState().push('error', 'Pet não iniciado', message);
        return;
      }
      useSettingsStore.getState().closeDrawer();
      useToastStore.getState().push(
        'success',
        'Criação do pet iniciada',
        'A missão já existe e o executor visual recebeu a imagem-base.',
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

          {library && library.length > 0 && (
            <div className="settings-pet-library">
              <p className="settings-appearance__label">
                Biblioteca inclusa ({library.length})
              </p>
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
            </div>
          )}

          <div className="settings-pet-import" aria-label="Criar e importar pets">
            <p className="settings-appearance__label">Criar e importar</p>
            <p className="settings-field__note settings-pet-import__lead">
              Três caminhos: gerar com IA, importar spritesheet local, ou
              buscar na galeria da comunidade.
            </p>
            <div className="settings-pet-import__actions action-card-row">
              {petApi.pickImage && (
                <ActionCard
                  icon="sparkle"
                  title={hatchBusy ? 'Iniciando criação…' : 'Criar pet com IA'}
                  subtitle="Foto → pet v2 completo"
                  variant="primary"
                  disabled={hatchBusy}
                  onClick={() => void onHatchPet()}
                />
              )}
              <ActionCard
                icon="grid"
                title="Importar spritesheet do Codex"
                subtitle="Contrato v2 · ~/.codex/pets"
                onClick={() => void onPickSheetNative()}
              />
            </div>
            <p className="settings-field__note">
              Criar com IA abre uma missão que desenha seu pet em todas as
              poses a partir de uma foto (processo lento, padrão Codex).
              Spritesheets no contrato v2 (8×11) importam direto — inclusive
              os de ~/.codex/pets. Os arquivos finais ficam locais; a geração
              usa o provider Codex configurado.
            </p>
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
              <p className="settings-appearance__label">Galeria da comunidade</p>
              <div className="settings-pet-gallery__row">
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
                <ActionCard
                  icon="star"
                  title={galleryBusy ? 'Baixando…' : 'Importar da galeria'}
                  size="sm"
                  disabled={galleryBusy || !gallerySlug.trim()}
                  onClick={() => void onGalleryImport()}
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
                para importar. Prefira a biblioteca inclusa se quiser offline.
              </p>
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
