import type { CloneService } from '../service.contract'
import type { DuplicatePlanNode } from '../deepDuplicate.service'
import { extractCopyableFields, type CopyableField } from '../copyItem.service'
import { normalizeQuantity } from '../normalize.service'
import type { ApiClient } from './client'
import { assertMutationSuccess } from './parse'
import { extractBomMutationErrorMessage } from './parse'
import { mapWithConcurrency } from './concurrency'

type MutateApi = Pick<
  CloneService,
  | 'createBomCloneOperationItem'
  | 'commitBomCloneItem'
  | 'updateBomCloneItem'
  | 'deleteBomCloneItem'
  | 'deepDuplicateSubtree'
>

function normalizeCreateItemError(error: unknown, requestedNumber: string): Error {
  const fallback = 'Item creation failed'
  const message = extractBomMutationErrorMessage(error, fallback)
  const normalized = message.trim()
  const duplicateNumber =
    /cannot have duplicates/i.test(normalized)
    || /error\.unique/i.test(normalized)

  if (duplicateNumber && requestedNumber) {
    return new Error(
      `NUMBER already exists: ${requestedNumber}. Use a different suffix or delete the partial clone item first.`
    )
  }

  return new Error(normalized || fallback)
}

function sumQuantities(left: string, right: string): string {
  const normalizedLeft = normalizeQuantity(left, '0')
  const normalizedRight = normalizeQuantity(right, '0')
  const parsedLeft = Number.parseFloat(normalizedLeft)
  const parsedRight = Number.parseFloat(normalizedRight)
  if (!Number.isFinite(parsedLeft) || !Number.isFinite(parsedRight)) {
    return normalizedLeft || normalizedRight || '0'
  }
  return String(parsedLeft + parsedRight)
}

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

function resolveWorkspaceIdFromItemLink(itemLink: string | undefined): number | null {
  const link = String(itemLink || '').trim()
  if (!link) return null
  const wsMatch = /\/workspaces\/(\d+)\/items\//i.exec(link)
  const workspaceId = Number.parseInt(wsMatch?.[1] || '', 10)
  return Number.isFinite(workspaceId) && workspaceId > 0 ? workspaceId : null
}

async function fetchItemFieldsForCopyInWorkspace(
  client: ApiClient,
  context: Parameters<CloneService['deepDuplicateSubtree']>[0],
  workspaceId: number,
  itemId: number
): Promise<CopyableField[]> {
  const payload = await client.getItemDetails({
    tenant: context.tenant,
    workspaceId,
    dmsId: itemId,
  })
  return extractCopyableFields(payload)
}

function resolveItemIdFromItemLink(itemLink: string | undefined): number | null {
  const link = String(itemLink || '').trim()
  if (!link) return null
  const itemMatch = /\/items\/(\d+)\b/i.exec(link)
  const itemId = Number.parseInt(itemMatch?.[1] || '', 10)
  return Number.isFinite(itemId) && itemId > 0 ? itemId : null
}

function parseLinkableProxyReference(value: string): { workspaceId: number; proxyItemId: number } | null {
  const text = value.trim()
  if (!text) return null
  const match = /\/workspaces\/(\d+)\/items\/\d+\/views\/\d+\/linkable-items\/(\d+)\b/i.exec(text)
  if (!match) return null
  const workspaceId = Number.parseInt(match[1], 10)
  const proxyItemId = Number.parseInt(match[2], 10)
  if (!Number.isFinite(workspaceId) || workspaceId <= 0 || !Number.isFinite(proxyItemId) || proxyItemId <= 0) {
    return null
  }
  return { workspaceId, proxyItemId }
}

function readLinkValue(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.link === 'string' && record.link.trim()) return record.link.trim()
  if (typeof record.__self__ === 'string' && record.__self__.trim()) return record.__self__.trim()
  if (record.__self__ && typeof record.__self__ === 'object') {
    const nestedLink = String((record.__self__ as Record<string, unknown>).link || '').trim()
    if (nestedLink) return nestedLink
  }
  return ''
}

function collectItemIdCandidates(value: unknown, results: number[], seen: Set<number>, depth = 0): void {
  if (depth > 6 || value == null) return
  if (typeof value === 'string') {
    const linkableProxy = parseLinkableProxyReference(value)
    if (linkableProxy && !seen.has(linkableProxy.proxyItemId)) {
      seen.add(linkableProxy.proxyItemId)
      results.push(linkableProxy.proxyItemId)
    }
    const match = /\/items\/(\d+)\b/i.exec(value)
    if (!match) return
    const parsed = Number.parseInt(match[1], 10)
    if (Number.isFinite(parsed) && parsed > 0 && !seen.has(parsed)) {
      seen.add(parsed)
      results.push(parsed)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectItemIdCandidates(entry, results, seen, depth + 1)
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  const directKeys = ['dmsId', 'itemId', 'id']
  for (const key of directKeys) {
    const parsed = Number(record[key])
    if (Number.isFinite(parsed) && parsed > 0 && !seen.has(parsed)) {
      seen.add(parsed)
      results.push(parsed)
    }
  }

  for (const nestedValue of Object.values(record)) {
    collectItemIdCandidates(nestedValue, results, seen, depth + 1)
  }
}

function resolveRecursiveItemIds(value: unknown): number[] {
  const results: number[] = []
  collectItemIdCandidates(value, results, new Set<number>())
  return results
}

function findRecursiveItemLink(value: unknown, itemId: number, depth = 0): string {
  if (depth > 6 || value == null) return ''
  if (typeof value === 'string') {
    return new RegExp(`/items/${itemId}\\b`, 'i').test(value) ? value.trim() : ''
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findRecursiveItemLink(entry, itemId, depth + 1)
      if (nested) return nested
    }
    return ''
  }
  if (typeof value !== 'object') return ''

  const directLink = readLinkValue(value)
  if (directLink && new RegExp(`/items/${itemId}\\b`, 'i').test(directLink)) return directLink

  const record = value as Record<string, unknown>
  for (const nestedValue of Object.values(record)) {
    const nested = findRecursiveItemLink(nestedValue, itemId, depth + 1)
    if (nested) return nested
  }
  return ''
}

function findFirstRecursiveLink(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return ''
  if (typeof value === 'string') {
    return /\/workspaces\/\d+\/items\/\d+\b/i.test(value) ? value.trim() : ''
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findFirstRecursiveLink(entry, depth + 1)
      if (nested) return nested
    }
    return ''
  }
  if (typeof value !== 'object') return ''

  const directLink = readLinkValue(value)
  if (directLink) return directLink

  const record = value as Record<string, unknown>
  for (const nestedValue of Object.values(record)) {
    const nested = findFirstRecursiveLink(nestedValue, depth + 1)
    if (nested) return nested
  }
  return ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resolveLinkableEntries(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== 'object') return []
  const record = result as Record<string, unknown>
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : null
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(record.items)
      ? record.items
      : []
  return items.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
}

