import { describe, expect, it, vi } from 'vitest';
import {
  JEV_CAPABILITY_CARD,
  PLANNER_SYSTEM_PROMPT,
  PLANNER_TOOLS,
  buildJevSubgoalTask,
  buildLabelEntries,
  buildPlannerObservation,
  buildPlannerSystemPrompt,
  buildPlannerTools,
  buildScreenshotNote,
  callPlanner,
  screenRelativeToCss,
  visionShotKey,
} from '../src/shared/planner';
import { DEFAULT_SETTINGS, ObservedElement, PageAction } from '../src/shared/types';

describe('planner contract', () => {
  it('exposes exactly the three base tools', () => {
    const names = PLANNER_TOOLS.map((t) => t.function.name).sort();
    expect(names).toEqual(['browser_act', 'jev_delegate', 'task_finish']);
  });

  it('adds the vision pair only when screenshots are enabled', () => {
    const off = buildPlannerTools({ ...DEFAULT_SETTINGS, screenshotsEnabled: false }).map((t) => t.function.name);
    expect(off).not.toContain('take_screenshot');
    expect(off).not.toContain('screen_act');
    expect(off).not.toContain('locate_at');
    const on = buildPlannerTools({ ...DEFAULT_SETTINGS, screenshotsEnabled: true }).map((t) => t.function.name);
    expect(on).toContain('take_screenshot');
    expect(on).toContain('screen_act');
    expect(on).toContain('locate_at');
  });

  it('maps 0-1000 screenshot units onto CSS viewport pixels', () => {
    expect(screenRelativeToCss(500, 500, 1280, 800)).toEqual({ x: 640, y: 400 });
    expect(screenRelativeToCss(-5, 1200, 1000, 1000)).toEqual({ x: 0, y: 1000 });
  });

  it('mentions screenshots in the system prompt only when enabled', () => {
    expect(buildPlannerSystemPrompt({ ...DEFAULT_SETTINGS, screenshotsEnabled: false })).not.toContain('take_screenshot');
    expect(buildPlannerSystemPrompt({ ...DEFAULT_SETTINGS, screenshotsEnabled: true })).toContain('take_screenshot');
  });

  it('tells the planner Jev cannot type', () => {
    expect(`${PLANNER_SYSTEM_PROMPT} ${JEV_CAPABILITY_CARD}`).toMatch(/CANNOT TYPE_TEXT/);
    expect(PLANNER_SYSTEM_PROMPT).toContain('jev_delegate');
  });

  it('caps delegate budgets at 12 steps', () => {
    const delegate = PLANNER_TOOLS.find((t) => t.function.name === 'jev_delegate')!;
    const props = delegate.function.parameters.properties as unknown as Record<string, { maximum?: number }>;
    expect(props.maxSteps.maximum).toBe(12);
  });

  it('wraps subgoals so the Jev side blocks on typing instead of guessing', () => {
    const task = buildJevSubgoalTask('Open results', 'Find hotels');
    expect(task).toContain('needs text');
    expect(task).toContain('BLOCKED');
  });

  it('accepts content:null next to tool_calls (common provider shape)', async () => {    const providerMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'task_finish', arguments: '{"status":"blocked"}' } },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: providerMessage }] }) }))
    );
    try {
      const res = await callPlanner(
        { ...DEFAULT_SETTINGS, textHelper: { ...DEFAULT_SETTINGS.textHelper, apiKey: 'test-key' } },
        [{ role: 'user', content: 'hi' }]
      );
      expect(res.toolCall?.name).toBe('task_finish');
      expect(res.message.content).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts a native screen_act call only when the vision tools are offered', async () => {
    const screenCall = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'screen_act', arguments: '{"x":10,"y":20,"action":"click"}' } },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: screenCall }] }) }))
    );
    try {
      const vision = {
        ...DEFAULT_SETTINGS,
        screenshotsEnabled: true,
        textHelper: { ...DEFAULT_SETTINGS.textHelper, apiKey: 'test-key' },
      };
      const res = await callPlanner(vision, [{ role: 'user', content: 'hi' }]);
      expect(res.toolCall).toEqual({ name: 'screen_act', args: { x: 10, y: 20, action: 'click' } });

      // The same call is refused when screen_act was not among the offered tools.
      await expect(
        callPlanner({ ...vision, screenshotsEnabled: false }, [{ role: 'user', content: 'hi' }])
      ).rejects.toThrow(/unknown tool "screen_act"/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns a null tool call (not a throw) when the model just chats', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Let me think…' }, finish_reason: 'stop' }] }),
      }))
    );
    try {
      const res = await callPlanner(
        { ...DEFAULT_SETTINGS, textHelper: { ...DEFAULT_SETTINGS.textHelper, apiKey: 'test-key' } },
        [{ role: 'user', content: 'hi' }]
      );
      expect(res.toolCall).toBeNull();
      expect(res.content).toBe('Let me think…');
      expect(res.finishReason).toBe('stop');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('always includes the goal and caps elements/text in the observation', () => {
    const elements = Array.from({ length: 80 }, (_, i) => ({ index: `${i + 1}`, label: `Item ${i}`, operations: ['CLICK'] }));
    const obs = buildPlannerObservation(
      'Create a Google Form quiz',
      { url: 'https://www.google.com/', title: 'Google', text: 'x'.repeat(5000), omitted_actions: 3 },
      elements,
      [],
      null,
      'a warning'
    );
    expect(obs.goal).toBe('Create a Google Form quiz');
    expect(obs.elements).toHaveLength(60);
    expect(obs.omitted).toBe(3 + 20);
    expect(obs.text).toHaveLength(4000);
    expect(obs.warning).toBe('a warning');
  });

  it('labels exactly the offered elements, collapsing a shared fill/click node', () => {
    const elements: ObservedElement[] = [
      { index: '1', label: 'Search', operations: ['CLICK'] },
      { index: '2', label: 'Where from?', operations: ['TYPE_TEXT', 'CLICK'] },
      { index: '3', label: 'Class', operations: ['SELECT'] },
    ];
    const targets: Record<string, Record<string, PageAction>> = {
      CLICK: {
        '1': { id: 'e1', node: 11, kind: 'click', label: 'Search' },
        '2': { id: 'e3', node: 22, kind: 'click', label: 'Open Where from?' },
      },
      TYPE_TEXT: { '2': { id: 'e2', node: 22, kind: 'fill', label: 'Where from?' } },
      SELECT: {
        '3:1': { id: 'e4', node: 33, kind: 'select', label: 'Class → A' },
        '3:2': { id: 'e5', node: 33, kind: 'select', label: 'Class → B' },
      },
    };

    expect(buildLabelEntries(elements, targets)).toEqual([
      { index: '1', node: 11 },
      { index: '2', node: 22 },
      { index: '3', node: 33 },
    ]);
    // An element outside the offered (capped) list is never labeled.
    expect(buildLabelEntries(elements.slice(0, 1), targets)).toEqual([{ index: '1', node: 11 }]);
  });

  it('reuses a screenshot only while url and labeled elements are unchanged', () => {
    const one = [{ index: '1', node: 11 }];
    expect(visionShotKey('u', one)).toBe(visionShotKey('u', [...one]));
    expect(visionShotKey('u', one)).not.toBe(visionShotKey('v', one));
    expect(visionShotKey('u', one)).not.toBe(visionShotKey('u', [{ index: '1', node: 12 }]));
  });

  it('describes the screenshot and its numbered boxes in the attached note', () => {
    const note = buildScreenshotNote('https://example.com/form');
    expect(note).toContain('https://example.com/form');
    expect(note).toContain('#4f46e5');
    expect(note).toContain('[index]');
    expect(note).toContain('screen_act');
    expect(note.toLowerCase()).toContain('screenshot');
  });
});
