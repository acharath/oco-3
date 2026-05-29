"use strict";

/* Timeseries view — CO₂ from co2_sam.csv, SIF from sif_sam.csv, switchable */
(function () {
  const TS_BANDS = [
    { key: 'arctic',    label: 'Arctic',           latMin:  60, latMax:  90, color: '#93d5f7' },
    { key: 'mid_north', label: 'N. Mid-latitudes',  latMin:  30, latMax:  60, color: '#5b8ff9' },
    { key: 'tropics',   label: 'Tropics',            latMin: -30, latMax:  30, color: '#ffc444' },
    { key: 'mid_south', label: 'S. Mid-latitudes',   latMin: -60, latMax: -30, color: '#29d8a8' },
    { key: 'antarctic', label: 'Antarctic',          latMin: -90, latMax: -60, color: '#be8fff' },
  ];

  const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const CO2_ROWS_EST = 6053903;
  const SIF_ROWS_EST = 18929841;
  const TS_PALETTE = [
    '#00f5ff','#ff1493','#39ff14','#ff6b35','#bf00ff','#ffd700',
    '#ff4466','#00ffaa','#ff69b4','#4dbbff','#ff8c00','#7fff00',
  ];

  // ── CO₂ data (from co2_sam.csv) ───────────────────────────────
  const bandRaw  = new Map(TS_BANDS.map(b => [b.key, new Map()]));
  let   bandAvgs = new Map();
  const co2Raw   = new Map();   // cityKey → monthMs → [vals]
  const cityMeta = new Map();   // cityKey → {city, country}
  let co2Loaded  = false;
  let co2Loading = false;

  // ── SIF data (from sif_sam.csv) ───────────────────────────────
  const sifRaw   = new Map();   // cityName → monthMs → [vals]
  const sifAvgs  = new Map();   // cityName → monthMs → avg
  let sifLoaded  = false;
  let sifLoading = false;

  // ── shared month list ─────────────────────────────────────────
  let allMonths  = [];          // sorted millisecond timestamps

  // ── chart & view state ────────────────────────────────────────
  let chart       = null;
  let pendingS    = null;
  let tsMode      = 'co2';
  let highlighted = new Set();
  let lastS       = null;

  // ── helpers ────────────────────────────────────────────────────
  function msToTag(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  function computeBandAvgs() {
    bandAvgs = new Map();
    for (const band of TS_BANDS) {
      const avgs = new Map();
      for (const [m, vals] of bandRaw.get(band.key))
        avgs.set(m, vals.reduce((s, v) => s + v, 0) / vals.length);
      bandAvgs.set(band.key, avgs);
    }
  }

  function cityKeysForSelection(selNames) {
    const keys = [];
    for (const key of cityMeta.keys())
      if (selNames.includes(cityMeta.get(key).city)) keys.push(key);
    return keys;
  }

  function buildCo2MonthlyAvgs(key) {
    const out = {};
    for (const [ms, vals] of co2Raw.get(key))
      out[ms] = vals.reduce((s, v) => s + v, 0) / vals.length;
    return out;
  }

  function monthInRange(ms, S) {
    if (!S || !S.mfrom || !S.mto) return true;
    return msToTag(ms) >= S.mfrom && msToTag(ms) <= S.mto;
  }

  function filteredMonths(S) { return allMonths.filter(m => monthInRange(m, S)); }

  function rebuildAllMonths() {
    const set = new Set();
    for (const mm of co2Raw.values())  for (const ms of mm.keys()) set.add(ms);
    for (const mm of sifAvgs.values()) for (const ms of mm.keys()) set.add(ms);
    allMonths = Array.from(set).sort((a, b) => a - b);
  }

  // ── status display ─────────────────────────────────────────────
  function updateStatus() {
    const status = document.getElementById('ts-status');
    const prog   = document.getElementById('ts-prog');
    if (!status) return;

    const co2Pct = co2Loaded ? 100 : co2Loading ? 40 : 0;
    const sifPct = sifLoaded ? 100 : sifLoading ? 40 : 0;
    const overall = Math.round((co2Pct + sifPct) / 2);
    if (prog && !co2Loaded || !sifLoaded)
      prog && (prog.style.width = overall + '%');

    if (!co2Loaded && !sifLoaded) { status.textContent = 'Loading CO₂ & SIF data…'; return; }
    if (!co2Loaded) { status.textContent = 'Loading CO₂ data…'; return; }
    if (!sifLoaded) { status.textContent = 'CO₂ ready · Loading SIF data…'; return; }
    // both loaded — show mode-specific status
    if (lastS) {
      const n = (lastS.sel || []).length;
      const months = filteredMonths(lastS).length;
      const hl = highlighted.size ? ` · ${[...highlighted].join(', ')} highlighted` : '';
      status.textContent = `${n} cit${n !== 1 ? 'ies' : 'y'} · ${months} months · click a line to bold${hl}`;
    }
  }

  // ── toggle UI ──────────────────────────────────────────────────
  function buildToggle() {
    if (document.getElementById('ts-mode-toggle')) return;
    const head = document.querySelector('.ts-head');
    if (!head) return;
    const wrap = document.createElement('div');
    wrap.id = 'ts-mode-toggle';
    wrap.style.cssText = 'display:flex;gap:0;margin-left:auto;flex-shrink:0;border:1px solid #1e1e1e;border-radius:4px;overflow:hidden';
    ['co2','sif'].forEach(mode => {
      const btn = document.createElement('button');
      btn.dataset.mode = mode;
      btn.textContent  = mode === 'co2' ? 'CO₂' : 'SIF';
      btn.style.cssText = 'padding:3px 11px;font-size:9.5px;font-family:inherit;cursor:pointer;border:none;letter-spacing:.06em;transition:background .12s,color .12s';
      btn.addEventListener('click', () => {
        tsMode = mode;
        highlighted.clear();
        syncToggle();
        if (lastS) updateChart(lastS);
      });
      wrap.appendChild(btn);
    });
    head.appendChild(wrap);
    syncToggle();
  }

  function syncToggle() {
    document.querySelectorAll('#ts-mode-toggle button').forEach(btn => {
      const on = btn.dataset.mode === tsMode;
      btn.style.background = on ? 'rgba(0,245,255,0.15)' : 'transparent';
      btn.style.color      = on ? '#00f5ff' : '#444';
    });
  }

  // ── chart options ──────────────────────────────────────────────
  function axisLabel() { return tsMode === 'co2' ? 'CO₂ (ppm)' : 'SIF (W/m²/sr/nm)'; }
  function fmtV(v)     { return tsMode === 'co2' ? v.toFixed(2)+' ppm' : v.toFixed(4)+' W/m²'; }

  function chartOptions() {
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#555', font: { size: 9.5, family: "'Segoe UI',system-ui,sans-serif" },
            boxWidth: 20, boxHeight: 2, padding: 12,
            filter: item => !item.text.startsWith('_'),
          },
        },
        tooltip: {
          backgroundColor: 'rgba(8,8,8,0.94)', borderColor: '#222', borderWidth: 1,
          titleColor: '#999', bodyColor: '#ccc', padding: 10,
          callbacks: {
            title: items => items[0]?.label,
            label(ctx) {
              if (ctx.dataset.label.startsWith('_')) return null;
              const v = ctx.parsed.y;
              if (v == null) return null;
              return ` ${ctx.dataset.label}: ${fmtV(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          ticks: { color: '#3a3a3a', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 14 },
          grid: { color: '#0d0d0d', drawTicks: false }, border: { color: '#1a1a1a' },
        },
        y: {
          ticks: { color: '#4a4a4a', font: { size: 10 },
            callback: v => tsMode === 'co2' ? v.toFixed(1) : v.toFixed(3), maxTicksLimit: 8 },
          grid: { color: '#0d0d0d', drawTicks: false }, border: { color: '#1a1a1a' },
          title: { display: true, text: axisLabel(), color: '#3a3a3a', font: { size: 10 } },
        },
      },
    };
  }

  // ── build & render chart ───────────────────────────────────────
  function updateChart(S) {
    lastS = S;
    buildToggle();
    syncToggle();

    const hint   = document.getElementById('ts-hint');
    const ready  = tsMode === 'co2' ? co2Loaded : sifLoaded;

    if (!ready) {
      updateStatus();
      if (hint) {
        hint.textContent = tsMode === 'co2' ? 'Loading CO₂ data…' : 'Loading SIF data… (this may take a moment)';
        hint.style.display = 'block';
      }
      return;
    }

    const selNames    = S.sel || [];
    const activeBands = S.activeBands || new Set();
    const hasCity     = selNames.length > 0;
    const hasBand     = activeBands.size > 0 && tsMode === 'co2';

    if (!hasCity && !hasBand) {
      if (hint) { hint.innerHTML = 'Select cities in the sidebar<br>or toggle latitude bands'; hint.style.display = 'block'; }
      if (chart) { chart.data.labels = []; chart.data.datasets = []; chart.update('none'); }
      updateStatus();
      return;
    }
    if (hint) hint.style.display = 'none';

    const months    = filteredMonths(S);
    const labels    = months.map(m => { const d = new Date(m); return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`; });
    const datasets  = [];
    const anyHL     = highlighted.size > 0;

    // ── lat-band lines (CO₂ mode only) ────────────────────────
    if (tsMode === 'co2') {
      for (const band of TS_BANDS) {
        if (!activeBands.has(band.key)) continue;
        const avgs = bandAvgs.get(band.key);
        datasets.push({
          label: band.label + ' avg', yAxisID: 'y',
          data: months.map(m => avgs.has(m) ? avgs.get(m) : null),
          borderColor: band.color + '55', backgroundColor: 'transparent',
          borderWidth: 1.2, fill: false, tension: 0, pointRadius: 0, spanGaps: true, order: 10,
        });
      }
    }

    if (hasCity) {
      const cityKeys  = cityKeysForSelection(selNames);
      const co2AvgMap = tsMode === 'co2'
        ? new Map(cityKeys.map(k => [cityMeta.get(k).city, buildCo2MonthlyAvgs(k)]))
        : null;

      // per-city value lookup
      function getVals(cityName) {
        return months.map(ms => {
          if (tsMode === 'co2') {
            const avgs = co2AvgMap.get(cityName);
            return avgs ? (avgs[ms] ?? null) : null;
          }
          // SIF mode — use sifAvgs keyed by millisecond timestamp
          const mo = sifAvgs.get(cityName);
          return mo ? (mo.get(ms) ?? null) : null;
        });
      }

      // gather city names that actually have data in this mode
      const activeCities = tsMode === 'co2'
        ? cityKeys.map(k => cityMeta.get(k).city)
        : selNames.filter(name => sifAvgs.has(name));

      // ── mean ±1σ band (milk spill) ───────────────────────────
      const meanArr = [], upperArr = [], lowerArr = [];
      for (let j = 0; j < months.length; j++) {
        const vals = activeCities.map(name => {
          const arr = getVals(name);
          return arr[j];
        }).filter(v => v != null);
        if (!vals.length) { meanArr.push(null); upperArr.push(null); lowerArr.push(null); continue; }
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const std  = vals.length > 1
          ? Math.sqrt(vals.map(v => (v-mean)**2).reduce((s,v) => s+v, 0) / vals.length)
          : 0;
        meanArr.push(mean);
        upperArr.push(mean + std);
        lowerArr.push(mean - std);
      }

      datasets.push({ label: '_upper', data: upperArr, borderColor: 'transparent',
        backgroundColor: 'rgba(235,242,255,0.28)', fill: '+1',
        tension: 0, pointRadius: 0, order: 5, yAxisID: 'y' });
      datasets.push({ label: '_lower', data: lowerArr, borderColor: 'transparent',
        backgroundColor: 'transparent', fill: false,
        tension: 0, pointRadius: 0, order: 5, yAxisID: 'y' });
      datasets.push({
        label: `Group avg ${tsMode === 'co2' ? 'CO₂' : 'SIF'}`,
        data: meanArr, borderColor: 'rgba(255,255,255,0.85)', backgroundColor: 'transparent',
        borderWidth: 2.4, fill: false, tension: 0, pointRadius: 0, spanGaps: true,
        order: 1, yAxisID: 'y',
      });

      // ── per-city lines ────────────────────────────────────────
      activeCities.forEach((name, i) => {
        const color  = (S.colors && S.colors[name]) || TS_PALETTE[i % TS_PALETTE.length];
        const isHL   = highlighted.has(name);
        const alpha  = anyHL && !isHL ? '44' : '';
        const width  = isHL ? 3.5 : anyHL ? 1.0 : 2.2;
        datasets.push({
          label: name, yAxisID: 'y',
          data: getVals(name),
          borderColor: color + alpha, backgroundColor: 'transparent',
          borderWidth: width, fill: false, tension: 0,
          pointRadius: 0, pointHitRadius: 8,
          spanGaps: true, order: isHL ? 0 : 2,
        });
      });
    }

    if (!chart) {
      const el = document.getElementById('ts-chart');
      if (!el) return;
      chart = new Chart(el.getContext('2d'), { type: 'line', data: { labels, datasets }, options: chartOptions() });

      // Canvas-level click: find nearest line and toggle bold
      el.addEventListener('click', e => {
        if (!chart) return;
        // Use 'nearest' + intersect:true so only the actual line clicked registers
        const hits = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
        if (!hits.length) {
          // click on empty area — clear all highlights
          if (highlighted.size) { highlighted.clear(); if (lastS) updateChart(lastS); }
          return;
        }
        const ds = chart.data.datasets[hits[0].datasetIndex];
        if (!ds || ds.label.startsWith('_') || ds.label.startsWith('Group') || ds.label.includes(' avg')) return;
        const name = ds.label;
        if (highlighted.has(name)) highlighted.delete(name); else highlighted.add(name);
        if (lastS) updateChart(lastS);
      });
      // Pointer cursor on hover over a city line
      el.addEventListener('mousemove', e => {
        if (!chart) return;
        const hits = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
        const isCityLine = hits.length && !chart.data.datasets[hits[0].datasetIndex]?.label.startsWith('_')
          && !chart.data.datasets[hits[0].datasetIndex]?.label.includes(' avg')
          && !chart.data.datasets[hits[0].datasetIndex]?.label.startsWith('Group');
        el.style.cursor = isCityLine ? 'pointer' : 'default';
      });
    } else {
      chart.data.labels   = labels;
      chart.data.datasets = datasets;
      if (chart.options.scales?.y?.title) chart.options.scales.y.title.text = axisLabel();
      if (chart.options.scales?.y?.ticks) chart.options.scales.y.ticks.callback =
        v => tsMode === 'co2' ? v.toFixed(1) : v.toFixed(3);
      chart.update('active');
    }

    updateStatus();
  }

  // ── CO₂ CSV loader ─────────────────────────────────────────────
  function startLoadingCO2() {
    co2Loading = true;
    const prog = document.getElementById('ts-prog');
    let rows = 0;
    Papa.parse('../co2_sam.csv', {
      download: true, header: true, dynamicTyping: false, skipEmptyLines: true,
      step(r) {
        rows++;
        if (rows % 60000 === 0 && prog)
          prog.style.width = Math.min(rows / CO2_ROWS_EST * 50, 49) + '%'; // 0-50%
        const val = parseFloat(r.data.xco2);
        const lat = parseFloat(r.data.latitude);
        const dtStr = (r.data.datetime || '').trim();
        const city  = (r.data.city    || '').trim();
        const ctry  = (r.data.country || '').trim();
        if (!isFinite(val)) return;
        let t = Date.parse(dtStr);
        if (!isFinite(t) && dtStr.includes(' ')) t = Date.parse(dtStr.replace(' ','T')+'Z');
        if (!isFinite(t)) return;
        const d = new Date(t);
        const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
        if (isFinite(lat)) {
          for (const b of TS_BANDS) {
            if (lat >= b.latMin && lat < b.latMax) {
              const bm = bandRaw.get(b.key);
              if (!bm.has(ms)) bm.set(ms,[]);
              bm.get(ms).push(val); break;
            }
          }
        }
        if (!city || city === 'Unknown') return;
        const key = city + '|||' + ctry;
        if (!co2Raw.has(key))  { co2Raw.set(key, new Map()); cityMeta.set(key, {city, country:ctry}); }
        const mm = co2Raw.get(key);
        if (!mm.has(ms)) mm.set(ms,[]);
        mm.get(ms).push(val);
      },
      complete() {
        co2Loaded = true; co2Loading = false;
        if (prog) prog.style.width = sifLoaded ? '100%' : '50%';
        computeBandAvgs();
        rebuildAllMonths();
        updateStatus();
        // render if CO₂ mode was pending
        if (pendingS && tsMode === 'co2') { updateChart(pendingS); pendingS = null; }
        else if (lastS && tsMode === 'co2') updateChart(lastS);
      },
      error(err) { co2Loading = false; console.error('CO₂ CSV error:', err); },
    });
  }

  // ── SIF CSV loader ─────────────────────────────────────────────
  function startLoadingSIF() {
    sifLoading = true;
    const prog = document.getElementById('ts-prog');
    let rows = 0;
    Papa.parse('../sif_sam.csv', {
      download: true, header: true, dynamicTyping: false, skipEmptyLines: true,
      step(r) {
        rows++;
        if (rows % 100000 === 0 && prog)
          prog.style.width = Math.min(50 + rows / SIF_ROWS_EST * 50, 99) + '%'; // 50-99%
        const val  = parseFloat(r.data.Daily_SIF_757nm);
        if (!isFinite(val)) return;
        const dtStr = (r.data.datetime || '').trim();
        const city  = (r.data.city    || '').trim();
        if (!city || city === 'Unknown') return;
        let t = Date.parse(dtStr);
        if (!isFinite(t) && dtStr.includes(' ')) t = Date.parse(dtStr.replace(' ','T')+'Z');
        if (!isFinite(t)) return;
        const d  = new Date(t);
        const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
        if (!sifRaw.has(city)) sifRaw.set(city, new Map());
        const mm = sifRaw.get(city);
        if (!mm.has(ms)) mm.set(ms,[]);
        mm.get(ms).push(val);
      },
      complete() {
        // build averages
        for (const [name, monthMap] of sifRaw) {
          if (!sifAvgs.has(name)) sifAvgs.set(name, new Map());
          const out = sifAvgs.get(name);
          for (const [ms, vals] of monthMap)
            out.set(ms, vals.reduce((s,v) => s+v, 0) / vals.length);
        }
        sifLoaded = true; sifLoading = false;
        if (prog) prog.style.width = '100%';
        rebuildAllMonths();
        updateStatus();
        // render if SIF mode was pending or active
        if (tsMode === 'sif') {
          const target = pendingS || lastS;
          if (target) { updateChart(target); pendingS = null; }
        }
      },
      error(err) { sifLoading = false; console.error('SIF CSV error:', err); },
    });
  }

  // ── public API ─────────────────────────────────────────────────
  window.TimeseriesView = {
    init() {
      if (!co2Loaded && !co2Loading) startLoadingCO2();
      if (!sifLoaded && !sifLoading) startLoadingSIF();
    },
    update(S) {
      if (!co2Loaded && !co2Loading) startLoadingCO2();
      if (!sifLoaded && !sifLoading) startLoadingSIF();
      const ready = tsMode === 'co2' ? co2Loaded : sifLoaded;
      if (ready)  { updateChart(S); }
      else        { pendingS = S; updateStatus(); }
    },
    isLoaded: () => co2Loaded && sifLoaded,
  };

  // ── auto-start loading as soon as DOM is ready ─────────────────
  // Runs in the background while the user browses other tabs.
  document.addEventListener('DOMContentLoaded', () => {
    startLoadingCO2();
    startLoadingSIF();
  });
})();
