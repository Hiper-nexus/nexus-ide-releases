import type { ResolvedProvider } from '../../shared/voice-ipc';

export function VoiceServiceDetails({ groups }: {
  groups: ReadonlyArray<{ label: string; providers: readonly ResolvedProvider[] }>;
}) {
  return <details className="voice-settings__fallback-voices">
    <summary>Diagnóstico dos serviços</summary>
    {groups.map(group => <div key={group.label}>
      <h4>{group.label}</h4>
      <dl>{group.providers.map(provider => <div key={provider.provider}>
        <dt>{provider.provider}</dt>
        <dd>{provider.reason}</dd>
      </div>)}</dl>
    </div>)}
  </details>;
}
