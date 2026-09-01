import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const runtimePackage = JSON.parse(await readFile(new URL('./runtime-package.json', import.meta.url), 'utf8'));
const installScript = await readFile(new URL('./install.sh', import.meta.url), 'utf8');
const managerScript = await readFile(new URL('./haejeok.sh', import.meta.url), 'utf8');

const runtimeDependencies = runtimePackage.dependencies;
const requiredDependencies = [
  '@dqbd/tiktoken',
  'express',
  'express-rate-limit',
  'msgpackr',
  'node-html-parser',
  'openid-client',
  'pg',
  'ws',
];

function normalizedVersion(value) {
  return String(value).replace(/^[~^]/, '');
}
test('Termux runtime dependencies stay aligned with the root package', () => {
  assert.deepEqual(Object.keys(runtimeDependencies).sort(), requiredDependencies.sort());
  for (const dependency of requiredDependencies) {
    assert.equal(
      runtimeDependencies[dependency],
      normalizedVersion(rootPackage.dependencies[dependency]),
      `${dependency} version drifted from package.json`,
    );
  }
});

test('Termux runtime excludes optional native and cloud backends', () => {
  for (const dependency of ['sharp', 'mssql', 'oracledb', '@aws-sdk/client-s3']) {
    assert.equal(runtimeDependencies[dependency], undefined);
  }
});

test('Termux installer is deterministic and localhost-first', () => {
  assert.match(installScript, /pkg install -y .*openssl-tool/);
  assert.doesNotMatch(installScript, /pkg install -y .* openssl(?: |$)/);
  assert.match(installScript, /npm ci --omit=dev --ignore-scripts/);
  assert.match(installScript, /pkg install -y .*openssl/);
  assert.match(installScript, /command -v openssl/);
  assert.match(installScript, /\/dev\/urandom/);
  assert.match(installScript, /RISU_HOST=127\.0\.0\.1/);
  assert.match(managerScript, /update_config_value RISU_HOST 0\.0\.0\.0/);
  assert.match(managerScript, /update_config_value RISU_HOST 127\.0\.0\.1/);
});
