
const params = new URLSearchParams(window.location.search);
const profile = params.get('as');
const STORAGE_KEY = 'clipsync-deviceId' + (profile ? `-${profile}` : '');

function generateId() {
  // crypto.randomUUID only exists on HTTPS/localhost, so we add a fallback.
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Load the saved id, or create one the first time this browser visits.
function getOrCreateDeviceId() {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

// Builds a friendly name like "Chrome on Windows (a3f9)".
function guessDeviceName(deviceId) {
    const ua = navigator.userAgent;

    let browser = 'Browser';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';

    // Order matters: Android UAs contain "Linux", iPhone UAs contain "Mac OS X".
    let os = 'Unknown OS';
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    return `${browser} on ${os} (${deviceId.slice(0, 4)})`;
}

const deviceId = getOrCreateDeviceId();
const deviceName = guessDeviceName(deviceId);

// 2. STATE + DOM REFERENCES

let currentCode = null; // the session we're in (null = not in one)

const $ = (id) => document.getElementById(id);
const homeView = $('home-view');
const sessionView = $('session-view');
const statusBadge = $('status-badge');
const createBtn = $('create-btn');
const joinForm = $('join-form');
const codeInput = $('code-input');
const homeError = $('home-error');
const sessionCode = $('session-code');
const deviceCount = $('device-count');
const deviceList = $('device-list');
const leaveBtn = $('leave-btn');

//REPLICATING THE CLIP LENGTH FROM THE SERVER
const MAX_CLIP_BYTES = 100 * 1024; // 100 KB

const myPublicId = deviceId.slice(0, 8); // short version of our id, for display in the device list

const syncBtn = $('sync-btn');
const sendTextBtn = $('send-text-btn');
const clipInput = $('clip-input');
const clipStatus = $('clip-status');
const historyEmpty = $('history-empty');
const historyList = $('history-list');
const clearHistoryBtn = $('clear-history-btn');


// 3. UI HELPERS

function setStatus(kind, text) {
  statusBadge.className = `badge badge--${kind}`;
  statusBadge.textContent = text;
}

function showHome(errorMessage = '') {
  resetClipUI(); // addition: clear old clipboard text when we leave / fail to rejoin
  sessionView.hidden = true;
  homeView.hidden = false;
  homeError.textContent = errorMessage;
}

function showSession(code) {
  homeView.hidden = true;
  sessionView.hidden = false;
  homeError.textContent = '';
  sessionCode.textContent = code;
}

function renderDevices(devices) {
  deviceCount.textContent = devices.length;
  deviceList.replaceChildren(); // empty the list

  const myPublicId = deviceId.slice(0, 8);

  for (const device of devices) {
    const li = document.createElement('li');
    // IMPORTANT: textContent, NOT innerHTML. Device names come from OTHER
    // people's browsers, so treating them as HTML would allow XSS attacks.
    li.textContent = device.name;

    if (device.publicId === myPublicId) {
      const tag = document.createElement('span');
      tag.className = 'you';
      tag.textContent = ' (this device)';
      li.appendChild(tag);
    }
    deviceList.appendChild(li);
  }
}

//--------------------Clipboard UI Helpers---------------------

function setClipStatus(message, isError = false) {
  clipStatus.textContent = message;
  clipStatus.className = isError ? 'status status--error' : 'status';
}

//--------History UI Helpers-----------------
// `entries` is our local copy of the shared history: Map<id, entry>.
// Using the id as the key is what prevents duplicates: the same id can only exist once.
const entries = new Map();
 
// Never trust data coming from the network: check the shape before using it.
function isValidEntry(e) {
  return Boolean(e) && typeof e === 'object'
    && typeof e.id === 'string'
    && typeof e.text === 'string'
    && typeof e.senderId === 'string'
    && typeof e.senderName === 'string'
    && Number.isInteger(e.seq)
    && Number.isFinite(e.timestamp);
}
 
// Add one entry. Returns false if we already had it (a duplicate), true if it is new.
function addEntry(entry) {
  if (entries.has(entry.id)) return false;
  entries.set(entry.id, entry);
  return true;
}
 
function removeEntries(ids) {
  for (const id of ids) entries.delete(id);
}
 
// Replace EVERYTHING with the server's list (used when we join, and after a reconnect).
// Replacing instead of appending is why a reconnect can never create duplicates.
function applySnapshot(list) {
  entries.clear();
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isValidEntry(entry)) addEntry(entry);
    }
  }
  renderHistory();
}
 
