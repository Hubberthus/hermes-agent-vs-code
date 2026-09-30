// Syntax-checks every JS file tracked by git, instead of a hardcoded list.
// The hardcoded list went stale when upstream deleted test/, which made
// `npm run lint` fail on missing files rather than on real code errors.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '*.js'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
  } catch (err) {
    failed++;
    process.stderr.write(`FAIL ${file}\n${err.stderr ? err.stderr.toString() : err.message}\n`);
  }
}

console.log(`${files.length - failed}/${files.length} JS files parse cleanly`);
process.exit(failed ? 1 : 0);
