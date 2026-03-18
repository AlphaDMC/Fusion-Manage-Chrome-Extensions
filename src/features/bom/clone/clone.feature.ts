import type { PlmExtRuntime } from '../../../shared/runtime/types'
import { createCloneDom } from './clone.dom'
import { createEmptyBomClonePermissions, resolveBomClonePermissions, type BomClonePermissions } from './clone.permissions'
import type { CloneQuickCreateAction } from './clone.types'

type CloneRuntime = Pick<PlmExtRuntime, 'requestPlmAction' | 'openModal' | 'closeModal' | 'findByIdDeep'>
type CloneControllerModule = typeof import('./clone.controller')
type CloneController = ReturnType<CloneControllerModule['createCloneController']>

export type BomCloneFeature = {
  mount: () => void
  update: () => void
  unmount: () => void
}

export function createBomCloneFeature(runtime: CloneRuntime): BomCloneFeature {
  const dom = createCloneDom(runtime)
  let controller: CloneController | null = null
  let controllerLoadPromise: Promise<CloneController> | null = null
  let mounted = false
  let stopDomObservation: (() => void) | null = null
  let refreshTimer: number | null = null
  let keepAliveTimer: number | null = null
  let lastUrl = window.location.href
  const navEventName = 'plm-extension-location-change'
  let permissionContextKey: string | null = null
  let permissionLoadInFlight: Promise<BomClonePermissions> | null = null
  let permissions = createEmptyBomClonePermissions()
  let permissionsResolved = false

  function clearRefreshTimer(): void {
    if (refreshTimer === null) return
    window.clearTimeout(refreshTimer)
    refreshTimer = null
  }

  function clearKeepAliveTimer(): void {
    if (keepAliveTimer === null) return
    window.clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }

  function stopObserver(): void {
    if (!stopDomObservation) return
    stopDomObservation()
    stopDomObservation = null
  }

  function clearPermissionState(): void {
    permissionLoadInFlight = null
    permissions = createEmptyBomClonePermissions()
    permissionsResolved = false
  }

  function scheduleSync(delayMs = 0): void {
    if (controller) {
      controller.update()
      return
    }
    if (refreshTimer !== null) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      syncLauncher()
    }, Math.max(0, delayMs))
  }

  function onUrlMaybeChanged(): void {
    const currentUrl = window.location.href
    if (currentUrl === lastUrl) return
    lastUrl = currentUrl
    scheduleSync(0)
  }

  function ensureObserver(): void {
    if (controller || stopDomObservation) return
    stopDomObservation = dom.observeCloneButtonPresence((delayMs) => scheduleSync(delayMs))
  }

  async function ensureController(): Promise<CloneController> {
    if (controller) return controller
    if (controllerLoadPromise) return controllerLoadPromise

    controllerLoadPromise = import('./clone.controller')
      .then((module) => {
        controller = module.createCloneController(runtime)
        return controller
      })
      .finally(() => {
        controllerLoadPromise = null
      })

    const loadedController = await controllerLoadPromise
    if (mounted) {
      stopObserver()
      clearRefreshTimer()
      clearKeepAliveTimer()
      loadedController.mount()
    }
    return loadedController
  }

  async function openClone(action: CloneQuickCreateAction): Promise<void> {
    const loadedController = await ensureController()
    await loadedController.launchQuickCreateAction(action)
  }

  function syncLauncher(): void {
    if (controller) {
      controller.update()
      return
    }

    const isBom = dom.isBomTab(window.location.href)
    if (!isBom) {
      dom.removeCloneButton()
      permissionContextKey = null
      clearPermissionState()
      return
    }

    const resolvedContext = dom.resolveContext(window.location.href)
    if (!resolvedContext) {
      dom.removeCloneButton()
      return
    }

    const nextPermissionKey = `${resolvedContext.tenant}:${resolvedContext.workspaceId}`
    if (permissionContextKey !== nextPermissionKey) {
      permissionContextKey = nextPermissionKey
      clearPermissionState()
    }

    if (!permissionsResolved) {
      if (!permissionLoadInFlight) {
        permissionLoadInFlight = resolveBomClonePermissions(runtime, resolvedContext.tenant, resolvedContext.workspaceId)
          .then((nextPermissions) => {
            if (permissionContextKey === nextPermissionKey) {
              permissions = nextPermissions
              permissionsResolved = true
            }
            return nextPermissions
          })
          .catch(() => {
            const fallback = createEmptyBomClonePermissions()
            if (permissionContextKey === nextPermissionKey) {
              permissions = fallback
              permissionsResolved = true
            }
            return fallback
          })
          .finally(() => {
            permissionLoadInFlight = null
            scheduleSync(0)
          })
      }
      dom.removeCloneButton()
      return
    }

    if (!permissions.canAdd) {
      dom.removeCloneButton()
      return
    }

    dom.ensureCloneButton((action) => {
      void openClone(action)
    }, {
      disabled: false,
      title: 'Quick Create'
    })
  }

  return {
    mount() {
      if (!mounted) {
        mounted = true
        lastUrl = window.location.href
        window.addEventListener(navEventName, onUrlMaybeChanged)
        window.addEventListener('hashchange', onUrlMaybeChanged)
        window.addEventListener('popstate', onUrlMaybeChanged)
      }

      if (controller) {
        controller.mount()
        return
      }

      ensureObserver()
      syncLauncher()

      if (keepAliveTimer === null) {
        keepAliveTimer = window.setInterval(() => {
          if (controller) return
          if (!dom.isBomTab(window.location.href)) return
          if (!dom.isCloneButtonPresent()) scheduleSync(0)
        }, 300)
      }
    },
    update() {
      if (controller) {
        controller.update()
        return
      }
      scheduleSync(0)
    },
    unmount() {
      if (mounted) {
        mounted = false
        window.removeEventListener(navEventName, onUrlMaybeChanged)
        window.removeEventListener('hashchange', onUrlMaybeChanged)
        window.removeEventListener('popstate', onUrlMaybeChanged)
      }

      clearRefreshTimer()
      clearKeepAliveTimer()
      stopObserver()
      permissionContextKey = null
      clearPermissionState()

      if (controller) {
        controller.unmount()
        return
      }

      dom.removeCloneButton()
    }
  }
}
