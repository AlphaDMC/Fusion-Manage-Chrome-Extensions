import type { CloneService } from '../service.contract'
import type { DuplicatePlanNode } from '../deepDuplicate.service'
import type { ApiClient } from './client'
import { assertMutationSuccess } from './parse'

type MutateApi = Pick<
  CloneService,
  | 'createBomCloneOperationItem'
  | 'commitBomCloneItem'
  | 'updateBomCloneItem'
  | 'deleteBomCloneItem'
  | 'deepDuplicateSubtree'
>

function resolveSectionsPayload(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (!result || typeof result !== 'object') return []
  const record = result as Record<string, unknown>
  if (Array.isArray(record.sections)) return record.sections as unknown[]
  return []
}

function readCaseInsensitiveValue(record: Record<string, unknown>, key: string): string {
  const direct = record[key]
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const lowerKey = key.toLowerCase()
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (entryKey.toLowerCase() !== lowerKey) continue
    if (typeof entryValue === 'string' && entryValue.trim()) return entryValue.trim()
  }
  return ''
}

function resolveItemLocationCandidate(record: Record<string, unknown>): string {
  const nestedHeaders = record.headers && typeof record.headers === 'object'
    ? record.headers as Record<string, unknown>
    : {}
  const nestedData = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : {}
  const nestedDataHeaders = nestedData.headers && typeof nestedData.headers === 'object'
    ? nestedData.headers as Record<string, unknown>
    : {}

  return (
    readCaseInsensitiveValue(nestedHeaders, 'location')
    || readCaseInsensitiveValue(nestedDataHeaders, 'location')
    || readCaseInsensitiveValue(record, 'location')
    || readCaseInsensitiveValue(nestedData, 'location')
    || readCaseInsensitiveValue(record, '__self__')
    || readCaseInsensitiveValue(nestedData, '__self__')
    || (typeof record.data === 'string' ? record.data.trim() : '')
  )
}

