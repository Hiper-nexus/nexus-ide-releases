import { parse as babelParse } from '@babel/parser';
import type * as t from '@babel/types';
import * as recast from 'recast';

/**
 * Deterministic JSX write-back engine (VISUAL-EDIT-001, F3). Every operation
 * is PURE (source in → source out) and returns its semantic INVERSE, so the
 * action stack can undo without diffing files. Elements are located by the
 * ephemeral `data-nexus-id` attribute injected by design-instrument (never
 * persisted). Reformatting the user's file is forbidden (spec §7.4):
 *
 *  - literal edits (className, style values, text) are RANGE edits on the
 *    original source — byte-surgical by construction;
 *  - structural edits (reorder/delete/duplicate) go through recast, which
 *    reprints only the touched subtree.
 */

export const NEXUS_ID_ATTR = 'data-nexus-id';

// --------------------------------------------------------------- babel side

type BabelNode = t.Node & { start?: number | null; end?: number | null };

function parseBabel(code: string): t.File {
  return babelParse(code, {
    sourceType: 'module',
    allowImportExportEverywhere: true,
    plugins: ['jsx', 'typescript'],
  });
}

function walk(node: unknown, visit: (node: BabelNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const candidate = node as BabelNode;
  if (typeof candidate.type === 'string') visit(candidate);
  for (const key of Object.keys(candidate)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') {
      continue;
    }
    walk((candidate as unknown as Record<string, unknown>)[key], visit);
  }
}

function jsxAttrName(attribute: t.JSXAttribute): string | null {
  return attribute.name.type === 'JSXIdentifier' ? attribute.name.name : null;
}

function findJsxAttribute(
  element: t.JSXElement,
  name: string,
): t.JSXAttribute | null {
  for (const attribute of element.openingElement.attributes) {
    if (attribute.type === 'JSXAttribute' && jsxAttrName(attribute) === name) {
      return attribute;
    }
  }
  return null;
}

function babelNexusIdOf(element: t.JSXElement): string | null {
  const attribute = findJsxAttribute(element, NEXUS_ID_ATTR);
  return attribute?.value?.type === 'StringLiteral' ? attribute.value.value : null;
}

function locateBabel(code: string, nexusId: string): {
  ast: t.File;
  element: t.JSXElement;
} {
  const ast = parseBabel(code);
  let element: t.JSXElement | null = null;
  walk(ast.program, (node) => {
    if (!element && node.type === 'JSXElement') {
      if (babelNexusIdOf(node as t.JSXElement) === nexusId) {
        element = node as t.JSXElement;
      }
    }
  });
  if (!element) {
    throw new Error(`no JSX element with ${NEXUS_ID_ATTR}="${nexusId}"`);
  }
  return { ast, element };
}

function rangeOf(node: BabelNode): [number, number] {
  if (typeof node.start !== 'number' || typeof node.end !== 'number') {
    throw new Error('AST node has no source range');
  }
  return [node.start, node.end];
}

function spliceRange(
  code: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return code.slice(0, start) + replacement + code.slice(end);
}

function validatedCode(code: string): string {
  parseBabel(code);
  return code;
}

function escapeJsxData(value: string, isAttribute: boolean): string {
  return value.replace(/[&<>\x00-\x1f\x7f{}"]|\r\n?/gu, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '{') return '&#123;';
    if (character === '}') return '&#125;';
    if (character === '"') return isAttribute ? '&quot;' : '"';
    const codePoint = character.codePointAt(0);
    return codePoint === undefined ? '' : `&#${codePoint};`;
  });
}

function singleQuotedStringLiteral(value: string): string {
  let escaped = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "'") escaped += "\\'";
    else if (character === '\\') escaped += '\\\\';
    else if (character === '\n') escaped += '\\n';
    else if (character === '\r') escaped += '\\r';
    else if (character === '\t') escaped += '\\t';
    else if (character === '\b') escaped += '\\b';
    else if (character === '\f') escaped += '\\f';
    else if (codePoint < 0x20 || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029) {
      escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else escaped += character;
  }
  return `'${escaped}'`;
}

