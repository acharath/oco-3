let globeRadius = 210;

let rotX = 0, rotY = 0;
let dragging = false;
let lastX = 0, lastY = 0;
let didDrag = false;

let timeSlider, playButton;
let playing = false;
let zoom = 1;

const MAX_DRAW_TOTAL = 12000;
const CLUSTER_DEG = 0.08;

let ptsCO2 = [];
let binsCO2 = new Map(); 
let cityHistory = new Map();  
let timestampBuckets = new Map(); 
let clusterGroups = new Map();   
let monthsAll = [];

let dataReady = false;
let loadingDone = false;
let loadingRows = 0;

let hud;
let selectedPoint = null;
let selectedGroup = null;
let currentVisibleCount = 0;

let globalCO2Min = 380;
let globalCO2Max = 450;

let currentDrawnPoints = [];

function setup() {
  createCanvas(1100, 850, WEBGL);
  angleMode(RADIANS);

  hud = createGraphics(width, height);
  hud.pixelDensity(1);
  hud.textFont("sans-serif");

  loadHugeCSV("co2_sam.csv");
}

function draw() {
  background(10);
  currentDrawnPoints = [];

  push();
  rotateX(rotX);
  rotateY(rotY);

  drawGraticule();
  drawGlobeBase();

  if (dataReady) {
    drawCO2Points();
  }

  pop();

  drawHUD();

  if (dataReady && playing && frameCount % 12 === 0) {
    advanceTime();
  }
}

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

    step: function(results) {
      const row = results.data;
      loadingRows++;

      const lat = parseFloat(row.latitude);
      const lon = parseFloat(row.longitude);
      const val = parseFloat(row.xco2);
      const t = parseTime(row.datetime);

      if (!isFinite(lat) || !isFinite(lon) || !isFinite(val) || !isFinite(t)) return;

      const city = cleanText(row.city, "Unknown");
      const country = cleanText(row.country, "");
      const population = parseFloat(row.population);
      const source_file = cleanText(row.source_file, "");
      const target_name = cleanText(row.target_name, "");
      const datetime = cleanText(row.datetime, "");
      const local_time = cleanText(row.local_time, "");
      const monthMs = toUTCMonth(t);

      const cityKey = makeCityKey(city, country);

      const idx = ptsCO2.length;
      ptsCO2.push({
        lat,
        lon,
        val,
        t,
        datetime,
        local_time,
        monthMs,
        city,
        country,
        cityKey,
        clusterKey: null,
        population: isFinite(population) ? population : null,
        target_name,
        source_file
      });

      allVals.push(val);

      if (!binsCO2.has(monthMs)) {
        binsCO2.set(monthMs, []);
      }
      binsCO2.get(monthMs).push(idx);

      if (city !== "Unknown") {
        if (!cityHistory.has(cityKey)) {
          cityHistory.set(cityKey, []);
        }
        cityHistory.get(cityKey).push({ monthMs, val });
      }

      if (!timestampBuckets.has(datetime)) {
        timestampBuckets.set(datetime, []);
      }
      timestampBuckets.get(datetime).push(idx);
    },

    complete: function() {
      buildSpatialClusters();
      buildSharedMonths();
      computeGlobalColorRange(allVals);
      initUI();
      loadingDone = true;
      dataReady = monthsAll.length > 0;

      console.log("Finished loading rows:", loadingRows);
      console.log("Total valid points:", ptsCO2.length);
      console.log("Months:", monthsAll.length);
      console.log("Clusters:", clusterGroups.size);
      console.log("Global color range:", globalCO2Min, globalCO2Max);
    },

    error: function(err) {
      console.error("CSV load error:", err);
    }
  });
}

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

      for (const idx of component) {
        ptsCO2[idx].clusterKey = clusterKey;
      }
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
  if (!vals || vals.length === 0) {
    globalCO2Min = 380;
    globalCO2Max = 450;
    return;
  }

  const sorted = [...vals].sort((a, b) => a - b);
  const q05 = percentileSorted(sorted, 0.05);
  const q95 = percentileSorted(sorted, 0.95);

  globalCO2Min = q05;
  globalCO2Max = q95;

  if (globalCO2Max <= globalCO2Min) {
    globalCO2Min = Math.min(...sorted);
    globalCO2Max = Math.max(...sorted);
  }

  if (globalCO2Max <= globalCO2Min) {
    globalCO2Min -= 1;
    globalCO2Max += 1;
  }
}

