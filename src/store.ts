import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ArtifactVersion } from './domain'

export type StoreSnapshot = { artifacts: ArtifactVersion[] }

export class JsonArtifactStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoreSnapshot> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoreSnapshot
    } catch {
      return { artifacts: [] }
    }
  }

  async save(snapshot: StoreSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), 'utf8')
  }
}
