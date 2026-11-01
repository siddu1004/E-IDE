// Arduino Serial Monitor & Live Plotter Webview Client
(function () {
  const vscode = acquireVsCodeApi();

  // Elements
  const baudSelect = document.getElementById('baud-select');
  const btnToggleConnect = document.getElementById('btn-toggle-connect');
  const btnClear = document.getElementById('btn-clear');
  const chkAutoscroll = document.getElementById('chk-autoscroll');
  const chkTimestamps = document.getElementById('chk-timestamps');
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');

  const btnLayoutSplit = document.getElementById('tab-split');
  const btnLayoutMonitor = document.getElementById('tab-monitor');
  const btnLayoutPlotter = document.getElementById('tab-plotter');
  const mainView = document.getElementById('main-view');

  const monitorLog = document.getElementById('monitor-log');
  const serialInput = document.getElementById('serial-input');
  const lineEndingSelect = document.getElementById('line-ending-select');
  const btnSend = document.getElementById('btn-send');

  const plotterContainer = document.getElementById('plotter-container');

  // State
  let isConnected = false;
  let activePort = '';
  let activeBaud = 115200;

  // Live plotting state
  const MAX_POINTS = 300;
  const rollingSamples = {
    xData: [],
    series: {},
  };
  let sampleIndex = 0;
  let dirtyPlot = false;

  // Initialize Waveform Viewer if available
  let waveformViewer = null;
  if (window.createWaveformViewer && plotterContainer) {
    try {
      waveformViewer = window.createWaveformViewer(plotterContainer, {
        title: 'Live Serial Plotter',
      });
    } catch (e) {
      console.error('Failed to initialize waveform viewer:', e);
    }
  }

  // Layout switcher
  function setLayout(layout) {
    mainView.className = `arduino-main-view layout-${layout}`;
    [btnLayoutSplit, btnLayoutMonitor, btnLayoutPlotter].forEach((b) => b?.classList.remove('active'));
    if (layout === 'split') btnLayoutSplit?.classList.add('active');
    else if (layout === 'monitor') btnLayoutMonitor?.classList.add('active');
    else if (layout === 'plotter') btnLayoutPlotter?.classList.add('active');

    if (waveformViewer) {
      setTimeout(() => waveformViewer.draw(), 50);
    }
  }

  btnLayoutSplit?.addEventListener('click', () => setLayout('split'));
  btnLayoutMonitor?.addEventListener('click', () => setLayout('monitor'));
  btnLayoutPlotter?.addEventListener('click', () => setLayout('plotter'));

  // Baud rate change
  baudSelect?.addEventListener('change', () => {
    const baud = parseInt(baudSelect.value, 10);
    if (!isNaN(baud)) {
      activeBaud = baud;
      vscode.postMessage({ type: 'changeBaud', baud });
    }
  });

  // Toggle connection
  btnToggleConnect?.addEventListener('click', () => {
    if (isConnected) {
      vscode.postMessage({ type: 'stopMonitor' });
    } else {
      vscode.postMessage({
        type: 'startMonitor',
        port: activePort,
        baud: parseInt(baudSelect?.value || '115200', 10),
      });
    }
  });

  // Clear log & plot
  btnClear?.addEventListener('click', () => {
    if (monitorLog) monitorLog.innerHTML = '';
    rollingSamples.xData = [];
    rollingSamples.series = {};
    sampleIndex = 0;
    if (waveformViewer) {
      waveformViewer.setPlotData({
        plotName: 'Serial Plotter',
        xName: 'Sample',
        xData: [],
        series: {},
      });
    }
  });

  // Sending serial data
  function sendCurrentInput() {
    if (!serialInput) return;
    let text = serialInput.value;
    if (!text && text !== '') return;

    const ending = lineEndingSelect?.value || '\\n';
    if (ending === '\\n') text += '\n';
    else if (ending === '\\r') text += '\r';
    else if (ending === '\\r\\n') text += '\r\n';

    vscode.postMessage({ type: 'sendSerial', text });
    serialInput.value = '';
  }

  btnSend?.addEventListener('click', sendCurrentInput);
  serialInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendCurrentInput();
    }
  });

  // Append serial line to monitor
  function appendLine(line, timestamp) {
    if (!monitorLog) return;
    const lineEl = document.createElement('div');
    lineEl.className = 'log-line';

    if (chkTimestamps?.checked) {
      const timeEl = document.createElement('span');
      timeEl.className = 'timestamp';
      const d = new Date(timestamp || Date.now());
      timeEl.textContent = `[${d.toTimeString().split(' ')[0]}.${String(d.getMilliseconds()).padStart(3, '0')}] `;
      lineEl.appendChild(timeEl);
    }

    const contentEl = document.createElement('span');
    contentEl.className = 'content';
    contentEl.textContent = line;
    lineEl.appendChild(contentEl);

    monitorLog.appendChild(lineEl);

    // Limit log size to prevent memory bloat (keep last 1000 lines)
    if (monitorLog.children.length > 1000) {
      monitorLog.removeChild(monitorLog.firstChild);
    }

    if (chkAutoscroll?.checked) {
      monitorLog.scrollTop = monitorLog.scrollHeight;
    }
  }

  // Push numeric series to rolling plotter
  function pushPlotNumbers(numbers) {
    if (!numbers || !numbers.length) return;
    sampleIndex++;
    rollingSamples.xData.push(sampleIndex);
    if (rollingSamples.xData.length > MAX_POINTS) {
      rollingSamples.xData.shift();
    }

    numbers.forEach((val, idx) => {
      const name = `ch${idx + 1}`;
      if (!rollingSamples.series[name]) {
        rollingSamples.series[name] = [];
      }
      rollingSamples.series[name].push(val);
      if (rollingSamples.series[name].length > MAX_POINTS) {
        rollingSamples.series[name].shift();
      }
    });

    dirtyPlot = true;
  }

  // Animation frame loop for smooth 60fps plotting without UI lockup
  let lastPlotRender = 0;
  function plotLoop(timestamp) {
    if (dirtyPlot && timestamp - lastPlotRender > 33) {
      // ~30 fps update
      dirtyPlot = false;
      lastPlotRender = timestamp;
      if (waveformViewer) {
        waveformViewer.setPlotData({
          plotName: 'Serial Plotter',
          xName: 'Sample',
          xData: rollingSamples.xData,
          series: rollingSamples.series,
        });
      }
    }
    requestAnimationFrame(plotLoop);
  }
  requestAnimationFrame(plotLoop);

  // Handle messages from the extension host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.type) {
      case 'serialData':
        appendLine(msg.line, msg.timestamp);
        if (msg.numbers && msg.numbers.length > 0) {
          pushPlotNumbers(msg.numbers);
        }
        break;

      case 'status':
        isConnected = !!msg.connected;
        activePort = msg.port || activePort;
        if (msg.baud && baudSelect) {
          activeBaud = msg.baud;
          baudSelect.value = String(msg.baud);
        }

        if (statusPill && statusText) {
          statusPill.className = `status-pill ${isConnected ? 'connected' : 'disconnected'}`;
          statusText.textContent = isConnected
            ? `Connected (${activePort || 'Port'} @ ${activeBaud})`
            : `Disconnected (${activePort || 'No port'})`;
        }
        if (btnToggleConnect) {
          btnToggleConnect.textContent = isConnected ? 'Disconnect' : 'Connect';
        }
        break;

      case 'setPort':
        activePort = msg.port || '';
        if (statusText && !isConnected) {
          statusText.textContent = `Disconnected (${activePort || 'No port'})`;
        }
        break;

      case 'error':
        appendLine(`[Error] ${msg.message}`);
        break;
    }
  });

  // Notify extension we're ready
  vscode.postMessage({ type: 'ready' });
})();