function percentileSorted(arr, p) {
  if (arr.length === 0) return NaN;
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  const t = idx - lo;
  return arr[lo] * (1 - t) + arr[hi] * t;
}

function initUI() {
  if (monthsAll.length === 0) return;

  if (timeSlider) timeSlider.remove();
  if (playButton) playButton.remove();

  timeSlider = createSlider(0, monthsAll.length - 1, 0, 1);
  timeSlider.position(20, height - 40);
  timeSlider.style("width", "680px");

  playButton = createButton("▶ Play");
  playButton.position(720, height - 44);
  playButton.mousePressed(() => {
    playing = !playing;
    playButton.html(playing ? "❚❚ Pause" : "▶ Play");
  });
}

function drawCO2Points() {
  if (!timeSlider || monthsAll.length === 0) return;

  const monthMs = monthsAll[timeSlider.value()];
  let indices = binsCO2.get(monthMs) || [];

  indices = sampleIndices(indices, MAX_DRAW_TOTAL);
  currentVisibleCount = indices.length;

  const r = (globeRadius + 2.0) * zoom;
  const ordered = [];

  for (const idx of indices) {
    const p = ptsCO2[idx];
    const pos = latLonToXYZ(radians(p.lat), radians(p.lon), r);
    const sp = getScreenPositionCurrentMatrix(pos.x, pos.y, pos.z);
    const front = pos.z > 0;

    ordered.push({
      p,
      pos,
      sx: sp.x,
      sy: sp.y,
      front
    });
  }

  ordered.sort((a, b) => a.pos.z - b.pos.z);
  currentDrawnPoints = ordered;

  for (const item of ordered) {
    const isSelected =
      selectedGroup &&
      item.p.clusterKey === selectedGroup.clusterKey;

    strokeWeight((isSelected ? 6.0 : 3.5) * zoom);
    stroke(globalCo2Color(item.p.val));
    point(item.pos.x, item.pos.y, item.pos.z);
  }
}

function drawHUD() {
  hud.clear();

  if (!loadingDone) {
    hud.fill(255);
    hud.textSize(18);
    hud.textAlign(LEFT, TOP);
    hud.text("Loading co2.csv...", 20, 20);

    hud.textSize(14);
    hud.text(`Rows parsed: ${loadingRows.toLocaleString()}`, 20, 50);
  } else if (!dataReady) {
    hud.fill(255);
    hud.textSize(18);
    hud.textAlign(LEFT, TOP);
    hud.text("No valid data loaded.", 20, 20);
  } else {
    drawCO2LegendHUD();
    drawTimeLabelHUD();

    hud.fill(180);
    hud.textSize(11);
    hud.textAlign(RIGHT);
    hud.text(`Visible points: ${currentVisibleCount}`, width - 30, 25);

    if (selectedPoint && selectedGroup) {
      drawSelectedCityInfo(selectedPoint);
      drawCityChart(selectedPoint.cityKey, selectedPoint.city, selectedPoint.country);
      drawClusterPopup(selectedGroup);
    }
  }

  push();
  resetMatrix();
  translate(-width / 2, -height / 2);
  image(hud, 0, 0);
  pop();
}

function drawSelectedCityInfo(p) {
  hud.textAlign(CENTER, TOP);
  hud.fill(255);
  hud.noStroke();
  hud.textSize(26);

  let loc = p.city || "Unknown City";
  if (p.country) {
    loc += ", " + p.country;
  }

  hud.text(loc, width / 2, 20);

  hud.textSize(13);
  hud.fill(210);
  hud.text(`Selected cluster mean XCO₂: ${nf(selectedGroup.meanVal, 1, 3)} ppm`, width / 2, 54);

  const dt = new Date(p.t);
  hud.text(dt.toUTCString(), width / 2, 72);
}

