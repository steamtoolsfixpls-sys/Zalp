// Minimal static file server for local play and headless checks: `node tools/serve.mjs [port]`.
import http from 'node:http';
import { exec } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.ktx2': 'image/ktx2',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav'
};

export function startServer(root, port = 0) {
    const base = resolve(root);
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let filePath = normalize(join(base, urlPath));
        if (!filePath.startsWith(base)) {
            res.writeHead(403).end();
            return;
        }
        try {
            let st = statSync(filePath);
            if (st.isDirectory()) {
                filePath = join(filePath, 'index.html');
                st = statSync(filePath);
            }
            res.writeHead(200, {
                'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
                'Content-Length': st.size,
                'Cache-Control': 'no-cache'
            });
            createReadStream(filePath).pipe(res);
        } catch {
            res.writeHead(404).end('not found');
        }
    });
    return new Promise((ok, reject) => {
        let candidate = port;
        let attempts = 0;
        const onError = (err) => {
            if (err.code === 'EADDRINUSE' && candidate !== 0 && attempts < 50) {
                attempts += 1;
                candidate = attempts === 50 ? 0 : candidate + 1;
                server.listen(candidate, '127.0.0.1');
                return;
            }
            server.off('error', onError);
            reject(err);
        };
        server.on('error', onError);
        server.listen(candidate, '127.0.0.1', () => {
            server.off('error', onError);
            ok({ server, port: server.address().port });
        });
    });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
const selfPath = resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (entryPath === selfPath) {
    const root = resolve(fileURLToPath(import.meta.url), '..', '..');
    const args = process.argv.slice(2);
    const shouldOpen = args.includes('--open');
    const portArg = Number(args.find((a) => /^\d+$/.test(a))) || 8080;
    const { port } = await startServer(root, portArg);
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Serving ${root} at ${url}`);
    if (shouldOpen && process.platform === 'win32') {
        exec(`start "" "${url}"`);
    }
}
