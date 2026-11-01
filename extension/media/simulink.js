// Simulink Webview Controller: Interactive SVG Block Diagram, Parameter Editor, and Waveform Viewer.

(function () {
  const vscode = acquireVsCodeApi();

  const svg = document.getElementById('diagram-svg');
  const canvasContainer = document.getElementById('canvas-container');
  const modelNameEl = document.getElementById('model-name');
  const statusBadge = document.getElementById('status-badge');
  const simulateBtn = document.getElementById('simulate-btn');
  const stopTimeInput = document.getElementById('stop-time-input');
  const autoSimCheckbox = document.getElementById('autosim-checkbox');
  const asideContent = document.getElementById('aside-content');
  const waveformContainer = document.getElementById('waveform-panel');
  const banner = document.getElementById('banner');
  let bannerTimer;

  function showAgentBanner(text, hasUndo) {
    if (!banner) return;
    banner.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    banner.appendChild(span);

    if (hasUndo) {
      const undoBtn = document.createElement('button');
      undoBtn.textContent = 'Undo';
      undoBtn.className = 'banner-undo-btn';
      undoBtn.onclick = () => {
        vscode.postMessage({ type: 'undoAgent' });
      };
      banner.appendChild(undoBtn);
    }

    banner.classList.add('visible');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('visible'), 10000);
  }

  function updateHistoryPanel(items) {
    let section = document.getElementById('agent-history-section');
    if (!section) {
      const aside = document.querySelector('aside');
      if (aside) {
        section = document.createElement('div');
        section.id = 'agent-history-section';
        section.className = 'agent-history-section';
        section.innerHTML = '<div class="aside-header">Agent History</div><ul id="agent-history-list" class="agent-history-list"></ul>';
        aside.appendChild(section);
      }
    }
    const list = document.getElementById('agent-history-list');
    if (!list || !section) return;

    if (!items || items.length === 0) {
      section.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    section.classList.remove('hidden');
    list.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'agent-history-item';
      li.innerHTML = `<span class="agent-history-desc" title="${item.description}">${item.description}</span><span class="agent-history-time">${item.time}</span><button class="history-undo-btn">Undo</button>`;
      li.querySelector('button').onclick = () => {
        vscode.postMessage({ type: 'undoAgent' });
      };
      list.appendChild(li);
    });
  }

  let currentModel = null;
  let currentDiff = null;
  let selectedBlock = null;
  let currentSystemName = 'root';
  const systemStack = [];
  // Last simulation run, replayed on dashboard gauges: { x: number[], series: { name: number[] } }.
  let liveRun = null;
  let liveIndex = -1;
  let liveFrame = 0;
  const liveGauges = new Map();
  let bridgeStatus = 'off';

  // Waveform Viewer instance
  let waveformViewer = null;
  if (typeof window.createWaveformViewer === 'function') {
    waveformViewer = window.createWaveformViewer(waveformContainer, {
      title: 'Simulink Simulation Waveforms',
    });
  }

  // Pan and Zoom state
  let panX = 40;
  let panY = 40;
  let scale = 1.0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  // Viewport setup
  const viewportGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.insertAdjacentHTML('afterbegin',
    '<defs><marker id="slx-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="slx-arrowhead"/></marker></defs>');
  svg.appendChild(viewportGroup);

  function updateTransform() {
    viewportGroup.setAttribute('transform', `translate(${panX}, ${panY}) scale(${scale})`);
  }
  updateTransform();

  // Mouse interactions for pan/zoom
  canvasContainer.addEventListener('mousedown', (e) => {
    if (e.target === svg || e.target === canvasContainer || e.target === viewportGroup) {
      isDragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
      canvasContainer.classList.add('grabbing');
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panX = e.clientX - dragStartX;
    panY = e.clientY - dragStartY;
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    canvasContainer.classList.remove('grabbing');
  });

  canvasContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = canvasContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    panX = mouseX - (mouseX - panX) * zoomFactor;
    panY = mouseY - (mouseY - panY) * zoomFactor;
    scale *= zoomFactor;
    updateTransform();
  });

  // Action button events
  simulateBtn.addEventListener('click', () => {
    const stopTime = parseFloat(stopTimeInput.value) || 10;
    vscode.postMessage({
      type: 'simulate',
      stopTime,
    });
  });

  if (autoSimCheckbox) {
    autoSimCheckbox.addEventListener('change', (e) => {
      vscode.postMessage({
        type: 'toggleAutoSimulate',
        value: e.target.checked,
      });
    });
  }

  function showErrorOverlay(text) {
    let overlay = document.getElementById('error-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'error-overlay';
      overlay.className = 'error-overlay';
      overlay.innerHTML = `
        <div class="error-box">
          <div class="error-icon">&#9888;</div>
          <div class="error-title">Cannot open Simulink model</div>
          <div id="error-message" class="error-message"></div>
          <button id="error-open-as-text" class="primary">Open as text</button>
        </div>
      `;
      document.body.appendChild(overlay);
      document.getElementById('error-open-as-text').addEventListener('click', () => {
        vscode.postMessage({ type: 'openAsText' });
      });
    }
    document.getElementById('error-message').textContent = text;
    overlay.classList.remove('hidden');
  }

  function hideErrorOverlay() {
    const overlay = document.getElementById('error-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  async function captureEditorSnapshot(name) {
    try {
      const width = 1100;
      const height = 750;
      const offscreen = document.createElement('canvas');
      offscreen.width = width;
      offscreen.height = height;
      const ctx = offscreen.getContext('2d');

      const isLight = document.body.classList.contains('vscode-light');
      const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || (isLight ? '#ffffff' : '#1e1e1e');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      // Header bar
      ctx.fillStyle = isLight ? '#f3f3f3' : '#252526';
      ctx.fillRect(0, 0, width, 36);
      ctx.fillStyle = isLight ? '#333333' : '#cccccc';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('E-IDE Simulink Editor - ' + (modelNameEl?.textContent || 'rc_circuit.slx'), 16, 22);

      // Status badge
      ctx.fillStyle = bridgeStatus === 'ready' ? '#388a34' : '#888888';
      ctx.fillRect(width - 150, 8, 120, 20);
      ctx.fillStyle = '#ffffff';
      ctx.font = '11px sans-serif';
      ctx.fillText(`MATLAB: ${bridgeStatus}`, width - 130, 22);

      // Simulink Block Diagram SVG
      const svgEl = document.getElementById('diagram-svg');
      if (svgEl) {
        const svgClone = svgEl.cloneNode(true);
        const svgW = width - 260;
        const svgH = 380;
        svgClone.setAttribute('width', svgW);
        svgClone.setAttribute('height', svgH);

        const fg = isLight ? '#1e1e1e' : '#cccccc';
        const blockBg = isLight ? '#f9f9f9' : '#2d2d2d';
        const blue = isLight ? '#0066cc' : '#3794ff';

        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = `
          .slx-block rect { fill: ${blockBg} !important; stroke: ${fg} !important; stroke-width: 1.5px !important; rx: 2px !important; }
          .block-name { fill: ${fg} !important; font-size: 11px !important; font-family: sans-serif !important; font-weight: 600 !important; text-anchor: middle !important; dominant-baseline: central !important; }
          .block-type { fill: #888888 !important; font-size: 9px !important; font-family: sans-serif !important; text-anchor: middle !important; }
          .slx-line { stroke: ${fg} !important; stroke-width: 1.5px !important; fill: none !important; }
          .port { fill: ${blue} !important; stroke: none !important; }
        `;
        svgClone.insertBefore(style, svgClone.firstChild);

        const svgData = new XMLSerializer().serializeToString(svgClone);
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        await new Promise((resolve) => {
          img.onload = () => {
            ctx.drawImage(img, 10, 46, svgW, svgH);
            URL.revokeObjectURL(url);
            resolve();
          };
          img.onerror = resolve;
          img.src = url;
        });
      }

      // Sidebar parameters
      ctx.fillStyle = isLight ? '#f8f8f8' : '#252526';
      ctx.fillRect(width - 240, 46, 230, 380);
      ctx.strokeStyle = isLight ? '#e5e5e5' : '#333333';
      ctx.strokeRect(width - 240, 46, 230, 380);
      ctx.fillStyle = isLight ? '#333333' : '#cccccc';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('MODEL PARAMETERS', width - 230, 68);
      const rows = document.querySelectorAll('.param-table tbody tr');
      let ry = 88;
      rows.forEach((r, idx) => {
        if (idx < 10) {
          ctx.font = '10px monospace';
          ctx.fillStyle = isLight ? '#555555' : '#aaaaaa';
          ctx.fillText(r.textContent.replace(/\s+/g, ' ').trim(), width - 230, ry);
          ry += 18;
        }
      });

      // Waveform canvas
      const waveCanvas = document.getElementById('waveform-canvas');
      if (waveCanvas && waveCanvas.width > 0) {
        ctx.fillStyle = isLight ? '#f3f3f3' : '#252526';
        ctx.fillRect(0, 436, width, 28);
        ctx.fillStyle = isLight ? '#333333' : '#cccccc';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('SIMULINK WAVEFORMS', 16, 454);

        const pills = document.querySelectorAll('.trace-pill');
        let px = 170;
        pills.forEach((p) => {
          ctx.fillStyle = isLight ? '#e0e0e0' : '#383838';
          ctx.fillRect(px, 442, 60, 16);
          ctx.fillStyle = isLight ? '#222222' : '#ffffff';
          ctx.font = '10px sans-serif';
          ctx.fillText(p.textContent.trim(), px + 8, 454);
          px += 70;
        });

        ctx.drawImage(waveCanvas, 0, 466, width, 270);
      }

      const dataUrl = offscreen.toDataURL('image/png');
      vscode.postMessage({ type: 'snapshotResult', name, dataUrl });
    } catch (err) {
      vscode.postMessage({ type: 'snapshotResult', name, error: String(err) });
    }
  }

  // Handle messages from host
  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'update':
        hideErrorOverlay();
        currentModel = msg.model;
        currentDiff = msg.changes;
        if (modelNameEl) {
          modelNameEl.textContent = msg.fileName || currentModel.name;
        }
        renderDiagram();
        renderParamTable();
        if (currentDiff) {
          setTimeout(() => {
            currentDiff = null;
            document.querySelectorAll('.diff-changed, .diff-added').forEach((el) => {
              el.classList.remove('diff-changed', 'diff-added');
            });
          }, 3200);
        }
        break;

      case 'agentBanner':
        showAgentBanner(msg.text, msg.hasUndo);
        if (msg.history) updateHistoryPanel(msg.history);
        break;

      case 'agentHistoryUpdate':
        if (msg.history) updateHistoryPanel(msg.history);
        break;

      case 'bridgeStatus':
        bridgeStatus = msg.status;
        updateStatusBadge(msg.status);
        break;

      case 'simulationResult':
        if (waveformViewer && msg.current) {
          waveformViewer.loadData(msg.current, msg.previous);
        }
        if (msg.current && msg.current.x && msg.current.x.length) {
          liveRun = msg.current;
          replayGauges();
        }
        break;

      case 'error':
        showErrorOverlay(msg.error || 'Unable to open Simulink model');
        break;

      case 'captureSnapshot':
        captureEditorSnapshot(msg.name);
        break;
    }
  });

  function updateStatusBadge(status) {
    if (!statusBadge) return;
    statusBadge.className = `status-badge ${status}`;
    statusBadge.textContent = `MATLAB: ${status}`;
  }

  function getActiveSystem() {
    if (!currentModel) return null;
    if (currentSystemName === 'root' || !currentModel.subsystems[currentSystemName]) {
      return currentModel.rootSystem;
    }
    return currentModel.subsystems[currentSystemName];
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Mirrors portPosition() in slxParser.ts: ports spaced evenly along their side, rotation clockwise.
  function portPosition(block, portType, portNumber) {
    const { left, top, right, bottom } = block.position;
    const kind = portType.toLowerCase();
    const counts = block.ports || { in: 1, out: 1, lconn: 1, rconn: 1 };
    const total = Math.max(portNumber, counts[kind] || 1, 1);
    const frac = (2 * portNumber - 1) / (2 * total);
    let onStart = kind === 'in' || kind === 'lconn';
    if (block.mirror) onStart = !onStart;
    switch ((((block.rotation || 0) % 360) + 360) % 360) {
      case 90: return { x: right - frac * (right - left), y: onStart ? top : bottom };
      case 180: return { x: onStart ? right : left, y: bottom - frac * (bottom - top) };
      case 270: return { x: left + frac * (right - left), y: onStart ? bottom : top };
      default: return { x: onStart ? left : right, y: top + frac * (bottom - top) };
    }
  }

  function linePath(line, srcBlock, dstBlock) {
    let pts = line.points && line.points.length >= 2 ? line.points.slice() : null;
    if (!pts) {
      const a = portPosition(srcBlock, line.src.portType, line.src.portNumber);
      const b = portPosition(dstBlock, line.dst.portType, line.dst.portNumber);
      const midX = (a.x + b.x) / 2;
      pts = [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
    } else {
      // A model edited without re-routing can leave the last leg diagonal; draw it as an elbow.
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1) pts.splice(pts.length - 1, 0, { x: a.x, y: b.y });
    }
    return 'M ' + pts.map((p) => `${p.x} ${p.y}`).join(' L ');
  }

  function shortValue(text, max) {
    if (!text) return '';
    const t = String(text).replace(/\s+/g, ' ');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  const GLYPHS = {
    UnitDelay: '1/z', Integrator: '1/s', Derivative: 'du/dt', Product: '×', TransferFcn: 'H(s)',
    StateSpace: 'ẋ=Ax+Bu', Saturate: '⟋', Scope: '▭', Step: '⎍', Clock: '⏱', Mux: '⫴', Demux: '⫴',
    PMIOPort: '◇', Memory: 'M', Switch: '⇄', Abs: '|u|', Sqrt: '√',
  };

  // A recognisable glyph per block type, close to what Simulink draws, without library assets.
  function drawGlyph(g, block) {
    const { left, top, right, bottom } = block.position;
    const w = right - left;
    const h = bottom - top;
    const cx = left + w / 2;
    const cy = top + h / 2;
    const p = block.parameters || {};
    const fs = Math.max(7, Math.min(12, h * 0.4));
    const text = (t, size) => g.appendChild(el('text', { x: cx, y: cy, class: 'block-glyph', 'font-size': size || fs }, t));
    switch (block.type) {
      case 'Gain':
        g.appendChild(el('polygon', { points: `${left},${top} ${right},${cy} ${left},${bottom}`, class: 'block-shape' }));
        text(shortValue(p.Gain || '1', 6));
        return;
      case 'Sum':
        if (p.IconShape !== 'rectangular') {
          g.appendChild(el('ellipse', { cx, cy, rx: w / 2, ry: h / 2, class: 'block-shape' }));
          text(shortValue((p.Inputs || '++').replace(/\|/g, ''), 4));
          return;
        }
        break;
      case 'Inport':
      case 'Outport':
        g.appendChild(el('rect', { x: left, y: top, width: w, height: h, rx: h / 2, ry: h / 2, class: 'block-shape' }));
        text(p.Port || '1');
        return;
      case 'Goto':
      case 'From':
        g.appendChild(el('rect', { x: left, y: top, width: w, height: h, class: 'block-shape' }));
        text(`[${shortValue(p.GotoTag || 'A', 10)}]`);
        return;
      case 'CustomWebBlock':
      case 'CircularGaugeBlock':
      case 'DashboardScope': {
        const r = Math.min(w, h) / 2;
        g.appendChild(el('circle', { cx, cy, r, class: 'block-shape dashboard' }));
        g.appendChild(el('path', { d: `M ${cx - r * 0.7} ${cy + r * 0.3} A ${r * 0.75} ${r * 0.75} 0 1 1 ${cx + r * 0.7} ${cy + r * 0.3}`, class: 'gauge-arc' }));
        const live = el('g', { class: 'gauge-live' });
        g.appendChild(live);
        liveGauges.set(block.sid, { node: live, block });
        paintGauge(live, block);
        return;
      }
      case 'SliderBlock':
      case 'KnobBlock':
        g.appendChild(el('rect', { x: left, y: top, width: w, height: h, class: 'block-shape dashboard' }));
        g.appendChild(el('line', { x1: left + 4, y1: cy, x2: right - 4, y2: cy, class: 'gauge-arc' }));
        g.appendChild(el('circle', { cx: left + w * 0.4, cy, r: Math.min(5, h / 3), class: 'gauge-needle' }));
        return;
      default:
        break;
    }
    g.appendChild(el('rect', { x: left, y: top, width: w, height: h, class: 'block-shape' }));
    if (block.type === 'SubSystem') {
      text(shortValue(block.name, Math.max(6, Math.floor(w / 6))), Math.max(7, Math.min(11, fs)));
    } else if (block.type === 'Reference' || block.type === 'S-Function') {
      const src = (block.sourceBlock || p.SourceBlock || block.type).split('/').pop();
      text(shortValue(src, Math.max(5, Math.floor(w / 5))), Math.max(6, Math.min(10, fs)));
    } else if (block.type === 'Constant') {
      text(shortValue(p.Value || '1', 8));
    } else {
      text(GLYPHS[block.type] || shortValue(block.type, Math.max(4, Math.floor(w / 6))));
    }
  }

  // The bound signal's value at the replay position, matched by signal name, then by source block name.
  function liveValue(block) {
    if (!liveRun || !block.binding || liveIndex < 0) return undefined;
    const { signal, source } = block.binding;
    const key = [signal, source].find((k) => k && liveRun.series[k]);
    const values = key && liveRun.series[key];
    if (!values || !values.length) return undefined;
    return values[Math.min(liveIndex, values.length - 1)];
  }

  function formatValue(v) {
    const a = Math.abs(v);
    return a !== 0 && (a >= 1e4 || a < 1e-2) ? v.toExponential(2) : String(Number(v.toPrecision(3)));
  }

  // Needle and readout. The arc runs clockwise from 203° to -23°, mapped onto the gauge's min..max.
  function paintGauge(node, block) {
    node.textContent = '';
    const { left, top, right, bottom } = block.position;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const r = Math.min(right - left, bottom - top) / 2;
    const v = liveValue(block);
    const { min, max } = block.gauge || { min: 0, max: 100 };
    const frac = v === undefined ? 0.75 : Math.max(0, Math.min(1, (v - min) / (max - min)));
    const angle = ((203.2 - 226.4 * frac) * Math.PI) / 180;
    node.appendChild(el('line', { x1: cx, y1: cy, x2: cx + r * 0.6 * Math.cos(angle), y2: cy - r * 0.6 * Math.sin(angle), class: 'gauge-needle' }));
    if (v !== undefined) {
      node.appendChild(el('text', { x: cx, y: cy + r * 0.55, class: 'gauge-value', 'font-size': Math.max(6, r * 0.32) }, formatValue(v)));
    }
  }

  // Replays the run on every gauge over about two seconds, ending on the final value.
  function replayGauges() {
    cancelAnimationFrame(liveFrame);
    const n = liveRun ? liveRun.x.length : 0;
    if (!n) return;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 2000);
      liveIndex = Math.round(t * (n - 1));
      liveGauges.forEach(({ node, block }) => paintGauge(node, block));
      if (t < 1) liveFrame = requestAnimationFrame(step);
    };
    liveFrame = requestAnimationFrame(step);
  }

  function drawPorts(g, block) {
    const counts = block.ports;
    if (!counts) return;
    for (const kind of ['in', 'out', 'lconn', 'rconn']) {
      for (let k = 1; k <= (counts[kind] || 0); k++) {
        const pos = portPosition(block, kind, k);
        if (kind === 'lconn' || kind === 'rconn') {
          g.appendChild(el('rect', { x: pos.x - 2.5, y: pos.y - 2.5, width: 5, height: 5, class: 'port conn' }));
        } else {
          g.appendChild(el('circle', { cx: pos.x, cy: pos.y, r: 1.8, class: 'port' }));
        }
      }
    }
  }

  function fitToView(system) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (p) => {
      minX = Math.min(minX, p.left); minY = Math.min(minY, p.top);
      maxX = Math.max(maxX, p.right); maxY = Math.max(maxY, p.bottom + 14);
    };
    system.blocks.forEach((b) => grow(b.position));
    (system.annotations || []).forEach((a) => grow(a.position));
    if (!Number.isFinite(minX)) return;
    const rect = canvasContainer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pad = 24;
    scale = Math.min((rect.width - 2 * pad) / Math.max(1, maxX - minX), (rect.height - 2 * pad) / Math.max(1, maxY - minY), 2);
    panX = pad - minX * scale + (rect.width - 2 * pad - (maxX - minX) * scale) / 2;
    panY = pad - minY * scale;
    updateTransform();
  }

  let lastFittedSystem = null;

  function renderDiagram() {
    const system = getActiveSystem();
    if (!system) return;

    viewportGroup.innerHTML = '';
    liveGauges.clear();
    const blockMap = new Map();
    for (const b of system.blocks) blockMap.set(b.sid, b);

    // 0. Annotations (titles and notes) sit behind everything.
    const annGroup = el('g', { class: 'annotations-group' });
    for (const a of system.annotations || []) {
      const size = a.fontSize || 10;
      a.text.split(/\n/).forEach((lineText, i) => {
        annGroup.appendChild(el('text', {
          x: a.position.left,
          y: a.position.top + size * (i + 1),
          class: 'slx-annotation' + (a.bold ? ' bold' : ''),
          'font-size': size,
        }, lineText));
      });
    }
    viewportGroup.appendChild(annGroup);

    // 1. Lines, routed along the points saved in the model.
    const linesGroup = el('g', { class: 'lines-group' });
    for (const line of system.lines) {
      if (!line.src || !line.dst) continue;
      const srcBlock = blockMap.get(line.src.sid);
      const dstBlock = blockMap.get(line.dst.sid);
      if (!srcBlock || !dstBlock) continue;
      const physical = /conn/i.test(line.src.portType) || /conn/i.test(line.dst.portType);
      let cls = 'slx-line' + (physical ? ' physical' : '');
      if (line.logged) cls += ' logged';
      const pathEl = el('path', { d: linePath(line, srcBlock, dstBlock), class: cls });
      if (!physical) pathEl.setAttribute('marker-end', 'url(#slx-arrow)');
      if (line.name) pathEl.appendChild(el('title', {}, line.name));

      pathEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (physical) return;
        if (line.logged) {
          vscode.postMessage({ type: 'plotSignal', name: line.name || srcBlock.name });
        } else if (confirm(`Signal from '${srcBlock.name}' is not logged. Enable logging on this signal?`)) {
          vscode.postMessage({ type: 'enableLogging', line: { srcBlock: srcBlock.name, srcPort: line.src.portNumber } });
        }
      });
      linesGroup.appendChild(pathEl);
    }
    viewportGroup.appendChild(linesGroup);

    // 2. Blocks
    const blocksGroup = el('g', { class: 'blocks-group' });
    for (const block of system.blocks) {
      let bClass = 'slx-block';
      if (currentDiff) {
        if (currentDiff.changedBlockSids && currentDiff.changedBlockSids.includes(block.sid)) bClass += ' diff-changed';
        else if (currentDiff.addedBlockSids && currentDiff.addedBlockSids.includes(block.sid)) bClass += ' diff-added';
      }
      if (selectedBlock && selectedBlock.sid === block.sid) bClass += ' selected';
      const bGroup = el('g', { class: bClass });

      drawGlyph(bGroup, block);
      drawPorts(bGroup, block);

      if ((block.parameters || {}).ShowName !== 'off') {
        const { left, right, bottom } = block.position;
        bGroup.appendChild(el('text', { x: (left + right) / 2, y: bottom + 10, class: 'block-name' }, block.name));
      }
      const bound = block.binding ? `
Shows: ${block.binding.signal} (from ${block.binding.source})` : '';
      bGroup.appendChild(el('title', {}, `${block.name} (${block.sourceBlock || block.type})${bound}`));

      bGroup.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedBlock = block;
        renderDiagram();
        renderParamTable();
      });

      // Subsystem files are named after the block's SID, not its name.
      if (block.type === 'SubSystem' && currentModel.subsystems[block.sid]) {
        bGroup.classList.add('drillable');
        bGroup.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          systemStack.push({ sid: block.sid, name: block.name });
          currentSystemName = block.sid;
          selectedBlock = null;
          renderDiagram();
          renderParamTable();
        });
      }
      blocksGroup.appendChild(bGroup);
    }
    viewportGroup.appendChild(blocksGroup);

    if (lastFittedSystem !== currentSystemName) {
      lastFittedSystem = currentSystemName;
      fitToView(system);
    }
  }

  function renderParamTable() {
    asideContent.innerHTML = '';

    const system = getActiveSystem();
    if (!system) return;

    // Subsystem breadcrumb if inside subsystem
    if (currentSystemName !== 'root') {
      const bc = document.createElement('div');
      bc.className = 'slx-breadcrumb';
      const back = document.createElement('a');
      back.href = '#';
      back.textContent = '← Up';
      back.addEventListener('click', (e) => {
        e.preventDefault();
        systemStack.pop();
        currentSystemName = systemStack.length ? systemStack[systemStack.length - 1].sid : 'root';
        selectedBlock = null;
        renderDiagram();
        renderParamTable();
      });
      bc.appendChild(back);
      bc.appendChild(document.createTextNode('  ' + ['model', ...systemStack.map((f) => f.name)].join(' / ')));
      asideContent.appendChild(bc);
    }

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.fontSize = '12px';
    title.style.marginBottom = '8px';
    title.textContent = selectedBlock ? `Parameters: ${selectedBlock.name}` : 'All Block Parameters';
    asideContent.appendChild(title);

    const blocksToDisplay = selectedBlock ? [selectedBlock] : system.blocks;

    for (const b of blocksToDisplay) {
      const bTitle = document.createElement('div');
      bTitle.style.fontWeight = '500';
      bTitle.style.fontSize = '11px';
      bTitle.style.marginTop = '6px';
      bTitle.textContent = `${b.name} (${b.type})`;
      asideContent.appendChild(bTitle);

      const table = document.createElement('table');
      table.className = 'param-table';
      table.innerHTML = `<thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody></tbody>`;
      const tbody = table.querySelector('tbody');

      const params = Object.entries(b.parameters);
      if (params.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `<td colspan="2" style="color:var(--vscode-descriptionForeground); font-style:italic;">No custom parameters</td>`;
        tbody.appendChild(row);
      } else {
        for (const [key, val] of params) {
          const row = document.createElement('tr');
          const keyCell = document.createElement('td');
          keyCell.textContent = key;

          const valCell = document.createElement('td');
          const input = document.createElement('input');
          input.type = 'text';
          input.value = val;

          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              saveParam(b.name, key, input.value);
            }
          });

          input.addEventListener('blur', () => {
            if (input.value !== val) {
              saveParam(b.name, key, input.value);
            }
          });

          valCell.appendChild(input);
          row.appendChild(keyCell);
          row.appendChild(valCell);
          tbody.appendChild(row);
        }
      }

      asideContent.appendChild(table);
    }
  }

  function saveParam(blockName, paramName, value) {
    if (bridgeStatus === 'off') {
      alert('Start MATLAB to edit');
      return;
    }

    vscode.postMessage({
      type: 'setParam',
      block: blockName,
      param: paramName,
      value: value,
    });
  }

  // Notify host that webview is ready
  vscode.postMessage({ type: 'ready' });
})();
