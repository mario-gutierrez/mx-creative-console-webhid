import WebSocket from 'ws';

const wsUrl = process.argv[2] || 'ws://localhost:8787';
const ws = new WebSocket(wsUrl);

function log(prefix, payload) {
    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] ${prefix}`, payload);
}

ws.on('open', () => {
    log('connected', wsUrl);
    ws.send(JSON.stringify({ requestId: 'state-1', action: 'getState' }));
    ws.send(JSON.stringify({ requestId: 'roller-divert', action: 'setRollerDiverted', enabled: true }));
});

ws.on('message', (raw) => {
    try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'event' && (msg.event === 'keypadKeysChanged' || msg.event === 'dialpadKeysChanged' || msg.event === 'rollerEvent')) {
            log(msg.event, msg.data);
            return;
        }

        if (msg.type === 'status') {
            log('status', msg);
            return;
        }

        // log(msg.type || 'message', msg);
    } catch (error) {
        log('parse-error', error.message);
    }
});

ws.on('error', (error) => {
    log('error', error.message);
});

ws.on('close', () => {
    log('closed', 'connection closed');
});
