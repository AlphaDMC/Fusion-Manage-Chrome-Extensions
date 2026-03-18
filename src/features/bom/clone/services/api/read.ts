import type { BomCloneContext, BomCloneLinkableItem, BomCloneNode } from '../../clone.types'
import { buildOperationFormModel } from '../form/operationForm.service'
import { dedupePositiveInts, parsePositiveInt } from '../normalize.service'
import type { CloneService } from '../service.contract'
import { extractCopyableFields } from '../copyItem.service'
import { collectTopLevelChildItemIdsFromTree, mergeBomNodeCollections } from '../structure/tree.service'
import { parseViewDefIdFromLink } from '../form/viewDefLinks'
import { asDisplayString, extractArray, readNodeId, readNodeLabel, toBomTree } from './parseTree'
import { toBomTreeV1 } from './parseTreeV1'
import type { ApiClient } from './client'
import { mapWithConcurrency } from './concurrency'

type ReadApi = Pick<
  CloneService,
  | 'validateLinkableItem'
  | 'fetchWorkspaceBomViewDefIds'
  | 'fetchSourceBomStructure'
  | 'fetchSourceBomStructureAcrossViews'
  | 'fetchTargetBomChildItemIds'
  | 'fetchTargetBomChildItemIdsAcrossViews'
  | 'fetchLinkableItems'
  | 'fetchOperationFormDefinition'
  | 'fetchItemFieldsForCopy'
>

function extractBomViewDefIds(response: unknown): number[] {
  const record = response && typeof response === 'object' ? (response as Record<string, unknown>) : {}
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {}
  const bomViews = Array.isArray(data.bomViews) ? (data.bomViews as Record<string, unknown>[]) : []
  const parsed: number[] = []
  for (const view of bomViews) {
    const direct = parsePositiveInt(view.id)
    if (direct !== null) {
      parsed.push(direct)
      continue
    }
    const linked = parseViewDefIdFromLink(String(view.link || ''))
    if (linked !== null && linked > 0) parsed.push(linked)
  }
  return dedupePositiveInts(parsed)
}


function createViewReader(client: ApiClient, fetchConcurrency: number) {
  const fetchByViewDef = async (
    context: BomCloneContext,
    dmsId: number,
    viewDefId: number | null,
    options?: { depth?: number }
  ): Promise<BomCloneNode[]> => {
    const effectiveDate = new Date().toISOString().slice(0, 10)
    const depth = Number.isFinite(options?.depth) ? Math.max(1, Math.floor(Number(options?.depth))) : 1
    const sourceBom = await client.getBom({
      tenant: context.tenant,
      wsId: context.workspaceId,
      dmsId,
      rootId: dmsId,
      depth,
      effectiveDate,
      revisionBias: 'release',
      headers: { Accept: 'application/vnd.autodesk.plm.bom.bulk+json' },
      ...(viewDefId !== null ? { viewId: viewDefId } : {})
    })
    return toBomTree(sourceBom)
  }

  return {
    fetchByViewDef,
    async fetchWorkspaceBomViewDefIds(context: Pick<BomCloneContext, 'tenant' | 'workspaceId' | 'viewDefId'>) {
      const ids: number[] = []
      if (context.viewDefId !== null) ids.push(context.viewDefId)
      try {
        const response = await client.getBomViews({
          tenant: context.tenant,
          wsId: context.workspaceId
        })
        ids.push(...extractBomViewDefIds(response))
      } catch {
        // Allow fallback to URL context viewDef only.
      }
      return dedupePositiveInts(ids)
    },
    async fetchAcrossViews(
      context: BomCloneContext,
      dmsId: number,
      viewDefIds: number[],
      onViewLoad?: (viewDefId: number) => void
    ): Promise<BomCloneNode[]> {
      const resolvedViewDefIds = dedupePositiveInts([
        ...viewDefIds,
        ...(context.viewDefId !== null ? [context.viewDefId] : [])
      ])

      if (resolvedViewDefIds.length === 0) {
        return fetchByViewDef(context, dmsId, context.viewDefId)
      }

      const trees = await mapWithConcurrency(
        resolvedViewDefIds,
        fetchConcurrency,
        async (viewDefId) => {
          try {
            return await fetchByViewDef(context, dmsId, viewDefId)
          } catch {
            return [] as BomCloneNode[]
          } finally {
            onViewLoad?.(viewDefId)
          }
        }
      )

      return trees.reduce((merged, tree) => mergeBomNodeCollections(merged, tree), [] as BomCloneNode[])
    }
  }
}

