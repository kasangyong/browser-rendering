/**
 * A1 보강 — 박스 개수 스윕
 *
 * 열린 질문 3개를 한 번에 답한다.
 *   Q1. 600개에서 transform 의 style recalc 가 left 보다 비싼 이유
 *   Q2. 몇 개부터 컴포지터 레이어 승격이 거부되는가
 *   Q3. will-change: transform 이 왜 아무 차이도 못 만들었나
 *
 * 계측 원칙 (A1 반성 반영):
 *   - rAF 프레임 시간은 1차 지표로 쓰지 않는다 → 트레이스 이벤트 카운트가 기본
 *   - 관찰 도구(LayerTree)가 메인 스레드에 걸리는지 먼저 검증한다
 *   - 기준은 "몇 배 빠른가"가 아니라 "어떤 이벤트가 몇 번 도는가"
 *
 * 사용: node sweep.mjs [--run=2500]
 */
import { writeFile } from 'node:fs/promises';

const argNum = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? Number(m.split('=')[1]) : d;
};
const PORT = argNum('port', 9222);
const RUN_MS = argNum('run', 2500);
const WARM_MS = 1200;
const URL_ARG = 'http://127.0.0.1:8765/a1-pipeline-skip/';

const COUNTS = [1, 10, 50, 100, 250, 500, 1000];
const MODES = ['none', 'left', 'transform', 'willchange'];
const STAGES = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'RasterTask',
                'InvalidateLayout', 'Commit'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else { const h = this.handlers.get(m.method); if (h) h(m.params); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  on(m, f) { this.handlers.set(m, f); }
  fire(e) { this.ws.send(JSON.stringify({ id: ++this.id, method: 'Runtime.evaluate', params: { expression: e } })); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
    return r.result.value;
  }
}

const run = async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 40 && !(await cdp.evaluate('!!window.__A1').catch(() => false)); i++) await sleep(250);

  // ---- 레이어 트리 관찰 준비 ----
  let latestLayers = null;
  cdp.on('LayerTree.layerTreeDidChange', p => { latestLayers = p.layers || []; });
  await cdp.send('LayerTree.enable');
  await sleep(600);

  // ---- 계측기 사전 검증: LayerTree 가 메인 스레드에 걸리는가? ----
  cdp.fire('(()=>{const t=performance.now();while(performance.now()-t<1200);})()');
  await sleep(120);
  const probeT0 = Date.now();
  await cdp.send('LayerTree.compositingReasons', { layerId: (latestLayers?.[0]?.layerId) ?? '1' })
           .catch(() => null);
  const probeMs = Date.now() - probeT0;
  console.log(`[계측기 검증] 메인 블록 1200ms 중 LayerTree 응답 ${probeMs}ms` +
              ` → ${probeMs > 600 ? '메인에 걸림(주의)' : '메인과 무관'}`);
  await sleep(1400);

  const rows = [];
  for (const n of COUNTS) {
    await cdp.evaluate(`__A1.setCount(${n})`);
    await sleep(400);
    for (const mode of MODES) {
      await cdp.evaluate(`__A1.setMode(${JSON.stringify(mode)})`);
      latestLayers = null;
      await sleep(WARM_MS);

      // 레이어 스냅샷 (승격 결과)
      const layers = latestLayers || [];
      const drawing = layers.filter(l => l.drawsContent).length;

      // 트레이스
      const events = [];
      cdp.on('Tracing.dataCollected', p => { if (p.value) events.push(...p.value); });
      const complete = new Promise(res => cdp.on('Tracing.tracingComplete', res));
      await cdp.send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: { recordMode: 'recordAsMuchAsPossible',
          includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] },
      });
      await sleep(RUN_MS);
      await cdp.send('Tracing.end');
      await complete;

      const counts = {}, dur = {};
      for (const e of events) {
        if (e.ph === 'M') continue;
        counts[e.name] = (counts[e.name] || 0) + 1;
        if (typeof e.dur === 'number') dur[e.name] = (dur[e.name] || 0) + e.dur / 1000;
      }
      const frames = counts['WebFrameWidgetImpl::BeginMainFrame'] || counts['Commit'] || 0;
      const stage = {};
      for (const s of STAGES) {
        stage[s] = { n: counts[s] || 0, ms: +(dur[s] || 0).toFixed(2),
                     perFrame: frames ? +((dur[s] || 0) / frames).toFixed(3) : null };
      }
      const row = { boxes: n, mode, frames, layers: layers.length, layersDrawing: drawing, stage,
                    animServiceMs: +(dur['AnimationTimeline::serviceAnimations'] || 0).toFixed(2),
                    animUpdateMs: +(dur['Blink.Animate.UpdateTime'] || 0).toFixed(2) };
      rows.push(row);
      console.log(
        `n=${String(n).padStart(4)} ${mode.padEnd(11)}` +
        ` frames=${String(frames).padStart(4)}` +
        ` layers=${String(layers.length).padStart(4)}` +
        ` style/frame=${String(stage.UpdateLayoutTree.perFrame ?? '-').padStart(7)}ms` +
        ` layout=${String(stage.Layout.n).padStart(4)}` +
        ` paint=${String(stage.Paint.n).padStart(6)}` +
        ` invLayout=${String(stage.InvalidateLayout.n).padStart(5)}`
      );
    }
  }

  await writeFile(new URL('./sweep-results.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), browser: ver.Browser,
                     runMs: RUN_MS, warmupMs: WARM_MS, layerToolBlockedMs: probeMs, rows }, null, 2));
  console.log('\n✅ sweep-results.json 저장');
  await cdp.send('Browser.close').catch(() => {});
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
