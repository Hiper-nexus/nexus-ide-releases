/**
 * VisionIndicator — Fase 5 Jarvis Vision.
 * Small indicator shown in the header when screen capture was active
 * within the last 10 seconds.
 */
import { useEffect, useRef, useState } from 'react';
import { PixelIcon } from './PixelIcon';

interface VisionIndicatorProps {
  className?: string;
}

export function VisionIndicator({ className }: VisionIndicatorProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      setVisible(true);
      timerRef.current = window.setTimeout(() => {
        setVisible(false);
        timerRef.current = null;
      }, 10_000);
    };

    const unsub = window.nexus?.vision?.onCaptured(() => {
      handler();
    });

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      unsub?.();
    };
  }, []);

  if (!visible) return null;

  return (
    <span
      className={['vision-indicator', className].filter(Boolean).join(' ')}
      title="Jarvis Vision está capturando a tela do Nexus IDE"
    >
      <PixelIcon name="vision" size={11} />
      <span className="vision-indicator__label">Vision</span>
    </span>
  );
}

export default VisionIndicator;
