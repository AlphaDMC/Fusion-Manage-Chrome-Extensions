import type { ModalAction } from '../../../shared/runtime/types'
import { ensureStyleTag } from '../../../dom/styles'
import { buildFormPanelStyles } from '../../../ui/formPanel/formPanel.styles'
import { ensureItemSelectorStyles } from '../../../shared/item-selector/styles'
import type { BomCloneContext, CloneQuickCreateAction } from './clone.types'

/**
 * DOM adapter for BOM Clone.
 * Handles:
 * - context parsing from URL
 * - clone button injection/removal
 * - modal shell creation/teardown
 * - style injection and mutation observation
 */
type BomCloneDomRuntime = {
  openModal: (modalId: string, action: ModalAction) => void
  closeModal: (modalId: string) => void
  findByIdDeep: (root: Document | ShadowRoot | Element | null, id: string) => HTMLElement | null
}

export type CloneDomAdapter = {
  resolveContext: (urlString: string) => BomCloneContext | null
  isBomTab: (urlString: string) => boolean
  ensureCloneButton: (
    onSelect: (action: CloneQuickCreateAction) => void,
    options?: { disabled?: boolean; title?: string; label?: string }
  ) => HTMLDivElement | null
  isCloneButtonPresent: () => boolean
  observeCloneButtonPresence: (onNeedsSync: (delayMs: number) => void) => () => void
  ensureEditPanelStyles: (fieldsRootId: string) => void
  removeCloneButton: () => void
  refreshBomTabAfterCommit: () => void
  openItemDetailsForProcess: (itemLink: string | undefined, fallbackContext: Pick<BomCloneContext, 'tenant' | 'workspaceId'> | null) => void
  openBomDetailsForProcess: (itemLink: string | undefined, fallbackContext: Pick<BomCloneContext, 'tenant' | 'workspaceId'> | null) => void
  openSearchModalShell: () => HTMLDivElement | null
  closeSearchModalShell: () => void
  openStructureModalShell: () => HTMLDivElement | null
  closeStructureModalShell: () => void
}

const CLONE_BUTTON_ID = 'plm-extension-bom-clone-button'
const CLONE_DROPDOWN_ID = 'plm-extension-bom-clone-dropdown'
const SEARCH_MODAL_ID = 'plm-extension-bom-clone-modal'
const STRUCTURE_MODAL_ID = 'plm-extension-bom-clone-structure-modal'
const CLONE_STYLE_ID = 'plm-extension-bom-clone-button-style'
const OVERLAY_CLOSE_BLOCKED_ATTR = 'data-plm-bom-overlay-close-blocked'
const STRUCTURE_MODAL_SELECTOR = '#plm-extension-bom-clone-structure-modal'
const EDIT_PANEL_STYLE_ID = 'plm-bom-clone-edit-panel-style'
const CLONE_DROPDOWN_MENU_CLASS = 'plm-extension-bom-clone-dropdown-menu'
const API_ITEM_LINK_RE = /^\/api\/v3\/workspaces\/(\d+)\/items\/(\d+)$/i

/**
 * Parses DMS item id from URL query itemId payload.
 */
function parseDmsIdFromItemId(itemIdValue: string | null): number | null {
  if (!itemIdValue) return null
  const decoded = decodeURIComponent(itemIdValue)
  const parts = decoded.split(',')
  const maybeDmsId = Number.parseInt(parts.at(-1) ?? '', 10)
  return Number.isFinite(maybeDmsId) ? maybeDmsId : null
}

/**
 * Parses workspace id from BOM nested route pathname.
 */
