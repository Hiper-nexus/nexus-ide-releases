type MainGeneratedQrProps = {
  svg?: string;
  size?: number;
  label: string;
};

/**
 * QR produzido no processo principal, onde o encoder CommonJS é seguro. O
 * renderer o exibe como imagem data-URL e nunca interpreta markup recebido.
 */
export function MainGeneratedQr({
  svg,
  size = 168,
  label,
}: MainGeneratedQrProps) {
  if (!svg) {
    return <div role="img" aria-label={label} style={{ width: size, height: size }} />;
  }
  return (
    <img
      src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
      width={size}
      height={size}
      alt={label}
      style={{ display: 'block', borderRadius: 8 }}
    />
  );
}
