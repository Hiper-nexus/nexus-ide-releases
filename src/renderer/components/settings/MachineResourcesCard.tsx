import { useEffect, useId, useRef } from 'react';
import type { MachineResources } from '../../../shared/machine-resources';
import {
  receiveMachineResources,
  usePaneFootprintFeed,
  usePaneFootprintStore,
} from '../../state/pane-footprint-store';
import {
  formatLoad,
  formatPercent,
  formatResourceBytes,
} from '../../lib/machine-resources-display';

/**
 * F-1172: recursos da máquina em Uso e cotas. Monitor TS herdado do T3 (o
 * nativo Rust não foi portado); a memória é a MESMA leitura do gate de
 * admissão de panes, então "Pressão de memória" aqui é exatamente quando o
 * Nexus age. Dados: perf:snapshot ao montar + o push de 30s (assinatura via
 * usePaneFootprintFeed, o mesmo do badge de custo dos panes).
 *
 * Doutrina aviônica: o estado vem em texto ("Memória com folga", "Pressão de
 * memória"), a cor só reforça.
 */

const ID = 'machine-resources';
let focusRequested = false;

/** O indicador do rail pede para o card rolar até a vista ao abrir. */
export function requestMachineResourcesFocus(): void {
  focusRequested = true;
}

function windowLabel(machine: MachineResources): string {
  const minutes = Math.round(machine.window.spanMs / 60_000);
  return minutes >= 1 ? `Pico nos últimos ${minutes} min` : 'Pico recente';
}

function Verdict({ machine }: { machine: MachineResources }) {
  const reserve = formatResourceBytes(machine.memory.minFreeBytes);
  if (machine.pressure === 'unknown') {
    return (
      <p className="machine-resources__verdict" role="status">
        <strong>Sem leitura de memória.</strong> O sistema não respondeu agora; o Nexus não
        toma nenhuma ação automática sem leitura.
      </p>
    );
  }
  const available =
    machine.memory.availableBytes === null ? null : formatResourceBytes(machine.memory.availableBytes);
  if (machine.pressure === 'pressure') {
    return (
      <p className="machine-resources__verdict" role="status">
        <strong>Pressão de memória.</strong> {available} disponíveis, abaixo da reserva de{' '}
        {reserve} que o Nexus mantém para a máquina.
      </p>
    );
  }
  return (
    <p className="machine-resources__verdict" role="status">
      <strong>Memória com folga.</strong> {available} disponíveis, acima da reserva de {reserve}.
    </p>
  );
}

export function MachineResourcesCard() {
  usePaneFootprintFeed();
  const machine = usePaneFootprintStore((state) => state.machine);
  const titleId = useId();
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    const request = window.nexus?.perf?.snapshot?.();
    void request
      ?.then((snapshot) => {
        if (alive) receiveMachineResources(snapshot?.machine);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!focusRequested || !ref.current) return;
    focusRequested = false;
    ref.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    ref.current.focus({ preventScroll: true });
  }, []);

  if (!machine) {
    return (
      <section
        className="machine-resources"
        id={ID}
        ref={ref}
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-busy="true"
      >
        <h2 className="machine-resources__title" id={titleId}>
          Recursos da máquina
        </h2>
        <p className="machine-resources__hint" role="status">
          Lendo os recursos da máquina…
        </p>
      </section>
    );
  }

  const { memory, cpu, nexus } = machine;
  const used = memory.usedRatio;
  const usedBytes =
    memory.availableBytes === null ? null : Math.max(0, memory.totalBytes - memory.availableBytes);
  const memoryLine =
    used === null || usedBytes === null
      ? null
      : `${formatResourceBytes(usedBytes)} de ${formatResourceBytes(memory.totalBytes)} em uso (${formatPercent(used)})`;

  return (
    <section
      className={`machine-resources machine-resources--${machine.pressure}`}
      id={ID}
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
    >
      <header className="machine-resources__head">
        <h2 className="machine-resources__title" id={titleId}>
          Recursos da máquina
        </h2>
        <p className="machine-resources__hint">
          Mesma leitura que o Nexus usa para decidir abrir panes.
        </p>
      </header>

      <Verdict machine={machine} />

      {memoryLine && used !== null ? (
        <div className="machine-resources__memory">
          <div className="machine-resources__row">
            <span>Memória</span>
            <strong>{memoryLine}</strong>
          </div>
          <div
            className="machine-resources__bar"
            role="meter"
            aria-label="Memória em uso"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(used * 100)}
            aria-valuetext={memoryLine}
          >
            <span className="machine-resources__bar-fill" style={{ width: `${Math.round(used * 100)}%` }} />
            {memory.totalBytes > 0 ? (
              <span
                className="machine-resources__bar-reserve"
                aria-hidden="true"
                style={{ left: `${Math.round((1 - memory.minFreeBytes / memory.totalBytes) * 100)}%` }}
              />
            ) : null}
          </div>
          {memory.peakUsedRatio !== null ? (
            <span className="machine-resources__sub">
              {windowLabel(machine)}: {formatPercent(memory.peakUsedRatio)}
            </span>
          ) : null}
        </div>
      ) : null}

      <dl className="machine-resources__facts">
        <div>
          <dt>CPU (carga média de 1 min)</dt>
          <dd>
            {cpu.loadAvg1 === null
              ? 'Carga de CPU indisponível neste sistema'
              : `${formatLoad(cpu.loadAvg1)} em ${cpu.cores} ${cpu.cores === 1 ? 'núcleo' : 'núcleos'}`}
          </dd>
        </div>
        <div>
          <dt>Panes do Nexus</dt>
          <dd>
            {nexus.panesBytes === null
              ? 'Sem medição dos panes agora'
              : `${formatResourceBytes(nexus.panesBytes)} em ${nexus.paneCount} ${nexus.paneCount === 1 ? 'pane' : 'panes'}`}
          </dd>
        </div>
        <div>
          <dt>Nexus (aplicativo)</dt>
          <dd>{nexus.appBytes === null ? 'Sem medição agora' : formatResourceBytes(nexus.appBytes)}</dd>
        </div>
      </dl>

      <div className="machine-resources__policy">
        <p className="machine-resources__policy-title">Sob pressão de memória, o Nexus:</p>
        <ul>
          <li>
            estaciona o pane ocioso mais antigo a cada minuto (até 3 se a pressão for severa) — o
            CLI encerra, o pane e o histórico ficam, e você acorda quando quiser. O orquestrador e
            panes aguardando você nunca são estacionados;
          </li>
          {machine.admissionEnabled ? (
            <>
              <li>não abre novos workers automáticos de missão sem folga de memória — a missão segue em lotes;</li>
              <li>
                avisa antes de abrir um pane novo; a decisão continua sua (só recusa com a trava
                dura NEXUS_PANE_CAP_HARD=1).
              </li>
            </>
          ) : (
            <li>
              não segura nem avisa novos panes: o gate de admissão está desligado
              (NEXUS_PANE_GUARD=off).
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
