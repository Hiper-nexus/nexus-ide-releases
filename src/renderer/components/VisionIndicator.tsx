/**
 * VisionIndicator — Fase 5 Jarvis Vision.
 * Small indicator shown in the header when screen capture was active
 * within the last 10 seconds.
 */
import { useEffect, useRef, useState } from 'react';
import { PixelIcon } from './PixelIcon';
import { useVisionConsentStore } from '../state/vision-consent-store';

interface VisionIndicatorProps {
  className?: string;
}

export function VisionIndicator({ className }: VisionIndicatorProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);
  const consentActive = useVisionConsentStore((s) => s.allowCloudImage);
  const markCaptured = useVisionConsentStore((s) => s.markCaptured);

  useEffect(() => {
    const handler = (result: Parameters<typeof markCaptured>[0]) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      markCaptured(result);
      setVisible(true);
      timerRef.current = window.setTimeout(() => {
        setVisible(false);
        timerRef.current = null;
      }, 10_000);
    };

    const unsub = window.nexus?.vision?.onCaptured(handler);

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      unsub?.();
    };
  }, []);

  if (!visible && !consentActive) return null;

  const label = consentActive ? 'Vision consent' : 'Vision';
  const title = consentActive
    ? 'Envio de imagem da tela para nuvem permitido nesta sessão'
    : 'Jarvis Vision capturou a tela do Nexus IDE';

  return (
    <span
      className={[
        'vision-indicator',
        consentActive ? 'vision-indicator--consent' : 'vision-indicator--capture',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={title}
    >
      <PixelIcon name="vision" size={11} />
      <span className="vision-indicator__label">{label}</span>
    </span>
  );
}

export default VisionIndicator;
