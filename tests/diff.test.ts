import { describe, expect, it } from 'vitest';
import { computeActionDiff, diffKey, formatDiffForModel } from '../src/shared/diff';
import type { PageAction, PageSnapshot } from '../src/shared/types';

function action(partial: Partial<PageAction> & { id: string }): PageAction {
  return { kind: 'click', label: 'x', ...partial };
}

function snapshot(actions: PageAction[]): PageSnapshot {
  return {
    url: 'https://example.com',
    title: 'Example',
    w: 1280,
    h: 800,
    text: 'hello',
    scroll: { y: 0, height: 1000 },
    actions,
    omitted_actions: 0,
  };
}

describe('diffKey', () => {
  it('ignores positional ids, keys fill/click on the same node separately', () => {
    expect(diffKey(action({ id: 'e1', node: 7, kind: 'fill', label: 'Name' }))).toBe('7|fill');
    expect(diffKey(action({ id: 'e9', node: 7, kind: 'click', label: 'Open Name' }))).toBe('7|click');
  });
  it('keys each select option by value', () => {
    expect(diffKey(action({ id: 'e1', node: 3, kind: 'select', label: 'Size → M', value: 'm' }))).toBe(
      '3|select|m'
    );
  });
  it('returns null for node-less controls (scroll/wait)', () => {
    expect(diffKey(action({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down' }))).toBeNull();
  });
});

describe('computeActionDiff', () => {
  it('reports added, removed, and changed controls', () => {
    const before = snapshot([
      action({ id: 'e1', node: 1, kind: 'click', label: 'Search', role: 'button' }),
      action({ id: 'e2', node: 2, kind: 'click', label: 'Filter', role: 'checkbox', checked: 'false' }),
      action({ id: 'e3', node: 3, kind: 'fill', label: 'Name', value: '' }),
    ]);
    const after = snapshot([
      action({ id: 'e1', node: 1, kind: 'click', label: 'Search', role: 'button' }),
      action({ id: 'e2', node: 2, kind: 'click', label: 'Filter', role: 'checkbox', checked: 'true' }),
      action({ id: 'e4', node: 4, kind: 'click', label: 'Checkout', role: 'button' }),
    ]);
    const diff = computeActionDiff(before, after);
    expect(diff.added.map((a) => a.label)).toEqual(['Checkout']);
    // A control that became disabled is skipped by the snapshot: surfaces as removed.
    expect(diff.removed.map((a) => a.label)).toEqual(['Name']);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].label).toBe('Filter');
    expect(diff.changed[0].changes.join(' ')).toContain('checked');
  });

  it('is empty for identical snapshots and null-safe', () => {
    const s = snapshot([action({ id: 'e1', node: 1, kind: 'click', label: 'A' })]);
    expect(computeActionDiff(s, s)).toEqual({ added: [], removed: [], changed: [] });
    expect(computeActionDiff(null, s)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('formatDiffForModel', () => {
  it('combines page outcome with compact transitions and caps long lists', () => {
    const before = snapshot([]);
    const after = snapshot(
      Array.from({ length: 20 }, (_, i) =>
        action({ id: `e${i + 1}`, node: 100 + i, kind: 'click', label: `Item ${i}`, role: 'link' })
      )
    );
    const diff = computeActionDiff(before, after);
    const line = formatDiffForModel('page content changed (something opened)', diff);
    expect(line).toContain('page content changed');
    expect(line).toContain('+20');
    expect(line).toContain('more');
  });

  it('words removals as possibly disabled, not deleted', () => {
    const before = snapshot([action({ id: 'e1', node: 1, kind: 'click', label: 'Buy', role: 'button' })]);
    const line = formatDiffForModel('no visible change', computeActionDiff(before, snapshot([])));
    expect(line).toContain('?disabled/hidden');
  });
});