/** Insertion point for a new attribute: right before `>` or `/>`. */
function attributeInsertionPoint(element: t.JSXElement): number {
  const opening = element.openingElement as BabelNode;
  const [, end] = rangeOf(opening);
  return end - (element.openingElement.selfClosing ? 2 : 1);
}

// ---------------------------------------------------------------- className

export interface ClassNameEdit {
  add: string[];
  remove: string[];
}

export function applyClassNameEdit(
  code: string,
  nexusId: string,
  edit: ClassNameEdit,
): { code: string; inverse: ClassNameEdit } {
  const { element } = locateBabel(code, nexusId);
  const attribute = findJsxAttribute(element, 'className');

  let current: string[] = [];
  if (attribute) {
    if (attribute.value?.type !== 'StringLiteral') {
      throw new Error(
        'className is a dynamic expression — deterministic edit refused (agent territory)',
      );
    }
    current = attribute.value.value.split(/\s+/).filter(Boolean);
  }

  const removed = edit.remove.filter((cls) => current.includes(cls));
  const added = edit.add.filter((cls) => !current.includes(cls));
  const next = [...current.filter((cls) => !edit.remove.includes(cls)), ...added];
  const inverse: ClassNameEdit = { add: removed, remove: added };

  if (attribute && next.length > 0) {
    const [start, end] = rangeOf(attribute.value as BabelNode);
    return {
      code: validatedCode(
        spliceRange(
          code,
          start,
          end,
          `"${escapeJsxData(next.join(' '), true)}"`,
        ),
      ),
      inverse,
    };
  }
  if (attribute && next.length === 0) {
    const [start, end] = rangeOf(attribute as BabelNode);
    const removalStart = leadingWhitespaceStart(code, start);
    return {
      code: validatedCode(spliceRange(code, removalStart, end, '')),
      inverse,
    };
  }
  if (next.length === 0) return { code, inverse };
  const point = attributeInsertionPoint(element);
  const prefix = /\s/.test(code[point - 1] ?? '') ? '' : ' ';
  return {
    code: validatedCode(
      spliceRange(
        code,
        point,
        point,
        `${prefix}className="${escapeJsxData(next.join(' '), true)}"`,
      ),
    ),
    inverse,
  };
}

function leadingWhitespaceStart(code: string, index: number): number {
  let start = index;
  while (start > 0 && /[ \t]/.test(code[start - 1])) start -= 1;
  return start;
}

// ------------------------------------------------------------- inline style

/** camelCase style props; null removes the property. */
export type InlineStyleEdit = Record<string, string | null>;

const STYLE_PROPERTY_PATTERN = /^(?:[A-Za-z][A-Za-z0-9]*|--[A-Za-z][A-Za-z0-9_-]*)$/u;
const UNSAFE_STYLE_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

function assertValidStyleProperty(property: string): void {
  if (
    !STYLE_PROPERTY_PATTERN.test(property) ||
    UNSAFE_STYLE_PROPERTIES.has(property)
  ) {
    throw new Error(`invalid style property: ${property}`);
  }
}

function stylePropertySource(property: string): string {
  return property.startsWith('--')
    ? singleQuotedStringLiteral(property)
    : property;
}

function styleObjectOf(element: t.JSXElement): {
  attribute: t.JSXAttribute;
  object: t.ObjectExpression;
} | null {
  const attribute = findJsxAttribute(element, 'style');
  if (!attribute) return null;
  if (
    attribute.value?.type !== 'JSXExpressionContainer' ||
    attribute.value.expression.type !== 'ObjectExpression'
  ) {
    throw new Error('style is not an object literal — deterministic edit refused');
  }
  return { attribute, object: attribute.value.expression };
}

function stylePropertyName(property: t.ObjectExpression['properties'][number]): string | null {
  if (property.type !== 'ObjectProperty') return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  return null;
}

function stylePropertyValue(property: t.ObjectProperty): string {
  if (property.value.type === 'StringLiteral') return property.value.value;
  if (property.value.type === 'NumericLiteral') return String(property.value.value);
  throw new Error(
    'style property value is a dynamic expression — deterministic edit refused',
  );
}

