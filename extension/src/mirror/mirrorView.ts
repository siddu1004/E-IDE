// "EEE Apps" sidebar tree view provider.
// Displays one row per app from MIRROR_APPS with Installed / Running / Not installed status,
// auto-refreshed every 5 seconds.

import * as vscode from 'vscode';
import { activeAppMirror, AppStatus } from './appMirror';
import { getMirrorApp, MirrorApp, MIRROR_APPS } from './mirrorApps';
import { computeAppStatus, formatAppStatusLabel, getAppDisplayState } from './mirrorStatus';

export class MirrorAppTreeItem extends vscode.TreeItem {
  constructor(
    public readonly app: MirrorApp,
    public readonly installed: boolean,
    public readonly running: boolean,
    public readonly windowCount: number = 0
  ) {
    super(app.label, vscode.TreeItemCollapsibleState.None);

    const state = getAppDisplayState(installed, running);
    this.description = formatAppStatusLabel(state);

    if (running) {
      this.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
      this.tooltip = `${app.label} (Running - click to open inside E-IDE)`;
      this.contextValue = 'runningApp';
      this.command = {
        command: 'eide.apps.open',
        title: 'Open in E-IDE',
        arguments: [app.id],
      };
    } else if (installed) {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.blue'));
      this.tooltip = `${app.label} (Installed - click to launch inside E-IDE)`;
      this.contextValue = 'installedApp';
      this.command = {
        command: 'eide.apps.open',
        title: 'Open in E-IDE',
        arguments: [app.id],
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('descriptionForeground'));
      this.tooltip = `${app.label} (Not installed - click to download)`;
      this.contextValue = 'uninstalledApp';
      this.command = {
        command: 'eide.apps.installApp',
        title: 'Install App',
        arguments: [app.id],
      };
    }
  }
}

export class MirrorAppsProvider implements vscode.TreeDataProvider<MirrorAppTreeItem>, vscode.Disposable {
  private static instance?: MirrorAppsProvider;
  private static commandsRegistered = false;

  private _onDidChangeTreeData: vscode.EventEmitter<MirrorAppTreeItem | undefined | void> =
    new vscode.EventEmitter<MirrorAppTreeItem | undefined | void>();
  public readonly onDidChangeTreeData: vscode.Event<MirrorAppTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private pollTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    MirrorAppsProvider.instance = this;

    // Refresh every 5 seconds as requested
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, 5000);

    if (!MirrorAppsProvider.commandsRegistered) {
      MirrorAppsProvider.commandsRegistered = true;
      this.disposables.push(
        vscode.commands.registerCommand('eide.apps.refresh', () => {
          MirrorAppsProvider.instance?.refresh();
        }),
        vscode.commands.registerCommand('eide.apps.installApp', async (appId?: string) => {
          const app = appId ? getMirrorApp(appId) : undefined;
          if (!app) return;
          const choice = await vscode.window.showInformationMessage(
            `${app.label} is not installed. Download from official site?`,
            'Install',
            'Cancel'
          );
          if (choice === 'Install') {
            vscode.env.openExternal(vscode.Uri.parse(app.installUrl));
          }
        })
      );
    }
  }

  public static getInstance(): MirrorAppsProvider | undefined {
    return MirrorAppsProvider.instance;
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: MirrorAppTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: MirrorAppTreeItem): Promise<MirrorAppTreeItem[]> {
    if (element) return [];

    let statuses: AppStatus[] = [];
    if (activeAppMirror) {
      try {
        statuses = await activeAppMirror.status();
      } catch {
        // Fallback if status probe is unsupported or timed out
      }
    }

    return MIRROR_APPS.map((app) => {
      const live = statuses.find((s) => s.id === app.id);
      if (live) {
        return new MirrorAppTreeItem(app, live.installed, live.running, live.windows.length);
      }

      const customPath = vscode.workspace.getConfiguration('eide.apps').get<string>(`${app.id}Path`);
      const fallback = computeAppStatus(app, [], customPath);
      return new MirrorAppTreeItem(app, fallback.installed, fallback.running, 0);
    });
  }

  public dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
