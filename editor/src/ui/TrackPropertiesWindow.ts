import { getParameterWheelStep, registerParameterWheelControl, roundStepValue } from './ParameterWheelMenu';
import { renderIcon } from '../../../packages/ui/src/icons.js';

export class TrackPropertiesWindow {
    container: HTMLElement;
    onClose: () => void;
    private disposed: boolean = false;
    private onGlobalParamsChanged: (e: Event) => void;
    private onEngineSettingsUpdated: (e: Event) => void;

    constructor(container: HTMLElement, onClose: () => void) {
        this.container = container;
        this.onClose = onClose;

        this.onGlobalParamsChanged = () => {
            if (!this.disposed) {
                this.updateFieldsFromGlobal();
            }
        };
        this.onEngineSettingsUpdated = (ev: Event) => {
            if (!this.disposed) {
                this.applyEngineSettingsToUI((ev as CustomEvent).detail);
            }
        };

        window.addEventListener('global-parameters-changed', this.onGlobalParamsChanged);
        window.addEventListener('sin-engine-settings-updated', this.onEngineSettingsUpdated);
        this.render();
        window.dispatchEvent(new CustomEvent('sin-request-engine-settings'));
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        window.removeEventListener('global-parameters-changed', this.onGlobalParamsChanged);
        window.removeEventListener('sin-engine-settings-updated', this.onEngineSettingsUpdated);
    }

    private getBpm(): number {
        const getGlobal = (window as any).getGlobalParameter;
        const val = getGlobal ? getGlobal('bpm') : 120;
        return Number.isFinite(val) ? val : 120;
    }

    private getTotalBars(): number {
        const getGlobal = (window as any).getGlobalParameter;
        const val = getGlobal ? getGlobal('total_bars') : 4;
        return Number.isFinite(val) ? val : 4;
    }

    private getKey(): string {
        const getGlobal = (window as any).getGlobalParameter;
        const val = getGlobal ? getGlobal('key') : 'C';
        return val || 'C';
    }

    private setGlobal(params: { bpm?: number; total_bars?: number; key?: string }) {
        const setParams = (window as any).setGlobalParameters;
        if (setParams) {
            setParams(params);
        }
    }

    private computeDuration(): { seconds: number; formatted: string; beats: number; isFree: boolean } {
        const bpm = this.getBpm();
        const bars = this.getTotalBars();
        if (bars <= 0) {
            return { seconds: 0, formatted: 'Free', beats: 0, isFree: true };
        }
        const beats = bars * 4;
        const seconds = (beats * 60) / Math.max(20, bpm);
        const mins = Math.floor(seconds / 60);
        const remSecs = (seconds % 60).toFixed(1);
        const formatted = `${String(mins).padStart(2, '0')}:${remSecs.padStart(4, '0')}`;
        return { seconds, formatted, beats, isFree: false };
    }

    private formatDurationLabel(duration: { seconds: number; formatted: string; beats: number; isFree: boolean }): string {
        if (duration.isFree) {
            return 'Free (-1) · Plays longest finite source to end';
        }
        return `${duration.seconds.toFixed(2)}s (${duration.formatted}) · ${duration.beats} beats @ 4/4`;
    }

    private getGraphStats(): { nodesCount: number; sampleCount: number; seqCount: number; trackCount: number } {
        const graph = (window as any).editorGraph;
        const nodes = (graph?._nodes || []) as any[];
        let sampleCount = 0;
        let seqCount = 0;
        let trackCount = 0;

        for (const n of nodes) {
            if (n.type === 'Audio/Sample') sampleCount++;
            else if (n.type === 'Audio/Sequence') seqCount++;
            else if (n.type === 'Audio/Track') trackCount++;
        }

        return {
            nodesCount: nodes.length,
            sampleCount,
            seqCount,
            trackCount
        };
    }

