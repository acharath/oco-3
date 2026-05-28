"use strict";

/* Timeseries view (Chart.js) — uses compare app sidebar state (S.sel, S.activeBands) */
(function () {
  const TS_BANDS = [
    { key: 'arctic', label: 'Arctic', range: '60°N – 90°N', latMin: 60, latMax: 90, color: '#93d5f7' },
    { key: 'mid_north', label: 'N. Mid-latitudes', range: '30°N – 60°N', latMin: 30, latMax: 60, color: '#5b8ff9' },
    { key: 'tropics', label: 'Tropics', range: '30°S – 30°N', latMin: -30, latMax: 30, color: '#ffc444' },
    { key: 'mid_south', label: 'S. Mid-latitudes', range: '30°S – 60°S', latMin: -60, latMax: -30, color: '#29d8a8' },
    { key: 'antarctic', label: 'Antarctic', range: '60°S – 90°S', latMin: -90, latMax: -60, color: '#be8fff' },
  ];

  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TOTAL_ROWS_ESTIMATE = 6053903;
  const TS_PALETTE = [
    '#00f5ff', '#ff1493', '#39ff14', '#ff6b35', '#bf00ff', '#ffd700',
    '#ff4466', '#00ffaa', '#ff69b4', '#4dbbff', '#ff8c00', '#7fff00',
  ];

  const bandRaw = new Map(TS_BANDS.map(b => [b.key, new Map()]));
  let bandAvgs = new Map();
  const cityData = new Map();
  const cityMeta = new Map();
  let allMonths = [];
  let chart = null;
  let loaded = false;
  let loading = false;

  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }
  }

  function computeBandAvgs() {
    bandAvgs = new Map();
    for (const band of TS_BANDS) {
      const avgs = new Map();
      for (const [m, vals] of bandRaw.get(band.key)) {
        avgs.set(m, vals.reduce((s, v) => s + v, 0) / vals.length);
      }
      bandAvgs.set(band.key, avgs);
    }
  }

  function cityKeysForSelection(selNames) {
    const keys = [];
    for (const key of cityMeta.keys()) {
      const meta = cityMeta.get(key);
      if (selNames.includes(meta.city)) keys.push(key);
    }
    return keys;
  }

  function buildMonthlyAvgs(key) {
    const avgs = {};
    for (const [m, vals] of cityData.get(key))
      avgs[m] = vals.reduce((s, v) => s + v, 0) / vals.length;
    return avgs;
  }

  function chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#666',
            font: { size: 10.5, family: "'Segoe UI', system-ui, sans-serif" },
            boxWidth: 20,
            boxHeight: 2,
            padding: 14,
            filter: item => !item.text.startsWith('_') && (item.text.includes('avg') || item.text === 'City selection avg'),
          },
        },
        tooltip: {
          backgroundColor: 'rgba(8,8,8,0.94)',
          borderColor: '#222',
          borderWidth: 1,
          titleColor: '#999',
          bodyColor: '#ccc',
          padding: 10,
          callbacks: {
            title: items => items[0].label,
            label(ctx) {
              if (ctx.dataset.label.startsWith('_')) return null;
              const v = ctx.parsed.y;
              if (v === null || v === undefined) return null;
              return ` ${ctx.dataset.label}: ${v.toFixed(3)} ppm`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          ticks: { color: '#3a3a3a', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 14 },
          grid: { color: '#0f0f0f', drawTicks: false },
          border: { color: '#1a1a1a' },
        },
        y: {
          ticks: {
            color: '#3a3a3a',
            font: { size: 10 },
            callback: v => v.toFixed(1) + ' ppm',
            maxTicksLimit: 8,
          },
          grid: { color: '#0f0f0f', drawTicks: false },
          border: { color: '#1a1a1a' },
          title: { display: true, text: 'XCO₂ (ppm)', color: '#2e2e2e', font: { size: 10 } },
        },
      },
    };
  }

  function monthInRange(ms, S) {
    if (!S || !S.mfrom || !S.mto) return true;
    const d = new Date(ms);
    const tag = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    return tag >= S.mfrom && tag <= S.mto;
  }

  function filteredMonths(S) {
    return allMonths.filter(m => monthInRange(m, S));
  }

  function updateChart(S) {
    const hint = document.getElementById('ts-hint');
    const status = document.getElementById('ts-status');
    if (!loaded) {
      if (hint) hint.textContent = loading ? 'Loading CO₂ data…' : 'Preparing chart…';
      if (hint) hint.style.display = 'block';
      return;
    }

    const selNames = S.sel || [];
    const activeBands = S.activeBands || new Set();
    const hasCity = selNames.length > 0;
    const hasBand = activeBands.size > 0;

    if (!hasCity && !hasBand) {
      if (hint) {
        hint.innerHTML = 'Select cities in the sidebar<br>or toggle latitude bands';
        hint.style.display = 'block';
      }
      if (chart) { chart.data.labels = []; chart.data.datasets = []; chart.update('none'); }
      return;
    }
    if (hint) hint.style.display = 'none';

    const months = filteredMonths(S);
    const labels = months.map(m => {
      const d = new Date(m);
      return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    });

    const datasets = [];

    for (const band of TS_BANDS) {
      if (!activeBands.has(band.key)) continue;
      const avgs = bandAvgs.get(band.key);
      datasets.push({
        label: band.label + ' avg',
        data: months.map(m => avgs.has(m) ? avgs.get(m) : null),
        borderColor: band.color + '40',
        backgroundColor: 'transparent',
        borderWidth: 1.2,
        borderDash: [],
        fill: false,
        tension: 0.4,
        pointRadius: 0,
        spanGaps: true,
        order: 10,
      });
    }

    if (hasCity) {
      const cityKeys = cityKeysForSelection(selNames);
      const cityAvgList = cityKeys.map(key => ({ key, avgs: buildMonthlyAvgs(key) }));
      const meanArr = [], upperArr = [], lowerArr = [];

      for (const m of months) {
        const vals = cityAvgList.map(c => c.avgs[m]).filter(v => v !== undefined);
        if (!vals.length) {
          meanArr.push(null); upperArr.push(null); lowerArr.push(null);
          continue;
        }
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const std = vals.length > 1
          ? Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((s, v) => s + v, 0) / vals.length)
          : 0;
        meanArr.push(mean);
        upperArr.push(mean + std);
        lowerArr.push(mean - std);
      }

      datasets.push({
        label: '_upper',
        data: upperArr,
        borderColor: 'transparent',
        backgroundColor: 'rgba(255,255,255,0.2)',
        fill: '+1',
        tension: 0.35,
        pointRadius: 0,
        order: 4,
      });
      datasets.push({
        label: '_lower',
        data: lowerArr,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.4,
        pointRadius: 0,
        order: 4,
      });
      datasets.push({
        label: 'City selection avg',
        data: meanArr,
        borderColor: 'rgba(255,255,255,0.82)',
        backgroundColor: 'transparent',
        borderWidth: 2.2,
        borderDash: [],
        fill: false,
        tension: 0.4,
        pointRadius: 0,
        spanGaps: true,
        order: 1,
      });

      cityAvgList.forEach(({ key, avgs }, i) => {
        const meta = cityMeta.get(key);
        const color = (S.colors && S.colors[meta.city]) || TS_PALETTE[i % TS_PALETTE.length];
        datasets.push({
          label: meta.country ? `${meta.city}, ${meta.country}` : meta.city,
          data: months.map(m => avgs[m] !== undefined ? avgs[m] : null),
          borderColor: color,
          backgroundColor: color + '22',
          borderWidth: 2,
          fill: false,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 0,
          spanGaps: true,
          order: 2,
        });
      });
    }

    if (!chart) {
      const el = document.getElementById('ts-chart');
      if (!el) return;
      chart = new Chart(el.getContext('2d'), {
        type: 'line',
        data: { labels, datasets },
        options: chartOptions(),
      });
    } else {
      chart.data.labels = labels;
      chart.data.datasets = datasets;
      chart.update('active');
    }

    if (status) status.textContent = `${cityMeta.size} cities · ${months.length} months in range`;
  }

  function ensureLoaded(onReady) {
    if (loaded) { onReady(); return; }
    if (loading) return;
    loading = true;

    const prog = document.getElementById('ts-prog');
    const progText = document.getElementById('ts-prog-text');
    let rowsLoaded = 0;

    Papa.parse('../co2_sam.csv', {
      download: true,
      header: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      step(results) {
        const row = results.data;
        rowsLoaded++;
        if (rowsLoaded % 60000 === 0 && prog) {
          const pct = Math.min((rowsLoaded / TOTAL_ROWS_ESTIMATE) * 100, 99);
          prog.style.width = pct + '%';
          if (progText) progText.textContent = `Loading… ${(rowsLoaded / 1e6).toFixed(1)}M rows`;
        }

        const val = parseFloat(row.xco2);
        const lat = parseFloat(row.latitude);
        const dtStr = (row.datetime || '').trim();
        const city = (row.city || '').trim();
        const country = (row.country || '').trim();
        if (!isFinite(val)) return;

        let t = Date.parse(dtStr);
        if (!isFinite(t) && dtStr.includes(' ')) t = Date.parse(dtStr.replace(' ', 'T') + 'Z');
        if (!isFinite(t)) return;

        const d = new Date(t);
        const monthMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

        if (isFinite(lat)) {
          for (const band of TS_BANDS) {
            if (lat >= band.latMin && lat < band.latMax) {
              const bm = bandRaw.get(band.key);
              if (!bm.has(monthMs)) bm.set(monthMs, []);
              bm.get(monthMs).push(val);
              break;
            }
          }
        }

        if (!city || city === 'Unknown') return;
        const cityKey = city + '|||' + country;
        if (!cityData.has(cityKey)) {
          cityData.set(cityKey, new Map());
          cityMeta.set(cityKey, { city, country });
        }
        const monthMap = cityData.get(cityKey);
        if (!monthMap.has(monthMs)) monthMap.set(monthMs, []);
        monthMap.get(monthMs).push(val);
      },
      complete() {
        loaded = true;
        loading = false;
        if (prog) prog.style.width = '100%';
        if (progText) progText.textContent = `${cityMeta.size} cities loaded`;
        const monthSet = new Set();
        for (const monthMap of cityData.values())
          for (const m of monthMap.keys()) monthSet.add(m);
        allMonths = Array.from(monthSet).sort((a, b) => a - b);
        computeBandAvgs();
        onReady();
      },
      error(err) {
        loading = false;
        console.error('Timeseries CSV error:', err);
        if (progText) progText.textContent = 'Error loading data';
      },
    });
  }

  window.TimeseriesView = {
    update(S) {
      ensureLoaded(() => updateChart(S));
    },
    isLoaded: () => loaded,
  };
})();
