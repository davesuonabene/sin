import { type BaseNode } from '../../nodes/BaseNode.ts';
import { type ArrangementNode, type ArrangementSectionStructure } from '../../nodes/ArrangementNode.ts';
import { ArrangementVisualizer, type ArrangementAnchor } from '../ArrangementVisualizer.ts';
import { resolveArrangementSourceVisual } from '../arrangementSourceVisual.ts';
import { getParameterWheelStep, registerParameterWheelControl, roundStepValue } from '../ParameterWheelMenu.ts';

const QUANT_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'auto', label: 'Continuous' },
    { value: 'bar', label: '1 Bar' },
    { value: '0.5', label: '½ Bar' },
    { value: 'beat', label: 'Beat' },
    { value: 'none', label: 'Once' }
];

export class ArrangementTimelineSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        node.properties.total_bars = Math.max(0.25, Number(node.properties.total_bars) || 4);
        const arrangementNode = node as ArrangementNode;
        const initialStructure = arrangementNode.migrateLegacySectionSettings();
        let totalBars = node.properties.total_bars;

        const wrapper = document.createElement('div');
        wrapper.className = 'arrangement-timeline-group';
        wrapper.innerHTML = `
            <div class="arrangement-timeline-header">
                <div class="arrangement-timeline-title">Sections</div>
                <div class="arrangement-timeline-header-right">
                    <div class="arrangement-timeline-length" id="arr-total-bars-display">${totalBars} ${totalBars === 1 ? 'bar' : 'bars'}</div>
                    <button type="button" class="arrangement-mode-toggle-btn" id="arr-mode-toggle" title="Toggle Edit / Select Mode" aria-label="Toggle Edit Mode">
                        <svg class="arr-pencil-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                            <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>
                        </svg>
                        <span class="arr-mode-label">Edit</span>
                    </button>
                </div>
            </div>
            <div class="arrangement-visualizer"></div>
            <div class="arrangement-section-editor"></div>
        `;
        container.appendChild(wrapper);

        const visualizerContainer = wrapper.querySelector('.arrangement-visualizer') as HTMLElement;
        const sectionEditor = wrapper.querySelector('.arrangement-section-editor') as HTMLElement;
        const totalBarsDisplay = wrapper.querySelector('#arr-total-bars-display') as HTMLElement;
        const modeToggleBtn = wrapper.querySelector('#arr-mode-toggle') as HTMLButtonElement;
        if (!visualizerContainer || !sectionEditor) return;

        let selectedSection = 0;
        let visualizer: ArrangementVisualizer;

        const syncTotalBarsHeader = () => {
            totalBars = Math.max(0.25, Number(node.properties.total_bars) || 4);
            if (totalBarsDisplay) {
                totalBarsDisplay.textContent = `${totalBars} ${totalBars === 1 ? 'bar' : 'bars'}`;
            }
        };

        const renderSectionEditor = (index: number) => {
            syncTotalBarsHeader();
            const structure = arrangementNode.getSectionStructure();
            const boundaries = [0, ...structure.points, totalBars]
                .filter((p, i, a) => p >= 0 && p <= totalBars && a.indexOf(p) === i)
                .sort((a, b) => a - b);
            const sectionCount = boundaries.length - 1;
            if (index >= sectionCount) index = Math.max(0, sectionCount - 1);
            selectedSection = index;

            const start = boundaries[index];
            const end = boundaries[index + 1];
            const len = end - start;
            const formattedLen = Math.abs(len - Math.round(len)) < 0.001 ? String(Math.round(len)) : len.toFixed(1);

            const probVal = structure.probability[index] ?? 1.0;
            const currentQuant = structure.quant[index] || 'auto';
            const currentAnchor = structure.quantAnchor[index] || 'start';
            const slotVal = structure.slots?.[index] ?? '*';

            sectionEditor.innerHTML = `
                <div class="arrangement-section-heading">Section ${index + 1} (${formattedLen} bars, [${start}..${end}])</div>
                <div class="td-param-row" data-field-key="section_slots" data-param-label="Slot">
                    <div class="td-param-label">Slot</div>
                    <div class="td-param-control">
                        <input class="td-param-input" id="sec-slot-input" type="text" placeholder="*" value="${slotVal}">
                    </div>
                </div>
                <div class="td-param-row" data-field-key="section_probability" data-param-label="Probability">
                    <div class="td-param-label">Probability</div>
                    <div class="td-param-control">
                        <input class="td-param-input" id="sec-prob-input" type="number" min="0" max="1" step="0.1" value="${probVal}">
                    </div>
                </div>
                <div class="td-param-row" data-field-key="section_quant" data-param-label="Quantize">
                    <div class="td-param-label">Quantize</div>
                    <div class="td-param-control">
                        <select class="td-param-input td-param-select sin-select" id="prop-sec-quant">
                            ${QUANT_OPTIONS.map(opt => `<option value="${opt.value}" ${opt.value === currentQuant ? 'selected' : ''}>${opt.label}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="td-param-row" data-field-key="section_quant_anchor" data-param-label="Anchor">
                    <div class="td-param-label">Anchor</div>
                    <div class="td-param-control">
                        <select class="td-param-input td-param-select sin-select" id="prop-sec-quant-anchor">
                            <option value="start" ${currentAnchor === 'start' ? 'selected' : ''}>Start</option>
                            <option value="end" ${currentAnchor === 'end' ? 'selected' : ''}>End</option>
                        </select>
                    </div>
                </div>
            `;

            const slotInput = sectionEditor.querySelector('#sec-slot-input') as HTMLInputElement | null;
            const probInput = sectionEditor.querySelector('#sec-prob-input') as HTMLInputElement | null;
            const quantSelect = sectionEditor.querySelector('#prop-sec-quant') as HTMLSelectElement | null;
            const anchorSelect = sectionEditor.querySelector('#prop-sec-quant-anchor') as HTMLSelectElement | null;

            if (slotInput) {
                const parseSlotVal = (raw: string): number | string => {
                    const trimmed = raw.trim();
                    if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'default' || trimmed.toLowerCase() === 'active') {
                        return '*';
                    }
                    if (trimmed.toLowerCase() === 'rand' || trimmed.toLowerCase() === 'random') {
                        return 'rand';
                    }
                    const parsed = parseInt(trimmed, 10);
                    if (Number.isFinite(parsed)) {
                        return Math.max(0, Math.floor(parsed));
                    }
                    return '*';
                };
                const commitSlot = (normalizeInput: boolean) => {
                    const nextVal = parseSlotVal(slotInput.value);
                    if (normalizeInput) {
                        slotInput.value = String(nextVal);
                    }
                    arrangementNode.updateSectionSlot(index, nextVal);
                    windowContext.refreshAudioPreview();
                };
                slotInput.addEventListener('input', () => commitSlot(false));
                slotInput.addEventListener('change', () => commitSlot(true));
            }

            if (probInput) {
                const commitProb = () => {
                    const num = Math.max(0, Math.min(1, parseFloat(probInput.value) || 0));
                    probInput.value = String(num);
                    arrangementNode.updateSectionProbability(index, num);
                    visualizer.setSectionProbability(index, num);
                    windowContext.refreshAudioPreview();
                };
                registerParameterWheelControl(probInput, {
                    isInteger: false,
                    getValue: () => parseFloat(probInput.value) || 0,
                    setValue: (val) => {
                        const next = Math.max(0, Math.min(1, roundStepValue(val)));
                        probInput.value = String(next);
                        commitProb();
                    },
                });
                probInput.addEventListener('input', commitProb);
                probInput.addEventListener('change', commitProb);
                probInput.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    if (e.altKey || probInput.disabled) return;
                    const dir = e.deltaY < 0 ? 1 : -1;
                    const step = getParameterWheelStep(false);
                    const cur = parseFloat(probInput.value) || 0;
                    const next = Math.max(0, Math.min(1, roundStepValue(cur + dir * step, step)));
                    probInput.value = String(next);
                    commitProb();
                });
            }

            quantSelect?.addEventListener('change', () => {
                arrangementNode.updateSectionQuant(index, quantSelect.value);
                visualizer.setSectionQuant(index, quantSelect.value);
                windowContext.refreshAudioPreview();
            });

            anchorSelect?.addEventListener('change', () => {
                const anchor: ArrangementAnchor = anchorSelect.value === 'end' ? 'end' : 'start';
                arrangementNode.updateSectionQuantAnchor(index, anchor);
                visualizer.setSectionQuantAnchor(index, anchor);
                windowContext.refreshAudioPreview();
            });

            windowContext?.applyOverlays?.();
        };

        const getNodeColor = () => (node as any).nodeColor || (node as any).color || node.properties?.color || '#f59e0b';

        visualizer = new ArrangementVisualizer({
            container: visualizerContainer,
            totalBars,
            nodeColor: getNodeColor(),
            sectionPoints: initialStructure.points,
            sectionProbability: initialStructure.probability,
            sectionQuant: initialStructure.quant,
            sectionQuantAnchor: initialStructure.quantAnchor,
            selectedSection,
            source: resolveArrangementSourceVisual(node),
            onSectionSelect: (index: number) => {
                selectedSection = index;
                renderSectionEditor(selectedSection);
            },
            onSectionStructureChange: (points, probability, quant, quantAnchor) => {
                const structure: ArrangementSectionStructure = {
                    points,
                    probability: probability || [],
                    quant: quant || [],
                    quantAnchor: quantAnchor || []
                };
                arrangementNode.updateSectionStructure(structure);
                windowContext.refreshAudioPreview();
                renderSectionEditor(selectedSection);
            },
            onSplitAtBar: (bar: number) => {
                arrangementNode.splitSectionAtBar(bar);
                windowContext.refreshAudioPreview();
                visualizer.setSectionPoints(arrangementNode.getSectionStructure().points);
                renderSectionEditor(selectedSection);
            },
            onMergeCut: (cutIndex: number) => {
                arrangementNode.removeSectionCut(cutIndex);
                windowContext.refreshAudioPreview();
                visualizer.setSectionPoints(arrangementNode.getSectionStructure().points);
                renderSectionEditor(selectedSection);
            }
        });

        if (modeToggleBtn) {
            modeToggleBtn.addEventListener('click', () => {
                const isCurrentlyEdit = visualizer.getMode() === 'edit';
                const nextMode = isCurrentlyEdit ? 'select' : 'edit';
                visualizer.setMode(nextMode);
                modeToggleBtn.classList.toggle('is-edit-active', nextMode === 'edit');
                const label = modeToggleBtn.querySelector('.arr-mode-label');
                if (label) {
                    label.textContent = nextMode === 'edit' ? 'Done' : 'Edit';
                }
            });
        }

        const onPropChanged = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.nodeId === node.id) {
                if (detail?.key === 'total_bars') {
                    syncTotalBarsHeader();
                    visualizer.setTotalBars(totalBars);
                    visualizer.setSectionPoints(arrangementNode.getSectionStructure().points);
                    renderSectionEditor(selectedSection);
                } else if (detail?.key === 'color' || detail?.property === 'color') {
                    visualizer.setNodeColor(detail.value || getNodeColor());
                }
            }
        };
        const onNodeRefreshed = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.nodeId === node.id) {
                visualizer.setNodeColor(getNodeColor());
            }
        };
        window.addEventListener('node-property-changed', onPropChanged);
        window.addEventListener('node-properties-refreshed', onNodeRefreshed);
        const origDestroy = visualizer.destroy.bind(visualizer);
        visualizer.destroy = () => {
            window.removeEventListener('node-property-changed', onPropChanged);
            window.removeEventListener('node-properties-refreshed', onNodeRefreshed);
            origDestroy();
        };

        windowContext.currentArrangementVisualizer = visualizer;
        renderSectionEditor(selectedSection);
    }
}
