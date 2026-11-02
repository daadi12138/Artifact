import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RunSnapshot } from './run-manager'

export async function managedRunWorktree(id: string, projectRoot?: string, stateDirectory = process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact')) {
  if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error('无效的 Run ID')
  const run = JSON.parse(await readFile(join(stateDirectory, 'runs', id, 'manifest.json'), 'utf8')) as RunSnapshot
  const expected = resolve(stateDirectory, 'worktrees', id)
  if (run.id !== id || !run.worktreePath || resolve(run.worktreePath) !== expected) throw new Error('该 Run 没有有效的托管 Worktree')
  const details = await lstat(expected)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Worktree 目录不可用')
  if (projectRoot && await realpath(run.project.gitRoot) !== await realpath(projectRoot)) throw new Error('Worktree 不属于当前项目')
  return { run, root: await realpath(expected) }
}

export async function managedTerminalDirectory(requestedPath: string, projectRoot: string, stateDirectory?: string) {
  const root = resolve(stateDirectory || process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact'), 'worktrees')
  const requested = resolve(requestedPath)
  const id = requested.slice(root.length + 1)
  if (requested !== join(root, id) || !/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error('终端工作目录必须位于当前项目或其托管 Worktree 中')
  return (await managedRunWorktree(id, projectRoot, stateDirectory)).root
}
