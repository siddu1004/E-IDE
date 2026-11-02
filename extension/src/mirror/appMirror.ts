// Shows a desktop EEE app (MATLAB, KiCad, LTspice, Arduino IDE) live inside an editor tab.
// mirror/WinMirror.cs captures the app's windows and posts mouse and keyboard input back to them,
// so the real app keeps running while the engineer works with it from inside the IDE.

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AppWindow,
  MirrorApp,
  MIRROR_APPS,
  appForFile,
  appPids,
  cleanLaunchEnv,
  findAppExecutable,
  getMirrorApp,
  isProtectedUserWindow,
  launchArgs,
  launchExecutable,
  matlabReloadCommand,
  matlabString,
  windowsShowingFile,
} from './mirrorApps';
import { formatMirrorHeaderStatus } from './mirrorStatus';

export interface MirrorFrame {
  width: number;
  height: number;
  title: string;
  jpeg: string;
}

/** One WinMirror helper process, attached to one app's windows. */
export class MirrorSession {
  private child: child_process.ChildProcess | undefined;
  private buffer = '';
  private waiters: Array<{ type: string; resolve: (msg: any) => void }> = [];
  private listeners = new Set<(msg: any) => void>();
  public lastFrame: MirrorFrame | undefined;
  public lastGoneMinimized: boolean | undefined;

  constructor(private readonly scriptPath: string) {}

