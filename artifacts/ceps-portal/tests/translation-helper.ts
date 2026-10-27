import type { Page } from '@playwright/test';

/** Model a browser translator replacing visible React text nodes with <font>. */
export async function simulateBrowserTranslation(page: Page): Promise<number> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const visible: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent
        || parent.closest('font, script, style, noscript, textarea, [translate="no"], .notranslate, [contenteditable="true"]')
        || !parent.getClientRects().length
        || getComputedStyle(parent).visibility === 'hidden'
        || getComputedStyle(parent).display === 'none') continue;
      visible.push(node as Text);
    }
    for (const text of visible) {
      const font = document.createElement('font');
      font.textContent = text.textContent;
      text.replaceWith(font);
    }
    return visible.length;
  });
}
