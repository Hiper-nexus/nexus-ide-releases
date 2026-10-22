import { describe, expect, it } from 'vitest';
import {
  OPERATOR_BOARDUI_LICENSE_KEY,
  OPERATOR_REGISTRY_TOKENS,
  hasOperatorBoardUiLicenseKey,
  operatorRegistryNamespaces,
  operatorRegistryToken,
} from './ui-kit-operator-keys';

describe('the keys the operator bundles into Nexus', () => {
  it('carries a BoardUI licence key that looks like one', () => {
    // GUID-shaped, no whitespace: everything assertBoardUiLicenseKey asks.
    expect(OPERATOR_BOARDUI_LICENSE_KEY).toMatch(
      /^[0-9A-Fa-f-]{36}$/,
    );
    expect(hasOperatorBoardUiLicenseKey()).toBe(true);
  });

  it('carries a token for every namespace it declares', () => {
    for (const namespace of operatorRegistryNamespaces()) {
      const token = operatorRegistryToken(namespace);
      expect(token).toBeTruthy();
      expect(token).toMatch(/^suk-/);
    }
  });

  it('returns the SAME constant for both lookup shapes of a namespace', () => {
    // trim() is inside the lookup, so a padded namespace must not miss.
    expect(operatorRegistryToken(' @shadcnuikit ')).toBe(
      operatorRegistryToken('@shadcnuikit'),
    );
  });

  it('declares only namespaces it really carries', () => {
    expect(operatorRegistryNamespaces()).toEqual(
      Object.keys(OPERATOR_REGISTRY_TOKENS),
    );
  });
});
