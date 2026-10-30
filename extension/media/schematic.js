// Webview script for LTspice schematic editor.
// Draws schematic as SVG, highlights edits, and coordinates with shared waveform viewer.
(function () {
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('canvas');
  const tbody = document.querySelector('#components tbody');
  const directives = document.getElementById('directives');
  const banner = document.getElementById('banner');
  const runBtn = document.getElementById('run-sim');
  const spinner = document.getElementById('sim-spinner');

  let bannerTimer;
  let currentSchematic;

  // Initialize shared waveform viewer
  const waveform = window.createWaveformViewer({
    canvas: document.getElementById('waveform-canvas'),
    legendBox: document.getElementById('traces-legend'),
    measBox: document.getElementById('measurements-bar'),
    tooltip: document.getElementById('cursor-tooltip'),
    emptyMsg: document.getElementById('waveform-empty-msg'),
    plotTitle: document.getElementById('plot-title'),
  });

  const SHAPES = {
    res: { label: [36, 56], parts: [['path', { d: 'M16 16 V32 M16 80 V96', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }], ['rect', { x: 6, y: 32, width: 20, height: 48, fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }]] },
    cap: { label: [40, 32], parts: [['path', { d: 'M16 0 V28 M16 36 V64 M0 28 H32 M0 36 H32', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }]] },
    ind: { label: [36, 56], parts: [['path', { d: 'M16 16 V32 M16 80 V96 M16 32 a8 6 0 0 1 0 12 a8 6 0 0 1 0 12 a8 6 0 0 1 0 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }]] },
    voltage: { label: [24, 56], parts: [['path', { d: 'M0 16 V40 M0 72 V96 M-4 50 H4 M0 46 V54 M-4 64 H4', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }], ['circle', { cx: 0, cy: 56, r: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }]] },
    current: { label: [24, 56], parts: [['path', { d: 'M0 0 V24 M0 56 V80 M0 32 V48 M-5 42 L0 48 L5 42', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }], ['circle', { cx: 0, cy: 40, r: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }]] },
    diode: { label: [36, 32], parts: [['path', { d: 'M16 0 V20 M16 44 V64 M0 20 H32 L16 44 Z M0 44 H32', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }]] },
  };
  const FALLBACK = { label: [52, 16], parts: [['rect', { x: -16, y: -16, width: 64, height: 64, fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }]] };

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

  function findNetNameAt(x, y) {
    if (!currentSchematic) return null;
    for (const f of currentSchematic.flags) {
      if (Math.hypot(f.x - x, f.y - y) < 8) return f.name;
    }
    return null;
  }

  function selectSymbol(id) {
    document.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
    document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.add('selected'));
    waveform.toggleTrace(`I(${id})`);
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
          <div class="error-title">Cannot open schematic</div>
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
      ctx.fillText('E-IDE Schematic Editor - ' + (document.getElementById('file-name')?.textContent || ''), 16, 22);

      // Schematic SVG
      const svgEl = document.getElementById('canvas');
      if (svgEl) {
        const svgClone = svgEl.cloneNode(true);
        const svgW = width - 260;
        const svgH = 380;
        svgClone.setAttribute('width', svgW);
        svgClone.setAttribute('height', svgH);

        const fg = isLight ? '#1e1e1e' : '#cccccc';
        const blue = isLight ? '#0066cc' : '#3794ff';
        const purple = isLight ? '#7b38a6' : '#b180d7';
        const orange = isLight ? '#d97706' : '#d18616';

        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = `
          line, path, rect, circle { stroke: ${fg}; stroke-width: 2px; fill: none; }
          .wires line { stroke: ${blue} !important; }
          .dot { fill: ${blue} !important; stroke: none !important; }
          text { fill: ${fg} !important; font-size: 14px !important; font-family: monospace, sans-serif !important; stroke: none !important; }
          .type { font-size: 11px !important; opacity: 0.7; }
          .directive { fill: ${purple} !important; }
          .comment { fill: #888888 !important; }
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

      // Sidebar components
      ctx.fillStyle = isLight ? '#f8f8f8' : '#252526';
      ctx.fillRect(width - 240, 46, 230, 380);
      ctx.strokeStyle = isLight ? '#e5e5e5' : '#333333';
      ctx.strokeRect(width - 240, 46, 230, 380);
      ctx.fillStyle = isLight ? '#333333' : '#cccccc';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('COMPONENTS', width - 230, 68);
      const rows = document.querySelectorAll('#components tbody tr');
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
        ctx.fillText(document.getElementById('plot-title')?.textContent || 'WAVEFORMS', 16, 454);

        const pills = document.querySelectorAll('.trace-pill');
        let px = 160;
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

  function renderSchematic({ schematic, changes, fileName }) {
    hideErrorOverlay();
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
        const netName = findNetNameAt(w.x1, w.y1) || findNetNameAt(w.x2, w.y2);
        if (netName && netName !== '0') {
          waveform.toggleTrace(`V(${netName})`);
        } else {
          const plot = waveform.getCurrentPlotData();
          const candidate = Object.keys(plot?.series || {}).find((k) => k.startsWith('V(') && k !== 'V(0)');
          if (candidate) waveform.toggleTrace(candidate);
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

    // Flags
    const flags = el('g', { class: 'flags' }, svg);
    for (const f of schematic.flags) {
      const g = el('g', { class: 'flag' }, flags);
      if (f.name === '0') {
        el('path', { d: `M${f.x - 16} ${f.y} H${f.x + 16} L${f.x} ${f.y + 16} Z`, fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, g);
      } else {
        const txt = el('text', { x: f.x + 4, y: f.y - 6 }, g);
        txt.textContent = f.name;
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          waveform.toggleTrace(`V(${f.name})`);
        });
      }
      el('circle', { cx: f.x, cy: f.y, r: 3, class: 'dot' }, g);
      xs.push(f.x);
      ys.push(f.y);
    }

    // Directives
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
      setTimeout(() => {
        document.querySelectorAll('.changed').forEach((el) => {
          el.classList.remove('changed');
        });
      }, 3200);
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

  function showAgentBanner(text, hasUndo) {
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
        section.innerHTML = '<h2>Agent History</h2><ul id="agent-history-list" class="agent-history-list"></ul>';
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

  function showBanner(changes) {
    const parts = [];
    if (changes.symbols?.length) parts.push(`changed ${changes.symbols.join(', ')}`);
    if (changes.removedSymbols?.length) parts.push(`removed ${changes.removedSymbols.join(', ')}`);
    if (changes.wires?.length) parts.push(`${changes.wires.length} wire(s) added`);
    if (changes.texts?.length) parts.push(`${changes.texts.length} directive(s) changed`);
    if (!parts.length) return;
    showBannerText(`Update: ${parts.join(' · ')}`);
  }

  // Handle incoming messages
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
          waveform.setPlotData(msg.current, msg.previous);
          if (msg.bannerText) showBannerText(msg.bannerText);
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

      case 'agentBanner':
        showAgentBanner(msg.text, msg.hasUndo);
        if (msg.history) updateHistoryPanel(msg.history);
        break;

      case 'agentHistoryUpdate':
        if (msg.history) updateHistoryPanel(msg.history);
        break;

      case 'error':
        showErrorOverlay(msg.error || 'Unable to open schematic');
        break;

      case 'captureSnapshot':
        captureEditorSnapshot(msg.name);
        break;
    }
  });

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
