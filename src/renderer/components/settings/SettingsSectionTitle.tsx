import { createContext, useContext, type ReactNode } from 'react';

export type SettingsSectionTitleLevel = 2 | 3;

const SettingsSectionTitleLevelContext =
  createContext<SettingsSectionTitleLevel>(3);

export function SettingsSectionTitleProvider({
  level,
  children,
}: {
  level: SettingsSectionTitleLevel;
  children: ReactNode;
}) {
  return (
    <SettingsSectionTitleLevelContext.Provider value={level}>
      {children}
    </SettingsSectionTitleLevelContext.Provider>
  );
}

export function SettingsSectionTitle({
  id,
  className = '',
  subtitle,
  children,
}: {
  id?: string;
  className?: string;
  /** Frase de propósito sob o título (DESIGN.md §12) — mesmo idioma de
      `.settings-detail__hint`, sem exigir wrapper extra no call site. */
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const level = useContext(SettingsSectionTitleLevelContext);
  const classes = `settings-detail__title settings-detail__route-title ${className}`.trim();

  const heading =
    level === 2 ? (
      <h2 id={id} className={classes} tabIndex={-1}>
        {children}
      </h2>
    ) : (
      <h3 id={id} className={classes}>
        {children}
      </h3>
    );

  if (!subtitle) return heading;
  return (
    <>
      {heading}
      <p className="settings-detail__hint">{subtitle}</p>
    </>
  );
}
