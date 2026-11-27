import { renderIcon } from '../../../packages/ui/src/icons.js';
import { enhanceRangeSlider } from '../../../packages/ui/src/slider.js';

export const HEADER_REFRESH_ICON_SVG = renderIcon('refresh', 'toolbar-svg-icon');
export const HEADER_FREEZE_ICON_SVG = renderIcon('freeze', 'toolbar-svg-icon');
export const HEADER_LOCK_OPEN_ICON_SVG = renderIcon('lockOpen', 'toolbar-svg-icon');
export const HEADER_LOCK_CLOSED_ICON_SVG = renderIcon('lockClosed', 'toolbar-svg-icon');
export const HEADER_SIDEBAR_ICON_SVG = renderIcon('sidebar', 'toolbar-svg-icon');
export const HEADER_INSPECTOR_ICON_SVG = renderIcon('inspector', 'toolbar-svg-icon');

export const HEADER_VIEW_MORPH_ICON_SVG = `
<svg class="view-morph-svg" viewBox="0 0 21 21" width="21" height="21" fill="none" aria-hidden="true">
    <path class="vm-wire vm-wire-top" d="M5 4.5 L16 10" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
    <path class="vm-wire vm-wire-bot" d="M5 16.5 L16 11" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
    <rect class="vm-node vm-a" x="2" y="3" width="3" height="3" rx="0.5" fill="currentColor"/>
    <rect class="vm-node vm-b" x="2" y="15" width="3" height="3" rx="0.5" fill="currentColor"/>
    <rect class="vm-node vm-c" x="16" y="9" width="3" height="3" rx="0.5" fill="currentColor"/>
    <line class="vm-playhead" x1="10.5" y1="2" x2="10.5" y2="19" stroke="currentColor" stroke-width="1" stroke-linecap="square"/>
</svg>
`.trim();

export const playIcon = renderIcon('play');
export const pauseIcon = renderIcon('pause');
export const stopIcon = renderIcon('stop');
export const loopIcon = renderIcon('loop');
export const volumeIcon = renderIcon('volume');
export const mutedIcon = renderIcon('muted');

