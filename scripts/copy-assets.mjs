// Copy non-TS assets that tsc doesn't emit into dist/ so the compiled app is
// self-contained. Currently: the SQL migration files.
import { cpSync, existsSync } from 'node:fs';

const copies = [['src/db/migrations', 'dist/db/migrations']];

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`copy-assets: source not found: ${from}`);
    process.exit(1);
  }
  cpSync(from, to, { recursive: true });
  console.log(`copy-assets: ${from} -> ${to}`);
}