// Draw the whole list from `entries`, newest first (highest seq on top).
function renderHistory() {
  const sorted = [...entries.values()].sort((a, b) => b.seq - a.seq);
  historyEmpty.hidden = sorted.length > 0;
  clearHistoryBtn.hidden = sorted.length === 0;
  historyList.replaceChildren(...sorted.map(makeEntryItem));
}
 
// Builds the <li> for one entry. Everything that came from the network goes in
// through textContent / href (never innerHTML), so it cannot run as HTML or script.
function makeEntryItem(entry) {
  const li = document.createElement('li');
  li.className = 'entry';
 
  const meta = document.createElement('div');
  meta.className = 'entry__meta';
 
  const safeUrl = getSafeUrl(entry.text); // from utils.js: a clean http(s) URL, or null
  if (safeUrl) {
    li.classList.add('entry--link');
    const badge = document.createElement('span');
    badge.className = 'entry__badge';
    badge.textContent = 'Link';
    meta.appendChild(badge);
  }
 
  const who = entry.senderId === myPublicId ? 'you' : entry.senderName;
  meta.append(`${who} · ${formatTime(entry.timestamp)}`);
 
  const body = document.createElement('div');
  body.className = 'entry__text';
  if (safeUrl) {
    const link = document.createElement('a');
    link.href = safeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer'; // the opened page gets no access to ours
    link.textContent = entry.text.trim();
    body.appendChild(link);
  } else {
    body.textContent = entry.text;
  }
 
  const actions = document.createElement('div');
  actions.className = 'entry__actions';
 
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => copyEntry(entry));
 
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn--danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteEntry(entry));
 
  actions.append(copyBtn, deleteBtn);
  li.append(meta, body, actions);
  return li;
}
 
// Copy an old entry back to this device's clipboard (a click = allowed by the browser).
async function copyEntry(entry) {
  try {
    await navigator.clipboard.writeText(entry.text);
    setClipStatus(`Copied: ${makePreview(entry.text)}`);
  } catch (err) {
    setClipStatus('Copy failed. Check clipboard permission, or select the text and press Ctrl+C.', true);
  }
}
 
// Ask the server to delete one entry. We do NOT remove it from the screen here:
// the server answers by broadcasting 'clip:deleted' to everyone (us included),
// so there is exactly one place that updates the screen.
function deleteEntry(entry) {
  socket.timeout(5000).emit('clip:delete', { id: entry.id }, (err, res) => {
    if (err) {
      setClipStatus('The server did not respond. Try again.', true);
      return;
    }
    if (!res.ok) {
      setClipStatus(res.error, true);
    }
  });
}
 
clearHistoryBtn.addEventListener('click', () => {
  if (!window.confirm('Clear the history on ALL devices in this session?')) return;
  socket.timeout(5000).emit('clip:clear', {}, (err, res) => {
    if (err) {
      setClipStatus('The server did not respond. Try again.', true);
      return;
    }
    if (!res.ok) {
      setClipStatus(res.error, true);
    }
  });
});
 
// Used by showHome(): forget everything when we leave a session.
function resetClipUI() {
  clipInput.value = '';
  setClipStatus('');
  entries.clear();
  renderHistory();
}

// 4. SOCKET CONNECTION

const socket = io(); // connects to the server that served this page

// Register listeners ONCE here, never inside a function that runs repeatedly.
// (Otherwise you get duplicate handlers after every reconnect.)

socket.on('connect', () => {
  setStatus('connected', 'Connected');
  // If we were in a session before a drop/server restart, try to get back in.
  // (A taste of Phase 6, since it prevents confusing stale screens.)
  if (currentCode) joinSession(currentCode);
});

socket.on('disconnect', () => {
  setStatus('reconnecting', 'Reconnecting…');
});

socket.on('connect_error', () => {
  setStatus('reconnecting', 'Reconnecting…');
});

// The server pushes this whenever someone joins or leaves our session.
socket.on('devices:update', (data) => {
  if (data.code !== currentCode) return; // ignore updates for other sessions
  renderDevices(data.devices);
});

