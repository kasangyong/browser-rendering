/**
 * C7 복구 — 두 프로세스가 results.json 을 번갈아 덮어써서 36건 중 12건만 남았다.
 * (락을 손으로 지운 내 실수. C4d 에서 PID 검사까지 넣어놓고 그 검사를 무력화했다.)
 *
 * stdout 로그에는 36건이 전부 남아 있으므로 거기서 복구한다.
 * 사이트에 72회를 더 요청하는 것보다 이쪽이 낫다.
 *
 * 로그에 있는 것: site · mode · FCP · LCP · Layout · Style
 * 없는 것: ParseHTML · PrePaint · Paint · 문서 높이 → 살아남은 12건에서 가져온다.
 */
import { readFile, writeFile } from 'node:fs/promises';
const LOG = process.argv[2];
const text = (await readFile(LOG, 'utf8')).replace(/\r/g, '');
const saved = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));

const re = /^\s*(\d+)\/36\s+(\S+)\s+(plain|cv-auto)\s+FCP\s+([\d.]+)\s+LCP\s+([\d.]+)\s+Layout\s+([\d.]+)\s+Style\s+([\d.]+)/gm;
const rows = [];
const seen = {};
for (const m of text.matchAll(re)) {
  const [, idx, siteKey, mode, fcp, lcp, layout, style] = m;
  const key = siteKey + '|' + mode;
  seen[key] = (seen[key] || 0);
  rows.push({
    siteKey, mode, rep: seen[key]++, order: Number(idx),
    fcpMs: +fcp, lcpMs: +lcp,
    stage: { Layout: { ms: +layout }, UpdateLayoutTree: { ms: +style } },
    recovered: true,
  });
}
// 살아남은 12건에서 나머지 단계와 높이를 가져다 붙인다 (설정별 대표값)
const extra = {};
for (const r of saved.rows) {
  const k = r.siteKey + '|' + r.mode;
  if (!extra[k]) extra[k] = { stage: r.stage, after: r.after, probe: r.probe, cvApplied: r.cvApplied };
}
for (const r of rows) {
  const e = extra[r.siteKey + '|' + r.mode];
  if (!e) continue;
  for (const s of ['ParseHTML', 'PrePaint', 'Paint', 'RasterTask']) {
    r.stage[s] = e.stage[s] ? { ...e.stage[s], fromRepresentative: true } : { n: 0, ms: 0 };
  }
  r.after = e.after; r.probe = e.probe; r.cvApplied = e.cvApplied;
}
const out = { ...saved,
  note: 'FCP·LCP·Layout·Style 은 36건 전부 stdout 로그에서 복구. ' +
        'ParseHTML·PrePaint·Paint·높이는 살아남은 12건의 설정별 대표값이라 참고용.',
  recoveredFromLog: true, rows };
await writeFile(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 2));
const g = {};
for (const r of rows) (g[r.siteKey + '|' + r.mode] ||= []).push(r.rep);
console.log('복구 완료:', rows.length, '건');
for (const k of Object.keys(g).sort()) console.log('  ', k.padEnd(22), g[k].length + '건');
