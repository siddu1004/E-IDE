import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;

    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    let vscodeExecutablePath: string | undefined;
    const localCode = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
    if (fs.existsSync(localCode)) {
      vscodeExecutablePath = localCode;
      console.log(`[IntegrationTest] Using local VS Code at: ${vscodeExecutablePath}`);
    }

    console.log('[IntegrationTest] Launching VS Code Host with EIDE_TEST=1...');
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-gpu',
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
      ],
      extensionTestsEnv: {
        EIDE_TEST: '1',
      },
    });
    console.log('[IntegrationTest] All integration tests completed successfully.');
  } catch (err) {
    console.error('[IntegrationTest] Integration tests failed:', err);
    process.exit(1);
  }
}

main();