function parseWorkspaceIdFromPath(pathname: string): number | null {
  const match = /^\/plm\/workspaces\/(\d+)\/items\/bom\/nested$/i.exec(pathname)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

/**
 * Resolves tenant segment from hostname.
 */
function getTenantFromHost(hostname: string): string {
  const parts = hostname.split('.')
  return (parts[0] || '').toLowerCase()
}

/**
 * Resolves the action-button host container on BOM pages.
 */
function findActionButtonsHost(): HTMLElement | null {
  const host = document.querySelector('#transcluded-buttons') as HTMLElement | null
  if (!host) return null

  const commandBar = (host.querySelector('.bom-command-bar') || host.querySelector('.grid-command-bar')) as HTMLElement | null
  if (commandBar) return commandBar
  return host
}

/**
 * Ensures clone-related feature styles are injected once.
 */
function ensureStyles(): void {
  ensureItemSelectorStyles(SEARCH_MODAL_ID, 'plm-extension-search-styles-search')
  ensureItemSelectorStyles(STRUCTURE_MODAL_ID, 'plm-extension-search-styles-structure')
  void import('./clone.styles').then(({ buildCloneStyles }) => {
    ensureStyleTag(CLONE_STYLE_ID, buildCloneStyles(CLONE_BUTTON_ID, STRUCTURE_MODAL_ID))
  })
}

/**
 * Prevents shared modal renderer from closing clone modals
 * when users click on the backdrop outside the modal panel.
 */
function blockBackdropClose(modal: HTMLDivElement): void {
  if (modal.getAttribute(OVERLAY_CLOSE_BLOCKED_ATTR) === 'true') return
  modal.setAttribute(OVERLAY_CLOSE_BLOCKED_ATTR, 'true')
  modal.addEventListener('click', (event) => {
    if (event.target !== modal) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)
}

/**
 * Attempts in-place BOM tab refresh and falls back to full reload.
 */
function refreshBomTabAfterCommitDom(): void {
  window.location.reload()
}

function parseWorkspaceAndDmsIdFromItemLink(itemLink: string | undefined): { workspaceId: number; dmsId: number } | null {
  if (!itemLink) return null
  let pathname = itemLink.trim()
  if (!pathname) return null
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    } catch {
      return null
    }
  }
  const match = API_ITEM_LINK_RE.exec(pathname)
  if (!match) return null
  const workspaceId = Number.parseInt(match[1], 10)
  const dmsId = Number.parseInt(match[2], 10)
  if (!Number.isFinite(workspaceId) || !Number.isFinite(dmsId)) return null
  return { workspaceId, dmsId }
}

function buildPlmItemIdParam(tenant: string, workspaceId: number, dmsId: number): string {
  return encodeURIComponent(`urn\`adsk,plm\`tenant,workspace,item\`${tenant.toUpperCase()},${workspaceId},${dmsId}`)
}

function openCloneNodeUrl(
  destination: 'details' | 'bom',
  itemLink: string | undefined,
  fallbackContext: Pick<BomCloneContext, 'tenant' | 'workspaceId'> | null
): void {
  const linkContext = parseWorkspaceAndDmsIdFromItemLink(itemLink)
  if (!linkContext || !fallbackContext?.tenant) return
  const workspaceId = linkContext.workspaceId || fallbackContext.workspaceId
  const itemId = buildPlmItemIdParam(fallbackContext.tenant, workspaceId, linkContext.dmsId)
  const path = destination === 'details'
    ? `/plm/workspaces/${workspaceId}/items/itemDetails?view=full&tab=details&mode=edit&itemId=${itemId}`
    : `/plm/workspaces/${workspaceId}/items/itemDetails?view=full&tab=bom&mode=view&itemId=${itemId}`
  window.open(`${window.location.origin}${path}`, '_blank', 'noopener,noreferrer')
}

/**
 * Creates DOM adapter implementation for BOM clone feature.
 */
