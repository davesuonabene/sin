const SVG_OPEN = '<svg class="ui-svg-icon" viewBox="0 0 24 24" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

export const ICONS = {
  play: `${SVG_OPEN}<polygon points="7 5 19 12 7 19 7 5" fill="currentColor" stroke="none"/>${SVG_CLOSE}`,
  pause: `${SVG_OPEN}<rect x="6" y="5" width="4" height="14" rx="0.5" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="0.5" fill="currentColor" stroke="none"/>${SVG_CLOSE}`,
  stop: `${SVG_OPEN}<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>${SVG_CLOSE}`,
  loop: `${SVG_OPEN}<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>${SVG_CLOSE}`,
  cue: `${SVG_OPEN}<path d="M12 3v18"/><path d="M12 4l6 3.5-6 3.5"/>${SVG_CLOSE}`,
  volume: `${SVG_OPEN}<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>${SVG_CLOSE}`,
  muted: `${SVG_OPEN}<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>${SVG_CLOSE}`,
  sidebar: `${SVG_OPEN}<rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="9" y1="4" x2="9" y2="20"/>${SVG_CLOSE}`,
  inspector: `${SVG_OPEN}<path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>${SVG_CLOSE}`,
  dock: `${SVG_OPEN}<rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="15" y1="4" x2="15" y2="20"/>${SVG_CLOSE}`,
  float: `${SVG_OPEN}<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>${SVG_CLOSE}`,
  close: `${SVG_OPEN}<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>${SVG_CLOSE}`,
  chevronDown: `${SVG_OPEN}<polyline points="6 9 12 15 18 9"/>${SVG_CLOSE}`,
  chevronUp: `${SVG_OPEN}<polyline points="18 15 12 9 6 15"/>${SVG_CLOSE}`,
  chevronRight: `${SVG_OPEN}<polyline points="9 6 15 12 9 18"/>${SVG_CLOSE}`,
  filter: `${SVG_OPEN}<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>${SVG_CLOSE}`,
  plus: `${SVG_OPEN}<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>${SVG_CLOSE}`,
  minus: `${SVG_OPEN}<line x1="5" y1="12" x2="19" y2="12"/>${SVG_CLOSE}`,
  refresh: `${SVG_OPEN}<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>${SVG_CLOSE}`,
  search: `${SVG_OPEN}<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>${SVG_CLOSE}`,
  star: `${SVG_OPEN}<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>${SVG_CLOSE}`,
  starFilled: `${SVG_OPEN}<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/>${SVG_CLOSE}`,
  download: `${SVG_OPEN}<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>${SVG_CLOSE}`,
  upload: `${SVG_OPEN}<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>${SVG_CLOSE}`,
  zap: `${SVG_OPEN}<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>${SVG_CLOSE}`,
  folder: `${SVG_OPEN}<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>${SVG_CLOSE}`,
  externalLink: `${SVG_OPEN}<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>${SVG_CLOSE}`,
  sliders: `${SVG_OPEN}<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>${SVG_CLOSE}`,
  eye: `${SVG_OPEN}<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>${SVG_CLOSE}`,
  eyeOff: `${SVG_OPEN}<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>${SVG_CLOSE}`,
  renderFlag: `${SVG_OPEN}<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M9.5 15.5v-7h3.25a2.25 2.25 0 0 1 0 4.5H9.5m3 0 2.5 2.5"/>${SVG_CLOSE}`,
  freeze: `${SVG_OPEN}<line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>${SVG_CLOSE}`,
  dice: `${SVG_OPEN}<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.25" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.25" fill="currentColor" stroke="none"/>${SVG_CLOSE}`,
  lockOpen: `${SVG_OPEN}<rect x="3" y="11" width="18" height="11" rx="1.5"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>${SVG_CLOSE}`,
  lockClosed: `${SVG_OPEN}<rect x="3" y="11" width="18" height="11" rx="1.5"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>${SVG_CLOSE}`,
  trash: `${SVG_OPEN}<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>${SVG_CLOSE}`,
  pool: `${SVG_OPEN}<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>${SVG_CLOSE}`,
  save: `${SVG_OPEN}<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>${SVG_CLOSE}`,
  pencil: `${SVG_OPEN}<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>${SVG_CLOSE}`,
  undo: `${SVG_OPEN}<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>${SVG_CLOSE}`,
  arrowLeft: `${SVG_OPEN}<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>${SVG_CLOSE}`,
  palette: `${SVG_OPEN}<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10.5" r="1" fill="currentColor" stroke="none"/>${SVG_CLOSE}`,
  activity: `${SVG_OPEN}<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>${SVG_CLOSE}`,
  fit: `${SVG_OPEN}<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>${SVG_CLOSE}`,
  globe: `${SVG_OPEN}<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.35 3.3 5.18 3.3 8.5S14.2 18.15 12 20.5c-2.2-2.35-3.3-5.18-3.3-8.5S9.8 5.85 12 3.5z"/>${SVG_CLOSE}`,
  check: `${SVG_OPEN}<polyline points="20 6 9 17 4 12"/>${SVG_CLOSE}`,
  layers: `${SVG_OPEN}<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>${SVG_CLOSE}`,
  more: `${SVG_OPEN}<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/>${SVG_CLOSE}`,
};

export function renderIcon(name, className = '') {
  const svg = ICONS[name] || '';
  if (!className || !svg) return svg;
  return svg.replace('class="ui-svg-icon"', `class="ui-svg-icon ${className}"`);
}
