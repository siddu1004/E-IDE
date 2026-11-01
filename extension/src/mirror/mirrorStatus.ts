// Pure helper functions for desktop app mirroring state, formatting, and prompts.
// Zero vscode imports; fully testable with node --test.

import { AppWindow, findAppExecutable, MirrorApp, appPids } from './mirrorApps';

export type AppDisplayState = 'running' | 'installed' | 'not_installed';

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
