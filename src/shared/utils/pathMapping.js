import { join } from 'node:path'

const normalizePosixPath = (value) => {
  return `${value || ''}`.replace(/\\/g, '/').trim()
}

const normalizeRemoteRoot = (value) => {
  let p = normalizePosixPath(value)
  p = p.replace(/\/+$/g, '')
  return p
}

export const mapRemotePathToLocal = (remotePath, { remoteDir, mountPath } = {}) => {
  const rp = normalizePosixPath(remotePath)
  const rd = normalizeRemoteRoot(remoteDir)
  const mp = `${mountPath || ''}`.trim()

  if (!rp || !rd || !mp) {
    return remotePath
  }

  if (rp === rd) {
    return mp
  }

  const prefix = `${rd}/`
  if (!rp.startsWith(prefix)) {
    return remotePath
  }

  const relative = rp.slice(prefix.length)
  const segments = relative.split('/').filter(Boolean)
  if (segments.length === 0) {
    return mp
  }

  return join(mp, ...segments)
}
