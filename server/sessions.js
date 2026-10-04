const crypto = require('crypto'); //initialising crypto module
const {createHistory} = require ('./history');

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; //Alphabets used in tbe expression of the code used to link
const CODE_LENGTH = 6; //Length of verification code

//Regular expression of the code
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

//session map <code, session>. code is generated.
//as for session, we make the object of elements {code, devices: Map<deviceId, device>, createdAt, lastActivity}
//in this, device object contains  : { deviceId, name, socketId, joinedAt }

const sessions = new Map();

//-------------------------Code Generation-----------------------

const generateCode = () => {
    let code = '';
    for(let i = 0; i < CODE_LENGTH; i++){
        //notice crypto.RandomInt is used instead of Math.random as the first one is more unpredictable than random function.
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

const normaliseCode = (input) => {
      return String(input ?? '').trim().toUpperCase();
}
//---------------------------------------------------------------

//------------------------Create Session-------------------------

const generateSession = () => {
    let code;

    //check a non existing code,  ie a code not in use  by another session

    do {
        code = generateCode()
    }
    while (sessions.has(code))  // code


    const session = {
        code,
        devices : new Map(),
        history : createHistory(), // use of const {createhistory} from line2
        createdAt : Date.now(),
        lastActivity  : Date.now(),
    };    // session



    sessions.set(code, session);
    return session;

}

//the short, public version of a deviceId (the full id stays private).
const publicIdOf = (deviceId) => deviceId.slice(0, 8);



const getSession = (input) => {
    const code = normaliseCode(input);
    if (!CODE_PATTERN.test(code)) return null;
    return sessions.get(code) || null;
}


//adds device if, if already exists it updates the session instead of making a duplicate
const addDevice = (code, { deviceId, name, socketId }) => {
    const session = sessions.get(code);
    if(!session) return null;

    const existing = session.devices.get(deviceId);
    session.devices.set(deviceId, {
        deviceId,
        name,
        socketId, // changes on every reconnect, deviceId does not
        joinedAt: existing ? existing.joinedAt : Date.now(),
    });
    session.lastActivity = Date.now();
    return session;
}

const removeDevice = (code, deviceId, socketId) => {
    const session = sessions.get(code);
    if (!session) return false;

    const device = session.devices.get(deviceId);
    if (!device || device.socketId !== socketId) return false;  // here it ensures that the OLD id is not to confused by the NEW id after refresh which mauy delete our new session and eliminate the newly generated id

    session.devices.delete(deviceId);
    session.lastActivity = Date.now();
    return true;
}




const getDeviceList = (code) => {
    const session = sessions.get(code);
    if (!session) return [];

    return [...session.devices.values()] // makes a array for of the values of the map of devices
        .sort((a, b) => a.joinedAt - b.joinedAt) // sorts the array in ascending order of the time of joining
        .map((d) => ({
        publicId: publicIdOf(d.deviceId), //slices the first 8 characters of the deviceId to make it public // ADDITION of publicIdOf function. does the same work
        name: d.name,
        joinedAt: d.joinedAt,
        }));
}


///---------- History Helpers ----------

// The clipboard history object of a session (or null if the session is gone).
const getHistory = (code) => {
    const session = sessions.get(code);
    return session ? session.history : null;
}
 
// One device record { deviceId, name, socketId, joinedAt } (or null).
// The server uses this to learn WHO is sending, so it never trusts a name from the browser.
const getDevice = (code, deviceId) => {
    const session = sessions.get(code);
    if (!session) return null;
    return session.devices.get(deviceId) || null;
}


// ---------- Cleanup ----------
// Every minute, delete sessions that are empty AND have been idle too long.

setInterval(() => {
    const now = Date.now();
    for (const [code, session] of sessions) {
        if (session.devices.size === 0 && now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(code);
        }
    }
}, 60 * 1000).unref(); // unref() = don't keep Node alive just for this timer


module.exports = {
  generateSession,
  getSession,
  addDevice,
  removeDevice,
  getDeviceList,
  publicIdOf,
  getHistory,
  getDevice,
};