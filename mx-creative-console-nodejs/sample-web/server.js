import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const configPath = path.resolve(rootDir, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const app = express();
const port = Number(config.web?.port) || 8788;

app.use(express.static(path.resolve(__dirname, 'public')));

// Serve the reusable client library so browser pages can import it.
app.get('/mxCreativeConsoleNodeClient.js', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.resolve(rootDir, 'mxCreativeConsoleNodeClient.js'));
});

app.get('/api/config', (_req, res) => {
    res.json({ websocketPort: Number(config.websocket?.port) || 8787 });
});

app.listen(port, () => {
    console.log(`Sample web client running at http://localhost:${port}`);
});