function drawCityChart(cityKey, cityName, countryName) {
  const history = cityHistory.get(cityKey);
  if (!history || !monthsAll.length) return;

  const panelW = 520;
  const panelH = 185;
  const px = width / 2 - panelW / 2;
  const py = height - panelH - 78;

  hud.fill(0, 190);
  hud.stroke(170, 210);
  hud.strokeWeight(1);
  hud.rect(px, py, panelW, panelH, 8);

  hud.noStroke();
  hud.fill(255);
  hud.textAlign(LEFT, TOP);
  hud.textSize(13);

  let title = `Monthly city average: ${cityName}`;
  if (countryName) title += `, ${countryName}`;
  hud.text(title, px + 15, py + 12);

  const grouped = new Map();
  for (const h of history) {
    if (!grouped.has(h.monthMs)) grouped.set(h.monthMs, []);
    grouped.get(h.monthMs).push(h.val);
  }

  const sortedMonths = Array.from(grouped.keys()).sort((a, b) => a - b);
  const chartData = sortedMonths.map(m => {
    const vals = grouped.get(m);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { x: m, y: avg };
  });

  if (!chartData.length) return;

  let minY = Math.min(...chartData.map(d => d.y));
  let maxY = Math.max(...chartData.map(d => d.y));
  if (maxY - minY < 0.4) {
    minY -= 0.2;
    maxY += 0.2;
  }

  const marginLeft = 55;
  const marginRight = 20;
  const marginTop = 32;
  const marginBottom = 35;

  const cx = px + marginLeft;
  const cy = py + marginTop;
  const cw = panelW - marginLeft - marginRight;
  const ch = panelH - marginTop - marginBottom;

  hud.stroke(90);
  hud.strokeWeight(1);
  hud.line(cx, cy + ch, cx + cw, cy + ch);
  hud.line(cx, cy, cx, cy + ch);

  hud.noStroke();
  hud.fill(180);
  hud.textSize(10);
  hud.textAlign(RIGHT, CENTER);
  hud.text(nf(minY, 1, 2), cx - 8, cy + ch);
  hud.text(nf(maxY, 1, 2), cx - 8, cy);

  hud.textAlign(CENTER, TOP);
  const firstD = new Date(chartData[0].x);
  const lastD = new Date(chartData[chartData.length - 1].x);
  hud.text(monthLabel(firstD), cx, cy + ch + 6);
  hud.text(monthLabel(lastD), cx + cw, cy + ch + 6);

  if (chartData.length > 1) {
    hud.noFill();
    hud.stroke(255, 200, 0);
    hud.strokeWeight(2);
    hud.beginShape();
    for (const d of chartData) {
      const vx = map(d.x, chartData[0].x, chartData[chartData.length - 1].x, cx, cx + cw);
      const vy = map(d.y, minY, maxY, cy + ch, cy);
      hud.vertex(vx, vy);
    }
    hud.endShape();

    hud.noStroke();
    hud.fill(255, 220, 100);
    for (const d of chartData) {
      const vx = map(d.x, chartData[0].x, chartData[chartData.length - 1].x, cx, cx + cw);
      const vy = map(d.y, minY, maxY, cy + ch, cy);
      hud.circle(vx, vy, 4);
    }
  } else {
    const vx = cx + cw / 2;
    const vy = map(chartData[0].y, minY, maxY, cy + ch, cy);
    hud.noStroke();
    hud.fill(255, 220, 100);
    hud.circle(vx, vy, 5);
  }
}

function drawClusterPopup(group) {
  const panelW = 350;
  const panelH = 310;
  const px = width - panelW - 22;
  const py = 55;

  hud.fill(0, 205);
  hud.stroke(180, 220);
  hud.strokeWeight(1);
  hud.rect(px, py, panelW, panelH, 10);

  hud.noStroke();
  hud.fill(255);
  hud.textAlign(LEFT, TOP);
  hud.textSize(14);
  hud.text("Selected timestamp cluster", px + 14, py + 12);

  hud.textSize(11);
  hud.fill(210);
  hud.text(`Points: ${group.points.length}`, px + 14, py + 34);
  hud.text(`Mean XCO₂: ${nf(group.meanVal, 1, 3)} ppm`, px + 14, py + 50);
  hud.text(`Min: ${nf(group.localMin, 1, 3)}   Max: ${nf(group.localMax, 1, 3)}`, px + 14, py + 66);

  const mapX = px + 14;
  const mapY = py + 92;
  const mapW = panelW - 28;
  const mapH = 155;

  hud.fill(18);
  hud.stroke(80);
  hud.rect(mapX, mapY, mapW, mapH, 6);

  const lats = group.points.map(p => p.lat);
  const lons = group.points.map(p => p.lon);

  let latMin = Math.min(...lats);
  let latMax = Math.max(...lats);
  let lonMin = Math.min(...lons);
  let lonMax = Math.max(...lons);

  const latPad = Math.max((latMax - latMin) * 0.15, 0.01);
  const lonPad = Math.max((lonMax - lonMin) * 0.15, 0.01);

  latMin -= latPad;
  latMax += latPad;
  lonMin -= lonPad;
  lonMax += lonPad;

  hud.noStroke();
  for (const p of group.points) {
    const x = map(p.lon, lonMin, lonMax, mapX + 12, mapX + mapW - 12);
    const y = map(p.lat, latMin, latMax, mapY + mapH - 12, mapY + 12);

    hud.fill(localCo2Color(p.val, group.localMin, group.localMax));
    hud.circle(x, y, 8);
  }

  if (selectedPoint) {
    const x = map(selectedPoint.lon, lonMin, lonMax, mapX + 12, mapX + mapW - 12);
    const y = map(selectedPoint.lat, latMin, latMax, mapY + mapH - 12, mapY + 12);
    hud.noFill();
    hud.stroke(255);
    hud.strokeWeight(2);
    hud.circle(x, y, 13);
  }

  hud.noStroke();
  hud.fill(200);
  hud.textSize(10);
  hud.text(`lat ${nf(latMin, 1, 3)} → ${nf(latMax, 1, 3)}`, mapX, mapY + mapH + 8);
  hud.text(`lon ${nf(lonMin, 1, 3)} → ${nf(lonMax, 1, 3)}`, mapX, mapY + mapH + 22);

  drawLocalLegend(px + 14, py + panelH - 28, panelW - 28, group.localMin, group.localMax);
}

