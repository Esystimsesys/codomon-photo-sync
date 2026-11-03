import type { Growth } from '../shared/types';

type Measure = 'height' | 'weight' | 'chest' | 'head';
type Series = { measure: Measure; name: string; unit: string; color: string };
// Height and weight share one chart, as on Codomon's own page; the pair passes the dataviz palette validator
// (normal and colour-blind separation, contrast) against the card surface. Chest and head get one chart each.
const GREEN = '#2b8a4e', VIOLET = '#6250d6', SURFACE = '#fffefa';
const HEIGHT: Series = { measure: 'height', name: '身長', unit: 'cm', color: GREEN }, WEIGHT: Series = { measure: 'weight', name: '体重', unit: 'kg', color: VIOLET };
const CHEST: Series = { measure: 'chest', name: '胸囲', unit: 'cm', color: GREEN }, HEAD: Series = { measure: 'head', name: '頭囲', unit: 'cm', color: GREEN };
/** Past this many records the dots crowd the line; only the latest keeps one, and the hovered one shows its own. */
const DOTS_UP_TO = 24;

let child = '', year = '', moreOpen = false;
/** The chest/head fold on screen. Its `toggle` event arrives a task late, so the next render reads `open` from it directly. */
let fold: HTMLDetailsElement | null = null;
/** What each chart on the page draws. The SVG is drawn at bind time at the chart's real width, so its text stays at its real size. */
let charts: Record<string, { series: Series[]; records: Growth[]; label: string }> = {};
let resize: ResizeObserver | undefined;
const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The fiscal year (April to March) a day belongs to. */
const fiscal = (day: string) => Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) < 4 ? 1 : 0);
const days = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 864e5;
/** Measurements with one decimal place, as written on a growth chart (102 → 102.0). */
export const amount = (v: number) => String(v).includes('.') ? String(v) : v.toFixed(1);
/** Codomon keeps one record a month, dated the 1st, so a record is named by its month (2026-10-01 → 2026年10月). */
const month = (day: string) => `${Number(day.slice(0, 4))}年${Number(day.slice(5, 7))}月`;

