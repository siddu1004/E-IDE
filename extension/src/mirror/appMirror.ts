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
  findAppExecutable,
  getMirrorApp,
  launchArgs,
  launchExecutable,
  matlabReloadCommand,
  matlabString,
  windowsShowingFile,
} from './mirrorApps';

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
    if (msg.type === 'frame') this.lastFrame = msg;
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

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

interface OpenMirror {
  app: MirrorApp;
  session: MirrorSession;
  panel?: vscode.WebviewPanel;
}

/** Set in activate() so the agent tools reach the same open mirrors as the tabs. */
export let activeAppMirror: AppMirrorController | undefined;
export function setAppMirror(c: AppMirrorController | undefined): void {
  activeAppMirror = c;
}

export type AppStatus = { id: string; label: string; installed: boolean; running: boolean; windows: string[] };

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

    let pids = appPids(app, await entry.session.listWindows());
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
      const before = new Set(pids);
      child_process.spawn(launchExecutable(app, exe, filePath), launchArgs(app, filePath), { detached: true, stdio: 'ignore' }).unref();
      pids = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${app.label}...` },
        async () => {
          const deadline = Date.now() + 120000; // MATLAB can take a minute to show its desktop
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            const now = appPids(app, await entry.session.listWindows());
            if (now.some((p) => !before.has(p))) return now;
          }
          return appPids(app, await entry.session.listWindows());
        }
      );
      if (pids.length === 0) {
        vscode.window.showErrorMessage(`E-IDE: ${app.label} started but no window appeared.`);
        return undefined;
      }
    }

    entry.session.send(`attach ${pids.join(',')}`);
    if (!mustLaunch && filePath && app.id === 'matlab') await this.runInMatlab(entry, `open(${matlabString(filePath)})`);
    return entry;
  }

  /** Runs a command in the user's MATLAB desktop by typing it into its Command Window. */
  private async runInMatlab(entry: OpenMirror, command: string): Promise<void> {
    const main = (await entry.session.listWindows()).find((w) => w.process.toLowerCase() === 'matlab' && /^MATLAB R\d/.test(w.title));
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
  async reload(appId: string, filePath: string): Promise<void> {
    const app = getMirrorApp(appId);
    if (!app) return;
    const entry = await this.attach(appId);
    if (!entry) return;
    if (app.id === 'matlab') {
      const command = matlabReloadCommand(filePath);
      if (command) await this.runInMatlab(entry, command);
      return this.show(appId);
    }
    const holding = windowsShowingFile(app, await entry.session.listWindows(), filePath);
    holding.forEach((w) => entry.session.send(`close ${w.hwnd}`));
    const deadline = Date.now() + 60000; // time to answer a save prompt
    while (holding.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const open = new Set((await entry.session.listWindows()).map((w) => w.hwnd));
      if (!holding.some((w) => open.has(w.hwnd))) break;
    }
    const still = new Set((await entry.session.listWindows()).map((w) => w.hwnd));
    if (holding.some((w) => still.has(w.hwnd))) return; // the user kept the window open
    await this.show(appId, filePath);
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
    entry.panel = panel;
    panel.webview.html = this.html(panel.webview, entry.app);

    const sub = entry.session.onMessage((msg) => {
      if (msg.type === 'frame' || msg.type === 'gone' || msg.type === 'error') panel.webview.postMessage(msg);
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

  async click(appId: string, x: number, y: number, button: number, double: boolean): Promise<MirrorFrame> {
    const { session } = await this.ensure(appId);
    const at = `${Math.round(x)} ${Math.round(y)} ${button}`;
    session.send(`mouse down ${at} 0`);
    session.send(`mouse up ${at} 0`);
    if (double) {
      session.send(`mouse dbl ${at} 0`);
      session.send(`mouse up ${at} 0`);
    }
    await new Promise((r) => setTimeout(r, 700));
    return session.snapshot();
  }

  async type(appId: string, text: string, pressEnter: boolean): Promise<MirrorFrame> {
    const { session } = await this.ensure(appId);
    for (const ch of text) session.send(`char ${ch.codePointAt(0)}`);
    if (pressEnter) {
      session.send('key down 13');
      session.send('key up 13');
    }
    await new Promise((r) => setTimeout(r, 700));
    return session.snapshot();
  }

  async status(): Promise<AppStatus[]> {
    const shared = this.open.values().next().value as OpenMirror | undefined;
    const probe = shared?.session ?? new MirrorSession(this.scriptPath);
    try {
      const windows = await probe.listWindows();
      return MIRROR_APPS.map((app) => {
        const pids = appPids(app, windows);
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

  private html(webview: vscode.Webview, app: MirrorApp): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'appMirror.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'appMirror.css'));
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
    <span class="app-name">${app.label}</span>
    <span id="window-title" class="window-title"></span>
    <span id="status" class="status">Connecting...</span>
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