// another device sent us clipboard text.
socket.on('clip:added', async (data) => {
  if (!currentCode || !data) return;       // ignore if we already left the session
  if (!isValidEntry(data.entry)) return;   // never trust incoming data
 
  const entry = data.entry;
  const isNew = addEntry(entry);           // false = we already had this id (duplicate)
  if (Array.isArray(data.evicted)) removeEntries(data.evicted); // dropped by the server's size caps
  renderHistory();
 
  // Auto-copy only NEW items that came from ANOTHER device.
  if (!isNew || entry.senderId === myPublicId) return;
  try {
    await navigator.clipboard.writeText(entry.text);
    setClipStatus(`Copied from ${entry.senderName}: ${makePreview(entry.text)}`);
  } catch (err) {
    // Blocked (tab not focused, Safari needs a click, no permission, or no HTTPS).
    setClipStatus(`New item from ${entry.senderName}. Auto-copy was blocked: press Copy on it below.`, true);
  }
});
 
socket.on('clip:deleted', (data) => {
  if (!currentCode || !data || !Array.isArray(data.ids)) return;
  removeEntries(data.ids);
  renderHistory();
});
 
socket.on('clip:cleared', () => {
  if (!currentCode) return;
  entries.clear();
  renderHistory();
});


function explainClipboardError(err) {
  if (!navigator.clipboard) {
    return 'Clipboard access needs HTTPS or localhost. Use the text box instead.';
  }
  if (err && err.name === 'NotAllowedError') {
    return 'Clipboard permission was denied. Allow it in your browser\'s site settings, or use the text box.';
  }
  return 'Could not read the clipboard. Use the text box instead.';
}
 
function sendClip(text) {
  if (!currentCode) {
    setClipStatus('Join a session first.', true);
    return;
  }
  if (!socket.connected) {
    setClipStatus('You are offline. Wait for the connection to come back.', true);
    return;
  }
  if (text.trim().length === 0) {
    setClipStatus('Nothing to send: the text is empty.', true);
    return;
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_CLIP_BYTES) {
    setClipStatus(`Too large (${Math.round(bytes / 1024)} KB). The limit is 100 KB.`, true);
    return;
  }
 
  setClipStatus('Sending…');
 
  // .timeout(5000): if the server doesn't answer within 5 seconds, `err` is filled in.
  socket.timeout(5000).emit('clip:send', { id: generateId(), text }, (err, res) => {
    if (err) {
      setClipStatus('The server did not respond. Try again.', true);
      return;
    }
    if (!res.ok) {
      setClipStatus(res.error, true);
      return;
    }
    setClipStatus(
      res.receivers === 0
        ? 'Sent, but no other devices are connected yet.'
        : `Sent to ${res.receivers} other device(s).`
    );
  });
}
 
async function handleSyncClick() {
  syncBtn.disabled = true; // stop double clicks while a permission prompt may be open
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      throw new Error('clipboard-unsupported');
    }
    const text = await navigator.clipboard.readText();
    clipInput.value = text; // show what was read, so nothing is sent "invisibly"
    sendClip(text);
  } catch (err) {
    setClipStatus(explainClipboardError(err), true);
    clipInput.focus(); // point the user to the manual fallback
  } finally {
    syncBtn.disabled = false;
  }
}
 
syncBtn.addEventListener('click', handleSyncClick);
sendTextBtn.addEventListener('click', () => sendClip(clipInput.value));

// 5. ACTIONS (create / join / leave)

// Handles the server's reply for both create and join.
function handleSessionResponse(res) {
  if (!res.ok) {
    currentCode = null;
    showHome(res.error);
    return;
  }
  currentCode = res.code;
  showSession(res.code);
  renderDevices(res.devices);
  applySnapshot(res.entries); // show the existing history (also after a reconnect)
}

function joinSession(code) {
  // The third argument is the "ack" callback: the server's direct reply.
  socket.emit('session:join', { code, deviceId, name: deviceName }, handleSessionResponse);
}

createBtn.addEventListener('click', () => {
  homeError.textContent = '';
  socket.emit('session:create', { deviceId, name: deviceName }, handleSessionResponse);
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault(); // stop the page from reloading
  const code = codeInput.value.trim();
  if (code.length !== 6) {
    homeError.textContent = 'The pairing code is 6 characters long.';
    return;
  }
  homeError.textContent = '';
  joinSession(code);
});

// Auto-uppercase while typing so codes always look right.
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase();
});

leaveBtn.addEventListener('click', () => {
  socket.emit('session:leave');
  currentCode = null;
  codeInput.value = '';
  showHome();
});

// Start on the home screen.
showHome();