const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const sessions = require('./sessions');

const PORT = process.env.PORT || 3000;

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
    return typeof id === 'string' && id.length >= 8 && id.length <= 64;
}


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
        });
    })

     socket.on('session:join', (payload, ack) => {
        if (typeof ack !== 'function') return;

        const { code, deviceId, name } = payload || {};
        if (!isValidDeviceId(deviceId)) {
            return ack({ ok: false, error: 'Invalid device id.' });
        }

        const session = sessions.getSession(code);
        if (!session) {
            return ack({ ok: false, error: 'Session not found. Check the code and try again.' });
        }

        enterSession(socket, session, deviceId, cleanName(name));
        console.log(`➡️  ${cleanName(name)} joined ${session.code}`);

        ack({
            ok: true,
            code: session.code,
            devices: sessions.getDeviceList(session.code),
        });
    });

    socket.on('session:leave', () => {
        leaveCurrentSession(socket);
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