/** Round tick values covering the data, about `count` steps of them. */
function ticks(min: number, max: number, count: number): number[] {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * power).find(s => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(6)));
  if (out[out.length - 1] < max) out.push(Number((out[out.length - 1] + step).toFixed(6)));
  return out;
}
/** Round ticks in exactly `steps` steps, so the right axis lands on the left axis's grid lines. */
function ticksIn(min: number, max: number, steps: number): number[] {
  if (min === max) { min -= 1; max += 1; }
  for (let power = 10 ** Math.floor(Math.log10((max - min) / steps)); ; power *= 10) for (const m of [1, 2, 5]) {
    const step = m * power, start = Math.floor(min / step) * step;
    if (start + steps * step >= max - step * 1e-9) return Array.from({ length: steps + 1 }, (_, i) => Number((start + i * step).toFixed(6)));
  }
}
/** Labels along the time axis: years for a long span, months otherwise, about one per 90px. */
function timeLabels(first: string, last: string, room: number): [number, string][] {
  const long = days(last) - days(first) > 400, out: [number, string][] = [];
  for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) for (let m = 1; m <= 12; m++) {
    const day = `${y}-${String(m).padStart(2, '0')}-01`;
    if (day >= first && day <= last && (!long || m === 1)) out.push([days(day), long ? `${y}年` : `${m}月`]);
  }
  const every = Math.ceil(out.length / Math.max(Math.floor(room / 90), 2));
  return out.filter((_, i) => i % every === 0);
}
/** One chart at a given pixel size. A second series takes the right axis, on the same grid lines as the first. */
function draw(series: Series[], records: Growth[], label: string, W: number, H: number): string {
  const rows = records.filter(g => series.some(s => g[s.measure] !== null));
  if (!rows.length) return '<p class="muted growth-none">この期間の記録はありません。</p>';
  const two = series.length > 1, PAD = { left: 40, right: two ? 40 : 12, top: two ? 30 : 10, bottom: 24 };
  const values = series.map(s => rows.map(g => g[s.measure]).filter((v): v is number => v !== null));
  const first = ticks(Math.min(...values[0]), Math.max(...values[0]), Math.max(Math.round((H - PAD.top - PAD.bottom) / 45), 3));
  const scales = [first, ...values.slice(1).map(v => v.length ? ticksIn(Math.min(...v), Math.max(...v), first.length - 1) : first)];
  const [x0, x1] = [days(rows[0].date), days(rows[rows.length - 1].date)];
  const xd = (d: number) => x0 === x1 ? (PAD.left + W - PAD.right) / 2 : PAD.left + (d - x0) / (x1 - x0) * (W - PAD.left - PAD.right);
  const y = (i: number, v: number) => H - PAD.bottom - (v - scales[i][0]) / (scales[i][scales[i].length - 1] - scales[i][0]) * (H - PAD.top - PAD.bottom);
  const grid = first.map((v, k) => `<line class="growth-grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(0, v)}" y2="${y(0, v)}"/><text class="growth-axis" x="${PAD.left - 8}" y="${y(0, v) + 4}" text-anchor="end">${v}</text>${two ? `<text class="growth-axis" x="${W - PAD.right + 8}" y="${y(0, v) + 4}">${scales[1][k]}</text>` : ''}`).join('');
  // Each axis is named above it, with a stroke of its line's colour, so which scale belongs to which line is never colour alone.
  const titles = two ? series.map((s, i) => { const edge = i ? W : 0, dir = i ? -1 : 1;
    return `<line x1="${edge}" x2="${edge + dir * 14}" y1="12" y2="12" stroke="${s.color}" stroke-width="2"/><text class="growth-axis" x="${edge + dir * 18}" y="16" text-anchor="${i ? 'end' : 'start'}">${s.name}（${s.unit}）</text>`; }).join('') : '';
  const labels = (x0 === x1 ? [[x0, month(rows[0].date)] as [number, string]] : timeLabels(rows[0].date, rows[rows.length - 1].date, W - PAD.left - PAD.right))
    .map(([d, text]) => `<text class="growth-axis" x="${xd(d)}" y="${H - 6}" text-anchor="middle">${text}</text>`).join('');
  const lines = series.map((s, i) => {
    const points = rows.filter(g => g[s.measure] !== null).map(g => [xd(days(g.date)), y(i, g[s.measure]!)]);
    const path = points.map(([px, py], k) => `${k ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    const dots = (points.length > DOTS_UP_TO ? points.slice(-1) : points).map(([px, py]) => `<circle cx="${px}" cy="${py}" r="4" fill="${s.color}" stroke="${SURFACE}" stroke-width="2"/>`).join('');
    return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
  const focus = series.map(s => `<circle class="growth-focus" r="4" fill="${s.color}" stroke="${SURFACE}" stroke-width="2" visibility="hidden"/>`).join('');
  const data = esc(JSON.stringify(rows.map(g => [xd(days(g.date)), series.map((s, i) => g[s.measure] === null ? null : y(i, g[s.measure]!)),
    `${month(g.date)}　${series.filter(s => g[s.measure] !== null).map(s => `${two ? `${s.name} ` : ''}${amount(g[s.measure]!)} ${s.unit}`).join('・')}`])));
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="${label}${rows.length}件。左右の矢印キーで1件ずつ読めます。" data-growth-points="${data}">${grid}${titles}${labels}${lines}<line class="growth-cross" y1="${PAD.top}" y2="${H - PAD.bottom}" visibility="hidden"/>${focus}</svg><div class="growth-tip" role="status" hidden></div>`;
}
/** A chart card: its title with the latest values, and a slot the SVG is drawn into at bind time. */
function card(key: string, series: Series[], records: Growth[], className = ''): string {
  const latest = series.map(s => [s, [...records].reverse().find(g => g[s.measure] !== null)] as const);
  const two = series.length > 1;
  const title = two ? series.map(s => s.name).join('と') : `${series[0].name}<small>（${series[0].unit}）</small>`;
  const now = latest.filter(([, g]) => g).map(([s, g]) => `<span>${two ? `<i class="growth-key" style="background:${s.color}"></i>${s.name} ` : ''}${amount(g![s.measure]!)} ${s.unit}${two ? '' : `<small>${month(g!.date)}</small>`}</span>`).join('');
  const when = two && latest.some(([, g]) => g) ? `<small>${month(latest.map(([, g]) => g?.date ?? '').sort().pop()!)}時点</small>` : '';
  const label = latest.filter(([, g]) => g).map(([s, g]) => `${s.name}の推移。最新は${month(g!.date)}の${amount(g![s.measure]!)}${s.unit}。`).join('');
  charts[key] = { series, records, label };
  return `<section class="growth-chart ${className}"><div class="growth-chart-head"><h3>${title}</h3><div class="growth-now">${now}${when}</div></div><div class="growth-plot" data-growth-chart="${key}"></div></section>`;
}
const value = (v: number | null) => v === null ? '<span class="muted">-</span>' : amount(v);
function table(caption: string, series: Series[], records: Growth[]): string {
  const rows = records.filter(g => series.some(s => g[s.measure] !== null)).reverse();
  return `<table class="growth-table"><caption class="sr-only">${esc(caption)}</caption><thead><tr><th scope="col">月</th>${series.map(s => `<th scope="col">${s.name}（${s.unit}）</th>`).join('')}</tr></thead><tbody>${rows.map(g => `<tr><th scope="row">${month(g.date)}</th>${series.map(s => `<td>${value(g[s.measure])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
/** The growth page: one child at a time, height and weight in one large chart, chest and head folded away below. */
export function growthView(all: Growth[]): string {
  charts = {};
  if (fold?.isConnected) moreOpen = fold.open;
  const intro = '<div class="heading compact"><div><h1>成長記録</h1><p class="muted">園で測った身長・体重です。保存先の「成長記録」フォルダにも、子どもごとのCSVファイルで残します。</p></div></div>';
  if (!all.length) return `${intro}<div class="empty"><h3>成長記録がまだありません</h3><p>同期すると、コドモンに入力された成長記録がここに表示されます。</p></div>`;
  const children = [...new Set(all.map(g => g.child))];
  if (!children.includes(child)) child = children[0];
  const mine = all.filter(g => g.child === child);
  const years = [...new Set(mine.map(g => fiscal(g.date)))].sort((a, b) => b - a);
  if (year && !years.includes(Number(year))) year = '';
  const shown = mine.filter(g => !year || fiscal(g.date) === Number(year)).sort((a, b) => a.date.localeCompare(b.date));
  const tabs = children.length > 1 ? `<div class="tabs" role="group" aria-label="子どもを選ぶ">${children.map(c => `<button class="tab ${c === child ? 'active' : ''}" data-growth-child="${esc(c)}" aria-pressed="${c === child}">${esc(c)}</button>`).join('')}</div>` : '';
  const filter = `<label class="growth-year">期間<select data-growth-year><option value="">すべての期間</option>${years.map(y => `<option value="${y}" ${String(y) === year ? 'selected' : ''}>${y}年度（${y}年4月〜${y + 1}年3月）</option>`).join('')}</select></label>`;
  const measured = shown.filter(g => g.chest !== null || g.head !== null).length;
  const more = mine.some(g => g.chest !== null || g.head !== null) ? `<details class="growth-more" data-growth-more ${moreOpen ? 'open' : ''}><summary>胸囲・頭囲<small>${measured ? `${measured}件` : 'この期間の記録はありません'}</small></summary>${measured ? `<div class="growth-charts">${card('chest', [CHEST], shown)}${card('head', [HEAD], shown)}</div>${table(`${child}の胸囲・頭囲`, [CHEST, HEAD], shown)}` : ''}</details>` : '';
  return `${intro}${tabs}${filter}${card('main', [HEIGHT, WEIGHT], shown, 'growth-main')}${more}<h2 class="growth-table-title">記録の一覧</h2>${table(`${child}の成長記録`, [HEIGHT, WEIGHT], shown)}`;
}
/** The crosshair with its tooltip (pointer and arrow keys) on one drawn chart. */
function bindPlot(svg: SVGSVGElement): void {
  const W = svg.viewBox.baseVal.width, points = JSON.parse(svg.dataset.growthPoints!) as [number, (number | null)[], string][];
  const cross = svg.querySelector<SVGLineElement>('.growth-cross')!, dots = Array.from(svg.querySelectorAll<SVGCircleElement>('.growth-focus')), tip = svg.parentElement!.querySelector<HTMLElement>('.growth-tip')!;
  let current = points.length - 1;
  const show = (i: number) => {
    current = i; const [px, ys, text] = points[i], scale = svg.getBoundingClientRect().width / W;
    cross.setAttribute('x1', String(px)); cross.setAttribute('x2', String(px)); cross.removeAttribute('visibility');
    dots.forEach((dot, k) => { if (ys[k] === null) return dot.setAttribute('visibility', 'hidden'); dot.setAttribute('cx', String(px)); dot.setAttribute('cy', String(ys[k])); dot.removeAttribute('visibility'); });
    tip.textContent = text; tip.hidden = false;
    const top = Math.min(...ys.filter((v): v is number => v !== null));
    tip.style.left = `${Math.min(Math.max(px * scale, tip.offsetWidth / 2), W * scale - tip.offsetWidth / 2)}px`; tip.style.top = `${Math.max(top * scale - 40, 0)}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); tip.hidden = true; };
  svg.addEventListener('pointermove', e => {
    const at = (e.clientX - svg.getBoundingClientRect().left) / (svg.getBoundingClientRect().width / W);
    show(points.reduce((best, p, i) => Math.abs(p[0] - at) < Math.abs(points[best][0] - at) ? i : best, 0));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(current));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); show(Math.min(Math.max(current + (e.key === 'ArrowRight' ? 1 : -1), 0), points.length - 1));
  });
}
/** Child tabs, the period filter, the chest/head fold, and each chart drawn (and redrawn on resize) at its real width. */
export function bindGrowth(root: HTMLElement, render: () => void): void {
  root.querySelectorAll<HTMLElement>('[data-growth-child]').forEach(b => b.addEventListener('click', () => { child = b.dataset.growthChild!; year = ''; render(); }));
  root.querySelector<HTMLSelectElement>('[data-growth-year]')?.addEventListener('change', e => { year = (e.target as HTMLSelectElement).value; render(); });
  fold = root.querySelector<HTMLDetailsElement>('[data-growth-more]');
  fold?.addEventListener('toggle', e => { moreOpen = (e.target as HTMLDetailsElement).open; });
  resize?.disconnect();
  const drawn = new WeakMap<HTMLElement, number>();
  const fill = (slot: HTMLElement) => {
    const width = Math.floor(slot.clientWidth);
    if (!width || drawn.get(slot) === width) return;
    drawn.set(slot, width);
    const { series, records, label } = charts[slot.dataset.growthChart!];
    slot.innerHTML = draw(series, records, label, width, series.length > 1 ? Math.round(Math.min(Math.max(width * 0.42, 260), 380)) : 180);
    const svg = slot.querySelector<SVGSVGElement>('svg');
    if (svg) bindPlot(svg);
  };
  resize = new ResizeObserver(entries => entries.forEach(e => fill(e.target as HTMLElement)));
  root.querySelectorAll<HTMLElement>('[data-growth-chart]').forEach(slot => { fill(slot); resize!.observe(slot); });
}
