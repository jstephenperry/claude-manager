// Drive the running app over the DevTools protocol to screenshot each tab.
// Usage: launch with `npx electron . --remote-debugging-port=9222`, then
//        node scripts/shoot.mjs <outDir>
import fs from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv[2] || '.';
const PORT = 9222;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) {
  console.error('no page target found:', targets.map((t) => `${t.type} ${t.url}`));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await new Promise((r) => (ws.onopen = r));

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.error('EVAL ERROR:', JSON.stringify(r.result.exceptionDetails.exception));
  return r.result?.result?.value;
};

const shoot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${name}.png`);
  await fs.writeFile(file, Buffer.from(r.result.data, 'base64'));
  console.log('shot:', file);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Report any renderer errors surfaced so far.
const errs = await evaluate(`(window.__errs || []).join(' | ')`);
if (errs) console.log('renderer errors:', errs);

for (const tab of ['sessions', 'memories', 'cleanup', 'trash']) {
  await evaluate(`
    (async () => {
      const m = await import('./state.js');
      m.set({ tab: '${tab}', projectId: null, openMemory: null });
    })()
  `);
  await wait(450);
  await shoot(tab);
}

// Open the transcript drawer on the largest non-live session.
await evaluate(`
  (async () => {
    const s = await import('./state.js');
    const t = await import('./views/transcript.js');
    const all = s.store.scan.projects.flatMap(p => p.sessions).filter(x => !x.live);
    all.sort((a,b) => b.counts.toolUse - a.counts.toolUse);
    await t.openTranscript(all[0]);
  })()
`);
await wait(1600);
await shoot('transcript');

console.log('done');
ws.close();
process.exit(0);
