import { renderIcon } from '../../../packages/ui/src/icons.js';
import { enhanceSelect } from '../../../packages/ui/src/dropdown.js';
import { enhanceRangeSlider } from '../../../packages/ui/src/slider.js';

export const HEADER_PLAY_ICON_SVG = renderIcon('play', 'toolbar-svg-icon');
export const HEADER_PAUSE_ICON_SVG = renderIcon('pause', 'toolbar-svg-icon');
export const HEADER_REFRESH_ICON_SVG = renderIcon('refresh', 'toolbar-svg-icon');
export const HEADER_FREEZE_ICON_SVG = renderIcon('freeze', 'toolbar-svg-icon');
export const HEADER_LOCK_OPEN_ICON_SVG = renderIcon('lockOpen', 'toolbar-svg-icon');
export const HEADER_LOCK_CLOSED_ICON_SVG = renderIcon('lockClosed', 'toolbar-svg-icon');
export const HEADER_SIDEBAR_ICON_SVG = renderIcon('sidebar', 'toolbar-svg-icon');
export const HEADER_INSPECTOR_ICON_SVG = renderIcon('inspector', 'toolbar-svg-icon');

export const playIcon = renderIcon('play');
export const pauseIcon = renderIcon('pause');
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
            <div class="top-header-center"></div>
            <div class="top-header-right">
                <button id="global-preview-btn" class="header-btn global-preview-btn icon-header-btn squared-btn ui-btn ui-btn--icon ui-btn--bordered" type="button" title="Play transport (Space)" aria-label="Play transport (Space)" disabled>
                    ${HEADER_PLAY_ICON_SVG}
                </button>
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

    const playbackFooter = document.createElement('footer');
    playbackFooter.className = 'playback-footer';
    playbackFooter.setAttribute('aria-label', 'Playback transport');
    playbackFooter.innerHTML = `
        <div class="playback-toolbar ui-transport">
            <div class="render-select-wrapper ui-transport-target">
                <select id="temp-files-select" class="playback-track-select sin-select" aria-label="Playback track">
                    <option value="" disabled selected>No renders available</option>
                </select>
            </div>
            <div class="master-player-wrapper ui-transport-controls">
                <audio id="master-player" preload="metadata"></audio>
                <button id="master-play-btn" class="ui-btn ui-btn--icon ui-btn--bordered master-control-btn" type="button" aria-label="Play" title="Play" disabled>
                    ${playIcon}
                </button>
                <button id="master-loop-btn" class="ui-btn ui-btn--icon ui-btn--bordered master-control-btn master-loop-btn" type="button" aria-label="Loop off" title="Loop off" aria-pressed="false" disabled>
                    ${renderIcon('loop')}
                </button>
                <span id="master-time-display" class="ui-transport-time">0:00 / 0:00</span>
            </div>
            <div id="master-waveform" class="master-waveform ui-transport-timeline" title="Click or drag to seek"></div>
            <div class="master-volume-control ui-transport-right ui-transport-volume">
                <button id="master-mute-btn" class="ui-btn ui-btn--icon master-control-btn master-volume-btn" type="button" aria-label="Mute" title="Mute">
                    ${volumeIcon}
                </button>
                <input id="master-volume" class="master-volume-slider ui-transport-volume-slider" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume">
            </div>
        </div>
    `;

    const dockviewContainer = document.createElement('div');
    dockviewContainer.className = 'dockview-container';

    appElement.appendChild(topHeader);
    appElement.appendChild(dockviewContainer);
    appElement.appendChild(playbackFooter);

    const tempFilesSelectEl = playbackFooter.querySelector('#temp-files-select') as HTMLSelectElement | null;
    const masterVolumeEl = playbackFooter.querySelector('#master-volume') as HTMLInputElement | null;
    if (tempFilesSelectEl) {
        enhanceSelect(tempFilesSelectEl, { preferUp: true });
    }
    if (masterVolumeEl) {
        enhanceRangeSlider(masterVolumeEl, { defaultValue: 1, showValue: false, compact: true });
    }

    // Strictly prevent floating panels from being dragged or positioned higher than y = 0 (under or past the header)
    const clampFloatingPanels = () => {
        const elements = dockviewContainer.querySelectorAll<HTMLElement>('.dv-floating-group, .dv-resize-container');
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

    const floatingObserver = new MutationObserver(scheduleFloatingPanelClamp);
    floatingObserver.observe(dockviewContainer, { childList: true, subtree: true });

    window.addEventListener('pointermove', (e: PointerEvent) => {
        if (e.buttons > 0) scheduleFloatingPanelClamp();
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
        floatingToggleLibrary,
        headerToggleLibrary: floatingToggleLibrary,
        tempFilesSelect: playbackFooter.querySelector('#temp-files-select') as HTMLSelectElement,
        masterPlayer: playbackFooter.querySelector('#master-player') as HTMLAudioElement,
        masterPlayBtn: playbackFooter.querySelector('#master-play-btn') as HTMLButtonElement,
        masterLoopBtn: playbackFooter.querySelector('#master-loop-btn') as HTMLButtonElement,
        masterMuteBtn: playbackFooter.querySelector('#master-mute-btn') as HTMLButtonElement,
        masterVolume: playbackFooter.querySelector('#master-volume') as HTMLInputElement,
        exportBtn: topHeader.querySelector('#export-btn') as HTMLButtonElement,
        globalPreviewBtn: topHeader.querySelector('#global-preview-btn') as HTMLButtonElement,
        previewRecalculateBtn: topHeader.querySelector('#preview-recalculate-btn') as HTMLButtonElement,
        globalSeedInput: topHeader.querySelector('#global-seed-input') as HTMLInputElement,
        globalSeedLockBtn: topHeader.querySelector('#global-seed-lock-btn') as HTMLButtonElement,
        globalFreezeBtn: topHeader.querySelector('#global-freeze-btn') as HTMLButtonElement,
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

