// Headless smoke run: boots the game in Chrome (software WebGL), runs a scenario, reports page errors.
//   node tools/smoke.mjs [scenario.mjs] [--out dir] [--query "quality=low"] [--page path] [--w 1280] [--h 720]
// A scenario module default-exports `async (ctx) => {}` with ctx = { page, shot, wait, ev, log }.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? def : args[i + 1];
};
const scenarioPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const outDir = resolve(opt('out', '/tmp/smoke'));
const width = Number(opt('w', 1280));
const height = Number(opt('h', 720));
const pagePath = opt('page', 'index.html');
const query = opt('query', '');
const bootTimeout = Number(opt('boot', 120000));
mkdirSync(outDir, { recursive: true });

// Software-rendered Chrome is CPU-bound: a small cross-process semaphore keeps parallel runs from thrashing.
const SLOTS = Number(process.env.SMOKE_SLOTS || 2);
let slotDir = null;
for (let waited = 0; !slotDir; waited++) {
    for (let i = 0; i < SLOTS && !slotDir; i++) {
        const dir = `/tmp/battle-smoke-slot-${i}`;
        try {
            mkdirSync(dir);
            writeFileSync(join(dir, 'pid'), String(process.pid));
            slotDir = dir;
        } catch {
            try {
                process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 0);
            } catch (e) {
                if (e.code !== 'EPERM') rmSync(dir, { recursive: true, force: true });   // stale slot
            }
        }
    }
    if (!slotDir) {
        if (waited % 20 === 0) console.log('waiting for a free smoke slot...');
        await new Promise((ok) => setTimeout(ok, 1000 + Math.random() * 1000));
    }
}
process.on('exit', () => rmSync(slotDir, { recursive: true, force: true }));

const { server, port } = await startServer(root);
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/local/bin/google-chrome',
    headless: 'new',
    protocolTimeout: 600000,
    args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`
    ]
});

const problems = [];
const note = (kind, text) => {
    const line = `[${kind}] ${String(text).slice(0, 400)}`;
    if (!problems.includes(line)) problems.push(line);
};
let exitCode = 0;
try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.on('pageerror', (e) => note('pageerror', e.stack || e.message));
    page.on('console', (m) => {
        if (m.type() === 'error') note('console.error', m.text());
        else if (m.type() === 'warn' && !/GPU stall|GL Driver Message|Automatic fallback to software/i.test(m.text())) note('warn', m.text());
    });
    page.on('requestfailed', (r) => note('requestfailed', `${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) note('http', `${r.status()} ${r.url()}`); });

    const ctx = {
        page,
        log: (...a) => console.log(...a),
        wait: (ms) => new Promise((ok) => setTimeout(ok, ms)),
        ev: (fn, ...a) => page.evaluate(fn, ...a),
        shot: async (name) => {
            const file = join(outDir, `${name}.png`);
            await page.screenshot({ path: file });
            console.log(`shot ${file}`);
        }
    };

    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/${pagePath}${query ? `?${query}` : ''}`, { waitUntil: 'domcontentloaded' });
    if (pagePath === 'index.html') {
        await page.waitForFunction(
            () => window.BATTLE_ENGINE?.ready === true || document.getElementById('start-panel')?.style.display === 'flex',
            { timeout: bootTimeout, polling: 250 }
        );
        console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    if (scenarioPath) {
        const mod = await import(pathToFileURL(resolve(scenarioPath)).href);
        await mod.default(ctx);
    } else {
        await ctx.shot('boot');
    }
} catch (e) {
    note('smoke', e.stack || e.message);
    exitCode = 1;
} finally {
    await browser.close();
    server.close();
}

if (problems.length) {
    console.log(`PROBLEMS (${problems.length}):`);
    for (const p of problems.slice(0, 40)) console.log('  ' + p);
    if (problems.some((p) => p.startsWith('[pageerror]') || p.startsWith('[smoke]'))) exitCode = 1;
} else {
    console.log('no page errors');
}
process.exit(exitCode);
