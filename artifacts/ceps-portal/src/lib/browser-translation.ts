/**
 * Browser translators can replace React-owned text nodes with <font> elements.
 * Ignore only the resulting detached-child operations, not unrelated DOM errors.
 * https://github.com/facebook/react/issues/11538
 */
const installed = Symbol.for('ceps.browserTranslationGuard');

export function installBrowserTranslationGuard(nodeType: Pick<typeof Node, 'prototype'> = Node): void {
  const prototype = nodeType.prototype;
  if ((prototype as unknown as Record<symbol, boolean>)[installed]) return;
  const removeChild = prototype.removeChild;
  const insertBefore = prototype.insertBefore;

  prototype.removeChild = function<T extends Node>(this: Node, child: T): T {
    if (child && child.parentNode !== this) {
      console.warn('[CEPS browser translation] Skipped removeChild for a detached text node.');
      return child;
    }
    return removeChild.call(this, child) as T;
  };
  prototype.insertBefore = function<T extends Node>(this: Node, child: T, reference: Node | null): T {
    if (reference && reference.parentNode !== this) {
      console.warn('[CEPS browser translation] Skipped insertBefore for a detached reference node.');
      return child;
    }
    return insertBefore.call(this, child, reference) as T;
  };
  Object.defineProperty(prototype, installed, { value: true });
}
