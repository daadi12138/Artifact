import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..', 'node_modules', 'electron')
const runtimePath = resolve(packageRoot, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const metadata = {
  packageRoot,
  runtimePath,
  installed: existsSync(runtimePath),
  platform: process.platform,
  arch: process.arch,
}
console.log(JSON.stringify(metadata, null, 2))
if (!metadata.installed) {
  console.error('Electron runtime is missing. Run the Electron package install script when network access to the Electron release mirror is available.')
  process.exitCode = 1
}
