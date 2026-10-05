/**
 * Efeito colateral de importação, de propósito: `main.ts` importa este arquivo
 * ANTES de qualquer outro. Quando o processo foi chamado como
 * `nexus-ide --redline-status` (ou `--redline-bar-*`), o comando roda e o
 * processo sai aqui, sem abrir janela, sem tomar o lock de instância única e
 * sem carregar o resto do Main. Num launch normal não faz nada.
 */
import { runRedlineCliFromProcess } from './redline-cli';

runRedlineCliFromProcess();
