// Writes files.json: every file the app's updater installs. Run `npm run files`
// after adding or removing a file (the tests check it's up to date).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { safeAppPath } from '../server.mjs';

const skip = (f) => f.startsWith('tests/') || f.startsWith('tools/') || f === 'files.json' || !safeAppPath(f);
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !skip(f) && fs.existsSync(f));
for (const extra of ['files.json']) files.push(extra);
fs.writeFileSync('files.json', `${JSON.stringify([...new Set(files)].sort(), null, 2)}\n`);
console.log(`files.json: ${files.length} files`);
