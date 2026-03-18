import { httpRequest } from './http'
import { sortArray } from './plm.helper'

const APS_BASE = (tenant) => `https://${tenant}.autodeskplm360.net`
const LINKABLE_ITEM_PATH_RE = /\/api\/v3\/workspaces\/(\d+)\/items\/(\d+)\/views\/\d+\/linkable-items\/(\d+)(?:[/?#]|$)/i
const VALIDATION_PAYLOAD_CACHE_MAX = 2000
const validationPayloadCache = new Map()
const validationPayloadInFlight = new Map()

function getBomViewsListEndpoint(tenant, workspaceId) {
  return `${APS_BASE(tenant)}/api/v3/workspaces/${workspaceId}/views/5`
}

function extractBomViewsFromListResponse(response) {
  const data =
    response && typeof response === 'object' && response.data && typeof response.data === 'object'
      ? response.data
      : response
  const fromRoot = Array.isArray(data?.bomViews) ? data.bomViews : []
  if (fromRoot.length > 0) return fromRoot
  const nestedData = data && typeof data.data === 'object' ? data.data : null
  const fromNested = Array.isArray(nestedData?.bomViews) ? nestedData.bomViews : []
  if (fromNested.length > 0) return fromNested
  return Array.isArray(response?.bomViews) ? response.bomViews : []
}

function parseBomViewDefIdFromLink(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const match = /\/viewdef\/(\d+)(?:[/?#]|$)/i.exec(text)
  if (!match) return null
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

function parseBomViewDefId(entry) {
  if (!entry || typeof entry !== 'object') return null

  const linkCandidates = []
  if (typeof entry.link === 'string') linkCandidates.push(entry.link)
  if (typeof entry.__self__ === 'string') linkCandidates.push(entry.__self__)
  if (entry.__self__ && typeof entry.__self__ === 'object') {
    if (typeof entry.__self__.link === 'string') linkCandidates.push(entry.__self__.link)
    if (typeof entry.__self__.urn === 'string') linkCandidates.push(entry.__self__.urn)
  }
  if (typeof entry.urn === 'string') linkCandidates.push(entry.urn)

  for (const candidate of linkCandidates) {
    const parsed = parseBomViewDefIdFromLink(candidate)
    if (parsed !== null) return parsed
  }

  const directCandidates = [
    entry.viewDefId,
    entry.viewdefid,
    entry.viewdefId,
    entry.id
  ]

  for (const candidate of directCandidates) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }

  return null
}

function buildBomViewDefLink(workspaceId, viewDefId) {
  return `/api/v3/workspaces/${workspaceId}/views/5/viewdef/${viewDefId}`
}

function toTenantUrl(tenant, path) {
  const raw = String(path || '').trim()
  if (!raw) return ''
  return raw.startsWith('http') ? raw : `${APS_BASE(tenant)}${raw}`
}

function parseLinkableItemPath(link) {
  const raw = String(link || '').trim()
  if (!raw) return null
  const pathname = raw.startsWith('http')
    ? (() => {
      try {
        return new URL(raw).pathname
      } catch {
        return raw
      }
    })()
    : raw
  const match = LINKABLE_ITEM_PATH_RE.exec(pathname)
  if (!match) return null

  const workspaceId = Number(match[1])
  const parentItemId = Number(match[2])
  const linkableItemId = Number(match[3])
  if (!Number.isFinite(workspaceId) || !Number.isFinite(parentItemId) || !Number.isFinite(linkableItemId)) {
    return null
  }

  return {
    workspaceId,
    parentItemId,
    linkableItemId,
    link: raw
  }
}

function resolveBomViewLink(entry) {
  if (!entry || typeof entry !== 'object') return ''
  if (typeof entry.link === 'string' && entry.link.trim()) return entry.link.trim()
  if (entry.__self__ && typeof entry.__self__ === 'object') {
    const link = String(entry.__self__.link || '').trim()
    if (link) return link
  }
  if (typeof entry.__self__ === 'string' && entry.__self__.trim()) return entry.__self__.trim()
  return ''
}

function normalizeBomViews(entries, workspaceId) {
  const normalized = []
  const seen = new Set()

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.deleted === true) continue
    const viewDefId = parseBomViewDefId(entry)
    const fallbackLink = viewDefId ? buildBomViewDefLink(workspaceId, viewDefId) : ''
    const resolvedLink = resolveBomViewLink(entry) || fallbackLink
    const key = viewDefId ? `id:${viewDefId}` : `link:${resolvedLink}`
    if (!resolvedLink || seen.has(key)) continue
    seen.add(key)

    normalized.push({
      id: viewDefId,
      name: String(entry.name || entry.title || '').trim(),
      isDefault: Boolean(entry.isDefault),
      link: resolvedLink,
      urn: String(
        entry.urn || (entry.__self__ && typeof entry.__self__ === 'object' ? entry.__self__.urn || '' : '') || ''
      ).trim()
    })
  }

  return normalized
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return []
  const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, items.length))
  const results = new Array(items.length)
  let nextIndex = 0

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()))
  return results
}

