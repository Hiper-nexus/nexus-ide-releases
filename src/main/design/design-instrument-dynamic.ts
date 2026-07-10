import type * as t from "@babel/types";

/** JSX emitted by these callbacks can have multiple runtime instances. */
export function isDynamicArrayTemplate(ancestors: readonly t.Node[]): boolean {
  return ancestors.some((ancestor) => {
    if (
      ancestor.type !== "CallExpression" &&
      ancestor.type !== "OptionalCallExpression"
    ) {
      return false;
    }
    const callee = ancestor.callee;
    if (
      callee.type !== "MemberExpression" &&
      callee.type !== "OptionalMemberExpression"
    ) {
      return false;
    }
    if (!callee.computed && callee.property.type === "Identifier") {
      return (
        callee.property.name === "map" || callee.property.name === "flatMap"
      );
    }
    return (
      callee.computed &&
      callee.property.type === "StringLiteral" &&
      (callee.property.value === "map" || callee.property.value === "flatMap")
    );
  });
}
