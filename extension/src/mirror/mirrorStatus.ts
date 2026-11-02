// Pure helper functions for desktop app mirroring state, formatting, and prompts.
// Zero vscode imports; fully testable with node --test.

import { AppWindow, findAppExecutable, MirrorApp, appPids } from './mirrorApps';

export type AppDisplayState = 'running' | 'installed' | 'not_installed';

export type MirrorHeaderState = 'starting' | 'live' | 'minimized' | 'gone' | 'error';

/**
 * Derives the visual state of an app given its installation and process status.
 */
export function getAppDisplayState(installed: boolean, running: boolean): AppDisplayState {
  if (running) return 'running';
  if (installed) return 'installed';
  return 'not_installed';
}

/**
 * Returns a human-friendly label for the app's display state.
 */
export function formatAppStatusLabel(state: AppDisplayState): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'installed':
      return 'Installed';
    case 'not_installed':
      return 'Not installed';
  }
}

/**
 * Formats the app tab header status string.
 */
export function formatMirrorHeaderStatus(
  state: MirrorHeaderState,
  fps = 0,
  detail = ''
): string {
  switch (state) {
    case 'starting':
      return `Starting ${detail || 'app'}…`;
    case 'live':
      return fps > 0 ? `Live · ${fps} fps` : 'Live';
    case 'minimized':
      return 'Minimized (App closed or minimized)';
    case 'gone':
      return 'App closed or minimized';
    case 'error':
      return `Error: ${detail}`;
  }
}

/**
 * Returns true on first activation when no EEE desktop app is installed.
 */
export function shouldPromptGettingStarted(
  alreadyPrompted: boolean,
  statuses: ReadonlyArray<{ installed: boolean }>
): boolean {
  if (alreadyPrompted) return false;
  if (statuses.length === 0) return true;
  return statuses.every((s) => !s.installed);
}

/**
 * Returns the reload confirmation prompt when an agent edits a mirrored file.
 */
export function formatReloadPrompt(appName: string): string {
  return `Changed on disk, reload in ${appName}?`;
}

/**
 * Computes whether an app is installed and running from an executable check and window list.
 */
export function computeAppStatus(
  app: MirrorApp,
  windows: AppWindow[] = [],
  customPath?: string,
  env: Record<string, string | undefined> = process.env
): { installed: boolean; running: boolean; pids: number[] } {
  const exe = findAppExecutable(app, customPath, env);
  const pids = appPids(app, windows);
  return {
    installed: !!exe,
    running: pids.length > 0,
    pids,
  };
}

export interface AppQuickAction {
  id: string;
  label: string;
  keyCombo?: string;
  primary?: boolean;
}

/**
 * Returns available quick action buttons for an open app toolbar.
 */
export function getAppQuickActions(appId: string): AppQuickAction[] {
  switch (appId) {
    case 'matlab':
      return [
        { id: 'matlab_run', label: '▶ Run (F5)', keyCombo: 'f5', primary: true },
        { id: 'matlab_sim', label: '⚡ Sim (Ctrl+T)', keyCombo: 'ctrl+t' },
        { id: 'matlab_cw', label: '⌨ Command Win (Ctrl+0)', keyCombo: 'ctrl+0' },
        { id: 'matlab_clc', label: '⌫ Clear (clc)' },
        { id: 'save', label: '💾 Save', keyCombo: 'ctrl+s' },
      ];
    case 'ltspice':
      return [
        { id: 'ltspice_run', label: '▶ Run Sim (F7)', keyCombo: 'f7', primary: true },
        { id: 'ltspice_fit', label: '🔍 Zoom Fit (Ctrl+B)', keyCombo: 'ctrl+b' },
        { id: 'ltspice_comp', label: '➕ Component (F2)', keyCombo: 'f2' },
        { id: 'ltspice_wire', label: '✏ Wire (F3)', keyCombo: 'f3' },
        { id: 'save', label: '💾 Save', keyCombo: 'ctrl+s' },
      ];
    case 'kicad':
      return [
        { id: 'kicad_sym', label: '➕ Symbol (A)', keyCombo: 'a', primary: true },
        { id: 'kicad_wire', label: '✏ Wire (W)', keyCombo: 'w' },
        { id: 'kicad_pcb', label: '⚡ Update PCB (F8)', keyCombo: 'f8' },
        { id: 'kicad_fit', label: '🔍 Fit (Home)', keyCombo: 'home' },
        { id: 'save', label: '💾 Save', keyCombo: 'ctrl+s' },
      ];
    case 'arduino':
      return [
        { id: 'arduino_verify', label: '✔ Verify (Ctrl+R)', keyCombo: 'ctrl+r', primary: true },
        { id: 'arduino_upload', label: '⬆ Upload (Ctrl+U)', keyCombo: 'ctrl+u' },
        { id: 'arduino_serial', label: '📊 Serial Monitor', keyCombo: 'ctrl+shift+m' },
        { id: 'save', label: '💾 Save', keyCombo: 'ctrl+s' },
      ];
    default:
      return [{ id: 'save', label: '💾 Save', keyCombo: 'ctrl+s' }];
  }
}

/**
 * Formats a window title for display in the multi-window dropdown switcher.
 */
export function formatWindowPickerOption(win: { hwnd: number; title: string }, maxLen = 40): string {
  if (!win.title || !win.title.trim()) return `HWND ${win.hwnd}`;
  const trimmed = win.title.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 3) + '...' : trimmed;
}
