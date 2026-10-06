UniClip

UniClip is a web application designed for real-time clipboard sharing across devices. It allows users to send text, URLs, and image screenshots between paired devices connected to the same room without requiring user registration or account creation.
Technical Stack

    Backend: Node.js, Express.js, Socket.IO

    Frontend: HTML5, CSS3, JavaScript (Vanilla ES6)

    APIs & Libraries: Async Clipboard API, FileReader API, qrcode library

Architecture Overview & Task Coverage
1. Session & Pairing

    Temporary Sessions & Short Codes: Upon loading the application, server/index.js assigns a unique room token to the socket connection. Users can generate or enter a short session code to join specific room instances using Socket.IO room namespaces (socket.join(roomId)).

    No Authentication: The application contains no user database, login routes, or authentication middleware. All session data resides in volatile memory and clears when sessions expire.

    Connected Devices Indicator: The frontend (public/app.js) listens for room connection events emitted by the server, updating a visual counter element in the UI whenever a peer joins or leaves the active session.

2. Clipboard Sync

    Explicit User Sync: Built using navigator.clipboard.readText() to handle clipboard access through manual click actions, bypassing background execution limits enforced by modern browsers.

    Text & Link Parsing: Received data is processed by helper functions in public/js/utils.js. The input is evaluated using the native URL constructor to verify http: and https: schemes.

    Link Presentation: Validated links are formatted as standard HTML anchor tags (<a href="..." target="_blank" rel="noopener noreferrer">), ensuring secure external navigation.

    Permission Fallback: If browser permissions block navigator.clipboard, the application exposes a fallback manual input field (#clip-input) where users can manually paste content into the input field.

3. Real-Time Synchronization

    WebSocket Pipeline: Server and client instances communicate via bi-directional Socket.IO channels. When a clip is submitted, server/index.js receives the event and broadcasts the payload to all sockets in the designated room without requiring page reloads.

    Ordering: Every clip passing through the server is assigned an auto-incrementing sequence number (seq). Client render functions sort incoming history items according to this sequence identifier to preserve strict chronological ordering across devices.

    Deduplication: Both server and client manage sets tracking unique clip IDs (seen-ids). Additionally, content-level hashing checks prevent identical consecutive text or image payloads from re-entering the stream.

4. Clipboard History

    History Feed: Synced clips append directly into #history-list managed by public/js/history.js. Each card records and displays content previews, source metadata, and a timestamp.

    History Cap: History records are capped at a maximum of 50 items per session to optimize DOM rendering performance.

    Copy Back: History cards feature dedicated "Copy" action buttons that pass stored strings directly back into navigator.clipboard.writeText().

    Deletion: Users can delete individual history items from the list or send a clear event to wipe the active session's clip array across all connected devices.

5. Reconnection

    Automatic Reconnection Handling: The Socket.IO client automatically manages socket reconnect attempts when network drops occur.

    State Recovery: Upon reconnection, the client sends its highest recorded sequence number (seq) to the server. The server re-transmits any missed clips while existing seen-ids tracking prevents the duplication of previously processed entries.

Applied Bonus Features

This implementation includes the following 2 bonus features:

    QR Pairing

        Implementation: Uses qrcode on the client side to convert the full room URL (https://<domain>?room=<roomId>) into a QR matrix rendered onto an HTML <canvas> element (#qr-canvas).

        Usage: Scanning the QR code on a mobile device immediately opens the pairing URL, joining the corresponding session room without requiring manual code entry.

    Image Sync

        Implementation: Leverages e.clipboardData.items via global paste event handlers alongside drag-and-drop event listeners (dragover, drop).

        Conversion: Selected image blobs are converted into Base64 Data URLs using FileReader.readAsDataURL().

        Rendering: Base64 payloads travel through the standard WebSocket pipeline under type: "image". The renderer detects this type and displays an <img> tag with thumbnail previews and copy options inside the clip card.