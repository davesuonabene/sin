import { renderIcon } from './icons.js';

export function createTransportBar(config = {}) {
  const root = document.createElement(config.tag || 'footer');
  root.className = `ui-transport${config.className ? ` ${config.className}` : ''}`;
  if (config.id) root.id = config.id;
  root.setAttribute('aria-label', config.ariaLabel || 'Playback transport');

  const refs = {
    root,
    targetSlot: null,
    controlsSlot: null,
    timelineSlot: null,
    timeEl: null,
    rightSlot: null,
    buttons: {},
  };

  if (config.targetElement) {
    const targetSlot = document.createElement('div');
    targetSlot.className = 'ui-transport-target';
    targetSlot.appendChild(config.targetElement);
    root.appendChild(targetSlot);
    refs.targetSlot = targetSlot;
  }

  const controlsSlot = document.createElement('div');
  controlsSlot.className = 'ui-transport-controls';
  const controls = Array.isArray(config.controls) ? config.controls : ['play'];
  for (const ctrl of controls) {
    if (ctrl === 'cue') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-btn ui-btn--bordered ui-transport-cue-btn';
      btn.textContent = 'Cue';
      controlsSlot.appendChild(btn);
      refs.buttons.cue = btn;
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-btn ui-btn--icon';
      btn.innerHTML = renderIcon(ctrl);
      controlsSlot.appendChild(btn);
      refs.buttons[ctrl] = btn;
    }
  }
  root.appendChild(controlsSlot);
  refs.controlsSlot = controlsSlot;

  const timelineSlot = document.createElement('div');
  timelineSlot.className = 'ui-transport-timeline';
  root.appendChild(timelineSlot);
  refs.timelineSlot = timelineSlot;

  if (config.showTime !== false) {
    const timeEl = document.createElement('span');
    timeEl.className = 'ui-transport-time';
    timeEl.textContent = '0:00 / 0:00';
    root.appendChild(timeEl);
    refs.timeEl = timeEl;
  }

  if (Array.isArray(config.rightElements) && config.rightElements.length > 0) {
    const rightSlot = document.createElement('div');
    rightSlot.className = 'ui-transport-right';
    for (const el of config.rightElements) {
      rightSlot.appendChild(el);
    }
    root.appendChild(rightSlot);
    refs.rightSlot = rightSlot;
  }

  return refs;
}
