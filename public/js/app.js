
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
let initialError = '';   // message to show on the home screen at startup (e.g. bad join link)

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
const qrBox = $('qr-box');
const qrCanvas = $('qr-canvas');
const qrWarning = $('qr-warning');


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

const imageDrop = $('image-drop');
const imageInput = $('image-input');
const imageModal = $('image-modal');
const modalImg = $('modal-img');
const modalCaption = $('modal-caption');
const modalDownloadBtn = $('modal-download-btn');
const modalCloseBtn = $('modal-close-btn');
const MAX_IMAGES_PER_BATCH = 5; // how many images one drop / file selection may send


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
  renderQr(code);
}

//--------------------QR code: build + render the join link---------------------
 
// Same alphabet/length the server uses to generate pairing codes.
const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

function buildJoinUrl(code) {
  return `${window.location.origin}/join?code=${encodeURIComponent(code)}`;
}



function renderQr(code) {
  // If the QR library failed to load (offline / CDN blocked), hide the QR section.
  // The typed pairing code keeps working either way.
  if (typeof qrcode !== 'function') {
    qrBox.hidden = true;
    return;
  }

  const qr = qrcode(0, 'M'); // type 0 = pick the smallest size that fits, 'M' = medium error correction
  qr.addData(buildJoinUrl(code));
  qr.make(); // generaing the qrcode

  //canvas drawing constraints
  const modules = qr.getModuleCount();
  const quiet = 4;   // the white "quiet zone" border scanners need
  const scale = 8;   // pixels per QR square (the CSS scales the canvas down for small screens)
  const size = (modules + quiet * 2) * scale;

  qrCanvas.width = size;
  qrCanvas.height = size;
  const ctx = qrCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
      }
    }
  }


  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  qrWarning.hidden = !isLocal;
  if (isLocal) {
    qrWarning.textContent =
      'You opened UniClip via "localhost", which other devices cannot reach. ' +
      'Open it using this computer\'s network address (e.g. http://192.168.x.x:3000) so the QR code works on your phone.';
  }
  qrBox.hidden = false;
}


//--------------------Join link: read ?code= from the URL---------------------
 
// If we landed here from a scanned QR code (/join?code=K7M2QX), remember the code.
// We join as soon as the socket is connected (see the 'connect' handler below).
let pendingJoinCode = null;


(function readJoinCodeFromUrl() {
  const raw = params.get('code');
  if (raw === null) return;
 
  const code = raw.trim().toUpperCase();
 
  // Remove ?code= from the address bar so a refresh doesn't re-join and the code
  // doesn't linger in the browser history. Keep other params such as ?as=.
  params.delete('code');
  const query = params.toString();
  history.replaceState(null, '', '/' + (query ? `?${query}` : ''));
 
  if (!CODE_PATTERN.test(code)) {
    // Shown once showHome() runs at the bottom of this file.
    initialError = 'That join link has an invalid pairing code. Type the code instead.';
    return;
  }
  codeInput.value = code;  // pre-fill the field: if auto-join fails the user can still fix/retry
  pendingJoinCode = code;
})();



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
    && Number.isFinite(e.timestamp)
    && isValidEntryKind(e);
}

function isValidEntryKind(e) {
  if (e.kind === undefined || e.kind === 'text') return true;
  return e.kind === 'image'
    && isSafeImageDataUrl(e.dataUrl)
    && typeof e.name === 'string'
    && Number.isFinite(e.size);
}
 
// The image's type, read from the data URL itself (not from a field a peer could fake).
function imageMimeOf(entry) {
  return entry.dataUrl.slice(5, entry.dataUrl.indexOf(';'));
}

 
// Add one entry. Returns false if we already had it (a duplicate), true if it is new.
function addEntry(entry) {
  if (entries.has(entry.id)) return false;
  entries.set(entry.id, entry);
  return true;
}

const itemCache = new Map(); // entry id -> <li>
 