export function applyInlineStyleEdit(
  code: string,
  nexusId: string,
  edit: InlineStyleEdit,
): { code: string; inverse: InlineStyleEdit } {
  const entries = Object.entries(edit);
  for (const [key] of entries) assertValidStyleProperty(key);
  const inverse: InlineStyleEdit = {};
  let working = code;

  // One property per pass: each splice invalidates ranges, so re-locate.
  for (const [key, value] of entries) {
    const { element } = locateBabel(working, nexusId);
    const style = styleObjectOf(element);
    const property = style?.object.properties.find(
      (candidate) => stylePropertyName(candidate) === key,
    ) as t.ObjectProperty | undefined;

    if (value === null) {
      if (!property || !style) continue;
      inverse[key] = stylePropertyValue(property);
      working = removeStyleProperty(working, style, property);
      continue;
    }

    if (property) {
      inverse[key] = stylePropertyValue(property);
      const [start, end] = rangeOf(property.value as BabelNode);
      working = validatedCode(
        spliceRange(working, start, end, singleQuotedStringLiteral(value)),
      );
    } else if (style) {
      inverse[key] = null;
      const properties = style.object.properties;
      const last = properties[properties.length - 1] as BabelNode | undefined;
      if (last) {
        const [, end] = rangeOf(last);
        working = validatedCode(
          spliceRange(
            working,
            end,
            end,
            `, ${stylePropertySource(key)}: ${singleQuotedStringLiteral(value)}`,
          ),
        );
      } else {
        const [start] = rangeOf(style.object as BabelNode);
        working = validatedCode(
          spliceRange(
            working,
            start + 1,
            start + 1,
            ` ${stylePropertySource(key)}: ${singleQuotedStringLiteral(value)} `,
          ),
        );
      }
    } else {
      inverse[key] = null;
      const { element: fresh } = locateBabel(working, nexusId);
      const point = attributeInsertionPoint(fresh);
      const prefix = /\s/.test(working[point - 1] ?? '') ? '' : ' ';
      working = validatedCode(
        spliceRange(
          working,
          point,
          point,
          `${prefix}style={{ ${stylePropertySource(key)}: ${singleQuotedStringLiteral(value)} }}`,
        ),
      );
    }
  }
  return { code: validatedCode(working), inverse };
}

function removeStyleProperty(
  code: string,
  style: { attribute: t.JSXAttribute; object: t.ObjectExpression },
  property: t.ObjectProperty,
): string {
  const properties = style.object.properties;
  if (properties.length === 1) {
    // Last property → the whole style attribute goes (plus leading space).
    const [start, end] = rangeOf(style.attribute as BabelNode);
    return spliceRange(code, leadingWhitespaceStart(code, start), end, '');
  }
  const index = properties.indexOf(property);
  const [start, end] = rangeOf(property as BabelNode);
  if (index > 0) {
    const [, previousEnd] = rangeOf(properties[index - 1] as BabelNode);
    return spliceRange(code, previousEnd, end, '');
  }
  const [nextStart] = rangeOf(properties[1] as BabelNode);
  return spliceRange(code, start, nextStart, '');
}

// -------------------------------------------------------------------- text

export function applyTextEdit(
  code: string,
  nexusId: string,
  newText: string,
): { code: string; previousText: string } {
  const { element } = locateBabel(code, nexusId);
  const children = element.children;
  const textNodes = children.filter(
    (child) => child.type === 'JSXText' && child.value.trim().length > 0,
  ) as t.JSXText[];
  const nonText = children.filter((child) => child.type !== 'JSXText');
  if (textNodes.length !== 1 || nonText.length > 0) {
    throw new Error(
      'element children are not a single text node — deterministic text edit refused',
    );
  }
  const node = textNodes[0];
  const raw = node.value;
  const leading = raw.match(/^\s*/)?.[0] ?? '';
  const trailing = raw.replace(/^\s*/, '').match(/\s*$/)?.[0] ?? '';
  const previousText = raw.trim();
  const [start, end] = rangeOf(node as BabelNode);
  return {
    code: validatedCode(
      spliceRange(
        code,
        start,
        end,
        `${leading}${escapeJsxData(newText, false)}${trailing}`,
      ),
    ),
    previousText,
  };
}

// ------------------------------------------------------------- recast side

