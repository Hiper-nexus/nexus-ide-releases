import type { ReactNode } from 'react';
import { useBugReportDialogStore } from '../../state/bug-report-dialog-store';
import { PixelIcon } from '../PixelIcon';

interface ReportProblemButtonProps {
  className: string;
  /** Texto visível ao lado do ícone; o nome acessível é sempre o mesmo. */
  children?: ReactNode;
  /** Dica do botão (ex.: o atalho, quando ele vale na tela). */
  title?: string;
}

/**
 * Porta única e SEMPRE visível para "Reportar um problema". O diálogo já tinha
 * três portas escondidas (menu Ajuda, paleta, atalho) e o operador não achava
 * nenhuma; este botão vive onde a tela nunca some (topo do rail e a tela de
 * acesso bloqueado) e abre o mesmo diálogo global.
 */
export function ReportProblemButton({
  className,
  children,
  title = 'Reportar um problema',
}: ReportProblemButtonProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label="Reportar um problema"
      title={title}
      onClick={() => useBugReportDialogStore.getState().open()}
    >
      <PixelIcon name="bug" size={12} />
      {children ? <span>{children}</span> : null}
    </button>
  );
}
