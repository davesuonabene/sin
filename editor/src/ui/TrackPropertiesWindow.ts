import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type BaseNode } from '../nodes/BaseNode.ts';
import { roundStepValue } from './ParameterWheelMenu.ts';
import { WidgetFactory } from './WidgetFactory.ts';
import { renderIcon } from '../../../packages/ui/src/icons.js';

const ROOT_KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const BAR_PRESETS = [-1, 1, 2, 4, 8, 16, 32] as const;

type TrackTabId = 'GLOBAL' | 'ENGINE';

export function parseTrackKeyParts(key: string): { root: string; isMinor: boolean } {
    const trimmed = String(key || 'C').trim();
    const match = trimmed.match(/^([A-G][#b]?)(.*)$/i);
    if (!match) return { root: 'C', isMinor: false };
    const rawRoot = match[1][0].toUpperCase() + (match[1][1] || '');
    const suffix = (match[2] || '').toLowerCase();
    const enharmonicMap: Record<string, string> = {
        Db: 'C#',
        'D#': 'Eb',
        Gb: 'F#',
        'G#': 'Ab',
        'A#': 'Bb',
    };
    const root = enharmonicMap[rawRoot] || rawRoot;
    const isMinor = suffix.includes('m') && !suffix.includes('maj');
    return { root, isMinor };
}

export function normalizeTrackTotalBars(rawValue: number, previousValue: number): number {
    if (!Number.isFinite(rawValue)) return previousValue;
    if (previousValue <= 0 && rawValue > previousValue && rawValue <= 0) {
        return 1;
    }
    if (rawValue <= 0) return -1;
    return Math.max(0.25, Math.min(128, roundStepValue(rawValue)));
}

interface TrackFieldAdapter {
    id: number;
    properties: Record<string, any>;
    updateProperty: (key: string, value: any) => void;
    preparePropertyEdit: () => boolean;
    getFields: () => FieldSchema[];
    isFieldDynamicActive: () => boolean;
    hasFieldOperator: () => boolean;
    getFieldOperator: () => undefined;
    clearFieldOperator: () => void;
    hasMixedSlotValues: () => boolean;
    setStaticFieldValue: () => void;
}

export class TrackPropertiesWindow {
    container: HTMLElement;
    onClose: () => void;
    activeTab: TrackTabId = 'GLOBAL';
    private disposed: boolean = false;
    private onGlobalParamsChanged: (e: Event) => void;
    private onEngineSettingsUpdated: (e: Event) => void;
    private onGraphChanged: () => void;
    private fieldSyncs: Map<string, () => void> = new Map();
    private trackAdapter: TrackFieldAdapter;
    private fields: FieldSchema[];

    constructor(container: HTMLElement, onClose: () => void) {
        this.container = container;
        this.onClose = onClose;

        this.fields = this.createFieldSchemas();
        this.trackAdapter = this.createFieldAdapter();

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
        this.onGraphChanged = () => {
            if (!this.disposed) {
                this.updateGraphStats();
            }
        };

        window.addEventListener('global-parameters-changed', this.onGlobalParamsChanged);
        window.addEventListener('sin-engine-settings-updated', this.onEngineSettingsUpdated);
        window.addEventListener('graph-connections-changed', this.onGraphChanged);
        this.render();
        window.dispatchEvent(new CustomEvent('sin-request-engine-settings'));
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.fieldSyncs.clear();
        window.removeEventListener('global-parameters-changed', this.onGlobalParamsChanged);
        window.removeEventListener('sin-engine-settings-updated', this.onEngineSettingsUpdated);
        window.removeEventListener('graph-connections-changed', this.onGraphChanged);
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

    private parseKeyParts(key: string): { root: string; isMinor: boolean } {
        return parseTrackKeyParts(key);
    }

    private setGlobal(params: { bpm?: number; total_bars?: number; key?: string }) {
        const setParams = (window as any).setGlobalParameters;
        if (setParams) {
            setParams(params);
        }
    }

    private dispatchEngineSettings(detail: Record<string, any>) {
        window.dispatchEvent(new CustomEvent('sin-set-engine-settings', { detail }));
    }

    private createFieldAdapter(): TrackFieldAdapter {
        const parsedKey = this.parseKeyParts(this.getKey());
        return {
            id: -1,
            properties: {
                bpm: this.getBpm(),
                total_bars: this.getTotalBars(),
                key: this.getKey(),
                key_mode: parsedKey.isMinor ? 'min' : 'maj',
                wait_for_fx: false,
                tile_ram_mb: 256,
                dsp_cache_max_gb: 4,
            },
            updateProperty: (key: string, value: any) => {
                this.trackAdapter.properties[key] = value;
            },
            preparePropertyEdit: () => true,
            getFields: () => this.fields,
            isFieldDynamicActive: () => false,
            hasFieldOperator: () => false,
            getFieldOperator: () => undefined,
            clearFieldOperator: () => { },
            hasMixedSlotValues: () => false,
            setStaticFieldValue: () => { },
        };
    }

    private createFieldSchemas(): FieldSchema[] {
        return [
            {
                key: 'bpm',
                label: 'Tempo',
                type: 'float',
                default: 120,
                min: 20,
                max: 300,
                step: 1,
                unit: 'BPM',
                dynamic: false,
                commitOnChange: true,
                description: 'Global tempo in beats per minute (20–300)',
                getValue: () => this.getBpm(),
                setValue: (_node, val) => {
                    const next = Math.max(20, Math.min(300, roundStepValue(Number(val))));
                    this.trackAdapter.properties.bpm = next;
                    this.setGlobal({ bpm: next });
                    return next;
                },
            },
            {
                key: 'total_bars',
                label: 'Length',
                type: 'float',
                default: 4,
                min: -1,
                max: 128,
                step: 0.25,
                unit: 'bars',
                dynamic: false,
                commitOnChange: true,
                description: 'Global length in bars (-1 for unconstrained free length)',
                getValue: () => this.getTotalBars(),
                setValue: (_node, val) => {
                    const next = normalizeTrackTotalBars(Number(val), this.getTotalBars());
                    this.trackAdapter.properties.total_bars = next;
                    this.setGlobal({ total_bars: next });
                    return next;
                },
            },
            {
                key: 'key',
                label: 'Key',
                type: 'string',
                default: 'C',
                placeholder: 'e.g. C, Am, F#m',
                dynamic: false,
                description: 'Global musical key and scale',
                getValue: () => this.getKey(),
                setValue: (_node, val) => {
                    const next = String(val ?? '').trim() || 'C';
                    this.trackAdapter.properties.key = next;
                    this.setGlobal({ key: next });
                    return next;
                },
            },
            {
                key: 'key_mode',
                label: 'Scale',
                type: 'radio',
                default: 'maj',
                options: [
                    { value: 'maj', label: 'Major' },
                    { value: 'min', label: 'Minor' },
                ],
                dynamic: false,
                description: 'Musical scale polarity (Major or Minor)',
                getValue: () => (this.parseKeyParts(this.getKey()).isMinor ? 'min' : 'maj'),
                setValue: (_node, val) => {
                    const mode = String(val) === 'min' ? 'min' : 'maj';
                    const { root } = this.parseKeyParts(this.getKey());
                    const nextKey = mode === 'min' ? `${root}m` : root;
                    this.trackAdapter.properties.key_mode = mode;
                    this.trackAdapter.properties.key = nextKey;
                    this.setGlobal({ key: nextKey });
                    return mode;
                },
            },
            {
                key: 'wait_for_fx',
                label: 'Wait for FX',
                type: 'boolean',
                default: false,
                dynamic: false,
                description: 'Pause briefly on Play/Seek until the playhead RX tile is cooked instead of starting raw',
                setValue: (_node, val) => {
                    const checked = Boolean(val);
                    this.trackAdapter.properties.wait_for_fx = checked;
                    this.dispatchEngineSettings({ wait_for_fx: checked });
                    return checked;
                },
            },
            {
                key: 'tile_ram_mb',
                label: 'Tile RAM',
                type: 'int',
                default: 256,
                min: 32,
                max: 4096,
                step: 32,
                unit: 'MB',
                dynamic: false,
                commitOnChange: true,
                description: 'RAM budget for cached processor tiles',
                setValue: (_node, val) => {
                    const mb = Math.max(32, Math.min(4096, Math.round(Number(val) || 256)));
                    this.trackAdapter.properties.tile_ram_mb = mb;
                    this.dispatchEngineSettings({ tile_ram_mb: mb });
                    return mb;
                },
            },
            {
                key: 'dsp_cache_max_gb',
                label: 'Disk Cache',
                type: 'float',
                default: 4,
                min: 0.5,
                max: 64,
                step: 0.5,
                unit: 'GB',
                dynamic: false,
                commitOnChange: true,
                description: 'Disk cache budget for cooked DSP tiles',
                setValue: (_node, val) => {
                    const gb = Math.max(0.5, Math.min(64, roundStepValue(Number(val) || 4)));
                    this.trackAdapter.properties.dsp_cache_max_gb = gb;
                    this.dispatchEngineSettings({ dsp_cache_max_gb: gb });
                    return gb;
                },
            },
        ];
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
            return 'Free (-1) · Plays longest finite source';
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
            trackCount,
        };
    }

    private createSchemaRow(fieldKey: string, inputId?: string): HTMLDivElement {
        const field = this.fields.find(f => f.key === fieldKey);
        if (!field) {
            throw new Error(`Unknown track field schema: ${fieldKey}`);
        }
        const row = WidgetFactory.createRow(
            field,
            this.trackAdapter as unknown as BaseNode,
            () => {
                this.updateDerivedDisplays();
            }
        );
        const controlWidget = row.querySelector<HTMLElement>('.td-param-control > *');
        if (inputId && controlWidget) {
            if (controlWidget instanceof HTMLInputElement || controlWidget instanceof HTMLSelectElement) {
                controlWidget.id = inputId;
            } else {
                const nestedInput = controlWidget.querySelector<HTMLElement>('input, select');
                if (nestedInput) nestedInput.id = inputId;
            }
        }
        const syncDisplay = (controlWidget as any)?.__syncDisplay;
        if (typeof syncDisplay === 'function') {
            this.fieldSyncs.set(fieldKey, syncDisplay);
        }
        return row;
    }

    private createStaticRow(labelText: string, controlContent: HTMLElement, options?: { topAlign?: boolean; title?: string }): HTMLDivElement {
        const row = document.createElement('div');
        row.className = options?.topAlign ? 'td-param-row td-track-row-top' : 'td-param-row';
        if (options?.title) row.title = options.title;

        const labelEl = document.createElement('div');
        labelEl.className = 'td-param-label';
        labelEl.textContent = labelText;

        const controlEl = document.createElement('div');
        controlEl.className = 'td-param-control';
        controlEl.appendChild(controlContent);

        row.append(labelEl, controlEl);
        return row;
    }

    private selectTab(tabId: TrackTabId) {
        this.activeTab = tabId;
        this.container.querySelectorAll<HTMLElement>('.td-param-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });
        this.container.querySelectorAll<HTMLElement>('.td-track-tab-pane').forEach(pane => {
            pane.hidden = pane.dataset.tab !== tabId;
        });
    }

    private render() {
        this.fieldSyncs.clear();

        const shell = document.createElement('div');
        shell.className = 'td-param-container td-track-param-container';

        // Header matching PropertiesWindow exactly
        const header = document.createElement('div');
        header.className = 'td-param-header';
        header.innerHTML = `
            <div class="header-left">
                <span class="node-badge">GLOBAL</span>
                <span class="node-title td-track-title">Track Parameters</span>
            </div>
            <div class="td-param-header-actions">
                <button type="button" class="ui-btn ui-btn--icon close-btn" id="track-close-btn" title="Close Panel" aria-label="Close Panel">${renderIcon('close')}</button>
            </div>
        `;
        shell.appendChild(header);

        // Tabs bar matching PropertiesWindow exactly
        const tabsBar = document.createElement('div');
        tabsBar.className = 'td-param-tabs';
        const tabs: TrackTabId[] = ['GLOBAL', 'ENGINE'];
        for (const tab of tabs) {
            const tabEl = document.createElement('div');
            tabEl.className = `td-param-tab ${tab === this.activeTab ? 'active' : ''}`;
            tabEl.dataset.tab = tab;
            tabEl.textContent = tab;
            tabEl.addEventListener('click', () => this.selectTab(tab));
            tabsBar.appendChild(tabEl);
        }
        shell.appendChild(tabsBar);

        // Standard inspector body
        const body = document.createElement('div');
        body.className = 'td-param-body td-track-param-body';

        // === GLOBAL TAB ===
        const globalPane = document.createElement('div');
        globalPane.className = 'td-track-tab-pane';
        globalPane.dataset.tab = 'GLOBAL';
        globalPane.hidden = this.activeTab !== 'GLOBAL';

        // Timing group
        const timingGroup = document.createElement('div');
        timingGroup.className = 'td-param-group';
        timingGroup.appendChild(this.createSchemaRow('bpm', 'track-bpm-input'));
        timingGroup.appendChild(this.createSchemaRow('total_bars', 'track-bars-input'));

        // Bar presets row (monochrome ui-segmented)
        const presetsBar = document.createElement('div');
        presetsBar.className = 'ui-segmented td-track-presets';
        presetsBar.setAttribute('role', 'group');
        presetsBar.setAttribute('aria-label', 'Length bar presets');
        for (const bars of BAR_PRESETS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'td-track-preset-btn';
            btn.dataset.bars = String(bars);
            btn.textContent = bars <= 0 ? 'Free' : String(bars);
            btn.title = bars <= 0
                ? 'Unconstrained length: plays longest source to end'
                : `Set global length to ${bars} bar${bars === 1 ? '' : 's'}`;
            btn.addEventListener('click', () => {
                this.setGlobal({ total_bars: bars });
            });
            presetsBar.appendChild(btn);
        }
        timingGroup.appendChild(this.createStaticRow('Presets', presetsBar));

        // Duration readout row
        const durationSpan = document.createElement('span');
        durationSpan.id = 'track-duration-display';
        durationSpan.className = 'td-track-meta-value';
        timingGroup.appendChild(this.createStaticRow('Duration', durationSpan));
        globalPane.appendChild(timingGroup);

        // Key & Scale group
        const keyGroup = document.createElement('div');
        keyGroup.className = 'td-param-group td-track-group-separated';
        const keyRow = this.createSchemaRow('key', 'track-key-input');
        const keyInput = keyRow.querySelector<HTMLInputElement>('#track-key-input');
        if (keyInput) {
            keyInput.maxLength = 8;
            keyInput.spellcheck = false;
        }
        keyGroup.appendChild(keyRow);

        // Root key 6x2 monochrome grid
        const rootGrid = document.createElement('div');
        rootGrid.className = 'td-track-key-grid';
        rootGrid.setAttribute('role', 'group');
        rootGrid.setAttribute('aria-label', 'Musical root note');
        for (const root of ROOT_KEYS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'td-track-key-btn';
            btn.dataset.root = root;
            btn.textContent = root;
            btn.addEventListener('click', () => {
                const { isMinor } = this.parseKeyParts(this.getKey());
                const nextKey = isMinor ? `${root}m` : root;
                this.setGlobal({ key: nextKey });
            });
            rootGrid.appendChild(btn);
        }
        keyGroup.appendChild(this.createStaticRow('Root', rootGrid, { topAlign: true }));
        keyGroup.appendChild(this.createSchemaRow('key_mode'));
        globalPane.appendChild(keyGroup);

        // Actions group
        const actionsGroup = document.createElement('div');
        actionsGroup.className = 'td-param-group td-track-group-separated';
        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'td-track-actions';

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.id = 'track-refresh-pools-btn';
        refreshBtn.className = 'td-param-action-btn td-track-action-inline';
        refreshBtn.title = 'Recalculate all pools, samples, and random modifiers';
        refreshBtn.innerHTML = `${renderIcon('refresh', 'td-track-btn-icon')}<span>Recalculate Pools</span>`;
        refreshBtn.addEventListener('click', () => {
            const btn = document.querySelector('#preview-recalculate-btn') as HTMLButtonElement | null;
            if (btn && !btn.disabled) {
                btn.click();
            } else {
                fetch('/api/preview/invalidate', { method: 'POST' }).catch(() => { });
            }
        });

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.id = 'track-reset-defaults-btn';
        resetBtn.className = 'td-param-action-btn td-track-action-inline';
        resetBtn.textContent = 'Reset Defaults';
        resetBtn.title = 'Reset to Defaults (120 BPM, 4 Bars, C)';
        resetBtn.addEventListener('click', () => {
            this.setGlobal({ bpm: 120, total_bars: 4, key: 'C' });
        });

        actionsWrap.append(refreshBtn, resetBtn);
        actionsGroup.appendChild(this.createStaticRow('Actions', actionsWrap));
        globalPane.appendChild(actionsGroup);

        // Graph Overview info table (exact same .td-info-table style as node COMMON tabs)
        const infoGroup = document.createElement('div');
        infoGroup.className = 'td-param-group td-track-group-separated';
        const infoTable = document.createElement('table');
        infoTable.className = 'td-info-table';
        infoTable.innerHTML = `
            <tr><td>Nodes</td><td id="stat-nodes">0</td></tr>
            <tr><td>Samples</td><td id="stat-samples">0</td></tr>
            <tr><td>Sequences</td><td id="stat-seqs">0</td></tr>
            <tr><td>Tracks</td><td id="stat-tracks">0</td></tr>
        `;
        infoGroup.appendChild(infoTable);
        globalPane.appendChild(infoGroup);

        // === ENGINE TAB ===
        const enginePane = document.createElement('div');
        enginePane.className = 'td-track-tab-pane';
        enginePane.dataset.tab = 'ENGINE';
        enginePane.hidden = this.activeTab !== 'ENGINE';

        const engineGroup = document.createElement('div');
        engineGroup.className = 'td-param-group';
        engineGroup.appendChild(this.createSchemaRow('wait_for_fx', 'engine-wait-fx-toggle'));
        engineGroup.appendChild(this.createSchemaRow('tile_ram_mb', 'engine-ram-budget-input'));
        engineGroup.appendChild(this.createSchemaRow('dsp_cache_max_gb', 'engine-disk-budget-input'));

        // Cache stats + Clear button row (matching ExportSection's preview+action layout)
        const cacheControl = document.createElement('div');
        cacheControl.className = 'td-track-cache-control';
        cacheControl.id = 'engine-cache-stats-row';

        const cacheStatsSpan = document.createElement('span');
        cacheStatsSpan.id = 'engine-cache-stats-text';
        cacheStatsSpan.className = 'td-track-meta-value';
        cacheStatsSpan.textContent = 'RAM: 0 / 256 MB · Disk: 0 MB / 4.0 GB';
        cacheStatsSpan.title = cacheStatsSpan.textContent;

        const clearCacheBtn = document.createElement('button');
        clearCacheBtn.type = 'button';
        clearCacheBtn.id = 'engine-clear-cache-btn';
        clearCacheBtn.className = 'td-param-action-btn';
        clearCacheBtn.textContent = 'Clear';
        clearCacheBtn.title = 'Clear cached RAM & disk processor tiles';
        clearCacheBtn.addEventListener('click', () => {
            this.dispatchEngineSettings({ clear_tile_cache: true });
        });

        cacheControl.append(cacheStatsSpan, clearCacheBtn);
        engineGroup.appendChild(this.createStaticRow('Cache', cacheControl));
        enginePane.appendChild(engineGroup);

        body.append(globalPane, enginePane);
        shell.appendChild(body);
        this.container.replaceChildren(shell);

        header.querySelector('#track-close-btn')?.addEventListener('click', this.onClose);

        this.updateFieldsFromGlobal();
    }

    private updateDerivedDisplays() {
        const totalBars = this.getTotalBars();
        const key = this.getKey();
        const { root: activeRoot } = this.parseKeyParts(key);
        const duration = this.computeDuration();
        const durationLabel = this.formatDurationLabel(duration);

        const durationDisplay = this.container.querySelector<HTMLElement>('#track-duration-display');
        if (durationDisplay) {
            durationDisplay.textContent = durationLabel;
            durationDisplay.title = durationLabel;
        }

        this.container.querySelectorAll<HTMLButtonElement>('.td-track-preset-btn').forEach(btn => {
            if (!btn.dataset.bars) return;
            const b = parseFloat(btn.dataset.bars);
            const isActive = b <= 0 ? totalBars <= 0 : totalBars === b;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });

        this.container.querySelectorAll<HTMLButtonElement>('.td-track-key-btn').forEach(btn => {
            const isActive = btn.dataset.root === activeRoot;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });

        this.updateGraphStats();
    }

    private updateGraphStats() {
        const stats = this.getGraphStats();
        const statNodes = this.container.querySelector('#stat-nodes');
        if (statNodes) statNodes.textContent = String(stats.nodesCount);
        const statSamples = this.container.querySelector('#stat-samples');
        if (statSamples) statSamples.textContent = String(stats.sampleCount);
        const statSeqs = this.container.querySelector('#stat-seqs');
        if (statSeqs) statSeqs.textContent = String(stats.seqCount);
        const statTracks = this.container.querySelector('#stat-tracks');
        if (statTracks) statTracks.textContent = String(stats.trackCount);
    }

    private updateFieldsFromGlobal() {
        const bpm = this.getBpm();
        const totalBars = this.getTotalBars();
        const key = this.getKey();
        const { isMinor } = this.parseKeyParts(key);

        this.trackAdapter.properties.bpm = bpm;
        this.trackAdapter.properties.total_bars = totalBars;
        this.trackAdapter.properties.key = key;
        this.trackAdapter.properties.key_mode = isMinor ? 'min' : 'maj';

        this.fieldSyncs.get('bpm')?.();
        this.fieldSyncs.get('total_bars')?.();
        this.fieldSyncs.get('key')?.();
        this.fieldSyncs.get('key_mode')?.();

        this.updateDerivedDisplays();
    }

    private applyEngineSettingsToUI(settings: any) {
        if (!settings || typeof settings !== 'object') return;
        if (typeof settings.wait_for_fx === 'boolean') {
            this.trackAdapter.properties.wait_for_fx = settings.wait_for_fx;
            this.fieldSyncs.get('wait_for_fx')?.();
        }
        const cs = settings.cache_stats;
        if (cs && typeof cs === 'object') {
            if (cs.ram_budget_mb != null) {
                this.trackAdapter.properties.tile_ram_mb = Math.round(Number(cs.ram_budget_mb));
                this.fieldSyncs.get('tile_ram_mb')?.();
            }
            if (cs.disk_budget_gb != null) {
                this.trackAdapter.properties.dsp_cache_max_gb = Number(cs.disk_budget_gb);
                this.fieldSyncs.get('dsp_cache_max_gb')?.();
            }
            const statsText = this.container.querySelector<HTMLElement>('#engine-cache-stats-text');
            if (statsText) {
                const label = `RAM: ${Number(cs.ram_used_mb || 0).toFixed(1)} / ${Math.round(Number(cs.ram_budget_mb || 256))} MB · Disk: ${Number(cs.disk_used_mb || 0).toFixed(1)} MB / ${Number(cs.disk_budget_gb || 4).toFixed(1)} GB`;
                statsText.textContent = label;
                statsText.title = label;
            }
        }
    }
}
