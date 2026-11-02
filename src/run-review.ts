import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { managedRunWorktree } from './run-worktree'

const exec = promisify(execFile)
const maxBytes = 2 * 1024 * 1024
export type ReviewFile = { path: string; previousPath?: string; status: string; fingerprint?: string }
export type ReviewFileDetail = ReviewFile & { diff: string; fingerprint: string; binary: boolean }

async function git(root: string, args: string[]) {
  return (await exec('git', ['--no-pager', '-C', root, ...args], { timeout: 15000, maxBuffer: maxBytes, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' } })).stdout
}

export function parseReviewFiles(output: string): ReviewFile[] {
  const parts = output.split('\0'), files: ReviewFile[] = []
  for (let i = 0; i < parts.length - 1;) {
    const status = parts[i++]
    const first = parts[i++]
    if (!first) continue
    if (/^[RC]/.test(status)) files.push({ status: status[0], previousPath: first, path: parts[i++] })
    else files.push({ status: status[0], path: first })
  }
  return files
}

async function reviewContent(root: string, file: ReviewFile) {
  const path = file.path
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '.git') || path.includes('\0')) throw new Error('无效的文件路径')
  if (file.status === 'D') return Buffer.alloc(0)
  const target = resolve(root, path), details = await lstat(target)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('不支持预览符号链接或特殊文件')
  const canonical = await realpath(target), within = relative(root, canonical)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('文件路径超出 Worktree')
  if (details.size > maxBytes) throw new Error('文件超过 2 MB，请在本地编辑器中审查')
  return readFile(target)
}

function contentFingerprint(base: string, file: ReviewFile, content: Buffer) {
  return createHash('sha256').update(base).update(JSON.stringify({ path: file.path, status: file.status, previousPath: file.previousPath })).update(content).digest('hex')
}

export async function readRunReview(id: string, requestedPath?: string, stateDirectory?: string) {
  const { run, root } = await managedRunWorktree(id, undefined, stateDirectory)
  const base = run.baseGitRef
  if (!base || !/^[a-f0-9]{40,64}$/i.test(base)) throw new Error('该 Run 未保存可审查的 Git 基线')
  const [tracked, untracked] = await Promise.all([
    git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', base, '--']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const files = parseReviewFiles(tracked)
  const seen = new Set(files.map(file => file.path))
  for (const path of untracked.split('\0').filter(Boolean)) if (!seen.has(path)) files.push({ path, status: '?' })
  if (requestedPath === undefined) {
    const limited = files.slice(0, 1000)
    for (let i = 0; i < limited.length; i += 8) await Promise.all(limited.slice(i, i + 8).map(async file => {
      try { file.fingerprint = contentFingerprint(base, file, await reviewContent(root, file)) } catch { /* Unsupported files remain visible without review marks. */ }
    }))
    return { root, base, files: limited, truncated: files.length > limited.length }
  }
  const file = files.find(item => item.path === requestedPath)
  if (!file) throw new Error('文件不在本次 Run 的变更列表中')
  const path = file.path, content = await reviewContent(root, file), binary = content.includes(0)
  const diff = file.status === '?'
    ? binary ? `二进制新增文件：${path}` : `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${content.toString('utf8').split('\n').length} @@\n${content.toString('utf8').split('\n').map(line => `+${line}`).join('\n')}`
    : await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--no-color', base, '--', ...(file.previousPath ? [file.previousPath] : []), path])
  const fingerprint = contentFingerprint(base, file, content)
  return { ...file, diff, fingerprint, binary: binary || diff.includes('Binary files ') } satisfies ReviewFileDetail
}
