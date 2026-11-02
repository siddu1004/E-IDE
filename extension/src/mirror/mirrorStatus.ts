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
  const pids = appPids(app, windows, true);
  return {
    installed: !!exe,
    running: pids.length > 0,
    pids,
  };
}
