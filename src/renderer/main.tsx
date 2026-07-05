import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

// No StrictMode: its dev-time double-mount would spawn/kill PTYs twice per pane.
const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}
createRoot(container).render(<App />);
// Sinal de vida para o watchdog do main (via console forward, só dev): o
// primeiro load com Vite frio às vezes pendura o grafo de módulos e o React
// nunca monta ("tela preta") — sem este sinal o main não sabe distinguir
// página carregada de app montado.
console.log('[diag] app montado');
