import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main() {
  const testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-test-workspace-'));
  const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-test-user-'));
  const testExtensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-test-ext-'));

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
        testWorkspaceDir,
        '--disable-gpu',
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        `--user-data-dir=${testUserDataDir}`,
        `--extensions-dir=${testExtensionsDir}`,
      ],
      extensionTestsEnv: {
        EIDE_TEST: '1',
      },
    });
    console.log('[IntegrationTest] All integration tests completed successfully.');
  } catch (err) {
    console.error('[IntegrationTest] Integration tests failed:', err);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(testUserDataDir, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(testExtensionsDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  }
}

main();

