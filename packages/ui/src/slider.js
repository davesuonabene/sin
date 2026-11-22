export function clampSliderValue(value, min, max) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 100;
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  const num = Number.isFinite(value) ? value : low;
  return Math.max(low, Math.min(high, num));
}

export function normalizeSliderRatio(value, min, max) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 100;
  const span = hi - lo;
  if (Math.abs(span) < 1e-12) return 0;
  const clamped = clampSliderValue(value, lo, hi);
  return Math.max(0, Math.min(1, (clamped - lo) / span));
}

export function snapSliderValue(value, min, max, step) {
  const clamped = clampSliderValue(value, min, max);
  const st = Number(step);
  if (!Number.isFinite(st) || st <= 0) return clamped;
  const lo = Number.isFinite(min) ? min : 0;
  const steps = Math.round((clamped - lo) / st);
  const snapped = lo + steps * st;
  const stepStr = String(st);
  const decimals = stepStr.includes('.') ? Math.min(8, stepStr.split('.')[1].length) : 0;
  const rounded = decimals > 0 ? Number(snapped.toFixed(decimals)) : Math.round(snapped);
  return clampSliderValue(rounded, min, max);
}

export function computeSliderFillGeometry(value, min, max, bipolar = false) {
  const ratio = normalizeSliderRatio(value, min, max);
  const isBipolar = Boolean(bipolar && min < 0 && max > 0);
  const zeroRatio = isBipolar ? normalizeSliderRatio(0, min, max) : 0;
  const leftPct = Math.min(ratio, zeroRatio) * 100;
  const widthPct = Math.abs(ratio - zeroRatio) * 100;
  const headPct = ratio * 100;
  return {
    ratio,
    zeroRatio,
    leftPct,
    widthPct,
    headPct,
    isBipolar,
  };
}

function defaultFormat(val, step) {
  const st = Number(step);
  if (Number.isFinite(st) && st >= 1 && Number.isInteger(st)) {
    return String(Math.round(val));
  }
  const decimals = String(st).includes('.') ? Math.min(3, String(st).split('.')[1].length) : 2;
  return Number(val).toFixed(decimals);
}

