import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSlx } from '../simulink/slxParser';
import { TestHook } from '../testHook';

export interface AgentChangeRecord {
  id: string;
  timestamp: number;
  timeFormatted: string;
  description: string;
  filePath: string;
  fileType: 'asc' | 'kicad_sch' | 'slx';
  previousText?: string;
  previousBackupPath?: string;
}

interface ActiveTurn {
  timer: NodeJS.Timeout;
  changes: string[];
  initialText?: string;
  backupPath?: string;
  fileType: 'asc' | 'kicad_sch' | 'slx';
}

async function copyFileWithRetry(src: string, dst: string, maxAttempts = 15, delayMs = 150): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.copyFileSync(src, dst);
      return;
    } catch (err: any) {
      if ((err.code === 'EBUSY' || err.code === 'EACCES') && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

async function readFileWithRetry(filePath: string, maxAttempts = 15, delayMs = 150): Promise<Buffer> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fs.readFileSync(filePath);
    } catch (err: any) {
      if ((err.code === 'EBUSY' || err.code === 'EACCES') && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  return fs.readFileSync(filePath);
}

export class AgentHistoryManager {
  private static instance: AgentHistoryManager;

  // Active turn per lowercase fsPath (2-second debounce window)
  private activeTurns = new Map<string, ActiveTurn>();

  // Change history per lowercase fsPath
  private fileHistory = new Map<string, AgentChangeRecord[]>();

  // Map of registered webviews (imported from tools or injected)
  private webviews = new Map<string, vscode.Webview>();

  // Last agent edit timestamp per lowercase fsPath
  private lastAgentEditTimes = new Map<string, number>();

  public static getInstance(): AgentHistoryManager {
    if (!AgentHistoryManager.instance) {
      AgentHistoryManager.instance = new AgentHistoryManager();
    }
    return AgentHistoryManager.instance;
  }

  public markAgentEditing(filePath: string): void {
    this.lastAgentEditTimes.set(path.resolve(filePath).toLowerCase(), Date.now());
  }

  public isAgentEditing(filePath: string, windowMs = 15000): boolean {
    const t = this.lastAgentEditTimes.get(path.resolve(filePath).toLowerCase());
    return t !== undefined && Date.now() - t < windowMs;
  }

  public registerWebview(filePath: string, webview: vscode.Webview): vscode.Disposable {
    const key = path.resolve(filePath).toLowerCase();
    this.webviews.set(key, webview);
    return {
      dispose: () => {
        if (this.webviews.get(key) === webview) {
          this.webviews.delete(key);
        }
      },
    };
  }

  public getWebview(filePath: string): vscode.Webview | undefined {
    return this.webviews.get(path.resolve(filePath).toLowerCase());
  }

  public getHistory(filePath: string): AgentChangeRecord[] {
    return this.fileHistory.get(path.resolve(filePath).toLowerCase()) || [];
  }

  /**
   * Called before modifying a file. Captures the state before this turn started.
   */
  public async recordBeforeChange(filePath: string, changeDesc: string): Promise<void> {
    this.markAgentEditing(filePath);
    const key = path.resolve(filePath).toLowerCase();
    const ext = path.extname(filePath).toLowerCase();
    const fileType: 'asc' | 'kicad_sch' | 'slx' =
      ext === '.asc' ? 'asc' : ext === '.kicad_sch' ? 'kicad_sch' : 'slx';

    let turn = this.activeTurns.get(key);

    if (turn) {
      // Existing turn within 2s window
      clearTimeout(turn.timer);
      turn.changes.push(changeDesc);
    } else {
      // New turn: capture initial state
      let initialText: string | undefined;
      let backupPath: string | undefined;

      if (fileType === 'slx') {
        const tempDir = os.tmpdir();
        backupPath = path.join(
          tempDir,
          `eide_backup_${Date.now()}_${path.basename(filePath)}`
        );
        if (fs.existsSync(filePath)) {
          await copyFileWithRetry(filePath, backupPath);
        }
      } else {
        const uri = vscode.Uri.file(filePath);
        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase()
        );
        if (openDoc) {
          initialText = openDoc.getText();
        } else if (fs.existsSync(filePath)) {
          initialText = fs.readFileSync(filePath, 'utf8');
        }
      }

      turn = {
        timer: undefined as any,
        changes: [changeDesc],
        initialText,
        backupPath,
        fileType,
      };
      this.activeTurns.set(key, turn);
    }

    // Set 2s debounce window
    turn.timer = setTimeout(() => {
      this.commitTurn(filePath, turn!);
    }, 2000);
  }

  public commitActiveTurn(filePath: string) {
    const key = path.resolve(filePath).toLowerCase();
    const pendingTurn = this.activeTurns.get(key);
    if (pendingTurn) {
      clearTimeout(pendingTurn.timer);
      this.commitTurn(filePath, pendingTurn);
    }
  }

  public clearHistory(filePath?: string) {
    if (filePath) {
      const key = path.resolve(filePath).toLowerCase();
      const pendingTurn = this.activeTurns.get(key);
      if (pendingTurn) clearTimeout(pendingTurn.timer);
      this.activeTurns.delete(key);
      this.fileHistory.delete(key);
    } else {
      for (const turn of this.activeTurns.values()) {
        clearTimeout(turn.timer);
      }
      this.activeTurns.clear();
      this.fileHistory.clear();
    }
  }

  /**
   * Finalizes an agent turn into history.
   */
  private commitTurn(filePath: string, turn: ActiveTurn) {
    this.markAgentEditing(filePath);
    const key = path.resolve(filePath).toLowerCase();
    this.activeTurns.delete(key);

    const record: AgentChangeRecord = {
      id: `change_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      timeFormatted: new Date().toLocaleTimeString(),
      description: turn.changes.join(' · '),
      filePath,
      fileType: turn.fileType,
      previousText: turn.initialText,
      previousBackupPath: turn.backupPath,
    };

    const history = this.fileHistory.get(key) || [];
    history.unshift(record);
    if (history.length > 20) history.pop(); // keep short history
    this.fileHistory.set(key, history);

    this.postHistoryUpdate(filePath, history);
  }

  /**
   * Posts agent banner and undo action into the editor webview.
   */
  public postAgentBanner(filePath: string, bannerText: string, simulationDurationSec?: number) {
    const webview = this.getWebview(filePath);
    if (!webview) return;

    let fullText = bannerText;
    if (simulationDurationSec !== undefined) {
      fullText += ` · re-simulated in ${simulationDurationSec.toFixed(1)} s`;
    }

    const history = this.getHistory(filePath);

    const msg = {
      type: 'agentBanner',
      text: fullText,
      hasUndo: true,
      history: history.map((h) => ({
        id: h.id,
        time: h.timeFormatted,
        description: h.description,
      })),
    };

    TestHook.recordPostMessageForUri(filePath, msg);
    webview.postMessage(msg);
  }

  private postHistoryUpdate(filePath: string, history: AgentChangeRecord[]) {
    const webview = this.getWebview(filePath);
    if (!webview) return;

    const msg = {
      type: 'agentHistoryUpdate',
      history: history.map((h) => ({
        id: h.id,
        time: h.timeFormatted,
        description: h.description,
      })),
    };

    TestHook.recordPostMessageForUri(filePath, msg);
    webview.postMessage(msg);
  }

  /**
   * Performs Undo: restores previous content and triggers re-simulation.
   */
  public async undoLastChange(
    filePath: string,
    resimulateCallback?: () => Promise<number | void>
  ): Promise<boolean> {
    const key = path.resolve(filePath).toLowerCase();

    // If an active turn is currently pending debounced commit, flush it now
    const pendingTurn = this.activeTurns.get(key);
    if (pendingTurn) {
      clearTimeout(pendingTurn.timer);
      this.commitTurn(filePath, pendingTurn);
    }

    const history = this.fileHistory.get(key);
    if (!history || history.length === 0) {
      vscode.window.showInformationMessage('No agent changes to undo for this file.');
      return false;
    }

    const lastRecord = history.shift()!;
    this.fileHistory.set(key, history);

    const startTime = Date.now();

    if (lastRecord.fileType === 'slx') {
      if (lastRecord.previousBackupPath && fs.existsSync(lastRecord.previousBackupPath)) {
        await copyFileWithRetry(lastRecord.previousBackupPath, filePath);
        try {
          fs.unlinkSync(lastRecord.previousBackupPath);
        } catch {}

        const webview = this.getWebview(filePath);
        if (webview) {
          const buf = await readFileWithRetry(filePath);
          const model = parseSlx(buf, path.basename(filePath, '.slx'));
          webview.postMessage({
            type: 'update',
            model,
            fileName: path.basename(filePath),
          });
        }
      }
    } else {
      if (lastRecord.previousText !== undefined) {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          doc.lineAt(doc.lineCount - 1).range.end
        );
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, fullRange, lastRecord.previousText);
        await vscode.workspace.applyEdit(we);
        await doc.save();
      }
    }

    let elapsedSec = (Date.now() - startTime) / 1000;
    console.log('[Undo-Log] starting resimulateCallback on:', filePath);
    if (resimulateCallback) {
      try {
        const resimTime = await resimulateCallback();
        if (typeof resimTime === 'number') {
          elapsedSec = resimTime;
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Re-simulation after undo failed: ${e.message}`);
      }
    }

    console.log("[Undo-Log] finished undo successfully");
    this.postAgentBanner(
      filePath,
      `Undone: reverted "${lastRecord.description}"`,
      elapsedSec
    );
    this.postHistoryUpdate(filePath, history);
    return true;
  }
}
