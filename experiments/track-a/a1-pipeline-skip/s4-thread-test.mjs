/**
 * A1 · S4 — 메인 스레드를 막아도 애니메이션이 움직이는가?
 *
 * 메인 스레드를 busy loop로 점유한 상태에서 스크린샷을 연속 촬영한다.
 * 화면이 바뀌면 = 그 애니메이션은 메인 스레드 밖(컴포지터)에서 돌고 있다는 뜻.
 *
 * 사용: node s4-thread-test.mjs [--boxes=1] [--block=1400]
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const argNum = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? Number(m.split('=')[1]) : d;
};
const PORT = argNum('port', 9222);
const BOXES = argNum('boxes', 1);
const BLOCK_MS = argNum('block', 1400);
const SHOTS = 4;
const URL_ARG = process.argv.find(a => a.startsWith('http')) ||
                'http://127.0.0.1:8765/a1-pipeline-skip/';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = b64 => createHash('sha1').update(b64).digest('hex').slice(0, 12);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  /** 응답을 기다리지 않고 던지기만 한다 (메인 스레드를 막는 용도) */
  fire(expression) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression } }));
  }
}

const shot = async cdp => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  return r.data;
};

const run = async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const target = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`, { method: 'PUT' })).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 실패')), { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 40 && !(await cdp.evaluate('!!window.__A1').catch(() => false)); i++) await sleep(250);
  await cdp.evaluate(`__A1.setCount(${BOXES})`);

  const out = [];
  for (const mode of ['left', 'transform', 'willchange']) {
    await cdp.evaluate(`__A1.setMode(${JSON.stringify(mode)})`);
    await sleep(1500);   // 워밍업 · 레이어 승격 안정화

    // 기준선: 메인 스레드가 정상일 때도 화면이 바뀌는지 (애니메이션 살아있음 확인)
    const baseA = await shot(cdp);
    await sleep(400);
    const baseB = await shot(cdp);
    const baselineMoves = hash(baseA) !== hash(baseB);

    // 메인 스레드 점유 시작 (응답 대기 안 함)
    cdp.fire(`(()=>{const t=performance.now();while(performance.now()-t<${BLOCK_MS});})()`);
    await sleep(120);   // busy loop 진입 여유

    const shots = [];
    for (let i = 0; i < SHOTS; i++) {
      shots.push(hash(await shot(cdp)));
      await sleep(Math.floor((BLOCK_MS - 300) / SHOTS));
    }
    const unique = new Set(shots).size;

    // 블록이 실제로 걸렸는지 확인 (메인이 막혔다면 이 evaluate가 지연됨)
    const t0 = Date.now();
    await cdp.evaluate('1');
    const mainBlockedMs = Date.now() - t0;

    out.push({ mode, baselineMoves, shots, uniqueFrames: unique, movedWhileBlocked: unique > 1, mainBlockedMs });
    console.log(
      `${mode.padEnd(11)} | 평상시 움직임 ${baselineMoves ? 'O' : 'X'}` +
      ` | 블록 중 스크린샷 ${unique}/${SHOTS} 종류` +
      ` → ${unique > 1 ? '✅ 계속 움직임(컴포지터)' : '❌ 정지(메인 스레드 의존)'}`
    );
    await sleep(500);
  }

  await writeFile(new URL('./s4-results.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), browser: ver.Browser,
                     boxes: BOXES, blockMs: BLOCK_MS, modes: out }, null, 2));
  console.log('\n✅ s4-results.json 저장');
  await cdp.send('Browser.close').catch(() => {});
  process.exit(0);
};

run().catch(e => { console.error('실패:', e); process.exit(1); });