function drawLocalLegend(x, y, w, localMin, localMax) {
  hud.fill(220);
  hud.noStroke();
  hud.textSize(10);
  hud.textAlign(LEFT, TOP);
  hud.text("Local cluster XCO₂ scale", x, y - 14);

  for (let i = 0; i <= w; i++) {
    const val = map(i, 0, w, localMin, localMax);
    hud.fill(localCo2Color(val, localMin, localMax));
    hud.rect(x + i, y, 1, 10);
  }

  hud.fill(220);
  hud.textAlign(LEFT, TOP);
  hud.text(nf(localMin, 1, 3), x, y + 12);

  hud.textAlign(RIGHT, TOP);
  hud.text(nf(localMax, 1, 3), x + w, y + 12);
}

function drawCO2LegendHUD() {
  hud.noStroke();
  hud.fill(220);
  hud.textSize(12);
  hud.textAlign(LEFT);
  hud.text("Global XCO₂ scale", 20, 18);

  for (let i = 0; i <= 200; i++) {
    const val = map(i, 0, 200, globalCO2Min, globalCO2Max);
    hud.fill(globalCo2Color(val));
    hud.rect(20 + i, 25, 1, 10);
  }

  hud.fill(220);
  hud.textSize(10);
  hud.textAlign(LEFT, TOP);
  hud.text(nf(globalCO2Min, 1, 2), 20, 38);
  hud.textAlign(RIGHT, TOP);
  hud.text(nf(globalCO2Max, 1, 2), 220, 38);
}

function drawTimeLabelHUD() {
  if (!timeSlider || monthsAll.length === 0) return;

  const d = new Date(monthsAll[timeSlider.value()]);
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  hud.fill(255);
  hud.textSize(16);
  hud.textAlign(LEFT);
  hud.text(`${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`, 20, height - 65);
}

function drawGlobeBase() {
  ambientLight(120);
  directionalLight(255, 255, 255, 1, 1, -1);
  noStroke();
  fill(30);
  sphere(globeRadius * zoom, 48, 48);
}

function drawGraticule() {
  stroke(120, 50);
  noFill();
  const r = (globeRadius + 1) * zoom;

  for (let lat = -75; lat <= 75; lat += 15) {
    beginShape();
    for (let lon = -180; lon <= 180; lon += 10) {
      const p = latLonToXYZ(radians(lat), radians(lon), r);
      vertex(p.x, p.y, p.z);
    }
    endShape();
  }
}

function globalCo2Color(v) {
  const t = constrain(map(v, globalCO2Min, globalCO2Max, 0, 1), 0, 1);
  return lerpColor(color(60, 120, 255), color(255, 60, 60), t);
}

function localCo2Color(v, vmin, vmax) {
  let lo = vmin;
  let hi = vmax;

  if (hi - lo < 0.02) {
    lo -= 0.01;
    hi += 0.01;
  }

  const t = constrain(map(v, lo, hi, 0, 1), 0, 1);
  return lerpColor(color(40, 160, 255), color(255, 80, 40), t);
}

