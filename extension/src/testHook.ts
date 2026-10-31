// Test-only hook for driving webview editors in VS Code integration tests.
// Active ONLY when process.env.EIDE_TEST === '1'. Zero overhead/no-op otherwise.

import * as vscode from 'vscode';

export interface TestEditorHandle {
  documentUri: vscode.Uri;
  viewType: string;
  postedMessages: any[];
  postMessage: (msg: any) => Thenable<boolean>;
  sendWebviewMessage: (msg: any) => Promise<void>;
  waitForMessage: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
}

export class TestHook {
  private static handles = new Map<string, TestEditorHandle>();
  private static messageListeners = new Map<string, Array<(msg: any) => void>>();

  public static isEnabled(): boolean {
    return process.env.EIDE_TEST === '1';
  }

  public static register(
    viewType: string,
    uri: vscode.Uri,
    webview: vscode.Webview,
    onDidReceiveMessage: (msg: any) => Promise<void> | void
  ): { recordPostMessage: (msg: any) => void; dispose: () => void } | undefined {
    if (!TestHook.isEnabled()) {
      return undefined;
    }

    const key = uri.fsPath.toLowerCase();
    const postedMessages: any[] = [];
    const listeners: Array<(msg: any) => void> = [];
    TestHook.messageListeners.set(key, listeners);

    const handle: TestEditorHandle = {
      documentUri: uri,
      viewType,
      postedMessages,
      postMessage: (msg) => webview.postMessage(msg),
      sendWebviewMessage: async (msg) => {
        await onDidReceiveMessage(msg);
      },
      waitForMessage: (predicate, timeoutMs = 25000) => {
        for (const m of postedMessages) {
          if (predicate(m)) return Promise.resolve(m);
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const history = postedMessages.map(m => m.type || JSON.stringify(m)).join(', ');
            reject(new Error(`Timed out waiting for message after ${timeoutMs}ms (received: [${history}])`));
          }, timeoutMs);

          const listener = (msg: any) => {
            if (predicate(msg)) {
              clearTimeout(timer);
              const idx = listeners.indexOf(listener);
              if (idx >= 0) listeners.splice(idx, 1);
              resolve(msg);
            }
          };
          listeners.push(listener);
        });
      },
    };

    TestHook.handles.set(key, handle);

    return {
      recordPostMessage: (msg: any) => {
        postedMessages.push(msg);
        const curListeners = TestHook.messageListeners.get(key) || [];
        for (const l of [...curListeners]) {
          try {
            l(msg);
          } catch {}
        }
      },
      dispose: () => {
        TestHook.handles.delete(key);
        TestHook.messageListeners.delete(key);
      },
    };
  }

  public static getHandle(uri: vscode.Uri): TestEditorHandle | undefined {
    return TestHook.handles.get(uri.fsPath.toLowerCase());
  }

  public static recordPostMessageForUri(uriOrPath: vscode.Uri | string, msg: any): void {
    if (!TestHook.isEnabled()) return;
    const fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
    const key = fsPath.toLowerCase();
    const handle = TestHook.handles.get(key);
    if (handle) {
      handle.postedMessages.push(msg);
      const curListeners = TestHook.messageListeners.get(key) || [];
      for (const l of [...curListeners]) {
        try {
          l(msg);
        } catch {}
      }
    }
  }

  public static getAllHandles(): TestEditorHandle[] {
    return Array.from(TestHook.handles.values());
  }
}

