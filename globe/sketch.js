let globeRadius = 210;

let rotX = 0.25, rotY = 0;
let dragging = false;
let lastX = 0, lastY = 0;
let didDrag = false;

let playing = false;
let zoom = 1;

const MAX_DRAW_TOTAL = 14000;
const CLUSTER_DEG = 0.08;
const TOTAL_ROWS_ESTIMATE = 6053903;
const HEADER_H = 44;

let ptsCO2 = [];
let binsCO2 = new Map();
let cityHistory = new Map();
let timestampBuckets = new Map();
let clusterGroups = new Map();
let monthsAll = [];

let dataReady = false;
let loadingDone = false;
let loadingRows = 0;

let selectedPoint = null;
let selectedGroup = null;
let currentVisibleCount = 0;
let currentDrawnPoints = [];

let globalCO2Min = 380;
let globalCO2Max = 450;

// ── Setup ─────────────────────────────────────────────────────────

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight - HEADER_H, WEBGL);
  cnv.parent('globe-wrap');
  angleMode(RADIANS);
  loadHugeCSV('../co2_sam.csv');
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight - HEADER_H);
}

// ── Draw loop ─────────────────────────────────────────────────────

function draw() {
  background(5);
  currentDrawnPoints = [];

  push();
  rotateX(rotX);
  rotateY(rotY);

  drawGraticule();
  drawGlobeBase();

  if (dataReady) drawCO2Points();

  pop();

  if (dataReady && playing && frameCount % 10 === 0) advanceTime();

  // Update header stat
  if (frameCount % 30 === 0) {
    const el = document.getElementById('stat-visible');
    if (el) el.textContent = currentVisibleCount.toLocaleString();
  }
}

// ── CSV Loading ────────────────────────────────────────────────────

function loadHugeCSV(filename) {
  ptsCO2 = [];
  binsCO2 = new Map();
  cityHistory = new Map();
  timestampBuckets = new Map();
  clusterGroups = new Map();
  monthsAll = [];
  dataReady = false;
  loadingDone = false;
  loadingRows = 0;
  selectedPoint = null;
  selectedGroup = null;

  const allVals = [];

  Papa.parse(filename, {
    download: true,
    header: true,
    dynamicTyping: false,
    skipEmptyLines: true,

    step(results) {
      const row = results.data;
      loadingRows++;

      if (loadingRows % 60000 === 0) {
        const pct = Math.min((loadingRows / TOTAL_ROWS_ESTIMATE) * 100, 99);
        const pb = document.getElementById('prog');
        if (pb) pb.style.width = pct + '%';
        const pt = document.getElementById('prog-text');
        if (pt) pt.textContent =
          `Loading… ${(loadingRows / 1e6).toFixed(1)}M / ${(TOTAL_ROWS_ESTIMATE / 1e6).toFixed(1)}M rows`;
      }

      const lat = parseFloat(row.latitude);
      const lon = parseFloat(row.longitude);
      const val = parseFloat(row.xco2);
      const t   = parseTime(row.datetime);

      if (!isFinite(lat) || !isFinite(lon) || !isFinite(val) || !isFinite(t)) return;

      const city       = cleanText(row.city,        'Unknown');
      const country    = cleanText(row.country,     '');
      const population = parseFloat(row.population);
      const source_file  = cleanText(row.source_file,  '');
      const target_name  = cleanText(row.target_name,  '');
      const datetime     = cleanText(row.datetime,     '');
      const local_time   = cleanText(row.local_time,   '');
      const monthMs      = toUTCMonth(t);
      const cityKey      = makeCityKey(city, country);

      const idx = ptsCO2.length;
      ptsCO2.push({
        lat, lon, val, t, datetime, local_time, monthMs,
        city, country, cityKey, clusterKey: null,
        population: isFinite(population) ? population : null,
        target_name, source_file,
      });

      allVals.push(val);

      if (!binsCO2.has(monthMs)) binsCO2.set(monthMs, []);
      binsCO2.get(monthMs).push(idx);

      if (city !== 'Unknown') {
        if (!cityHistory.has(cityKey)) cityHistory.set(cityKey, []);
        cityHistory.get(cityKey).push({ monthMs, val });
      }

      if (!timestampBuckets.has(datetime)) timestampBuckets.set(datetime, []);
      timestampBuckets.get(datetime).push(idx);
    },

    complete() {
      buildSpatialClusters();
      buildSharedMonths();
      computeGlobalColorRange(allVals);
      initUI();

      loadingDone = true;
      dataReady = monthsAll.length > 0;

      // Update header stats
      const pb = document.getElementById('prog');
      if (pb) pb.style.width = '100%';
      const pt = document.getElementById('prog-text');
      if (pt) pt.textContent = `${ptsCO2.length.toLocaleString()} points loaded`;
      const sp = document.getElementById('stat-points');
      if (sp) sp.textContent = ptsCO2.length.toLocaleString();
      const sc = document.getElementById('stat-cities');
      if (sc) sc.textContent = cityHistory.size.toLocaleString();

      drawLegendCanvas();

      console.log('Loaded rows:', loadingRows, '| Points:', ptsCO2.length,
                  '| Months:', monthsAll.length, '| Clusters:', clusterGroups.size);
    },

    error(err) {
      console.error('CSV load error:', err);
      const pt = document.getElementById('prog-text');
      if (pt) pt.textContent = 'Error loading data';
    },
  });
}

