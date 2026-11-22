import { renderIcon } from './icons.js';

let activeDropdownController = null;

export function closeActiveDropdown() {
  if (activeDropdownController) {
    activeDropdownController.close();
  }
}

export function enhanceSelect(selectEl, options = {}) {
  if (
    !selectEl ||
    selectEl.tagName !== 'SELECT' ||
    typeof selectEl.hasAttribute !== 'function' ||
    typeof selectEl.closest !== 'function' ||
    typeof HTMLSelectElement === 'undefined'
  ) {
    return null;
  }
  if (selectEl.hasAttribute('data-no-enhance')) return null;
  if (selectEl.__sinDropdownController) {
    selectEl.__sinDropdownController.sync();
    return selectEl.__sinDropdownController;
  }

  const inDialog = Boolean(selectEl.closest('dialog'));
  const size = options.size || (inDialog ? 'md' : 'sm');
  const preferUp = Boolean(options.preferUp);

  const root = document.createElement('div');
  root.className = `ui-dropdown ui-dropdown--${size}${options.ghost ? ' ui-dropdown--ghost' : ''}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const labelEl = document.createElement('span');
  labelEl.className = 'ui-dropdown-label';

  const chevronWrap = document.createElement('span');
  chevronWrap.className = 'ui-dropdown-chevron';
  chevronWrap.setAttribute('aria-hidden', 'true');
  chevronWrap.innerHTML = renderIcon('chevronDown');

  trigger.append(labelEl, chevronWrap);
  root.appendChild(trigger);

  const parent = selectEl.parentNode;
  if (parent) {
    parent.insertBefore(root, selectEl);
  }
  selectEl.classList.add('ui-dropdown-native-hidden');
  selectEl.tabIndex = -1;
  root.appendChild(selectEl);

  let menuEl = null;
  let highlightedIndex = -1;
  let isOpen = false;
  let typeaheadBuf = '';
  let typeaheadTimer = null;

  const protoValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const protoIdxDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

  const syncVisibilityAndLabel = () => {
    const isHidden =
      selectEl.hidden ||
      selectEl.classList.contains('hidden') ||
      selectEl.style.display === 'none';
    root.hidden = isHidden;
    root.classList.toggle('hidden', isHidden);

    trigger.disabled = Boolean(selectEl.disabled);
    const ariaLabel = selectEl.getAttribute('aria-label');
    if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
    if (selectEl.title) trigger.title = selectEl.title;

    if (selectEl.style.flex) root.style.flex = selectEl.style.flex;
    if (selectEl.style.width) root.style.width = selectEl.style.width;
    if (selectEl.style.maxWidth) root.style.maxWidth = selectEl.style.maxWidth;
    if (selectEl.style.minWidth) root.style.minWidth = selectEl.style.minWidth;

    const selectedOption = selectEl.options[selectEl.selectedIndex] || selectEl.options[0] || null;
    labelEl.textContent = selectedOption ? selectedOption.textContent : '';
    const isItalic =
      selectEl.classList.contains('is-ram-preview') ||
      Boolean(selectedOption?.classList?.contains('ram-preview-option'));
    labelEl.classList.toggle('is-italic', isItalic);
  };

  if (protoValueDesc && protoValueDesc.set) {
    Object.defineProperty(selectEl, 'value', {
      configurable: true,
      get() {
        return protoValueDesc.get.call(this);
      },
      set(val) {
        protoValueDesc.set.call(this, val);
        syncVisibilityAndLabel();
      },
    });
  }
  if (protoIdxDesc && protoIdxDesc.set) {
    Object.defineProperty(selectEl, 'selectedIndex', {
      configurable: true,
      get() {
        return protoIdxDesc.get.call(this);
      },
      set(idx) {
        protoIdxDesc.set.call(this, idx);
        syncVisibilityAndLabel();
      },
    });
  }

  const getOptionButtons = () => {
    if (!menuEl) return [];
    return Array.from(menuEl.querySelectorAll('.ui-dropdown-option:not(:disabled)'));
  };

  const setHighlight = (btnIndex) => {
    const buttons = getOptionButtons();
    buttons.forEach((b) => b.classList.remove('is-highlighted'));
    if (btnIndex >= 0 && btnIndex < buttons.length) {
      highlightedIndex = btnIndex;
      const target = buttons[btnIndex];
      target.classList.add('is-highlighted');
      target.scrollIntoView({ block: 'nearest' });
    } else {
      highlightedIndex = -1;
    }
  };

  const selectOptionValue = (val) => {
    const prev = protoValueDesc ? protoValueDesc.get.call(selectEl) : selectEl.value;
    if (protoValueDesc?.set) protoValueDesc.set.call(selectEl, val);
    else selectEl.value = val;
    syncVisibilityAndLabel();
    close();
    if (!Object.is(prev, val)) {
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const buildMenuItems = () => {
    if (!menuEl) return;
    menuEl.innerHTML = '';

    const appendOption = (opt) => {
      if (opt.hidden) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ui-dropdown-option${opt.selected ? ' is-selected' : ''}`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(Boolean(opt.selected)));
      btn.disabled = Boolean(opt.disabled);
      btn.dataset.value = opt.value;

      const check = document.createElement('span');
      check.className = 'ui-dropdown-option-check';
      check.innerHTML = renderIcon('check');

      const text = document.createElement('span');
      text.className = `ui-dropdown-option-text${opt.classList?.contains('ram-preview-option') ? ' is-italic' : ''}`;
      text.textContent = opt.textContent || '';

      btn.append(check, text);
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!btn.disabled) {
          selectOptionValue(opt.value);
          trigger.focus({ preventScroll: true });
        }
      });
      menuEl.appendChild(btn);
    };

    for (const child of Array.from(selectEl.children)) {
      if (child.tagName === 'OPTGROUP') {
        const groupLabel = document.createElement('div');
        groupLabel.className = 'ui-dropdown-group-label';
        groupLabel.textContent = child.getAttribute('label') || '';
        menuEl.appendChild(groupLabel);
        for (const opt of Array.from(child.children)) {
          if (opt.tagName === 'OPTION') appendOption(opt);
        }
      } else if (child.tagName === 'OPTION') {
        appendOption(child);
      }
    }
  };

  const positionMenu = () => {
    if (!menuEl) return;
    const rect = trigger.getBoundingClientRect();
    const minW = Math.max(rect.width, 148);
    menuEl.style.minWidth = `${minW}px`;
    menuEl.style.maxWidth = `${Math.min(360, window.innerWidth - 16)}px`;

    const menuRect = menuEl.getBoundingClientRect();
    const menuH = Math.min(260, menuRect.height || 180);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openUp = (preferUp && spaceAbove >= 80) || (spaceBelow < Math.min(menuH, 160) && spaceAbove > spaceBelow);

    let left = rect.left;
    const width = Math.max(minW, menuRect.width || minW);
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }

    if (openUp) {
      menuEl.style.maxHeight = `${Math.max(96, Math.min(260, spaceAbove))}px`;
      const finalH = menuEl.getBoundingClientRect().height || menuH;
      menuEl.style.top = `${Math.max(8, rect.top - finalH - 4)}px`;
    } else {
      menuEl.style.maxHeight = `${Math.max(96, Math.min(260, spaceBelow))}px`;
      menuEl.style.top = `${Math.min(window.innerHeight - 16, rect.bottom + 4)}px`;
    }
    menuEl.style.left = `${Math.max(8, left)}px`;
  };

  const onDocPointerDown = (e) => {
    const t = e.target;
    if (menuEl?.contains(t) || root.contains(t)) return;
    close();
  };

  const onDocKeyDown = (e) => {
    if (!isOpen) return;
    const buttons = getOptionButtons();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      trigger.focus({ preventScroll: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(highlightedIndex < buttons.length - 1 ? highlightedIndex + 1 : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(highlightedIndex > 0 ? highlightedIndex - 1 : Math.max(0, buttons.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (highlightedIndex >= 0 && buttons[highlightedIndex]) {
        e.preventDefault();
        selectOptionValue(buttons[highlightedIndex].dataset.value || '');
        trigger.focus({ preventScroll: true });
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      typeaheadBuf += e.key.toLowerCase();
      window.clearTimeout(typeaheadTimer);
      typeaheadTimer = window.setTimeout(() => { typeaheadBuf = ''; }, 500);
      const idx = buttons.findIndex((b) =>
        (b.textContent || '').trim().toLowerCase().startsWith(typeaheadBuf)
      );
      if (idx >= 0) setHighlight(idx);
    }
  };

  const onWindowChange = () => {
    if (isOpen) positionMenu();
  };

  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    trigger.setAttribute('aria-expanded', 'false');
    menuEl?.remove();
    menuEl = null;
    highlightedIndex = -1;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    window.removeEventListener('resize', onWindowChange);
    window.removeEventListener('scroll', onWindowChange, true);
    if (activeDropdownController === controller) {
      activeDropdownController = null;
    }
  };

  const open = () => {
    if (isOpen || selectEl.disabled) return;
    if (activeDropdownController && activeDropdownController !== controller) {
      activeDropdownController.close();
    }
    isOpen = true;
    activeDropdownController = controller;
    trigger.setAttribute('aria-expanded', 'true');

    menuEl = document.createElement('div');
    menuEl.className = 'ui-dropdown-menu';
    menuEl.setAttribute('role', 'listbox');
    menuEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    menuEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    buildMenuItems();

    // Top-layer modal compatibility: mount inside <dialog> if inside one
    const portalHost = selectEl.closest('dialog') || document.body;
    portalHost.appendChild(menuEl);
    positionMenu();

    const buttons = getOptionButtons();
    const selectedBtnIdx = buttons.findIndex((b) => b.classList.contains('is-selected'));
    if (selectedBtnIdx >= 0) setHighlight(selectedBtnIdx);

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    window.addEventListener('resize', onWindowChange);
    window.addEventListener('scroll', onWindowChange, true);
  };

  trigger.addEventListener('pointerdown', (e) => e.stopPropagation());
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen) close();
    else open();
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      if (!isOpen) {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    }
  });

  const onNativeChange = () => syncVisibilityAndLabel();
  selectEl.addEventListener('change', onNativeChange);

  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => {
        syncVisibilityAndLabel();
        if (isOpen) {
          buildMenuItems();
          positionMenu();
        }
      })
    : null;
  observer?.observe(selectEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'class', 'style', 'title', 'aria-label'],
  });

  const controller = {
    element: root,
    trigger,
    select: selectEl,
    open,
    close,
    sync: syncVisibilityAndLabel,
    destroy() {
      close();
      observer?.disconnect();
      selectEl.removeEventListener('change', onNativeChange);
      delete selectEl.__sinDropdownController;
    },
  };

  selectEl.__sinDropdownController = controller;
  syncVisibilityAndLabel();
  return controller;
}

export function enhanceAllSelects(root = document, options = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const selects = Array.from(root.querySelectorAll('select:not([data-no-enhance])'));
  return selects.map((sel) => enhanceSelect(sel, options)).filter(Boolean);
}
