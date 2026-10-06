/**
 * Realm-independent node checks. A pop-out window is another JS realm: the nodes its document
 * creates are not instances of the main window's `Node` or `Element`, so `instanceof` fails for
 * them. These duck-type on `nodeType` instead (as `DockShell`'s `documentOf` does).
 */
const ELEMENT_NODE = 1;

/** The event target as a node, or null (a window, or nothing). */
export function asNode(target: EventTarget | null | undefined): Node | null {
  return target && typeof (target as Node).nodeType === 'number' ? (target as Node) : null;
}

/** The event target as an element, or null. */
export function asElement(target: EventTarget | null | undefined): Element | null {
  return asNode(target)?.nodeType === ELEMENT_NODE ? (target as Element) : null;
}
