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

  function renderDiagram() {
    const system = getActiveSystem();
    if (!system) return;

    viewportGroup.innerHTML = '';

    const blockMap = new Map();
    for (const b of system.blocks) {
      blockMap.set(b.sid, b);
    }

    // 1. Draw Lines
    const linesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    linesGroup.setAttribute('class', 'lines-group');

    for (const line of system.lines) {
      if (!line.src || !line.dst) continue;
      const srcBlock = blockMap.get(line.src.sid);
      const dstBlock = blockMap.get(line.dst.sid);
      if (!srcBlock || !dstBlock) continue;

      // Source port coordinate (right edge of src block)
      const srcX = srcBlock.position.right;
      const srcY = (srcBlock.position.top + srcBlock.position.bottom) / 2;

      // Destination port coordinate (left edge of dst block)
      const dstX = dstBlock.position.left;
      const dstY = (dstBlock.position.top + dstBlock.position.bottom) / 2;

      // Orthogonal routing path
      const midX = (srcX + dstX) / 2;
      const pathD = `M ${srcX} ${srcY} L ${midX} ${srcY} L ${midX} ${dstY} L ${dstX} ${dstY}`;

      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', pathD);
      let cls = 'slx-line';
      if (line.logged) cls += ' logged';
      pathEl.setAttribute('class', cls);

      // Line click handler
      pathEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (line.logged) {
          vscode.postMessage({
            type: 'plotSignal',
            name: line.name || srcBlock.name,
          });
        } else {
          const enable = confirm(`Signal from '${srcBlock.name}' is not logged. Enable logging on this signal?`);
          if (enable) {
            vscode.postMessage({
              type: 'enableLogging',
              line: {
                srcBlock: srcBlock.name,
                srcPort: line.src.portNumber,
              },
            });
          }
        }
      });

      linesGroup.appendChild(pathEl);
    }
    viewportGroup.appendChild(linesGroup);

    // 2. Draw Blocks
    const blocksGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    blocksGroup.setAttribute('class', 'blocks-group');

    for (const block of system.blocks) {
      const bGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      let bClass = 'slx-block';

      if (currentDiff) {
        if (currentDiff.changedBlockSids && currentDiff.changedBlockSids.includes(block.sid)) {
          bClass += ' diff-changed';
        } else if (currentDiff.addedBlockSids && currentDiff.addedBlockSids.includes(block.sid)) {
          bClass += ' diff-added';
        }
      }

      if (selectedBlock && selectedBlock.sid === block.sid) {
        bClass += ' selected';
      }
      bGroup.setAttribute('class', bClass);

      const width = Math.max(30, block.position.right - block.position.left);
      const height = Math.max(20, block.position.bottom - block.position.top);

      // Block rectangle
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', block.position.left);
      rect.setAttribute('y', block.position.top);
      rect.setAttribute('width', width);
      rect.setAttribute('height', height);
      bGroup.appendChild(rect);

      // Block Name
      const nameText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      nameText.setAttribute('x', block.position.left + width / 2);
      nameText.setAttribute('y', block.position.top + height / 2);
      nameText.setAttribute('class', 'block-name');
      nameText.textContent = block.name;
      bGroup.appendChild(nameText);

      // Block Type label below
      const typeText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      typeText.setAttribute('x', block.position.left + width / 2);
      typeText.setAttribute('y', block.position.bottom + 12);
      typeText.setAttribute('class', 'block-type');
      typeText.textContent = block.type;
      bGroup.appendChild(typeText);

      // Block Click: select & highlight in parameter table
      bGroup.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedBlock = block;
        renderDiagram();
        renderParamTable();
      });

      // Subsystem drill-down on double click
      if (block.type === 'SubSystem' && currentModel.subsystems[block.name]) {
        bGroup.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          currentSystemName = block.name;
          selectedBlock = null;
          renderDiagram();
          renderParamTable();
        });
      }

      blocksGroup.appendChild(bGroup);
    }
    viewportGroup.appendChild(blocksGroup);
  }

  function renderParamTable() {
    asideContent.innerHTML = '';

    const system = getActiveSystem();
    if (!system) return;

    // Subsystem breadcrumb if inside subsystem
    if (currentSystemName !== 'root') {
      const bc = document.createElement('div');
      bc.style.marginBottom = '8px';
      bc.innerHTML = `<a href="#" id="back-to-root" style="color:var(--vscode-textLink-foreground); font-size:11px;">← Back to Root Model</a>`;
      asideContent.appendChild(bc);
      document.getElementById('back-to-root').addEventListener('click', (e) => {
        e.preventDefault();
        currentSystemName = 'root';
        renderDiagram();
        renderParamTable();
      });
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
