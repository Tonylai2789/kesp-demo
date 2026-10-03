import { mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functions = join(root, 'web/functions');
const jest = join(functions, 'node_modules/jest/bin/jest.js');
if (!existsSync(jest)) throw new Error('Run npm ci in web/functions first. Also install firebase-tools and Java 21+.');
const directory = mkdtempSync(join(tmpdir(), 'kesp-demo-rules-'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  for (const name of ['firestore.rules', 'storage.rules']) copyFileSync(join(root, 'web', name), join(directory, name));
  copyFileSync(join(functions, 'src/__tests__/demoAccess.firebase.json'), join(directory, 'firebase.json'));
  const tests = ['demoAccess.rules.emulator.test.ts', 'demoAccess.storage.emulator.test.ts', 'consubancoMembers.emulator.test.ts', 'demoApiLimits.emulator.test.ts'];
  // Cold Java emulator startup can exceed Jest's five-second hook default on EC2.
  const command = `${quote(process.execPath)} --test ${quote(join(root, 'scripts/demo-password-rules.emulator.test.mjs'))} && cd ${quote(functions)} && ${quote(process.execPath)} ${quote(jest)} --runInBand --testTimeout=30000 --runTestsByPath ${tests.map(name=>quote('src/__tests__/'+name)).join(' ')}`;
  const result = spawnSync('firebase', ['emulators:exec', '--project', 'demo-kesp-auth', '--config', join(directory,'firebase.json'),
    '--only', 'firestore,storage', command], {
    cwd:directory, stdio:'inherit', env:{...process.env,
      GCLOUD_PROJECT:'demo-kesp-auth', GOOGLE_CLOUD_PROJECT:'demo-kesp-auth', GCP_PROJECT:'demo-kesp-auth',
      FIREBASE_CONFIG:JSON.stringify({projectId:'demo-kesp-auth'}),
      KESP_DEMO_AUTH_EMULATOR_TESTS:'1', KESP_DEMO_STORAGE_EMULATOR_TESTS:'1'},
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, {recursive:true,force:true});
}
