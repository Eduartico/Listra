/**
 * Pure helpers behind the in-page relist actions.
 *
 * Shared by the content script (which decides what to ask for) and the manager
 * (which turns the request into queue entries), so both agree on what "active"
 * means and on the shape of a queue entry.
 */
(() => {
  const VB = (globalThis.VB ||= {});

  /**
   * Ids of the wardrobe records that are live right now. Only an explicit
   * `is_closed: false` counts: a record missing the flag is not assumed open,
   * because relisting deletes the original first.
   *
   * @param {Array<{id: number|string, is_closed?: boolean}>} records
   * @returns {string[]}
   */
  function activeIds(records) {
    return (records || [])
      .filter((r) => r && r.is_closed === false && r.id != null)
      .map((r) => String(r.id));
  }

  /** The field set every queue entry carries; mirrors manager.js's backupNewId. */
  function newEntry(id) {
    return {
      id: String(id),
      status: 'pending',
      title: null,
      folder: null,
      attempts: 0,
      error: null,
      imageCount: null,
      bytes: null,
      price: null,
      currency: null,
    };
  }

  /**
   * Queue entries for a relist request, in request order and without
   * duplicates. Existing entries are reused as the same objects (the queue is
   * mutated by reference elsewhere); unknown ids get a fresh pending entry that
   * relistOne backs up before doing anything else.
   *
   * @param {Array<{id: string}>} queue
   * @param {Array<string|number>} ids
   * @returns {{entries: object[], added: object[]}}
   */
  function entriesFor(queue, ids) {
    const seen = new Set();
    const entries = [];
    const added = [];
    for (const raw of ids || []) {
      const id = String(raw);
      if (seen.has(id)) continue;
      seen.add(id);
      let entry = (queue || []).find((e) => e && e.id === id);
      if (!entry) {
        entry = newEntry(id);
        added.push(entry);
      }
      entries.push(entry);
    }
    return { entries, added };
  }

  VB.relistPlan = { activeIds, entriesFor, newEntry };
})();
