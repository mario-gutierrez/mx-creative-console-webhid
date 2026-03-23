import HID from 'node-hid';

const devs = HID.devices().filter(d => d.vendorId === 0x046d && d.productId === 0xc354);
console.log('Probing ALL keypad collections for incoming data — press keys now!\n');

const handles = [];
for (const dev of devs) {
    let hid;
    try {
        hid = new HID.HID(dev.path);
    } catch (e) {
        console.log(`  SKIP usagePage=${dev.usagePage} usage=${dev.usage}: ${e.message}`);
        continue;
    }

    const label = `usagePage=${dev.usagePage} usage=${dev.usage}`;
    hid.on('data', (buf) => {
        const bytes = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`DATA [${label}] len=${buf.length}: ${bytes}`);
    });
    hid.on('error', (e) => {
        console.log(`ERR  [${label}]: ${e.message}`);
    });
    handles.push(hid);
    console.log(`  Listening on ${label}`);
}

console.log('\nWaiting 30s...\n');
setTimeout(() => {
    handles.forEach(h => { try { h.close(); } catch { } });
    process.exit(0);
}, 30000);
