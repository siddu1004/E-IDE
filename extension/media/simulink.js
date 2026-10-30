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

  // Handle messages from host
  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'update':
        currentModel = msg.model;
        currentDiff = msg.changes;
        if (modelNameEl) {
          modelNameEl.textContent = msg.fileName || currentModel.name;
        }
        renderDiagram();
        renderParamTable();
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
        alert(msg.error);
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
