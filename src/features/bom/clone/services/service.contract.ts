import type { BomCloneContext, BomCloneFormSection, BomCloneLinkableItem, BomCloneNode, FormFieldDefinition } from '../clone.types'
import type { DuplicatePlanNode } from './deepDuplicate.service'

export type CloneService = {
  validateLinkableItem: (context: BomCloneContext, sourceItemId: number) => Promise<boolean>
  fetchWorkspaceBomViewDefIds: (context: Pick<BomCloneContext, 'tenant' | 'workspaceId' | 'viewDefId'>) => Promise<number[]>
  fetchSourceBomStructure: (
    context: BomCloneContext,
    sourceItemId: number,
    options?: { depth?: number }
  ) => Promise<BomCloneNode[]>
  fetchSourceBomStructureAcrossViews: (
    context: BomCloneContext,
    sourceItemId: number,
    viewDefIds: number[],
    onViewLoad?: (viewDefId: number) => void
  ) => Promise<BomCloneNode[]>
  fetchTargetBomChildItemIds: (context: BomCloneContext) => Promise<number[]>
  fetchTargetBomChildItemIdsAcrossViews: (
    context: BomCloneContext,
    viewDefIds: number[],
    onViewLoad?: (viewDefId: number) => void
  ) => Promise<number[]>
  fetchLinkableItems: (
    context: BomCloneContext,
    options: { search: string; offset: number; limit: number }
  ) => Promise<{ items: BomCloneLinkableItem[]; totalCount: number; offset: number; limit: number }>
  fetchOperationFormDefinition: (
    context: Pick<BomCloneContext, 'tenant' | 'workspaceId'>
  ) => Promise<{ fields: FormFieldDefinition[]; sections: BomCloneFormSection[]; metaLinks: Record<string, string> }>
  fetchItemFieldsForCopy: (
    context: BomCloneContext,
    itemId: number
  ) => Promise<Array<{ fieldId: string; value: string }>>
  deepDuplicateSubtree: (
    context: BomCloneContext,
    plan: DuplicatePlanNode,
    projectId: string
  ) => Promise<number>
  createBomCloneOperationItem: (
    context: BomCloneContext,
    payload: {
      fields: Array<{
        fieldId: string
        value: string
        type: string
        display?: string
      }>
    }
  ) => Promise<number>
  commitBomCloneItem: (
    context: BomCloneContext,
    payload: {
      sourceItemId: number
      itemNumber: number
      quantity: string
      parentItemId?: number
      pinned?: boolean
      fields?: Array<{ link: string; value: string }>
    }
  ) => Promise<void>
  updateBomCloneItem: (
    context: BomCloneContext,
    payload: { edgeId: string; sourceItemId: number; itemNumber: number; quantity: string; pinned?: boolean; fields?: Array<{ link: string; value: string }> }
  ) => Promise<void>
  deleteBomCloneItem: (
    context: BomCloneContext,
    payload: { edgeId: string }
  ) => Promise<void>
}


