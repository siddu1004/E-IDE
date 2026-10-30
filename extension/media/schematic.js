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
    res: { label: [36, 56], parts: [['path', { d: 'M16 16 V32 M16 80 V96' }], ['rect', { x: 6, y: 32, width: 20, height: 48 }]] },
    cap: { label: [40, 32], parts: [['path', { d: 'M16 0 V28 M16 36 V64 M0 28 H32 M0 36 H32' }]] },
    ind: { label: [36, 56], parts: [['path', { d: 'M16 16 V32 M16 80 V96 M16 32 a8 6 0 0 1 0 12 a8 6 0 0 1 0 12 a8 6 0 0 1 0 12' }]] },
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
        el('path', { d: `M${f.x - 16} ${f.y} H${f.x + 16} L${f.x} ${f.y + 16} Z` }, g);
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
