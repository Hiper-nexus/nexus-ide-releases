import { PLAN_STATE, describeStatus, planCopy } from './status.js';

export const STATUS_URL = (import.meta.env?.VITE_API_ORIGIN || 'https://api.nexuside.app') + '/v1/public/status';
const COPY_TARGETS = {
  status: 'plans-status',
  price: 'plans-price',
  trialDays: 'plans-trial-days',
  trialAgents: 'plans-trial-agents',
  trialSync: 'plans-trial-sync',
};

export function renderPlans(section, view) {
  const copy = planCopy(view);
  section.dataset.state = view.state;
  for (const [key, id] of Object.entries(COPY_TARGETS)) document.getElementById(id).textContent = copy[key];
  document.getElementById('plans-price').dataset.unavailable = view.price ? 'false' : 'true';
}

export async function initializePlans(fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  const section = document.getElementById('planos');
  if (!section) return;
  let view;
  try {
    const response = await fetchImpl(STATUS_URL, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = response.ok ? await response.json() : null;
    view = describeStatus(payload && payload.ok === true && typeof payload.data === 'object' ? payload.data : null);
  } catch {
    view = { state: PLAN_STATE.ERROR };
  }
  renderPlans(section, view);
}
