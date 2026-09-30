import { buildJevRequest, validateChoiceAnswer, buildActionSpace } from '../shared/action-space';
import { computeActionDiff, formatDiffForModel } from '../shared/diff';
import { activeJevModel, callJevProvider } from '../shared/providers';
import {
  buildJevSubgoalTask,
  buildLabelEntries,
  buildPlannerObservation,
  buildPlannerSystemPrompt,
  buildScreenshotNote,
  callPlanner,
  screenRelativeToCss,
  visionShotKey,
  type ChatMessage,
  type PlannerObservation,
} from '../shared/planner';
import { createFieldContext, generateFieldText } from '../shared/text-helper';
import {
  ActResult,
  AgentProgress,
  ChoiceQuestion,
  AgentStepLog,
  AppSettings,
  DEFAULT_SETTINGS,
  JevDelegateResult,
  JevSubStep,
  ObservedElement,
  PageAction,
  PageSnapshot,
  PrepareResult,
  ProbeCandidate,
  RecentAction,
} from '../shared/types';
import { TrustedInput } from './input';

/** Semantic fingerprint of an observation: URL, scroll, visible text and the element table. */
export function computePageFingerprint(snapshot: PageSnapshot): string {
  const semantics = snapshot.actions.map(({ rect, ...a }) => a);
  return JSON.stringify([snapshot.url, Math.round(snapshot.scroll.y), snapshot.text, semantics]);
}

interface PageSummary {
  url: string;
  title: string;
  textLength: number;
  scrollY: number;
  fingerprint: string;
}

const summarize = (s: PageSnapshot): PageSummary => ({
  url: s.url,
  title: s.title,
  textLength: s.text.length,
  scrollY: s.scroll.y,
  fingerprint: computePageFingerprint(s),
});

/** Describes, in words the model can use, what an action visibly did. */
export function describeOutcome(before: PageSummary, after: PageSummary): string {
  if (after.url !== before.url) return `navigated to ${after.url}`;
  if (after.title !== before.title) return `page changed: "${after.title}"`;
  if (Math.abs(after.textLength - before.textLength) > 50) return 'page content changed (something opened, closed or loaded; same URL)';
  if (Math.abs(after.scrollY - before.scrollY) > 40) return 'scrolled';
  if (after.fingerprint !== before.fingerprint) return 'minor change on the page';
  return 'no visible change';
}

/** DONE / BLOCKED are accepted only when the independent cross-check does not contradict them. */
const GOAL_DONE_MIN = 0.5;
const STUCK_MIN = 0.5;

/**
 * Errors Chrome raises when the page navigated (or its document was replaced) while a message
 * was in flight. The action itself ran; only the reply was lost.
 */
export function isNavigationError(message: string): boolean {
  return (
    /back\/forward cache/i.test(message) ||
    /message (channel|port) (is |was )?closed/i.test(message) ||
    /Receiving end does not exist/i.test(message) ||
    /Frame was removed/i.test(message) ||
    /Extension context invalidated/i.test(message)
  );
}

const OP_BY_KIND: Record<string, string> = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT', scroll: '', wait: '', key: '' };

/** Scroll/enter are page-manipulation controls, not targets: viewport-only observation
 * requires repeating them, so the repeat block ignores them. A scroll that changes
 * nothing still trips the no-change deadlock guard, and the step budget bounds the rest. */
const REPEAT_EXEMPT_KINDS = new Set(['scroll', 'key', 'wait']);

/** True for control kinds the repeat block ignores; an unknown kind is never exempt. */
function isRepeatExempt(kind: string | undefined): boolean {
  return kind !== undefined && REPEAT_EXEMPT_KINDS.has(kind);
}

/**
 * Stable per-target identity for failure counting. Snapshot ids (e1…en) are positional:
 * after any re-render they can name a different element, so counting or suppressing by
 * id withholds innocent controls. Kind + label survives re-renders.
 */
function stableTargetKey(action: Pick<PageAction, 'kind' | 'label'>): string {
  return `${action.kind}:${action.label}`;
}

