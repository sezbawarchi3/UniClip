const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const sessions = require('./sessions');
const { isValidEntryId } = require('./history');

const PORT = process.env.PORT || 3000;

// const MAX_CLIP_BYTES = 5 * 1024 * 1024; // 5 MB
// we commented the max bytes because this now lives in history and can ONLY be accessed from there.
const app = express();
const server = http.createServer(app); // Socket.io needs the raw HTTP server
const io = new Server(server);


// Serve everything inside /public (index.html, css, js).
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Helpers ----------

const cleanName = (raw) => {
    const name = String(raw ?? '').trim().slice(0, 40);
    return name || 'Unknown device';
}

const isValidDeviceId = (id) => {
    return typeof id == 'string' && id.length >= 8 && id.length <= 64;
}


// if the browser sent no callback, use a do-nothing function so reply() never crashes.
const safeAck = (ack) => (typeof ack === 'function' ? ack : () => {});

//list of all connected devices in the socket room, through code
const broadcastDevices = (code) => {
    io.to(code).emit('devices:update', {
        code,
        devices: sessions.getDeviceList(code),
    })
}


const leaveCurrentSession = (socket) => {
    const {code, deviceId} = socket.data;
    if (!code) return; // not in a session

    socket.leave(code);
    sessions.removeDevice(code, deviceId, socket.id);
    socket.data.code = null;

    broadcastDevices(code);
}

// FIXED: Passed missing arguments (socket, session, deviceId, name)
const enterSession = (socket, session, deviceId, name) => {
    // If this socket was in a DIFFERENT session, leave that one first.
    if (socket.data.code && socket.data.code !== session.code) {
        leaveCurrentSession(socket);
    }

    sessions.addDevice(session.code, { deviceId, name, socketId: socket.id });
    socket.join(session.code); // rooms let us message everyone in a session
    socket.data.code = session.code; // socket.data = per-connection scratch space
    socket.data.deviceId = deviceId;

    broadcastDevices(session.code);
}


// ---------- Socket events ----------


// FIXED: Changed 'Connection' to lowercase 'connection'
io.on('connection', (socket) => {
    console.log(`Socket Connected : ${socket.id}`);

    //here browser sends .emit(sessioncreate, payload, callback), her is a kind of reply by mentioning the callback as ack
    // FIXED: Changed io.on to socket.on and event name to 'session:create'
    socket.on('session:create', (payload, ack) =>{
        if(typeof ack != 'function') return; //ack is not a function, so we cannot send back the response to the browser
        const { deviceId, name } = payload || {};
        if (!isValidDeviceId(deviceId)) {
            return ack({ ok: false, error: 'Invalid device id.' });
        }
        // FIXED: Changed sessions.createSession() to sessions.generateSession()
        const session = sessions.generateSession();
        enterSession(socket, session, deviceId, cleanName(name));
        console.log(`New Session ${session.code} created by ${cleanName(name)}`);

        ack({
            ok: true,
            code: session.code,
            devices: sessions.getDeviceList(session.code),
            entries: session.history.list(), // existing history (empty for a new session)
        });
    })

     socket.on('session:join', (payload, ack) => {
        if (typeof ack != 'function') return;

        const { code, deviceId, name } = payload || {};
        if (!isValidDeviceId(deviceId)) {
            return ack({ ok: false, error: 'Invalid device id.' });
        }

        const session = sessions.getSession(code);
        if (!session) {
            return ack({ ok: false, error: 'Session not found. Check the code and try again.' });
        }

        enterSession(socket, session, deviceId, cleanName(name));
        console.log(`->  ${cleanName(name)} joined ${session.code}`);

        ack({
            ok: true,
            code: session.code,
            devices: sessions.getDeviceList(session.code),
            entries: session.history.list(), // late joiners / reconnects get the full history
        });
    });

    socket.on('session:leave', () => {
        leaveCurrentSession(socket);
    });


    // Browser sends: socket.emit('clip:send', { id, text }, callback)
    socket.on('clip:send', (payload, ack) => {
        const reply = safeAck(ack);

        // Use the room the SERVER recorded for this socket, never one sent by the client.
        const code = socket.data.code;
        if (!code) {
            return reply({ ok: false, error: 'Join a session first.' });
        }

        if (typeof payload !== 'object' || payload === null) {
            return reply({ ok: false, error: 'Invalid clipboard message.' });
        }

        const history = sessions.getHistory(code);
        const device = sessions.getDevice(code, socket.data.deviceId);
        if (!history || !device) {
            return reply({ ok: false, error: 'Session not found. Rejoin and try again.' });
        }

        // history.add() checks the id, the text type, the size (in bytes) and "empty",
        // gives the entry its seq number, and ignores duplicate ids.
        // WHO sent it comes from the server's own records, NOT from the payload,
        // so a browser cannot pretend to be another device.
        const result = history.add({
            id: payload.id,
            text: payload.text,
            senderId: sessions.publicIdOf(device.deviceId),
            senderName: device.name,
        });
        if (!result.ok) {
            return reply({ ok: false, error: result.error });
        }

        const receivers = Math.max(sessions.getDeviceList(code).length - 1, 0);

        // Same id seen before (e.g. a retry): tell the sender "ok", but do NOT broadcast again.
        if (result.duplicate) {
            return reply({ ok: true, duplicate: true, receivers });
        }

        // Everyone in the room INCLUDING the sender: the history is shared state, and
        // every screen draws it from this one event. `evicted` = old entries that were
        // dropped to stay under the size caps, so every screen drops them too.
        io.to(code).emit('clip:added', { entry: result.entry, evicted: result.evicted });

        // Log only the SIZE, never the content: clipboard data is private.
        console.log(`Clip #${result.entry.seq} in ${code} : ${Buffer.byteLength(result.entry.text, 'utf8')} bytes --> ${receivers} other device(s)`);
        reply({ ok: true, duplicate: false, receivers });
    });

    // Browser sends: socket.emit('clip:delete', { id }, callback)
    socket.on('clip:delete', (payload, ack) => {
        const reply = safeAck(ack);

        const code = socket.data.code;
        if (!code) {
            return reply({ ok: false, error: 'Join a session first.' });
        }

        const history = sessions.getHistory(code);
        const id = payload && payload.id;
        if (!history || !isValidEntryId(id)) {
            return reply({ ok: false, error: 'Invalid entry id.' });
        }

        if (!history.remove(id)) {
            return reply({ ok: false, error: 'That item no longer exists.' });
        }

        io.to(code).emit('clip:deleted', { ids: [id] });
        reply({ ok: true });
    });

    socket.on('clip:clear', (payload, ack) => {
        const reply = safeAck(ack);

        const code = socket.data.code;
        const history = code ? sessions.getHistory(code) : null;
        if (!history) {
            return reply({ ok: false, error: 'Join a session first.' });
        }

        const removed = history.clear();
        io.to(code).emit('clip:cleared', {});
        console.log(`History cleared in ${code} (${removed} item(s))`);
        reply({ ok: true, removed });
    });

    socket.on('disconnect', (reason) => {
        console.log(`Socket disconnected: ${socket.id} (${reason})`);
        leaveCurrentSession(socket);
    });
});

// FIXED: Moved server.listen OUTSIDE of io.on so it executes at app startup
console.log('Attempting to start server on port:', PORT);

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});