type RecastNode = recast.types.namedTypes.Node;
type JsxElement = recast.types.namedTypes.JSXElement;
type JsxAttribute = recast.types.namedTypes.JSXAttribute;

const n = recast.types.namedTypes;

function parseRecast(code: string): RecastNode {
  return recast.parse(code, {
    parser: {
      parse: (source: string) =>
        babelParse(source, {
          sourceType: 'module',
          allowImportExportEverywhere: true,
          plugins: ['jsx', 'typescript'],
          tokens: true,
        }),
    },
  });
}

function printRecast(ast: RecastNode): string {
  return validatedCode(recast.print(ast).code);
}

function recastAttribute(element: JsxElement, name: string): JsxAttribute | null {
  for (const attribute of element.openingElement.attributes ?? []) {
    if (
      n.JSXAttribute.check(attribute) &&
      n.JSXIdentifier.check(attribute.name) &&
      attribute.name.name === name
    ) {
      return attribute as JsxAttribute;
    }
  }
  return null;
}

function recastNexusIdOf(element: JsxElement): string | null {
  const attribute = recastAttribute(element, NEXUS_ID_ATTR);
  if (!attribute?.value || !n.StringLiteral.check(attribute.value)) return null;
  return attribute.value.value;
}

function locateRecast(code: string, nexusId: string): {
  ast: RecastNode;
  element: JsxElement;
  parent: JsxElement | null;
} {
  const ast = parseRecast(code);
  let element: JsxElement | null = null;
  let parent: JsxElement | null = null;
  recast.types.visit(ast, {
    visitJSXElement(path) {
      if (recastNexusIdOf(path.node) === nexusId) {
        element = path.node;
        const parentNode = path.parent?.node as RecastNode | undefined;
        parent = parentNode && n.JSXElement.check(parentNode) ? parentNode : null;
        return false;
      }
      this.traverse(path);
      return undefined;
    },
  });
  if (!element) {
    throw new Error(`no JSX element with ${NEXUS_ID_ATTR}="${nexusId}"`);
  }
  return { ast, element, parent };
}

function elementChildren(parent: JsxElement): JsxElement[] {
  return (parent.children ?? []).filter((child) =>
    n.JSXElement.check(child),
  ) as JsxElement[];
}

export function applyReorder(
  code: string,
  parentNexusId: string,
  fromIndex: number,
  toIndex: number,
): { code: string; inverse: { fromIndex: number; toIndex: number } } {
  const { ast, element: parent } = locateRecast(code, parentNexusId);
  const elements = elementChildren(parent);
  if (
    fromIndex < 0 ||
    fromIndex >= elements.length ||
    toIndex < 0 ||
    toIndex >= elements.length
  ) {
    throw new Error(`reorder index out of range (0..${elements.length - 1})`);
  }
  if (fromIndex !== toIndex) {
    const reordered = [...elements];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    // Keep whitespace/JSXText slots in place; swap only the element slots.
    const children = parent.children ?? [];
    let slot = 0;
    for (let index = 0; index < children.length; index += 1) {
      if (n.JSXElement.check(children[index])) {
        children[index] = reordered[slot];
        slot += 1;
      }
    }
  }

  return {
    code: printRecast(ast),
    inverse: { fromIndex: toIndex, toIndex: fromIndex },
  };
}

// ---------------------------------------------------------- delete/restore

export interface DeleteRestoreInfo {
  parentNexusId: string;
  index: number;
  snippet: string;
  /** Ephemeral id of the removed element (empty for untagged copies). */
  deletedNexusId: string;
}

function deleteElement(
  parent: JsxElement,
  element: JsxElement,
): DeleteRestoreInfo {
  const parentId = recastNexusIdOf(parent);
  if (!parentId) {
    throw new Error('parent element has no ephemeral id — delete refused');
  }
  const index = elementChildren(parent).indexOf(element);
  const snippet = recast.print(element).code;
  const children = parent.children ?? [];
  children.splice(children.indexOf(element), 1);
  return {
    parentNexusId: parentId,
    index,
    snippet,
    deletedNexusId: recastNexusIdOf(element) ?? '',
  };
}

