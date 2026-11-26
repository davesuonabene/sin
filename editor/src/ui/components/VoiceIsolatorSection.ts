import { type BaseNode } from '../../nodes/BaseNode.ts';
import { type VoiceIsolatorNode } from '../../nodes/VoiceIsolatorNode.ts';

interface ModelStatusEntry {
    id: string;
    name: string;
    backend_tier: string;
    size_mb: number;
    license: string;
    installed: boolean;
    source?: string | null;
    location?: string;
    target_dir?: string;
    download?: {
        status: string;
        progress: number;
        current_file?: string;
        error?: string | null;
    };
}

const BACKEND_MODEL_MAP: Record<string, string | null> = {
    dsp_lite: null,
    fast_onnx: 'deepfilternet3_onnx',
    speech_hq: 'mossformer2_se_48k',
    studio_hq: 'melband_roformer_voice_hq',
};

function fmtDb(v: number): string {
    if (v <= -59.9) return '-∞ dB';
    if (Math.abs(v) < 0.05) return '0.0 dB';
    return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
}

export class VoiceIsolatorSection {
    static async render(
        container: HTMLElement,
        baseNode: BaseNode,
        windowContext: any
    ): Promise<void> {
        const node = baseNode as VoiceIsolatorNode;
        const root = document.createElement('div');
        root.className = 'sin-proc-panel sin-voice-panel';

        // 1. Live Status & Cook Bar
        const statusBar = document.createElement('div');
        statusBar.className = 'sin-proc-status-bar';
        const statusBadge = document.createElement('span');
        statusBadge.className = 'sin-proc-badge';
        const statusText = document.createElement('span');
        statusText.className = 'sin-proc-status-text';
        const cookBtn = document.createElement('button');
        cookBtn.type = 'button';
        cookBtn.className = 'sin-proc-btn';
        cookBtn.textContent = 'Process';
        cookBtn.addEventListener('click', () => node.requestManualCook());

        const cookFullBtn = document.createElement('button');
        cookFullBtn.type = 'button';
        cookFullBtn.className = 'sin-proc-btn sin-proc-btn-ghost';
        cookFullBtn.textContent = 'Cook Full';
        cookFullBtn.title = 'Propagate ML processing across the entire track beyond the sliding precook window';
        cookFullBtn.addEventListener('click', () => node.requestCookFullTrack(true));

        statusBar.append(statusBadge, statusText, cookFullBtn, cookBtn);
        root.appendChild(statusBar);

        // 2. Explicit Lazy Model Download Card (shown whenever selected backend model isn't installed or is downloading)
        const modelCard = document.createElement('div');
        modelCard.className = 'sin-model-card';
        modelCard.style.display = 'none';
        root.appendChild(modelCard);

        // 3. Supertone Clear-inspired 3-Column Vertical Fader Mixer
        const mixer = document.createElement('div');
        mixer.className = 'sin-voice-mixer';

        const columns = [
            { id: 'ambience', label: 'AMBIENCE', dbKey: 'ambience_db', muteKey: 'mute_ambience', accent: '#f59e0b' },
            { id: 'voice', label: 'VOICE', dbKey: 'voice_db', muteKey: 'mute_voice', accent: '#22d3ee' },
            { id: 'reverb', label: 'REVERB', dbKey: 'reverb_db', muteKey: 'mute_reverb', accent: '#a78bfa' },
        ] as const;

        const colRefs: Record<string, {
            slider: HTMLInputElement;
            readout: HTMLSpanElement;
            soloBtn: HTMLButtonElement;
            muteBtn: HTMLButtonElement;
            meterFill: HTMLDivElement;
            colEl: HTMLDivElement;
        }> = {};

        for (const col of columns) {
            const colEl = document.createElement('div');
            colEl.className = 'sin-voice-col';
            colEl.style.setProperty('--stem-accent', col.accent);

            const title = document.createElement('div');
            title.className = 'sin-voice-col-title';
            title.textContent = col.label;

            const faderStage = document.createElement('div');
            faderStage.className = 'sin-voice-fader-stage';

            const meterTrack = document.createElement('div');
            meterTrack.className = 'sin-voice-meter-track';
            const meterFill = document.createElement('div');
            meterFill.className = 'sin-voice-meter-fill';
            meterTrack.appendChild(meterFill);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '-60';
            slider.max = '12';
            slider.step = '0.5';
            slider.className = 'sin-voice-fader';
            slider.setAttribute('aria-label', col.label);

            slider.addEventListener('input', () => {
                const v = Number(slider.value);
                node.updateProperty(col.dbKey, v);
                syncNormalFieldInput(col.dbKey, v);
                syncUI();
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam(col.dbKey, v, false);
                }
            });
            slider.addEventListener('change', () => {
                const v = Number(slider.value);
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam(col.dbKey, v, true);
                } else {
                    windowContext?.refreshAudioPreview?.();
                }
            });
            slider.addEventListener('dblclick', () => {
                node.updateProperty(col.dbKey, 0.0);
                syncNormalFieldInput(col.dbKey, 0.0);
                syncUI();
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam(col.dbKey, 0.0, true);
                } else {
                    windowContext?.refreshAudioPreview?.();
                }
            });

            faderStage.append(meterTrack, slider);

            const readout = document.createElement('span');
            readout.className = 'sin-voice-readout';

            const btnRow = document.createElement('div');
            btnRow.className = 'sin-voice-sm-row';

            const soloBtn = document.createElement('button');
            soloBtn.type = 'button';
            soloBtn.className = 'sin-voice-sm-btn sin-voice-solo';
            soloBtn.textContent = 'S';
            soloBtn.title = `Solo ${col.label}`;
            soloBtn.addEventListener('click', () => {
                const curSolo = String(node.properties?.solo_stem || 'none');
                const nextSolo = curSolo === col.id ? 'none' : col.id;
                node.updateProperty('solo_stem', nextSolo);
                syncUI();
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam('solo_stem', nextSolo, true);
                } else {
                    windowContext?.refreshAudioPreview?.();
                }
            });

            const muteBtn = document.createElement('button');
            muteBtn.type = 'button';
            muteBtn.className = 'sin-voice-sm-btn sin-voice-mute';
            muteBtn.textContent = 'M';
            muteBtn.title = `Mute ${col.label}`;
            muteBtn.addEventListener('click', () => {
                const nextMute = !Boolean(node.properties?.[col.muteKey]);
                node.updateProperty(col.muteKey, nextMute);
                syncUI();
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam(col.muteKey, nextMute, true);
                } else {
                    windowContext?.refreshAudioPreview?.();
                }
            });

            btnRow.append(soloBtn, muteBtn);
            colEl.append(title, faderStage, readout, btnRow);
            mixer.appendChild(colEl);

            colRefs[col.id] = { slider, readout, soloBtn, muteBtn, meterFill, colEl };
        }
        root.appendChild(mixer);

        // 4. One-Click Presets Strip
        const presetsRow = document.createElement('div');
        presetsRow.className = 'sin-proc-actions';
        const presets: Array<{ label: string; amb: number; vox: number; rev: number }> = [
            { label: '0 dB Unity', amb: 0, vox: 0, rev: 0 },
            { label: 'Clean Dialogue', amb: -60, vox: 0, rev: -12 },
            { label: 'Dry Studio', amb: -60, vox: 0, rev: -60 },
            { label: 'Room Only', amb: 0, vox: -60, rev: 0 },
        ];
        for (const p of presets) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sin-proc-btn sin-proc-btn-ghost';
            b.textContent = p.label;
            b.addEventListener('click', () => {
                node.updateProperty('solo_stem', 'none');
                node.updateProperty('mute_ambience', false);
                node.updateProperty('mute_voice', false);
                node.updateProperty('mute_reverb', false);
                node.updateProperty('ambience_db', p.amb);
                node.updateProperty('voice_db', p.vox);
                node.updateProperty('reverb_db', p.rev);
                syncNormalFieldInput('ambience_db', p.amb);
                syncNormalFieldInput('voice_db', p.vox);
                syncNormalFieldInput('reverb_db', p.rev);
                syncUI();
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam('solo_stem', 'none', false);
                    node.emitLiveParam('mute_ambience', false, false);
                    node.emitLiveParam('mute_voice', false, false);
                    node.emitLiveParam('mute_reverb', false, false);
                    node.emitLiveParam('ambience_db', p.amb, false);
                    node.emitLiveParam('voice_db', p.vox, false);
                    node.emitLiveParam('reverb_db', p.rev, true);
                } else {
                    windowContext?.refreshAudioPreview?.();
                }
            });
            presetsRow.appendChild(b);
        }
        root.appendChild(presetsRow);

        container.appendChild(root);

        let modelsById: Record<string, ModelStatusEntry> = {};
        let pollTimer: number | null = null;
        let lastModelCardKey = '';

        const stopDownloadPoll = () => {
            if (pollTimer !== null) {
                window.clearInterval(pollTimer);
                pollTimer = null;
            }
        };

        const ensureDownloadPoll = () => {
            const anyDownloading = Object.values(modelsById).some(
                (m) => m?.download?.status === 'downloading'
            );
            if (anyDownloading && pollTimer === null && root.isConnected) {
                pollTimer = window.setInterval(() => {
                    if (!root.isConnected) {
                        stopDownloadPoll();
                        return;
                    }
                    void fetchModels();
                }, 1000);
            } else if (!anyDownloading) {
                stopDownloadPoll();
            }
        };

        const syncNormalFieldInput = (fieldKey: string, val: number) => {
            const panelRoot = windowContext?.container || container.parentElement;
            const row = panelRoot?.querySelector?.(`[data-field-key="${fieldKey}"]`) as HTMLElement | null;
            if (!row) return;
            row.querySelectorAll<HTMLInputElement>('input').forEach((inp) => {
                if (document.activeElement !== inp) {
                    inp.value = String(val);
                }
            });
        };

        const renderModelCard = () => {
            const backend = String(node.properties?.backend || 'fast_onnx');
            const modelId = BACKEND_MODEL_MAP[backend];
            if (!modelId) {
                if (lastModelCardKey !== 'none') {
                    lastModelCardKey = 'none';
                    modelCard.style.display = 'none';
                }
                return;
            }
            const entry = modelsById[modelId];
            if (!entry) {
                if (lastModelCardKey !== 'missing') {
                    lastModelCardKey = 'missing';
                    modelCard.style.display = 'none';
                }
                return;
            }
            const dlStatus = entry.download?.status || (entry.installed ? 'ready' : 'idle');
            const dlPct = Math.round((entry.download?.progress || 0) * 100);
            const cardKey = `${modelId}|${entry.installed ? 1 : 0}|${dlStatus}|${dlPct}|${entry.download?.error || ''}`;
            if (cardKey === lastModelCardKey) return;
            lastModelCardKey = cardKey;
            const isDownloading = dlStatus === 'downloading';

            modelCard.style.display = '';
            modelCard.innerHTML = '';

            const head = document.createElement('div');
            head.className = 'sin-model-card-head';
            head.textContent = entry.installed
                ? `Model Ready: ${entry.name} (${entry.source || 'local'})`
                : `Model Required: ${entry.name} (~${entry.size_mb} MB)`;

            const meta = document.createElement('div');
            meta.className = 'sin-model-card-meta';
            const pathStr = entry.location || entry.target_dir || `.gaia/models/${modelId}`;
            meta.textContent = `License: ${entry.license} · Path: ${pathStr}`;

            const btnBar = document.createElement('div');
            btnBar.className = 'sin-proc-actions';

            if (!entry.installed) {
                const dlBtn = document.createElement('button');
                dlBtn.type = 'button';
                dlBtn.className = 'sin-proc-btn sin-proc-btn-primary';
                dlBtn.textContent = isDownloading
                    ? `Cancel Download (${Math.round((entry.download?.progress || 0) * 100)}%)`
                    : `Download Model (~${entry.size_mb} MB)`;
                dlBtn.addEventListener('click', async () => {
                    if (isDownloading) {
                        await fetch(`/api/dsp/models/${encodeURIComponent(modelId)}/download`, { method: 'DELETE' });
                    } else {
                        await fetch(`/api/dsp/models/${encodeURIComponent(modelId)}/download`, { method: 'POST' });
                    }
                    await fetchModels();
                });
                btnBar.appendChild(dlBtn);
            }

            const copyPathBtn = document.createElement('button');
            copyPathBtn.type = 'button';
            copyPathBtn.className = 'sin-proc-btn sin-proc-btn-ghost';
            copyPathBtn.textContent = 'Copy Path';
            copyPathBtn.addEventListener('click', () => {
                navigator.clipboard?.writeText?.(pathStr).catch(() => {});
                copyPathBtn.textContent = 'Copied!';
                setTimeout(() => { copyPathBtn.textContent = 'Copy Path'; }, 1200);
            });
            btnBar.appendChild(copyPathBtn);

            modelCard.append(head, meta);
            if (isDownloading) {
                const prog = document.createElement('div');
                prog.className = 'sin-model-progress';
                const fill = document.createElement('div');
                fill.className = 'sin-model-progress-fill';
                fill.style.width = `${Math.round((entry.download?.progress || 0) * 100)}%`;
                prog.appendChild(fill);
                modelCard.appendChild(prog);
            }
            if (entry.download?.error) {
                const err = document.createElement('div');
                err.className = 'sin-model-error';
                err.textContent = entry.download.error;
                modelCard.appendChild(err);
            }
            modelCard.appendChild(btnBar);
        };

        const syncUI = () => {
            const st = node.properties?.bypass ? 'bypassed' : (node.processorStatus?.state || 'ready');
            statusBadge.dataset.state = st;
            statusBadge.textContent = st.replace('_', ' ').toUpperCase();
            statusText.textContent = node.processorStatus?.phase || (node.properties?.bypass ? 'Bypassed (Dry)' : 'Ready');
            cookBtn.style.display = (node.properties?.cook_mode === 'manual' || st === 'stale_bypassed') ? '' : 'none';
            cookFullBtn.style.display = (node.isComplexMl() && Boolean((window as any).__sinRealtimeTiled)) ? '' : 'none';

            const solo = String(node.properties?.solo_stem || 'none');
            const rms = node.processorStatus?.stem_rms || {};

            for (const col of columns) {
                const ref = colRefs[col.id];
                const dbVal = Number(node.properties?.[col.dbKey] ?? 0);
                const isMuted = Boolean(node.properties?.[col.muteKey]);
                const isSolo = solo === col.id;
                const dimmed = (solo !== 'none' && !isSolo) || isMuted;

                if (document.activeElement !== ref.slider) {
                    ref.slider.value = String(dbVal);
                }
                ref.readout.textContent = fmtDb(dbVal);
                ref.soloBtn.classList.toggle('is-active', isSolo);
                ref.muteBtn.classList.toggle('is-active', isMuted);
                ref.colEl.classList.toggle('is-dimmed', dimmed);

                const stemRmsVal = Number((rms as any)[col.id] ?? 0);
                const pct = Math.min(100, Math.round(Math.sqrt(Math.max(0, stemRmsVal)) * 160));
                ref.meterFill.style.height = `${pct}%`;
            }

            renderModelCard();
        };

        const fetchModels = async () => {
            try {
                const res = await fetch('/api/dsp/models?node_type=voice_isolator');
                if (res.ok) {
                    const data = await res.json();
                    const prevMap = modelsById;
                    const nextMap: Record<string, ModelStatusEntry> = {};
                    for (const m of data?.models || []) {
                        nextMap[m.id] = m;
                    }
                    modelsById = nextMap;
                    renderModelCard();
                    ensureDownloadPoll();
                    const activeBackend = String(node.properties?.backend || 'fast_onnx');
                    const activeModelId = BACKEND_MODEL_MAP[activeBackend];
                    if (
                        activeModelId &&
                        prevMap[activeModelId]?.download?.status === 'downloading' &&
                        nextMap[activeModelId]?.installed
                    ) {
                        node.requestManualCook();
                    }
                }
            } catch {
                // Keep UI responsive offline
            }
        };

        const onProp = (ev: Event) => {
            if (!root.isConnected) { cleanup(); return; }
            if ((ev as CustomEvent).detail?.nodeId === node.id) syncUI();
        };
        const onStatus = (ev: Event) => {
            if (!root.isConnected) { cleanup(); return; }
            if ((ev as CustomEvent).detail?.nodeId === node.id) syncUI();
        };
        const onModelDl = (ev: Event) => {
            if (!root.isConnected) { cleanup(); return; }
            const d = (ev as CustomEvent).detail;
            if (d?.model_id && modelsById[d.model_id]) {
                modelsById[d.model_id] = {
                    ...modelsById[d.model_id],
                    installed: d.status === 'ready' ? true : modelsById[d.model_id].installed,
                    download: d,
                };
                renderModelCard();
                ensureDownloadPoll();
                if (d.status === 'ready') {
                    void fetchModels();
                    node.requestManualCook();
                }
            }
        };
        const cleanup = () => {
            stopDownloadPoll();
            window.removeEventListener('sin-processor-prop-changed', onProp);
            window.removeEventListener('sin-processor-status-changed', onStatus);
            window.removeEventListener('sin-model-download', onModelDl);
        };
        window.addEventListener('sin-processor-prop-changed', onProp);
        window.addEventListener('sin-processor-status-changed', onStatus);
        window.addEventListener('sin-model-download', onModelDl);

        syncUI();
        void fetchModels();
    }
}
