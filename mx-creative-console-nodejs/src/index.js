import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MXCreativeConsoleProvider } from './provider.js';

function loadConfig() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const defaultPath = path.resolve(__dirname, '..', 'config.json');
    const explicitPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : null;
    const configPath = explicitPath || defaultPath;

    const text = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(text);

    return {
        config,
        configPath
    };
}

const { config, configPath } = loadConfig();
const provider = new MXCreativeConsoleProvider(config);

provider.on('status', ({ message, isError }) => {
    const prefix = isError ? 'ERROR' : 'INFO';
    console.log(`[${prefix}] ${message}`);
});

provider.on('fatalError', async (error) => {
    console.error(`[FATAL] ${error.message}`);
    await provider.stop();
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[UNHANDLED_REJECTION] ${message}`);
});

provider.start();
console.log(`Loaded configuration from ${configPath}`);

const shutdown = async () => {
    console.log('Shutting down provider...');
    await provider.stop();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