    private render() {
        const bpm = this.getBpm();
        const totalBars = this.getTotalBars();
        const key = this.getKey();
        const duration = this.computeDuration();
        const stats = this.getGraphStats();

        const rootKeys = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

        this.container.innerHTML = `
            <div class="td-param-container td-track-param-container">
                <!-- Header -->
                <div class="td-param-header">
                    <div class="header-left">
                        <span class="node-badge" style="background: #4f46e5; color: #ffffff;">TRACK</span>
                        <span class="node-title">Track Parameters</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <button type="button" class="ui-btn ui-btn--icon close-btn" id="track-close-btn" title="Close Panel" aria-label="Close Panel">${renderIcon('close')}</button>
                    </div>
                </div>

                <!-- Body -->
                <div class="td-param-body td-track-param-body">
                    <!-- Timing & Tempo Section -->
                    <div class="td-section">
                        <div class="td-section-title">TEMPO & LENGTH</div>
                        <div class="td-track-fields-grid">
                            <!-- BPM -->
                            <div class="td-field-row">
                                <label class="td-field-label">Tempo (BPM)</label>
                                <div class="td-number-stepper">
                                    <button type="button" class="td-stepper-btn" id="bpm-dec-btn" title="Decrease BPM">-</button>
                                    <input type="number" id="track-bpm-input" class="td-track-input" min="20" max="300" step="1" value="${bpm}">
                                    <button type="button" class="td-stepper-btn" id="bpm-inc-btn" title="Increase BPM">+</button>
                                </div>
                            </div>

                            <!-- Total Bars -->
                            <div class="td-field-row">
                                <label class="td-field-label">Length (Bars)</label>
                                <div class="td-number-stepper">
                                    <button type="button" class="td-stepper-btn" id="bars-dec-btn" title="Decrease Bars">-</button>
                                    <input type="number" id="track-bars-input" class="td-track-input" min="-1" max="128" step="0.25" value="${totalBars}">
                                    <button type="button" class="td-stepper-btn" id="bars-inc-btn" title="Increase Bars">+</button>
                                </div>
                            </div>
                        </div>

                        <!-- Quick Bar Presets -->
                        <div class="td-quick-presets-row">
                            <span class="td-presets-label">Bar Presets:</span>
                            <div class="td-preset-chips">
                                <button type="button" class="td-preset-chip ${totalBars <= 0 ? 'active' : ''}" data-bars="-1" title="Unconstrained length: plays longest source to end">Free (-1)</button>
                                ${[1, 2, 4, 8, 16, 32].map(b => `
                                    <button type="button" class="td-preset-chip ${totalBars === b ? 'active' : ''}" data-bars="${b}">${b}</button>
                                `).join('')}
                            </div>
                        </div>

                        <!-- Computed Duration Badge -->
                        <div class="td-duration-badge" id="track-duration-display">
                            <span class="td-duration-icon">⏱</span>
                            <span class="td-duration-text">${this.formatDurationLabel(duration)}</span>
                        </div>
                    </div>

                    <!-- Musical Key Section -->
                    <div class="td-section">
                        <div class="td-section-title">MUSICAL KEY & SCALE</div>
                        <div class="td-field-row">
                            <label class="td-field-label">Current Key</label>
                            <input type="text" id="track-key-input" class="td-track-input td-key-input" value="${key}" maxlength="8" spellcheck="false" placeholder="e.g. C, Am, F#m">
                        </div>

                        <!-- Quick Root Key Chips -->
                        <div class="td-root-keys-grid">
                            ${rootKeys.map(k => `
                                <button type="button" class="td-key-chip ${key.startsWith(k) ? 'active' : ''}" data-root="${k}">${k}</button>
                            `).join('')}
                        </div>
                        <div class="td-mode-chips-row">
                            <button type="button" class="td-mode-chip ${!key.includes('m') ? 'active' : ''}" data-mode="maj">Major</button>
                            <button type="button" class="td-mode-chip ${key.includes('m') ? 'active' : ''}" data-mode="min">Minor</button>
                        </div>
                    </div>

                    <!-- Composition Overview Section -->
                    <div class="td-section">
                        <div class="td-section-title">GRAPH OVERVIEW</div>
                        <div class="td-stats-grid">
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-nodes">${stats.nodesCount}</span>
                                <span class="td-stat-label">Total Nodes</span>
                            </div>
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-samples">${stats.sampleCount}</span>
                                <span class="td-stat-label">Samples</span>
                            </div>
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-seqs">${stats.seqCount}</span>
                                <span class="td-stat-label">Sequences</span>
                            </div>
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-tracks">${stats.trackCount}</span>
                                <span class="td-stat-label">Tracks</span>
                            </div>
                        </div>
                    </div>

                    <!-- Long-Track Engine & Tile Cache Section -->
                    <div class="td-section">
                        <div class="td-section-title">LONG-TRACK ENGINE & CACHE</div>
                        <div class="td-field-row" style="align-items: center; justify-content: space-between;">
                            <label class="td-field-label" for="engine-wait-fx-toggle" title="Pause briefly on Play/Seek until the playhead RX tile is cooked instead of starting raw">Wait for FX (Preroll)</label>
                            <input type="checkbox" id="engine-wait-fx-toggle" />
                        </div>
                        <div class="td-track-fields-grid" style="margin-top: 6px;">
                            <div class="td-field-row">
                                <label class="td-field-label" for="engine-ram-budget-input">Tile RAM (MB)</label>
                                <input type="number" id="engine-ram-budget-input" class="td-track-input" min="32" max="4096" step="32" value="256">
                            </div>
                            <div class="td-field-row">
                                <label class="td-field-label" for="engine-disk-budget-input">Disk Cache (GB)</label>
                                <input type="number" id="engine-disk-budget-input" class="td-track-input" min="0.5" max="64" step="0.5" value="4">
                            </div>
                        </div>
                        <div class="td-duration-badge" id="engine-cache-stats-row" style="margin-top: 6px; justify-content: space-between;">
                            <span id="engine-cache-stats-text" class="td-duration-text">RAM: 0 / 256 MB · Disk: 0 MB / 4.0 GB</span>
                            <button type="button" class="td-preset-chip" id="engine-clear-cache-btn" title="Clear cached RAM & disk processor tiles">Clear</button>
                        </div>
                    </div>

                    <!-- Quick Actions Section -->
                    <div class="td-section td-actions-section">
                        <button type="button" class="td-track-action-btn primary" id="track-refresh-pools-btn">
                            ↻ Recalculate All Pools
                        </button>
                        <button type="button" class="td-track-action-btn secondary" id="track-reset-defaults-btn">
                            Reset to Defaults (120 BPM, 4 Bars, C)
                        </button>
                    </div>
                </div>
            </div>
        `;

        this.bindEvents();
    }

