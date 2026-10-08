// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: plugin local `nexus`
// só com as regras que se aplicam ao Nexus (as demais do T3 são de Effect/mobile);
// objeto simples em vez de `definePlugin` (identidade em `@oxlint/plugins`).
// `no-test-in-loop` (QLT-06) e `no-raw-ipc` (QLT-07) foram escritas aqui a
// partir da ideia das regras do T3, sem copiar código.
//
// Carregado pelo `.oxlintrc.json` (`jsPlugins`); as regras rodam com
// `npm run lint:oxlint` no CI e no `npm run lint`.

import noRawIpc from './rules/no-raw-ipc.mjs';
import noTestInLoop from './rules/no-test-in-loop.mjs';
import requireSuppressionReason from './rules/require-suppression-reason.mjs';

export default {
  meta: { name: 'nexus' },
  rules: {
    'no-raw-ipc': noRawIpc,
    'no-test-in-loop': noTestInLoop,
    'require-suppression-reason': requireSuppressionReason,
  },
};