function getEntryItem(entry) {
  let li = itemCache.get(entry.id);
  if (!li) {
    li = makeEntryItem(entry);
    itemCache.set(entry.id, li);
  }
  return li;
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

    const isImage = entry.kind === 'image';
  if (isImage) {
    li.classList.add('entry--image');
    const badge = document.createElement('span');
    badge.className = 'entry__badge';
    badge.textContent = 'Image';
    meta.appendChild(badge);
  }

 
  const who = entry.senderId === myPublicId ? 'you' : entry.senderName;
  meta.append(`${who} · ${formatTime(entry.timestamp)}`);
 
  const body = document.createElement('div');
  body.className = isImage ? 'entry__image' : 'entry__text';
  if (isImage) {
    body.appendChild(makeImagePreview(entry)); // <img> inside a button
  } else if (safeUrl) {
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
    if (entry.kind === 'image') {
      await copyImageToClipboard(entry);
      setClipStatus(`Copied image: ${entry.name}`);
      return;
    }
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
  if (currentCode) {
    joinSession(currentCode);
  } else if (pendingJoinCode) {
    // Arrived through a scanned QR code / join link: join automatically.
    const code = pendingJoinCode;
    pendingJoinCode = null; // only once; later reconnects use currentCode
    homeError.textContent = '';
    joinSession(code);
  }

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
  if (!isNew || entry.senderId === myPublicId) return;
  try {
    if (entry.kind === 'image') {
      await copyImageToClipboard(entry); // never writeText('') over the user's clipboard
      setClipStatus(`Copied image from ${entry.senderName}: ${entry.name}`);
    } else {
      await navigator.clipboard.writeText(entry.text);
      setClipStatus(`Copied from ${entry.senderName}: ${makePreview(entry.text)}`);
    }
  }
  catch (err) {
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('read-failed'));
    reader.readAsDataURL(file);
  });
}
 
// Returns an error string, or '' if this file may be sent.
function checkImageFile(file) {
  if (!IMAGE_EXTENSIONS[file.type]) return 'Unsupported image type. Use PNG, JPEG, WEBP or GIF.';
  if (file.size > MAX_IMAGE_BYTES) return `Image is too large (limit is ${formatBytes(MAX_IMAGE_BYTES)}).`;
  if (file.size === 0) return 'That image is empty.';
  return '';
}
 
// Same ack-based path as text: the server assigns seq, de-dupes by id and broadcasts 'clip:added'.
function emitImage(dataUrl, name) {
  return new Promise((resolve) => {
    socket.timeout(15000).emit('clip:send', { id: generateId(), kind: 'image', dataUrl, name }, (err, res) => {
      if (err) return resolve({ ok: false, error: 'The server did not respond. Try again.' });
      resolve(res);
    });
  });
}
 
async function sendImageFiles(fileList) {
  if (!currentCode) return setClipStatus('Join a session first.', true);
  if (!socket.connected) return setClipStatus('You are offline. Wait for the connection to come back.', true);
 
  let files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return setClipStatus('No image found. Use PNG, JPEG, WEBP or GIF.', true);
 
  let skipped = '';
  if (files.length > MAX_IMAGES_PER_BATCH) {
    skipped = ` (only the first ${MAX_IMAGES_PER_BATCH} were sent)`;
    files = files.slice(0, MAX_IMAGES_PER_BATCH);
  }
 
  let sent = 0;
  for (const file of files) {
    const problem = checkImageFile(file);
    if (problem) { setClipStatus(`${file.name || 'Image'}: ${problem}`, true); continue; }
 
    setClipStatus(`Sending ${file.name || 'image'}…`);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await emitImage(dataUrl, file.name);
      if (!res.ok) { setClipStatus(res.error, true); continue; }
      sent++;
    } catch (err) {
      setClipStatus('Could not read that image file.', true);
    }
  }
  if (sent > 0) setClipStatus(`Sent ${sent} image(s)${skipped}.`);
}
 
