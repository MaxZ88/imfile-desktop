import { ipcRenderer } from 'electron'
import is from 'electron-is'
import { isEmpty, clone } from 'lodash'
import { Aria2 } from '@shared/aria2'
import {
  separateConfig,
  compactUndefined,
  formatOptionsForEngine,
  mergeTaskResult,
  changeKeysToCamelCase,
  changeKeysToKebabCase,
  mapRemotePathToLocal
} from '@shared/utils'
import { ENGINE_RPC_HOST } from '@shared/constants'

export default class Api {
  constructor (options = {}) {
    this.options = options

    this.client = new Aria2()
    this.ready = this.init()
  }

  async init () {
    this.config = await this.loadConfig()
    this.applyClientConfig()
    this.openClient()
  }

  loadConfigFromLocalStorage () {
    // TODO
    const result = {}
    return result
  }

  async loadConfigFromNativeStore () {
    const result = await ipcRenderer.invoke('get-app-config')
    return result
  }

  async loadConfig () {
    let result = is.renderer()
      ? await this.loadConfigFromNativeStore()
      : this.loadConfigFromLocalStorage()

    result = changeKeysToCamelCase(result)
    return result
  }

  getRpcClientOptions () {
    const {
      rpcMode,
      rpcListenPort,
      rpcSecret,
      rpcRemoteHost,
      rpcRemotePort,
      rpcRemoteSecret,
      rpcRemoteSecure,
      rpcRemotePath
    } = this.config || {}

    if (rpcMode === 'remote') {
      return {
        host: rpcRemoteHost,
        port: rpcRemotePort,
        secret: rpcRemoteSecret,
        secure: rpcRemoteSecure,
        path: rpcRemotePath || '/jsonrpc'
      }
    }

    return {
      host: ENGINE_RPC_HOST,
      port: rpcListenPort,
      secret: rpcSecret,
      secure: false,
      path: '/jsonrpc'
    }
  }

  applyClientConfig () {
    const { host, port, secret, secure, path } = this.getRpcClientOptions()

    this.client.host = host
    this.client.port = port
    this.client.secret = secret
    this.client.secure = !!secure
    this.client.path = path || '/jsonrpc'
  }

  forceCloseClientSocket () {
    if (!this.client || !this.client.socket) {
      return
    }
    try {
      this.client.socket.close()
    } catch (e) {
      return e
    }
    this.client.socket = null
  }

  openClient () {
    this.forceCloseClientSocket()
    this.client.open().catch((e) => e)
  }

  async reloadConfigAndReconnect () {
    this.config = await this.loadConfig()
    this.applyClientConfig()
    this.openClient()
    return this.config
  }

  async fetchPreference () {
    this.config = await this.loadConfig()
    return this.config
  }

  isRemoteMode () {
    return this.config && this.config.rpcMode === 'remote'
  }

  getRemotePathMappingOptions () {
    const { rpcRemoteDownloadDir: remoteDir, rpcRemoteMountPath: mountPath } = this.config || {}
    return { remoteDir, mountPath }
  }

  shouldApplyRemotePathMapping () {
    const { remoteDir, mountPath } = this.getRemotePathMappingOptions()
    return this.isRemoteMode() && !isEmpty(remoteDir) && !isEmpty(mountPath)
  }

  mapTaskPaths (task) {
    if (!task || !this.shouldApplyRemotePathMapping()) {
      return task
    }

    const mapping = this.getRemotePathMappingOptions()
    if (task.dir) {
      task.dir = mapRemotePathToLocal(task.dir, mapping)
    }
    if (Array.isArray(task.files)) {
      task.files.forEach((file) => {
        if (file && file.path) {
          file.path = mapRemotePathToLocal(file.path, mapping)
        }
      })
    }
    return task
  }

  mapTaskListPaths (taskList) {
    if (!Array.isArray(taskList) || !this.shouldApplyRemotePathMapping()) {
      return taskList
    }
    taskList.forEach((task) => this.mapTaskPaths(task))
    return taskList
  }

  savePreference (params = {}) {
    const kebabParams = changeKeysToKebabCase(params)
    if (is.renderer()) {
      return this.savePreferenceToNativeStore(kebabParams)
    } else {
      return this.savePreferenceToLocalStorage(kebabParams)
    }
  }

  savePreferenceToLocalStorage () {
    // TODO
  }

