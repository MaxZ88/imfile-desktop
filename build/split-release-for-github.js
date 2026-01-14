const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_RELEASE_DIR = path.resolve(__dirname, '..', 'release')
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 95 * 1024 * 1024
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024
const REPO_ROOT = path.resolve(__dirname, '..')
const BACKUP_ROOT = path.join(REPO_ROOT, 'backup')

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

async function ensureDir (dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true })
}

function getBackupPath (filePath) {
  const relative = path.relative(REPO_ROOT, filePath)
  const isInsideRepo = !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(':')
  if (isInsideRepo) {
    return path.join(BACKUP_ROOT, relative)
  }

  const parsed = path.parse(path.resolve(filePath))
  const root = parsed.root
  const drive = root && root.length >= 2 && root[1] === ':' ? root[0].toUpperCase() : 'ROOT'
  const rest = path.resolve(filePath).slice(root.length)
  return path.join(BACKUP_ROOT, '_external', drive, rest)
}

async function moveToBackup (filePath, { dryRun }) {
  const backupPath = getBackupPath(filePath)
  const backupDir = path.dirname(backupPath)

  if (dryRun) {
    console.log(`[dry-run] move: ${filePath} -> ${backupPath}`)
    return backupPath
  }

  await ensureDir(backupDir)
  await removeFileIfExists(backupPath)
  await fs.promises.rename(filePath, backupPath)
  console.log(`moved: ${filePath} -> ${backupPath}`)
  return backupPath
}

async function splitFileFromSource (sourcePath, { targetDir, baseName, chunkBytes, bufferBytes, dryRun }) {
  const existingParts = await listExistingParts(targetDir, baseName)

  if (existingParts.length > 0) {
    if (!dryRun) {
      for (const partPath of existingParts) {
        await removeFileIfExists(partPath)
      }
    }
  }

  const input = await fs.promises.open(sourcePath, 'r')
  try {
    const stat = await input.stat()
    const totalBytes = stat.size
    const buffer = Buffer.allocUnsafe(bufferBytes)

    let offset = 0
    let part = 1

    while (offset < totalBytes) {
      const partFileName = `${baseName}.part${String(part).padStart(2, '0')}`
      const partPath = path.join(targetDir, partFileName)

      if (dryRun) {
        const end = Math.min(offset + chunkBytes, totalBytes)
        console.log(`[dry-run] split: ${sourcePath} -> ${partPath} (${end - offset} bytes)`)
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
    const filePath = item.filePath
    const targetDir = path.dirname(filePath)
    const baseName = path.basename(filePath)
    console.log(`split: ${filePath} (${item.size} bytes)`)
    const backupPath = await moveToBackup(filePath, { dryRun })
    await splitFileFromSource(backupPath, { targetDir, baseName, chunkBytes, bufferBytes, dryRun })
  }

  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
