import { type BaseNode } from '../../nodes/BaseNode.ts';
import { type PreampDenoiseNode } from '../../nodes/PreampDenoiseNode.ts';
import { serializeNodeSubtree } from '../../../../ermes/ts/serializer.ts';

interface PreampProfileOption {
    id: string;
    label: string;
    device_family: string;
    default_topology: string;
    calibrated: boolean;
}

interface PreviewCurvesResponse {
    freqs_hz: number[];
    input_db: number[];
    noise_floor_db: number[];
    output_db: number[];
    detected_spurs_hz: number[];
    suggested_noise_window: [number, number];
}

function setupCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
    const dpr = Math.min(2, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

export class PreampDenoiseSection {
    static async render(
        container: HTMLElement,
        baseNode: BaseNode,
        windowContext: any
    ): Promise<void> {
        const node = baseNode as PreampDenoiseNode;
        const root = document.createElement('div');
        root.className = 'sin-proc-panel sin-preamp-panel';

        // 1. Status & Cook Mode Bar
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
        statusBar.append(statusBadge, statusText, cookBtn);
        root.appendChild(statusBar);

        // 2. Device Profile + Topology Quick Bar
        const deviceBar = document.createElement('div');
        deviceBar.className = 'sin-proc-row';

        const profileSelect = document.createElement('select');
        profileSelect.className = 'td-param-select sin-select sin-proc-select';
        profileSelect.setAttribute('aria-label', 'Preamp Device Profile');

        const topoGroup = document.createElement('div');
        topoGroup.className = 'sin-proc-seg';
        const topoDefs = [
            { value: 'mono_or_dual_mono', label: 'Mono / Interface' },
            { value: 'coincident_xy_stereo', label: 'Coincident X/Y' },
            { value: 'spaced_stereo', label: 'Spaced' },
        ];
        const topoBtns: HTMLButtonElement[] = [];
        for (const t of topoDefs) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sin-proc-seg-btn';
            b.textContent = t.label;
            b.dataset.value = t.value;
            b.addEventListener('click', () => {
                node.updateProperty('input_topology', t.value);
                syncUI();
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam('input_topology', t.value, true);
                } else {
                    windowContext?.refreshAudioPreview?.();
                }
            });
            topoBtns.push(b);
            topoGroup.appendChild(b);
        }
        deviceBar.append(profileSelect);
        root.appendChild(deviceBar);
        root.appendChild(topoGroup);

        // 3. Interactive Spectrum & Noise-Floor Canvas
        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'sin-preamp-canvas-wrap';
        const canvas = document.createElement('canvas');
        canvas.className = 'sin-preamp-canvas';
        const CANVAS_W = 300;
        const CANVAS_H = 128;
        canvasWrap.appendChild(canvas);
        root.appendChild(canvasWrap);

        // 4. Action Strip (Learn Quietest 1s, Clear Print, Noise-Only Diff, Refresh Spectrum)
        const actions = document.createElement('div');
        actions.className = 'sin-proc-actions';

        const learnBtn = document.createElement('button');
        learnBtn.type = 'button';
        learnBtn.className = 'sin-proc-btn';
        learnBtn.textContent = 'Auto Noise Print (1s)';

        const clearPrintBtn = document.createElement('button');
        clearPrintBtn.type = 'button';
        clearPrintBtn.className = 'sin-proc-btn sin-proc-btn-ghost';
        clearPrintBtn.textContent = 'Clear Print';

        const diffBtn = document.createElement('button');
        diffBtn.type = 'button';
        diffBtn.className = 'sin-proc-btn';
        diffBtn.textContent = 'Listen Noise Only';

        actions.append(learnBtn, clearPrintBtn, diffBtn);
        root.appendChild(actions);

        const spurInfo = document.createElement('div');
        spurInfo.className = 'sin-proc-meta';
        root.appendChild(spurInfo);

        container.appendChild(root);

        let profiles: PreampProfileOption[] = [
            { id: 'generic_adc', label: 'Generic Preamp / ADC Floor', device_family: 'generic', default_topology: 'mono_or_dual_mono', calibrated: false },
            { id: 'usb_interface', label: 'USB Audio Interface / Soundcard', device_family: 'interface', default_topology: 'mono_or_dual_mono', calibrated: false },
            { id: 'zoom_h4', label: 'Zoom H4 (Original X/Y)', device_family: 'zoom_h4', default_topology: 'coincident_xy_stereo', calibrated: false },
            { id: 'zoom_h4n', label: 'Zoom H4n (X/Y Capsules)', device_family: 'zoom_h4', default_topology: 'coincident_xy_stereo', calibrated: false },
            { id: 'zoom_h4n_pro', label: 'Zoom H4n Pro (X/Y Capsules)', device_family: 'zoom_h4', default_topology: 'coincident_xy_stereo', calibrated: false },
            { id: 'zoom_h4essential', label: 'Zoom H4essential (32-bit X/Y)', device_family: 'zoom_h4', default_topology: 'coincident_xy_stereo', calibrated: false },
        ];
        let previewData: PreviewCurvesResponse | null = null;

        const populateProfiles = () => {
            profileSelect.innerHTML = '';
            const cur = String(node.properties?.profile_id || 'generic_adc');
            for (const p of profiles) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.calibrated ? `★ ${p.label} (Calibrated)` : p.label;
                opt.selected = p.id === cur;
                profileSelect.appendChild(opt);
            }
        };
        populateProfiles();

        profileSelect.addEventListener('change', () => {
            const nextId = profileSelect.value;
            const found = profiles.find((p) => p.id === nextId);
            node.updateProperty('profile_id', nextId);
            if (found?.default_topology) {
                node.updateProperty('input_topology', found.default_topology);
            }
            syncUI();
            void refreshSpectrum();
            if ((window as any).__sinRealtimeTiled) {
                if (found?.default_topology) {
                    node.emitLiveParam('input_topology', found.default_topology, false);
                }
                node.emitLiveParam('profile_id', nextId, true);
            } else {
                windowContext?.refreshAudioPreview?.();
            }
        });

        diffBtn.addEventListener('click', () => {
            const cur = String(node.properties?.output_mode || 'denoised');
            const nextMode = cur === 'noise_only' ? 'denoised' : 'noise_only';
            node.updateProperty('output_mode', nextMode);
            syncUI();
            if ((window as any).__sinRealtimeTiled) {
                node.emitLiveParam('output_mode', nextMode, true);
            } else {
                windowContext?.refreshAudioPreview?.();
            }
        });

        clearPrintBtn.addEventListener('click', () => {
            node.updateProperty('noise_start', 0);
            node.updateProperty('noise_end', 0);
            syncUI();
            void refreshSpectrum();
            if ((window as any).__sinRealtimeTiled) {
                node.emitLiveParam('noise_start', 0, false);
                node.emitLiveParam('noise_end', 0, true);
            } else {
                windowContext?.refreshAudioPreview?.();
            }
        });

        learnBtn.addEventListener('click', async () => {
            await refreshSpectrum();
            if (previewData?.suggested_noise_window) {
                const [s, e] = previewData.suggested_noise_window;
                node.updateProperty('noise_start', s);
                node.updateProperty('noise_end', e);
                syncUI();
                if ((window as any).__sinRealtimeTiled) {
                    node.emitLiveParam('noise_start', s, false);
                    node.emitLiveParam('noise_end', e, true);
                } else {
                    windowContext?.refreshAudioPreview?.();
                }
            }
        });

        // Draggable HPF handle directly on the spectrum canvas
        const fMin = 25;
        const fMax = 20000;
        const freqToX = (hz: number) => {
            const clamped = Math.max(fMin, Math.min(fMax, hz));
            return (Math.log(clamped / fMin) / Math.log(fMax / fMin)) * CANVAS_W;
        };
        const xToFreq = (x: number) => {
            const norm = Math.max(0, Math.min(1, x / CANVAS_W));
            return fMin * Math.pow(fMax / fMin, norm);
        };

        let draggingHpf = false;
        const updateHpfFromEvent = (ev: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            const relX = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * CANVAS_W;
            const hz = Math.round(Math.max(0, Math.min(150, xToFreq(relX))));
            node.updateProperty('hp_hz', hz < 8 ? 0 : hz);
            drawSpectrum();
        };
        canvas.addEventListener('pointerdown', (ev) => {
            draggingHpf = true;
            canvas.setPointerCapture?.(ev.pointerId);
            updateHpfFromEvent(ev);
        });
        canvas.addEventListener('pointermove', (ev) => {
            if (draggingHpf) updateHpfFromEvent(ev);
        });
        canvas.addEventListener('pointerup', () => {
            if (!draggingHpf) return;
            draggingHpf = false;
            syncUI();
            if ((window as any).__sinRealtimeTiled) {
                node.emitLiveParam('hp_hz', Number(node.properties?.hp_hz ?? 40), true);
            } else {
                windowContext?.refreshAudioPreview?.();
            }
        });

        const drawSpectrum = () => {
            const ctx = setupCanvas(canvas, CANVAS_W, CANVAS_H);
            if (!ctx) return;

            ctx.fillStyle = '#090d14';
            ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

            // Log frequency grid lines
            ctx.strokeStyle = 'rgba(148,163,184,0.12)';
            ctx.lineWidth = 1;
            for (const f of [50, 100, 250, 500, 1000, 2000, 5000, 10000]) {
                const x = Math.round(freqToX(f)) + 0.5;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, CANVAS_H);
                ctx.stroke();
            }

            const dbMin = -100;
            const dbMax = -10;
            const dbToY = (db: number) => {
                const norm = Math.max(0, Math.min(1, (db - dbMin) / (dbMax - dbMin)));
                return CANVAS_H - norm * (CANVAS_H - 14) - 8;
            };

            const drawCurve = (freqs: number[], dbs: number[], stroke: string, dashed = false, fill?: string) => {
                if (!freqs.length || freqs.length !== dbs.length) return;
                ctx.save();
                ctx.beginPath();
                for (let i = 0; i < freqs.length; i++) {
                    const x = freqToX(freqs[i]);
                    const y = dbToY(dbs[i]);
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                if (fill) {
                    ctx.lineTo(freqToX(freqs[freqs.length - 1]), CANVAS_H);
                    ctx.lineTo(freqToX(freqs[0]), CANVAS_H);
                    ctx.closePath();
                    ctx.fillStyle = fill;
                    ctx.fill();
                } else {
                    if (dashed) ctx.setLineDash([4, 3]);
                    ctx.strokeStyle = stroke;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
                ctx.restore();
            };

            if (previewData) {
                drawCurve(previewData.freqs_hz, previewData.input_db, '#64748b', false, 'rgba(100,116,139,0.22)');
                drawCurve(previewData.freqs_hz, previewData.noise_floor_db, '#f59e0b', true);
                drawCurve(previewData.freqs_hz, previewData.output_db, '#2dd4bf', false);

                // Mark detected narrowband hardware spurs
                ctx.fillStyle = '#fb7185';
                for (const sp of previewData.detected_spurs_hz || []) {
                    const sx = freqToX(sp);
                    ctx.fillRect(sx - 1, 2, 2, 10);
                }
            } else {
                // Analytical preamp 1/f curve fallback before upstream audio is analyzed
                const fc = String(node.properties?.profile_id || '').startsWith('zoom_h4') ? 240 : 150;
                const red = Number(node.properties?.reduction_db ?? 12);
                const freqs: number[] = [];
                const floorDb: number[] = [];
                const outDb: number[] = [];
                for (let i = 0; i < 64; i++) {
                    const f = fMin * Math.pow(fMax / fMin, i / 63);
                    const nDb = -66 + 10 * Math.log10(1 + Math.pow(fc / f, 1.15));
                    freqs.push(f);
                    floorDb.push(nDb);
                    outDb.push(nDb - red * 0.7);
                }
                drawCurve(freqs, floorDb, '#f59e0b', true);
                drawCurve(freqs, outDb, '#2dd4bf', false);
            }

            // HPF vertical handle
            const hpHz = Number(node.properties?.hp_hz ?? 40);
            if (hpHz >= 5) {
                const hx = freqToX(hpHz);
                ctx.fillStyle = 'rgba(244,63,94,0.14)';
                ctx.fillRect(0, 0, hx, CANVAS_H);
                ctx.strokeStyle = '#f43f5e';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(hx, 0);
                ctx.lineTo(hx, CANVAS_H);
                ctx.stroke();
                ctx.fillStyle = '#fda4af';
                ctx.font = '600 9px "Inter", system-ui, sans-serif';
                ctx.fillText(`HPF ${Math.round(hpHz)}Hz`, Math.min(CANVAS_W - 60, hx + 4), 12);
            }

            // Legend + Reduction readout
            ctx.fillStyle = '#94a3b8';
            ctx.font = '500 9px "Inter", system-ui, sans-serif';
            const redDb = Number(node.properties?.reduction_db ?? 12);
            ctx.fillText(`-${redDb.toFixed(1)} dB floor · Drag to set HPF`, 6, CANVAS_H - 5);
        };

        const syncUI = () => {
            const st = node.properties?.bypass ? 'bypassed' : (node.processorStatus?.state || 'ready');
            statusBadge.dataset.state = st;
            statusBadge.textContent = st.replace('_', ' ').toUpperCase();
            statusText.textContent = node.processorStatus?.phase || (node.properties?.bypass ? 'Bypassed (Dry)' : 'Ready');
            cookBtn.style.display = (node.properties?.cook_mode === 'manual' || st === 'stale_bypassed') ? '' : 'none';

            const curProf = String(node.properties?.profile_id || 'generic_adc');
            if (profileSelect.value !== curProf) profileSelect.value = curProf;

            const curTopo = String(node.properties?.input_topology || 'mono_or_dual_mono');
            topoBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.value === curTopo));

            const isDiff = String(node.properties?.output_mode || 'denoised') === 'noise_only';
            diffBtn.classList.toggle('is-active', isDiff);

            const ns = Number(node.properties?.noise_start || 0);
            const ne = Number(node.properties?.noise_end || 0);
            const printLabel = ne > ns + 0.005 ? `Noise Print: ${(ns * 100).toFixed(0)}%..${(ne * 100).toFixed(0)}%` : 'Adaptive Preamp Floor';
            const spurs = previewData?.detected_spurs_hz?.length
                ? ` · Spurs: ${previewData.detected_spurs_hz.slice(0, 4).map((s) => `${Math.round(s)}Hz`).join(', ')}`
                : '';
            spurInfo.textContent = `${printLabel}${spurs}`;

            // Reflect topology state on normal FieldSchema rows (disable stereo_coherence on mono/dual-mono)
            const panelRoot = windowContext?.container || container.parentElement;
            if (panelRoot) {
                const scRow = panelRoot.querySelector?.('[data-field-key="stereo_coherence"]') as HTMLElement | null;
                if (scRow) {
                    const disableSc = curTopo === 'mono_or_dual_mono';
                    scRow.style.opacity = disableSc ? '0.4' : '';
                    scRow.style.pointerEvents = disableSc ? 'none' : '';
                }
            }
            drawSpectrum();
        };

        const refreshSpectrum = async () => {
            const graph = (window as any).editorGraph;
            const inputs = node.getInputNodes?.() || [];
            if (!graph || inputs.length === 0) {
                drawSpectrum();
                return;
            }
            try {
                const upstreamModel = serializeNodeSubtree(graph, inputs[0].id);
                if (!upstreamModel) return;
                const res = await fetch('/api/dsp/preamp-denoise/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: upstreamModel,
                        params: node.getProcessorParams(),
                        num_points: 128,
                    }),
                });
                if (res.ok) {
                    previewData = await res.json();
                    syncUI();
                }
            } catch {
                // Keep analytical preview cleanly if backend isn't reachable
            }
        };

        // Load read-only preamp profiles from SIN API (includes GAIA calibrated profiles)
        try {
            const res = await fetch('/api/dsp/preamp-profiles');
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data?.profiles) && data.profiles.length > 0) {
                    profiles = data.profiles;
                    populateProfiles();
                }
            }
        } catch {
            // Keep built-in fallback list
        }

        const onProp = (ev: Event) => {
            if (!root.isConnected) {
                window.removeEventListener('sin-processor-prop-changed', onProp);
                window.removeEventListener('sin-processor-status-changed', onStatus);
                return;
            }
            const d = (ev as CustomEvent).detail;
            if (d?.nodeId === node.id) syncUI();
        };
        const onStatus = (ev: Event) => {
            if (!root.isConnected) {
                window.removeEventListener('sin-processor-prop-changed', onProp);
                window.removeEventListener('sin-processor-status-changed', onStatus);
                return;
            }
            const d = (ev as CustomEvent).detail;
            if (d?.nodeId === node.id) syncUI();
        };
        window.addEventListener('sin-processor-prop-changed', onProp);
        window.addEventListener('sin-processor-status-changed', onStatus);

        syncUI();
        void refreshSpectrum();
    }
}