function readNoul(answer: any): number | undefined {
  const v = answer?.noul ?? answer?.probability;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

const INTERNAL_PREFIXES = ['chrome://', 'chrome-extension://', 'chrome-untrusted://', 'edge://', 'about:', 'view-source:', 'devtools://'];

const MAX_CONSECUTIVE_STALE = 4;
/** DONE/BLOCKED below this confidence is confirmed by a second look before the run ends. */
const TERMINAL_CONFIRM_THRESHOLD = 0.5;
const DEADLOCK_RUN = 3;
/** Same target executed this many times within the last REPEAT_WINDOW actions ends the run. */
const REPEAT_LIMIT = 3;
const REPEAT_WINDOW = 6;

export class AgentRunner {
  private progress: AgentProgress = {
    status: 'idle',
    goal: '',
    currentStep: 0,
    maxSteps: DEFAULT_SETTINGS.maxSteps,
    logs: [],
  };

  private settings: AppSettings = DEFAULT_SETTINGS;
  private history: RecentAction[] = [];
  private activeTabId: number | null = null;
  private runToken = 0;
  /** Cancels in-flight provider/text-helper requests when the run stops. */
  private providerAbort: AbortController | null = null;

  /** Starts a fresh abort scope, cancelling any request from the previous scope. */
  private newProviderScope(): AbortSignal {
    this.providerAbort?.abort();
    this.providerAbort = new AbortController();
    return this.providerAbort.signal;
  }

  private lastFingerprint: string | null = null;
  private lastSummary: PageSummary | null = null;
  /** Previous observation: element-level diffs are computed against it. */
  private lastSnapshot: PageSnapshot | null = null;
  /** Tabs the run came from, most recent last, so a closed follow-up tab returns to its opener. */
  private tabStack: number[] = [];
  private pendingTab: { from: number; to: number; closed: boolean } | null = null;
  private tabNote: string | null = null;
  /** Trusted input via chrome.debugger; attached per run when the setting is on and permitted. */
  private input = new TrustedInput();

  constructor() {
    this.input.onCancelled = () => {
      if (this.progress.status !== 'running') return;
      this.stop();
      this.progress.lastError = 'Stopped: debugging was cancelled from the browser bar.';
      this.broadcastUpdate();
    };
    // A click may open a new tab (target=_blank, window.open). Like a person, the agent
    // follows it; when that tab closes it returns to the tab that opened it.
    try {
      chrome.tabs.onCreated.addListener((tab) => this.onTabCreated(tab));
      chrome.tabs.onRemoved.addListener((tabId) => this.onTabRemoved(tabId));
    } catch {
      // Not running inside an extension (unit tests without tab events)
    }
  }

  private onTabCreated(tab: chrome.tabs.Tab): void {
    if (this.progress.status !== 'running' || tab.id === undefined) return;
    if (this.activeTabId === null || tab.openerTabId !== this.activeTabId) return;
    this.tabStack.push(this.activeTabId);
    this.pendingTab = { from: this.activeTabId, to: tab.id, closed: false };
    this.activeTabId = tab.id;
  }

  private onTabRemoved(tabId: number): void {
    // A closed tab is never a way back, no matter where it sits on the stack: drop it so a
    // later return cannot land on a dead tab (e.g. the opener closed while on the child).
    this.tabStack = this.tabStack.filter((id) => id !== tabId);
    if (tabId !== this.activeTabId) return;
    if (this.tabStack.length === 0) {
      // Nothing to return to; followTab resolves the window's current tab (to: -1).
      this.pendingTab = { from: tabId, to: -1, closed: true };
      return;
    }
    const back = this.tabStack.pop()!;
    this.pendingTab = { from: tabId, to: back, closed: true };
    this.activeTabId = back;
  }

  /** Brings a newly opened (or restored) tab to the front and waits for it before observing. */
  private async followTab(): Promise<void> {
    const pending = this.pendingTab;
    if (!pending) return;
    this.pendingTab = null;
    if (pending.to === -1) {
      // The active tab closed with no opener on the stack: continue on whatever tab is
      // now frontmost instead of observing a dead tab id.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const current = tabs?.[0]?.id;
      if (current === undefined) {
        this.activeTabId = null;
        return;
      }
      this.activeTabId = current;
      this.lastFingerprint = null;
      this.tabNote = 'the tab closed; continuing on the current tab';
      this.targetFailureCount.clear();
      this.lastTargetKey = null;
      await this.waitForTabToLoad(current);
      await this.attachInput(current);
      this.sendStatus({ text: this.tabNote });
      return;
    }
    this.lastFingerprint = null; // a different document: the previous action's outcome is "opened a tab"
    this.tabNote = pending.closed ? 'the tab closed; back on the previous tab' : 'opened a new tab and switched to it';
    // A different document: per-target failure history belongs to the old page.
    this.targetFailureCount.clear();
    this.lastTargetKey = null;
    await chrome.tabs.update(pending.to, { active: true }).catch(() => undefined);
    await this.waitForTabToLoad(pending.to);
    await this.attachInput(pending.to);
    this.sendStatus({ text: this.tabNote });
  }
  private startUrl = '';
  private visitedUrls: string[] = [];
  private consecutiveStale = 0;
  private decisionCount = 0;
  private targetFailureCount = new Map<string, number>();
  private lastTargetKey: string | null = null;
  private lastStaleNotice: string | null = null;
  private pendingTerminal: string | null = null;
  private vetoed: 'DONE' | 'BLOCKED' | null = null;
  /** Verdicts already withheld once this run; a repeat proposal is accepted (README: withheld once). */
  private vetoedBefore = new Set<'DONE' | 'BLOCKED'>();
  /** One inconsistent answer is asked again; a second one ends the run. */
  private invalidAnswerRetried = false;
  /** Text generated for a decision that turned out stale; reused only for an identical helper input. */
  private pendingText: { key: string; text: string } | null = null;
  /** Planner-mode conversation (system + observation/tool turns), trimmed to recent. */
  private plannerMessages: ChatMessage[] = [];
  private plannerIters = 0;
  private lastDelegate: JevDelegateResult | null = null;
  /** Chatty turns without a tool call: nudged, then the run ends quoting the model. */
  private plannerNudges = 0;
  /** url + labeled-element signature of the last vision screenshot, to skip redundant captures. */
  private lastVisionKey: string | null = null;

  public setSettings(settings: AppSettings): void {
    this.settings = settings;
    if (this.progress.status !== 'running') {
      this.progress.maxSteps = settings.maxSteps || DEFAULT_SETTINGS.maxSteps;
      return;
    }
    // Mid-run change: trusted input follows the toggle immediately. Turning it off detaches
    // (act also checks the setting, so a detach race cannot keep CDP in use); turning it on
    // attaches now instead of waiting for the next tab switch.
    if (!settings.trustedInput) {
      void this.input.detach();
    } else if (this.activeTabId !== null) {
      void this.attachInput(this.activeTabId);
    }
  }

  public getProgress(): AgentProgress {
    return this.progress;
  }

  private reset(goal: string, tabId: number): void {
    this.runToken++;
    this.newProviderScope();
    this.activeTabId = tabId;
    this.history = [];
    this.lastFingerprint = null;
    this.lastSummary = null;
    this.lastSnapshot = null;
    this.tabStack = [];
    this.pendingTab = null;
    this.tabNote = null;
    this.startUrl = '';
    this.visitedUrls = [];
    this.consecutiveStale = 0;
    this.decisionCount = 0;
    this.targetFailureCount.clear();
    this.lastTargetKey = null;
    this.lastStaleNotice = null;
    this.pendingTerminal = null;
    this.vetoed = null;
    this.vetoedBefore.clear();
    this.invalidAnswerRetried = false;
    this.pendingText = null;
    this.plannerMessages = [];
    this.plannerIters = 0;
    this.lastDelegate = null;
    this.plannerNudges = 0;
    this.lastVisionKey = null;
    this.progress = {
      status: 'running',
      goal,
      currentStep: 0,
      maxSteps: this.settings.maxSteps || DEFAULT_SETTINGS.maxSteps,
      logs: [],
    };
  }

  public async start(goal: string, tabId: number): Promise<void> {
    if (this.progress.status === 'running') return;
    this.reset(goal, tabId);
    const token = this.runToken;
    this.broadcastUpdate();
    await this.attachInput(tabId);
    if (token !== this.runToken) return;
    await this.loop(token);
  }

  /** Executes exactly one step. A new goal, or a finished run, starts over; a paused run continues. */
  public async step(goal: string, tabId: number): Promise<void> {
    if (this.progress.status === 'running') return;
    const continuing = this.progress.status === 'paused' && goal === this.progress.goal && tabId === this.activeTabId;
    if (!continuing) {
      this.reset(goal, tabId);
    } else {
      this.runToken++;
      this.newProviderScope();
      this.progress.status = 'running';
    }
    const token = this.runToken;

    if (this.progress.currentStep >= this.progress.maxSteps) {
      this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget.`);
      return;
    }

    this.broadcastUpdate();
    await this.attachInput(tabId);
    if (token !== this.runToken) return;
    let cont: boolean;
    try {
      cont = await this.executeOneStep(token);
    } catch (err: any) {
      // H4: an unexpected throw (malformed snapshot, logging) must end the run, not wedge at "running".
      if (token !== this.runToken) return;
      this.finish('error', `Step failed: ${err?.message || String(err)}`);
      return;
    }
    if (token === this.runToken && this.progress.status === 'running') {
      this.progress.status = cont ? 'paused' : 'idle';
    }
    if (this.progress.status !== 'running') void this.input.detach();
    this.broadcastUpdate();
  }

  public stop(): void {
    this.runToken++;
    this.providerAbort?.abort();
    void this.input.detach();
    if (this.progress.status === 'running' || this.progress.status === 'paused') {
      this.progress.status = 'idle';
    }
    this.broadcastUpdate();
    this.sendStatus({ clear: true });
  }

  private async loop(token: number): Promise<void> {
    while (token === this.runToken && this.progress.status === 'running') {
      if (this.progress.currentStep >= this.progress.maxSteps) {
        this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget without DONE.`);
        break;
      }
      let cont: boolean;
      try {
        cont = await this.executeOneStep(token);
      } catch (err: any) {
        // H4: anything thrown outside the per-stage handlers must end the run, not wedge at "running".
        if (token !== this.runToken) break;
        this.finish('error', `Step failed: ${err?.message || String(err)}`);
        break;
      }
      if (!cont) break;
      if (this.settings.stepDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.settings.stepDelayMs));
      }
    }
  }

  /** Resolves when the tab finishes loading, or after a timeout. */
  private async waitForTabToLoad(tabId: number, timeoutMs = 8000): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
      };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.status === 'complete') finish();
        })
        .catch(() => finish());
      setTimeout(finish, timeoutMs);
    });
    // Let the new document run its first frames before observing.
    await new Promise((r) => setTimeout(r, 150));
  }

  private lastPingError = '';

  private async ping(tabId: number): Promise<boolean> {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return !!res?.pong;
    } catch (err: any) {
      this.lastPingError = err?.message || String(err);
      return false;
    }
  }

  /** Makes sure a single content script instance is listening in the tab. */
  private async ensureContentScriptReady(tabId: number, token?: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    if (token !== undefined && token !== this.runToken) throw new DOMException('Stopped', 'AbortError');
    const url = tab.url || '';
    if (INTERNAL_PREFIXES.some((p) => url.startsWith(p))) {
      throw new Error(
        `Cannot run on internal browser page (${url}). Open a regular web page and try again.`
      );
    }
    // Inject as soon as a document exists instead of waiting for the load event: the script
    // guards against double registration, so a later manifest injection is harmless.
    let injectError = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      if (token !== undefined && token !== this.runToken) throw new DOMException('Stopped', 'AbortError');
      if (await this.ping(tabId)) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch (err: any) {
        injectError = err?.message || String(err);
      }
      const current = attempt >= 3 ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (current?.status === 'loading') await this.waitForTabToLoad(tabId, 2000);
      else await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    if (!(await this.ping(tabId))) {
      throw new Error(
        `Content script did not respond after injection (${this.lastPingError || 'no reply'}${injectError ? `; inject: ${injectError}` : ''}). Reload the page and try again.`
      );
    }
  }

  /**
   * One observe → decide → act cycle. Returns false when the run has ended.
   * A stale decision is discarded and the page is observed again without recording a step.
   */
  private async executeOneStep(token: number): Promise<boolean> {
    await this.followTab();
    if (token !== this.runToken) return false;
    const tabId = this.activeTabId;
    if (tabId === null) {
      this.finish('error', 'No active tab identified');
      return false;
    }

    // 1. Observe (M1: one retry for navigation races; the click that caused the
    //    navigation must not kill the run it just triggered)
    let snapshot: PageSnapshot;
    try {
      await this.ensureContentScriptReady(tabId, token);
      const observeOnce = () => chrome.tabs.sendMessage(tabId, { type: 'CONTENT_OBSERVE' });
      let response = await observeOnce();
      if ((!response?.success || !response.snapshot) && isNavigationError(response?.error || '')) {
        await this.waitForTabToLoad(tabId);
        if (token !== this.runToken) return false;
        response = await observeOnce();
      }
      if (!response?.success || !response.snapshot) {
        throw new Error(response?.error || 'Failed to capture page DOM snapshot');
      }
      snapshot = response.snapshot;
    } catch (err: any) {
      // H2: Stop during observe/injection is silent, not an error finish.
      if (token !== this.runToken || err?.name === 'AbortError') return false;
      const message = err?.message || String(err);
      if (isNavigationError(message)) {
        try {
          await this.waitForTabToLoad(tabId);
        } catch {
          // ignore wait failures; the retry decides
        }
        if (token !== this.runToken) return false;
        try {
          const retry = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_OBSERVE' });
          if (retry?.success && retry.snapshot) {
            snapshot = retry.snapshot;
          } else {
            throw new Error(retry?.error || 'Failed to capture page DOM snapshot');
          }
        } catch (retryErr: any) {
          if (token !== this.runToken || retryErr?.name === 'AbortError') return false;
          this.finish('error', `Observe failed: ${retryErr?.message || String(retryErr)}`);
          return false;
        }
      } else {
        this.finish('error', `Observe failed: ${message}`);
        return false;
      }
    }
    if (token !== this.runToken) return false;

    // 2. Resolve what the previous action did and detect deadlocks
    const summary = summarize(snapshot);
    const fingerprint = summary.fingerprint;
    if (!this.startUrl) this.startUrl = snapshot.url;
    if (this.visitedUrls[this.visitedUrls.length - 1] !== snapshot.url) this.visitedUrls.push(snapshot.url);
    const last = this.history[this.history.length - 1];
    if (last && last.page_changed === undefined && this.tabNote) {
      last.outcome = `${this.tabNote}: ${snapshot.url}`;
      last.url = snapshot.url;
      last.page_changed = true;
      this.tabNote = null;
    } else if (last && last.page_changed === undefined && this.lastSummary) {
      last.outcome = describeOutcome(this.lastSummary, summary);
      last.url = snapshot.url;
      last.page_changed = fingerprint !== this.lastFingerprint;
      if (!last.page_changed && this.lastTargetKey && last.kind !== 'wait') {
        const count = (this.targetFailureCount.get(this.lastTargetKey) || 0) + 1;
        this.targetFailureCount.set(this.lastTargetKey, count);
      } else if (last.page_changed) {
        this.targetFailureCount.clear();
      }
    }
    this.lastFingerprint = fingerprint;
    this.lastSummary = summary;
    this.attachDiffToLastStep(snapshot);
    this.lastSnapshot = snapshot;

    const recent = this.history.slice(-DEADLOCK_RUN);
    if (
      recent.length === DEADLOCK_RUN &&
      recent.every((h) => h.page_changed === false && h.kind !== 'wait')
    ) {
      this.finish(
        'blocked',
        `${DEADLOCK_RUN} consecutive actions produced no change on the page. Inspect the page or adjust the goal.`
      );
      return false;
    }

    // 3. Loop feedback for the model. Toggling the same control (a menu that opens and closes)
    //    changes the page every time, so repeats are tracked separately from "no change".
    let warning: string | undefined;
    const repeatedAction = last?.action && !isRepeatExempt(last.kind) ? last.action : null;
    const repeated = repeatedAction ? this.repeatCount(repeatedAction) : 0;
    if (repeated >= REPEAT_LIMIT) {
      this.finish('blocked', `The same action "${repeatedAction}" was repeated ${repeated} times without reaching the goal.`);
      return false;
    }
    // Failure counts are keyed by stable kind+label identity; resolve them to this
    // snapshot's positional ids so suppression always names the current elements.
    const suppressedKeys = new Set(
      Array.from(this.targetFailureCount.entries())
        .filter(([, count]) => count >= 2)
        .map(([key]) => key)
    );
    const suppressedTargetIds: string[] = [];
    for (const a of snapshot.actions) {
      if (a.node !== undefined && suppressedKeys.has(stableTargetKey(a))) suppressedTargetIds.push(a.id);
    }
    if (last && last.page_changed === false && last.kind !== 'wait') {
      warning = `ATTENTION: Previous action "${last.action}" resulted in NO visible change on the page. Do NOT repeat the exact same action. Try an alternative target, scroll, or submit button.`;
    } else if (repeated >= 2 && repeatedAction) {
      warning = `ATTENTION: "${repeatedAction}" has now been executed ${repeated} times and did not advance the goal. Do NOT choose it again; use a different control that moves toward the goal.`;
      // Ids are per snapshot; withhold whatever on this page carries the same operation and label.
      for (const a of snapshot.actions) {
        if (a.node !== undefined && `${OP_BY_KIND[a.kind] || ''} ${a.label}` === repeatedAction) suppressedTargetIds.push(a.id);
      }
    } else if (this.lastStaleNotice) {
      warning = this.lastStaleNotice;
    }
    this.lastStaleNotice = null;

    // 4. Decide
    if (this.decisionCount >= this.progress.maxSteps * 2) {
      this.finish('blocked', 'Reached the model-call budget for this run.');
      return false;
    }
    const { request, actionSpace } = buildJevRequest(
      activeJevModel(this.settings),
      snapshot,
      this.progress.goal,
      this.history,
      { warning, suppressedTargetIds },
      { start_url: this.startUrl, steps_taken: this.history.length, visited_urls: this.visitedUrls.slice(-6) }
    );
    if (this.vetoed) {
      // The previous verdict was contradicted by its cross-check; withhold it this time.
      delete actionSpace.operations[this.vetoed];
      delete (request.questions.operation as ChoiceQuestion).criteria[this.vetoed];
      this.vetoed = null;
    }

    const started = Date.now();
    let jevResponse;
    try {
      this.decisionCount++;
      jevResponse = await callJevProvider(this.settings, request, { signal: this.providerAbort?.signal });
    } catch (err: any) {
      // H2: a Stop-aborted decision is silent; it must not overwrite the idle status with an error.
      if (token !== this.runToken || err?.name === 'AbortError') return false;
      this.finish('error', `Jev decision failed: ${err?.message || String(err)}`);
      return false;
    }
    const latencyMs = Date.now() - started;
    if (token !== this.runToken) return false;

    let operationAnswer;
    try {
      operationAnswer = validateChoiceAnswer(jevResponse.answers?.operation, actionSpace.operations);
    } catch (err: any) {
      return this.rejectAnswer(`Invalid operation choice: ${err?.message || String(err)}`);
    }
    const operation = operationAnswer.choice;
    const provider = this.settings.activeProvider;
    const goalDone = readNoul(jevResponse.answers?.goal_done);
    const stuck = readNoul(jevResponse.answers?.stuck);

    if (operation === 'DONE' && goalDone !== undefined && goalDone < GOAL_DONE_MIN && !this.vetoedBefore.has('DONE')) {
      this.vetoed = 'DONE';
      this.vetoedBefore.add('DONE');
      this.lastStaleNotice = `ATTENTION: DONE was proposed, but the independent goal check says the task is not achieved yet (probability ${goalDone.toFixed(2)}). Something in the task is still missing; act on it.`;
      this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation: 'DONE (vetoed)', confidence: operationAnswer.confidence, latencyMs, provider, probabilities: operationAnswer.probabilities, goalDone, stuck });
      this.broadcastUpdate();
      return true;
    }
    if (operation === 'BLOCKED' && stuck !== undefined && stuck < STUCK_MIN && !this.vetoedBefore.has('BLOCKED')) {
      this.vetoed = 'BLOCKED';
      this.vetoedBefore.add('BLOCKED');
      this.lastStaleNotice = `ATTENTION: BLOCKED was proposed, but the independent progress check does not see a dead end (stuck probability ${stuck.toFixed(2)}). Choose a control that moves toward the task.`;
      this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation: 'BLOCKED (vetoed)', confidence: operationAnswer.confidence, latencyMs, provider, probabilities: operationAnswer.probabilities, goalDone, stuck });
      this.broadcastUpdate();
      return true;
    }

    if (operation === 'DONE' || operation === 'BLOCKED') {
      if (operationAnswer.confidence < TERMINAL_CONFIRM_THRESHOLD && this.pendingTerminal !== operation) {
        // A hesitant verdict gets one more look after the page settles; only a repeat ends the run.
        this.pendingTerminal = operation;
        this.sendStatus({ text: operation === 'DONE' ? 'Checking whether the task is complete…' : 'Checking for another way forward…', latencyMs });
        await new Promise((r) => setTimeout(r, 600));
        return true;
      }
      this.addLog({
        step: this.progress.currentStep,
        timestamp: Date.now(),
        operation,
        confidence: operationAnswer.confidence,
        latencyMs,
        provider,
        probabilities: operationAnswer.probabilities,
        goalDone,
        stuck,
      });
      this.finish(operation === 'DONE' ? 'done' : 'blocked');
      this.sendStatus({ text: operation === 'DONE' ? 'Done' : 'Blocked', latencyMs });
      return false;
    }

    this.pendingTerminal = null;

    // 5. Resolve the target from the selected operation's head only
    let targetAction: PageAction | undefined;
    let targetConfidence = operationAnswer.confidence;
    if (operation in actionSpace.targets) {
      try {
        const targetAnswer = validateChoiceAnswer(
          jevResponse.answers?.[`${operation.toLowerCase()}_target`],
          actionSpace.targets[operation]
        );
        targetAction = actionSpace.targets[operation][targetAnswer.choice];
        targetConfidence = targetAnswer.confidence;
      } catch (err: any) {
        return this.rejectAnswer(`Invalid target choice: ${err?.message || String(err)}`);
      }
    } else if (operation in actionSpace.controls) {
      targetAction = actionSpace.controls[operation];
    }
    if (!targetAction) {
      this.finish('error', `Could not find target action for operation: ${operation}`);
      return false;
    }

    // 6. TYPE_TEXT: the helper supplies the value; reuse it only for an identical input after a stale retry
    let generatedText: string | undefined;
    if (operation === 'TYPE_TEXT') {
      const context = createFieldContext(
        this.progress.goal,
        targetAction,
        { title: snapshot.title, text: snapshot.text },
        this.history
      );
      const key = JSON.stringify(context);
      if (this.pendingText && this.pendingText.key === key) {
        generatedText = this.pendingText.text;
      } else {
        try {
          generatedText = await generateFieldText(this.settings, context, { signal: this.providerAbort?.signal });
        } catch (err: any) {
          if (token !== this.runToken || err?.name === 'AbortError') return false;
          const message = err?.message || String(err);
          if (!/nothing typed/i.test(message)) {
            this.finish('error', `Text helper failed: ${message}`);
            return false;
          }
          // The helper could not derive a value from the goal: the field is not the way
          // forward. Tell the model and withhold the field after two attempts; the run
          // continues (this counter is separate from the page-stale counter, so refusals
          // on different fields never look like a stuck page).
          this.targetFailureCount.set(stableTargetKey(targetAction), (this.targetFailureCount.get(stableTargetKey(targetAction)) || 0) + 1);
          this.lastStaleNotice = `ATTENTION: No value for the field "${targetAction.label}" can be derived from the goal, so TYPE_TEXT there is not possible. Use links, buttons or other controls instead.`;
          this.broadcastUpdate();
          return true;
        }
        this.pendingText = { key, text: generatedText };
      }
      if (token !== this.runToken) return false;
    }

    // 7. Act (never retried)
    this.sendStatus({ text: `${operation} ${targetAction.label}`.slice(0, 120), latencyMs });
    let navigated = false;
    try {
      const result = await this.act(tabId, targetAction, generatedText, token);
      // H2: Stop during act wins; nothing after this point may execute or be recorded.
      if (token !== this.runToken) return false;
      if (!result.ok) {
        if (result.code === 'invalid') {
          this.finish('error', `Act execution failed: ${result.message}`);
          return false;
        }
        this.consecutiveStale++;
        if (this.consecutiveStale >= MAX_CONSECUTIVE_STALE) {
          this.finish('error', `Page kept changing before actions could run: ${result.message}`);
          return false;
        }
        // A covered or vanished target counts as a miss: the model is told, and after two
        // misses the target is withheld while alternatives exist.
        this.targetFailureCount.set(stableTargetKey(targetAction), (this.targetFailureCount.get(stableTargetKey(targetAction)) || 0) + 1);
        this.lastStaleNotice = `ATTENTION: The target "${targetAction.label}" could not be acted on (${result.message}). If an overlay or dialog is open, act inside it or close it; otherwise choose a different target.`;
        this.broadcastUpdate();
        // A covered or vanished target usually means the page is still loading or animating
        // (an in-page sort or filter that swaps the list); give it more time before looking again.
        await new Promise((r) => setTimeout(r, 500 * this.consecutiveStale));
        return true; // observe again; nothing was executed
      }
    } catch (err: any) {
      // H2: Stop during act wins, even when the page navigated mid-action.
      if (token !== this.runToken || err?.name === 'AbortError') return false;
      const message = err?.message || String(err);
      if (!isNavigationError(message)) {
        this.finish('error', `Act execution failed: ${message}`);
        return false;
      }
      // The action ran and the page navigated before it could reply; the action still counts.
      navigated = true;
    }

    // 8. Record execution before observing again
    this.consecutiveStale = 0;
    this.invalidAnswerRetried = false;
    this.pendingText = null;
    this.lastTargetKey = stableTargetKey(targetAction);
    this.history.push({
      step: this.progress.currentStep + 1,
      action: `${operation} ${targetAction.label}`,
      kind: targetAction.kind,
      text: generatedText,
      page_changed: undefined,
    });
    this.progress.currentStep++;
    this.addLog({
      step: this.progress.currentStep,
      timestamp: Date.now(),
      operation,
      targetId: targetAction.id,
      targetLabel: targetAction.label,
      targetValue: generatedText,
      confidence: targetConfidence,
      latencyMs,
      provider,
      probabilities: operationAnswer.probabilities,
      goalDone,
      stuck,
    });
    this.broadcastUpdate();

    // A click, select or Enter may have started a navigation that only shows up as the tab
    // loading; observing the old document now would hand the model a page that is about to
    // disappear.
    if (this.pendingTab) {
      await this.followTab();
    } else if (navigated) {
      await this.waitForTabToLoad(tabId);
    } else {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === 'loading') await this.waitForTabToLoad(tabId);
    }
    return true;
  }

  /** An inconsistent model answer is not executed. The first one is simply asked again. */
  private rejectAnswer(message: string): boolean {
    if (!this.invalidAnswerRetried) {
      this.invalidAnswerRetried = true;
      this.lastStaleNotice = null;
      this.broadcastUpdate();
      return true;
    }
    this.finish('error', message);
    return false;
  }

  /** How often the same operation + label was executed within the recent window (counting the last action). */
  private repeatCount(action: string): number {
    return this.history.slice(-REPEAT_WINDOW).filter((h) => h.action === action && !isRepeatExempt(h.kind)).length;
  }

  private addLog(log: AgentStepLog): void {
    this.progress.logs.unshift(log);
    if (this.progress.logs.length > 50) this.progress.logs.pop();
  }

  /**
   * Patches the just-resolved step with its element-level diff. The outcome set above
   * is page-level only ("scrolled", "no visible change"); the diff names which
   * controls appeared, vanished (?disabled/hidden/covered) or changed state, so the
   * next decision — and the popup feed — sees what the action actually did.
   */
  private attachDiffToLastStep(snapshot: PageSnapshot): void {
    const last = this.history[this.history.length - 1];
    if (!last || last.page_changed === undefined || !last.outcome || !this.lastSnapshot) return;
    const diff = computeActionDiff(this.lastSnapshot, snapshot);
    // History shape is a tested contract: only enrich the outcome when controls
    // actually appeared, vanished or changed state. Page-level text already covers rest.
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) return;
    const line = formatDiffForModel(last.outcome, diff).slice(0, 240);
    last.outcome = line;
    const stepNo = last.step ?? this.progress.currentStep;
    const log = this.progress.logs.find((l) => l.step === stepNo && !l.operation.includes('(vetoed)'));
    if (log) log.diff = line;
  }

  /** Attaches trusted input when enabled; records why not so the trace shows which path ran. */
  private async attachInput(tabId: number): Promise<void> {
    if (!this.settings.trustedInput) {
      this.progress.inputNote = 'Trusted input is off in settings; using synthetic events.';
    } else if (await this.input.attach(tabId)) {
      delete this.progress.inputNote;
    } else {
      this.progress.inputNote = TrustedInput.available()
        ? 'Could not attach the debugger (DevTools open on this tab?); using synthetic events.'
        : 'The debugger API is unavailable in this browser; using synthetic events.';
    }
    // Stop during attach wins: never leave the debugger attached while idle.
    if (this.progress.status !== 'running') {
      await this.input.detach();
    }
    this.broadcastUpdate();
  }

  /**
   * One action: the page checks, scrolls and focuses the target, then the input is dispatched
   * through the DevTools protocol when attached, or with synthetic events otherwise. A
   * trusted dispatch that throws falls back to synthetic on the already prepared target.
   */
  private async act(tabId: number, action: PageAction, text?: string, token?: number): Promise<ActResult> {
    const stopped = () => token !== undefined && token !== this.runToken;
    // M10: the setting is authoritative, not the attachment state — a mid-run toggle off
    // takes effect even if the detach has not landed yet.
    if (!this.settings.trustedInput || this.input.attachedTab !== tabId) {
      const result: ActResult | undefined = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_ACT', action, text });
      return result ?? { ok: false, code: 'failed', message: 'No reply from the page.' };
    }
    const prep: PrepareResult | undefined = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PREPARE', action, text });
    if (stopped()) throw new DOMException('Stopped', 'AbortError');
    if (!prep) return { ok: false, code: 'failed', message: 'No reply from the page.' };
    if (!prep.ok) return prep;
    if (prep.done) return { ok: true, via: 'page' };
    try {
      if (action.kind === 'click') {
        await this.input.click(prep.x, prep.y);
      } else if (action.kind === 'fill') {
        await this.input.click(prep.x, prep.y);
        await this.input.insertText(text ?? '');
      } else if (action.kind === 'key') {
        await this.input.pressEnter();
      } else {
        return { ok: false, code: 'invalid', message: `Unknown action kind: ${String(action.kind)}` };
      }
    } catch (err: any) {
      // H2: Stop wins over the synthetic fallback; never dispatch after the user stopped.
      if (stopped()) throw new DOMException('Stopped', 'AbortError');
      // The session was lost mid-action (tab navigated away, user cancelled): synthetic events
      // on the target the page already prepared are the closest equivalent.
      const fallback: ActResult | undefined = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_DISPATCH', action, text });
      if (stopped()) throw new DOMException('Stopped', 'AbortError');
      return fallback ?? { ok: false, code: 'failed', message: err?.message || String(err) };
    }
    if (stopped()) throw new DOMException('Stopped', 'AbortError');
    await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_SETTLE' }).catch(() => undefined);
    return { ok: true, via: 'cdp' };
  }

  /**
   * Read-only observation for the planner and delegate loops: injects the content
   * script if needed and tolerates one navigation race, like the ultrafast loop.
   * Throws on failure (the caller decides the run outcome); Stop surfaces as AbortError.
   */
  private async observeTab(tabId: number, token: number): Promise<PageSnapshot> {
    const throwIfStopped = () => {
      if (token !== this.runToken) throw new DOMException('Stopped', 'AbortError');
    };
    await this.ensureContentScriptReady(tabId, token);
    const observeOnce = () => chrome.tabs.sendMessage(tabId, { type: 'CONTENT_OBSERVE' });
    let response = await observeOnce();
    throwIfStopped();
    if ((!response?.success || !response.snapshot) && isNavigationError(response?.error || '')) {
      await this.waitForTabToLoad(tabId);
      throwIfStopped();
      response = await observeOnce();
      throwIfStopped();
    }
    if (!response?.success || !response.snapshot) {
      throw new Error(response?.error || 'Failed to capture page DOM snapshot');
    }
    return response.snapshot as PageSnapshot;
  }

  /**
   * Jev delegate: runs a text-free chain for the planner on the current tab and
   * returns every attempt with its UI diff — including misses the Jev loop would
   * shrug off (covered/disabled/stale). TYPE_TEXT is stripped from the action
   * space; a Jev that still asks to type ends the delegate as blocked "needs text".
   */
  private async runSubtask(
    subgoal: string,
    overallGoal: string,
    maxSteps: number,
    token: number
  ): Promise<JevDelegateResult> {
    const budget = Math.min(12, Math.max(1, Math.floor(maxSteps) || 8));
    const task = buildJevSubgoalTask(subgoal, overallGoal);
    const stopped = () => token !== this.runToken;
    const tabId = this.activeTabId;
    const steps: JevSubStep[] = [];
    const endOf = (status: JevDelegateResult['status'], reason: string, end: PageSnapshot | null): JevDelegateResult => ({
      status,
      reason,
      steps,
      endUrl: end?.url ?? '',
      endTitle: end?.title ?? '',
      excerpt: (end?.text ?? '').slice(0, 1500),
    });
    if (tabId === null) return endOf('error', 'No active tab for the Jev delegate.', null);

    let snapshot: PageSnapshot;
    try {
      await this.followTab();
      if (stopped()) throw new DOMException('Stopped', 'AbortError');
      snapshot = await this.observeTab(tabId, token);
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      return endOf('error', `Observe failed: ${err?.message || String(err)}`, null);
    }

    const localHistory: RecentAction[] = [];
    const visited: string[] = [snapshot.url];
    const vetoedOnce = new Set<'DONE' | 'BLOCKED'>();
    let vetoed: 'DONE' | 'BLOCKED' | null = null;
    let consecutiveNoChange = 0;
    let staleFails = 0;
    let invalidRetried = false;
    let acts = 0;
    let n = 0;
    const pushFail = (op: string, target: string, code: string, outcome: string, targetId?: string) => {
      steps.push({ n: ++n, op, target, targetId, ok: false, code, outcome, pageChanged: false, url: snapshot.url, diff: 'no change' });
    };

    for (let iter = 0; iter < budget + 3 && acts < budget; iter++) {
      if (stopped()) throw new DOMException('Stopped', 'AbortError');
      const { request, actionSpace } = buildJevRequest(
        activeJevModel(this.settings),
        snapshot,
        task,
        localHistory,
        {
          warning:
            consecutiveNoChange > 0 && localHistory.length > 0
              ? `ATTENTION: Previous action "${localHistory[localHistory.length - 1].action}" resulted in NO visible change. Do NOT repeat it.`
              : undefined,
        },
        { start_url: visited[0], steps_taken: acts, visited_urls: visited.slice(-6) }
      );
      // Text-free delegate: typing is the planner's job, never Jev's.
      delete actionSpace.operations['TYPE_TEXT'];
      delete actionSpace.targets['TYPE_TEXT'];
      delete (request.questions as Record<string, unknown>)['type_text_target'];
      if (vetoed) {
        delete actionSpace.operations[vetoed];
        delete (request.questions.operation as ChoiceQuestion).criteria[vetoed];
        vetoed = null;
      }

      let jevResponse;
      try {
        jevResponse = await callJevProvider(this.settings, request, { signal: this.providerAbort?.signal });
      } catch (err: any) {
        if (stopped() || err?.name === 'AbortError') throw new DOMException('Stopped', 'AbortError');
        return endOf('error', `Jev decision failed: ${err?.message || String(err)}`, snapshot);
      }
      if (stopped()) throw new DOMException('Stopped', 'AbortError');

      // A Jev that asks to type needs the planner: end the delegate, keep the trace.
      if ((jevResponse.answers as any)?.operation?.choice === 'TYPE_TEXT') {
        return endOf('blocked', 'needs text: the Jev delegate reached a field that must be typed.', snapshot);
      }
      let operation: string;
      let confidence: number | undefined;
      try {
        const validated = validateChoiceAnswer(jevResponse.answers?.operation, actionSpace.operations);
        operation = validated.choice;
        confidence = validated.confidence;
      } catch {
        if (!invalidRetried) {
          invalidRetried = true;
          continue;
        }
        return endOf('blocked', 'Jev delegate gave an unusable answer twice.', snapshot);
      }
      const goalDone = readNoul(jevResponse.answers?.goal_done);
      const stuck = readNoul(jevResponse.answers?.stuck);
      if (operation === 'DONE' && goalDone !== undefined && goalDone < GOAL_DONE_MIN && !vetoedOnce.has('DONE')) {
        vetoed = 'DONE';
        vetoedOnce.add('DONE');
        pushFail('DONE (vetoed)', '', 'vetoed', `DONE proposed but goal check says not achieved (${goalDone.toFixed(2)}).`);
        continue;
      }
      if (operation === 'BLOCKED' && stuck !== undefined && stuck < STUCK_MIN && !vetoedOnce.has('BLOCKED')) {
        vetoed = 'BLOCKED';
        vetoedOnce.add('BLOCKED');
        pushFail('BLOCKED (vetoed)', '', 'vetoed', `BLOCKED proposed but progress check disagrees (${stuck.toFixed(2)}).`);
        continue;
      }
      if (operation === 'DONE' || operation === 'BLOCKED') {
        return operation === 'DONE'
          ? endOf('done', `Subgoal achieved in ${acts} step(s).`, snapshot)
          : endOf('blocked', 'Jev delegate found no way forward text-free.', snapshot);
      }

      let targetAction: PageAction | undefined;
      try {
        if (operation in actionSpace.targets) {
          const targetAnswer = validateChoiceAnswer(
            jevResponse.answers?.[`${operation.toLowerCase()}_target`],
            actionSpace.targets[operation]
          );
          targetAction = actionSpace.targets[operation][targetAnswer.choice];
        } else if (operation in actionSpace.controls) {
          targetAction = actionSpace.controls[operation];
        }
      } catch {
        targetAction = undefined;
      }
      if (!targetAction) {
        if (!invalidRetried) {
          invalidRetried = true;
          continue;
        }
        return endOf('blocked', 'Jev delegate gave an unusable target twice.', snapshot);
      }
      invalidRetried = false;

      let navigated = false;
      try {
        const result = await this.act(tabId, targetAction, undefined, token);
        if (stopped()) throw new DOMException('Stopped', 'AbortError');
        if (!result.ok) {
          if (result.code === 'invalid') return endOf('error', `Act execution failed: ${result.message}`, snapshot);
          if (++staleFails >= MAX_CONSECUTIVE_STALE) {
            return endOf('error', `Page kept changing before actions could run: ${result.message}`, snapshot);
          }
          pushFail(operation, targetAction.label, result.code, `${targetAction.label} could not be acted on (${result.message}).`, targetAction.id);
          try {
            snapshot = await this.observeTab(tabId, token);
          } catch (err: any) {
            if (err?.name === 'AbortError') throw err;
            return endOf('error', `Observe failed: ${err?.message || String(err)}`, snapshot);
          }
          continue;
        }
      } catch (err: any) {
        if (stopped() || err?.name === 'AbortError') throw new DOMException('Stopped', 'AbortError');
        if (!isNavigationError(err?.message || String(err))) {
          return endOf('error', `Act execution failed: ${err?.message || String(err)}`, snapshot);
        }
        navigated = true;
      }

      staleFails = 0;
      acts++;
      if (this.pendingTab) {
        await this.followTab();
      } else if (navigated) {
        await this.waitForTabToLoad(tabId);
      } else {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.status === 'loading') await this.waitForTabToLoad(tabId);
      }
      if (stopped()) throw new DOMException('Stopped', 'AbortError');
      let after: PageSnapshot;
      try {
        after = await this.observeTab(tabId, token);
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        return endOf('error', `Observe failed: ${err?.message || String(err)}`, snapshot);
      }
      const outcome = describeOutcome(summarize(snapshot), summarize(after));
      const pageChanged = computePageFingerprint(snapshot) !== computePageFingerprint(after);
      const line = formatDiffForModel(outcome, computeActionDiff(snapshot, after)).slice(0, 240);
      steps.push({
        n: ++n, op: operation, target: targetAction.label, targetId: targetAction.id,
        ok: true, outcome: line, pageChanged, url: after.url, diff: line, confidence,
      });
      localHistory.push({ step: acts, action: `${operation} ${targetAction.label}`, kind: targetAction.kind, outcome: line, url: after.url, page_changed: pageChanged });
      if (visited[visited.length - 1] !== after.url) visited.push(after.url);
      consecutiveNoChange = pageChanged ? 0 : consecutiveNoChange + 1;
      if (consecutiveNoChange >= DEADLOCK_RUN) {
        return endOf('blocked', `${DEADLOCK_RUN} consecutive delegate actions produced no change on the page.`, after);
      }
      const repeats = localHistory.slice(-REPEAT_WINDOW).filter((h) => h.action === `${operation} ${targetAction!.label}`).length;
      if (repeats >= REPEAT_LIMIT) {
        return endOf('blocked', `Delegate repeated "${operation} ${targetAction.label}" without reaching the subgoal.`, after);
      }
      snapshot = after;
    }
    return endOf('blocked', `Reached the delegate budget of ${budget} steps without DONE.`, snapshot);
  }

  /** Planner mode entry: the general LLM drives, Jev serves as a delegate tool. */
  public async startPlanner(goal: string, tabId: number): Promise<void> {
    if (this.progress.status === 'running') return;
    this.reset(goal, tabId);
    const token = this.runToken;
    this.plannerMessages = [{ role: 'system', content: buildPlannerSystemPrompt(this.settings) }];
    this.broadcastUpdate();
    await this.attachInput(tabId);
    if (token !== this.runToken) return;
    await this.plannerLoop(token);
  }

  /** Executes exactly one planner iteration. A new goal, or a finished run, starts over. */
  public async stepPlanner(goal: string, tabId: number): Promise<void> {
    if (this.progress.status === 'running') return;
    const continuing = this.progress.status === 'paused' && goal === this.progress.goal && tabId === this.activeTabId;
    if (!continuing) {
      this.reset(goal, tabId);
      this.plannerMessages = [{ role: 'system', content: buildPlannerSystemPrompt(this.settings) }];
    } else {
      this.runToken++;
      this.newProviderScope();
      this.progress.status = 'running';
    }
    const token = this.runToken;
    if (this.progress.currentStep >= this.progress.maxSteps) {
      this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget.`);
      return;
    }
    this.broadcastUpdate();
    await this.attachInput(tabId);
    if (token !== this.runToken) return;
    let cont: boolean;
    try {
      cont = await this.executeOnePlannerStep(token);
    } catch (err: any) {
      if (token !== this.runToken) return;
      this.finish('error', `Planner step failed: ${err?.message || String(err)}`);
      return;
    }
    if (token === this.runToken && this.progress.status === 'running') {
      this.progress.status = cont ? 'paused' : 'idle';
    }
    if (this.progress.status !== 'running') void this.input.detach();
    this.broadcastUpdate();
  }

  private async plannerLoop(token: number): Promise<void> {
    while (token === this.runToken && this.progress.status === 'running') {
      if (this.progress.currentStep >= this.progress.maxSteps) {
        this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget without DONE.`);
        break;
      }
      let cont: boolean;
      try {
        cont = await this.executeOnePlannerStep(token);
      } catch (err: any) {
        if (token !== this.runToken) break;
        this.finish('error', `Planner step failed: ${err?.message || String(err)}`);
        break;
      }
      if (!cont) break;
      if (this.settings.stepDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.settings.stepDelayMs));
      }
    }
  }

  /** Keeps the system prompt plus recent turns; old observations are the first to go. */
  private trimPlannerMessages(): void {
    if (this.plannerMessages.length > 21) {
      this.plannerMessages = [this.plannerMessages[0], ...this.plannerMessages.slice(-20)];
    }
  }

  /**
   * Vision tokens are the run's dearest cost: only the latest screenshot stays in
   * context. Older shots are replaced by a one-line placeholder.
   */
  private dropOlderScreenshots(): void {
    let kept = false;
    for (let i = this.plannerMessages.length - 1; i >= 0; i--) {
      const m = this.plannerMessages[i];
      if (!Array.isArray(m.content) || !m.content.some((p) => p.type === 'image_url')) continue;
      if (!kept) {
        kept = true;
        continue;
      }
      const texts = m.content
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text: string }).text)
        .join(' ');
      m.content = `${texts || 'Screenshot'} [earlier screenshot removed]`;
    }
  }

  /** JPEG of the visible tab, as a data URL. Rejects with Chrome's reason on failure. */
  private captureVisibleTab(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 50 }, (url) => {
        const err = chrome.runtime.lastError?.message;
        if (err || !url) reject(new Error(err || 'Screenshot capture returned nothing.'));
        else resolve(url);
      });
    });
  }

  /**
   * Planner vision: draws numbered labels matching the element indices, captures the visible
   * tab, then clears the labels (they are for the model, not the user). Returns null when
   * screenshots are off, nothing is labeled, labeling fails, or — unless `force` — the same
   * url and element set were already captured and that image is still the latest in context.
   */
  private async labeledScreenshot(
    tabId: number,
    elements: ObservedElement[],
    targets: Record<string, Record<string, PageAction>>,
    url: string,
    token: number,
    force: boolean
  ): Promise<string | null> {
    if (!this.settings.screenshotsEnabled) return null;
    const entries = buildLabelEntries(elements, targets);
    if (!entries.length) return null;
    const key = visionShotKey(url, entries);
    if (!force && key === this.lastVisionKey) return null;
    const labeled = await chrome.tabs
      .sendMessage(tabId, { type: 'CONTENT_LABEL', entries })
      .then(() => true)
      .catch(() => false);
    if (!labeled) return null;
    let dataUrl: string | null = null;
    try {
      dataUrl = token === this.runToken ? await this.captureVisibleTab() : null;
    } catch {
      dataUrl = null;
    } finally {
      void chrome.tabs.sendMessage(tabId, { type: 'CONTENT_LABEL', entries: [] }).catch(() => undefined);
    }
    if (dataUrl) this.lastVisionKey = key;
    return dataUrl;
  }

  /**
   * Resolves a planner browser_act to a live target. Index-style ids ('3', '4:2')
   * address the Jev element table; raw snapshot ids ('e3') and control names work too.
   */
  private resolvePlannerTarget(
    targets: Record<string, Record<string, PageAction>>,
    controls: Record<string, PageAction>,
    snapshot: PageSnapshot,
    operation: string,
    targetId: unknown,
    optionId: unknown
  ): PageAction | undefined {
    const op = String(operation || '').toUpperCase();
    if (op === 'WAIT') return controls['WAIT'];
    if (op === 'PRESS_ENTER') return controls['PRESS_ENTER'];
    if (op === 'SCROLL_DOWN') return controls['SCROLL_DOWN'];
    if (op === 'SCROLL_UP') return controls['SCROLL_UP'];
    const group = targets[op];
    const tid = String(targetId ?? '');
    if (group) {
      if (group[tid]) return group[tid];
      if (op === 'SELECT' && optionId !== undefined && group[`${tid}:${optionId}`]) {
        return group[`${tid}:${optionId}`];
      }
    }
    return snapshot.actions.find((a) => a.id === tid);
  }

  /** Cache node id → planner element index, from an action space's target groups. */
  private nodeIndexLookup(targets: Record<string, Record<string, PageAction>>): Map<number, string> {
    const byNode = new Map<number, string>();
    for (const group of Object.values(targets)) {
      for (const [key, action] of Object.entries(group)) {
        const base = key.split(':')[0];
        if (action.node !== undefined && !byNode.has(action.node)) byNode.set(action.node, base);
      }
    }
    return byNode;
  }

  /**
   * Maps a screenshot point (0-1000) to the page: asks the content script what is at and near
   * it, then decorates each hit with the planner element index when one exists. Read-only, so
   * it runs even without trusted input. Returns null when the page cannot be probed.
   */
  private async probeAt(
    tabId: number,
    snapshot: PageSnapshot,
    targets: Record<string, Record<string, PageAction>>,
    x: number,
    y: number
  ): Promise<Record<string, unknown> | null> {
    const point = screenRelativeToCss(x, y, snapshot.w, snapshot.h);
    const res = await chrome.tabs
      .sendMessage(tabId, { type: 'CONTENT_PROBE', x: point.x, y: point.y })
      .catch(() => null);
    if (!res?.success || !Array.isArray(res.candidates)) return null;
    const byNode = this.nodeIndexLookup(targets);
    const candidates = (res.candidates as ProbeCandidate[]).map((c) => {
      const index = c.node !== undefined ? byNode.get(c.node) : undefined;
      return {
        ...(index ? { index } : {}),
        label: c.label,
        tag: c.tag,
        ...(c.role ? { role: c.role } : {}),
        distance: c.distance,
        ...(c.covered ? { covered: c.covered } : {}),
        offered: !!index,
      };
    });
    return candidates.length
      ? { point, at: candidates[0], near: candidates.slice(1) }
      : { point, at: null, near: [] };
  }

  /**
   * One planner turn: observe, ask the planner model for one tool call, run it.
   * Returns false when the run has ended.
   */
  private async executeOnePlannerStep(token: number): Promise<boolean> {
    // Cap every planner turn, including step-driven runs: nudges, screenshots and locate_at
    // calls do not advance currentStep, so the step budget alone never bounds them.
    const iterBudget = this.settings.plannerMaxIters || DEFAULT_SETTINGS.plannerMaxIters;
    if (this.plannerIters >= iterBudget) {
      this.finish('blocked', `Reached the planner iteration budget of ${iterBudget} for this run.`);
      return false;
    }
    await this.followTab();
    if (token !== this.runToken) return false;
    const tabId = this.activeTabId;
    if (tabId === null) {
      this.finish('error', 'No active tab identified');
      return false;
    }
    let snapshot: PageSnapshot;
    try {
      snapshot = await this.observeTab(tabId, token);
    } catch (err: any) {
      if (token !== this.runToken || err?.name === 'AbortError') return false;
      this.finish('error', `Observe failed: ${err?.message || String(err)}`);
      return false;
    }
    if (token !== this.runToken) return false;

    const recent = this.history.slice(-DEADLOCK_RUN);
    if (recent.length === DEADLOCK_RUN && recent.every((h) => h.page_changed === false && h.kind !== 'wait')) {
      this.finish('blocked', `${DEADLOCK_RUN} consecutive actions produced no change on the page. Inspect the page or adjust the goal.`);
      return false;
    }
    const lastH = this.history[this.history.length - 1];
    const repeated = lastH?.action && !isRepeatExempt(lastH.kind) ? this.repeatCount(lastH.action) : 0;
    if (repeated >= REPEAT_LIMIT) {
      this.finish('blocked', `The same action "${lastH!.action}" was repeated ${repeated} times without reaching the goal.`);
      return false;
    }

    const space = buildActionSpace(snapshot.actions, this.progress.goal);
    const obs: PlannerObservation = buildPlannerObservation(
      this.progress.goal,
      snapshot,
      space.elements,
      this.history,
      this.lastDelegate,
      lastH && lastH.page_changed === false
        ? `ATTENTION: Previous action "${lastH.action}" resulted in NO visible change. Do NOT repeat it; use a different control or delegate.`
        : undefined
    );
    // Vision (screenshotsEnabled): label the offered elements with their indices and attach a
    // screenshot of the same page, so the model can correlate numbers in the DOM with the
    // image. A page whose element set is unchanged since the last shot reuses that image.
    const shot = await this.labeledScreenshot(tabId, obs.elements, space.targets, snapshot.url, token, false);
    if (token !== this.runToken) return false;
    this.plannerMessages.push(
      shot
        ? {
            role: 'user',
            content: [
              { type: 'text', text: JSON.stringify(obs) },
              { type: 'text', text: buildScreenshotNote(snapshot.url) },
              { type: 'image_url', image_url: { url: shot } },
            ],
          }
        : { role: 'user', content: JSON.stringify(obs) }
    );
    this.trimPlannerMessages();

    const started = Date.now();
    let toolCall;
    let finishReason: string | null = null;
    let assistantMsg: ChatMessage;
    try {
      this.plannerIters++;
      const res = await callPlanner(this.settings, this.plannerMessages, { signal: this.providerAbort?.signal });
      toolCall = res.toolCall;
      finishReason = res.finishReason;
      assistantMsg = res.message;
    } catch (err: any) {
      if (token !== this.runToken || err?.name === 'AbortError') return false;
      this.finish('error', `Planner failed: ${err?.message || String(err)}`);
      return false;
    }
    const latencyMs = Date.now() - started;
    if (token !== this.runToken) return false;
    if (!toolCall) {
      // A chatty turn (prose, or a reply cut by the token limit) nudges the model
      // back to tools instead of aborting the run; after two nudges the run ends
      // quoting the model so the stop reason is informative.
      const said =
        typeof assistantMsg.content === 'string' && assistantMsg.content.trim()
          ? assistantMsg.content.slice(0, 300)
          : '';
      this.plannerMessages.push({ role: 'assistant', content: assistantMsg.content || '' });
      if (this.plannerNudges >= 2) {
        this.finish('blocked', said ? `Planner stopped without acting: ${said}` : 'Planner stopped replying with actions.');
        return false;
      }
      this.plannerNudges++;
      const toolList = this.settings.screenshotsEnabled
        ? 'browser_act, jev_delegate, task_finish, take_screenshot, screen_act, locate_at'
        : 'browser_act, jev_delegate, task_finish';
      const cut =
        finishReason === 'length'
          ? ' Your reply was cut by the token limit: be terse and emit only the tool call.'
          : ' Do not chat; act.';
      this.plannerMessages.push({ role: 'user', content: `That reply contained no tool call. Reply with exactly one tool call: ${toolList}.${cut}` });
      this.trimPlannerMessages();
      this.broadcastUpdate();
      return true;
    }
    this.plannerNudges = 0;
    const callId = assistantMsg.tool_calls?.[0]?.id ?? `call_${Date.now()}`;
    this.plannerMessages.push({
      role: 'assistant',
      content: assistantMsg.content || '',
      tool_calls: assistantMsg.tool_calls ?? [
        { id: callId, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } },
      ],
    });
    const pushToolResult = (payload: unknown) => {
      this.plannerMessages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(payload).slice(0, 6000) });
      this.trimPlannerMessages();
    };

    if (toolCall.name === 'task_finish') {
      const status = toolCall.args.status === 'done' ? 'done' : 'blocked';
      const summary = String(toolCall.args.summary || '').slice(0, 300) || (status === 'done' ? 'Done' : 'Blocked');
      pushToolResult({ ok: true });
      this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation: status === 'done' ? 'DONE' : 'BLOCKED', latencyMs, provider: 'planner' });
      this.finish(status, summary);
      this.sendStatus({ text: summary.slice(0, 120), latencyMs });
      return false;
    }

    if (toolCall.name === 'jev_delegate') {
      const subgoal = String(toolCall.args.subgoal || '').slice(0, 500);
      if (!subgoal) {
        pushToolResult({ ok: false, error: 'jev_delegate needs a subgoal.' });
        return true;
      }
      const delegateBudget = Math.min(12, Math.max(1, Math.floor(toolCall.args.maxSteps) || 8));
      this.sendStatus({ text: `Jev: ${subgoal}`.slice(0, 120), latencyMs });
      let result;
      try {
        result = await this.runSubtask(subgoal, this.progress.goal, delegateBudget, token);
      } catch (err: any) {
        if (token !== this.runToken || err?.name === 'AbortError') return false;
        this.finish('error', `Delegate failed: ${err?.message || String(err)}`);
        return false;
      }
      if (token !== this.runToken) return false;
      this.lastDelegate = result;
      const doneActs = result.steps.filter((s) => s.ok).length;
      this.progress.currentStep += doneActs;
      const tail = result.steps[result.steps.length - 1];
      this.history.push({
        step: this.progress.currentStep,
        action: `JEV "${subgoal.slice(0, 80)}" → ${result.status} (${result.steps.length} attempts)`,
        outcome: `${result.reason} | end ${result.endUrl}`.slice(0, 240),
        url: result.endUrl || snapshot.url,
        page_changed: result.steps.some((s) => s.pageChanged),
      });
      this.addLog({
        step: this.progress.currentStep, timestamp: Date.now(), operation: `JEV_DELEGATE ${result.status.toUpperCase()}`,
        targetLabel: subgoal.slice(0, 100), latencyMs, provider: 'planner', diff: tail?.diff,
      });
      pushToolResult(result);
      this.broadcastUpdate();
      if (this.progress.currentStep >= this.progress.maxSteps) {
        this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget.`);
        return false;
      }
      return true;
    }

    if (toolCall.name === 'take_screenshot') {
      if (!this.settings.screenshotsEnabled) {
        pushToolResult({ ok: false, error: 'Screenshots are disabled in settings.' });
        return true;
      }
      // Force: the model asked for a fresh look, so bypass the unchanged-page reuse.
      const dataUrl = await this.labeledScreenshot(tabId, obs.elements, space.targets, snapshot.url, token, true);
      if (token !== this.runToken) return false;
      if (!dataUrl) {
        pushToolResult({ ok: false, error: 'Screenshot capture failed.' });
        return true;
      }
      pushToolResult({ ok: true });
      this.plannerMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: buildScreenshotNote(snapshot.url) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      });
      this.dropOlderScreenshots();
      this.trimPlannerMessages();
      this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation: 'SCREENSHOT', latencyMs, provider: 'planner' });
      this.broadcastUpdate();
      return true;
    }

    if (toolCall.name === 'screen_act') {
      // Coordinates for controls the snapshot never offered: unlabelled, canvas-drawn,
      // custom dialogs the screenshot reveals but no index covers.
      if (!this.settings.screenshotsEnabled) {
        pushToolResult({ ok: false, error: 'Screenshots are disabled in settings.' });
        return true;
      }
      const rx = Number(toolCall.args.x);
      const ry = Number(toolCall.args.y);
      const sact = String(toolCall.args.action || '');
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx < 0 || rx > 1000 || ry < 0 || ry > 1000 || (sact !== 'click' && sact !== 'type')) {
        pushToolResult({ ok: false, error: 'screen_act needs x/y in 0-1000 and action click|type.' });
        return true;
      }
      let stext: string | undefined;
      if (sact === 'type') {
        stext = String(toolCall.args.text ?? '');
        if (!stext) {
          pushToolResult({ ok: false, error: 'screen_act type needs the exact text to type.' });
          return true;
        }
      }
      if (!this.settings.trustedInput || this.input.attachedTab !== tabId) {
        pushToolResult({ ok: false, error: 'screen_act needs trusted input attached; use element ids instead.' });
        return true;
      }
      const pt = screenRelativeToCss(rx, ry, snapshot.w, snapshot.h);
      this.sendStatus({ text: `SCREEN ${sact} @(${Math.round(rx)},${Math.round(ry)})`.slice(0, 120), latencyMs });
      try {
        await this.input.click(pt.x, pt.y);
        if (stext !== undefined) await this.input.insertText(stext);
      } catch (err: any) {
        if (token !== this.runToken) return false;
        pushToolResult({ ok: false, error: `Screen input failed: ${err?.message || String(err)}` });
        return true;
      }
      if (token !== this.runToken) return false;
      await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_SETTLE' }).catch(() => undefined);
      return this.finishDirectAct(token, tabId, snapshot, latencyMs,
        { op: 'SCREEN_ACT', label: `${sact} @(${Math.round(rx)},${Math.round(ry)})`, text: stext }, pushToolResult,
        { x: rx, y: ry, targets: space.targets });
    }

    if (toolCall.name === 'locate_at') {
      // Read-only: turn a guessed coordinate into the real element (and its index) so the
      // planner can recover from a screen_act that missed without another blind retry.
      if (!this.settings.screenshotsEnabled) {
        pushToolResult({ ok: false, error: 'Screenshots are disabled in settings.' });
        return true;
      }
      const lx = Number(toolCall.args.x);
      const ly = Number(toolCall.args.y);
      if (!Number.isFinite(lx) || !Number.isFinite(ly) || lx < 0 || lx > 1000 || ly < 0 || ly > 1000) {
        pushToolResult({ ok: false, error: 'locate_at needs x/y in 0-1000.' });
        return true;
      }
      const probe = await this.probeAt(tabId, snapshot, space.targets, lx, ly);
      if (token !== this.runToken) return false;
      pushToolResult(probe ? { ok: true, ...probe } : { ok: false, error: 'Could not probe that point.' });
      return true;
    }

    // browser_act: the planner's own hands, the only path that types.
    const op = String(toolCall.args.operation || '').toUpperCase();
    const target = this.resolvePlannerTarget(
      space.targets, space.controls, snapshot, op, toolCall.args.targetId, toolCall.args.optionId
    );
    if (!target) {
      pushToolResult({ ok: false, error: `No live target "${String(toolCall.args.targetId ?? '')}" for ${op}. Use an index from elements.` });
      return true;
    }
    let text: string | undefined;
    if (op === 'TYPE_TEXT') {
      text = String(toolCall.args.text ?? '');
      if (!text) {
        pushToolResult({ ok: false, error: 'TYPE_TEXT needs the exact text to type.' });
        return true;
      }
    }
    const opName = op === 'TYPE_TEXT' ? 'TYPE_TEXT' : OP_BY_KIND[target.kind] || op;
    this.sendStatus({ text: `${opName} ${target.label}`.slice(0, 120), latencyMs });
    try {
      const result: ActResult = await this.act(tabId, target, text, token);
      if (token !== this.runToken) return false;
      if (!result.ok) {
        if (result.code === 'invalid') {
          this.finish('error', `Act execution failed: ${result.message}`);
          return false;
        }
        pushToolResult({ ok: false, code: result.code, error: result.message });
        this.broadcastUpdate();
        return true;
      }
    } catch (err: any) {
      if (token !== this.runToken || err?.name === 'AbortError') return false;
      const message = err?.message || String(err);
      if (!isNavigationError(message)) {
        this.finish('error', `Act execution failed: ${message}`);
        return false;
      }
      // The action ran and the page navigated before replying; the settle check
      // inside finishDirectAct observes the new document.
    }
    if (token !== this.runToken) return false;
    return this.finishDirectAct(token, tabId, snapshot, latencyMs,
      { op: opName, kind: target.kind, label: target.label, targetId: target.id, text }, pushToolResult);
  }

  /**
   * Shared tail for the planner's direct acts (browser_act, screen_act): wait for the
   * page to settle, re-observe, record outcome + UI diff + log, feed the tool result.
   * Returns false when the run has ended.
   */
  private async finishDirectAct(
    token: number,
    tabId: number,
    before: PageSnapshot,
    latencyMs: number,
    entry: { op: string; kind?: string; label: string; targetId?: string; text?: string },
    pushToolResult: (payload: unknown) => void,
    probe?: { x: number; y: number; targets: Record<string, Record<string, PageAction>> }
  ): Promise<boolean> {
    if (this.pendingTab) {
      await this.followTab();
    } else {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === 'loading') await this.waitForTabToLoad(tabId);
    }
    if (token !== this.runToken) return false;
    let after: PageSnapshot;
    try {
      after = await this.observeTab(tabId, token);
    } catch (err: any) {
      if (token !== this.runToken || err?.name === 'AbortError') return false;
      this.finish('error', `Observe failed: ${err?.message || String(err)}`);
      return false;
    }
    const outcome = describeOutcome(summarize(before), summarize(after));
    const pageChanged = computePageFingerprint(before) !== computePageFingerprint(after);
    const line = formatDiffForModel(outcome, computeActionDiff(before, after)).slice(0, 240);
    this.progress.currentStep++;
    this.history.push({ step: this.progress.currentStep, action: `${entry.op} ${entry.label}`, kind: entry.kind, text: entry.text, outcome: line, url: after.url, page_changed: pageChanged });
    this.addLog({
      step: this.progress.currentStep, timestamp: Date.now(), operation: entry.op,
      targetId: entry.targetId, targetLabel: entry.label, targetValue: entry.text,
      latencyMs, provider: 'planner', diff: line,
    });
    // A screen_act that changed nothing gets an automatic probe of the same point: the model
    // sees what the coordinate actually hit (and the nearest indices) in the same tool result,
    // instead of guessing again and tripping the no-change deadlock guard.
    const payload: Record<string, unknown> = { ok: true, outcome: line, url: after.url, title: after.title };
    if (!pageChanged && probe) {
      const probed = await this.probeAt(tabId, before, probe.targets, probe.x, probe.y);
      if (token !== this.runToken) return false;
      if (probed) payload.probe = probed;
    }
    pushToolResult(payload);
    this.broadcastUpdate();
    if (this.progress.currentStep >= this.progress.maxSteps) {
      this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget.`);
      return false;
    }
    return true;
  }

  private finish(status: 'done' | 'blocked' | 'error', message?: string): void {
    void this.input.detach();
    this.progress.status = status;
    if (message) {
      this.progress.lastError = message;
    } else {
      delete this.progress.lastError;
    }
    this.broadcastUpdate();
    if (status !== 'done') this.sendStatus({ text: message || status });
  }

  private broadcastUpdate(): void {
    try {
      chrome.runtime
        .sendMessage({ type: 'PROGRESS_UPDATE', progress: this.progress })
        .catch(() => {
          // Popup might be closed
        });
    } catch {
      // No receiver available
    }
  }

  private sendStatus(payload: { text?: string; latencyMs?: number; clear?: boolean }): void {
    if (this.activeTabId === null) return;
    try {
      chrome.tabs.sendMessage(this.activeTabId, { type: 'CONTENT_STATUS', ...payload }).catch(() => {
        // Tab may be navigating
      });
    } catch {
      // Tab gone
    }
  }
}