// ── Clustering ────────────────────────────────────────────────────

function buildSharedMonths() {
  monthsAll = Array.from(binsCO2.keys()).sort((a, b) => a - b);
}

function buildSpatialClusters() {
  clusterGroups = new Map();
  let clusterCounter = 0;

  for (const [datetime, idxs] of timestampBuckets.entries()) {
    const visited = new Set();

    for (const startIdx of idxs) {
      if (visited.has(startIdx)) continue;

      const component = [];
      const queue = [startIdx];
      visited.add(startIdx);

      while (queue.length > 0) {
        const cur = queue.pop();
        component.push(cur);
        const p = ptsCO2[cur];

        for (const nb of idxs) {
          if (visited.has(nb)) continue;
          const q = ptsCO2[nb];
          if (closeInLatLon(p, q, CLUSTER_DEG)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }

      const seed = ptsCO2[startIdx];
      const clusterKey =
        `${datetime}|||${seed.city}|||${seed.country}|||cluster${clusterCounter++}`;

      clusterGroups.set(clusterKey, component);
      for (const idx of component) ptsCO2[idx].clusterKey = clusterKey;
    }
  }
}

function closeInLatLon(a, b, threshDeg) {
  const meanLatRad = radians((a.lat + b.lat) / 2);
  const dLat = Math.abs(a.lat - b.lat);
  const dLon = Math.abs(a.lon - b.lon) * Math.cos(meanLatRad);
  return Math.sqrt(dLat * dLat + dLon * dLon) <= threshDeg;
}

function computeGlobalColorRange(vals) {
  if (!vals || vals.length === 0) { globalCO2Min = 380; globalCO2Max = 450; return; }
  const sorted = [...vals].sort((a, b) => a - b);
  const q05 = percentileSorted(sorted, 0.05);
  const q95 = percentileSorted(sorted, 0.95);
  globalCO2Min = q05;
  globalCO2Max = q95;
  if (globalCO2Max <= globalCO2Min) {
    globalCO2Min = sorted[0];
    globalCO2Max = sorted[sorted.length - 1];
  }
  if (globalCO2Max <= globalCO2Min) { globalCO2Min -= 1; globalCO2Max += 1; }
}

function percentileSorted(arr, p) {
  if (arr.length === 0) return NaN;
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] * (1 - (idx - lo)) + arr[hi] * (idx - lo);
}

// ── UI init ───────────────────────────────────────────────────────

function initUI() {
  if (monthsAll.length === 0) return;

  const slider = document.getElementById('time-slider');
  if (!slider) return;
  slider.max   = monthsAll.length - 1;
  slider.value = 0;
  slider.addEventListener('input', updateTimeLabel);

  const btn = document.getElementById('play-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      playing = !playing;
      this.textContent = playing ? '⏸ Pause' : '▶ Play';
      this.classList.toggle('playing', playing);
    });
  }

  updateTimeLabel();
}

