import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDirectories = [".next", ".next-electron-dev", "dist-electron", "dist-cli", "release"];
const dryRun = process.argv.includes("--dry-run");

for (const directory of generatedDirectories) {
  const target = resolve(projectRoot, directory);

  if (!target.startsWith(`${projectRoot}/`)) {
    throw new Error(`Refusing to clean a path outside the project: ${target}`);
  }

  if (dryRun) {
    console.log(`Would remove ${directory}`);
  } else {
    await rm(target, { force: true, recursive: true });
    console.log(`Removed ${directory}`);
  }
}
