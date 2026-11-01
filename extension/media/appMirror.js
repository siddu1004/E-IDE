// Live view of a desktop app inside an E-IDE tab: draws frames from the host and sends input back.
(function () {
  const vscode = acquireVsCodeApi();
  const stage = document.getElementById('stage');
  const screen = document.getElementById('screen');
  const statusEl = document.getElementById('status');
  const titleEl = document.getElementById('window-title');
  const fitToggle = document.getElementById('fit-toggle');

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
    return (e.ctrlKey && (e.key === 'Tab' || e.key === 'PageUp' || e.key === 'PageDown')) || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') || e.key === 'F1';
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

  // Window sizes are physical pixels, so scale the tab size by the display's pixel ratio.
  let fitTimer = 0;
  function fitWindow() {
    if (!fitToggle.checked) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const ratio = window.devicePixelRatio || 1;
      vscode.postMessage({ type: 'fit', width: Math.round(stage.clientWidth * ratio), height: Math.round(stage.clientHeight * ratio) });
    }, 400);
  }
  fitToggle.addEventListener('change', () => {
    vscode.setState(Object.assign({}, vscode.getState(), { fit: fitToggle.checked }));
    fitWindow();
  });
  new ResizeObserver(fitWindow).observe(stage);

  setInterval(() => {
    if (frames) statusEl.textContent = `Live · ${frames} fps`;
    else if (screen.src) statusEl.textContent = 'Live';
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
        break;
      case 'gone':
        statusEl.textContent = 'App closed or minimized';
        stage.classList.add('gone');
        break;
      case 'error':
        statusEl.textContent = 'Error: ' + msg.message;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