export function createCloneDom(runtime: BomCloneDomRuntime): CloneDomAdapter {
  let detachCloneDropdownGuards: (() => void) | null = null

  function applyCloneTriggerSizing(button: HTMLButtonElement): void {
    button.style.setProperty('min-width', '145px', 'important')
    button.style.setProperty('min-height', '34px', 'important')
    button.style.setProperty('width', '145px', 'important')
    button.style.setProperty('max-width', '145px', 'important')
    button.style.setProperty('padding-left', '9px', 'important')
    button.style.setProperty('padding-right', '8px', 'important')
  }

  function isBomTabRoute(urlString: string): boolean {
    try {
      const url = new URL(urlString)
      const workspaceId = parseWorkspaceIdFromPath(url.pathname)
      const tab = (url.searchParams.get('tab') || '').toLowerCase()
      const mode = (url.searchParams.get('mode') || '').toLowerCase()
      const view = (url.searchParams.get('view') || '').toLowerCase()
      const supportedView = view === 'full' || view === 'split'
      return Boolean(workspaceId && tab === 'bom' && mode === 'view' && supportedView)
    } catch {
      return false
    }
  }

  /**
   * Finds an element by id, including deep/shadow-aware runtime lookup.
   */
  function findById(id: string): HTMLElement | null {
    return runtime.findByIdDeep(document, id) || document.getElementById(id)
  }

  /**
   * Resolves the command-bar action menu button.
   */
  function findActionMenuButtonResolved(): HTMLButtonElement | null {
    const button = findById('bom-actions-button')
    return button instanceof HTMLButtonElement ? button : null
  }

  /**
   * Resolves the action dropdown container when available.
   */
  function findActionDropdownContainerResolved(): HTMLElement | null {
    return findById('bom-actions-dropdown')
  }

  function closeCloneDropdown(): void {
    const container = document.getElementById(CLONE_DROPDOWN_ID)
    if (!(container instanceof HTMLDivElement)) return
    container.classList.remove('is-open')
  }

  function ensureCloneDropdownGuards(): void {
    if (detachCloneDropdownGuards) return

    const onPointerDown = (event: MouseEvent): void => {
      const container = document.getElementById(CLONE_DROPDOWN_ID)
      if (!(container instanceof HTMLDivElement)) return
      const target = event.target
      if (target instanceof Node && container.contains(target)) return
      closeCloneDropdown()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      closeCloneDropdown()
    }

    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    detachCloneDropdownGuards = () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      detachCloneDropdownGuards = null
    }
  }

  return {
    resolveContext(urlString) {
      try {
        const url = new URL(urlString)
        const workspaceId = parseWorkspaceIdFromPath(url.pathname)
        const currentItemId = parseDmsIdFromItemId(url.searchParams.get('itemId'))
        const viewIdFromUrl = Number.parseInt(url.searchParams.get('viewId') || '5', 10)
        const viewDefIdRaw = Number.parseInt(url.searchParams.get('viewDefId') || '', 10)
        const viewDefId = Number.isFinite(viewDefIdRaw) && viewDefIdRaw > 0 ? viewDefIdRaw : null

        if (!workspaceId || !currentItemId || !Number.isFinite(viewIdFromUrl)) return null

        return {
          tenant: getTenantFromHost(url.hostname),
          workspaceId,
          currentItemId,
          viewId: viewIdFromUrl,
          viewDefId
        }
      } catch {
        return null
      }
    },
    isBomTab(urlString) {
      return isBomTabRoute(urlString)
    },
    ensureCloneButton(onSelect, options) {
      ensureStyles()
      ensureCloneDropdownGuards()

      const host = findActionButtonsHost()
      const menuButton = findActionMenuButtonResolved()
      const actionDropdown = findActionDropdownContainerResolved()
      const parent = actionDropdown?.parentElement || menuButton?.parentElement || host
      if (!parent) return null

      let container = document.getElementById(CLONE_DROPDOWN_ID) as HTMLDivElement | null
      if (!container) {
        container = document.createElement('div')
        container.id = CLONE_DROPDOWN_ID
        container.className = 'plm-extension-bom-clone-dropdown'

        const button = document.createElement('button')
        button.type = 'button'
        button.id = CLONE_BUTTON_ID
        button.className = [
          'md-button',
          'md-secondary',
          'md-default-theme',
          'command-bar-button',
          'md-button',
          'md-ink-ripple',
          'plm-extension-btn',
          'plm-extension-btn--secondary',
          'plm-extension-bom-clone-dropdown-trigger'
        ].join(' ')
        const label = document.createElement('span')
        label.className = 'label'
        label.textContent = 'Quick Create'
        const chevron = document.createElement('span')
        chevron.className = 'zmdi zmdi-chevron-down plm-extension-bom-clone-dropdown-chevron'
        chevron.setAttribute('aria-hidden', 'true')
        button.append(label, chevron)

        const menu = document.createElement('div')
        menu.className = CLONE_DROPDOWN_MENU_CLASS
        menu.setAttribute('role', 'menu')

        const engineering = document.createElement('button')
        engineering.type = 'button'
        engineering.className = 'plm-extension-bom-clone-dropdown-item'
        engineering.setAttribute('role', 'menuitem')
        engineering.dataset.mode = 'engineering'
        engineering.textContent = 'Variant Bill of Materials'

        const manufacturing = document.createElement('button')
        manufacturing.type = 'button'
        manufacturing.className = 'plm-extension-bom-clone-dropdown-item'
        manufacturing.setAttribute('role', 'menuitem')
        manufacturing.dataset.mode = 'manufacturing'
        manufacturing.textContent = 'Manufacturing Bill of Materials'

        const deepClone = document.createElement('button')
        deepClone.type = 'button'
        deepClone.className = 'plm-extension-bom-clone-dropdown-item'
        deepClone.setAttribute('role', 'menuitem')
        deepClone.dataset.mode = 'deep-clone'
        deepClone.textContent = 'Deep Clone Current BOM'

        menu.append(engineering, manufacturing, deepClone)
        container.append(button, menu)
      }

      const button = container.querySelector(`#${CLONE_BUTTON_ID}`) as HTMLButtonElement | null
      const menu = container.querySelector(`.${CLONE_DROPDOWN_MENU_CLASS}`) as HTMLDivElement | null
      const engineering = container.querySelector('[data-mode="engineering"]') as HTMLButtonElement | null
      const manufacturing = container.querySelector('[data-mode="manufacturing"]') as HTMLButtonElement | null
      const deepClone = container.querySelector('[data-mode="deep-clone"]') as HTMLButtonElement | null
      const label = button?.querySelector('.label') as HTMLSpanElement | null
      if (!button || !menu || !engineering || !manufacturing || !deepClone || !label) return null
      applyCloneTriggerSizing(button)
      label.textContent = String(options?.label || 'Quick Create')
      engineering.textContent = 'Variant Bill of Materials'
      manufacturing.textContent = 'Manufacturing Bill of Materials'
      deepClone.textContent = 'Deep Clone Current BOM'
      const disabled = Boolean(options?.disabled)
      const title = String(options?.title || '').trim()
      button.disabled = disabled
      engineering.disabled = disabled
      manufacturing.disabled = disabled
      deepClone.disabled = disabled
      button.title = title
      button.setAttribute('aria-label', title || 'Quick Create')
      if (disabled) closeCloneDropdown()

      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (disabled) return
        const nextOpen = !container.classList.contains('is-open')
        container.classList.toggle('is-open', nextOpen)
      }

      const handleSelection = (action: CloneQuickCreateAction) => (event: MouseEvent): void => {
        event.preventDefault()
        event.stopPropagation()
        if (disabled) return
        closeCloneDropdown()
        onSelect(action)
      }

      engineering.onclick = handleSelection('engineering')
      manufacturing.onclick = handleSelection('manufacturing')
      deepClone.onclick = handleSelection('deep-clone')

      if (actionDropdown && actionDropdown.nextElementSibling !== container) {
        container.remove()
        actionDropdown.insertAdjacentElement('afterend', container)
      } else if (menuButton && menuButton.parentElement && menuButton.parentElement.nextElementSibling !== container) {
        container.remove()
        menuButton.insertAdjacentElement('afterend', container)
      } else if (container.parentElement !== parent) {
        container.remove()
        parent.appendChild(container)
      }

      return container
    },
    isCloneButtonPresent() {
      const container = document.getElementById(CLONE_DROPDOWN_ID)
      return Boolean(container && document.contains(container))
    },
    observeCloneButtonPresence(onNeedsSync) {
      const observer = new MutationObserver(() => {
        const shouldExist = isBomTabRoute(window.location.href)
        const button = document.getElementById(CLONE_BUTTON_ID) as HTMLButtonElement | null

        if (!shouldExist) {
          if (button) onNeedsSync(0)
          return
        }

        if (!button || !document.contains(button)) onNeedsSync(16)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
      return () => observer.disconnect()
    },
    ensureEditPanelStyles(fieldsRootId) {
      ensureStyleTag(EDIT_PANEL_STYLE_ID, buildFormPanelStyles(STRUCTURE_MODAL_SELECTOR, fieldsRootId))
    },
    removeCloneButton() {
      closeCloneDropdown()
      if (detachCloneDropdownGuards) detachCloneDropdownGuards()
      const container = document.getElementById(CLONE_DROPDOWN_ID)
      if (container) container.remove()
      const legacyButton = document.getElementById(CLONE_BUTTON_ID)
      if (legacyButton) legacyButton.remove()
    },
    refreshBomTabAfterCommit() {
      refreshBomTabAfterCommitDom()
    },
    openItemDetailsForProcess(itemLink, fallbackContext) {
      openCloneNodeUrl('details', itemLink, fallbackContext)
    },
    openBomDetailsForProcess(itemLink, fallbackContext) {
      openCloneNodeUrl('bom', itemLink, fallbackContext)
    },
    openSearchModalShell() {
      runtime.openModal(SEARCH_MODAL_ID, { id: 'bom.clone', label: 'Clone BOM' })
      const modal = document.getElementById(SEARCH_MODAL_ID)
      if (!(modal instanceof HTMLDivElement)) return null
      blockBackdropClose(modal)
      return modal
    },
    closeSearchModalShell() {
      runtime.closeModal(SEARCH_MODAL_ID)
    },
    openStructureModalShell() {
      runtime.openModal(STRUCTURE_MODAL_ID, { id: 'bom.clone.structure', label: 'Clone BOM - Structure' })
      const modal = document.getElementById(STRUCTURE_MODAL_ID)
      if (!(modal instanceof HTMLDivElement)) return null
      blockBackdropClose(modal)
      return modal
    },
    closeStructureModalShell() {
      runtime.closeModal(STRUCTURE_MODAL_ID)
    }
  }
}

