'use strict';
// Cross-platform test entry: Node 18/20 do not glob --test arguments and cmd.exe does
// not expand *.test.js, so the files are listed here.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).map(f => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