function readLinkableItemId(candidate: Record<string, unknown>): number | null {
  const nestedItem = candidate.item && typeof candidate.item === 'object'
    ? candidate.item as Record<string, unknown>
    : null
  const sources = nestedItem ? [nestedItem, candidate] : [candidate]
  for (const source of sources) {
    const parsed = Number(source.dmsId || source.itemId || source.id)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  const seen = new Set<number>()
  const visit = (value: unknown, depth = 0): number | null => {
    if (depth > 6 || value == null) return null
    if (typeof value === 'string') {
      const match = /\/items\/(\d+)\b/i.exec(value)
      if (!match) return null
      const parsed = Number.parseInt(match[1], 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = visit(entry, depth + 1)
        if (nested !== null) return nested
      }
      return null
    }
    if (typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    for (const key of ['dmsId', 'itemId', 'id']) {
      const parsed = Number(record[key])
      if (Number.isFinite(parsed) && parsed > 0 && !seen.has(parsed)) {
        seen.add(parsed)
        return parsed
      }
    }
    for (const nestedValue of Object.values(record)) {
      const nested = visit(nestedValue, depth + 1)
      if (nested !== null) return nested
    }
    return null
  }
  return visit(candidate)
}

function createBomReader(client: ApiClient, fetchByViewDef: ReturnType<typeof createViewReader>['fetchByViewDef']) {
  return async (context: BomCloneContext, dmsId: number, options?: { depth?: number }): Promise<BomCloneNode[]> => {
    const depth = Number.isFinite(options?.depth) ? Math.max(1, Math.floor(Number(options?.depth))) : 1
    let lastError: unknown = null

    try {
      const tree = await fetchByViewDef(context, dmsId, context.viewDefId, options)
      if (tree.length > 0) return tree
      console.debug('[DEEP-DUP] fetchSourceBomStructure falling back to V1: v3 tree empty for item', dmsId)
    } catch (error) {
      lastError = error
      console.debug('[DEEP-DUP] fetchSourceBomStructure falling back to V1: v3 read failed for item', dmsId, error)
      // Fall back to the legacy v1 load path when the viewdef-backed read fails.
    }

    try {
      const response = await client.getBomV1({
        tenant: context.tenant,
        wsId: context.workspaceId,
        dmsId,
        depth
      })
      const tree = toBomTreeV1(response, {
        workspaceId: context.workspaceId,
        rootItemId: dmsId,
        depth
      })
      if (tree.length > 0) return tree
    } catch (error) {
      lastError = error
    }

    if (lastError) throw lastError
    return []
  }
}

export function createReadApi(params: {
  client: ApiClient
  fetchConcurrency?: number
}): ReadApi {
  const { client, fetchConcurrency = 10 } = params
  const viewReader = createViewReader(client, fetchConcurrency)
  const readBomTree = createBomReader(client, viewReader.fetchByViewDef)

  return {
    async validateLinkableItem(context, sourceItemId) {
      const response = await client.fetchBomLinkableItems({
        tenant: context.tenant,
        workspaceId: context.workspaceId,
        currentItemId: context.currentItemId,
        viewId: context.viewId
      }) as { data?: unknown; items?: unknown[] }

      const fromData = extractArray((response?.data as Record<string, unknown> | undefined)?.items)
      const rootArray = extractArray((response as { items?: unknown[] })?.items)
      const candidates = fromData.length > 0 ? fromData : rootArray
      if (candidates.length === 0) return true
      return candidates.some((item) => readLinkableItemId(item) === sourceItemId)
    },

    fetchWorkspaceBomViewDefIds: viewReader.fetchWorkspaceBomViewDefIds,
    fetchSourceBomStructure: readBomTree,
    fetchSourceBomStructureAcrossViews: viewReader.fetchAcrossViews,

    async fetchTargetBomChildItemIds(context) {
      const tree = await readBomTree(context, context.currentItemId, { depth: 1 })
      return collectTopLevelChildItemIdsFromTree(tree, context.currentItemId)
    },

    async fetchTargetBomChildItemIdsAcrossViews(context) {
      const tree = await readBomTree(context, context.currentItemId, { depth: 1 })
      return collectTopLevelChildItemIdsFromTree(tree, context.currentItemId)
    },

    async fetchLinkableItems(context, options) {
      const response = await client.fetchBomLinkableItems({
        tenant: context.tenant,
        workspaceId: context.workspaceId,
        currentItemId: context.currentItemId,
        viewId: context.viewId,
        relatedWorkspaceId: context.workspaceId,
        search: options.search || '',
        sort: 'item.title desc',
        limit: options.limit,
        offset: options.offset
      }) as { data?: unknown }

      const data =
        response?.data && typeof response.data === 'object'
          ? (response.data as Record<string, unknown>)
          : (response as unknown as Record<string, unknown>)
      const items = extractArray(data.items).map((entry) => {
        const itemRaw = entry.item
        const item = itemRaw && typeof itemRaw === 'object' ? (itemRaw as Record<string, unknown>) : {}
        const workspaceRaw = entry.workspace
        const workspace = workspaceRaw && typeof workspaceRaw === 'object' ? (workspaceRaw as Record<string, unknown>) : {}
        const lifecycleRaw = entry.lifecycle
        const lifecycle = lifecycleRaw && typeof lifecycleRaw === 'object' ? (lifecycleRaw as Record<string, unknown>) : {}
        const id = Number(readNodeId(item, '0'))
        return {
          id,
          label: readNodeLabel(item, `Item ${id}`),
          workspace: asDisplayString(workspace.title) || '',
          lifecycle: asDisplayString(lifecycle.title) || ''
        } satisfies BomCloneLinkableItem
      }).filter((entry) => Number.isFinite(entry.id) && entry.id > 0)

      return {
        items,
        totalCount: Number(data.totalCount) || items.length,
        offset: Number(data.offset) || options.offset || 0,
        limit: Number(data.limit) || options.limit || 100
      }
    },

    async fetchItemFieldsForCopy(context, itemId) {
      const payload = await client.getItemDetails({
        tenant: context.tenant,
        workspaceId: context.workspaceId,
        dmsId: itemId,
      })
      return extractCopyableFields(payload)
    },

    async fetchOperationFormDefinition(context) {
      const [fieldsPayload, sectionsPayload] = await Promise.all([
        client.fetchFields({
          tenant: context.tenant,
          workspaceId: context.workspaceId
        }),
        client.fetchSections({
          tenant: context.tenant,
          workspaceId: context.workspaceId
        })
      ])

      return buildOperationFormModel(fieldsPayload, sectionsPayload)
    }
  }
}
