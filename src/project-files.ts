import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadProject } from './project'

export type ProjectFileEntry = {
  path: string
  size: number
  modifiedAt: string
  binary: boolean
}

const ignoredDirectories = new Set(['.git', '.next', '.turbo', '.cache', 'node_modules', 'dist', 'build', 'coverage', 'target', '__pycache__', '.venv', 'venv'])
const maxFiles = 4_000
const maxFileSize = 2_000_000

async function projectRoot(): Promise<string> {
  const project = await loadProject()
  if (!project) throw new Error('请先导入项目')
  return realpath(project.repositoryPath)
}

function relativeProjectPath(root: string, requestedPath: string): { path: string; absolute: string } {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new Error('文件路径不能为空')
  const normalized = requestedPath.replaceAll('\\', '/')
  const absolute = resolve(root, normalized)
  const path = relative(root, absolute).replaceAll(sep, '/')
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('文件路径必须位于当前项目中')
  if (path.split('/').some(segment => ignoredDirectories.has(segment))) throw new Error('不能访问项目的内部构建或版本控制目录')
  return { path, absolute }
}

async function existingProjectFile(root: string, requestedPath: string): Promise<{ path: string; absolute: string; details: Awaited<ReturnType<typeof stat>> }> {
  const resolved = relativeProjectPath(root, requestedPath)
  const physicalPath = await realpath(resolved.absolute)
  const physicalRelative = relative(root, physicalPath)
  if (physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) throw new Error('文件路径不能通过符号链接离开当前项目')
  const details = await stat(physicalPath)
  if (!details.isFile()) throw new Error('只能打开文件')
  return { path: resolved.path, absolute: physicalPath, details }
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192))
  return sample.includes(0)
}

async function collectFiles(directory: string, root: string, output: ProjectFileEntry[]): Promise<void> {
  if (output.length >= maxFiles) return
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= maxFiles) return
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue
      await collectFiles(join(directory, entry.name), root, output)
      continue
    }
    if (!entry.isFile()) continue
    const absolute = join(directory, entry.name)
    const details = await stat(absolute)
    if (details.size > maxFileSize) {
      output.push({ path: relative(root, absolute).replaceAll(sep, '/'), size: details.size, modifiedAt: details.mtime.toISOString(), binary: true })
      continue
    }
    const sample = await readFile(absolute)
    output.push({ path: relative(root, absolute).replaceAll(sep, '/'), size: details.size, modifiedAt: details.mtime.toISOString(), binary: looksBinary(sample) })
  }
}

export async function listProjectFiles(): Promise<{ root: string; files: ProjectFileEntry[]; truncated: boolean }> {
  const root = await projectRoot()
  const files: ProjectFileEntry[] = []
  await collectFiles(root, root, files)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { root, files, truncated: files.length >= maxFiles }
}

export async function readProjectFile(requestedPath: string): Promise<{ file: ProjectFileEntry; content: string }> {
  const root = await projectRoot()
  const resolved = await existingProjectFile(root, requestedPath)
  const { details } = resolved
  if (details.size > maxFileSize) throw new Error('文件超过 2 MB，暂不支持在编辑器中打开')
  const buffer = await readFile(resolved.absolute)
  if (looksBinary(buffer)) throw new Error('二进制文件不能在文本编辑器中打开')
  return {
    file: { path: resolved.path, size: Number(details.size), modifiedAt: details.mtime.toISOString(), binary: false },
    content: buffer.toString('utf8'),
  }
}

export async function writeProjectFile(requestedPath: string, content: string): Promise<ProjectFileEntry> {
  if (typeof content !== 'string') throw new Error('文件内容必须是文本')
  if (content.length > maxFileSize) throw new Error('文件内容超过 2 MB 编辑限制')
  if (content.includes('\0')) throw new Error('文件内容包含不可写入的二进制数据')
  const root = await projectRoot()
  const resolved = await existingProjectFile(root, requestedPath)
  const temporary = `${resolved.absolute}.${randomUUID()}.tmp`
  await mkdir(dirname(resolved.absolute), { recursive: true })
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, resolved.absolute)
  const next = await stat(resolved.absolute)
  return { path: resolved.path, size: next.size, modifiedAt: next.mtime.toISOString(), binary: false }
}
