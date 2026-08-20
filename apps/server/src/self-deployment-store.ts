import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SelfDeploymentStorePort } from '@loom/application'

/**
 * `SelfDeploymentStorePort` over one file on the local filesystem.
 *
 * The only interesting part is the write, and it is the whole reason this is a port rather
 * than two lines inline: **the pointer is written by rename.** `writeFile` onto the live path
 * truncates first, so a crash between truncate and flush leaves a zero-length or half-written
 * file — and the reader that would meet it is a recovery script trying to find out which
 * revision to put back. Losing the pointer at exactly the moment it is needed is the failure
 * this adapter exists to make impossible.
 *
 * `rename` within one directory is atomic on every filesystem this platform runs on, so a
 * reader sees the old pointer or the new one. The temporary file is a sibling rather than in
 * the system temp directory, because a rename across devices is a copy and a copy is not
 * atomic.
 *
 * Not fsync'd, and that is a deliberate stopping point: surviving a power cut mid-rename is a
 * different guarantee from surviving a crashed process, it costs a flush on every promotion,
 * and the recovery for a lost pointer is the drill — a checkout at a known-good commit, which
 * is the path a deployment in that state needs anyway.
 */
export const fileSelfDeploymentStore = (path: string): SelfDeploymentStorePort => ({
  async read() {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  },

  async write(text) {
    const dir = dirname(path)
    await mkdir(dir, { recursive: true })
    const staging = join(dir, `.${process.pid}.deployment.tmp`)
    await writeFile(staging, text, 'utf8')
    await rename(staging, path)
  },
})
