#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { diagnoseProject, resolveGitProject } from './core/index'

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help'
  const inputPath = resolve(process.argv[3] ?? process.cwd())

  if (command === 'doctor') {
    const diagnostic = await diagnoseProject(inputPath)
    console.log(JSON.stringify(diagnostic, null, 2))
    if (!diagnostic.valid) process.exitCode = 1
    return
  }

  if (command === 'open') {
    const project = await resolveGitProject(inputPath)
    launchDesktopApp(project.gitRoot)
    console.log(`Opening ${project.gitRoot} in Artifact`)
    return
  }

  if (command === 'dev') {
    const project = await resolveGitProject(inputPath)
    console.log(`Project: ${project.gitRoot}`)
    console.log('Starting Artifact on http://127.0.0.1:3000')
    const appRoot = resolve(__dirname, '..')
    const nextBin = resolve(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
    const child = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1'], { cwd: appRoot, stdio: 'inherit' })
    child.on('exit', code => { process.exitCode = code ?? 1 })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
    return
  }

  console.log('Usage: artifact <open|doctor|dev> [project-path]')
}

function launchDesktopApp(projectPath: string): void {
  if (process.platform !== 'darwin') throw new Error('Artifact.app launching is currently supported on macOS')
  const appRoot = resolve(__dirname, '..')
  const candidates = [
    process.env.ARTIFACT_APP_PATH,
    resolve(appRoot, 'release', 'mac-arm64', 'Artifact.app'),
    resolve(appRoot, 'release', 'mac', 'Artifact.app'),
    '/Applications/Artifact.app',
    join(homedir(), 'Applications', 'Artifact.app'),
  ].filter((path): path is string => Boolean(path))
  const localApp = candidates.find(existsSync)
  const args = localApp
    ? ['-n', localApp, '--args', '--project', projectPath]
    : ['-n', '-a', 'Artifact', '--args', '--project', projectPath]
  const result = spawnSync('/usr/bin/open', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Artifact.app is not installed')
}

void main().catch(error => {
  console.error(`artifact: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
