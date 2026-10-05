// If `text` is exactly ONE http/https link, return the cleaned-up URL string.
// Otherwise return null (meaning: "treat it as plain text").
function getSafeUrl(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null; // huge = not a normal link

  // "see https://example.com now" is a sentence, not a link: any space/newline -> text.
  if (/\s/.test(trimmed)) return null;

  let url;
  try {
    url = new URL(trimmed); // throws for things like "hello" or "example.com" (no scheme)
  } catch (err) {
    return null;
  }

  // SECURITY: only allow http and https. This blocks "javascript:alert(1)",
  // "data:text/html,...", "file:///etc/passwd" and friends from becoming clickable.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  return url.href;
}

// Turns a timestamp (milliseconds) into a short local time
function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// One-line shortened version of a text, for status messages.
function makePreview(text, maxLength = 40) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  // Array.from splits by real characters, so an emoji is never cut in half.
  const chars = Array.from(oneLine);
  if (chars.length <= maxLength) return oneLine;
  return chars.slice(0, maxLength - 1).join('') + '…';
}

// ---------- Image helpers (Phase 9) ----------

// Formats we accept. Must match IMAGE_TYPES in server/history.js.
// (SVG is excluded on purpose: it can carry scripts.)
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB; the server enforces the same limit

// 1536 -> "1.5 KB", 5242880 -> "5.0 MB"
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Only a base64 data URL of an allowed image type may ever reach an <img src>.
// Anything else from the network (e.g. "javascript:...", "https://tracker/pixel.gif",
// "data:image/svg+xml,...") is refused.
function isSafeImageDataUrl(value) {
  return typeof value === 'string'
    && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

// Turns a name from someone else's device into a safe download file name
// that also ends with the right extension for the image's real type.
function safeDownloadName(name, mime) {
  const ext = IMAGE_EXTENSIONS[mime] || 'png';
  let base = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '') // drop the old extension; we add the right one
    .trim()
    .slice(0, 80);
  if (!base) base = 'uniclip-image';
  return `${base}.${ext}`;
}