import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'web', 'out');
const dst = path.join(root, 'dist', 'public');

try {
  await fs.rm(dst, { recursive: true, force: true });
  await fs.mkdir(dst, { recursive: true });
  await fs.cp(src, dst, { recursive: true });
  console.log(`Successfully copied static web build from ${src} to ${dst}`);
} catch (error) {
  console.error('Failed to copy static web build:', error);
  process.exit(1);
}
