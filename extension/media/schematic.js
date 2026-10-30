// Webview script: draws LTspice schematic as SVG, highlights changes,
// renders interactive waveform panel with cursors, measurements, and faded overlay.
(function () {
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('canvas');
  const tbody = document.querySelector('#components tbody');
  const directives = document.getElementById('directives');
  const banner = document.getElementById('banner');
  const runBtn = document.getElementById('run-sim');
  const spinner = document.getElementById('sim-spinner');
  const plotTitle = document.getElementById('plot-title');
  const legendBox = document.getElementById('traces-legend');
  const measBox = document.getElementById('measurements-bar');
  const waveformCanvas = document.getElementById('waveform-canvas');
  const cursorTooltip = document.getElementById('cursor-tooltip');
  const emptyMsg = document.getElementById('waveform-empty-msg');

  let bannerTimer;
  let currentSchematic;
  let currentPlotData = null;
  let previousPlotData = null;
  let activeTraces = new Set();
  let primaryTrace = null;
  let cursorXRatio = null; // 0..1 across plot width

  // Get theme colors from computed styles
  function getThemeColor(varName, fallback) {
    const val = getComputedStyle(document.body).getPropertyValue(varName).trim();
    return val || fallback;
  }

  const PALETTE = [
    '--vscode-charts-blue',
    '--vscode-charts-orange',
    '--vscode-charts-green',
    '--vscode-charts-purple',
    '--vscode-charts-yellow',
    '--vscode-charts-red',
  ];

  function colorForIndex(i) {
    const varName = PALETTE[i % PALETTE.length];
    return getThemeColor(varName, ['#3794ff', '#d18616', '#388a34', '#b180d7', '#cca700', '#f14c4c'][i % 6]);
  }

  // Simplified symbol bodies in LTspice's local coordinates (R0)
  const SHAPES = {
    res: { label: [36, 56], parts: [['path', { d: 'M16 16 V32 M16 80 V96' }], ['rect', { x: 6, y: 32, width: 20, height: 48 }]] },
    cap: { label: [40, 32], parts: [['path', { d: 'M16 0 V28 M16 36 V64 M0 28 H32 M0 36 H32' }]] },
    ind: { label: [36, 56], parts: [['path', { d: 'M16 16 V32 M16 80 V96 M16 32 a8 6 0 0 1 0 12 a8 6 0 0 1 0 12 a8 6 0 0 1 0 12 a8 6 0 0 1 0 12' }]] },
    voltage: { label: [24, 56], parts: [['path', { d: 'M0 16 V40 M0 72 V96 M-4 50 H4 M0 46 V54 M-4 64 H4' }], ['circle', { cx: 0, cy: 56, r: 16 }]] },
    current: { label: [24, 56], parts: [['path', { d: 'M0 0 V24 M0 56 V80 M0 32 V48 M-5 42 L0 48 L5 42' }], ['circle', { cx: 0, cy: 40, r: 16 }]] },
    diode: { label: [36, 32], parts: [['path', { d: 'M16 0 V20 M16 44 V64 M0 20 H32 L16 44 Z M0 44 H32' }]] },
  };
  const FALLBACK = { label: [52, 16], parts: [['rect', { x: -16, y: -16, width: 64, height: 64 }]] };

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  function orient(rotation) {
    return { mirror: rotation.startsWith('M'), deg: parseInt(rotation.slice(1), 10) || 0 };
  }

  function place(sym, [px, py]) {
    const { mirror, deg } = orient(sym.rotation);
    const x = mirror ? -px : px;
    const r = (deg * Math.PI) / 180;
    return [sym.x + x * Math.cos(r) - py * Math.sin(r), sym.y + x * Math.sin(r) + py * Math.cos(r)];
  }

  function shapeFor(type) {
    const base = type.split(/[\\/]/).pop().toLowerCase();
    return { shape: SHAPES[base] || FALLBACK, known: Boolean(SHAPES[base]), base };
  }

  // Find net name for a given wire coordinate or flag
  function findNetNameAt(x, y) {
    if (!currentSchematic) return null;
    for (const f of currentSchematic.flags) {
      if (Math.hypot(f.x - x, f.y - y) < 8) return f.name;
    }
    return null;
  }

  function toggleTrace(traceName) {
    if (activeTraces.has(traceName)) {
      activeTraces.delete(traceName);
      if (primaryTrace === traceName) {
        primaryTrace = activeTraces.values().next().value || null;
      }
    } else {
      activeTraces.add(traceName);
      primaryTrace = traceName;
    }
    updateLegendAndMeasurements();
    drawWaveform();
  }

  function selectSymbol(id) {
    document.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
    document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.add('selected'));

    // Component current trace name
    const traceName = `I(${id})`;
    if (currentPlotData && currentPlotData.series && currentPlotData.series[traceName]) {
      toggleTrace(traceName);
    }
  }

  function renderSchematic({ schematic, changes, fileName }) {
    currentSchematic = schematic;
    document.getElementById('file-name').textContent = fileName;
    svg.replaceChildren();

    const changedSymbols = new Set(changes.symbols || []);
    const changedWires = new Set(changes.wires || []);
    const changedTexts = new Set(changes.texts || []);

    const xs = [];
    const ys = [];

    // Wires
    const wires = el('g', { class: 'wires' }, svg);
    schematic.wires.forEach((w, i) => {
      const line = el('line', {
        x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
        class: changedWires.has(i) ? 'changed' : '',
      }, wires);

      line.addEventListener('click', () => {
        // Find net connected to wire endpoints
        const net1 = findNetNameAt(w.x1, w.y1);
        const net2 = findNetNameAt(w.x2, w.y2);
        const netName = net1 || net2;
        if (netName && netName !== '0') {
          toggleTrace(`V(${netName})`);
        } else {
          // Check for node voltage like V(n001)
          const traceCandidate = Object.keys(currentPlotData?.series || {}).find(
            (k) => k.startsWith('V(') && k !== 'V(0)'
          );
          if (traceCandidate) toggleTrace(traceCandidate);
        }
      });

      xs.push(w.x1, w.x2);
      ys.push(w.y1, w.y2);
    });

    // Symbols
    const symbols = el('g', { class: 'symbols' }, svg);
    for (const sym of schematic.symbols) {
      const { shape, known, base } = shapeFor(sym.type);
      const { mirror, deg } = orient(sym.rotation);
      const changed = changedSymbols.has(sym.id);
      const g = el('g', {
        class: `symbol${changed ? ' changed' : ''}`,
        transform: `translate(${sym.x} ${sym.y}) rotate(${deg}) scale(${mirror ? -1 : 1} 1)`,
        'data-id': sym.id,
      }, symbols);

      for (const [tag, attrs] of shape.parts) el(tag, attrs, g);
      if (!known) el('text', { x: 16, y: 20, class: 'type' }, g).textContent = base;

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        selectSymbol(sym.id);
      });

      const [lx, ly] = place(sym, shape.label);
      const label = el('text', { x: lx, y: ly, class: `label${changed ? ' changed' : ''}` }, symbols);
      el('tspan', { x: lx, dy: 0 }, label).textContent = sym.id;
      el('tspan', { x: lx, dy: 16 }, label).textContent = sym.attrs.Value ? sym.attrs.Value.value : '';
      xs.push(sym.x - 32, sym.x + 112);
      ys.push(sym.y - 32, sym.y + 112);
    }

    // Flags (GND and net labels)
    const flags = el('g', { class: 'flags' }, svg);
    for (const f of schematic.flags) {
      const g = el('g', { class: 'flag' }, flags);
      if (f.name === '0') {
        el('path', { d: `M${f.x - 16} ${f.y} H${f.x + 16} L${f.x} ${f.y + 16} Z` }, g);
      } else {
        const txt = el('text', { x: f.x + 4, y: f.y - 6 }, g);
        txt.textContent = f.name;
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleTrace(`V(${f.name})`);
        });
      }
      el('circle', { cx: f.x, cy: f.y, r: 3, class: 'dot' }, g);
      xs.push(f.x);
      ys.push(f.y);
    }

    // Texts / Directives
    const texts = el('g', { class: 'texts' }, svg);
    schematic.texts.forEach((t, i) => {
      const cls = `${t.directive ? 'directive' : 'comment'}${changedTexts.has(i) ? ' changed' : ''}`;
      el('text', { x: t.x, y: t.y, class: cls }, texts).textContent = t.text;
      xs.push(t.x, t.x + 200);
      ys.push(t.y);
    });

    if (xs.length) {
      const pad = 40;
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      svg.setAttribute('viewBox', `${minX} ${minY} ${Math.max(...xs) - minX + pad} ${Math.max(...ys) - minY + pad}`);
    }

    renderTable(schematic, changedSymbols);
    renderDirectives(schematic, changedTexts);
    if (changes && (changes.symbols?.length || changes.wires?.length || changes.texts?.length)) {
      showBanner(changes);
    }
  }

  function renderTable(schematic, changedSymbols) {
    tbody.replaceChildren();
    for (const sym of schematic.symbols) {
      const row = document.createElement('tr');
      row.dataset.id = sym.id;
      if (changedSymbols.has(sym.id)) row.classList.add('changed');

      const name = document.createElement('td');
      name.textContent = sym.id;
      const type = document.createElement('td');
      type.textContent = sym.type;
      const valueCell = document.createElement('td');
      const input = document.createElement('input');
      const original = sym.attrs.Value ? sym.attrs.Value.value : '';
      input.value = original;
      input.setAttribute('aria-label', `Value of ${sym.id}`);
      input.addEventListener('change', () => {
        if (input.value.trim() && input.value !== original) {
          vscode.postMessage({ type: 'setAttr', id: sym.id, key: 'Value', value: input.value });
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
      valueCell.appendChild(input);
      row.append(name, type, valueCell);
      row.addEventListener('click', () => selectSymbol(sym.id));
      tbody.appendChild(row);
    }
  }

  function renderDirectives(schematic, changedTexts) {
    directives.replaceChildren();
    schematic.texts.forEach((t, i) => {
      if (!t.directive) return;
      const li = document.createElement('li');
      li.textContent = t.text;
      if (changedTexts.has(i)) li.classList.add('changed');
      directives.appendChild(li);
    });
  }

  function showBannerText(text) {
    banner.textContent = text;
    banner.classList.add('visible');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('visible'), 5000);
  }

  function showBanner(changes) {
    const parts = [];
    if (changes.symbols?.length) parts.push(`changed ${changes.symbols.join(', ')}`);
    if (changes.removedSymbols?.length) parts.push(`removed ${changes.removedSymbols.join(', ')}`);
    if (changes.wires?.length) parts.push(`${changes.wires.length} wire(s) added`);
    if (changes.texts?.length) parts.push(`${changes.texts.length} directive(s) changed`);
    if (!parts.length) return;
    showBannerText(`Update: ${parts.join(' · ')}`);
  }

  // --- Waveform Rendering Engine ---

  function formatSi(value, unit = '') {
    if (value === 0 || isNaN(value)) return `0.00 ${unit}`.trim();
    const abs = Math.abs(value);
    const prefixes = [
      { p: 'G', factor: 1e9 },
      { p: 'M', factor: 1e6 },
      { p: 'k', factor: 1e3 },
      { p: '', factor: 1 },
      { p: 'm', factor: 1e-3 },
      { p: 'µ', factor: 1e-6 },
      { p: 'n', factor: 1e-9 },
      { p: 'p', factor: 1e-12 },
    ];
    for (const { p, factor } of prefixes) {
      if (abs >= factor * 0.999) {
        return `${(value / factor).toFixed(2)} ${p}${unit}`.trim();
      }
    }
    return `${value.toExponential(2)} ${unit}`.trim();
  }

  function getSeriesData(plot, name) {
    if (!plot || !plot.series || !plot.series[name]) return null;
    const raw = plot.series[name];
    if (raw.re) {
      // For complex AC data, plot magnitude: sqrt(re^2 + im^2)
      const n = raw.re.length;
      const mag = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        mag[i] = Math.hypot(raw.re[i], raw.im[i]);
      }
      return mag;
    }
    return raw;
  }

  function calculateMeasurements(x, y) {
    if (!y || !y.length) return null;
    let min = Infinity;
    let max = -Infinity;
    let sumSq = 0;
    let sum = 0;
    const n = y.length;

    for (let i = 0; i < n; i++) {
      const v = y[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sumSq += v * v;
    }

    const p2p = max - min;
    const rms = Math.sqrt(sumSq / n);
    const mean = sum / n;

    // Estimate frequency via zero-crossings around mean
    let freq = null;
    const crossings = [];
    for (let i = 1; i < n; i++) {
      if (y[i - 1] < mean && y[i] >= mean) {
        // Linear interpolation of crossing point
        const t = x[i - 1] + (x[i] - x[i - 1]) * ((mean - y[i - 1]) / (y[i] - y[i - 1] || 1e-12));
        crossings.push(t);
      }
    }
    if (crossings.length >= 2) {
      const totalPeriod = crossings[crossings.length - 1] - crossings[0];
      const avgPeriod = totalPeriod / (crossings.length - 1);
      if (avgPeriod > 0) freq = 1 / avgPeriod;
    }

    return { min, max, p2p, rms, freq };
  }

  function updateLegendAndMeasurements() {
    legendBox.replaceChildren();
    measBox.replaceChildren();

    if (!currentPlotData || !currentPlotData.variables) return;

    const availableTraces = Object.keys(currentPlotData.series || {});
    availableTraces.forEach((name, idx) => {
      const pill = document.createElement('span');
      pill.className = `trace-pill ${activeTraces.has(name) ? 'active' : 'faded'}`;
      if (primaryTrace === name) pill.style.fontWeight = 'bold';

      const dot = document.createElement('span');
      dot.className = 'trace-color-dot';
      dot.style.background = colorForIndex(idx);

      pill.append(dot, document.createTextNode(name));
      pill.addEventListener('click', () => toggleTrace(name));
      legendBox.appendChild(pill);
    });

    if (primaryTrace && activeTraces.has(primaryTrace)) {
      const yData = getSeriesData(currentPlotData, primaryTrace);
      const meas = calculateMeasurements(currentPlotData.x, yData);
      if (meas) {
        const unit = primaryTrace.startsWith('I(') ? 'A' : 'V';
        const addMeas = (label, valStr) => {
          const item = document.createElement('span');
          item.className = 'meas-item';
          item.innerHTML = `${label}: <strong>${valStr}</strong>`;
          measBox.appendChild(item);
        };
        addMeas('Trace', primaryTrace);
        addMeas('Min', formatSi(meas.min, unit));
        addMeas('Max', formatSi(meas.max, unit));
        addMeas('P-P', formatSi(meas.p2p, unit));
        addMeas('RMS', formatSi(meas.rms, unit));
        if (meas.freq) addMeas('Freq', formatSi(meas.freq, 'Hz'));
      }
    }
  }

  function drawWaveform() {
    const rect = waveformCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    waveformCanvas.width = rect.width * dpr;
    waveformCanvas.height = rect.height * dpr;

    const ctx = waveformCanvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (!currentPlotData || !currentPlotData.x || currentPlotData.x.length === 0 || activeTraces.size === 0) {
      emptyMsg.style.display = 'block';
      return;
    }
    emptyMsg.style.display = 'none';

    const w = rect.width;
    const h = rect.height;
    const padL = 55;
    const padR = 20;
    const padT = 15;
    const padB = 25;
    const plotW = Math.max(10, w - padL - padR);
    const plotH = Math.max(10, h - padT - padB);

    // Compute bounding ranges across active traces (both current and previous)
    let minX = currentPlotData.x[0];
    let maxX = currentPlotData.x[currentPlotData.x.length - 1];
    let minY = Infinity;
    let maxY = -Infinity;

    const activeList = Array.from(activeTraces);
    activeList.forEach((name) => {
      const yCur = getSeriesData(currentPlotData, name);
      if (yCur) {
        for (let i = 0; i < yCur.length; i++) {
          if (yCur[i] < minY) minY = yCur[i];
          if (yCur[i] > maxY) maxY = yCur[i];
        }
      }
      if (previousPlotData) {
        const yPrev = getSeriesData(previousPlotData, name);
        if (yPrev) {
          for (let i = 0; i < yPrev.length; i++) {
            if (yPrev[i] < minY) minY = yPrev[i];
            if (yPrev[i] > maxY) maxY = yPrev[i];
          }
        }
      }
    });

    if (minY === Infinity || maxY === -Infinity) {
      minY = -1;
      maxY = 1;
    } else if (maxY === minY) {
      maxY += 1;
      minY -= 1;
    } else {
      const margin = (maxY - minY) * 0.08;
      minY -= margin;
      maxY += margin;
    }

    const scaleX = (x) => padL + ((x - minX) / (maxX - minX || 1)) * plotW;
    const scaleY = (y) => padT + plotH - ((y - minY) / (maxY - minY || 1)) * plotH;
    const invScaleX = (px) => minX + ((px - padL) / plotW) * (maxX - minX);

    // 1. Draw Grid Lines
    const gridColor = getThemeColor('--vscode-panel-border', '#333333');
    const fgColor = getThemeColor('--vscode-descriptionForeground', '#888888');

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();

    // 5 vertical grid lines
    const numXDivs = 5;
    ctx.fillStyle = fgColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const isAc = currentPlotData.plotName?.toLowerCase().includes('ac');
    const xUnit = isAc ? 'Hz' : 's';

    for (let i = 0; i <= numXDivs; i++) {
      const gx = padL + (i / numXDivs) * plotW;
      ctx.moveTo(gx, padT);
      ctx.lineTo(gx, padT + plotH);
      const valX = minX + (i / numXDivs) * (maxX - minX);
      ctx.fillText(formatSi(valX, xUnit), gx, padT + plotH + 4);
    }

    // 4 horizontal grid lines
    const numYDivs = 4;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= numYDivs; i++) {
      const gy = padT + (i / numYDivs) * plotH;
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + plotW, gy);
      const valY = maxY - (i / numYDivs) * (maxY - minY);
      ctx.fillText(formatSi(valY), padL - 6, gy);
    }
    ctx.stroke();

    // 2. Draw Previous Trace Overlay (Faded / Dashed)
    if (previousPlotData && previousPlotData.x) {
      activeList.forEach((name) => {
        const yData = getSeriesData(previousPlotData, name);
        if (!yData || !yData.length) return;
        const colorIdx = Object.keys(currentPlotData.series || {}).indexOf(name);
        const strokeColor = colorForIndex(colorIdx >= 0 ? colorIdx : 0);

        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();

        const xData = previousPlotData.x;
        const pts = Math.min(xData.length, yData.length);
        for (let i = 0; i < pts; i++) {
          const px = scaleX(xData[i]);
          const py = scaleY(yData[i]);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      });
    }

    // 3. Draw Current Traces (Solid, bright)
    activeList.forEach((name) => {
      const yData = getSeriesData(currentPlotData, name);
      if (!yData || !yData.length) return;
      const colorIdx = Object.keys(currentPlotData.series || {}).indexOf(name);
      const strokeColor = colorForIndex(colorIdx >= 0 ? colorIdx : 0);

      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = primaryTrace === name ? 2.5 : 1.8;
      ctx.setLineDash([]);
      ctx.beginPath();

      const xData = currentPlotData.x;
      const pts = Math.min(xData.length, yData.length);
      for (let i = 0; i < pts; i++) {
        const px = scaleX(xData[i]);
        const py = scaleY(yData[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    });

    // 4. Draw Interactive Cursor Crosshair & Tooltip
    if (cursorXRatio !== null && cursorXRatio >= 0 && cursorXRatio <= 1) {
      const curX = padL + cursorXRatio * plotW;
      const curValX = minX + cursorXRatio * (maxX - minX);

      ctx.save();
      ctx.strokeStyle = getThemeColor('--vscode-focusBorder', '#007fd4');
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(curX, padT);
      ctx.lineTo(curX, padT + plotH);
      ctx.stroke();
      ctx.restore();

      // Find nearest interpolated point for each active trace
      const tooltips = [`X: ${formatSi(curValX, xUnit)}`];
      activeList.forEach((name) => {
        const yData = getSeriesData(currentPlotData, name);
        if (!yData) return;
        const xData = currentPlotData.x;
        // Binary search nearest index
        let low = 0;
        let high = xData.length - 1;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (xData[mid] < curValX) low = mid + 1;
          else high = mid;
        }
        const valY = yData[low];
        const py = scaleY(valY);
        const colorIdx = Object.keys(currentPlotData.series || {}).indexOf(name);
        const strokeColor = colorForIndex(colorIdx >= 0 ? colorIdx : 0);

        // Draw small dot on curve
        ctx.fillStyle = strokeColor;
        ctx.beginPath();
        ctx.arc(curX, py, 3.5, 0, Math.PI * 2);
        ctx.fill();

        const unit = name.startsWith('I(') ? 'A' : 'V';
        tooltips.push(`${name}: ${formatSi(valY, unit)}`);
      });

      // Position tooltip
      cursorTooltip.textContent = tooltips.join('\n');
      cursorTooltip.style.display = 'block';
      const tipL = Math.min(rect.width - 150, Math.max(10, curX + 12));
      const tipT = Math.max(10, padT + 5);
      cursorTooltip.style.left = `${tipL}px`;
      cursorTooltip.style.top = `${tipT}px`;
    } else {
      cursorTooltip.style.display = 'none';
    }
  }

  // Mouse cursor tracking on canvas
  waveformCanvas.addEventListener('mousemove', (e) => {
    const rect = waveformCanvas.getBoundingClientRect();
    const padL = 55;
    const padR = 20;
    const plotW = Math.max(10, rect.width - padL - padR);
    const mx = e.clientX - rect.left - padL;

    if (mx >= 0 && mx <= plotW) {
      cursorXRatio = mx / plotW;
      drawWaveform();
    } else {
      cursorXRatio = null;
      drawWaveform();
    }
  });

  waveformCanvas.addEventListener('mouseleave', () => {
    cursorXRatio = null;
    cursorTooltip.style.display = 'none';
    drawWaveform();
  });

  window.addEventListener('resize', () => {
    drawWaveform();
  });

  // Handle incoming messages from extension host
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;

    switch (msg.type) {
      case 'update':
        renderSchematic(msg);
        break;

      case 'simStart':
        spinner.classList.remove('hidden');
        runBtn.textContent = 'Cancel';
        runBtn.dataset.running = 'true';
        break;

      case 'simulationResult':
        spinner.classList.add('hidden');
        runBtn.textContent = 'Run Simulation';
        delete runBtn.dataset.running;

        if (msg.success && msg.current) {
          previousPlotData = currentPlotData;
          currentPlotData = msg.current;
          plotTitle.textContent = currentPlotData.plotName || 'Simulation';

          // If no active traces yet, select default output traces (V(out) or first voltages)
          if (activeTraces.size === 0) {
            const seriesKeys = Object.keys(currentPlotData.series || {});
            const preferred = seriesKeys.find((k) => k.toLowerCase() === 'v(out)') || seriesKeys.find((k) => k.startsWith('V('));
            if (preferred) {
              activeTraces.add(preferred);
              primaryTrace = preferred;
            } else if (seriesKeys.length > 0) {
              activeTraces.add(seriesKeys[0]);
              primaryTrace = seriesKeys[0];
            }
          }

          updateLegendAndMeasurements();
          drawWaveform();

          if (msg.bannerText) {
            showBannerText(msg.bannerText);
          }
        } else if (msg.error) {
          showBannerText(`Simulation error: ${msg.error}`);
        }
        break;

      case 'simError':
        spinner.classList.add('hidden');
        runBtn.textContent = 'Run Simulation';
        delete runBtn.dataset.running;
        showBannerText(msg.error || 'Simulation failed');
        break;
    }
  });

  // Actions
  runBtn.addEventListener('click', () => {
    if (runBtn.dataset.running === 'true') {
      vscode.postMessage({ type: 'cancelSimulation' });
    } else {
      vscode.postMessage({ type: 'runSimulation' });
    }
  });

  document.getElementById('as-text').addEventListener('click', () => vscode.postMessage({ type: 'openAsText' }));
  vscode.postMessage({ type: 'ready' });
})();
