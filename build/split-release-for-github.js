const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_RELEASE_DIR = path.resolve(__dirname, '..', 'release')
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 95 * 1024 * 1024
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024

function parseArgs (argv) {
  const args = {
    dir: DEFAULT_RELEASE_DIR,
    maxBytes: DEFAULT_MAX_BYTES,
    chunkBytes: DEFAULT_CHUNK_BYTES,
    dryRun: false
  }

  for (let i = 2; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (value.startsWith('--dir=')) {
      args.dir = path.resolve(value.slice('--dir='.length))
      continue
    }
    if (value.startsWith('--max-bytes=')) {
      args.maxBytes = Number(value.slice('--max-bytes='.length))
      continue
    }
    if (value.startsWith('--chunk-bytes=')) {
      args.chunkBytes = Number(value.slice('--chunk-bytes='.length))
      continue
    }
  }

  if (!Number.isFinite(args.maxBytes) || args.maxBytes <= 0) {
    throw new Error(`Invalid --max-bytes: ${args.maxBytes}`)
  }
  if (!Number.isFinite(args.chunkBytes) || args.chunkBytes <= 0) {
    throw new Error(`Invalid --chunk-bytes: ${args.chunkBytes}`)
  }
  if (args.chunkBytes > args.maxBytes) {
    throw new Error(`--chunk-bytes (${args.chunkBytes}) must be <= --max-bytes (${args.maxBytes})`)
  }

  return args
}

async function walkFiles (dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkFiles(fullPath))
      continue
    }
    if (entry.isFile()) {
      results.push(fullPath)
    }
  }

  return results
}

function isPartFile (filePath) {
  return /\.part\d{2}$/i.test(filePath)
}

async function listExistingParts (dir, baseName) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  const prefix = `${baseName}.part`
  const parts = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.startsWith(prefix)) continue
    if (!/\.part\d{2}$/i.test(entry.name)) continue
    parts.push(path.join(dir, entry.name))
  }

  parts.sort((a, b) => a.localeCompare(b))
  return parts
}

async function removeFileIfExists (filePath) {
  try {
    await fs.promises.unlink(filePath)
  } catch (e) {
    if (e && e.code === 'ENOENT') return
    throw e
  }
}

async function splitFile (filePath, { chunkBytes, bufferBytes, dryRun }) {
  const dir = path.dirname(filePath)
  const baseName = path.basename(filePath)

  const existingParts = await listExistingParts(dir, baseName)
  if (existingParts.length > 0) {
    if (!dryRun) {
      for (const partPath of existingParts) {
        await removeFileIfExists(partPath)
      }
    }
  }

  const input = await fs.promises.open(filePath, 'r')
  try {
    const stat = await input.stat()
    const totalBytes = stat.size
    const buffer = Buffer.allocUnsafe(bufferBytes)

    let offset = 0
    let part = 1

    while (offset < totalBytes) {
      const partFileName = `${baseName}.part${String(part).padStart(2, '0')}`
      const partPath = path.join(dir, partFileName)

      if (dryRun) {
        const end = Math.min(offset + chunkBytes, totalBytes)
        console.log(`[dry-run] split: ${filePath} -> ${partPath} (${end - offset} bytes)`)
        offset = end
        part++
        continue
      }

      const output = await fs.promises.open(partPath, 'w')
      try {
        let remaining = Math.min(chunkBytes, totalBytes - offset)
        while (remaining > 0) {
          const readSize = Math.min(buffer.length, remaining)
          const { bytesRead } = await input.read(buffer, 0, readSize, offset)
          if (bytesRead <= 0) break
          await output.write(buffer, 0, bytesRead)
          offset += bytesRead
          remaining -= bytesRead
        }
      } finally {
        await output.close()
      }

      part++
    }
  } finally {
    await input.close()
  }

  if (!dryRun) {
    await removeFileIfExists(filePath)
  }
}

async function main () {
  const { dir, maxBytes, chunkBytes, dryRun } = parseArgs(process.argv)
  const bufferBytes = DEFAULT_BUFFER_BYTES

  if (!fs.existsSync(dir)) {
    console.log(`skip: release dir not found: ${dir}`)
    return
  }

  const files = await walkFiles(dir)
  const candidates = []

  for (const filePath of files) {
    if (isPartFile(filePath)) continue
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) continue
    if (stat.size <= maxBytes) continue
    candidates.push({ filePath, size: stat.size })
  }

  candidates.sort((a, b) => b.size - a.size)

  if (candidates.length === 0) {
    console.log('ok: no files exceed GitHub limit')
    return
  }

  console.log(`found ${candidates.length} file(s) > ${maxBytes} bytes`)
  for (const item of candidates) {
    console.log(`split: ${item.filePath} (${item.size} bytes)`)
    await splitFile(item.filePath, { chunkBytes, bufferBytes, dryRun })
  }

  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

