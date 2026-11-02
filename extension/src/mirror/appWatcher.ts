// File system watcher for files opened inside mirrored desktop apps.
// Detects when the AI agent modifies a mirrored file and prompts the user to reload in the app.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentHistoryManager } from '../agent/agentHistory';
import { AppMirrorController } from './appMirror';
import { appForFile, getMirrorApp, MirrorApp } from './mirrorApps';
import { formatReloadPrompt } from './mirrorStatus';

export class AppFileWatcher implements vscode.Disposable {
  private static instance?: AppFileWatcher;

  private watchedFiles = new Map<
    string,
    {
      filePath: string;
      app: MirrorApp;
      watcher: vscode.FileSystemWatcher;
      fsWatcher?: fs.FSWatcher;
    }
  >();
  private lastPromptTime = new Map<string, number>();
  private pendingReload?: { appId: string; filePath: string; prompt: string };
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly appMirror: AppMirrorController
  ) {
    AppFileWatcher.instance = this;

    // Wrap appMirror.show to intercept files opened in mirrored apps
    const originalShow = appMirror.show.bind(appMirror);
    appMirror.show = async (appId: string, filePath?: string) => {
      if (filePath) {
        this.watch(filePath, appId);
      }
      return originalShow(appId, filePath);
    };

    this.disposables.push(
      vscode.commands.registerCommand('eide.apps.confirmReload', async () => {
        if (!this.pendingReload) return false;
        const { appId, filePath } = this.pendingReload;
        this.pendingReload = undefined;
        await this.appMirror.reload(appId, filePath);
        return true;
      })
    );
  }

  public static getInstance(): AppFileWatcher | undefined {
    return AppFileWatcher.instance;
  }

  public getPendingReload(): { appId: string; filePath: string; prompt: string } | undefined {
    return this.pendingReload;
  }

  /**
   * Watches a file that has been opened in a mirrored app.
   */
  public watch(filePath: string, appId?: string): void {
    const norm = path.resolve(filePath).toLowerCase();
    const app = (appId ? getMirrorApp(appId) : undefined) || appForFile(filePath);
    if (!app) return;

    if (this.watchedFiles.has(norm)) {
      const existing = this.watchedFiles.get(norm)!;
      existing.app = app;
      return;
    }

    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const pattern = new vscode.RelativePattern(dir, base);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(async () => {
      await this.handleFileChange(filePath);
    });

    // Also watch via Node fs.watch so files in %TEMP% outside workspaceFolders fire reliably.
    let fsWatcher: fs.FSWatcher | undefined;
    try {
      if (fs.existsSync(dir)) {
        fsWatcher = fs.watch(dir, (eventType, filename) => {
          if (filename && filename.toLowerCase() === base.toLowerCase()) {
            this.handleFileChange(filePath).catch(() => {});
          }
        });
      }
    } catch {
      // Best-effort fallback if directory watch is unavailable
    }

    this.watchedFiles.set(norm, { filePath, app, watcher, fsWatcher });
    this.disposables.push(watcher);
  }

  public isWatching(filePath: string): boolean {
    return this.watchedFiles.has(path.resolve(filePath).toLowerCase());
  }

  public getWatchedFiles(): string[] {
    return Array.from(this.watchedFiles.values()).map((w) => w.filePath);
  }

  /**
   * Handles a disk change event on a watched file.
   * Checks whether the change was caused by the AI agent and prompts the user to reload in the app.
   */
  public async handleFileChange(filePath: string): Promise<boolean> {
    const norm = path.resolve(filePath).toLowerCase();
    const entry = this.watchedFiles.get(norm);
    if (!entry) return false;

    // Only prompt if the change was made by the AI agent (60s window covers MATLAB batch saves)
    const isAgent = AgentHistoryManager.getInstance().isAgentEditing(filePath, 60000);
    if (!isAgent) return false;

    const now = Date.now();
    const prev = this.lastPromptTime.get(norm) ?? 0;
    if (now - prev < 1500) return false; // debounce duplicate fs events from a single save
    this.lastPromptTime.set(norm, now);

    const prompt = formatReloadPrompt(entry.app.label);
    this.pendingReload = { appId: entry.app.id, filePath: entry.filePath, prompt };
    const choice = await vscode.window.showInformationMessage(prompt, 'Reload');
    if (choice === 'Reload' && this.pendingReload?.filePath === entry.filePath) {
      this.pendingReload = undefined;
      await this.appMirror.reload(entry.app.id, entry.filePath);
      return true;
    }
    return false;
  }

  public dispose(): void {
    for (const w of this.watchedFiles.values()) {
      w.watcher.dispose();
      try {
        w.fsWatcher?.close();
      } catch {}
    }
    this.watchedFiles.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
