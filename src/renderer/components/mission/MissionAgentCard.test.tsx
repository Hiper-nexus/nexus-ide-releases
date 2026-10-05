/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { MissionAgentSnapshot } from '../../../shared/mission-engine-contract';
import { MissionAgentCard } from './MissionAgentCard';

it.each([
  ['orchestrator', 540, '--mission-core-width'],
  ['orchestrator', 304, '--mission-core-width'],
  ['executor', 208, '--mission-rack-width'],
] as const)('o rack %s usa seu retângulo de %i px mesmo com um núcleo maior na superfície', (category, width, variable) => {
  const host = document.createElement('div');
  host.style.setProperty('--mission-core-width', '540px');
  host.innerHTML = renderToStaticMarkup(<MissionAgentCard
    agent={{ id: 'rack', agentName: 'Rack', category, cli: 'codex', state: 'working' } as MissionAgentSnapshot}
    position={{ x: 400, y: 500, width, height: category === 'orchestrator' ? 162 : 150 }}
    selected={false} onSelectAgent={() => {}}
  />);
  const card = host.querySelector('button')!;
  expect(card.style.getPropertyValue(variable)).toBe(`${width}px`);
});
