import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const { loadConfig } = await import('./config.js');
const { openDatabase } = await import('./db/index.js');
const { now } = await import('./lib/security.js');

function usage() {
  console.error('用法：npm run invite -- add <码> --name <绑定名>');
}

const [command, code, ...arguments_] = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < arguments_.length; index += 2) {
  const key = arguments_[index];
  const value = arguments_[index + 1];
  if (key !== '--name' || value === undefined || options.has(key)) {
    usage();
    process.exit(1);
  }
  options.set(key, value);
}
const boundName = options.get('--name')?.trim();
if (command !== 'add' || !code?.trim() || !boundName) {
  usage();
  process.exit(1);
}

const db = openDatabase(loadConfig());
try {
  db.prepare('INSERT INTO invites (code, bound_name, active, used_count, created_at) VALUES (?, ?, 1, 0, ?)')
    .run(code.trim(), boundName, now());
  console.log(`内测通行码已添加：${code.trim()}；绑定名：${boundName}`);
} catch (error) {
  if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.error('添加失败：通行码已存在。');
  } else {
    throw error;
  }
  process.exitCode = 1;
} finally {
  db.close();
}
