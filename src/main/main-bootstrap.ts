import { app } from 'electron';
import { ensureRegularMacOSActivation } from './macos-activation-policy';

// Keep this entry intentionally tiny. The bundled runtime imports native
// modules and a large Electron graph; loading it before this synchronous call
// is what allowed macOS to classify NexusIDE as a UIElement.
ensureRegularMacOSActivation();

void import('./main').catch((error) => {
  console.error('[main-bootstrap] runtime failed to load:', error);
  app.quit();
});