function extractFieldsFromResponsePayload(payload) {
  if (!payload) return []

  const data =
    payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
      ? payload.data
      : payload

  if (Array.isArray(data?.fields)) return data.fields
  if (Array.isArray(data?.viewfields)) return data.viewfields
  if (Array.isArray(data?.viewFields)) return data.viewFields
  if (Array.isArray(data)) return data
  return []
}

function resolveValidatorsLink(field) {
  if (!field || typeof field !== 'object') return ''
  if (typeof field.validators === 'string' && field.validators.trim()) return field.validators.trim()
  if (field.validators && typeof field.validators === 'object') {
    const link = String(field.validators.link || '').trim()
    if (link) return link
  }
  return ''
}

function payloadHasRequiredValidator(value) {
  if (!value) return false
  if (Array.isArray(value)) return value.some((entry) => payloadHasRequiredValidator(entry))
  if (typeof value !== 'object') return String(value).trim().toLowerCase() === 'required'

  const validatorName = String(value.validatorName || value.name || '').trim().toLowerCase()
  if (validatorName === 'required') return true
  if (Array.isArray(value.validators)) return value.validators.some((entry) => payloadHasRequiredValidator(entry))
  return false
}

function normalizeValidationCacheKey(tenant, link) {
  const raw = String(link || '').trim()
  if (!raw) return ''

  if (raw.startsWith('http')) {
    try {
      const parsed = new URL(raw)
      return `${tenant}|${parsed.pathname}${parsed.search}`
    } catch {
      return `${tenant}|${raw}`
    }
  }

  return `${tenant}|${raw}`
}

function setValidationPayloadCache(cacheKey, payload) {
  if (!cacheKey) return
  if (validationPayloadCache.has(cacheKey)) {
    validationPayloadCache.delete(cacheKey)
  }
  validationPayloadCache.set(cacheKey, payload)

  if (validationPayloadCache.size > VALIDATION_PAYLOAD_CACHE_MAX) {
    const oldestKey = validationPayloadCache.keys().next().value
    if (oldestKey) validationPayloadCache.delete(oldestKey)
  }
}

async function fetchValidationPayloadCached(tenant, link) {
  const cacheKey = normalizeValidationCacheKey(tenant, link)
  if (!cacheKey) return null

  if (validationPayloadCache.has(cacheKey)) {
    return validationPayloadCache.get(cacheKey)
  }

  if (validationPayloadInFlight.has(cacheKey)) {
    return validationPayloadInFlight.get(cacheKey)
  }

  const requestPromise = (async () => {
    try {
      const response = await httpRequest({
        method: 'GET',
        url: String(link).startsWith('http') ? link : `${APS_BASE(tenant)}${link}`
      })
      setValidationPayloadCache(cacheKey, response)
      return response
    } catch {
      return null
    } finally {
      validationPayloadInFlight.delete(cacheKey)
    }
  })()

  validationPayloadInFlight.set(cacheKey, requestPromise)
  return requestPromise
}

async function hydrateRequiredValidatorsForFieldsResponse(tenant, payload) {
  const fields = extractFieldsFromResponsePayload(payload)
  if (!Array.isArray(fields) || fields.length === 0) return payload

  const validationDescriptors = []
  const seenValidationKeys = new Set()

  for (const field of fields) {
    const validatorsLink = resolveValidatorsLink(field)
    if (!validatorsLink) continue
    const cacheKey = normalizeValidationCacheKey(tenant, validatorsLink)
    if (!cacheKey || seenValidationKeys.has(cacheKey)) continue
    seenValidationKeys.add(cacheKey)
    validationDescriptors.push({ cacheKey, validatorsLink })
  }

  if (validationDescriptors.length === 0) return payload

  const validationEntries = await mapWithConcurrency(
    validationDescriptors,
    10,
    async ({ cacheKey, validatorsLink }) => {
      const response = await fetchValidationPayloadCached(tenant, validatorsLink)
      return [cacheKey, response]
    }
  )

  const validationByLink = new Map(validationEntries)

  for (const field of fields) {
    const validatorsLink = resolveValidatorsLink(field)
    if (!validatorsLink) {
      field.required = Boolean(field.required)
      continue
    }

    const cacheKey = normalizeValidationCacheKey(tenant, validatorsLink)
    const validationPayload: any = validationByLink.get(cacheKey)
    const validations = Array.isArray(validationPayload)
      ? validationPayload
      : Array.isArray(validationPayload?.data)
        ? validationPayload.data
        : []

    field.validations = validations
    field.required = Boolean(field.required) || payloadHasRequiredValidator(validations)
  }

  return payload
}

