const DEFAULTS = {
    maxEntries: 50,                       // keep at most 50 items (text + images together)
  maxTotalBytes: 2 * 1024 * 1024,       // ...and at most ~2 MB of TEXT in total
  maxEntryBytes: 100 * 1024,            // a single text item may be at most 100 KB
  maxImageBytes: 5 * 1024 * 1024,       // a single image may be at most 5 MB (decoded size)
  maxTotalImageBytes: 20 * 1024 * 1024, // ...and the images in a session at most ~20 MB in total
  maxSeenIds: 500,              // how many past ids we remember (duplicate check)
};

const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
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

// ---------- Image validation ----------
 
// The first bytes of a real image file identify its format. We compare them with the
// type the browser CLAIMED, so "evil.html" renamed to ".png" is rejected.
function matchesMagicBytes(mime, b) {
  switch (mime) {
    case 'image/png':
      return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
        && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
    case 'image/jpeg':
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/gif': // "GIF87a" or "GIF89a"
      return b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8'
        && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
    case 'image/webp': // "RIFF" <size> "WEBP"
      return b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF'
        && b.toString('latin1', 8, 12) === 'WEBP';
    default:
      return false;
  }
}
 
const DATA_URL_PREFIX = /^data:(image\/[a-z]+);base64,/;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
 
// Returns { ok: true, mime, size } or { ok: false, error }. `size` = decoded bytes.
function validateImageDataUrl(dataUrl, maxImageBytes) {
  const tooLarge = {
    ok: false,
    error: `Image is too large (limit is ${Math.round(maxImageBytes / (1024 * 1024))} MB).`,
  };
  if (typeof dataUrl !== 'string') {
    return { ok: false, error: 'Image data is missing.' };
  }
  // Cheap length check FIRST so we never run regexes over a huge hostile string.
  // base64 is 4/3 the size of the file; +128 covers the "data:...;base64," prefix.
  if (dataUrl.length > Math.ceil(maxImageBytes / 3) * 4 + 128) return tooLarge;
 
  const prefix = DATA_URL_PREFIX.exec(dataUrl);
  if (!prefix || !IMAGE_TYPES[prefix[1]]) {
    return { ok: false, error: 'Unsupported image type. Use PNG, JPEG, WEBP or GIF.' };
  }
  const mime = prefix[1];
  const body = dataUrl.slice(prefix[0].length);
  if (body.length === 0 || body.length % 4 !== 0 || !BASE64_BODY.test(body)) {
    return { ok: false, error: 'Image data is corrupted.' };
  }
 
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  const size = (body.length / 4) * 3 - padding;
  if (size > maxImageBytes) return tooLarge;
 
  // Decode only the first few bytes to check the real format.
  const head = Buffer.from(body.slice(0, 24), 'base64');
  if (!matchesMagicBytes(mime, head)) {
    return { ok: false, error: 'The file contents do not match its image type.' };
  }
  return { ok: true, mime, size };
}
 
// File names come from another person's browser: keep them short and printable.
function cleanImageName(raw, mime) {
  const fallback = `image.${IMAGE_TYPES[mime]}`;
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '') // control chars + characters illegal in file names
    .trim()
    .slice(0, 100);
  return name || fallback;
}
 


