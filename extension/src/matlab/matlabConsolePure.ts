// Pure logic helpers for in-IDE MATLAB Command Window.
// Zero vscode dependencies, 100% testable with node --test.

export interface CommandHistoryEntry {
  command: string;
  timestamp: number;
}

export class CommandHistoryTracker {
  private history: string[] = [];
  private pointer = -1;
  private draft = '';

  constructor(private readonly maxEntries = 100) {}

  public push(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;
    // Don't duplicate if identical to immediate predecessor
    if (this.history.length > 0 && this.history[this.history.length - 1] === trimmed) {
      this.pointer = -1;
      this.draft = '';
      return;
    }
    this.history.push(trimmed);
    if (this.history.length > this.maxEntries) {
      this.history.shift();
    }
    this.pointer = -1;
    this.draft = '';
  }

  public navigateUp(currentInput: string): string {
    if (this.history.length === 0) return currentInput;
    if (this.pointer === -1) {
      this.draft = currentInput;
      this.pointer = this.history.length - 1;
    } else if (this.pointer > 0) {
      this.pointer--;
    }
    return this.history[this.pointer];
  }

  public navigateDown(currentInput: string): string {
    if (this.pointer === -1) return currentInput;
    if (this.pointer < this.history.length - 1) {
      this.pointer++;
      return this.history[this.pointer];
    }
    this.pointer = -1;
    return this.draft;
  }

  public getHistory(): string[] {
    return [...this.history];
  }

  public clear(): void {
    this.history = [];
    this.pointer = -1;
    this.draft = '';
  }
}

/**
 * Formats command line echo with prompt prefix.
 */
export function formatConsoleEcho(cmd: string): string {
  return `>> ${cmd}`;
}

/**
 * Validates whether an input is a quick local command or full MATLAB evaluation.
 */
export function isLocalConsoleCommand(cmd: string): 'clc' | 'help' | undefined {
  const norm = cmd.trim().toLowerCase();
  if (norm === 'clc' || norm === 'clear screen') return 'clc';
  if (norm === 'help eide' || norm === 'help') return 'help';
  return undefined;
}

/**
 * Formats a friendly welcome / help banner for the in-IDE MATLAB Command Window.
 */
export function formatWelcomeBanner(version = 'R2026a (Headless Bridge)'): string {
  return [
    `E-IDE MATLAB Interactive Console [${version}]`,
    'Running completely inside IDE without opening real desktop windows.',
    'Type commands, run scripts, and inspect variables live. Type "clc" to clear.',
    '-------------------------------------------------------------------------------',
  ].join('\n');
}
