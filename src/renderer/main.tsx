import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

// No StrictMode: its dev-time double-mount would spawn/kill PTYs twice per pane.
const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}
createRoot(container).render(<App />);
