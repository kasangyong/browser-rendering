/**
 * S4 방법론 진단 — 두 가지를 확인한다.
 *  (1) fire()로 던진 busy loop가 정말 메인 스레드를 막는가?
 *  (2) Page.captureScreenshot 이 메인 스레드에 걸리는가? (걸리면 관찰 도구로 못 씀)
 */
const PORT = 9222;
const URL_ARG = 'http://127.0.0.1:8765/a1-pipeline-skip/';
const BLOCK = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id === undefined) return;
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  evaluate(expression) {
    return this.send('Runtime.evaluate', { expression, returnByValue: true })
      .then(r => r.result?.value);
  }
  fire(expression) {
    this.ws.send(JSON.stringify({ id: ++this.id, method: 'Runtime.evaluate', params: { expression } }));
  }
}

const run = async () => {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  for (let i = 0; i < 40 && !(await cdp.evaluate('!!window.__A1')); i++) await sleep(250);
  await cdp.evaluate('__A1.setCount(1)');
  await cdp.evaluate('__A1.setMode("transform")');
  await sleep(1000);

  // --- (1) 블로킹이 실제로 걸리는지
  cdp.fire(`(()=>{const t=performance.now();while(performance.now()-t<${BLOCK});})()`);
  await sleep(150);
  let t0 = Date.now();
  await cdp.evaluate('1');
  const evalDelay = Date.now() - t0;
  console.log(`(1) busy loop ${BLOCK}ms 중 Runtime.evaluate 응답까지: ${evalDelay}ms`);
  console.log(`    → ${evalDelay > BLOCK * 0.5 ? '✅ 메인 스레드가 실제로 막힌다' : '❌ 안 막힘 — fire() 방식 문제'}`);

  await sleep(600);

  // --- (2) 스크린샷이 메인 스레드에 걸리는지
  cdp.fire(`(()=>{const t=performance.now();while(performance.now()-t<${BLOCK});})()`);
  await sleep(150);
  t0 = Date.now();
  await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const shotDelay = Date.now() - t0;
  console.log(`(2) busy loop ${BLOCK}ms 중 captureScreenshot 응답까지: ${shotDelay}ms`);
  console.log(`    → ${shotDelay > BLOCK * 0.5
      ? '❌ 메인 스레드에 걸린다 — S4 관찰 도구로 쓸 수 없음'
      : '✅ 메인과 무관 — S4 관찰에 사용 가능'}`);

  await cdp.send('Browser.close').catch(() => {});
  process.exit(0);
};
run().catch(e => { console.error(e); process.exit(1); });
