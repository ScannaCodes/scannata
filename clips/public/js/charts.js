// Hand-rolled SVG charts: thin lines, hairline grid, crosshair tooltip.
import { esc, compact, full } from "./ui.js";

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

// series: [{ name, color, points: [{ x: Date|number, y }] }]
export function lineChart(el, { series, height = 260, zero = true, xLabel = (x) => new Date(x).toLocaleDateString(undefined, { month: "short", day: "numeric" }), yFormat = compact, tipTitle } = {}) {
  el.classList.add("chart");
  const draw = () => {
    const width = Math.max(280, el.clientWidth);
    const m = { t: 12, r: 16, b: 28, l: 46 };
    const w = width - m.l - m.r;
    const h = height - m.t - m.b;
    const xs = [...new Set(series.flatMap((s) => s.points.map((p) => +p.x)))].sort((a, b) => a - b);
    if (!xs.length) {
      el.innerHTML = `<div class="empty" style="padding:40px">No data in this range yet.</div>`;
      return;
    }
    const xMin = xs[0];
    const xMax = xs[xs.length - 1] === xMin ? xMin + 1 : xs[xs.length - 1];
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    let yMin = 0;
    let yMax = niceMax(Math.max(...ys, 0) * 1.08);
    if (!zero) {
      // growth lines: zoom to the data so small changes are visible
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.002, 1);
      const step = niceMax((hi - lo + pad * 2) / 4);
      yMin = Math.floor((lo - pad) / step) * step;
      yMax = yMin + step * 4;
      while (yMax < hi) yMax += step;
    }
    const X = (x) => m.l + ((x - xMin) / (xMax - xMin)) * w;
    const Y = (y) => m.t + h - ((y - yMin) / (yMax - yMin)) * h;

    let grid = "";
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) / 4) * i;
      grid += `<line x1="${m.l}" x2="${m.l + w}" y1="${Y(v)}" y2="${Y(v)}" class="${i ? "" : "baseline"}"/>`;
      grid += `<text x="${m.l - 10}" y="${Y(v) + 4}" text-anchor="end">${yFormat(v)}</text>`;
    }
    let xt = "";
    const nTicks = Math.min(xs.length, Math.max(2, Math.floor(w / 90)));
    for (let i = 0; i < nTicks; i++) {
      const x = xs[Math.round((i / Math.max(1, nTicks - 1)) * (xs.length - 1))];
      xt += `<text x="${X(x)}" y="${m.t + h + 20}" text-anchor="${i === 0 ? "start" : i === nTicks - 1 ? "end" : "middle"}">${esc(xLabel(x))}</text>`;
    }

    const paths = series
      .map((s) => {
        const pts = s.points.slice().sort((a, b) => a.x - b.x);
        if (!pts.length) return "";
        const d = pts.map((p, i) => `${i ? "L" : "M"}${X(+p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
        const area = `${d}L${X(+pts[pts.length - 1].x).toFixed(1)},${Y(yMin)}L${X(+pts[0].x).toFixed(1)},${Y(yMin)}Z`;
        const last = pts[pts.length - 1];
        return `<path d="${area}" fill="${s.color}" opacity="0.07"/>
          <path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          <circle cx="${X(+last.x)}" cy="${Y(last.y)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
      })
      .join("");

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))} over time">
        <g class="grid axis">${grid}</g><g class="axis">${xt}</g>${paths}
        <line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${m.t + h}" visibility="hidden"/>
        <g class="dots"></g>
        <rect x="${m.l}" y="${m.t}" width="${w}" height="${h}" fill="transparent" class="hit"/>
      </svg><div class="chart-tip"></div>`;

    const svg = el.querySelector("svg");
    const tip = el.querySelector(".chart-tip");
    const cross = el.querySelector(".crosshair");
    const dots = el.querySelector(".dots");
    const hit = el.querySelector(".hit");
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = ((ev.clientX - r.left) / r.width) * width;
      let best = xs[0];
      for (const x of xs) if (Math.abs(X(x) - sx) < Math.abs(X(best) - sx)) best = x;
      const cx = X(best);
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      const rows = series
        .map((s) => ({ s, p: s.points.find((p) => +p.x === best) }))
        .filter((r) => r.p);
      dots.innerHTML = rows
        .map(({ s, p }) => `<circle cx="${cx}" cy="${Y(p.y)}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`)
        .join("");
      tip.innerHTML = `<div class="tt-title">${esc(tipTitle ? tipTitle(best) : xLabel(best))}</div>${rows
        .map(({ s, p }) => `<div class="tt-row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><b>${full(p.y)}</b></div>`)
        .join("")}`;
      tip.classList.add("show");
      const px = (cx / width) * r.width;
      const left = px + 14 + tip.offsetWidth > r.width ? px - tip.offsetWidth - 14 : px + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${10}px`;
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", () => {
      tip.classList.remove("show");
      cross.setAttribute("visibility", "hidden");
      dots.innerHTML = "";
    });
  };
  draw();
  if (!el._ro) {
    el._ro = new ResizeObserver(() => el._draw?.());
    el._ro.observe(el);
  }
  el._draw = draw;
}

// Horizontal ranked bars, one colour (single series).
export function rankBars(el, items, { value = (d) => d.views, label = (d) => d.title, max = 6 } = {}) {
  const top = items.slice().sort((a, b) => value(b) - value(a)).slice(0, max);
  if (!top.length) {
    el.innerHTML = `<div class="empty" style="padding:30px">No clips yet.</div>`;
    return;
  }
  const hi = Math.max(...top.map(value), 1);
  el.innerHTML = `<div class="bars">${top
    .map(
      (d) => `<a class="bar-row" ${d.url ? `href="${esc(d.url)}" target="_blank" rel="noopener"` : ""} title="${esc(label(d))}">
        ${d.cover ? `<img src="${esc(d.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
        <div><div class="bar-title"><span>${esc(label(d))}</span><b>${compact(value(d))}</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${(value(d) / hi) * 100}%"></div></div></div>
      </a>`
    )
    .join("")}</div>`;
}
