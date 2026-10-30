// Webview script for KiCad schematic editor.
// Draws symbols from lib_symbols graphics, wires, junctions, labels,
// supports net highlighting across wires/pins, components table editing,
// ERC runs, and LTspice waveform simulations.
(function () {
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('canvas');
  const tbody = document.querySelector('#components tbody');
  const directives = document.getElementById('directives');
  const banner = document.getElementById('banner');
  const simBtn = document.getElementById('run-sim');
  const ercBtn = document.getElementById('run-erc');
  const spinner = document.getElementById('sim-spinner');

  let bannerTimer;
  let currentSchematic;
  let activeNetName = null;

  // Initialize shared waveform viewer
  const waveform = window.createWaveformViewer({
    canvas: document.getElementById('waveform-canvas'),
    legendBox: document.getElementById('traces-legend'),
    measBox: document.getElementById('measurements-bar'),
    tooltip: document.getElementById('cursor-tooltip'),
    emptyMsg: document.getElementById('waveform-empty-msg'),
    plotTitle: document.getElementById('plot-title'),
  });

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  function transformLocal(localX, localY, symX, symY, angleDeg, mirror) {
    let px = localX;
    let py = -localY; // Symbol library is Y-up, schematic is Y-down
    if (mirror === 'x') px = -px;
    if (mirror === 'y') py = -py;
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = px * cos - py * sin;
    const ry = px * sin + py * cos;
    return { x: symX + rx, y: symY + ry };
  }

  function highlightNet(netName) {
    if (activeNetName === netName) {
      activeNetName = null;
    } else {
      activeNetName = netName;
    }

    document.querySelectorAll('.net-highlighted').forEach((n) => n.classList.remove('net-highlighted'));

    if (!activeNetName) return;

    // Highlight all elements belonging to activeNetName
    document.querySelectorAll(`[data-net="${CSS.escape(activeNetName)}"]`).forEach((n) => {
      n.classList.add('net-highlighted');
    });

    // Also toggle in waveform plot if sim data exists: V(/<netName>) or V(<netName>)
    const plot = waveform.getCurrentPlotData();
    if (plot && plot.series) {
      const keys = Object.keys(plot.series);
      const target = keys.find(
        (k) =>
          k.toLowerCase() === `v(/${activeNetName.toLowerCase()})` ||
          k.toLowerCase() === `v(${activeNetName.toLowerCase()})`
      );
      if (target) {
        waveform.toggleTrace(target);
      }
    }
  }

  function selectSymbol(ref) {
    document.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
    document.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`).forEach((n) => n.classList.add('selected'));
    waveform.toggleTrace(`I(${ref})`);
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

    // Map each pin and wire endpoint to its net name for interactive highlighting
    const pinToNet = new Map();
    for (const net of schematic.nets || []) {
      for (const p of net.pins || []) {
        pinToNet.set(`${p.ref}:${p.pin}`, net.name);
      }
    }

    // Helper: find net touching coordinate (x, y)
    function findNetAt(x, y) {
      for (const net of schematic.nets || []) {
        for (const p of net.pins || []) {
          const sym = schematic.symbols.find((s) => s.ref === p.ref);
          if (sym) {
            const libSym = schematic.libSymbols?.[sym.libId];
            const pinDef = libSym?.pins?.find((pd) => pd.number === p.pin);
            if (pinDef) {
              const pt = transformLocal(pinDef.x, pinDef.y, sym.x, sym.y, sym.angle, sym.mirror);
              if (Math.hypot(pt.x - x, pt.y - y) < 0.15) return net.name;
            }
          }
        }
      }
      return null;
    }

    // 1. Draw Wires
    const wiresGroup = el('g', { class: 'wires' }, svg);
    schematic.wires.forEach((w, i) => {
      const netName = findNetAt(w.x1, w.y1) || findNetAt(w.x2, w.y2) || '';
      const line = el(
        'line',
        {
          x1: w.x1,
          y1: w.y1,
          x2: w.x2,
          y2: w.y2,
          class: `${changedWires.has(i) ? 'changed' : ''} ${activeNetName && activeNetName === netName ? 'net-highlighted' : ''}`,
          'data-net': netName,
        },
        wiresGroup
      );

      line.addEventListener('click', () => {
        if (netName) highlightNet(netName);
      });

      xs.push(w.x1, w.x2);
      ys.push(w.y1, w.y2);
    });

    // 2. Draw Junctions
    const junctionsGroup = el('g', { class: 'junctions' }, svg);
    for (const j of schematic.junctions) {
      const netName = findNetAt(j.x, j.y) || '';
      el(
        'circle',
        {
          cx: j.x,
          cy: j.y,
          r: 0.6,
          class: activeNetName && activeNetName === netName ? 'net-highlighted' : '',
          'data-net': netName,
        },
        junctionsGroup
      );
      xs.push(j.x);
      ys.push(j.y);
    }

    // 3. Draw Placed Symbols
    const symbolsGroup = el('g', { class: 'symbols' }, svg);
    for (const sym of schematic.symbols) {
      const isPower = sym.ref.startsWith('#PWR') || sym.libId.startsWith('power:');
      const changed = changedSymbols.has(sym.ref);
      const mirrorX = sym.mirror === 'x' ? -1 : 1;

      // Group for symbol with exact transform
      const g = el(
        'g',
        {
          class: `symbol${changed ? ' changed' : ''}`,
          'data-ref': sym.ref,
        },
        symbolsGroup
      );

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        selectSymbol(sym.ref);
      });

      // Draw graphics from lib_symbols
      const libSym = schematic.libSymbols?.[sym.libId];
      if (libSym) {
        // Shapes
        for (const item of libSym.graphics || []) {
          if (item.type === 'rectangle' && item.pts.length >= 2) {
            const p1 = transformLocal(item.pts[0].x, item.pts[0].y, sym.x, sym.y, sym.angle, sym.mirror);
            const p2 = transformLocal(item.pts[1].x, item.pts[1].y, sym.x, sym.y, sym.angle, sym.mirror);
            el('rect', {
              x: Math.min(p1.x, p2.x),
              y: Math.min(p1.y, p2.y),
              width: Math.abs(p2.x - p1.x),
              height: Math.abs(p2.y - p1.y),
            }, g);
            xs.push(p1.x, p2.x);
            ys.push(p1.y, p2.y);
          } else if (item.type === 'polyline' && item.pts.length >= 2) {
            const pointsStr = item.pts
              .map((pt) => {
                const p = transformLocal(pt.x, pt.y, sym.x, sym.y, sym.angle, sym.mirror);
                xs.push(p.x);
                ys.push(p.y);
                return `${p.x},${p.y}`;
              })
              .join(' ');
            el('polyline', { points: pointsStr }, g);
          } else if (item.type === 'circle' && item.center) {
            const c = transformLocal(item.center.x, item.center.y, sym.x, sym.y, sym.angle, sym.mirror);
            const r = item.radius || 1;
            el('circle', { cx: c.x, cy: c.y, r }, g);
            xs.push(c.x - r, c.x + r);
            ys.push(c.y - r, c.y + r);
          }
        }

        // Pins
        for (const pinDef of libSym.pins || []) {
          const pinNet = pinToNet.get(`${sym.ref}:${pinDef.number}`) || '';
          const pStart = transformLocal(pinDef.x, pinDef.y, sym.x, sym.y, sym.angle, sym.mirror);

          // Pin line drawn in direction of length
          if (pinDef.length > 0) {
            const pinRad = ((sym.angle + pinDef.angle) * Math.PI) / 180;
            const pEnd = {
              x: pStart.x + pinDef.length * Math.cos(pinRad),
              y: pStart.y - pinDef.length * Math.sin(pinRad),
            };
            el('line', {
              x1: pStart.x,
              y1: pStart.y,
              x2: pEnd.x,
              y2: pEnd.y,
              class: `symbol-pin ${activeNetName && activeNetName === pinNet ? 'net-highlighted' : ''}`,
              'data-net': pinNet,
            }, g);
            xs.push(pStart.x, pEnd.x);
            ys.push(pStart.y, pEnd.y);
          } else {
            xs.push(pStart.x);
            ys.push(pStart.y);
          }
        }
      }

      // Draw Reference and Value text
      if (!isPower) {
        const refProp = sym.properties.Reference;
        if (refProp && !refProp.hide) {
          const txt = el('text', { x: refProp.x, y: refProp.y, class: 'ref-text' }, g);
          txt.textContent = sym.ref;
          xs.push(refProp.x);
          ys.push(refProp.y);
        }
        const valProp = sym.properties.Value;
        if (valProp && !valProp.hide) {
          const txt = el('text', { x: valProp.x, y: valProp.y, class: 'val-text' }, g);
          txt.textContent = sym.value;
          xs.push(valProp.x);
          ys.push(valProp.y);
        }
      } else {
        const valProp = sym.properties.Value;
        if (valProp && !valProp.hide) {
          const txt = el('text', { x: valProp.x, y: valProp.y, class: 'val-text' }, g);
          txt.textContent = sym.value;
          xs.push(valProp.x);
          ys.push(valProp.y);
        }
      }
    }

    // 4. Draw Labels
    const labelsGroup = el('g', { class: 'labels' }, svg);
    for (const lbl of schematic.labels) {
      const g = el('g', { class: 'label' }, labelsGroup);
      const isHigh = activeNetName === lbl.name;
      const txt = el(
        'text',
        {
          x: lbl.x,
          y: lbl.y - 0.5,
          class: isHigh ? 'net-highlighted' : '',
          'data-net': lbl.name,
        },
        g
      );
      txt.textContent = lbl.name;

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        highlightNet(lbl.name);
      });

      xs.push(lbl.x - 2, lbl.x + 8);
      ys.push(lbl.y - 2, lbl.y + 2);
    }

    // 5. Draw Texts and Directives
    const textsGroup = el('g', { class: 'texts' }, svg);
    schematic.texts.forEach((t, i) => {
      const cls = `${t.directive ? 'directive' : 'comment'}${changedTexts.has(i) ? ' changed' : ''}`;
      const txt = el('text', { x: t.x, y: t.y, class: cls }, textsGroup);
      txt.textContent = t.text;
      xs.push(t.x, t.x + 15);
      ys.push(t.y);
    });

    if (xs.length) {
      const pad = 10;
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      svg.setAttribute('viewBox', `${minX} ${minY} ${Math.max(...xs) - minX + pad * 2} ${Math.max(...ys) - minY + pad * 2}`);
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
      if (sym.ref.startsWith('#PWR')) continue;

      const row = document.createElement('tr');
      row.dataset.ref = sym.ref;
      if (changedSymbols.has(sym.ref)) row.classList.add('changed');

      const nameCell = document.createElement('td');
      nameCell.textContent = sym.ref;

      // Editable Value field
      const valCell = document.createElement('td');
      const valInput = document.createElement('input');
      valInput.value = sym.value;
      valInput.setAttribute('aria-label', `Value of ${sym.ref}`);
      valInput.addEventListener('change', () => {
        if (valInput.value.trim() && valInput.value !== sym.value) {
          vscode.postMessage({ type: 'setProperty', ref: sym.ref, key: 'Value', value: valInput.value });
        }
      });
      valInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') valInput.blur();
      });
      valCell.appendChild(valInput);

      // Editable Footprint field
      const fpCell = document.createElement('td');
      const fpInput = document.createElement('input');
      fpInput.value = sym.footprint;
      fpInput.setAttribute('aria-label', `Footprint of ${sym.ref}`);
      fpInput.addEventListener('change', () => {
        if (fpInput.value !== sym.footprint) {
          vscode.postMessage({ type: 'setProperty', ref: sym.ref, key: 'Footprint', value: fpInput.value });
        }
      });
      fpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fpInput.blur();
      });
      fpCell.appendChild(fpInput);

      row.append(nameCell, valCell, fpCell);
      row.addEventListener('click', () => selectSymbol(sym.ref));
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
      ctx.fillText('E-IDE KiCad Editor - ' + (document.getElementById('file-name')?.textContent || ''), 16, 22);

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
        const green = isLight ? '#2e8b57' : '#4ec9b0';
        const orange = isLight ? '#d97706' : '#d18616';
        const red = isLight ? '#cf222e' : '#f14c4c';

        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = `
          line, polyline, rect, circle, path { stroke: ${fg}; stroke-width: 0.35px; fill: none; }
          .wires line { stroke: ${green} !important; stroke-width: 0.45px !important; }
          .junctions circle { fill: ${green} !important; stroke: none !important; }
          .symbol-pin { stroke: ${red} !important; stroke-width: 0.3px !important; }
          text { fill: ${fg} !important; font-size: 1.8px !important; font-family: monospace, sans-serif !important; stroke: none !important; }
          text.ref-text { fill: ${blue} !important; font-weight: bold; }
          text.val-text { fill: ${purple} !important; }
          .directive { fill: ${orange} !important; }
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

  // Handle incoming messages from extension host
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;

    switch (msg.type) {
      case 'update':
        hideErrorOverlay();
        renderSchematic(msg);
        break;

      case 'error':
        showErrorOverlay(msg.error || 'Unable to open KiCad schematic');
        break;

      case 'captureSnapshot':
        captureEditorSnapshot(msg.name);
        break;

      case 'simStart':
        spinner.classList.remove('hidden');
        simBtn.textContent = 'Cancel';
        simBtn.dataset.running = 'true';
        break;

      case 'simulationResult':
        spinner.classList.add('hidden');
        simBtn.textContent = 'Simulate in LTspice';
        delete simBtn.dataset.running;

        if (msg.success && msg.current) {
          waveform.setPlotData(msg.current, msg.previous);
          if (msg.bannerText) showBannerText(msg.bannerText);
        } else if (msg.missingModels && msg.missingModels.length > 0) {
          showBannerText(`No SPICE model for: ${msg.missingModels.join(', ')}`);
        } else if (msg.error) {
          showBannerText(`Simulation error: ${msg.error}`);
        }
        break;

      case 'simError':
        spinner.classList.add('hidden');
        simBtn.textContent = 'Simulate in LTspice';
        delete simBtn.dataset.running;
        showBannerText(msg.error || 'Simulation failed');
        break;

      case 'ercResult':
        if (msg.report) {
          const errs = msg.report.errorCount;
          const warns = msg.report.warningCount;
          showBannerText(`ERC complete: ${errs} error(s), ${warns} warning(s)`);
        }
        break;
    }
  });

  simBtn.addEventListener('click', () => {
    if (simBtn.dataset.running === 'true') {
      vscode.postMessage({ type: 'cancelSimulation' });
    } else {
      vscode.postMessage({ type: 'runSimulation' });
    }
  });

  if (ercBtn) {
    ercBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'runErc' });
    });
  }

  document.getElementById('as-text').addEventListener('click', () => vscode.postMessage({ type: 'openAsText' }));
  vscode.postMessage({ type: 'ready' });
})();
