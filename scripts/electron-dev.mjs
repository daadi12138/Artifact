import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import electronPath from 'electron'

const projectRoot = resolve(import.meta.dirname, '..')
const stateDirectory = resolve(projectRoot, '.artifact-desktop-dev')
await mkdir(stateDirectory, { recursive: true })

await run('npm', ['run', 'electron:compile'])
const port = await availablePort()
const url = `http://127.0.0.1:${port}`
const environment = {
  ...process.env,
  ARTIFACT_SERVER_URL: url,
  ARTIFACT_STATE_DIR: stateDirectory,
  ARTIFACT_SESSION_TOKEN: randomUUID(),
}
const next = spawn(process.execPath, [resolve(projectRoot, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: projectRoot,
  env: environment,
  stdio: 'inherit',
})

try {
  await waitForServer(url, next)
  const electron = spawn(electronPath, [resolve(projectRoot, 'dist-electron/electron/main.js')], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  })
  const exitCode = await exitOf(electron)
  process.exitCode = exitCode
} finally {
  next.kill('SIGTERM')
}

function run(command, args) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' })
  return exitOf(child).then(code => {
    if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${code}`)
  })
}

function exitOf(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolveExit(code ?? 1))
  })
}

function waitForServer(url, child) {
  return new Promise((resolveReady, reject) => {
    const startedAt = Date.now()
    const poll = async () => {
      if (child.exitCode !== null) { reject(new Error(`Next.js exited with code ${child.exitCode}`)); return }
      try {
        const response = await fetch(url)
        if (response.ok) { resolveReady(); return }
      } catch { /* The development server is still starting. */ }
      if (Date.now() - startedAt >= 30_000) { reject(new Error('Next.js did not start within 30 seconds')); return }
      setTimeout(poll, 150)
    }
    void poll()
  })
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate a port')); return }
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}