  start(): void {
    if (this.child) return;
    const child = child_process.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
      this.emit({ type: 'exit' });
    });
  }

  getPid(): number | undefined {
    return this.child?.pid;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        this.emit(JSON.parse(line));
      } catch {
        // A partial or malformed line from the helper is skipped; the next frame replaces it.
      }
    }
  }

  private emit(msg: any): void {
    if (msg.type === 'frame') {
      this.lastFrame = msg;
      this.lastGoneMinimized = undefined;
    } else if (msg.type === 'gone') {
      this.lastGoneMinimized = !!msg.minimized;
    }
    const ready = this.waiters.filter((w) => w.type === msg.type);
    this.waiters = this.waiters.filter((w) => w.type !== msg.type);
    ready.forEach((w) => w.resolve(msg));
    this.listeners.forEach((l) => l(msg));
  }

  onMessage(listener: (msg: any) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  send(command: string): void {
    this.start();
    this.child?.stdin?.write(command + '\n');
  }

  private waitFor(type: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        if (!this.waiters.includes(waiter)) return;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`The window helper did not answer (${type}) within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
    });
  }

  async listWindows(): Promise<AppWindow[]> {
    const reply = this.waitFor('windows', 20000); // the first call compiles the helper, which takes a few seconds
    this.send('list');
    return (await reply).items as AppWindow[];
  }

  /** The next frame, rendered fresh even if the app did not change. */
  async snapshot(): Promise<MirrorFrame> {
    const reply = this.waitFor('frame', 10000);
    this.send('snap');
    return reply;
  }

  /** Captures a specific window by HWND (e.g., the IDE window itself). */
  async captureWindow(hwnd: number): Promise<MirrorFrame> {
    const reply = this.waitFor('shot', 10000);
    this.send(`shot ${hwnd}`);
    return reply;
  }

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

interface OpenMirror {
  app: MirrorApp;
  session: MirrorSession;
  panel?: vscode.WebviewPanel;
  pids?: number[];
  filePath?: string;
}

/** Set in activate() so the agent tools reach the same open mirrors as the tabs. */
export let activeAppMirror: AppMirrorController | undefined;
export function setAppMirror(c: AppMirrorController | undefined): void {
  activeAppMirror = c;
}

export type AppStatus = {
  id: string;
  label: string;
  installed: boolean;
  running: boolean;
  windows: string[];
};

const KEY_NAME_TO_VK: Record<string, number> = {
  enter: 13,
  return: 13,
  esc: 27,
  escape: 27,
  tab: 9,
  space: 32,
  backspace: 8,
  delete: 46,
  up: 38,
  down: 40,
  left: 37,
  right: 39,
  f1: 112,
  f2: 113,
  f3: 114,
  f4: 115,
  f5: 116,
  f6: 117,
  f7: 118,
  f8: 119,
  f9: 120,
  f10: 121,
  f11: 122,
  f12: 123,
};

export class AppMirrorController implements vscode.Disposable {
  private readonly open = new Map<string, OpenMirror>();
  private readonly scriptPath: string;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.scriptPath = path.join(context.extensionPath, 'mirror', 'winmirror.ps1');
    this.disposables.push(
      vscode.commands.registerCommand('eide.apps.open', async (appId?: string) => {
        const id = appId ?? (await this.pickApp());
        if (id) await this.show(id);
      }),
      vscode.commands.registerCommand('eide.apps.openFile', async (uri?: vscode.Uri) => {
        const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        const app = file ? appForFile(file) : undefined;
        if (!file || !app) {
          vscode.window.showWarningMessage('E-IDE: No desktop app is known for this file type.');
          return;
        }
        await this.show(app.id, file);
      }),
      vscode.commands.registerCommand('eide.apps.focusWindow', async (appId?: string, windowTitle?: string) => {
        if (!appId) return;
        await this.focusWindow(appId, windowTitle);
      }),
      vscode.commands.registerCommand('eide.apps.popOut', async (appId?: string) => {
        if (!appId) return;
        await this.popOut(appId);
      })
    );
  }

  private async pickApp(): Promise<string | undefined> {
    const pick = await vscode.window.showQuickPick(
      MIRROR_APPS.map((a) => ({
        label: a.label,
        description: findAppExecutable(a, this.customPath(a)) ? '' : 'not installed',
        id: a.id,
      })),
      { placeHolder: 'Open which app inside E-IDE?' }
    );
    return pick?.id;
  }

  private customPath(app: MirrorApp): string | undefined {
    return vscode.workspace.getConfiguration('eide.apps').get<string>(`${app.id}Path`) || undefined;
  }

  private session(app: MirrorApp): OpenMirror {
    let entry = this.open.get(app.id);
    if (!entry) {
      entry = { app, session: new MirrorSession(this.scriptPath) };
      this.open.set(app.id, entry);
    }
    return entry;
  }

  /**
   * Attaches to the app's windows, starting the app if needed. Returns undefined when it is not
   * installed (the user is offered the download page) or did not open a window in time.
   */
  async attach(appId: string, filePath?: string): Promise<OpenMirror | undefined> {
    if (process.platform !== 'win32') {
      vscode.window.showWarningMessage('E-IDE: Showing desktop apps inside the IDE currently works on Windows only.');
      return undefined;
    }
    const app = getMirrorApp(appId);
    if (!app) throw new Error(`Unknown app '${appId}'. Known apps: ${MIRROR_APPS.map((a) => a.id).join(', ')}`);
    const entry = this.session(app);
    if (filePath) entry.filePath = filePath;

    let pids = appPids(app, await entry.session.listWindows(), false);
    // A file opens in a fresh instance, except in MATLAB, which is too heavy to start twice.
    const mustLaunch = pids.length === 0 || (filePath !== undefined && app.id !== 'matlab');

    if (mustLaunch) {
      const exe = findAppExecutable(app, this.customPath(app));
      if (!exe) {
        if (!entry.panel) {
          this.open.delete(app.id);
          entry.session.dispose();
        }
        const choice = await vscode.window.showWarningMessage(
          `${app.label} is not installed. Please install it to use it inside E-IDE.`,
          'Install',
          'Set Path'
        );
        if (choice === 'Install') vscode.env.openExternal(vscode.Uri.parse(app.installUrl));
        if (choice === 'Set Path') vscode.commands.executeCommand('workbench.action.openSettings', `eide.apps.${app.id}Path`);
        return undefined;
      }
      entry.panel?.webview.postMessage({
        type: 'status',
        text: formatMirrorHeaderStatus('starting', 0, app.label),
      });
      const before = new Set(pids);
      child_process.spawn(launchExecutable(app, exe, filePath), launchArgs(app, filePath), {
        detached: true,
        stdio: 'ignore',
        env: cleanLaunchEnv(),
      }).unref();
      pids = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${app.label}...` },
        async () => {
          const deadline = Date.now() + 120000; // MATLAB can take a minute to show its desktop
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            const now = appPids(app, await entry.session.listWindows(), false);
            const spawned = now.filter((p) => !before.has(p));
            if (spawned.length > 0) return spawned;
          }
          return appPids(app, await entry.session.listWindows(), false);
        }
      );
      if (pids.length === 0) {
        vscode.window.showErrorMessage(`E-IDE: ${app.label} started but no window appeared.`);
        return undefined;
      }
    }

    entry.pids = pids;
    entry.session.send(`attach ${pids.join(',')}`);
    if (!mustLaunch && filePath && app.id === 'matlab') {
      const openCmd = /\.m$/i.test(filePath)
        ? `edit(${matlabString(filePath)})`
        : `open(${matlabString(filePath)})`;
      await this.runInMatlab(entry, openCmd);
    }
    return entry;
  }

  /** Runs a command in the E-IDE MATLAB desktop by typing it into its Command Window (never touches protected user sessions). */
  public async runInMatlab(entry: OpenMirror, command: string): Promise<void> {
    const wins = await entry.session.listWindows();
    const main = wins.find(
      (w) =>
        w.process.toLowerCase() === 'matlab' &&
        /^MATLAB R\d/.test(w.title) &&
        !isProtectedUserWindow(w.title) &&
        (!entry.pids?.length || entry.pids.includes(w.pid))
    );
    if (!main) throw new Error('The MATLAB desktop window was not found.');
    const s = entry.session;
    s.send(`focus ${main.hwnd}`);
    ['key down 17', 'key down 48', 'key up 48', 'key up 17'].forEach((k) => s.send(k)); // Ctrl+0 selects the Command Window
    await new Promise((r) => setTimeout(r, 500));
    for (const ch of command) s.send(`char ${ch.codePointAt(0)}`);
    s.send('key down 13');
    s.send('key up 13');
  }

  /**
   * Shows the file as it is now on disk. MATLAB reopens the model; other apps close the window
   * holding the file (they ask about unsaved work in the tab first) and open it again.
   */
  async reload(appId: string, filePath?: string): Promise<void> {
    const app = getMirrorApp(appId);
    if (!app) return;
    const entry = await this.attach(appId);
    if (!entry) return;
    const targetFile = filePath ?? entry.filePath;
    if (!targetFile) {
      entry.session.send('snap');
      return;
    }
    if (app.id === 'matlab') {
      const command = matlabReloadCommand(targetFile);
      if (command) await this.runInMatlab(entry, command);
      return this.show(appId);
    }
    const allWins = await entry.session.listWindows();
    let holding = windowsShowingFile(app, allWins, targetFile);
    if (holding.length === 0 && entry.pids?.length) {
      holding = allWins.filter((w) => entry.pids!.includes(w.pid));
    }
    holding.forEach((w) => entry.session.send(`close ${w.hwnd}`));
    const deadline = Date.now() + 60000; // time to answer a save prompt
    while (holding.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const open = new Set((await entry.session.listWindows()).map((w) => w.hwnd));
      if (!holding.some((w) => open.has(w.hwnd))) break;
    }
    const still = new Set((await entry.session.listWindows()).map((w) => w.hwnd));
    if (holding.some((w) => still.has(w.hwnd))) return; // the user kept the window open
    await this.show(appId, targetFile);
  }

  async show(appId: string, filePath?: string): Promise<void> {
    const entry = await this.attach(appId, filePath);
    if (!entry) return;
    if (entry.panel) {
      entry.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('eide.appMirror', entry.app.label, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    panel.iconPath = new vscode.ThemeIcon(entry.app.icon);
    entry.panel = panel;
    panel.webview.html = this.html(panel.webview, entry.app);

    const sub = entry.session.onMessage((msg) => {
      if (msg.type === 'frame' || msg.type === 'gone' || msg.type === 'error' || msg.type === 'status') {
        panel.webview.postMessage(msg);
      }
    });
    panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'mouse':
          entry.session.send(`mouse ${msg.kind} ${Math.round(msg.x)} ${Math.round(msg.y)} ${msg.button | 0} ${msg.delta | 0}`);
          break;
        case 'key':
          entry.session.send(`key ${msg.down ? 'down' : 'up'} ${msg.vk | 0}`);
          break;
        case 'release':
          entry.session.send('release');
          break;
        case 'fit':
          entry.session.send(`fit ${msg.width | 0} ${msg.height | 0}`);
          break;
        case 'ready':
          entry.session.send('snap');
          break;
        case 'reload':
          this.reload(entry.app.id, entry.filePath);
          break;
        case 'popout':
          entry.session.send('popout');
          break;
        case 'restart':
          this.attach(entry.app.id);
          break;
      }
    });
    panel.onDidDispose(() => {
      sub.dispose();
      entry.session.dispose();
      this.open.delete(entry.app.id);
    });
  }

  private async ensure(appId: string): Promise<OpenMirror> {
    const entry = this.open.get(appId) ?? (await this.attach(appId));
    if (!entry) throw new Error(`${appId} is not installed or did not start.`);
    if (!entry.session.lastFrame) await entry.session.snapshot(); // the helper needs a layout to map x, y
    return entry;
  }

  /** A current picture of the app, for the agent. */
  async capture(appId: string): Promise<MirrorFrame> {
    return (await this.ensure(appId)).session.snapshot();
  }

  async click(appId: string, x: number, y: number, button: number, double: boolean, wheelDelta = 0): Promise<MirrorFrame> {
    const { session } = await this.ensure(appId);
    const at = `${Math.round(x)} ${Math.round(y)} ${button}`;
    if (wheelDelta !== 0) {
      session.send(`mouse wheel ${at} ${wheelDelta | 0}`);
    } else {
      session.send(`mouse down ${at} 0`);
      session.send(`mouse up ${at} 0`);
      if (double) {
        session.send(`mouse dbl ${at} 0`);
      }
    }
    await new Promise((r) => setTimeout(r, 700));
    return session.snapshot();
  }

  async type(appId: string, text: string, pressEnter: boolean, key?: string): Promise<MirrorFrame> {
    const { session } = await this.ensure(appId);
    if (text) {
      for (const ch of text) session.send(`char ${ch.codePointAt(0)}`);
    }
    if (key) {
      this.sendKeyCombo(session, key);
    }
    if (pressEnter) {
      session.send('key down 13');
      session.send('key up 13');
    }
    await new Promise((r) => setTimeout(r, 700));
    return session.snapshot();
  }

  private sendKeyCombo(session: MirrorSession, combo: string): void {
    const parts = combo.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
    const mods: number[] = [];
    let mainVk = 0;
    for (const p of parts) {
      if (p === 'ctrl' || p === 'control') mods.push(17);
      else if (p === 'shift') mods.push(16);
      else if (p === 'alt') mods.push(18);
      else if (KEY_NAME_TO_VK[p]) mainVk = KEY_NAME_TO_VK[p];
      else if (p.length === 1) mainVk = p.toUpperCase().charCodeAt(0);
    }
    for (const m of mods) session.send(`key down ${m}`);
    if (mainVk) {
      session.send(`key down ${mainVk}`);
      session.send(`key up ${mainVk}`);
    }
    for (let i = mods.length - 1; i >= 0; i--) session.send(`key up ${mods[i]}`);
  }

  /** Focuses a specific window of an app by title or HWND and reveals the tab. */
  async focusWindow(appId: string, hwndOrTitle?: number | string): Promise<MirrorFrame | undefined> {
    await this.show(appId);
    const entry = this.open.get(appId);
    if (!entry) return undefined;
    const wins = (await entry.session.listWindows()).filter((w) => !isProtectedUserWindow(w.title));
    const match = wins.find((w) =>
      typeof hwndOrTitle === 'number'
        ? w.hwnd === hwndOrTitle
        : hwndOrTitle
          ? w.title === hwndOrTitle || w.title.toLowerCase().includes(String(hwndOrTitle).toLowerCase())
          : true
    );
    if (match) {
      entry.session.send(`focus ${match.hwnd}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    return entry.session.snapshot();
  }

  async popOut(appId: string): Promise<void> {
    const entry = this.open.get(appId);
    if (entry) entry.session.send('popout');
  }

  async fit(appId: string, width: number, height: number): Promise<MirrorFrame> {
    const { session } = await this.ensure(appId);
    session.send(`fit ${width | 0} ${height | 0}`);
    await new Promise((r) => setTimeout(r, 600));
    return session.snapshot();
  }

  async minimize(appId: string, restore = false): Promise<{ minimized: boolean; statusText: string }> {
    const entry = await this.ensure(appId);
    entry.session.send(`minimize ${restore ? 'restore' : 'min'}`);
    await new Promise((r) => setTimeout(r, 900));
    if (restore) {
      await entry.session.snapshot();
      return { minimized: false, statusText: formatMirrorHeaderStatus('live', 12, entry.app.label) };
    }
    return {
      minimized: true,
      statusText: formatMirrorHeaderStatus(
        entry.session.lastGoneMinimized ? 'minimized' : 'gone',
        0,
        entry.app.label
      ),
    };
  }

  async closeTab(appId: string): Promise<{ closed: boolean; previousHelperPid?: number }> {
    const entry = this.open.get(appId);
    const pid = entry?.session.getPid();
    if (entry?.panel) {
      entry.panel.dispose();
    } else if (entry) {
      entry.session.dispose();
      this.open.delete(appId);
    }
    return { closed: true, previousHelperPid: pid };
  }

  getHelperInfo(appId: string): { helperPid?: number; attachedPids?: number[]; filePath?: string; lastGoneMinimized?: boolean } {
    const entry = this.open.get(appId);
    return {
      helperPid: entry?.session.getPid(),
      attachedPids: entry?.pids,
      filePath: entry?.filePath,
      lastGoneMinimized: entry?.session.lastGoneMinimized,
    };
  }

  async captureIdeWindow(): Promise<MirrorFrame> {
    const shared = this.open.values().next().value as OpenMirror | undefined;
    const probe = shared?.session ?? new MirrorSession(this.scriptPath);
    try {
      const wins = await probe.listWindows();
      const ideWin =
        wins.find((w) => /Antigravity/i.test(w.process) && /E-IDE/i.test(w.title)) ??
        wins.find((w) => /Antigravity|Code/i.test(w.process));
      if (!ideWin) throw new Error('Antigravity IDE window was not found on the desktop.');
      return await probe.captureWindow(ideWin.hwnd);
    } finally {
      if (!shared) probe.dispose();
    }
  }

  async status(): Promise<AppStatus[]> {
    const shared = this.open.values().next().value as OpenMirror | undefined;
    const probe = shared?.session ?? new MirrorSession(this.scriptPath);
    try {
      const windows = await probe.listWindows();
      return MIRROR_APPS.map((app) => {
        const pids = appPids(app, windows, true);
        return {
          id: app.id,
          label: app.label,
          installed: !!findAppExecutable(app, this.customPath(app)),
          running: pids.length > 0,
          windows: windows.filter((w) => pids.includes(w.pid)).map((w) => w.title),
        };
      });
    } finally {
      if (!shared) probe.dispose();
    }
  }

  private appIconSvg(app: MirrorApp): string {
    switch (app.id) {
      case 'matlab':
        return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 13.5V2.5M1.5 13.5H14.5"/><path d="M3 11L6.5 5.5L9.5 9.5L13.5 3.5"/></svg>';
      case 'kicad':
        return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><circle cx="5.5" cy="5.5" r="1.2"/><circle cx="10.5" cy="10.5" r="1.2"/><path d="M6.5 5.5H9L10.5 7V9.3"/></svg>';
      case 'ltspice':
        return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8H4.5L6.5 3L9.5 13L11.5 8H14.5"/></svg>';
      case 'arduino':
      default:
        return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1.5V4M10 1.5V4M6 12V14.5M10 12V14.5M1.5 6H4M1.5 10H4M12 6H14.5M12 10H14.5"/></svg>';
    }
  }

  private html(webview: vscode.Webview, app: MirrorApp): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'appMirror.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'appMirror.css'));
    const initialStatus = formatMirrorHeaderStatus('starting', 0, app.label);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>${app.label}</title>
</head>
<body>
  <header>
    <span class="app-icon" aria-hidden="true">${this.appIconSvg(app)}</span>
    <span class="app-name">${app.label}</span>
    <span id="window-title" class="window-title"></span>
    <span id="status" class="status">${initialStatus}</span>
    <button type="button" id="reload-btn" class="header-btn" title="Reload file or refresh in ${app.label}">↻ Reload</button>
    <button type="button" id="popout-btn" class="header-btn" title="Restore and bring ${app.label} to the foreground">↗ Pop out to real window</button>
    <label class="toggle"><input type="checkbox" id="fit-toggle"> Fit window to tab</label>
  </header>
  <main id="stage" tabindex="0"><img id="screen" alt="${app.label} window" draggable="false"></main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.open.forEach((e) => {
      e.panel?.dispose();
      e.session.dispose();
    });
    this.open.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
