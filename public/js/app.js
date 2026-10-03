// public/js/app.js

// 1. DEVICE IDENTITY


// Testing trick: two tabs in the SAME browser share localStorage, so they'd
// have the same deviceId and count as ONE device. Adding ?as=2 to the URL
// gives that tab its own separate identity.
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
const MAX_CLIP_BYTES = 5 * 1024 * 1024; // 5 MB

const syncBtn = $('sync-btn');
const sendTextBtn = $('send-text-btn');
const clipInput = $('clip-input');
const clipStatus = $('clip-status');
const receivedEmpty = $('received-empty');
const receivedBox = $('received-box');
const receivedText = $('received-text');
const receivedNote = $('received-note');
const copyReceivedBtn = $('copy-received-btn')

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
 
function showReceived(text, note) {
  receivedText.textContent = text; // textContent, never innerHTML (text comes from another device)
  receivedNote.textContent = note;
  receivedEmpty.hidden = true;
  receivedBox.hidden = false;
}
 
function resetClipUI() {
  clipInput.value = '';
  setClipStatus('');
  receivedText.textContent = '';
  receivedNote.textContent = '';
  receivedBox.hidden = true;
  receivedEmpty.hidden = false;
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
socket.on('clip:receive', async (text) => {
  if (!currentCode) return;             // ignore if we already left the session
  if (typeof text !== 'string') return; // never trust incoming data
 
  try {
    await navigator.clipboard.writeText(text);
    showReceived(text, 'Copied to your clipboard automatically.');
  } catch (err) {
    // Blocked (tab not focused, Safari needs a click, no permission, or no HTTPS).
    showReceived(text, 'Your browser blocked automatic copying. Click "Copy to my clipboard" below.');
  }
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
  socket.timeout(5000).emit('clip:send', text, (err, res) => {
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
 
copyReceivedBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(receivedText.textContent);
    receivedNote.textContent = 'Copied to your clipboard.';
  } catch (err) {
    receivedNote.textContent = 'Copy failed. Select the text above and press Ctrl+C.';
  }
});
 



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