    private bindEvents() {
        this.container.querySelector('#track-close-btn')?.addEventListener('click', this.onClose);

        const bpmInput = this.container.querySelector('#track-bpm-input') as HTMLInputElement | null;
        if (bpmInput) {
            registerParameterWheelControl(bpmInput, {
                isInteger: false,
                getValue: () => this.getBpm(),
                setValue: (val) => {
                    const next = Math.max(20, Math.min(300, roundStepValue(val)));
                    this.setGlobal({ bpm: next });
                },
            });
            bpmInput.addEventListener('change', () => {
                const val = parseFloat(bpmInput.value);
                if (!isNaN(val)) this.setGlobal({ bpm: val });
            });
            bpmInput.addEventListener('wheel', (e) => {
                e.preventDefault();
                if (e.altKey || bpmInput.disabled) return;
                const dir = e.deltaY < 0 ? 1 : -1;
                const step = getParameterWheelStep(false);
                const next = Math.max(20, Math.min(300, roundStepValue(this.getBpm() + dir * step, step)));
                this.setGlobal({ bpm: next });
            });
        }

        this.container.querySelector('#bpm-dec-btn')?.addEventListener('click', () => {
            const next = Math.max(20, this.getBpm() - 1);
            this.setGlobal({ bpm: next });
        });
        this.container.querySelector('#bpm-inc-btn')?.addEventListener('click', () => {
            const next = Math.min(300, this.getBpm() + 1);
            this.setGlobal({ bpm: next });
        });

        const barsInput = this.container.querySelector('#track-bars-input') as HTMLInputElement | null;
        if (barsInput) {
            registerParameterWheelControl(barsInput, {
                isInteger: false,
                getValue: () => this.getTotalBars(),
                setValue: (val) => {
                    const next = val <= 0 ? -1 : Math.max(0.25, Math.min(128, roundStepValue(val)));
                    this.setGlobal({ total_bars: next });
                },
            });
            barsInput.addEventListener('change', () => {
                const val = parseFloat(barsInput.value);
                if (!isNaN(val)) this.setGlobal({ total_bars: val <= 0 ? -1 : val });
            });
            barsInput.addEventListener('wheel', (e) => {
                e.preventDefault();
                if (e.altKey || barsInput.disabled) return;
                const dir = e.deltaY < 0 ? 1 : -1;
                const step = getParameterWheelStep(false);
                const cur = this.getTotalBars();
                const rawNext = cur <= 0 ? (dir > 0 ? 1 : -1) : roundStepValue(cur + dir * step, step);
                const next = rawNext <= 0 ? -1 : Math.max(0.25, Math.min(128, rawNext));
                this.setGlobal({ total_bars: next });
            });
        }

        this.container.querySelector('#bars-dec-btn')?.addEventListener('click', () => {
            const cur = this.getTotalBars();
            const next = cur <= 0.25 ? -1 : Math.max(0.25, cur - 1);
            this.setGlobal({ total_bars: next });
        });
        this.container.querySelector('#bars-inc-btn')?.addEventListener('click', () => {
            const cur = this.getTotalBars();
            const next = cur <= 0 ? 1 : Math.min(128, cur + 1);
            this.setGlobal({ total_bars: next });
        });

        // Quick bar preset chips
        this.container.querySelectorAll<HTMLButtonElement>('.td-preset-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const b = parseFloat(btn.dataset.bars || '4');
                if (!isNaN(b)) this.setGlobal({ total_bars: b });
            });
        });

        // Key text input
        const keyInput = this.container.querySelector('#track-key-input') as HTMLInputElement | null;
        if (keyInput) {
            keyInput.addEventListener('change', () => {
                this.setGlobal({ key: keyInput.value.trim() || 'C' });
            });
        }

        // Root key chips
        this.container.querySelectorAll<HTMLButtonElement>('.td-key-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const root = btn.dataset.root || 'C';
                const current = this.getKey();
                const isMinor = current.includes('m') && !current.includes('maj');
                const newKey = isMinor ? `${root}m` : root;
                this.setGlobal({ key: newKey });
            });
        });

        // Mode chips (Major / Minor)
        this.container.querySelectorAll<HTMLButtonElement>('.td-mode-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                const current = this.getKey();
                const rootMatch = current.match(/^[A-G][#b]?/);
                const root = rootMatch ? rootMatch[0] : 'C';
                const newKey = mode === 'min' ? `${root}m` : root;
                this.setGlobal({ key: newKey });
            });
        });

        // Engine & tile cache controls
        const waitFxToggle = this.container.querySelector('#engine-wait-fx-toggle') as HTMLInputElement | null;
        if (waitFxToggle) {
            waitFxToggle.addEventListener('change', () => {
                window.dispatchEvent(new CustomEvent('sin-set-engine-settings', {
                    detail: { wait_for_fx: waitFxToggle.checked },
                }));
            });
        }
        const ramInput = this.container.querySelector('#engine-ram-budget-input') as HTMLInputElement | null;
        if (ramInput) {
            ramInput.addEventListener('change', () => {
                const mb = Math.max(32, Math.min(4096, Math.round(parseFloat(ramInput.value) || 256)));
                ramInput.value = String(mb);
                window.dispatchEvent(new CustomEvent('sin-set-engine-settings', {
                    detail: { tile_ram_mb: mb },
                }));
            });
        }
        const diskInput = this.container.querySelector('#engine-disk-budget-input') as HTMLInputElement | null;
        if (diskInput) {
            diskInput.addEventListener('change', () => {
                const gb = Math.max(0.5, Math.min(64, parseFloat(diskInput.value) || 4.0));
                diskInput.value = String(gb);
                window.dispatchEvent(new CustomEvent('sin-set-engine-settings', {
                    detail: { dsp_cache_max_gb: gb },
                }));
            });
        }
        this.container.querySelector('#engine-clear-cache-btn')?.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('sin-set-engine-settings', {
                detail: { clear_tile_cache: true },
            }));
        });

        // Quick actions
        this.container.querySelector('#track-refresh-pools-btn')?.addEventListener('click', () => {
            const btn = document.querySelector('#preview-recalculate-btn') as HTMLButtonElement | null;
            if (btn && !btn.disabled) {
                btn.click();
            } else {
                fetch('/api/preview/invalidate', { method: 'POST' }).catch(() => {});
            }
        });

        this.container.querySelector('#track-reset-defaults-btn')?.addEventListener('click', () => {
            this.setGlobal({ bpm: 120, total_bars: 4, key: 'C' });
        });
    }

    private updateFieldsFromGlobal() {
        const bpm = this.getBpm();
        const totalBars = this.getTotalBars();
        const key = this.getKey();
        const duration = this.computeDuration();
        const stats = this.getGraphStats();

        const bpmInput = this.container.querySelector('#track-bpm-input') as HTMLInputElement | null;
        if (bpmInput && document.activeElement !== bpmInput) bpmInput.value = String(bpm);

        const barsInput = this.container.querySelector('#track-bars-input') as HTMLInputElement | null;
        if (barsInput && document.activeElement !== barsInput) barsInput.value = String(totalBars);

        const keyInput = this.container.querySelector('#track-key-input') as HTMLInputElement | null;
        if (keyInput && document.activeElement !== keyInput) keyInput.value = key;

        const durationDisplay = this.container.querySelector('#track-duration-display .td-duration-text');
        if (durationDisplay) {
            durationDisplay.textContent = this.formatDurationLabel(duration);
        }

        this.container.querySelectorAll<HTMLButtonElement>('.td-preset-chip').forEach(chip => {
            if (!chip.dataset.bars) return;
            const b = parseFloat(chip.dataset.bars);
            chip.classList.toggle('active', b <= 0 ? totalBars <= 0 : totalBars === b);
        });

        this.container.querySelectorAll<HTMLButtonElement>('.td-key-chip').forEach(chip => {
            const root = chip.dataset.root || 'C';
            chip.classList.toggle('active', key.startsWith(root));
        });

        this.container.querySelectorAll<HTMLButtonElement>('.td-mode-chip').forEach(chip => {
            const mode = chip.dataset.mode;
            const isMinor = key.includes('m') && !key.includes('maj');
            chip.classList.toggle('active', mode === 'min' ? isMinor : !isMinor);
        });

        const statNodes = this.container.querySelector('#stat-nodes');
        if (statNodes) statNodes.textContent = String(stats.nodesCount);
        const statSamples = this.container.querySelector('#stat-samples');
        if (statSamples) statSamples.textContent = String(stats.sampleCount);
        const statSeqs = this.container.querySelector('#stat-seqs');
        if (statSeqs) statSeqs.textContent = String(stats.seqCount);
        const statTracks = this.container.querySelector('#stat-tracks');
        if (statTracks) statTracks.textContent = String(stats.trackCount);
    }

    private applyEngineSettingsToUI(settings: any) {
        if (!settings || typeof settings !== 'object') return;
        const waitFxToggle = this.container.querySelector('#engine-wait-fx-toggle') as HTMLInputElement | null;
        if (waitFxToggle && typeof settings.wait_for_fx === 'boolean') {
            waitFxToggle.checked = settings.wait_for_fx;
        }
        const cs = settings.cache_stats;
        if (cs && typeof cs === 'object') {
            const ramInput = this.container.querySelector('#engine-ram-budget-input') as HTMLInputElement | null;
            if (ramInput && document.activeElement !== ramInput && cs.ram_budget_mb != null) {
                ramInput.value = String(Math.round(Number(cs.ram_budget_mb)));
            }
            const diskInput = this.container.querySelector('#engine-disk-budget-input') as HTMLInputElement | null;
            if (diskInput && document.activeElement !== diskInput && cs.disk_budget_gb != null) {
                diskInput.value = String(Number(cs.disk_budget_gb));
            }
            const statsText = this.container.querySelector('#engine-cache-stats-text');
            if (statsText) {
                statsText.textContent = `RAM: ${Number(cs.ram_used_mb || 0).toFixed(1)} / ${Math.round(Number(cs.ram_budget_mb || 256))} MB · Disk: ${Number(cs.disk_used_mb || 0).toFixed(1)} MB / ${Number(cs.disk_budget_gb || 4).toFixed(1)} GB`;
            }
        }
    }
}
