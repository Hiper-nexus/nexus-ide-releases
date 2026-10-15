import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import type { SettingsSection } from './settings-nav';
import '../../styles/settings-start.css';

const SETUP_TASKS: ReadonlyArray<{
  section: SettingsSection;
  icon: PixelIconName;
  title: string;
  description: string;
}> = [
  { section: 'appearance', icon: 'grid', title: 'Ajustar a aparência', description: 'Escolha o tema e deixe a tela confortável para você.' },
  { section: 'terminal', icon: 'terminal', title: 'Aumentar o texto', description: 'Ajuste a fonte e a leitura dos terminais.' },
  { section: 'voice', icon: 'mic', title: 'Configurar o microfone', description: 'Fale seus pedidos e converse com o Jarvis.' },
  { section: 'usage-quota', icon: 'bolt', title: 'Ver uso e limites', description: 'Acompanhe o consumo informado pelas suas IAs.' },
  { section: 'squads', icon: 'users', title: 'Escolher a equipe', description: 'Veja quem pode trabalhar nas suas próximas missões.' },
  { section: 'diagnostics', icon: 'warn', title: 'Resolver um problema', description: 'Confira o diagnóstico para investigar o que não funciona.' },
];

export function SettingsStartSection({ onSelect }: { onSelect: (section: SettingsSection) => void }) {
  return (
    <section className="settings-section settings-start">
      <SettingsSectionTitle subtitle="Comece pelo que você precisa. Os ajustes avançados continuam no menu ao lado.">
        Configuração rápida
      </SettingsSectionTitle>
      <div className="settings-start__connect">
        <span className="settings-start__symbol" aria-hidden="true"><PixelIcon name="key" size={24} /></span>
        <div className="settings-start__intro">
          <h3>Traga sua IA para o Nexus</h3>
          <p>Conecte uma conta de Claude, Codex ou outra ferramenta. Se você já conectou, pode seguir direto para os outros ajustes.</p>
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => onSelect('providers')}>
            Conectar uma IA <PixelIcon name="chevron" size={12} />
          </button>
        </div>
      </div>
      <h3 className="settings-start__heading">O que você quer ajustar?</h3>
      <ul className="settings-start__tasks">
        {SETUP_TASKS.map(task => (
          <li key={task.section}>
            <button type="button" className="settings-start__task" onClick={() => onSelect(task.section)}>
              <span className="settings-start__task-icon" aria-hidden="true"><PixelIcon name={task.icon} size={18} /></span>
              <span className="settings-start__task-copy"><strong>{task.title}</strong><span>{task.description}</span></span>
              <span className="settings-start__arrow" aria-hidden="true"><PixelIcon name="chevron" size={12} /></span>
            </button>
          </li>
        ))}
      </ul>
      <p className="settings-start__help">Procurando algo específico? Use a busca de configurações. Tente “entrar no Claude”, “mudar tema” ou “aumentar letra”.</p>
    </section>
  );
}
