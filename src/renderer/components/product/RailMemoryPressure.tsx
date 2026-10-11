import { useEffect, useRef, useState } from 'react';
import {
  receiveMachineResources,
  usePaneFootprintFeed,
  usePaneFootprintStore,
} from '../../state/pane-footprint-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { formatResourceBytes } from '../../lib/machine-resources-display';
import { requestMachineResourcesFocus } from '../settings/MachineResourcesCard';
import { PixelIcon } from '../PixelIcon';

/**
 * F-1172: indicador compacto no rodapé do rail. Silencioso enquanto há folga
 * (ou sem leitura — nunca inventa pressão); sob pressão real, pelos MESMOS
 * limiares do gate de admissão, aparece com texto e leva ao card "Recursos da
 * máquina" em Uso e cotas. Assina o mesmo push de 30s do badge de custo dos
 * panes; amostra mais velha que 2× o push some (ver MACHINE_SAMPLE_STALE_MS).
 */
/** 2× o intervalo do push (30s): mais velha que isto, a amostra não vale mais. */
export const MACHINE_SAMPLE_STALE_MS = 60_000;

export function RailMemoryPressure({
  onOpen,
  now = Date.now,
}: {
  onOpen?: () => void;
  /** Relógio injetável (testes); padrão Date.now. */
  now?: () => number;
}) {
  usePaneFootprintFeed();
  const machine = usePaneFootprintStore((state) => state.machine);
  const [clock, setClock] = useState(0);
  const refreshedFor = useRef<number | null>(null);
  const pressureSampledAt = machine?.pressure === 'pressure' ? machine.sampledAt : null;

  // Sessões fecham → o push para e a última "pressão" ficaria para sempre.
  // Ao vencer, a amostra some e pedimos UMA leitura nova ao perf:snapshot
  // (sem sessão viva o probe dele é vazio, barato). Se a pressão continua,
  // a leitura nova volta a mostrar; senão o indicador fica quieto.
  useEffect(() => {
    if (pressureSampledAt === null) return;
    const remaining = pressureSampledAt + MACHINE_SAMPLE_STALE_MS - now();
    if (remaining >= 0) {
      const timer = setTimeout(() => setClock((value) => value + 1), remaining + 1);
      return () => clearTimeout(timer);
    }
    if (refreshedFor.current === pressureSampledAt) return;
    refreshedFor.current = pressureSampledAt;
    void window.nexus?.perf
      ?.snapshot?.()
      ?.then((snapshot) => receiveMachineResources(snapshot?.machine))
      .catch(() => undefined);
    return undefined;
  }, [pressureSampledAt, clock, now]);

  const active =
    machine !== null &&
    machine.pressure === 'pressure' &&
    machine.memory.availableBytes !== null &&
    now() - machine.sampledAt <= MACHINE_SAMPLE_STALE_MS;

  // A região viva fica SEMPRE montada (vazia sem pressão): leitores de tela
  // anunciam a mudança de conteúdo, não um nó que nasce já preenchido.
  return (
    <div role="status" className="workspace-rail__pressure-slot">
      {active ? (
        <PressureButton
          available={formatResourceBytes(machine.memory.availableBytes!)}
          reserve={formatResourceBytes(machine.memory.minFreeBytes)}
          onOpen={onOpen}
        />
      ) : null}
    </div>
  );
}

function PressureButton({
  available,
  reserve,
  onOpen,
}: {
  available: string;
  reserve: string;
  onOpen?: () => void;
}) {
  const open = () => {
    requestMachineResourcesFocus();
    if (onOpen) onOpen();
    else useProductNavigationStore.getState().openSettings('usage-quota');
  };
  return (
    <button
      type="button"
      className="workspace-rail__row workspace-rail__fixed-row workspace-rail__pressure"
      aria-label={`Pressão de memória: ${available} disponíveis, abaixo da reserva de ${reserve}. Abrir Recursos da máquina`}
      title={`Disponível ${available}, abaixo da reserva de ${reserve}. Sob pressão, o Nexus estaciona panes ociosos.`}
      onClick={open}
    >
      <PixelIcon name="warn" size={12} />
      <span className="workspace-rail__row-label">Memória sob pressão</span>
      <span className="workspace-rail__row-count">{available} livres</span>
    </button>
  );
}
