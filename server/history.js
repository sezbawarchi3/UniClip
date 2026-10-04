const DEFAULTS = {
  maxEntries: 50,                 // keep at most 50 items
  maxTotalBytes: 2 * 1024 * 1024, // ...and at most ~2 MB of text in total
  maxEntryBytes: 100 * 1024,      // a single item may be at most 100 KB
  maxSeenIds: 500,                // how many past ids we remember (duplicate check)
};

// Restricting the shape stops weird or gigantic values from entering our Set.
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/; // looks like UUID

function isValidEntryId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function toPublic(record) {
  const { bytes, ...entry } = record;
  return entry;
}

function createHistory(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  // A single entry must be allowed to fit inside the total budget.
  if (cfg.maxEntryBytes > cfg.maxTotalBytes) {
    throw new Error('maxEntryBytes cannot be larger than maxTotalBytes');
  }

  let records = [];     // oldest -> newest (ascending seq)
  let totalBytes = 0;   // sum of bytes of everything in `records`
  let nextSeq = 1;      // NEVER reset or reused, even after delete/clear
  const seenIds = new Set(); // ids we've already accepted (insertion-ordered)

  // Remember an id, forgetting the oldest one if we remember too many.
  function rememberId(id) {
    seenIds.add(id);
    if (seenIds.size > cfg.maxSeenIds) {
      const oldest = seenIds.values().next().value; // Sets keep insertion order
      seenIds.delete(oldest);
    }
  }

  // add() returns one of the followinf
  //   { ok: false, error }                                  -> rejected
  //   { ok: true, duplicate: true,  entry, evicted: [] }    -> we've seen this id
  //   { ok: true, duplicate: false, entry, evicted: [ids] } -> stored
  function add({ id, text, senderId, senderName, now = Date.now() }) {
    if (!isValidEntryId(id)) {
      return { ok: false, error: 'Invalid entry id.' };
    }
    if (typeof text !== 'string') {
      return { ok: false, error: 'Clipboard data must be text.' };
    }
    const bytes = Buffer.byteLength(text, 'utf8'); // real bytes, not characters
    if (bytes > cfg.maxEntryBytes) {
      return {
        ok: false,
        error: `Entry is too large (limit is ${Math.round(cfg.maxEntryBytes / 1024)} KB).`,
      };
    }
    if (text.trim().length === 0) {
      return { ok: false, error: 'Nothing to store: the text is empty.' };
    }

    // Duplicate? Do NOT create a new entry or consume a seq number.
    if (seenIds.has(id)) {
      const existing = records.find((r) => r.id === id);
      return {
        ok: true,
        duplicate: true,
        entry: existing ? toPublic(existing) : null, // null = it was deleted/evicted since
        evicted: [],
      };
    }

    const record = {
      id,
      seq: nextSeq++,
      text,
      senderId,
      senderName,
      timestamp: now,
      bytes,
    };
    records.push(record);
    totalBytes += bytes;
    rememberId(id);

    // Enforce the caps by dropping the oldest entries.
    const evicted = [];
    while (records.length > cfg.maxEntries || totalBytes > cfg.maxTotalBytes) {
      if (records.length <= 1) break; // safety: never evict the entry we just added
      const oldest = records.shift();
      totalBytes -= oldest.bytes;
      evicted.push(oldest.id);
    }

    return { ok: true, duplicate: false, entry: toPublic(record), evicted };
  }

  // Everything, oldest -> newest. Returns COPIES so callers can't change our data.
  function list() {
    return records.map(toPublic);
  }

  // Only entries newer than `seq`. Used later so a reconnecting device can
  // ask: "give me everything after the last one I saw".
  function listAfter(seq) {
    return records.filter((r) => r.seq > seq).map(toPublic);
  }

  // Delete one entry. Returns true if something was removed.
  function remove(id) {
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) return false;
    totalBytes -= records[index].bytes;
    records.splice(index, 1);
    return true;
  }

  // Delete everything. Returns how many entries were removed.
  // We keep `nextSeq` and `seenIds` on purpose:
  //   - seq numbers must never go backwards (clients rely on them),
  //   - a late retry of an old id must not bring a cleared item back.
  function clear() {
    const count = records.length;
    records = [];
    totalBytes = 0;
    return count;
  }

  function stats() {
    return { count: records.length, totalBytes, nextSeq };
  }

  return { add, list, listAfter, remove, clear, stats };
}

module.exports = { 
    createHistory, 
    isValidEntryId, 
    DEFAULTS 
};