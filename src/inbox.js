// @ts-check
// Approvals of background runs (AURA-122): nobody watches the chat, so an approval waits here ("Wartet auf dich" in
// the panel) and the user gets a notification. After the timeout the run goes on without the action.
/**
 * @typedef {{ stepId: string, taskId: string, title: string, tool: string, label: string, detail: string,
 *   tier: number, reason: string, created: number }} Entry
 * @param {{ notify: (entry: Entry) => void, changed: (list: Entry[]) => void, timeoutMs: number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void, now?: () => number }} deps
 */
function createInbox(deps) {
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const now = deps.now || Date.now;
  /** @type {Map<string, { entry: Entry, timer: any }>} */
  const items = new Map();
  const list = () => [...items.values()].map((x) => x.entry);

  /**
   * @param {any} req host.approve request
   * @param {string} title title of the scheduled task
   * @param {(ok: any) => void} answer resolves the agent's approval (true/false or a scope string)
   * @returns {(ok: any) => void} decide: answers once, removes the entry
   */
  function add(req, title, answer) {
    const stepId = String(req.stepId);
    /** @type {Entry} */
    const entry = {
      stepId,
      taskId: String(req.taskId),
      title,
      tool: String(req.tool || ''),
      label: String(req.label || ''),
      detail: req.effect && req.effect !== req.label ? String(req.effect) : '',
      tier: Number(req.tier) || 0,
      reason: String(req.reason || ''),
      created: now()
    };
    let open = true;
    const decide = (/** @type {any} */ ok) => {
      if (!open) return;
      open = false;
      const it = items.get(stepId);
      if (it) clearTimer(it.timer);
      items.delete(stepId);
      deps.changed(list());
      answer(ok);
    };
    items.set(stepId, { entry, timer: setTimer(() => decide(false), deps.timeoutMs) });
    deps.changed(list());
    deps.notify(entry);
    return decide;
  }

  return { add, list, forTask: (/** @type {string} */ prefix) => list().filter((e) => e.taskId.startsWith(prefix)) };
}

module.exports = { createInbox };
