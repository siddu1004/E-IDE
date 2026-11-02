// In-IDE MATLAB Command Window webview logic.
(function () {
  const vscode = acquireVsCodeApi();

  const consoleEl = document.getElementById('console');
  const inputEl = document.getElementById('command-input');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  let history = [];
  let historyIndex = -1;
  let draft = '';

  function appendLine(text, kind) {
    if (!consoleEl) return;
    const div = document.createElement('div');
    div.className = 'line' + (kind ? ' ' + kind : '');
    div.textContent = text;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function submitCommand() {
    const raw = inputEl.value;
    const cmd = raw.trim();
    if (!cmd) return;

    if (cmd.toLowerCase() === 'clc') {
      consoleEl.innerHTML = '';
      inputEl.value = '';
      history.push(cmd);
      historyIndex = -1;
      draft = '';
      return;
    }

    appendLine('>> ' + raw, 'echo');
    if (history.length === 0 || history[history.length - 1] !== cmd) {
      history.push(cmd);
    }
    historyIndex = -1;
    draft = '';
    inputEl.value = '';

    vscode.postMessage({ type: 'eval', command: cmd });
  }

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      if (historyIndex === -1) {
        draft = inputEl.value;
        historyIndex = history.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      }
      inputEl.value = history[historyIndex];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      if (historyIndex < history.length - 1) {
        historyIndex++;
        inputEl.value = history[historyIndex];
      } else {
        historyIndex = -1;
        inputEl.value = draft;
      }
    }
  });

  document.querySelectorAll('.action-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (!action) return;
      if (action === 'clc') {
        consoleEl.innerHTML = '';
        inputEl.focus();
        return;
      }
      vscode.postMessage({ type: 'quickAction', action });
      inputEl.focus();
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'output':
        appendLine(msg.text, msg.kind);
        break;
      case 'clear':
        consoleEl.innerHTML = '';
        break;
      case 'status':
        if (statusDot && statusText) {
          statusDot.className = 'status-dot ' + msg.status;
          statusText.textContent = msg.status.charAt(0).toUpperCase() + msg.status.slice(1);
        }
        break;
    }
  });

  // Focus input on ready
  inputEl.focus();
  vscode.postMessage({ type: 'ready' });
})();