function latLonToXYZ(lat, lon, r) {
  return {
    x: r * cos(lat) * sin(lon),
    y: -r * sin(lat),
    z: r * cos(lat) * cos(lon)
  };
}

function parseTime(s) {
  let t = Date.parse(s);
  if (!isFinite(t) && typeof s === "string" && s.includes(" ")) {
    t = Date.parse(s.replace(" ", "T") + "Z");
  }
  return t;
}

function toUTCMonth(tMs) {
  const d = new Date(tMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function cleanText(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === "" ? fallback : s;
}

function makeCityKey(city, country) {
  return `${city}|||${country}`;
}

function sampleIndices(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.floor(i * step)]);
  }
  return out;
}

function monthLabel(d) {
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function getScreenPositionCurrentMatrix(x, y, z) {
  const mv = _renderer.uMVMatrix.copy();
  const pr = _renderer.uPMatrix.copy();

  const eyeX = mv.mat4[0] * x + mv.mat4[4] * y + mv.mat4[8]  * z + mv.mat4[12];
  const eyeY = mv.mat4[1] * x + mv.mat4[5] * y + mv.mat4[9]  * z + mv.mat4[13];
  const eyeZ = mv.mat4[2] * x + mv.mat4[6] * y + mv.mat4[10] * z + mv.mat4[14];
  const eyeW = mv.mat4[3] * x + mv.mat4[7] * y + mv.mat4[11] * z + mv.mat4[15];

  const clipX = pr.mat4[0] * eyeX + pr.mat4[4] * eyeY + pr.mat4[8]  * eyeZ + pr.mat4[12] * eyeW;
  const clipY = pr.mat4[1] * eyeX + pr.mat4[5] * eyeY + pr.mat4[9]  * eyeZ + pr.mat4[13] * eyeW;
  const clipW = pr.mat4[3] * eyeX + pr.mat4[7] * eyeY + pr.mat4[11] * eyeZ + pr.mat4[15] * eyeW;

  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;

  return {
    x: (ndcX + 1) * width / 2,
    y: (1 - ndcY) * height / 2
  };
}

function mouseClicked() {
  if (!dataReady || !timeSlider) return;
  if (mouseY > height - 100) return;
  if (didDrag) {
    didDrag = false;
    return;
  }

  let bestDist = 11;
  let found = null;

  for (const item of currentDrawnPoints) {
    if (!item.front) continue;

    const d = dist(mouseX, mouseY, item.sx, item.sy);
    if (d < bestDist) {
      bestDist = d;
      found = item.p;
    }
  }

  if (!found) {
    selectedPoint = null;
    selectedGroup = null;
    return;
  }

  selectedPoint = found;
  selectedGroup = buildSelectedGroup(found);
}

function buildSelectedGroup(p) {
  if (!p.clusterKey) return null;

  const idxs = clusterGroups.get(p.clusterKey) || [];
  const points = idxs.map(i => ptsCO2[i]);

  if (points.length === 0) return null;

  const vals = points.map(q => q.val);
  const meanVal = vals.reduce((a, b) => a + b, 0) / vals.length;
  let localMin = Math.min(...vals);
  let localMax = Math.max(...vals);

  if (localMax - localMin < 0.02) {
    localMin -= 0.01;
    localMax += 0.01;
  }

  return {
    clusterKey: p.clusterKey,
    city: p.city,
    country: p.country,
    datetime: p.datetime,
    points,
    meanVal,
    localMin,
    localMax
  };
}

function mousePressed() {
  dragging = true;
  didDrag = false;
  lastX = mouseX;
  lastY = mouseY;
}

function mouseReleased() {
  dragging = false;
}

function mouseDragged() {
  if (mouseY > height - 100 || !dragging) return;

  const dx = mouseX - lastX;
  const dy = mouseY - lastY;

  if (abs(dx) > 1 || abs(dy) > 1) {
    didDrag = true;
  }

  rotY += dx * 0.005;
  rotX += dy * 0.005;
  rotX = constrain(rotX, -PI / 2, PI / 2);

  lastX = mouseX;
  lastY = mouseY;
}

function mouseWheel(e) {
  zoom = constrain(zoom - e.delta * 0.001, 0.5, 2);
}

function advanceTime() {
  let t = timeSlider.value() + 1;
  if (t >= monthsAll.length) t = 0;
  timeSlider.value(t);
}