export async function getBomViews({
  tenant,
  wsId,
  link
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }

  const resolvedWorkspaceId = typeof link !== 'undefined' ? link.split('/')[4] : wsId
  const viewsUrl = getBomViewsListEndpoint(tenant, resolvedWorkspaceId)

  try {
    const viewsResponse = await httpRequest({
      method: 'GET',
      url: viewsUrl
    })

    const result = normalizeBomViews(
      extractBomViewsFromListResponse(viewsResponse),
      resolvedWorkspaceId
    )
    result.sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0))

    return {
      ...viewsResponse,
      data: {
        ...(viewsResponse && viewsResponse.data && typeof viewsResponse.data === 'object' ? viewsResponse.data : {}),
        bomViews: result,
        count: result.length
      }
    }
  } catch (error) {
    return error?.response ?? error
  }
}

export async function getBomViewsAndFields({
  tenant,
  wsId,
  link
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }

  const resolvedWorkspaceId = typeof link !== 'undefined' ? link.split('/')[4] : wsId
  const viewsUrl = getBomViewsListEndpoint(tenant, resolvedWorkspaceId)

  try {
    const viewsResponse = await httpRequest({
      method: 'GET',
      url: viewsUrl
    })

    const listedViews = normalizeBomViews(
      extractBomViewsFromListResponse(viewsResponse),
      resolvedWorkspaceId
    )

    const result = await mapWithConcurrency(
      listedViews,
      10,
      async (view) => {
        let fields = null
        const viewFieldsLink = String(view.link || '').endsWith('/fields')
          ? String(view.link || '')
          : `${String(view.link || '')}/fields`

        try {
          fields = await httpRequest({
            method: 'GET',
            url: toTenantUrl(tenant, viewFieldsLink)
          })
          fields = await hydrateRequiredValidatorsForFieldsResponse(tenant, fields)
        } catch {
          fields = null
        }

        const id = parseBomViewDefId(view || {})
        const linkValue = resolveBomViewLink(view || {})
        const urnValue = String(view.urn || '').trim()

        return {
          data: {
            id,
            name: String(view.name || '').trim(),
            isDefault: view.isDefault === true,
            link: linkValue,
            urn: urnValue,
            __self__: {
              link: linkValue,
              urn: urnValue
            }
          },
          fields
        }
      }
    )

    result.sort((left, right) => Number(left?.data?.id || 0) - Number(right?.data?.id || 0))

    return { data: result }
  } catch (error) {
    return {
      status: Number(error?.status) || 500,
      message: error instanceof Error ? error.message : String(error || ''),
      data: error?.data ?? null
    }
  }
}

export async function getBomViewFields({
  tenant,
  link,
  wsId,
  viewId
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }

  let url = typeof link !== 'undefined' ? link : `/api/v3/workspaces/${wsId}/views/5/viewdef/${viewId}`
  if (!String(url).endsWith('/fields')) {
    url = `${url}/fields`
  }
  url = url.startsWith('http') ? url : `${APS_BASE(tenant)}${url}`

  try {
    let response = await httpRequest({
      method: 'GET',
      url
    })
    response = await hydrateRequiredValidatorsForFieldsResponse(tenant, response)
    return response
  } catch (error) {
    return {
      status: Number(error?.status) || 500,
      message: error instanceof Error ? error.message : String(error || ''),
      data: error?.data ?? null
    }
  }
}

