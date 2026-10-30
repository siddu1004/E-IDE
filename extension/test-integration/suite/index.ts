import * as fs from 'fs';
import * as path from 'path';
import Mocha = require('mocha');

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 120000,
  });

  const testsRoot = path.resolve(__dirname);

  return new Promise((resolve, reject) => {
    const files = fs.readdirSync(testsRoot).filter((f) => f.endsWith('.test.js'));
    for (const f of files) {
      mocha.addFile(path.resolve(testsRoot, f));
    }

    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
