/** Official Xiaomi V2.6 API IDs and overseas base prices (2026-09-21).
 * https://mimo.mi.com/docs/en-US/price/pay-as-you-go
 * These are prices/capabilities, not benchmark scores or Desktop entitlements.
 */
export const MIMO_MODELS = [
  { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', input: 0.14, output: 0.28, cacheRead: 0.0028 },
  { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', input: 0.435, output: 0.87, cacheRead: 0.0036 },
  { id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro UltraSpeed', input: 4.35, output: 8.7, cacheRead: 0.036 },
] as const;
export const MIMO_CODE_MODEL_IDS = MIMO_MODELS.map(model => `xiaomi/${model.id}`);
export const MIMO_CODE_DEFAULT_MODEL = MIMO_CODE_MODEL_IDS[0];

/** The installed CLI's remote catalog may lag the release; seed official IDs. */
export const MIMO_CLI_MODELS = Object.fromEntries(MIMO_MODELS.map(model => [model.id, {
  id: model.id, name: model.name, reasoning: true, tool_call: true,
  cost: { input: model.input, output: model.output, cache_read: model.cacheRead },
}]));
