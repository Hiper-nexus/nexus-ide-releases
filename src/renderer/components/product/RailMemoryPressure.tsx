import { usePaneFootprintFeed, usePaneFootprintStore } from '../../state/pane-footprint-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { formatResourceBytes } from '../../lib/machine-resources-display';
import { requestMachineResourcesFocus } from '../settings/MachineResourcesCard';
import { PixelIcon } from '../PixelIcon';

/**
 * F-1172: indicador compacto no rodapé do rail. Silencioso enquanto há folga
 * (ou sem leitura — nunca inventa pressão); sob pressão real, pelos MESMOS
 * limiares do gate de admissão, aparece com texto e leva ao card "Recursos da
 * máquina" em Uso e cotas. Assina o mesmo push de 30s do badge de custo dos
 * panes — sem sessão viva o push não roda e o indicador fica quieto.
 */
export function RailMemoryPressure({ onOpen }: { onOpen?: () => void }) {
  usePaneFootprintFeed();
  const machine = usePaneFootprintStore((state) => state.machine);
  if (!machine || machine.pressure !== 'pressure' || machine.memory.availableBytes === null) return null;
  const available = formatResourceBytes(machine.memory.availableBytes);
  const reserve = formatResourceBytes(machine.memory.minFreeBytes);
  const open = () => {
    requestMachineResourcesFocus();
    if (onOpen) onOpen();
    else useProductNavigationStore.getState().openSettings('usage-quota');
  };
  return (
    <div role="status" className="workspace-rail__pressure-slot">
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
    </div>
  );
}
