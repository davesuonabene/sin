export const HEADER_PLAY_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';
export const HEADER_PAUSE_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>';
export const HEADER_REFRESH_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
export const HEADER_FREEZE_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><path d="m20 16-4-4 4-4"></path><path d="m4 8 4 4-4 4"></path><path d="m16 4-4 4-4-4"></path><path d="m8 20 4-4 4 4"></path></svg>';
export const HEADER_LOCK_OPEN_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>';
export const HEADER_LOCK_CLOSED_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
export const HEADER_SIDEBAR_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" ry="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line></svg>';
export const HEADER_INSPECTOR_ICON_SVG = '<svg class="toolbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';

export const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
export const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
export const volumeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5-.5v7a4 4 0 0 0 0-7z"/></svg>';
export const mutedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5 1 2 2 2-2 1.5 1.5-2 2 2 2-1.5 1.5-2-2-2 2-1.5-1.5 2-2-2-2z"/></svg>';

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
                <button id="floating-toggle-library" class="header-btn icon-header-btn squared-btn" type="button" title="Toggle Library Panel (Shortcut: L)" aria-label="Toggle Library Panel" aria-expanded="false">
                    ${HEADER_SIDEBAR_ICON_SVG}
                </button>
            </div>
            <div class="top-header-center"></div>
            <div class="top-header-right">
                <button id="global-preview-btn" class="header-btn global-preview-btn icon-header-btn squared-btn" type="button" title="Play transport (Space)" aria-label="Play transport (Space)" disabled>
                    ${HEADER_PLAY_ICON_SVG}
                </button>
                <button id="preview-recalculate-btn" class="header-btn preview-recalculate-btn icon-header-btn squared-btn" type="button" title="Refresh pools, samples, and modifiers" aria-label="Refresh pools, samples, and modifiers" disabled>
                    ${HEADER_REFRESH_ICON_SVG}
                </button>
                <div class="global-seed-control" title="Global Seed (0 = user pool order)">
                    <input id="global-seed-input" class="global-seed-input" type="number" min="0" step="1" value="0" aria-label="Global Seed" />
                    <button id="global-seed-lock-btn" class="header-btn global-seed-lock-btn icon-header-btn squared-btn" type="button" title="Global Seed Lock: OFF (Refresh updates Global Seed, pools, random modifiers, and field operators)" aria-label="Lock Global Seed" aria-pressed="false">
                        ${HEADER_LOCK_OPEN_ICON_SVG}
                    </button>
                </div>
                <button id="global-freeze-btn" class="header-btn global-freeze-btn icon-header-btn squared-btn" type="button" title="Global Freeze: OFF (Flagged nodes refresh on recalculate)" aria-label="Toggle Global Freeze" aria-pressed="false">
                    ${HEADER_FREEZE_ICON_SVG}
                </button>
                <div class="header-btn-separator" aria-hidden="true"></div>
                <button id="header-toggle-properties" class="header-btn secondary-tool-btn icon-header-btn squared-btn" type="button" title="Toggle Properties / Inspector (Shortcut: P)" aria-label="Toggle Properties / Inspector" aria-expanded="false">
                    ${HEADER_INSPECTOR_ICON_SVG}
                </button>
            </div>
        </div>
    `;

    const playbackFooter = document.createElement('footer');
    playbackFooter.className = 'playback-footer';
    playbackFooter.setAttribute('aria-label', 'Playback transport');
    playbackFooter.innerHTML = `
        <div class="playback-toolbar">
            <div class="render-select-wrapper">
                <select id="temp-files-select" class="playback-track-select sin-select" aria-label="Playback track">
                    <option value="" disabled selected>No renders available</option>
                </select>
            </div>
            <div class="master-player-wrapper">
                <audio id="master-player" preload="metadata"></audio>
                <button id="master-play-btn" class="master-control-btn" type="button" aria-label="Play" title="Play" disabled>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>
                </button>
                <button id="master-loop-btn" class="master-control-btn master-loop-btn" type="button" aria-label="Loop off" title="Loop off" aria-pressed="false" disabled>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h9.5a3.5 3.5 0 0 1 0 7H15m2-3 3 3-3 3M17 17H7.5a3.5 3.5 0 0 1 0-7H9m-2 3-3-3 3-3"/></svg>
                </button>
            </div>
            <div id="master-waveform" class="master-waveform" title="Click or drag to seek"></div>
            <div class="master-volume-control">
                <button id="master-mute-btn" class="master-control-btn master-volume-btn" type="button" aria-label="Mute" title="Mute">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5-.5v7a4 4 0 0 0 0-7z"/></svg>
                </button>
                <input id="master-volume" class="master-volume-slider" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume">
            </div>
        </div>
    `;

    const dockviewContainer = document.createElement('div');
    dockviewContainer.className = 'dockview-container';

    appElement.appendChild(topHeader);
    appElement.appendChild(dockviewContainer);
    appElement.appendChild(playbackFooter);

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

