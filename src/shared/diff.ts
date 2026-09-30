import type { PageAction, PageSnapshot } from './types';

/** One element that appeared, vanished, or visibly changed between two snapshots. */
export interface DiffAdded {
  key: string;
  label: string;
  role?: string;
  kind: string;
}

export interface DiffChanged extends DiffAdded {
  changes: string[];
}

export interface ActionDiff {
  added: DiffAdded[];
  removed: DiffAdded[];
  changed: DiffChanged[];
}

const MAX_DIFF_ITEMS = 12;
const MAX_LABEL = 80;

function shortLabel(label: string): string {
  const t = (label || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return t || '(unnamed)';
}

/**
 * Stable key per offered control. Snapshot ids (e1..en) are positional and shift on
 * every re-render, but `node` is a content-script identity that survives while the
 * element is alive. Fill and click on the same editable field are distinct kinds;
 * each select option is its own offer distinguished by value.
 */
export function diffKey(a: PageAction): string | null {
  if (a.node === undefined) return null;
  if (a.kind === 'select') return `${a.node}|select|${a.value ?? ''}`;
  return `${a.node}|${a.kind}`;
}

function describe(a: PageAction): DiffAdded {
  return {
    key: diffKey(a) ?? a.id,
    label: shortLabel(a.label),
    role: a.role,
    kind: a.kind,
  };
}

/** Human-readable per-field transitions for the same control, e.g. checked false->true. */
function changedFields(before: PageAction, after: PageAction): string[] {
  const out: string[] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ['label', before.label, after.label],
    ['value', before.value ?? before.current_value ?? '', after.value ?? after.current_value ?? ''],
    ['checked', before.checked, after.checked],
    ['selected', before.selected, after.selected],
    ['expanded', before.expanded, after.expanded],
    ['href', before.href, after.href],
    ['section', before.section, after.section],
  ];
  for (const [name, b, a] of pairs) {
    const bs = String(b ?? '');
    const as = String(a ?? '');
    if (bs !== as && (bs || as)) {
      const cap = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
      out.push(`${name} ${cap(bs) || '∅'}->${cap(as) || '∅'}`);
    }
  }
  return out.slice(0, 3);
}

/**
 * Element-level diff between two observations, keyed by stable node identity.
 * Disabled/hidden targets are skipped by the snapshot itself, so a control that
 * became disabled surfaces as `removed` — callers should word it as
 * "(?disabled/hidden/covered)" rather than claiming removal.
 */
export function computeActionDiff(before: PageSnapshot | null, after: PageSnapshot | null): ActionDiff {
  const empty: ActionDiff = { added: [], removed: [], changed: [] };
  if (!before || !after) return empty;
  const bMap = new Map<string, PageAction>();
  for (const a of before.actions) {
    const k = diffKey(a);
    if (k && !bMap.has(k)) bMap.set(k, a);
  }
  const aMap = new Map<string, PageAction>();
  for (const a of after.actions) {
    const k = diffKey(a);
    if (k && !aMap.has(k)) aMap.set(k, a);
  }
  for (const [k, a] of aMap) {
    if (!bMap.has(k)) empty.added.push(describe(a));
  }
  for (const [k, b] of bMap) {
    const a = aMap.get(k);
    if (!a) {
      empty.removed.push(describe(b));
    } else {
      const changes = changedFields(b, a);
      if (changes.length > 0) empty.changed.push({ ...describe(a), changes });
    }
  }
  empty.added.sort((x, y) => x.label.localeCompare(y.label));
  empty.removed.sort((x, y) => x.label.localeCompare(y.label));
  empty.changed.sort((x, y) => x.label.localeCompare(y.label));
  return empty;
}

function fmtItem(d: DiffAdded, prefix: string, suffix = ''): string {
  const role = d.role ? ` [${d.role}]` : '';
  return `${prefix} "${d.label}"${role}${suffix}`;
}

/**
 * One-line model feed: page outcome + compact element transitions.
 * Capped so a list-heavy page cannot blow the planner/Jev context.
 */
export function formatDiffForModel(pageOutcome: string, diff: ActionDiff): string {
  const parts: string[] = [];
  if (pageOutcome) parts.push(pageOutcome);
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) return parts.length > 0 ? `${parts.join('; ')}; no control changes` : 'no visible change';
  parts.push(`controls +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
  const items: string[] = [];
  for (const a of diff.added.slice(0, MAX_DIFF_ITEMS)) items.push(fmtItem(a, '+'));
  const remaining1 = MAX_DIFF_ITEMS - items.length;
  for (const r of diff.removed.slice(0, Math.max(0, remaining1))) {
    items.push(fmtItem(r, '-', ' (?disabled/hidden/covered)'));
  }
  const remaining2 = MAX_DIFF_ITEMS - items.length;
  for (const c of diff.changed.slice(0, Math.max(0, remaining2))) {
    items.push(fmtItem(c, '~', ` (${c.changes.join(', ')})`));
  }
  const omitted = total - items.length;
  if (omitted > 0) items.push(`…+${omitted} more`);
  return `${parts.join('; ')}: ${items.join(', ')}`;
}
