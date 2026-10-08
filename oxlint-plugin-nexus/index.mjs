// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: plugin local `nexus`
// com só a regra que se aplica ao Nexus (as demais do T3 são de Effect/mobile);
// objeto simples em vez de `definePlugin` (identidade em `@oxlint/plugins`).
//
// Carregado pelo `.oxlintrc.json` (`jsPlugins`); as regras rodam com
// `npm run lint:oxlint` no CI e no `npm run lint`.

import requireSuppressionReason from './rules/require-suppression-reason.mjs';

export default {
  meta: { name: 'nexus' },
  rules: {
    'require-suppression-reason': requireSuppressionReason,
  },
};