function getTimeIndex() {
  const s = document.getElementById('time-slider');
  return s ? parseInt(s.value, 10) : 0;
}

function updateTimeLabel() {
  if (!monthsAll.length) return;
  const d = new Date(monthsAll[getTimeIndex()]);
  const el = document.getElementById('time-label');
  if (el) el.textContent = MONTH_NAMES[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

function advanceTime() {
  const s = document.getElementById('time-slider');
  if (!s) return;
  let t = parseInt(s.value, 10) + 1;
  if (t >= monthsAll.length) t = 0;
  s.value = t;
  updateTimeLabel();
}

// ── Drawing ───────────────────────────────────────────────────────

function drawGlobeBase() {
  ambientLight(80);
  directionalLight(200, 210, 230, 0.6, 0.8, -1);
  directionalLight(60, 80, 120, -1, -0.3, 0.5);
  noStroke();
  fill(18, 20, 28);
  sphere(globeRadius * zoom, 52, 52);
}

function drawGraticule() {
  stroke(70, 90, 130, 55);
  noFill();
  const r = (globeRadius + 1) * zoom;

  // Latitude lines
  for (let lat = -75; lat <= 75; lat += 15) {
    beginShape();
    for (let lon = -180; lon <= 180; lon += 6) {
      const p = latLonToXYZ(radians(lat), radians(lon), r);
      vertex(p.x, p.y, p.z);
    }
    endShape();
  }

  // Equator slightly brighter
  stroke(80, 110, 180, 80);
  beginShape();
  for (let lon = -180; lon <= 180; lon += 4) {
    const p = latLonToXYZ(0, radians(lon), r);
    vertex(p.x, p.y, p.z);
  }
  endShape();
}

function drawCO2Points() {
  const ti = getTimeIndex();
  if (!monthsAll.length || ti < 0 || ti >= monthsAll.length) return;

  const monthMs = monthsAll[ti];
  let indices = binsCO2.get(monthMs) || [];
  indices = sampleIndices(indices, MAX_DRAW_TOTAL);
  currentVisibleCount = indices.length;

  const r = (globeRadius + 2.2) * zoom;
  const ordered = [];

  for (const idx of indices) {
    const p   = ptsCO2[idx];
    const pos = latLonToXYZ(radians(p.lat), radians(p.lon), r);
    const sp  = getScreenPos(pos.x, pos.y, pos.z);
    ordered.push({ p, pos, sx: sp.x, sy: sp.y, front: pos.z > 0 });
  }

  ordered.sort((a, b) => a.pos.z - b.pos.z);
  currentDrawnPoints = ordered;

  for (const item of ordered) {
    const isSel = selectedGroup && item.p.clusterKey === selectedGroup.clusterKey;
    strokeWeight((isSel ? 6.5 : 3.8) * zoom);
    stroke(globalCo2Color(item.p.val));
    point(item.pos.x, item.pos.y, item.pos.z);
  }
}

// ── HTML side panel (city info) ───────────────────────────────────

function showCityPanel(p, group) {
  const panel = document.getElementById('city-panel');
  if (!panel) return;

  document.getElementById('panel-city-name').textContent = p.city || 'Unknown';
  document.getElementById('panel-country').textContent   = p.country || '';
  document.getElementById('panel-mean').textContent      = group.meanVal.toFixed(3) + ' ppm';
  document.getElementById('panel-range').textContent     =
    group.localMin.toFixed(2) + ' → ' + group.localMax.toFixed(2);
  document.getElementById('panel-pts').textContent       = group.points.length;

  const dt = new Date(p.t);
  document.getElementById('panel-time').textContent      =
    MONTH_NAMES[dt.getUTCMonth()].slice(0,3) + ' ' + dt.getUTCFullYear();

  drawMiniChart(p.cityKey);

  panel.classList.add('visible');
}

function hideCityPanel() {
  const panel = document.getElementById('city-panel');
  if (panel) panel.classList.remove('visible');
}

function drawMiniChart(cityKey) {
  const history = cityHistory.get(cityKey);
  const cnv     = document.getElementById('panel-mini-chart');
  if (!cnv || !history || !history.length) return;

  // Aggregate monthly averages
  const grouped = new Map();
  for (const h of history) {
    if (!grouped.has(h.monthMs)) grouped.set(h.monthMs, []);
    grouped.get(h.monthMs).push(h.val);
  }
  const sortedMonths = Array.from(grouped.keys()).sort((a, b) => a - b);
  const data = sortedMonths.map(m => {
    const vals = grouped.get(m);
    return { x: m, y: vals.reduce((s, v) => s + v, 0) / vals.length };
  });
  if (data.length < 1) return;

  const W = cnv.offsetWidth || 268;
  const H = 90;
  cnv.width  = W;
  cnv.height = H;

  const ctx = cnv.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  let minY = Math.min(...data.map(d => d.y));
  let maxY = Math.max(...data.map(d => d.y));
  if (maxY - minY < 0.3) { minY -= 0.15; maxY += 0.15; }

  const ml = 38, mr = 10, mt = 8, mb = 20;
  const cw = W - ml - mr;
  const ch = H - mt - mb;

  // Axes
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + ch);
  ctx.lineTo(ml + cw, mt + ch);
  ctx.stroke();

  // Y-axis labels
  ctx.fillStyle  = '#3a3a3a';
  ctx.font       = '9px Segoe UI, system-ui, sans-serif';
  ctx.textAlign  = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(minY.toFixed(1), ml - 4, mt + ch);
  ctx.fillText(maxY.toFixed(1), ml - 4, mt);

  // X-axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (data.length > 0) {
    const d0 = new Date(data[0].x), d1 = new Date(data[data.length - 1].x);
    ctx.fillText(MONTH_NAMES[d0.getUTCMonth()].slice(0,3) + ' ' + d0.getUTCFullYear(),
      ml, mt + ch + 5);
    if (data.length > 1)
      ctx.fillText(MONTH_NAMES[d1.getUTCMonth()].slice(0,3) + ' ' + d1.getUTCFullYear(),
        ml + cw, mt + ch + 5);
  }

  // Area fill
  const xOf = d => ml + ((d.x - data[0].x) / Math.max(1, data[data.length - 1].x - data[0].x)) * cw;
  const yOf = d => mt + ch - ((d.y - minY) / (maxY - minY)) * ch;

  ctx.beginPath();
  ctx.moveTo(xOf(data[0]), mt + ch);
  for (const d of data) ctx.lineTo(xOf(d), yOf(d));
  ctx.lineTo(xOf(data[data.length - 1]), mt + ch);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, mt, 0, mt + ch);
  grad.addColorStop(0, 'rgba(60,143,255,0.18)');
  grad.addColorStop(1, 'rgba(60,143,255,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xOf(data[0]), yOf(data[0]));
  for (const d of data) ctx.lineTo(xOf(d), yOf(d));
  ctx.strokeStyle = '#3c8fff';
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Current time marker
  const ti      = getTimeIndex();
  const curMs   = monthsAll[ti];
  const nearest = data.reduce((best, d) =>
    Math.abs(d.x - curMs) < Math.abs(best.x - curMs) ? d : best, data[0]);
  const mx = xOf(nearest);
  const my = yOf(nearest);

  ctx.beginPath();
  ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#3c8fff';
  ctx.fill();
  ctx.strokeStyle = '#050505';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Legend canvas (bottom-left) ───────────────────────────────────

function drawLegendCanvas() {
  const cnv = document.getElementById('legend-canvas');
  if (!cnv) return;
  const ctx = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height;
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0,    '#3c8fff');
  grad.addColorStop(0.5,  '#b060ff');
  grad.addColorStop(1.0,  '#ff4d4d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const mn = document.getElementById('legend-min');
  const mx = document.getElementById('legend-max');
  if (mn) mn.textContent = globalCO2Min.toFixed(1);
  if (mx) mx.textContent = globalCO2Max.toFixed(1);
}

// ── Color helpers ─────────────────────────────────────────────────

function globalCo2Color(v) {
  const t = constrain(map(v, globalCO2Min, globalCO2Max, 0, 1), 0, 1);
  if (t < 0.5) return lerpColor(color(60, 143, 255), color(176, 96, 255), t * 2);
  return lerpColor(color(176, 96, 255), color(255, 77, 77), (t - 0.5) * 2);
}

// ── Geo utils ─────────────────────────────────────────────────────

function latLonToXYZ(lat, lon, r) {
  return {
    x:  r * cos(lat) * sin(lon),
    y: -r * sin(lat),
    z:  r * cos(lat) * cos(lon),
  };
}

function getScreenPos(x, y, z) {
  const mv = _renderer.uMVMatrix.copy();
  const pr = _renderer.uPMatrix.copy();

  const ex = mv.mat4[0]*x + mv.mat4[4]*y + mv.mat4[8] *z + mv.mat4[12];
  const ey = mv.mat4[1]*x + mv.mat4[5]*y + mv.mat4[9] *z + mv.mat4[13];
  const ez = mv.mat4[2]*x + mv.mat4[6]*y + mv.mat4[10]*z + mv.mat4[14];
  const ew = mv.mat4[3]*x + mv.mat4[7]*y + mv.mat4[11]*z + mv.mat4[15];

  const cx = pr.mat4[0]*ex + pr.mat4[4]*ey + pr.mat4[8] *ez + pr.mat4[12]*ew;
  const cy = pr.mat4[1]*ex + pr.mat4[5]*ey + pr.mat4[9] *ez + pr.mat4[13]*ew;
  const cw = pr.mat4[3]*ex + pr.mat4[7]*ey + pr.mat4[11]*ez + pr.mat4[15]*ew;

  return {
    x: (cx / cw + 1) * width  / 2,
    y: (1 - cy / cw) * height / 2,
  };
}

// ── Input handlers ────────────────────────────────────────────────

function mouseClicked() {
  if (!dataReady) return;
  const sliderBottom = height - 50;
  if (mouseY > sliderBottom) return;
  if (didDrag) { didDrag = false; return; }

  let bestDist = 12;
  let found = null;

  for (const item of currentDrawnPoints) {
    if (!item.front) continue;
    const d = dist(mouseX, mouseY, item.sx, item.sy);
    if (d < bestDist) { bestDist = d; found = item.p; }
  }

  if (!found) {
    selectedPoint = null;
    selectedGroup = null;
    hideCityPanel();
    return;
  }

  selectedPoint = found;
  selectedGroup = buildSelectedGroup(found);
  if (selectedGroup) showCityPanel(found, selectedGroup);
}

function buildSelectedGroup(p) {
  if (!p.clusterKey) return null;
  const idxs   = clusterGroups.get(p.clusterKey) || [];
  const points = idxs.map(i => ptsCO2[i]);
  if (!points.length) return null;

  const vals   = points.map(q => q.val);
  const meanVal  = vals.reduce((a, b) => a + b, 0) / vals.length;
  let localMin = Math.min(...vals);
  let localMax = Math.max(...vals);
  if (localMax - localMin < 0.02) { localMin -= 0.01; localMax += 0.01; }

  return { clusterKey: p.clusterKey, city: p.city, country: p.country,
           datetime: p.datetime, points, meanVal, localMin, localMax };
}

function mousePressed() {
  dragging = true;
  didDrag  = false;
  lastX    = mouseX;
  lastY    = mouseY;
}

function mouseReleased() { dragging = false; }

function mouseDragged() {
  if (mouseY > height - 50 || !dragging) return;
  const dx = mouseX - lastX;
  const dy = mouseY - lastY;
  if (abs(dx) > 1 || abs(dy) > 1) didDrag = true;
  rotY += dx * 0.005;
  rotX += dy * 0.005;
  rotX  = constrain(rotX, -PI / 2, PI / 2);
  lastX = mouseX;
  lastY = mouseY;
}

function mouseWheel(e) {
  zoom = constrain(zoom - e.delta * 0.001, 0.4, 2.5);
}

// ── Misc helpers ──────────────────────────────────────────────────

function parseTime(s) {
  let t = Date.parse(s);
  if (!isFinite(t) && typeof s === 'string' && s.includes(' '))
    t = Date.parse(s.replace(' ', 'T') + 'Z');
  return t;
}

function toUTCMonth(tMs) {
  const d = new Date(tMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function cleanText(v, fallback = '') {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === '' ? fallback : s;
}

function makeCityKey(city, country) { return `${city}|||${country}`; }

function sampleIndices(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out  = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
