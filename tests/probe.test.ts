// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { getCache, probePoint } from '../src/content/snapshot';

const rect = (left: number, top: number, width = 100, height = 30) =>
  ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

function control(text: string, box: { l: number; t: number; w?: number; h?: number }): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = text;
  document.body.appendChild(el);
  el.getBoundingClientRect = () => rect(box.l, box.t, box.w, box.h);
  return el;
}

describe('probePoint', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    getCache().nodes.clear();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it('names the element under the point even when it is not offered', () => {
    const overlay = control('Got it', { l: 20, t: 60, w: 80, h: 24 });
    (document as any).elementFromPoint = (x: number, y: number) => (x >= 20 && x <= 100 && y >= 60 && y <= 84 ? overlay : null);

    const [hit] = probePoint(60, 70);
    expect(hit).toMatchObject({ tag: 'button', label: 'Got it', distance: 0 });
    expect(hit.node).toBeUndefined(); // not in the cache = no index for it
    expect(hit.covered).toBeUndefined();
  });

  it('maps a cached point to its node and keeps only elements within the radius', () => {
    const near = control('Save', { l: 100, t: 100, w: 80, h: 30 });
    const far = control('Cancel', { l: 400, t: 100, w: 80, h: 30 });
    const cache = getCache();
    cache.nodes.set(1, near);
    cache.nodes.set(2, far);
    cache.ids.set(near, 1);
    (document as any).elementFromPoint = () => near;

    const found = probePoint(110, 110); // inside Save's rect, 290px from Cancel
    expect(found.find((c) => c.label === 'Save')?.node).toBe(1);
    expect(found.some((c) => c.label === 'Cancel')).toBe(false);
    expect(found[0].distance).toBe(0); // the hit ranks first
  });

  it('returns nothing when the point hits nothing and the cache is empty', () => {
    (document as any).elementFromPoint = () => null;
    expect(probePoint(5, 5)).toEqual([]);
  });
});