export function createAppShell(appElement: HTMLElement) {
    const topHeader = document.createElement('header');
    topHeader.className = 'top-header';
    topHeader.innerHTML = `
        <div class="header-menu-row">
            <div class="top-header-left">
                <div class="header-menus">
                    <details class="header-menu" id="file-menu" name="header-menus">
                        <summary>File</summary>
                        <div class="header-menu-popover sin-menu-surface">
                            <button id="new-stage-btn" class="header-menu-action sin-menu-item" type="button">New</button>
                            <button id="open-workspace-btn" class="header-menu-action sin-menu-item" type="button">Open...</button>
                            <div class="header-menu-submenu-item" id="open-recent-menu-item">
                                <button id="open-recent-trigger-btn" class="header-menu-action header-menu-submenu-trigger sin-menu-item" type="button">
                                    <span>Open Recent</span>
                                    <span class="header-menu-submenu-arrow">▶</span>
                                </button>
                                <div class="header-submenu-popover sin-menu-surface" id="open-recent-popover">
                                    <div class="header-menu-hint">No recent workspaces</div>
                                </div>
                            </div>
                            <div class="header-menu-separator sin-menu-divider"></div>
                            <button id="save-workspace-btn" class="header-menu-action sin-menu-item" type="button">Save</button>
                            <button id="save-workspace-as-btn" class="header-menu-action sin-menu-item" type="button">Save As...</button>
                            <div class="header-menu-separator sin-menu-divider"></div>
                            <button id="export-btn" class="header-menu-action sin-menu-item" type="button">Download selected audio</button>
                            <select id="workspace-preset-select" class="header-select workspace-preset-select sin-select" aria-label="Workspace save" style="display: none;">
                                <option value="">No saved workspaces</option>
                            </select>
                            <button id="load-workspace-btn" style="display: none;" disabled></button>
                            <button id="delete-workspace-btn" style="display: none;" disabled></button>
                        </div>
                    </details>
                    <details class="header-menu" id="library-menu" name="header-menus">
                        <summary>Library</summary>
                        <div class="header-menu-popover sin-menu-surface">
                            <button id="toggle-library-btn" class="header-menu-action sin-menu-item">Open Library</button>
                            <button id="refresh-library-btn" class="header-menu-action sin-menu-item">Refresh Library</button>
                            <button id="toggle-library-preview-btn" class="header-menu-action sin-menu-item" aria-pressed="true">Auto-preview: On</button>
                            <div class="header-menu-hint">Library management stays in GAIA.</div>
                        </div>
                    </details>
                    <details class="header-menu" id="render-menu" name="header-menus">
                        <summary>Render</summary>
                        <div class="header-menu-popover sin-menu-surface">
                            <button id="render-flagged-btn" class="header-menu-action sin-menu-item">Render Flagged Nodes</button>
                            <button id="render-selected-btn" class="header-menu-action sin-menu-item">Render Selected Nodes</button>
                            <button id="render-most-parent-btn" class="header-menu-action sin-menu-item">Render Most Parent Nodes</button>
                            <div class="header-menu-separator sin-menu-divider"></div>
                            <button id="render-all-btn" class="header-menu-action sin-menu-item">Render All Nodes</button>
                        </div>
                    </details>
                </div>
            </div>
        </div>
        <div class="header-toolbar-row">
            <div class="header-toolbar-left">
                <button id="floating-toggle-library" class="header-btn icon-header-btn squared-btn ui-btn ui-btn--icon ui-btn--bordered" type="button" title="Toggle Library Panel (Shortcut: L)" aria-label="Toggle Library Panel" aria-expanded="false">
                    ${HEADER_SIDEBAR_ICON_SVG}
                </button>
            </div>
            <div class="top-header-center">
                <button id="view-mode-toggle" class="header-view-morph-btn" type="button" data-mode="graph" aria-pressed="false" aria-label="Switch to Horizontal Timeline View" title="Switch to Timeline View (Tab)">
                    ${HEADER_VIEW_MORPH_ICON_SVG}
                </button>
            </div>
            <div class="top-header-right">
                <button id="preview-recalculate-btn" class="header-btn preview-recalculate-btn icon-header-btn squared-btn ui-btn ui-btn--icon ui-btn--bordered" type="button" title="Refresh pools, samples, and modifiers" aria-label="Refresh pools, samples, and modifiers" disabled>
                    ${HEADER_REFRESH_ICON_SVG}
                </button>
                <div class="global-seed-control" title="Global Seed (0 = user pool order)">
                    <input id="global-seed-input" class="global-seed-input ui-input" type="number" min="0" step="1" value="0" aria-label="Global Seed" />
                    <button id="global-seed-lock-btn" class="header-btn global-seed-lock-btn icon-header-btn squared-btn ui-btn ui-btn--icon ui-btn--bordered" type="button" title="Global Seed Lock: OFF (Refresh updates Global Seed, pools, random modifiers, and field operators)" aria-label="Lock Global Seed" aria-pressed="false">
                        ${HEADER_LOCK_OPEN_ICON_SVG}
                    </button>
                </div>
                <button id="global-freeze-btn" class="header-btn global-freeze-btn icon-header-btn squared-btn ui-btn ui-btn--icon ui-btn--bordered" type="button" title="Global Freeze: OFF (Flagged nodes refresh on recalculate)" aria-label="Toggle Global Freeze" aria-pressed="false">
                    ${HEADER_FREEZE_ICON_SVG}
                </button>
                <div class="header-btn-separator ui-divider" aria-hidden="true"></div>
                <button id="header-toggle-properties" class="header-btn secondary-tool-btn icon-header-btn squared-btn ui-btn ui-btn--icon ui-btn--bordered" type="button" title="Toggle Properties / Inspector (Shortcut: P)" aria-label="Toggle Properties / Inspector" aria-expanded="false">
                    ${HEADER_INSPECTOR_ICON_SVG}
                </button>
            </div>
        </div>
    `;

    // Pure full-width waveform visualizer bar (no buttons, no dropdowns — controlled via #global-footer-bar)
    const playbackFooter = document.createElement('footer');
    playbackFooter.className = 'playback-footer';
    playbackFooter.setAttribute('aria-label', 'Preview waveform');
    playbackFooter.innerHTML = `
        <audio id="master-player" preload="metadata"></audio>
        <div id="master-waveform" class="master-waveform" title="Click or drag to seek · Scroll to zoom · Double-click to reset zoom"></div>
    `;

    const dockviewContainer = document.createElement('div');
    dockviewContainer.className = 'dockview-container';

    // Unified global minimal footer bar shared across Graph View & Timeline View
    const globalFooterBar = document.createElement('div');
    globalFooterBar.id = 'global-footer-bar';
    globalFooterBar.className = 'sin-global-footer';
    globalFooterBar.setAttribute('role', 'contentinfo');

    const globalFooterLeft = document.createElement('div');
    globalFooterLeft.className = 'sin-global-footer-left';

    const timelineToggleRowsBtn = document.createElement('button');
    timelineToggleRowsBtn.id = 'timeline-toggle-rows-btn';
    timelineToggleRowsBtn.type = 'button';
    timelineToggleRowsBtn.className = 'ui-btn ui-btn--xs ui-btn--bordered sin-footer-rows-btn is-hidden';
    timelineToggleRowsBtn.textContent = 'Expand Rows';

    // Ableton-style borderless transparent transport icons centered in the shared footer bar
    const globalFooterTransport = document.createElement('div');
    globalFooterTransport.id = 'global-footer-transport';
    globalFooterTransport.className = 'sin-global-footer-transport';
    globalFooterTransport.setAttribute('role', 'group');
    globalFooterTransport.setAttribute('aria-label', 'Playback transport');
    globalFooterTransport.innerHTML = `
        <button id="master-play-btn" class="sin-transport-icon-btn sin-transport-play-btn" type="button" aria-label="Play (Space)" title="Play (Space)" disabled>
            ${playIcon}
        </button>
        <button id="master-stop-btn" class="sin-transport-icon-btn sin-transport-stop-btn" type="button" aria-label="Stop" title="Stop &amp; reset playhead" disabled>
            ${stopIcon}
        </button>
        <button id="master-loop-btn" class="sin-transport-icon-btn sin-transport-loop-btn" type="button" aria-label="Loop off" title="Toggle loop" aria-pressed="false" disabled>
            ${loopIcon}
        </button>
        <span class="sin-transport-sep" aria-hidden="true"></span>
        <div class="sin-footer-volume">
            <button id="master-mute-btn" class="sin-transport-icon-btn sin-transport-mute-btn" type="button" aria-label="Mute" title="Mute">
                ${volumeIcon}
            </button>
            <input id="master-volume" class="master-volume-slider sin-footer-volume-slider" type="range" min="0" max="1" step="0.01" value="1" aria-label="Master Volume">
        </div>
    `;

    const globalPathBar = document.createElement('nav');
    globalPathBar.id = 'global-path-bar';
    globalPathBar.className = 'sin-rack-path-bar sin-global-footer-path';
    globalPathBar.setAttribute('aria-label', 'Active preview ancestor path');

    globalFooterBar.append(globalFooterLeft, globalFooterTransport, globalPathBar);

    appElement.appendChild(topHeader);
    appElement.appendChild(dockviewContainer);
    appElement.appendChild(playbackFooter);
    appElement.appendChild(globalFooterBar);

    const masterVolumeEl = globalFooterTransport.querySelector('#master-volume') as HTMLInputElement | null;
    if (masterVolumeEl) {
        enhanceRangeSlider(masterVolumeEl, { defaultValue: 1, showValue: false, compact: true });
    }

    // Lightweight floating-panel clamp: track direct floating overlays without observing deep subtrees
    let hasFloatingGroups = false;
    const clampFloatingPanels = () => {
        const elements = dockviewContainer.querySelectorAll<HTMLElement>('.dv-floating-group, .dv-resize-container');
        hasFloatingGroups = elements.length > 0;
        elements.forEach(el => {
            const topVal = parseFloat(el.style.top);
            if (!isNaN(topVal) && topVal < 0) {
                el.style.top = '0px';
            }
        });
    };

    let floatingClampFrame: number | null = null;
    const scheduleFloatingPanelClamp = () => {
        if (floatingClampFrame !== null) return;
        floatingClampFrame = requestAnimationFrame(() => {
            floatingClampFrame = null;
            clampFloatingPanels();
        });
    };

    // Observe direct child changes + check once on pointerdown (zero deep subtree mutation overhead!)
    const floatingObserver = new MutationObserver(() => {
        hasFloatingGroups = Boolean(dockviewContainer.querySelector('.dv-floating-group'));
        if (hasFloatingGroups) scheduleFloatingPanelClamp();
    });
    floatingObserver.observe(dockviewContainer, { childList: true });

    dockviewContainer.addEventListener('pointerdown', () => {
        hasFloatingGroups = Boolean(dockviewContainer.querySelector('.dv-floating-group'));
    }, { passive: true, capture: true });

    window.addEventListener('pointermove', (e: PointerEvent) => {
        if (hasFloatingGroups && e.buttons > 0) scheduleFloatingPanelClamp();
    }, { passive: true });

    // Ensure menu dropdowns close when another is opened and on outside click
    const headerMenus = topHeader.querySelectorAll<HTMLDetailsElement>('details.header-menu');
    headerMenus.forEach(menu => {
        menu.addEventListener('toggle', () => {
            if (menu.open) {
                headerMenus.forEach(other => {
                    if (other !== menu && other.open) {
                        other.open = false;
                    }
                });
            }
        });
    });

    document.addEventListener('pointerdown', (e: PointerEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target?.closest('details.header-menu')) {
            headerMenus.forEach(m => {
                if (m.open) m.open = false;
            });
        }
    });

    const floatingToggleLibrary = topHeader.querySelector('#floating-toggle-library') as HTMLButtonElement;
    return {
        topHeader,
        dockviewContainer,
        playbackFooter,
        globalFooterBar,
        globalFooterLeft,
        globalPathBar,
        timelineToggleRowsBtn,
        floatingToggleLibrary,
        headerToggleLibrary: floatingToggleLibrary,
        masterPlayer: playbackFooter.querySelector('#master-player') as HTMLAudioElement,
        masterPlayBtn: globalFooterTransport.querySelector('#master-play-btn') as HTMLButtonElement,
        masterStopBtn: globalFooterTransport.querySelector('#master-stop-btn') as HTMLButtonElement,
        masterLoopBtn: globalFooterTransport.querySelector('#master-loop-btn') as HTMLButtonElement,
        masterMuteBtn: globalFooterTransport.querySelector('#master-mute-btn') as HTMLButtonElement,
        masterVolume: globalFooterTransport.querySelector('#master-volume') as HTMLInputElement,
        exportBtn: topHeader.querySelector('#export-btn') as HTMLButtonElement,
        previewRecalculateBtn: topHeader.querySelector('#preview-recalculate-btn') as HTMLButtonElement,
        globalSeedInput: topHeader.querySelector('#global-seed-input') as HTMLInputElement,
        globalSeedLockBtn: topHeader.querySelector('#global-seed-lock-btn') as HTMLButtonElement,
        globalFreezeBtn: topHeader.querySelector('#global-freeze-btn') as HTMLButtonElement,
        viewModeToggleBtn: topHeader.querySelector('#view-mode-toggle') as HTMLButtonElement,
        toggleLibraryBtn: topHeader.querySelector('#toggle-library-btn') as HTMLButtonElement,
        refreshLibraryBtn: topHeader.querySelector('#refresh-library-btn') as HTMLButtonElement | null,
        toggleLibraryPreviewBtn: topHeader.querySelector('#toggle-library-preview-btn') as HTMLButtonElement,
        headerToggleProperties: topHeader.querySelector('#header-toggle-properties') as HTMLButtonElement,
        fileMenu: topHeader.querySelector('#file-menu') as HTMLDetailsElement,
        libraryMenu: topHeader.querySelector('#library-menu') as HTMLDetailsElement,
        renderMenu: topHeader.querySelector('#render-menu') as HTMLDetailsElement,
        renderFlaggedBtn: topHeader.querySelector('#render-flagged-btn') as HTMLButtonElement,
        renderSelectedBtn: topHeader.querySelector('#render-selected-btn') as HTMLButtonElement,
        renderMostParentBtn: topHeader.querySelector('#render-most-parent-btn') as HTMLButtonElement,
        renderAllBtn: topHeader.querySelector('#render-all-btn') as HTMLButtonElement,
        newStageBtn: topHeader.querySelector('#new-stage-btn') as HTMLButtonElement,
        masterWaveformElement: playbackFooter.querySelector('#master-waveform') as HTMLDivElement,
        workspacePresetSelect: topHeader.querySelector('#workspace-preset-select') as HTMLSelectElement,
        saveWorkspaceAsBtn: topHeader.querySelector('#save-workspace-as-btn') as HTMLButtonElement,
        saveWorkspaceBtn: topHeader.querySelector('#save-workspace-btn') as HTMLButtonElement,
        loadWorkspaceBtn: (topHeader.querySelector('#open-workspace-btn') || topHeader.querySelector('#load-workspace-btn')) as HTMLButtonElement,
        openWorkspaceBtn: topHeader.querySelector('#open-workspace-btn') as HTMLButtonElement,
        openRecentTriggerBtn: topHeader.querySelector('#open-recent-trigger-btn') as HTMLButtonElement,
        openRecentPopover: topHeader.querySelector('#open-recent-popover') as HTMLDivElement,
        deleteWorkspaceBtn: topHeader.querySelector('#delete-workspace-btn') as HTMLButtonElement,
    };
}

