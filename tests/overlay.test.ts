// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { clearBadges, renderIndexedBadges } from '../src/content/overlay';
import { getCache } from '../src/content/snapshot';

const rect = (left: number, top: number) =>
  ({ x: left, y: top, top, left, width: 100, height: 30, right: left + 100, bottom: top + 30, toJSON: () => ({}) }) as DOMRect;

function control(text: string): HTMLElement {
  const el = document.createElement('button');
  el.textContent = text;
  document.body.appendChild(el);
  // jsdom keeps every rect at zero; give the control a real box so a badge is drawn.
  el.getBoundingClientRect = () => rect(10, 20);
  return el;
}

describe('numbered vision badges', () => {
  afterEach(() => {
    clearBadges();
    document.body.innerHTML = '';
    getCache().nodes.clear();
  });

  it('draws the given element index on each element', () => {
    const a = control('A');
    const b = control('B');
    const cache = getCache();
    cache.nodes.set(1, a);
    cache.nodes.set(2, b);

    renderIndexedBadges([
      { index: '1', node: 1 },
      { index: '2', node: 2 },
    ]);
    const badges = Array.from(document.querySelectorAll<HTMLElement>('.__jev_badge'));
    expect(badges.map((x) => x.textContent)).toEqual(['1', '2']);
    expect(badges[0].style.left).toBe('8px'); // rect.left 10 - 2px nudge
    expect(badges[0].style.background).toBe('rgb(79, 70, 229)'); // #4f46e5
  });

  it('clears the badges when given an empty list', () => {
    const a = control('A');
    getCache().nodes.set(1, a);
    renderIndexedBadges([{ index: '1', node: 1 }]);
    expect(document.querySelectorAll('.__jev_badge')).toHaveLength(1);

    renderIndexedBadges([]);
    expect(document.querySelectorAll('.__jev_badge')).toHaveLength(0);
  });

  it('skips nodes that are not in the page cache', () => {
    renderIndexedBadges([{ index: '1', node: 999 }]);
    expect(document.querySelectorAll('.__jev_badge')).toHaveLength(0);
  });
});