function createHistory(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  // A single entry must be allowed to fit inside its budget.
  if (cfg.maxEntryBytes > cfg.maxTotalBytes) {
    throw new Error('maxEntryBytes cannot be larger than maxTotalBytes');
  }
  if (cfg.maxImageBytes > cfg.maxTotalImageBytes) {
    throw new Error('maxImageBytes cannot be larger than maxTotalImageBytes');
  }
 
  let records = [];       // oldest -> newest (ascending seq)
  let textBytes = 0;      // sum of bytes of the TEXT entries in `records`
  let imageBytes = 0;     // sum of bytes of the IMAGE entries in `records`
  let nextSeq = 1;        // NEVER reset or reused, even after delete/clear
  const seenIds = new Set(); // ids we've already accepted (insertion-ordered)
 
  const isImage = (r) => r.kind == 'image';
  const isText = (r) => !isImage(r);
 
  function track(record, sign) {
    if (isImage(record)) imageBytes += sign * record.bytes;
    else textBytes += sign * record.bytes;
  }
 
  // Remember an id, forgetting the oldest one if we remember too many.
  function rememberId(id) {
    seenIds.add(id);
    if (seenIds.size > cfg.maxSeenIds) {
      const oldest = seenIds.values().next().value; // Sets keep insertion order
      seenIds.delete(oldest);
    }
  }
 
  // Drop the oldest records matching `filter` while `tooMuch()` is true.
  // The entry we just added (`keep`) is never dropped. Returns the dropped ids.
  function evictWhile(tooMuch, filter, keep) {
    const dropped = [];
    while (tooMuch()) {
      const index = records.findIndex((r) => r != keep && filter(r));
      if (index == -1) break;
      const [old] = records.splice(index, 1);
      track(old, -1);
      dropped.push(old.id);
    }
    return dropped;

  }

  // add() returns one of the followinf
  //   { ok: false, error }                                  -> rejected
  //   { ok: true, duplicate: true,  entry, evicted: [] }    -> we've seen this id
  //   { ok: true, duplicate: false, entry, evicted: [ids] } -> stored
    function add({ id, kind = 'text', text, image, senderId, senderName, now = Date.now() }) {
    if (!isValidEntryId(id)) {
      return { ok: false, error: 'Invalid entry id.' };
    }
 
    // Build the part of the record that depends on the kind, or reject.
    let payload;
    let bytes;
    if (kind === 'image') {
      if (typeof image !== 'object' || image === null) {
        return { ok: false, error: 'Image data is missing.' };
      }
      const checked = validateImageDataUrl(image.dataUrl, cfg.maxImageBytes);
      if (!checked.ok) return checked;
      bytes = checked.size;
      payload = {
        kind: 'image',
        text: '', // keeps every entry shaped the same: `text` is always a string
        mime: checked.mime,
        name: cleanImageName(image.name, checked.mime),
        size: checked.size,
        dataUrl: image.dataUrl,
      };
    } else if (kind === 'text') {
      if (typeof text !== 'string') {
        return { ok: false, error: 'Clipboard data must be text.' };
      }
      bytes = Buffer.byteLength(text, 'utf8'); // real bytes, not characters
      if (bytes > cfg.maxEntryBytes) {
        return {
          ok: false,
          error: `Entry is too large (limit is ${Math.round(cfg.maxEntryBytes / 1024)} KB).`,
        };
      }
      if (text.trim().length === 0) {
        return { ok: false, error: 'Nothing to store: the text is empty.' };
      }
      payload = { kind: 'text', text };
    } else {
      return { ok: false, error: 'Unknown item type.' };
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
      ...payload,
      senderId,
      senderName,
      timestamp: now,
      bytes,
    };
    records.push(record);
    track(record, +1);
    rememberId(id);

    const evicted = [
      ...evictWhile(() => textBytes > cfg.maxTotalBytes, isText, record),
      ...evictWhile(() => imageBytes > cfg.maxTotalImageBytes, isImage, record),
      ...evictWhile(() => records.length > cfg.maxEntries, () => true, record),
    ];
 
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
    track(records[index], -1);
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
    textBytes = 0;
    imageBytes = 0;
    return count;
  }
 
  function stats() {
    return {
      count: records.length,
      totalBytes: textBytes + imageBytes,
      textBytes,
      imageBytes,
      nextSeq,
    };
  }
 
  return { add, list, listAfter, remove, clear, stats };
}
 


module.exports = {
  createHistory,
  isValidEntryId,
  validateImageDataUrl,
  IMAGE_TYPES,
  DEFAULTS,
};