function resolveCreatedItemId(result: unknown): number {
  if (typeof result === 'string') {
    const match = /\/items\/(\d+)\b/i.exec(result.trim())
    const parsed = Number.parseInt(match?.[1] || '', 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  if (!result || typeof result !== 'object') throw new Error('Item creation did not return a valid response')
  const record = result as Record<string, unknown>
  const locationCandidate = resolveItemLocationCandidate(record)
  if (!locationCandidate) throw new Error('Item creation did not return item location')
  const match = /\/items\/(\d+)\b/i.exec(locationCandidate)
  const parsed = Number.parseInt(match?.[1] || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Unable to resolve created item id')
  return parsed
}

export function createMutateApi(params: {
  client: ApiClient
  fetchItemFieldsForCopy: CloneService['fetchItemFieldsForCopy']
}): MutateApi {
  const { client, fetchItemFieldsForCopy } = params

  async function deepDuplicateSubtreeImpl(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    plan: DuplicatePlanNode,
    projectId: string
  ): Promise<number> {
    if (plan.kind === 'reference') {
      const itemId = Number(plan.sourceNode.id)
      if (!Number.isFinite(itemId) || itemId <= 0) {
        throw new Error(`Cannot resolve item ID for reference node: ${plan.sourceNode.label}`)
      }
      return itemId
    }

    const sourceItemId = Number(plan.sourceNode.id)
    if (!Number.isFinite(sourceItemId) || sourceItemId <= 0) {
      throw new Error(`Cannot resolve source item ID for: ${plan.sourceNode.label}`)
    }

    const copiedFields = await fetchItemFieldsForCopy(context, sourceItemId)
    const fieldMap = new Map(copiedFields.map((f) => [f.fieldId, f.value]))

    // Build a unique item number by appending the sanitized project ID to the
    // source item's number. Strip all non-alphanumeric characters from projectId
    // so there are no spaces or special characters in the resulting number.
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9]/g, '')
    const sourceNumber = plan.sourceNode.number ?? ''
    if (sourceNumber) {
      const newNumber = sanitizedProjectId ? sourceNumber + sanitizedProjectId : sourceNumber
      // Find the field whose value matches the source number (the number field
      // may have any field ID depending on workspace configuration). If found,
      // update it in place; otherwise add DESCRIPTOR as a fallback.
      const numberField = copiedFields.find((f) => f.value === sourceNumber)
      fieldMap.set(numberField?.fieldId ?? 'DESCRIPTOR', newNumber)
    }

    const fields = Array.from(fieldMap.entries()).map(([fieldId, value]) => ({
      fieldId,
      value,
      type: 'string' as const,
    }))

    const sectionsResult = await client.fetchSections({
      tenant: context.tenant,
      workspaceId: context.workspaceId,
    })
    const sections = resolveSectionsPayload(sectionsResult)

    const createResult = await client.createItem({
      tenant: context.tenant,
      workspaceId: context.workspaceId,
      sections,
      fields,
    })
    const newItemId = resolveCreatedItemId(createResult)
    if (!newItemId || newItemId <= 0) {
      throw new Error(`Item creation returned invalid ID for: ${plan.sourceNode.label}`)
    }

    for (let i = 0; i < plan.children.length; i++) {
      const childPlan = plan.children[i]
      const childItemId = await deepDuplicateSubtreeImpl(
        context,
        childPlan,
        projectId
      )
      await client.addBomItem({
        tenant: context.tenant,
        wsIdParent: context.workspaceId,
        wsIdChild: context.workspaceId,
        dmsIdParent: newItemId,
        dmsIdChild: childItemId,
        number: i + 1,
        quantity: childPlan.sourceNode.quantity || '1',
      })
    }

    return newItemId
  }

  return {
    async createBomCloneOperationItem(context, payload) {
      const sectionsResult = await client.fetchSections({
        tenant: context.tenant,
        workspaceId: context.workspaceId
      })
      const sections = resolveSectionsPayload(sectionsResult)
      const createResult = await client.createItem({
        tenant: context.tenant,
        workspaceId: context.workspaceId,
        sections,
        fields: payload.fields
      })
      return resolveCreatedItemId(createResult)
    },

    async commitBomCloneItem(context, payload) {
      const result = await client.addBomItem({
        tenant: context.tenant,
        wsIdParent: context.workspaceId,
        wsIdChild: context.workspaceId,
        dmsIdParent: payload.parentItemId ?? context.currentItemId,
        dmsIdChild: payload.sourceItemId,
        number: payload.itemNumber,
        quantity: payload.quantity,
        ...(typeof payload.pinned === 'boolean' ? { pinned: payload.pinned } : {}),
        ...(Array.isArray(payload.fields) && payload.fields.length > 0 ? { fields: payload.fields } : {})
      })
      assertMutationSuccess('add', result)
    },

    async updateBomCloneItem(context, payload) {
      const result = await client.updateBomItem({
        tenant: context.tenant,
        wsIdParent: context.workspaceId,
        wsIdChild: context.workspaceId,
        dmsIdParent: context.currentItemId,
        dmsIdChild: payload.sourceItemId,
        edgeId: payload.edgeId,
        number: payload.itemNumber,
        quantity: payload.quantity,
        ...(typeof payload.pinned === 'boolean' ? { pinned: payload.pinned } : {}),
        ...(Array.isArray(payload.fields) && payload.fields.length > 0 ? { fields: payload.fields } : {})
      })
      assertMutationSuccess('update', result)
    },

    async deleteBomCloneItem(context, payload) {
      const result = await client.removeBomItem({
        tenant: context.tenant,
        wsId: context.workspaceId,
        dmsId: context.currentItemId,
        edgeId: payload.edgeId
      })
      assertMutationSuccess('remove', result)
    },

    deepDuplicateSubtree: deepDuplicateSubtreeImpl,
  }
}


