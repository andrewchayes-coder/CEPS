import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProtectedData } from '../components/protected-data';
import { TableCell } from '../components/ui/table';
import { formatMoney } from './utils';
import { installBrowserTranslationGuard } from './browser-translation';

test('translation guard handles only detached children and references and installs once', () => {
  class FakeNode {
    parentNode: FakeNode | null = null;
    children: FakeNode[] = [];
    removeChild<T extends FakeNode>(child: T): T {
      const index = this.children.indexOf(child);
      if (index < 0) throw new Error('NotFoundError: removeChild');
      this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }
    insertBefore<T extends FakeNode>(child: T, reference: FakeNode | null): T {
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      if (index < 0) throw new Error('NotFoundError: insertBefore');
      this.children.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }
  }
  const first = new FakeNode(), other = new FakeNode(), text = new FakeNode();
  other.insertBefore(text, null);
  installBrowserTranslationGuard(FakeNode as unknown as typeof Node);
  const patchedRemove = FakeNode.prototype.removeChild;
  installBrowserTranslationGuard(FakeNode as unknown as typeof Node);
  assert.equal(FakeNode.prototype.removeChild, patchedRemove);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    assert.equal(first.removeChild(text), text);
    const inserted = new FakeNode();
    assert.equal(first.insertBefore(inserted, text), inserted);
    assert.equal(inserted.parentNode, null);
    assert.equal(text.parentNode, other);
    assert.deepEqual(first.children, []);
    assert.equal(warnings.length, 2);
    first.insertBefore(inserted, null);
    assert.equal(inserted.parentNode, first);
    assert.equal(first.removeChild(inserted), inserted);
    assert.equal(inserted.parentNode, null);
    assert.throws(() => first.removeChild(null as unknown as FakeNode), /NotFoundError/);
  } finally {
    console.warn = originalWarn;
  }
});

test('record values are marked untranslated; surrounding labels remain translatable', () => {
  const html = renderToStaticMarkup(createElement('p', null, 'Total: $',
    createElement(ProtectedData, null, formatMoney('160')), ' due'));
  assert.match(html, /Total: \$<span translate="no" class="notranslate">160\.00<\/span> due/);
  const cells = renderToStaticMarkup(createElement('table', null,
    createElement('tbody', null, createElement('tr', null,
      createElement(TableCell, null, '09/2026'),
      createElement(TableCell, null, '459'),
      createElement(TableCell, null, 'Paid')))));
  assert.match(cells, /translate="no" class="notranslate">09\/2026<\/span>/);
  assert.match(cells, /translate="no" class="notranslate">459<\/span>/);
  assert.match(cells, /<td class="[^"]*">Paid<\/td>/);
});
