import type { PlmExtRuntime } from '../../../../../shared/runtime/types'

type Runtime = Pick<PlmExtRuntime, 'requestPlmAction'>

export type ApiClient = {
  getBom: (payload: Record<string, unknown>) => Promise<unknown>
  getBomV1: (payload: Record<string, unknown>) => Promise<unknown>
  getBomViews: (payload: Record<string, unknown>) => Promise<unknown>
  fetchFields: (payload: Record<string, unknown>) => Promise<unknown>
  fetchSections: (payload: Record<string, unknown>) => Promise<unknown>
  createItem: (payload: Record<string, unknown>) => Promise<unknown>
  getItemDetails: (payload: Record<string, unknown>) => Promise<unknown>
  fetchBomLinkableItems: (payload: Record<string, unknown>) => Promise<unknown>
  addBomItem: (payload: Record<string, unknown>) => Promise<unknown>
  updateBomItem: (payload: Record<string, unknown>) => Promise<unknown>
  removeBomItem: (payload: Record<string, unknown>) => Promise<unknown>
}

/**
 * Small transport adapter around requestPlmAction.
 * This stays outside React so BOM UI doesn't know anything about extension messaging.
 */
export function createApiClient(runtime: Runtime): ApiClient {
  return {
    getBom(payload) {
      return runtime.requestPlmAction('getBom', payload)
    },
    getBomV1(payload) {
      return runtime.requestPlmAction('getBomV1', payload)
    },
    getBomViews(payload) {
      return runtime.requestPlmAction('getBomViews', payload)
    },
    fetchFields(payload) {
      return runtime.requestPlmAction('fetchFields', payload)
    },
    fetchSections(payload) {
      return runtime.requestPlmAction('fetchSections', payload)
    },
    createItem(payload) {
      return runtime.requestPlmAction('createItem', payload)
    },
    getItemDetails(payload) {
      return runtime.requestPlmAction('getItemDetails', payload)
    },
    fetchBomLinkableItems(payload) {
      return runtime.requestPlmAction('fetchBomLinkableItems', payload)
    },
    addBomItem(payload) {
      return runtime.requestPlmAction('addBomItem', payload)
    },
    updateBomItem(payload) {
      return runtime.requestPlmAction('updateBomItem', payload)
    },
    removeBomItem(payload) {
      return runtime.requestPlmAction('removeBomItem', payload)
    }
  }
}


