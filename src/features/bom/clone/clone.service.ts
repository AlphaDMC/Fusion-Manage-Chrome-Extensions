import type { PlmExtRuntime } from '../../../shared/runtime/types'
import { createApiClient } from './services/api/client'
import { createMutateApi } from './services/api/mutate'
import { createReadApi } from './services/api/read'
import type { CloneService } from './services/service.contract'

type CloneRuntime = Pick<PlmExtRuntime, 'requestPlmAction'>

/**
 * Thin facade/composition root for BOM clone data service.
 * Composes API transport + narrow API service modules.
 */
export type { CloneService }

export function createCloneService(runtime: CloneRuntime): CloneService {
  const client = createApiClient(runtime)
  const readApi = createReadApi({ client })
  const mutateApi = createMutateApi({
    client,
    fetchItemFieldsForCopy: readApi.fetchItemFieldsForCopy.bind(readApi),
  })

  return {
    validateLinkableItem: readApi.validateLinkableItem,
    fetchWorkspaceBomViewDefIds: readApi.fetchWorkspaceBomViewDefIds,
    fetchSourceBomStructure: readApi.fetchSourceBomStructure,
    fetchSourceBomStructureAcrossViews: readApi.fetchSourceBomStructureAcrossViews,
    fetchTargetBomChildItemIds: readApi.fetchTargetBomChildItemIds,
    fetchTargetBomChildItemIdsAcrossViews: readApi.fetchTargetBomChildItemIdsAcrossViews,
    fetchLinkableItems: readApi.fetchLinkableItems,
    fetchOperationFormDefinition: readApi.fetchOperationFormDefinition,
    fetchItemFieldsForCopy: readApi.fetchItemFieldsForCopy,
    deepDuplicateSubtree: mutateApi.deepDuplicateSubtree,
    createBomCloneOperationItem: mutateApi.createBomCloneOperationItem,
    commitBomCloneItem: mutateApi.commitBomCloneItem,
    updateBomCloneItem: mutateApi.updateBomCloneItem,
    deleteBomCloneItem: mutateApi.deleteBomCloneItem
  }
}