// ---------- Paste (Ctrl+V / Cmd+V) ----------
 
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
 
  const files = [];
  let hasText = false;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    } else if (item.kind === 'string' && item.type === 'text/plain') {
      hasText = true;
    }
  }
  if (files.length === 0) return; // plain text paste: leave the browser default alone
 
  // Copying from Word/Excel puts BOTH text and an image on the clipboard. When the user
  // is typing in a field, they want the text, so don't hijack it.
  const t = e.target;
  const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');
  if (hasText && typing) return;
 
  e.preventDefault();
  if (sessionView.hidden) return; // not in a session: nothing to send to
  sendImageFiles(files);
});
 
// ---------- Drag and drop ----------
// Listening on document.body means a missed drop never makes the browser navigate to the image.
 
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
let dragDepth = 0; // dragenter/dragleave fire for every child element, so count them
 
document.body.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  imageDrop.classList.add('dropzone--over');
});
 
document.body.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // REQUIRED, otherwise the browser refuses the drop
  e.dataTransfer.dropEffect = 'copy';
});
 
document.body.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = Math.max(dragDepth - 1, 0);
  if (dragDepth === 0) imageDrop.classList.remove('dropzone--over');
});
 
document.body.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  imageDrop.classList.remove('dropzone--over');
  if (sessionView.hidden) return;
  sendImageFiles(e.dataTransfer.files);
});
 
// ---------- Click-to-choose ----------
 
imageDrop.addEventListener('click', () => imageInput.click());
imageDrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); imageInput.click(); }
});
imageInput.addEventListener('change', () => {
  sendImageFiles(imageInput.files);
  imageInput.value = ''; // so choosing the same file again still fires 'change'
});
 
// ---------- History rendering helpers ----------
 
// <button><img></button> + file name. Only validated data URLs ever reach src (see isValidEntry).
function makeImagePreview(entry) {
  const wrap = document.createElement('div');
 
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'entry__preview';
  btn.setAttribute('aria-label', `Open ${entry.name}`);
  btn.addEventListener('click', () => openImageModal(entry));
 
  const img = document.createElement('img');
  img.className = 'entry__img';
  img.alt = entry.name;
  img.loading = 'lazy';
  img.src = entry.dataUrl;
  btn.appendChild(img);
 
  const caption = document.createElement('div');
  caption.className = 'entry__filename';
  caption.textContent = `${entry.name} · ${formatBytes(entry.size)}`;
 
  wrap.append(btn, caption);
  return wrap;
}
 
// ---------- Copy image to clipboard ----------
 
// Browsers only reliably accept image/png in ClipboardItem, so other formats go through a canvas.
async function dataUrlToPngBlob(dataUrl) {
  if (dataUrl.startsWith('data:image/png')) return (await fetch(dataUrl)).blob();
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png-failed'))), 'image/png'));
}
 
async function copyImageToClipboard(entry) {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error('image-clipboard-unsupported');
  // Passing a Promise keeps Safari happy (it requires write() to start inside the user gesture).
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToPngBlob(entry.dataUrl) })]);
}
 
// ---------- Full-size preview modal ----------
 
let modalEntry = null;
 
function openImageModal(entry) {
  modalEntry = entry;
  modalImg.src = entry.dataUrl;
  modalImg.alt = entry.name;
  modalCaption.textContent = `${entry.name} · ${formatBytes(entry.size)}`;
  if (typeof imageModal.showModal === 'function') imageModal.showModal();
  else imageModal.setAttribute('open', '');
}
 
modalCloseBtn.addEventListener('click', () => imageModal.close());
imageModal.addEventListener('click', (e) => { if (e.target === imageModal) imageModal.close(); }); // backdrop click
imageModal.addEventListener('close', () => { modalImg.removeAttribute('src'); modalEntry = null; });
 
modalDownloadBtn.addEventListener('click', () => {
  if (!modalEntry) return;
  const a = document.createElement('a');
  a.href = modalEntry.dataUrl;
  a.download = safeDownloadName(modalEntry.name, imageMimeOf(modalEntry));
  document.body.appendChild(a);
  a.click();
  a.remove();
});


// Start on the home screen.
showHome(initialError);