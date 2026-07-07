/**
 * VisionIndicator — Fase 5 Jarvis Vision.
 * Small indicator shown in the header when screen capture was active
 * within the last 10 seconds. Shows 🎥 + "Vision ativo" with a pulse animation.
 */
import React, { useEffect, useState } from 'react';

interface VisionIndicatorProps {
  className?: string;
}

export const VisionIndicator: React.FC<VisionIndicatorProps> = ({ className }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = () => {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 10_000);
      return () => clearTimeout(timer);
    };

    const unsub = window.nexus?.vision?.onCaptured(() => {
      handler();
    });

    return () => {
      unsub?.();
    };
  }, []);

  if (!visible) return null;

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 500,
        background: 'rgba(147, 51, 234, 0.15)',
        color: '#c084fc',
        border: '1px solid rgba(147, 51, 234, 0.3)',
        animation: 'vision-pulse 2s ease-in-out infinite',
      }}
      title="Jarvis Vision está capturando a tela do Nexus IDE"
    >
      <style>{`
        @keyframes vision-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
      <span role="img" aria-label="Vision active">🎥</span>
      Vision ativo
    </span>
  );
};

export default VisionIndicator;