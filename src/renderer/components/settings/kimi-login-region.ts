import { kimiRegion, type KimiRegion } from '../../../shared/kimi-login-command';
import { askChoice, type ChoiceRequest } from '../../state/choice-store';

/**
 * kimi.ai (internacional, Google) vs kimi.com (China). The CLI device-code
 * URL follows `--region`; the operator has to pick because clients differ
 * (F-354). Locale only marks the recommended option.
 */
export function kimiLoginRegionRequest(
  preferred: KimiRegion = kimiRegion(),
): ChoiceRequest {
  return {
    title: 'Qual site do Kimi?',
    body:
      'O login abre a página de autorização no navegador. A URL muda com a conta: ' +
      'kimi.ai (internacional, Google) ou kimi.com (China).',
    options: [
      {
        value: 'global',
        label: 'kimi.ai — internacional',
        detail: 'www.kimi.ai/code/authorize_device — Google e contas fora da China',
        primary: preferred === 'global',
      },
      {
        value: 'mainland-cn',
        label: 'kimi.com — China',
        detail: 'Conta mainland, página em chinês',
        primary: preferred === 'mainland-cn',
      },
    ],
  };
}

export async function askKimiLoginRegion(): Promise<KimiRegion | null> {
  const picked = await askChoice(kimiLoginRegionRequest());
  if (picked === 'global' || picked === 'mainland-cn') return picked;
  return null;
}