export async function fetchBomLinkableItems({
  tenant,
  workspaceId,
  currentItemId,
  viewId,
  relatedWorkspaceId,
  search = '',
  sort = '',
  limit = 100,
  offset = 0
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }
  if (!workspaceId || !currentItemId || !viewId) {
    throw new Error('workspaceId, currentItemId, and viewId are required')
  }

  const query = new URLSearchParams()
  query.set('limit', String(limit))
  query.set('offset', String(offset))
  if (relatedWorkspaceId) query.set('relatedWorkspaceId', String(relatedWorkspaceId))
  if (search) query.set('search', String(search))
  if (sort) query.set('sort', String(sort))

  const url =
    `${APS_BASE(tenant)}/api/v3/workspaces/${workspaceId}/items/${currentItemId}/views/${viewId}/linkable-items?${query.toString()}`

  const response = await httpRequest({
    method: 'GET',
    url
  })

  if (response.data === '') {
    response.data = { items: [] }
  }

  if (!Array.isArray(response?.data?.items) && Array.isArray(response?.data?.linkableItems)) {
    response.data.items = response.data.linkableItems
  }

  return response
}

export async function getBom({
  tenant,
  wsId,
  dmsId,
  link,
  depth,
  revisionBias,
  effectiveDate,
  viewId,
  getBOMPartsList
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }

  const resolvedRevisionBias = typeof revisionBias !== 'undefined' ? revisionBias : 'release'
  const resolvedDepth = typeof depth !== 'undefined' ? depth : 10
  const resolvedGetPartsList = typeof getBOMPartsList !== 'undefined' ? getBOMPartsList : false
  const resolvedLink = typeof link !== 'undefined' ? link : `/api/v3/workspaces/${wsId}/items/${dmsId}`
  const rootId = typeof link !== 'undefined' ? String(link).split('/')[6] : dmsId

  let url =
    `${resolvedLink.startsWith('http') ? resolvedLink : `${APS_BASE(tenant)}${resolvedLink}`}` +
    `/bom?depth=${resolvedDepth}&revisionBias=${resolvedRevisionBias}&rootId=${rootId}`
  if (typeof viewId !== 'undefined') url += `&viewDefId=${viewId}`
  if (typeof effectiveDate !== 'undefined') url += `&effectiveDate=${effectiveDate}`

  const response = await httpRequest({
    method: 'GET',
    url,
    headers: {
      Accept: 'application/vnd.autodesk.plm.bom.bulk+json'
    }
  })

  let payload =
    response && typeof response === 'object' && response.data && typeof response.data === 'object'
      ? response.data
      : response

  if (payload && typeof payload === 'object' && Array.isArray(payload.edges)) {
    sortArray(payload.edges, 'itemNumber', '')
    sortArray(payload.edges, 'depth', '')
  }

  if (resolvedGetPartsList) {
    const workspaceId = resolvedLink.split('/')[4]
    const bomViewFields = await httpRequest({
      method: 'GET',
      url: `${APS_BASE(tenant)}/api/v3/workspaces/${workspaceId}/views/5/viewdef/${viewId}/fields`
    })
    const bomViewFieldsPayload =
      bomViewFields && typeof bomViewFields === 'object' && Array.isArray(bomViewFields.data)
        ? bomViewFields.data
        : bomViewFields

    if (payload && typeof payload === 'object') {
      payload.bomPartsList = getBOMPartsList(
        payload,
        bomViewFieldsPayload,
        null
      )
    }
  }

  if (response && typeof response === 'object' && response.data && typeof response.data === 'object') {
    response.data = payload
    return response
  }

  return { data: payload }
}

export async function addBomItem({
  tenant,
  wsIdParent,
  wsIdChild,
  dmsIdParent,
  dmsIdChild,
  linkParent,
  linkChild,
  quantity,
  pinned,
  number,
  fields
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }

  const resolvedLinkParent = typeof linkParent !== 'undefined' ? linkParent : `/api/v3/workspaces/${wsIdParent}/items/${dmsIdParent}`
  const resolvedLinkChild = typeof linkChild !== 'undefined' ? linkChild : `/api/v3/workspaces/${wsIdChild}/items/${dmsIdChild}`
  const linkableChildReference = parseLinkableItemPath(resolvedLinkChild)
  const canonicalChildLink = `/api/v3/workspaces/${wsIdChild}/items/${dmsIdChild}`
  const isPinned = typeof pinned === 'undefined' ? false : String(pinned).toLowerCase() === 'true'
  const resolvedQuantity = typeof quantity === 'undefined' ? 1 : quantity
  const params: any = {
    quantity: parseFloat(resolvedQuantity),
    isPinned,
    item: {
      link: linkableChildReference ? canonicalChildLink : resolvedLinkChild
    }
  }

  if (typeof number !== 'undefined') {
    params.itemNumber = Number(number)
  }

  if (typeof fields !== 'undefined' && fields.length > 0) {
    params.fields = []
    for (const field of fields) {
      params.fields.push({
        metaData: {
          link: field.link
        },
        value: field.value
      })
    }
  }

  try {
    const response = await httpRequest({
      method: 'POST',
      url: `${APS_BASE(tenant)}${resolvedLinkParent}/bom-items`,
      body: params,
      headers: linkableChildReference
        ? { 'content-location': linkableChildReference.link }
        : undefined
    })

    const resolvedStatus = Number(response?.status)
    return {
      data: true,
      status: Number.isFinite(resolvedStatus) ? resolvedStatus : 200
    }
  } catch (error) {
    return {
      status: Number(error?.status) || 500,
      message: error instanceof Error ? error.message : String(error || ''),
      data: error?.data ?? null
    }
  }
}