  savePreferenceToNativeStore (params = {}) {
    const { user, system, others } = separateConfig(params)
    const config = {}

    if (!isEmpty(user)) {
      console.info('[imFile] save user config: ', user)
      config.user = user
    }

    if (!isEmpty(system)) {
      console.info('[imFile] save system config: ', system)
      config.system = system
      this.updateActiveTaskOption(system)
    }

    if (!isEmpty(others)) {
      console.info('[imFile] save config found illegal key: ', others)
    }

    ipcRenderer.send('command', 'application:save-preference', config)
  }

  getVersion () {
    return this.client.call('getVersion')
  }

  changeGlobalOption (options) {
    const args = formatOptionsForEngine(options)

    return this.client.call('changeGlobalOption', args)
  }

  getGlobalOption () {
    return new Promise((resolve) => {
      this.client.call('getGlobalOption').then((data) => {
        resolve(changeKeysToCamelCase(data))
      })
    })
  }

  getOption (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])

    return new Promise((resolve) => {
      this.client.call('getOption', ...args).then((data) => {
        resolve(changeKeysToCamelCase(data))
      })
    })
  }

  updateActiveTaskOption (options) {
    this.fetchTaskList({ type: 'active' }).then((data) => {
      if (isEmpty(data)) {
        return
      }

      const gids = data.map((task) => task.gid)
      this.batchChangeOption({ gids, options })
    })
  }

  changeOption (params = {}) {
    const { gid, options = {} } = params

    const engineOptions = formatOptionsForEngine(options)
    const args = compactUndefined([gid, engineOptions])

    return this.client.call('changeOption', ...args)
  }

  getGlobalStat () {
    return this.client.call('getGlobalStat')
  }

  addUri (params) {
    const { uris, outs, options } = params
    const tasks = uris.map((uri, index) => {
      const engineOptions = formatOptionsForEngine(options)
      if (outs && outs[index]) {
        engineOptions.out = outs[index]
      }
      const args = compactUndefined([[uri], engineOptions])
      return ['aria2.addUri', ...args]
    })
    return this.client.multicall(tasks)
  }

  addTorrent (params) {
    const { torrent, options } = params
    const engineOptions = formatOptionsForEngine(options)
    const args = compactUndefined([torrent, [], engineOptions])
    return this.client.call('addTorrent', ...args)
  }

  addMetalink (params) {
    const { metalink, options } = params
    const engineOptions = formatOptionsForEngine(options)
    const args = compactUndefined([metalink, engineOptions])
    return this.client.call('addMetalink', ...args)
  }

  fetchDownloadingTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const activeArgs = compactUndefined([keys])
    const waitingArgs = compactUndefined([offset, num, keys])
    return new Promise((resolve, reject) => {
      this.client
        .multicall([
          ['aria2.tellActive', ...activeArgs],
          ['aria2.tellWaiting', ...waitingArgs]
        ])
        .then((data) => {
          console.log('[imFile] fetch downloading task list data:', data)
          const result = mergeTaskResult(data)
          const list = result.filter(
            (item) => item.completedLength !== item.totalLength
          )
          resolve(this.mapTaskListPaths(list))
        })
        .catch((err) => {
          console.log('[imFile] fetch downloading task list fail:', err)
          reject(err)
        })
    })
  }

  fetchWaitingTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const args = compactUndefined([offset, num, keys])
    return this.client.call('tellWaiting', ...args).then((data) => {
      return this.mapTaskListPaths(data)
    })
  }

  fetchStoppedTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const args = compactUndefined([offset, num, keys])
    return this.client.call('tellStopped', ...args).then((data) => {
      return this.mapTaskListPaths(data)
    })
  }

  fetchDoneTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const args = compactUndefined([offset, num, keys])
    return this.client.call('tellDone', ...args).then((data) => {
      return this.mapTaskListPaths(data)
    })
  }

  fetchActiveTaskList (params = {}) {
    const { keys } = params
    const args = compactUndefined([keys])
    return this.client.call('tellActive', ...args).then((data) => {
      return this.mapTaskListPaths(data)
    })
  }

  fetchSeedingTaskList (params = {}) {
    const { keys } = params
    const args = compactUndefined([keys])
    return new Promise((resolve, reject) => {
      this.client
        .call('tellActive', ...args)
        .then((data) => {
          console.log('[imFile] fetch seeding task list data:', data)
          if (data.length > 0) {
            const list = data.filter((item) => item.completedLength === item.totalLength)
            resolve(this.mapTaskListPaths(list))
          } else {
            resolve([])
          }
        })
        .catch((err) => {
          console.log('[imFile] fetch seeding task list fail:', err)
          reject(err)
        })
    })
  }

  fetchAllTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const activeArgs = compactUndefined([keys])
    const waitingArgs = compactUndefined([offset, num, keys])
    return new Promise((resolve, reject) => {
      this.client
        .multicall([
          ['aria2.tellActive', ...activeArgs],
          ['aria2.tellWaiting', ...waitingArgs],
          ['aria2.tellStopped', ...waitingArgs]
        ])
        .then((data) => {
          console.log('[imFile] fetch downloading task list data:', data)
          // const result = mergeTaskResult(data)
          resolve(
            data
          )
        })
        .catch((err) => {
          console.log('[imFile] fetch downloading task list fail:', err)
          reject(err)
        })
    })
  }

  fetchTaskList (params = {}) {
    const { type } = params
    switch (type) {
    case 'seeding':
      return this.fetchSeedingTaskList(params)
    case 'active':
      return this.fetchDownloadingTaskList(params)
    case 'waiting':
      return this.fetchWaitingTaskList(params)
    case 'stopped':
      return this.fetchStoppedTaskList(params)
    case 'done':
      return this.fetchStoppedTaskList(params)
    default:
      return this.fetchDownloadingTaskList(params)
    }
  }

  fetchTaskItem (params = {}) {
    const { gid, keys } = params
    const args = compactUndefined([gid, keys])
    return this.client.call('tellStatus', ...args).then((task) => {
      return this.mapTaskPaths(task)
    })
  }

  fetchTaskItemWithPeers (params = {}) {
    const { gid, keys } = params
    const statusArgs = compactUndefined([gid, keys])
    const peersArgs = compactUndefined([gid])
    return new Promise((resolve, reject) => {
      this.client
        .multicall([
          ['aria2.tellStatus', ...statusArgs],
          ['aria2.getPeers', ...peersArgs]
        ])
        .then((data) => {
          console.log('[imFile] fetchTaskItemWithPeers:', data)
          const result = data[0] && data[0][0]
          const peers = data[1] && data[1][0]
          result.peers = peers || []
          console.log('[imFile] fetchTaskItemWithPeers.result:', result)
          console.log('[imFile] fetchTaskItemWithPeers.peers:', peers)

          resolve(this.mapTaskPaths(result))
        })
        .catch((err) => {
          console.log('[imFile] fetch downloading task list fail:', err)
          reject(err)
        })
    })
  }

  fetchTaskItemPeers (params = {}) {
    const { gid, keys } = params
    const args = compactUndefined([gid, keys])
    return this.client.call('getPeers', ...args)
  }

  pauseTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('pause', ...args)
  }

  pauseAllTask (params = {}) {
    return this.client.call('pauseAll')
  }

  forcePauseTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('forcePause', ...args)
  }

  forcePauseAllTask (params = {}) {
    return this.client.call('forcePauseAll')
  }

  resumeTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('unpause', ...args)
  }

  resumeAllTask (params = {}) {
    return this.client.call('unpauseAll')
  }

  removeTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('remove', ...args)
  }

  forceRemoveTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('forceRemove', ...args)
  }

  saveSession (params = {}) {
    return this.client.call('saveSession')
  }

  purgeTaskRecord (params = {}) {
    return this.client.call('purgeDownloadResult')
  }

  removeTaskRecord (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('removeDownloadResult', ...args)
  }

  multicall (method, params = {}) {
    let { gids, options = {} } = params
    options = formatOptionsForEngine(options)

    const data = gids.map((gid, index) => {
      const _options = clone(options)
      const args = compactUndefined([gid, _options])
      return [method, ...args]
    })
    return this.client.multicall(data)
  }

  batchChangeOption (params = {}) {
    return this.multicall('aria2.changeOption', params)
  }

  batchRemoveTask (params = {}) {
    return this.multicall('aria2.remove', params)
  }

  batchResumeTask (params = {}) {
    return this.multicall('aria2.unpause', params)
  }

  batchPauseTask (params = {}) {
    return this.multicall('aria2.pause', params)
  }

  batchForcePauseTask (params = {}) {
    return this.multicall('aria2.forcePause', params)
  }
}