export function applyDelete(
  code: string,
  nexusId: string,
): { code: string; restore: DeleteRestoreInfo } {
  const { ast, element, parent } = locateRecast(code, nexusId);
  if (!parent) {
    throw new Error('cannot delete a root JSX element deterministically');
  }
  const restore = deleteElement(parent, element);
  return { code: printRecast(ast), restore };
}

/** Delete a child by position (undo path for duplicates, which have no id). */
export function applyDeleteAt(
  code: string,
  parentNexusId: string,
  index: number,
): { code: string; restore: DeleteRestoreInfo } {
  const { ast, element: parent } = locateRecast(code, parentNexusId);
  const elements = elementChildren(parent);
  const element = elements[index];
  if (!element) {
    throw new Error(`no child element at index ${index}`);
  }
  const restore = deleteElement(parent, element);
  return { code: printRecast(ast), restore };
}

/** Read-only helper: where an element sits among its element siblings. */
export function findSiblingPosition(
  code: string,
  nexusId: string,
): { parentNexusId: string; index: number; count: number } {
  const { element, parent } = locateRecast(code, nexusId);
  if (!parent) throw new Error('element has no JSX parent');
  const parentNexusId = recastNexusIdOf(parent);
  if (!parentNexusId) throw new Error('parent element has no ephemeral id');
  const siblings = elementChildren(parent);
  return {
    parentNexusId,
    index: siblings.indexOf(element),
    count: siblings.length,
  };
}

/** Read-only helper: current string className classes of an element. */
export function getClassNames(code: string, nexusId: string): string[] {
  const { element } = locateBabel(code, nexusId);
  const attribute = findJsxAttribute(element, 'className');
  if (!attribute) return [];
  if (attribute.value?.type !== 'StringLiteral') {
    throw new Error(
      'className is a dynamic expression — deterministic edit refused (agent territory)',
    );
  }
  return attribute.value.value.split(/\s+/).filter(Boolean);
}

export function applyRestore(
  code: string,
  parentNexusId: string,
  index: number,
  snippet: string,
): { code: string } {
  const { ast, element: parent } = locateRecast(code, parentNexusId);
  const restored = elementFromSnippet(snippet);
  insertAtElementIndex(parent, restored, index);
  return { code: printRecast(ast) };
}

export function applyDuplicate(
  code: string,
  nexusId: string,
): { code: string; duplicatedFromIndex: number; parentNexusId: string } {
  const { ast, element, parent } = locateRecast(code, nexusId);
  if (!parent) throw new Error('cannot duplicate a root JSX element');
  const parentNexusId = recastNexusIdOf(parent);
  if (!parentNexusId) {
    throw new Error('parent element has no ephemeral id — duplicate refused');
  }
  const copy = elementFromSnippet(recast.print(element).code);
  // The ephemeral id must stay unique — instrumentation re-tags the copy.
  const attributes = copy.openingElement.attributes ?? [];
  const idAttribute = recastAttribute(copy, NEXUS_ID_ATTR);
  if (idAttribute) attributes.splice(attributes.indexOf(idAttribute), 1);
  const index = elementChildren(parent).indexOf(element);
  insertAtElementIndex(parent, copy, index + 1);
  return { code: printRecast(ast), duplicatedFromIndex: index, parentNexusId };
}

function elementFromSnippet(snippet: string): JsxElement {
  const ast = parseRecast(`<>${snippet}</>;`);
  let element: JsxElement | null = null;
  recast.types.visit(ast, {
    visitJSXElement(path) {
      element = path.node;
      return false;
    },
  });
  if (!element) throw new Error('snippet is not a JSX element');
  return element;
}

function insertAtElementIndex(
  parent: JsxElement,
  element: JsxElement,
  index: number,
): void {
  const children = parent.children ?? [];
  const elements = elementChildren(parent);
  const clamped = Math.max(0, Math.min(index, elements.length));
  const newline = recast.types.builders.jsxText('\n');
  if (clamped >= elements.length) {
    const anchor = elements.length
      ? children.indexOf(elements[elements.length - 1]) + 1
      : children.length;
    children.splice(anchor, 0, newline, element);
  } else {
    const anchor = children.indexOf(elements[clamped]);
    children.splice(anchor, 0, element, newline);
  }
}