export async function getBomV1({
  tenant,
  wsId,
  dmsId,
  depth
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }
  if (!wsId) {
    throw new Error('wsId is required')
  }
  if (!dmsId) {
    throw new Error('dmsId is required')
  }

  const resolvedDepth = typeof depth !== 'undefined' ? depth : 100

  return httpRequest({
    method: 'GET',
    url: `${APS_BASE(tenant)}/api/rest/v1/workspaces/${wsId}/items/${dmsId}/boms?depth=${resolvedDepth}`,
    headers: {
      Accept: 'application/json'
    }
  })
}

export async function updateBomItem({
  tenant,
  wsIdParent,
  wsIdChild,
  dmsIdParent,
  dmsIdChild,
  linkParent,
  linkChild,
  edgeId,
  quantity,
  pinned,
  number,
  fields
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }

  const resolvedLinkParent = typeof linkParent !== 'undefined' ? linkParent : `/api/v3/workspaces/${wsIdParent}/items/${dmsIdParent}`
  const resolvedLinkChild = typeof linkChild !== 'undefined' ? linkChild : `/api/v3/workspaces/${wsIdChild}/items/${dmsIdChild}`
  const linkableChildReference = parseLinkableItemPath(resolvedLinkChild)
  const canonicalChildLink = `/api/v3/workspaces/${wsIdChild}/items/${dmsIdChild}`
  const isPinned = typeof pinned === 'undefined' ? false : String(pinned).toLowerCase() === 'true'
  const resolvedQuantity = typeof quantity === 'undefined' ? 1 : quantity
  const params: any = {
    quantity: parseFloat(resolvedQuantity),
    isPinned,
    item: {
      link: linkableChildReference ? canonicalChildLink : resolvedLinkChild
    }
  }

  if (typeof number !== 'undefined') {
    params.itemNumber = Number(number)
  }

  if (typeof fields !== 'undefined' && fields.length > 0) {
    params.fields = []
    for (const field of fields) {
      params.fields.push({
        metaData: {
          link: field.link
        },
        value: field.value
      })
    }
  }

  try {
    const response = await httpRequest({
      method: 'PATCH',
      url: `${APS_BASE(tenant)}${resolvedLinkParent}/bom-items/${edgeId}`,
      body: params,
      headers: linkableChildReference
        ? { 'content-location': linkableChildReference.link }
        : undefined
    })

    const resolvedStatus = Number(response?.status)
    return {
      data: true,
      status: Number.isFinite(resolvedStatus) ? resolvedStatus : 200
    }
  } catch (error) {
    return {
      status: Number(error?.status) || 500,
      message: error instanceof Error ? error.message : String(error || ''),
      data: error?.data ?? null
    }
  }
}

export async function removeBomItem({
  tenant,
  wsId,
  dmsId,
  link,
  edgeId,
  edgeLink
}) {
  if (!tenant) {
    throw new Error('tenant is required')
  }

  let resolvedEdgeLink = edgeLink
  if (typeof resolvedEdgeLink === 'undefined') {
    resolvedEdgeLink = typeof link !== 'undefined' ? link : `/api/v3/workspaces/${wsId}/items/${dmsId}`
    resolvedEdgeLink += `/bom-items/${edgeId}`
  }

  const url = resolvedEdgeLink.startsWith('http')
    ? resolvedEdgeLink
    : `${APS_BASE(tenant)}${resolvedEdgeLink}`

  try {
    const response = await httpRequest({
      method: 'DELETE',
      url
    })

    const resolvedStatus = Number(response?.status)
    return { data: true, status: Number.isFinite(resolvedStatus) ? resolvedStatus : 204 }
  } catch (error) {
    return {
      status: Number(error?.status) || 500,
      message: error instanceof Error ? error.message : String(error || ''),
      data: error?.data ?? null
    }
  }
}