function resolveLinkablePageMeta(result: unknown): { totalCount: number | null; offset: number | null; limit: number | null } {
  if (!result || typeof result !== 'object') return { totalCount: null, offset: null, limit: null }
  const record = result as Record<string, unknown>
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : null
  const source = data || record
  const readNumber = (value: unknown): number | null => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return {
    totalCount: readNumber(source.totalCount),
    offset: readNumber(source.offset),
    limit: readNumber(source.limit),
  }
}

function resolveLinkableItemId(entry: Record<string, unknown>): number | null {
  const nestedItem = entry.item && typeof entry.item === 'object'
    ? entry.item as Record<string, unknown>
    : null
  for (const source of nestedItem ? [nestedItem, entry] : [entry]) {
    const sourceLink = readLinkValue(source)
    const parsedFromLink = sourceLink ? parseLinkableProxyReference(sourceLink) : null
    if (parsedFromLink) return parsedFromLink.proxyItemId
  }
  for (const source of nestedItem ? [nestedItem, entry] : [entry]) {
    const parsed = Number(source.dmsId || source.itemId || source.id)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  const recursiveIds = resolveRecursiveItemIds(entry)
  return recursiveIds[0] ?? null
}

function resolveLinkableItemLink(entry: Record<string, unknown>, itemId: number): string {
  const entryLink = readLinkValue(entry)
  if (parseLinkableProxyReference(entryLink)) return entryLink
  if (/\/linkable-items\/\d+\b/i.test(entryLink)) return entryLink

  const nestedItem = entry.item && typeof entry.item === 'object'
    ? entry.item as Record<string, unknown>
    : null
  const direct = readLinkValue(nestedItem || entry)
  if (direct && new RegExp(`/items/${itemId}\\b`, 'i').test(direct)) return direct
  const recursiveMatch = findRecursiveItemLink(entry, itemId)
  if (recursiveMatch) return recursiveMatch

  const fallbackLink = findFirstRecursiveLink(entry)
  const fallbackWorkspaceId = resolveWorkspaceIdFromItemLink(fallbackLink)
  const linkableItemId = resolveLinkableItemId(entry)
  if (fallbackWorkspaceId && linkableItemId) {
    const linkableProxy = parseLinkableProxyReference(fallbackLink)
    if (linkableProxy) return fallbackLink
    return `/api/v3/workspaces/${fallbackWorkspaceId}/items/${linkableItemId}`
  }

  return fallbackLink
}

function entryMatchesItemId(entry: Record<string, unknown>, itemId: number): boolean {
  if (resolveLinkableItemId(entry) === itemId) return true
  return resolveRecursiveItemIds(entry).includes(itemId) || Boolean(findRecursiveItemLink(entry, itemId))
}

function entryMatchesItemNumber(entry: Record<string, unknown>, itemNumber: string): boolean {
  const normalized = itemNumber.trim()
  if (!normalized) return false
  const pattern = new RegExp(`\\b${escapeRegExp(normalized)}\\b`, 'i')
  const visit = (value: unknown, depth = 0): boolean => {
    if (depth > 6 || value == null) return false
    if (typeof value === 'string') return pattern.test(value)
    if (Array.isArray(value)) return value.some((entryValue) => visit(entryValue, depth + 1))
    if (typeof value !== 'object') return false
    return Object.values(value as Record<string, unknown>).some((entryValue) => visit(entryValue, depth + 1))
  }
  return visit(entry)
}

function resolveCanonicalItemLink(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const record = result as Record<string, unknown>
  const candidates = [
    record,
    record.item,
    record.data,
    record.payload,
    record.details,
    record.itemDetails,
  ]
  for (const candidate of candidates) {
    const link = readLinkValue(candidate)
    if (link) return link
  }
  return ''
}

function setAutomationTrace(kind: string, detail: Record<string, unknown> = {}): void {
  if (typeof document === 'undefined' || !document?.documentElement) return
  try {
    document.documentElement.setAttribute(
      'data-plm-bom-clone-automation-trace',
      JSON.stringify({
        kind,
        ...detail,
        at: Date.now(),
      })
    )
  } catch {
    // Trace surface is best-effort only.
  }
}

export function createMutateApi(params: {
  client: ApiClient
  fetchItemFieldsForCopy: CloneService['fetchItemFieldsForCopy']
}): MutateApi {
  const { client, fetchItemFieldsForCopy } = params
  const canonicalItemReferenceCache = new Map<string, Promise<{ itemLink: string; workspaceId: number | null }>>()
  const linkableItemReferenceCache = new Map<string, Promise<{
    itemLink: string
    workspaceId: number | null
    resolvedItemId: number
  } | null>>()
  const referenceItemNumberCache = new Map<number, string>()
  const sourceItemNumberCache = new Map<number, string>()
  const createdItemNumberCache = new Map<number, string>()
  const createdItemWorkspaceCache = new Map<number, number>()
  const linkableParentEntriesCache = new Map<string, Promise<Array<Record<string, unknown>>>>()
  const linkableSearchResultCache = new Map<string, Promise<Record<string, unknown> | null>>()
  const workspaceItemCopyableFieldsCache = new Map<string, Promise<CopyableField[]>>()

  function resolveReferenceCacheKey(itemId: number, itemLink: string): string {
    return itemLink || `id:${itemId}`
  }

  async function fetchCopyableFieldsForWorkspaceItem(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    workspaceId: number,
    itemId: number
  ): Promise<CopyableField[]> {
    const cacheKey = `${workspaceId}:${itemId}`
    const cached = workspaceItemCopyableFieldsCache.get(cacheKey)
    if (cached) return cached

    const pending = fetchItemFieldsForCopyInWorkspace(client, context, workspaceId, itemId)
    workspaceItemCopyableFieldsCache.set(cacheKey, pending)

    try {
      return await pending
    } catch (error) {
      workspaceItemCopyableFieldsCache.delete(cacheKey)
      throw error
    }
  }

  async function resolveCanonicalItemReference(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    itemId: number,
    itemLink?: string
  ): Promise<{ itemLink: string; workspaceId: number | null }> {
    const fallbackLink = String(itemLink || '').trim()
    const cacheKey = resolveReferenceCacheKey(itemId, fallbackLink)
    const cached = canonicalItemReferenceCache.get(cacheKey)
    if (cached) return cached

    const pending = (async () => {
      try {
        const detailPayload = await client.getItemDetails(
          fallbackLink
            ? { tenant: context.tenant, link: fallbackLink }
            : { tenant: context.tenant, workspaceId: context.workspaceId, dmsId: itemId }
        )
        const canonicalLink = resolveCanonicalItemLink(detailPayload) || fallbackLink
        return {
          itemLink: canonicalLink,
          workspaceId: resolveWorkspaceIdFromItemLink(canonicalLink),
        }
      } catch {
        return {
          itemLink: fallbackLink,
          workspaceId: resolveWorkspaceIdFromItemLink(fallbackLink),
        }
      }
    })()

    canonicalItemReferenceCache.set(cacheKey, pending)
    return pending
  }

  async function processLinkableMatchEntry(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    match: Record<string, unknown>,
    itemId: number,
    parentItemId: number,
    matchPageIndex: number
  ): Promise<{ itemLink: string; workspaceId: number | null; resolvedItemId: number }> {
    console.debug('[DEEP-DUP] linkable reference raw match:', JSON.stringify(match))
    const itemLink = resolveLinkableItemLink(match, itemId)
    const nestedItem = match.item && typeof match.item === 'object'
      ? match.item as Record<string, unknown>
      : null
    const canonicalItemLinkFromMatch = readLinkValue(nestedItem)
    const parsedProxy = parseLinkableProxyReference(itemLink)
    const resolvedItemId = resolveItemIdFromItemLink(canonicalItemLinkFromMatch)
      ?? parsedProxy?.proxyItemId
      ?? itemId
    const canonicalProxyReference = canonicalItemLinkFromMatch
      ? {
        itemLink: canonicalItemLinkFromMatch,
        workspaceId: resolveWorkspaceIdFromItemLink(canonicalItemLinkFromMatch),
      }
      : parsedProxy
        ? await resolveCanonicalItemReference(context, parsedProxy.proxyItemId, itemLink)
      : null
    const resolved = {
      itemLink,
      workspaceId: canonicalProxyReference?.workspaceId ?? resolveWorkspaceIdFromItemLink(itemLink),
      resolvedItemId,
    }
    console.debug(
      '[DEEP-DUP] linkable reference resolved:',
      'parentItemId=',
      parentItemId,
      'itemId=',
      itemId,
      'page=',
      Math.floor(matchPageIndex / 1000) + 1,
      'itemLink=',
      resolved.itemLink || '(none)',
      'workspaceId=',
      resolved.workspaceId,
      'resolvedItemId=',
      resolved.resolvedItemId
    )
    return resolved
  }

  async function fetchLinkableEntryBySearch(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    parentItemId: number,
    parentWorkspaceId: number,
    itemId: number,
    searchTerm: string
  ): Promise<Record<string, unknown> | null> {
    const cacheKey = `${parentWorkspaceId}:${parentItemId}:search:${searchTerm}`
    const cached = linkableSearchResultCache.get(cacheKey)
    if (cached !== undefined) return cached

    const pending = (async () => {
      const payload = await client.fetchBomLinkableItems({
        tenant: context.tenant,
        workspaceId: parentWorkspaceId,
        currentItemId: parentItemId,
        viewId: context.viewId,
        search: searchTerm,
        limit: 100,
        offset: 0,
      })
      const entries = resolveLinkableEntries(payload)
      return entries.find((entry) =>
        entryMatchesItemId(entry, itemId)
        || entryMatchesItemNumber(entry, searchTerm)
      ) ?? null
    })()

    linkableSearchResultCache.set(cacheKey, pending)
    try {
      const result = await pending
      if (!result) linkableSearchResultCache.delete(cacheKey)
      return result
    } catch {
      linkableSearchResultCache.delete(cacheKey)
      return null
    }
  }

  async function fetchAllLinkableEntriesForParent(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    parentItemId: number,
    parentWorkspaceId = context.workspaceId,
    options?: { forceRefresh?: boolean }
  ): Promise<Array<Record<string, unknown>>> {
    const cacheKey = `${parentWorkspaceId}:${parentItemId}`
    if (options?.forceRefresh) linkableParentEntriesCache.delete(cacheKey)
    const cached = linkableParentEntriesCache.get(cacheKey)
    if (cached) return cached

    const pending = (async () => {
      const pageSize = 1000
      const maxPages = 20
      const entries: Array<Record<string, unknown>> = []
      const candidateIds = new Set<number>()

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const offset = pageIndex * pageSize
        const payload = await client.fetchBomLinkableItems({
          tenant: context.tenant,
          workspaceId: parentWorkspaceId,
          currentItemId: parentItemId,
          viewId: context.viewId,
          limit: pageSize,
          offset,
        })
        const pageEntries = resolveLinkableEntries(payload)
        const pageMeta = resolveLinkablePageMeta(payload)
        entries.push(...pageEntries)
        for (const candidateId of pageEntries.flatMap((entry) => resolveRecursiveItemIds(entry))) {
          candidateIds.add(candidateId)
        }
        console.debug(
          '[DEEP-DUP] linkable items for parentItemId=',
          parentItemId,
          ': page=',
          pageIndex + 1,
          'offset=',
          offset,
          'pageEntries=',
          pageEntries.length,
          'totalCount=',
          pageMeta.totalCount,
          'candidateIds=',
          Array.from(candidateIds).slice(0, 10)
        )
        const reachedTotal = pageMeta.totalCount !== null && offset + pageEntries.length >= pageMeta.totalCount
        const exhaustedPage = pageMeta.totalCount === null && pageEntries.length < pageSize
        if (reachedTotal || exhaustedPage) break
      }

      return entries
    })()

    linkableParentEntriesCache.set(cacheKey, pending)

    try {
      return await pending
    } catch (error) {
      linkableParentEntriesCache.delete(cacheKey)
      throw error
    }
  }

  async function resolveLinkableItemReference(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    parentItemId: number,
    itemId: number,
    itemNumber?: string,
    parentWorkspaceId = context.workspaceId,
    options?: { forceRefresh?: boolean }
  ): Promise<{
    itemLink: string
    workspaceId: number | null
    resolvedItemId: number
  } | null> {
    const cacheKey = `${parentWorkspaceId}:${parentItemId}:${itemId}:${String(itemNumber || '').trim()}`
    const cached = linkableItemReferenceCache.get(cacheKey)
    if (cached) return cached

    const pending = (async () => {
      try {
        const fullCacheKey = `${parentWorkspaceId}:${parentItemId}`
        const fullCacheAlreadyPopulated = linkableParentEntriesCache.has(fullCacheKey)
        const trimmedNumber = String(itemNumber || '').trim()

        // When forceRefresh is set, also clear the targeted search cache for this item number
        if (options?.forceRefresh && trimmedNumber) {
          linkableSearchResultCache.delete(`${parentWorkspaceId}:${parentItemId}:search:${trimmedNumber}`)
        }

        // Fast path: single targeted search call when item number is known and full cache isn't loaded yet
        if (trimmedNumber && !fullCacheAlreadyPopulated && !options?.forceRefresh) {
          const searchMatch = await fetchLinkableEntryBySearch(
            context,
            parentItemId,
            parentWorkspaceId,
            itemId,
            trimmedNumber
          )
          if (searchMatch) {
            return await processLinkableMatchEntry(context, searchMatch, itemId, parentItemId, 0)
          }
          // fall through to full paginated fetch
        }

        const entries = await fetchAllLinkableEntriesForParent(
          context,
          parentItemId,
          parentWorkspaceId,
          options
        )
        const candidateIds = new Set<number>()
        for (const candidateId of entries.flatMap((entry) => resolveRecursiveItemIds(entry))) {
          candidateIds.add(candidateId)
        }
        const matchIndex = entries.findIndex((entry) => (
          entryMatchesItemId(entry, itemId)
          || (itemNumber ? entryMatchesItemNumber(entry, itemNumber) : false)
        ))
        if (matchIndex >= 0) {
          return await processLinkableMatchEntry(context, entries[matchIndex], itemId, parentItemId, matchIndex)
        }

        console.debug(
          '[DEEP-DUP] linkable reference missing:',
          'parentItemId=',
          parentItemId,
          'itemId=',
          itemId,
          'candidateIds=',
          Array.from(candidateIds)
        )
        return null
      } catch {
        console.debug(
          '[DEEP-DUP] linkable reference lookup failed:',
          'parentItemId=',
          parentItemId,
          'itemId=',
          itemId
        )
        return null
      }
    })()

    linkableItemReferenceCache.set(cacheKey, pending)

    try {
      const resolved = await pending
      if (!resolved) linkableItemReferenceCache.delete(cacheKey)
      return resolved
    } catch (error) {
      linkableItemReferenceCache.delete(cacheKey)
      throw error
    }
  }

  async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  async function resolveNewDuplicateChildReference(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    parentItemId: number,
    childItemId: number,
    parentWorkspaceId = context.workspaceId
  ): Promise<{
    itemLink: string
    workspaceId: number | null
    resolvedItemId: number
  } | null> {
    const childNumber = createdItemNumberCache.get(childItemId)
    const attempts = 3

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      setAutomationTrace('duplicate-child-lookup', {
        parentItemId,
        childItemId,
        childNumber: childNumber || '',
        attempt: attempt + 1,
        attempts,
      })
      const resolved = await resolveLinkableItemReference(
        context,
        parentItemId,
        childItemId,
        childNumber,
        parentWorkspaceId,
        { forceRefresh: attempt > 0 }
      )
      if (resolved) return resolved
      setAutomationTrace('duplicate-child-lookup-miss', {
        parentItemId,
        childItemId,
        childNumber: childNumber || '',
        attempt: attempt + 1,
        attempts,
      })
      if (attempt < attempts - 1) await delay(250)
    }

    return null
  }

  async function resolveReferenceChildLinkableReference(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    parentItemId: number,
    childItemId: number,
    parentWorkspaceId = context.workspaceId
  ): Promise<{
    itemLink: string
    workspaceId: number | null
    resolvedItemId: number
  } | null> {
    let childNumber = referenceItemNumberCache.get(childItemId) || sourceItemNumberCache.get(childItemId) || ''
    let resolved = await resolveLinkableItemReference(
      context,
      parentItemId,
      childItemId,
      childNumber,
      parentWorkspaceId
    )
    if (resolved) return resolved

    try {
      const copiedFields = await fetchItemFieldsForCopy(context, childItemId)
      const fetchedNumber = copiedFields.find((field) => field.fieldId === 'NUMBER')?.value ?? ''
      if (fetchedNumber) {
        childNumber = fetchedNumber
        sourceItemNumberCache.set(childItemId, fetchedNumber)
        if (fetchedNumber.startsWith('99')) referenceItemNumberCache.set(childItemId, fetchedNumber)
        resolved = await resolveLinkableItemReference(
          context,
          parentItemId,
          childItemId,
          childNumber,
          parentWorkspaceId
        )
        if (resolved) return resolved
      }
    } catch {
      // Best-effort fallback only.
    }

    return null
  }

  async function deepDuplicateSubtreeImpl(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    plan: DuplicatePlanNode,
    projectId: string,
    options?: {
      prefetchedFields?: CopyableField[]
      copySource?: {
        workspaceId: number
        itemId: number
      }
    }
  ): Promise<number> {
    console.debug('[DEEP-DUP] deepDuplicateSubtreeImpl: contextWorkspaceId=', context.workspaceId, 'nodeId=', plan.sourceNode.id, 'nodeItemLink=', plan.sourceNode.itemLink || '(none)', 'kind=', plan.kind)
    setAutomationTrace('node-start', {
      workspaceId: context.workspaceId,
      nodeId: plan.sourceNode.id,
      nodeLabel: plan.sourceNode.label,
      kind: plan.kind,
    })

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

    let copiedFields = options?.prefetchedFields
      ? [...options.prefetchedFields]
      : await fetchItemFieldsForCopy(context, sourceItemId)

    const canonicalCopySource = options?.copySource
    const itemWorkspaceId = canonicalCopySource?.workspaceId ?? context.workspaceId
    if (canonicalCopySource) {
      try {
        copiedFields = await fetchCopyableFieldsForWorkspaceItem(
          context,
          canonicalCopySource.workspaceId,
          canonicalCopySource.itemId
        )
        console.debug(
          '[DEEP-DUP] using canonical copy source:',
          'sourceItemId=',
          sourceItemId,
          'copyWorkspaceId=',
          canonicalCopySource.workspaceId,
          'copyItemId=',
          canonicalCopySource.itemId
        )
      } catch (error) {
        console.debug(
          '[DEEP-DUP] canonical copy source failed; falling back to source item fields:',
          'sourceItemId=',
          sourceItemId,
          'copyWorkspaceId=',
          canonicalCopySource.workspaceId,
          'copyItemId=',
          canonicalCopySource.itemId,
          error
        )
      }
    }

    // The actual item number is in the NUMBER field. node.number from the V1
    // BOM API is a numeric database ID, not the human-readable number, so
    // isPartNode() (which checks node.number) cannot reliably detect parts here.
    // Re-check using the real item number: if it starts with '99' treat as a
    // reference rather than creating a new item.
    const actualItemNumber = copiedFields.find((f) => f.fieldId === 'NUMBER')?.value ?? ''
    if (actualItemNumber) sourceItemNumberCache.set(sourceItemId, actualItemNumber)
    if (actualItemNumber.startsWith('99')) {
      referenceItemNumberCache.set(sourceItemId, actualItemNumber)
      console.debug('[DEEP-DUP] treating as reference (actual number starts with 99):', actualItemNumber)
      return sourceItemId
    }

    const fieldMap = new Map(copiedFields.map((f) => [f.fieldId, f.value]))

    // Build a unique item number by appending the sanitized project ID to the
    // source item's number. Strip all non-alphanumeric characters from projectId
    // so there are no spaces or special characters in the resulting number.
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9]/g, '')
    console.debug('[DEEP-DUP] sourceItemId:', sourceItemId, 'sanitizedProjectId:', sanitizedProjectId)
    console.debug('[DEEP-DUP] copiedFields:', JSON.stringify(copiedFields))

    if (sanitizedProjectId) {
      // The item number field has fieldId 'NUMBER'. node.number from the V1 BOM
      // API is the numeric item ID, not the human-readable number, so we find
      // the field by its ID rather than by value.
      const numberField = copiedFields.find((f) => f.fieldId === 'NUMBER')
      if (numberField) {
        const nextNumberValue = `${numberField.value}-${sanitizedProjectId}`
        console.debug('[DEEP-DUP] updating NUMBER field:', numberField.value, '->', nextNumberValue)
        fieldMap.set(numberField.fieldId, nextNumberValue)
      } else {
        console.debug('[DEEP-DUP] NUMBER field not found in copiedFields — number will not be suffixed')
      }
    }

    const fields = Array.from(fieldMap.entries()).map(([fieldId, value]) => ({
      fieldId,
      value,
      type: 'string' as const,
    }))
    console.debug('[DEEP-DUP] createItem fields:', JSON.stringify(fields))

    const sectionsResult = await client.fetchSections({
      tenant: context.tenant,
      workspaceId: itemWorkspaceId,
    })
    const sections = resolveSectionsPayload(sectionsResult)

    const requestedNumber = String(fieldMap.get('NUMBER') || '').trim()
    const createResult = await client.createItem({
      tenant: context.tenant,
      workspaceId: itemWorkspaceId,
      sections,
      fields,
    }).catch((error) => {
      throw normalizeCreateItemError(error, requestedNumber)
    })
    const newItemId = resolveCreatedItemId(createResult)
    if (!newItemId || newItemId <= 0) {
      throw new Error(`Item creation returned invalid ID for: ${plan.sourceNode.label}`)
    }
    if (requestedNumber) createdItemNumberCache.set(newItemId, requestedNumber)
    createdItemWorkspaceCache.set(newItemId, itemWorkspaceId)
    console.debug('[DEEP-DUP] createItem result:', JSON.stringify(createResult), '→ newItemId:', newItemId)
    setAutomationTrace('item-created', {
      sourceItemId,
      newItemId,
      requestedNumber,
    })

    const pendingChildAdds: Array<{
      sourceChildItemId: number
      childItemId: number
      childWsId: number
      childAddItemId: number
      childLink: string
      childWasReferenced: boolean
      quantity: string
    }> = []
    const pendingChildAddIndexByKey = new Map<string, number>()

    // Prefetch all sibling fields in parallel before the sequential processing loop
    const childFieldsPrefetchMap = new Map<number, CopyableField[]>()
    const validChildIds = plan.children
      .map((c) => Number(c.sourceNode.id))
      .filter((id) => Number.isFinite(id) && id > 0)
    await mapWithConcurrency(validChildIds, 10, async (sourceChildItemId) => {
      try {
        const fields = await fetchItemFieldsForCopy(context, sourceChildItemId)
        childFieldsPrefetchMap.set(sourceChildItemId, fields)
      } catch {
        // silently skip — the for-loop will retry inline below
      }
    })

    for (let i = 0; i < plan.children.length; i++) {
      const childPlan = plan.children[i]
      const sourceChildItemId = Number(plan.children[i]?.sourceNode.id)
      const currentItemWorkspaceId = createdItemWorkspaceCache.get(newItemId) ?? context.workspaceId
      let childPrefetchedFields: CopyableField[] | undefined
      let childCopySource: { workspaceId: number; itemId: number } | undefined

      if (Number.isFinite(sourceChildItemId) && sourceChildItemId > 0) {
        childPrefetchedFields = childFieldsPrefetchMap.get(sourceChildItemId)
          ?? await fetchItemFieldsForCopy(context, sourceChildItemId)
        const actualChildNumber = childPrefetchedFields.find((field) => field.fieldId === 'NUMBER')?.value ?? ''
        if (actualChildNumber) sourceItemNumberCache.set(sourceChildItemId, actualChildNumber)
        if (!actualChildNumber.startsWith('99')) {
          const sourceTemplateReference = await resolveLinkableItemReference(
            context,
            sourceItemId,
            sourceChildItemId,
            actualChildNumber
          )
          if (
            sourceTemplateReference
            && Number.isFinite(sourceTemplateReference.workspaceId)
            && Number(sourceTemplateReference.workspaceId) > 0
            && Number.isFinite(sourceTemplateReference.resolvedItemId)
            && sourceTemplateReference.resolvedItemId > 0
            && sourceTemplateReference.resolvedItemId !== sourceChildItemId
          ) {
            const candidateWorkspaceId = Number(sourceTemplateReference.workspaceId)
            const candidateItemId = sourceTemplateReference.resolvedItemId
            try {
              const candidateFields = await fetchCopyableFieldsForWorkspaceItem(
                context,
                candidateWorkspaceId,
                candidateItemId
              )
              const candidateNumber = candidateFields.find((field) => field.fieldId === 'NUMBER')?.value ?? ''
              if (candidateNumber && candidateNumber === actualChildNumber) {
                childCopySource = {
                  workspaceId: candidateWorkspaceId,
                  itemId: candidateItemId,
                }
                console.debug(
                  '[DEEP-DUP] duplicate child canonical template detected:',
                  'parentItemId=',
                  sourceItemId,
                  'sourceChildItemId=',
                  sourceChildItemId,
                  'copyWorkspaceId=',
                  childCopySource.workspaceId,
                  'copyItemId=',
                  childCopySource.itemId
                )
              } else {
                console.debug(
                  '[DEEP-DUP] skipping canonical copy source due to number mismatch:',
                  'parentItemId=',
                  sourceItemId,
                  'sourceChildItemId=',
                  sourceChildItemId,
                  'sourceNumber=',
                  actualChildNumber || '(none)',
                  'candidateWorkspaceId=',
                  candidateWorkspaceId,
                  'candidateItemId=',
                  candidateItemId,
                  'candidateNumber=',
                  candidateNumber || '(none)'
                )
              }
            } catch (error) {
              console.debug(
                '[DEEP-DUP] failed to validate canonical copy source; falling back to source child fields:',
                'parentItemId=',
                sourceItemId,
                'sourceChildItemId=',
                sourceChildItemId,
                'candidateWorkspaceId=',
                candidateWorkspaceId,
                'candidateItemId=',
                candidateItemId,
                error
              )
            }
          }
        }
      }

      const childItemId = await deepDuplicateSubtreeImpl(
        context,
        childPlan,
        projectId,
        {
          prefetchedFields: childPrefetchedFields,
          copySource: childCopySource,
        }
      )

      // A V1-loaded child can be planned as "duplicate" because node.number is
      // just the numeric item id, then be reclassified as a reference after its
      // true NUMBER field is fetched inside the recursive call above. Detect
      // referenced children from the returned id, not only the original plan.
      const childWasReferenced = Number.isFinite(sourceChildItemId) && sourceChildItemId > 0 && sourceChildItemId === childItemId
      const fallbackChildLink = childWasReferenced ? String(childPlan.sourceNode.itemLink || '').trim() : ''

      // For reclassified reference children, look up the linkable pool of the SOURCE
      // item (e.g. 407279) rather than the newly created item.  The source already
      // has these parts in its BOM so the linkable API returns them with the exact
      // link format Fusion accepts.  A brand-new item has an empty linkable pool.
      const linkableChildReference = childWasReferenced
        ? await resolveReferenceChildLinkableReference(
          context,
          sourceItemId,
          childItemId,
          currentItemWorkspaceId
        )
        : null

      // For the canonical fallback: use the context-workspace path instead of the
      // item's canonical workspace path.  When a catalog part lives in a related
      // workspace, accessing it via the context workspace may return a scoped link
      // that Fusion accepts for addBomItem (avoiding the "not related workspace"
      // error that the cross-workspace canonical link triggers).
      const canonicalChildReference = childWasReferenced
        ? (linkableChildReference || await resolveCanonicalItemReference(context, childItemId))
        : null
      const duplicateChildReference = !childWasReferenced
        ? await resolveNewDuplicateChildReference(context, newItemId, childItemId, currentItemWorkspaceId)
        : null
      const targetDuplicateChildTemplateReference = !childWasReferenced && !duplicateChildReference && Number.isFinite(sourceChildItemId) && sourceChildItemId > 0
        ? await resolveLinkableItemReference(
          context,
          newItemId,
          sourceChildItemId,
          sourceItemNumberCache.get(sourceChildItemId),
          currentItemWorkspaceId
        )
        : null
      const sourceDuplicateChildReference = !childWasReferenced && Number.isFinite(sourceChildItemId) && sourceChildItemId > 0
        ? await resolveLinkableItemReference(
          context,
          sourceItemId,
          sourceChildItemId,
          sourceItemNumberCache.get(sourceChildItemId)
        )
        : null
      const childLink = targetDuplicateChildTemplateReference?.itemLink
        || sourceDuplicateChildReference?.itemLink
        || duplicateChildReference?.itemLink
        || canonicalChildReference?.itemLink
        || fallbackChildLink
      let childWsId = createdItemWorkspaceCache.get(childItemId) ?? context.workspaceId
      let childAddItemId = childItemId
      if (childWasReferenced) {
        childWsId = linkableChildReference?.workspaceId
          ?? canonicalChildReference?.workspaceId
          ?? context.workspaceId
        childAddItemId = linkableChildReference?.resolvedItemId ?? childItemId
        console.debug(
          '[DEEP-DUP] child reference detected:',
          'plannedKind=', childPlan.kind,
          'linkableFound=', Boolean(linkableChildReference),
          'canonicalLink=', canonicalChildReference?.itemLink || '(none)',
          'fallbackLink=', fallbackChildLink || '(none)',
          'resolvedLink=', childLink || '(none)',
          'childWsId=', childWsId,
          'childAddItemId=', childAddItemId
        )
        setAutomationTrace('reference-child', {
          parentItemId: newItemId,
          childItemId,
          childWsId,
          childAddItemId,
          childLink: childLink || '',
        })
      } else if (targetDuplicateChildTemplateReference) {
        childWsId = createdItemWorkspaceCache.get(childItemId) ?? context.workspaceId
        childAddItemId = childItemId
        console.debug(
          '[DEEP-DUP] duplicate child target linkable detected:',
          'targetParentItemId=', newItemId,
          'sourceChildItemId=', sourceChildItemId,
          'resolvedLink=', childLink || '(none)',
          'childWsId=', childWsId,
          'childAddItemId=', childAddItemId
        )
        setAutomationTrace('duplicate-child-target-linkable', {
          targetParentItemId: newItemId,
          sourceChildItemId,
          childItemId,
          childWsId,
          childAddItemId,
          childLink: childLink || '',
        })
      } else if (sourceDuplicateChildReference) {
        childWsId = createdItemWorkspaceCache.get(childItemId) ?? context.workspaceId
        childAddItemId = childItemId
        console.debug(
          '[DEEP-DUP] duplicate child source linkable detected:',
          'sourceParentItemId=', sourceItemId,
          'sourceChildItemId=', sourceChildItemId,
          'resolvedLink=', childLink || '(none)',
          'childWsId=', childWsId,
          'childAddItemId=', childAddItemId
        )
        setAutomationTrace('duplicate-child-source-linkable', {
          sourceParentItemId: sourceItemId,
          sourceChildItemId,
          parentItemId: newItemId,
          childItemId,
          childWsId,
          childAddItemId,
          childLink: childLink || '',
        })
      } else if (duplicateChildReference) {
        childWsId = duplicateChildReference.workspaceId ?? context.workspaceId
        childAddItemId = duplicateChildReference.resolvedItemId
        console.debug(
          '[DEEP-DUP] duplicate child linkable detected:',
          'resolvedLink=', childLink || '(none)',
          'childWsId=', childWsId,
          'childAddItemId=', childAddItemId
        )
        setAutomationTrace('duplicate-child-linkable', {
          parentItemId: newItemId,
          childItemId,
          childWsId,
          childAddItemId,
          childLink: childLink || '',
        })
      }

      const childQuantity = normalizeQuantity(String(childPlan.sourceNode.quantity || '').trim() || '1', '1')
      const childLinkValue = childLink || ''
      const pendingChildAddKey = `${childWsId}:${childAddItemId}:${childLinkValue}`
      const existingPendingChildAddIndex = pendingChildAddIndexByKey.get(pendingChildAddKey)

      if (existingPendingChildAddIndex != null) {
        const existingPendingChildAdd = pendingChildAdds[existingPendingChildAddIndex]
        existingPendingChildAdd.quantity = sumQuantities(existingPendingChildAdd.quantity, childQuantity)
        console.debug(
          '[DEEP-DUP] merged duplicate child add:',
          'parentItemId=', newItemId,
          'existingChildItemId=', existingPendingChildAdd.childItemId,
          'sourceChildItemId=', sourceChildItemId,
          'childWsId=', childWsId,
          'childAddItemId=', childAddItemId,
          'linkChild=', childLinkValue || '(default)',
          'mergedQuantity=', existingPendingChildAdd.quantity
        )
        setAutomationTrace('merge-child-add', {
          parentItemId: newItemId,
          sourceChildItemId,
          childItemId,
          childWsId,
          childAddItemId,
          childLink: childLinkValue,
          mergedQuantity: existingPendingChildAdd.quantity,
        })
        continue
      }

      pendingChildAddIndexByKey.set(pendingChildAddKey, pendingChildAdds.length)
      pendingChildAdds.push({
        sourceChildItemId,
        childItemId,
        childWsId,
        childAddItemId,
        childLink: childLinkValue,
        childWasReferenced,
        quantity: childQuantity,
      })
    }

    const currentItemWorkspaceId = createdItemWorkspaceCache.get(newItemId) ?? context.workspaceId
    for (let i = 0; i < pendingChildAdds.length; i++) {
      const pendingChildAdd = pendingChildAdds[i]
      console.debug(
        '[DEEP-DUP] addBomItem params:',
        'wsIdParent=', currentItemWorkspaceId,
        'wsIdChild=', pendingChildAdd.childWsId,
        'dmsIdParent=', newItemId,
        'dmsIdChild=', pendingChildAdd.childAddItemId,
        'linkChild=', pendingChildAdd.childLink || '(default)',
        'childWasReferenced=', pendingChildAdd.childWasReferenced,
        'quantity=', pendingChildAdd.quantity
      )
      setAutomationTrace('add-child-start', {
        parentItemId: newItemId,
        childItemId: pendingChildAdd.childItemId,
        childWsId: pendingChildAdd.childWsId,
        childAddItemId: pendingChildAdd.childAddItemId,
        childLink: pendingChildAdd.childLink,
        childWasReferenced: pendingChildAdd.childWasReferenced,
        quantity: pendingChildAdd.quantity,
      })

      const addChildResult = await client.addBomItem({
        tenant: context.tenant,
        wsIdParent: currentItemWorkspaceId,
        wsIdChild: pendingChildAdd.childWsId,
        dmsIdParent: newItemId,
        dmsIdChild: pendingChildAdd.childAddItemId,
        number: i + 1,
        quantity: pendingChildAdd.quantity,
        ...(pendingChildAdd.childLink ? { linkChild: pendingChildAdd.childLink } : {}),
      })
      console.debug('[DEEP-DUP] addBomItem child', pendingChildAdd.childItemId, 'to', newItemId, 'result:', JSON.stringify(addChildResult))
      setAutomationTrace('add-child-result', {
        parentItemId: newItemId,
        sourceChildItemId: pendingChildAdd.sourceChildItemId,
        childItemId: pendingChildAdd.childItemId,
        childWsId: pendingChildAdd.childWsId,
        childAddItemId: pendingChildAdd.childAddItemId,
        childLink: pendingChildAdd.childLink,
        childWasReferenced: pendingChildAdd.childWasReferenced,
        quantity: pendingChildAdd.quantity,
        status: Number((addChildResult as { status?: unknown })?.status) || 200,
        result: JSON.stringify(addChildResult),
      })
      assertMutationSuccess('add', addChildResult)
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
      const dmsIdParent = payload.parentItemId ?? context.currentItemId
      const canonicalParentReference = await resolveCanonicalItemReference(context, dmsIdParent)
      const parentWsId = canonicalParentReference.workspaceId ?? context.workspaceId
      const linkableReference = await resolveLinkableItemReference(context, dmsIdParent, payload.sourceItemId)
      const canonicalReference = linkableReference || await resolveCanonicalItemReference(
        context,
        payload.sourceItemId,
        payload.sourceItemLink
      )
      if (!linkableReference) {
        console.debug(
          '[DEEP-DUP] commitBomCloneItem falling back to canonical item link:',
          'parentItemId=',
          dmsIdParent,
          'sourceItemId=',
          payload.sourceItemId,
          'itemLink=',
          canonicalReference.itemLink || '(none)'
        )
      }
      const childWsId = linkableReference?.workspaceId ?? canonicalReference.workspaceId ?? context.workspaceId
      const childAddItemId = linkableReference?.resolvedItemId ?? payload.sourceItemId
      console.debug(
        '[DEEP-DUP] commitBomCloneItem params: wsIdParent:',
        parentWsId,
        'wsIdChild:',
        childWsId,
        'dmsIdParent:',
        dmsIdParent,
        'dmsIdChild:',
        childAddItemId,
        'parentItemLink:',
        canonicalParentReference.itemLink || '(none)',
        'sourceItemLink:',
        canonicalReference.itemLink || '(none)'
      )
      const result = await client.addBomItem({
        tenant: context.tenant,
        wsIdParent: parentWsId,
        wsIdChild: childWsId,
        dmsIdParent,
        dmsIdChild: childAddItemId,
        number: payload.itemNumber,
        quantity: payload.quantity,
        ...(canonicalParentReference.itemLink ? { linkParent: canonicalParentReference.itemLink } : {}),
        ...(canonicalReference.itemLink ? { linkChild: canonicalReference.itemLink } : {}),
        ...(typeof payload.pinned === 'boolean' ? { pinned: payload.pinned } : {}),
        ...(Array.isArray(payload.fields) && payload.fields.length > 0 ? { fields: payload.fields } : {})
      })
      console.debug('[DEEP-DUP] commitBomCloneItem result:', JSON.stringify(result))
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
