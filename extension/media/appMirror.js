// Live view of a desktop app inside an E-IDE tab: draws frames from the host and sends input back.
(function () {
  const vscode = acquireVsCodeApi();
  const header = document.querySelector('header');
  const stage = document.getElementById('stage');
  const screen = document.getElementById('screen');
  const statusEl = document.getElementById('status');
  const titleEl = document.getElementById('window-title');
  const fitToggle = document.getElementById('fit-toggle');

  // Ensure header has icon, Reload, and Pop out buttons even if host HTML was from an older session
  if (header && !document.getElementById('reload-btn')) {
    const appNameEl = header.querySelector('.app-name');
    const appLabel = (appNameEl && appNameEl.textContent) || '';
    if (!header.querySelector('.app-icon') && appNameEl) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'app-icon';
      iconSpan.setAttribute('aria-hidden', 'true');
      if (/MATLAB/i.test(appLabel)) {
        iconSpan.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 13.5V2.5M1.5 13.5H14.5"/><path d="M3 11L6.5 5.5L9.5 9.5L13.5 3.5"/></svg>';
      } else if (/KiCad/i.test(appLabel)) {
        iconSpan.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><circle cx="5.5" cy="5.5" r="1.2"/><circle cx="10.5" cy="10.5" r="1.2"/><path d="M6.5 5.5H9L10.5 7V9.3"/></svg>';
      } else if (/LTspice/i.test(appLabel)) {
        iconSpan.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8H4.5L6.5 3L9.5 13L11.5 8H14.5"/></svg>';
      } else {
        iconSpan.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1.5V4M10 1.5V4M6 12V14.5M10 12V14.5M1.5 6H4M1.5 10H4M12 6H14.5M12 10H14.5"/></svg>';
      }
      header.insertBefore(iconSpan, appNameEl);
    }
    const toggleLabel = header.querySelector('.toggle');
    const rBtn = document.createElement('button');
    rBtn.type = 'button';
    rBtn.id = 'reload-btn';
    rBtn.className = 'header-btn';
    rBtn.title = 'Reload file or refresh in ' + appLabel;
    rBtn.textContent = '↻ Reload';
    const pBtn = document.createElement('button');
    pBtn.type = 'button';
    pBtn.id = 'popout-btn';
    pBtn.className = 'header-btn';
    pBtn.title = 'Restore and bring ' + appLabel + ' to the foreground';
    pBtn.textContent = '↗ Pop out to real window';
    header.insertBefore(rBtn, toggleLabel);
    header.insertBefore(pBtn, toggleLabel);
    if (statusEl && statusEl.textContent === 'Connecting...') {
      statusEl.textContent = 'Starting ' + appLabel + '…';
    }
  }

  const reloadBtn = document.getElementById('reload-btn');
  const popoutBtn = document.getElementById('popout-btn');

  const saved = vscode.getState() || {};
  fitToggle.checked = !!saved.fit;

  let frames = 0;
  let lastMove = 0;
  let buttonsDown = -1;

  // Frame pixels under the pointer; the image is scaled to fit the tab.
  function toFrame(e) {
    const r = screen.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = ((e.clientX - r.left) / r.width) * screen.naturalWidth;
    const y = ((e.clientY - r.top) / r.height) * screen.naturalHeight;
    if (x < 0 || y < 0 || x >= screen.naturalWidth || y >= screen.naturalHeight) return null;
    return { x, y };
  }

  function sendMouse(kind, e, extra) {
    const p = toFrame(e);
    if (!p) return;
    vscode.postMessage(Object.assign({ type: 'mouse', kind, x: p.x, y: p.y, button: e.button }, extra));
  }

  screen.addEventListener('mousedown', (e) => {
    e.preventDefault();
    stage.focus();
    buttonsDown = e.button;
    sendMouse('down', e);
  });
  window.addEventListener('mouseup', (e) => {
    if (buttonsDown < 0) return;
    buttonsDown = -1;
    sendMouse('up', e);
  });
  screen.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 33) return; // about 30 moves a second is enough for hover and drags
    lastMove = now;
    const p = toFrame(e);
    if (p) vscode.postMessage({ type: 'mouse', kind: 'move', x: p.x, y: p.y, button: buttonsDown });
  });
  screen.addEventListener('dblclick', (e) => sendMouse('dbl', e));
  screen.addEventListener('contextmenu', (e) => e.preventDefault());
  screen.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      sendMouse('wheel', e, { delta: e.deltaY > 0 ? -120 : 120 });
    },
    { passive: false }
  );

  // Shortcuts that still belong to the IDE, so the tab can be left with the keyboard.
  function forIde(e) {
    return (
      (e.ctrlKey && (e.key === 'Tab' || e.key === 'PageUp' || e.key === 'PageDown')) ||
      (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') ||
      e.key === 'F1'
    );
  }
  // Everything else goes to the app: stopping propagation keeps VS Code from also acting on Ctrl+S, Ctrl+Z, Ctrl+W, ...
  function sendKey(e, down) {
    if (forIde(e)) return;
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'key', down, vk: e.keyCode });
  }
  stage.addEventListener('keydown', (e) => sendKey(e, true));
  stage.addEventListener('keyup', (e) => sendKey(e, false));
  // A key still held when focus leaves would stay pressed in the app.
  stage.addEventListener('blur', () => vscode.postMessage({ type: 'release' }));
  window.addEventListener('blur', () => vscode.postMessage({ type: 'release' }));

  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'reload' });
      vscode.postMessage({ type: 'ready' });
    });
  }
  if (popoutBtn) {
    popoutBtn.addEventListener('click', () => vscode.postMessage({ type: 'popout' }));
  }

  // Window sizes are physical pixels, so scale the tab size by the display's pixel ratio.
  let fitTimer = 0;
  function fitWindow() {
    if (!fitToggle.checked) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const ratio = window.devicePixelRatio || 1;
      vscode.postMessage({
        type: 'fit',
        width: Math.round(stage.clientWidth * ratio),
        height: Math.round(stage.clientHeight * ratio),
      });
    }, 400);
  }
  fitToggle.addEventListener('change', () => {
    vscode.setState(Object.assign({}, vscode.getState(), { fit: fitToggle.checked }));
    fitWindow();
  });
  new ResizeObserver(fitWindow).observe(stage);

  setInterval(() => {
    if (stage.classList.contains('gone')) return;
    if (frames) statusEl.textContent = `Live · ${frames} fps`;
    else if (screen.src) statusEl.textContent = 'Live · 12 fps';
    frames = 0;
  }, 1000);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'frame':
        screen.src = 'data:image/jpeg;base64,' + msg.jpeg;
        titleEl.textContent = msg.title || '';
        stage.classList.remove('gone');
        frames++;
        if (statusEl.textContent.startsWith('Starting') || statusEl.textContent.startsWith('Connecting') || statusEl.textContent.includes('closed or minimized')) {
          statusEl.textContent = 'Live · 12 fps';
        }
        break;
      case 'gone':
        statusEl.textContent = msg.minimized
          ? 'Minimized (App closed or minimized)'
          : 'App closed or minimized';
        stage.classList.add('gone');
        break;
      case 'status':
        statusEl.textContent = msg.text;
        break;
      case 'error':
        statusEl.textContent = 'Error: ' + msg.message;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
