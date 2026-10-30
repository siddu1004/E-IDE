// Shared waveform viewer module for E-IDE (LTspice and KiCad editors).
// Handles High-DPI canvas rendering, cursors, measurements, and faded overlay.
(function () {
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
    if (raw && raw.re) {
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

    let freq = null;
    const crossings = [];
    for (let i = 1; i < n; i++) {
      if (y[i - 1] < mean && y[i] >= mean) {
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

  window.createWaveformViewer = function (elements) {
    const { canvas, legendBox, measBox, tooltip, emptyMsg, plotTitle } = elements;

    let currentPlotData = null;
    let previousPlotData = null;
    let activeTraces = new Set();
    let primaryTrace = null;
    let cursorXRatio = null;

    function toggleTrace(name) {
      if (activeTraces.has(name)) {
        activeTraces.delete(name);
        if (primaryTrace === name) {
          primaryTrace = activeTraces.values().next().value || null;
        }
      } else {
        activeTraces.add(name);
        primaryTrace = name;
      }
      updateLegendAndMeasurements();
      draw();
    }

    function addTrace(name) {
      activeTraces.add(name);
      primaryTrace = name;
      updateLegendAndMeasurements();
      draw();
    }

    function updateLegendAndMeasurements() {
      if (!legendBox || !measBox) return;
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

    function draw() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      if (!currentPlotData || !currentPlotData.x || currentPlotData.x.length === 0 || activeTraces.size === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
      }
      if (emptyMsg) emptyMsg.style.display = 'none';

      const w = rect.width;
      const h = rect.height;
      const padL = 55;
      const padR = 20;
      const padT = 15;
      const padB = 25;
      const plotW = Math.max(10, w - padL - padR);
      const plotH = Math.max(10, h - padT - padB);

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

      // Grid
      const gridColor = getThemeColor('--vscode-panel-border', '#333333');
      const fgColor = getThemeColor('--vscode-descriptionForeground', '#888888');

      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();

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

      // Faded previous run overlay
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

      // Current solid traces
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

      // Cursor and tooltip
      if (cursorXRatio !== null && cursorXRatio >= 0 && cursorXRatio <= 1 && tooltip) {
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

        const tooltips = [`X: ${formatSi(curValX, xUnit)}`];
        activeList.forEach((name) => {
          const yData = getSeriesData(currentPlotData, name);
          if (!yData) return;
          const xData = currentPlotData.x;
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

          ctx.fillStyle = strokeColor;
          ctx.beginPath();
          ctx.arc(curX, py, 3.5, 0, Math.PI * 2);
          ctx.fill();

          const unit = name.startsWith('I(') ? 'A' : 'V';
          tooltips.push(`${name}: ${formatSi(valY, unit)}`);
        });

        tooltip.textContent = tooltips.join('\n');
        tooltip.style.display = 'block';
        const tipL = Math.min(rect.width - 150, Math.max(10, curX + 12));
        const tipT = Math.max(10, padT + 5);
        tooltip.style.left = `${tipL}px`;
        tooltip.style.top = `${tipT}px`;
      } else if (tooltip) {
        tooltip.style.display = 'none';
      }
    }

    if (canvas) {
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const padL = 55;
        const padR = 20;
        const plotW = Math.max(10, rect.width - padL - padR);
        const mx = e.clientX - rect.left - padL;

        if (mx >= 0 && mx <= plotW) {
          cursorXRatio = mx / plotW;
        } else {
          cursorXRatio = null;
        }
        draw();
      });

      canvas.addEventListener('mouseleave', () => {
        cursorXRatio = null;
        if (tooltip) tooltip.style.display = 'none';
        draw();
      });
    }

    window.addEventListener('resize', () => {
      draw();
    });

    return {
      setPlotData(current, previous) {
        previousPlotData = previous || currentPlotData;
        currentPlotData = current;

        if (plotTitle) {
          plotTitle.textContent = currentPlotData.plotName || 'Simulation';
        }

        // Auto-select initial output traces if none selected
        if (activeTraces.size === 0) {
          const seriesKeys = Object.keys(currentPlotData.series || {});
          // Prefer output voltage traces: V(out), V(/out), or first voltage
          const preferred =
            seriesKeys.find((k) => k.toLowerCase() === 'v(out)' || k.toLowerCase() === 'v(/out)') ||
            seriesKeys.find((k) => k.startsWith('V('));
          if (preferred) {
            activeTraces.add(preferred);
            primaryTrace = preferred;
          } else if (seriesKeys.length > 0) {
            activeTraces.add(seriesKeys[0]);
            primaryTrace = seriesKeys[0];
          }
        }

        updateLegendAndMeasurements();
        draw();
      },
      toggleTrace,
      addTrace,
      draw,
      getActiveTraces() {
        return activeTraces;
      },
      getCurrentPlotData() {
        return currentPlotData;
      },
    };
  };
})();