export function enhanceRangeSlider(inputEl, options = {}) {
  if (
    !inputEl ||
    inputEl.tagName !== 'INPUT' ||
    typeof inputEl.hasAttribute !== 'function' ||
    typeof HTMLInputElement === 'undefined'
  ) {
    return null;
  }
  if (inputEl.__sinSliderController) {
    inputEl.__sinSliderController.sync();
    return inputEl.__sinSliderController;
  }

  const root = document.createElement('div');
  root.className = `ui-slider${options.compact ? ' ui-slider--compact' : ''}${options.className ? ` ${options.className}` : ''}`;

  const fillEl = document.createElement('div');
  fillEl.className = 'ui-slider-fill';

  const modBandEl = document.createElement('div');
  modBandEl.className = 'ui-slider-mod-band';

  const zeroEl = document.createElement('div');
  zeroEl.className = 'ui-slider-zero';

  const headEl = document.createElement('div');
  headEl.className = 'ui-slider-head';

  const contentEl = document.createElement('div');
  contentEl.className = 'ui-slider-content';

  let labelEl = null;
  if (options.label) {
    labelEl = document.createElement('span');
    labelEl.className = 'ui-slider-label';
    labelEl.textContent = options.label;
    contentEl.appendChild(labelEl);
  }

  const showValue = options.showValue !== false;
  let valueEl = null;
  if (showValue) {
    valueEl = document.createElement('span');
    valueEl.className = `ui-slider-value${options.onValueClick ? ' is-interactive' : ''}`;
    if (options.onValueClick) {
      valueEl.addEventListener('pointerdown', (e) => e.stopPropagation());
      valueEl.addEventListener('click', (e) => {
        e.stopPropagation();
        options.onValueClick();
      });
    }
    contentEl.appendChild(valueEl);
  }

  root.append(fillEl, modBandEl, zeroEl, headEl, contentEl);

  const parent = inputEl.parentNode;
  if (parent) {
    parent.insertBefore(root, inputEl);
  }
  inputEl.classList.add('ui-slider-native');
  inputEl.tabIndex = -1;
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  if (inputEl.getAttribute('aria-label')) {
    root.setAttribute('aria-label', inputEl.getAttribute('aria-label'));
  }
  if (inputEl.title && !root.title) {
    root.title = inputEl.title;
  }
  root.appendChild(inputEl);

  const getBounds = () => {
    const min = Number(inputEl.min === '' ? 0 : inputEl.min);
    const max = Number(inputEl.max === '' ? 100 : inputEl.max);
    const step = Number(inputEl.step === '' || inputEl.step === 'any' ? 0.01 : inputEl.step);
    return {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 100,
      step: Number.isFinite(step) && step > 0 ? step : 0.01,
    };
  };

  const isBipolar = () => {
    const { min, max } = getBounds();
    if (options.bipolar !== undefined) return Boolean(options.bipolar && min < 0 && max > 0);
    return min < 0 && max > 0;
  };

  const resolveDefault = () => {
    const { min, max } = getBounds();
    if (options.defaultValue !== undefined && Number.isFinite(Number(options.defaultValue))) {
      return clampSliderValue(Number(options.defaultValue), min, max);
    }
    return isBipolar() ? 0 : min;
  };

  let syncingFromDom = false;
  const protoDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  const renderVisual = () => {
    const { min, max, step } = getBounds();
    const rawVal = protoDesc ? Number(protoDesc.get.call(inputEl)) : Number(inputEl.value);
    const val = clampSliderValue(Number.isFinite(rawVal) ? rawVal : min, min, max);
    const geom = computeSliderFillGeometry(val, min, max, isBipolar());

    root.dataset.bipolar = String(geom.isBipolar);
    root.classList.toggle('is-disabled', Boolean(inputEl.disabled));
    root.setAttribute('aria-valuemin', String(min));
    root.setAttribute('aria-valuemax', String(max));
    root.setAttribute('aria-valuenow', String(val));

    fillEl.style.left = `${geom.leftPct}%`;
    fillEl.style.width = `${geom.widthPct}%`;
    headEl.style.left = `${geom.headPct}%`;
    if (geom.isBipolar) {
      zeroEl.style.left = `${geom.zeroRatio * 100}%`;
    }
    if (valueEl) {
      valueEl.textContent = options.formatValue ? options.formatValue(val) : defaultFormat(val, step);
    }
  };

  if (protoDesc && protoDesc.set) {
    Object.defineProperty(inputEl, 'value', {
      configurable: true,
      get() {
        return protoDesc.get.call(this);
      },
      set(next) {
        protoDesc.set.call(this, next);
        if (!syncingFromDom) renderVisual();
      },
    });
  }

  const commitNumericValue = (nextVal, emitChange = false) => {
    const { min, max, step } = getBounds();
    const snapped = snapSliderValue(nextVal, min, max, step);
    const prev = Number(inputEl.value);
    syncingFromDom = true;
    if (protoDesc?.set) protoDesc.set.call(inputEl, String(snapped));
    else inputEl.value = String(snapped);
    syncingFromDom = false;
    renderVisual();
    if (!Object.is(prev, snapped)) {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (emitChange) {
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  let dragging = false;
  let shiftAnchorX = 0;
  let shiftAnchorVal = 0;
  let shiftMode = false;

  const valueAtPointer = (clientX) => {
    const rect = root.getBoundingClientRect();
    const { min, max } = getBounds();
    if (rect.width <= 0) return min;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return min + ratio * (max - min);
  };

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || inputEl.disabled) return;
    e.preventDefault();
    root.focus({ preventScroll: true });
    dragging = true;
    root.classList.add('is-dragging');
    try { root.setPointerCapture(e.pointerId); } catch {}
    shiftMode = e.shiftKey;
    if (shiftMode) {
      shiftAnchorX = e.clientX;
      shiftAnchorVal = Number(inputEl.value);
    } else {
      const next = valueAtPointer(e.clientX);
      shiftAnchorX = e.clientX;
      shiftAnchorVal = next;
      commitNumericValue(next, false);
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (e.shiftKey !== shiftMode) {
      shiftMode = e.shiftKey;
      shiftAnchorX = e.clientX;
      shiftAnchorVal = Number(inputEl.value);
    }
    if (shiftMode) {
      const rect = root.getBoundingClientRect();
      const { min, max } = getBounds();
      const width = Math.max(1, rect.width);
      const deltaRatio = ((e.clientX - shiftAnchorX) / width) * 0.2;
      commitNumericValue(shiftAnchorVal + deltaRatio * (max - min), false);
    } else {
      const next = valueAtPointer(e.clientX);
      commitNumericValue(next, false);
    }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('is-dragging');
    try { root.releasePointerCapture(e.pointerId); } catch {}
    commitNumericValue(Number(inputEl.value), true);
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  root.addEventListener('dblclick', (e) => {
    if (inputEl.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const def = resolveDefault();
    commitNumericValue(def, true);
    options.onDoubleClickReset?.(def);
  });

  root.addEventListener('keydown', (e) => {
    if (inputEl.disabled) return;
    const { min, max, step } = getBounds();
    const cur = Number(inputEl.value);
    const mult = e.shiftKey ? 5 : 1;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step * mult;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step * mult;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next !== null) {
      e.preventDefault();
      commitNumericValue(next, true);
    }
  });

  const onNativeSync = () => renderVisual();
  inputEl.addEventListener('input', onNativeSync);
  inputEl.addEventListener('change', onNativeSync);

  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => renderVisual())
    : null;
  observer?.observe(inputEl, {
    attributes: true,
    attributeFilter: ['disabled', 'min', 'max', 'step', 'value', 'title'],
  });

  const controller = {
    element: root,
    input: inputEl,
    sync: renderVisual,
    setLabel(text) {
      if (labelEl) labelEl.textContent = text;
    },
    setModulationBand(startPct, endPct, color) {
      if (startPct == null || endPct == null) {
        modBandEl.style.display = 'none';
        return;
      }
      const lo = Math.max(0, Math.min(100, startPct));
      const hi = Math.max(lo, Math.min(100, endPct));
      modBandEl.style.display = 'block';
      modBandEl.style.left = `${lo}%`;
      modBandEl.style.width = `${Math.max(1, hi - lo)}%`;
      modBandEl.style.backgroundColor = color || '#0284c7';
    },
    destroy() {
      observer?.disconnect();
      inputEl.removeEventListener('input', onNativeSync);
      inputEl.removeEventListener('change', onNativeSync);
      delete inputEl.__sinSliderController;
    },
  };

  inputEl.__sinSliderController = controller;
  renderVisual();
  return controller;
}

export function createAbletonSlider(options = {}) {
  const input = document.createElement('input');
  input.type = 'range';
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.step !== undefined) input.step = String(options.step);
  if (options.value !== undefined) input.value = String(options.value);
  if (options.ariaLabel) input.setAttribute('aria-label', options.ariaLabel);
  if (options.title) input.title = options.title;
  if (options.onInput) {
    input.addEventListener('input', () => options.onInput(Number(input.value)));
  }
  if (options.onChange) {
    input.addEventListener('change', () => options.onChange(Number(input.value)));
  }
  return enhanceRangeSlider(input, options);
}
