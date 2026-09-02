import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { importProject } from './project'
import { listProjectFiles, readProjectFile, writeProjectFile } from './project-files'

const execFileAsync = promisify(execFile)

test('project file service lists editable files and keeps access inside the imported project', async () => {
  const state = await mkdtemp(join(tmpdir(), 'artifact-files-state-'))
  const repository = await mkdtemp(join(tmpdir(), 'artifact-files-repository-'))
  const outside = await mkdtemp(join(tmpdir(), 'artifact-files-outside-'))
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    await execFileAsync('git', ['init', '-q', repository])
    await mkdir(join(repository, 'node_modules'))
    await mkdir(join(repository, 'src'))
    await writeFile(join(repository, 'README.md'), '# Initial\n', 'utf8')
    await writeFile(join(repository, 'src', 'index.ts'), 'export const value = 1\n', 'utf8')
    await writeFile(join(repository, 'node_modules', 'hidden.js'), 'hidden', 'utf8')
    await writeFile(join(repository, '.git', 'config'), 'hidden', 'utf8')
    await writeFile(join(repository, 'image.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(outside, 'private.txt'), 'outside', 'utf8')
    await symlink(join(outside, 'private.txt'), join(repository, 'escape.txt'))
    await importProject(repository)

    const listed = await listProjectFiles()
    assert.deepEqual(listed.files.map(file => file.path), ['image.bin', 'README.md', 'src/index.ts'])
    assert.equal(listed.files.find(file => file.path === 'image.bin')?.binary, true)
    assert.equal((await readProjectFile('README.md')).content, '# Initial\n')

    const saved = await writeProjectFile('src/index.ts', 'export const value = 2\n')
    assert.equal(saved.path, 'src/index.ts')
    assert.equal((await readProjectFile('src/index.ts')).content, 'export const value = 2\n')
    await assert.rejects(() => readProjectFile('../private.txt'), /当前项目/)
    await assert.rejects(() => readProjectFile('node_modules/hidden.js'), /内部构建/)
    await assert.rejects(() => readProjectFile('image.bin'), /二进制/)
    await assert.rejects(() => readProjectFile('escape.txt'), /符号链接/)
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(state, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
