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

// In the browser `module` doesn't exist, so this does nothing there.
// In Node (our tests) it lets us require() this file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getSafeUrl, formatTime, makePreview };
}