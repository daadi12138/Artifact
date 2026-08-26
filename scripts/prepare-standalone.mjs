import { access, cp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const standaloneRoot = resolve(import.meta.dirname, '..', '.next', 'standalone')
const staticRoot = resolve(import.meta.dirname, '..', '.next', 'static')
await access(resolve(standaloneRoot, 'server.js'))
await access(staticRoot)
await cp(staticRoot, resolve(standaloneRoot, '.next', 'static'), { recursive: true, force: true })
await rm(resolve(standaloneRoot, '.artifact'), { recursive: true, force: true })
await rm(resolve(standaloneRoot, '.artifact-desktop-dev'), { recursive: true, force: true })
