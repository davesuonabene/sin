import { type BaseNode } from '../../nodes/BaseNode';
import { type FieldSchema } from '../../fields/FieldSchema';
import { type ArrangementNode, type ArrangementSectionStructure } from '../../nodes/ArrangementNode';
import { ArrangementVisualizer, type ArrangementSourceVisual } from '../ArrangementVisualizer';

export class ArrangementTimelineSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        node.properties.total_bars = Math.max(0.25, Number(node.properties.total_bars) || 4);
        const probabilityValue = Number(node.properties.probability);
        node.properties.probability = Number.isFinite(probabilityValue)
            ? Math.max(0, Math.min(1, probabilityValue))
            : 1;
        node.properties.quant = String(node.properties.quant || 'none');
        node.properties.quant_anchor = node.properties.quant_anchor === 'end' ? 'end' : 'start';

        const totalBars = node.properties.total_bars;
        const sectionPoints = (Array.isArray(node.properties.section_points) ? node.properties.section_points : [])
            .map(Number)
            .filter((point: number) => Number.isFinite(point) && point > 0 && point < totalBars)
            .sort((a: number, b: number) => a - b);
        node.properties.section_points = [...new Set(sectionPoints)];
        const arrangementNode = node as ArrangementNode;
        const initialStructure = arrangementNode.getSectionStructure();
        arrangementNode.updateSectionStructure(initialStructure);

        // Compute ArrangementSourceVisual indicators from parent/siblings
        const resolveSourceVisual = (): ArrangementSourceVisual | null => {
            const graph = (window as any).editorGraph;
            const trackNodes = (window as any).trackNodes;
            const nodeData = trackNodes?.get(node.id);
            const parentId = node.properties.parentId ?? nodeData?.parentId;
            const parentData = parentId != null ? trackNodes?.get(parentId) : null;

            let sourceBars = 1.0;
            let sourceLabel = "Sample";
            let sourceKind: 'loop' | 'sample' | 'sequence' | 'mixed' = 'loop';

            if (parentData && Array.isArray(parentData.children)) {
                const siblingIds = parentData.children.filter((id: number) => id !== node.id);
                if (siblingIds.length > 0) {
                    const siblings = siblingIds
                        .map((id: number) => graph?.getNodeById(id))
                        .filter((n: any) => n != null);

                    if (siblings.length > 0) {
                        const first = siblings[0];
                        sourceLabel = first.properties?.node_name || first.title || "Sample";
                        if (first.type === 'Audio/Sequence') {
                            sourceKind = 'sequence';
                            sourceBars = (first.properties?.sequence?.length || 16) * (first.properties?.step_length || 0.25);
                        } else if (first.type === 'Audio/Sample') {
                            sourceKind = first.properties?.sample_type === 'one_shot' ? 'sample' : 'loop';
                            sourceBars = Number(first.properties?.duration_bars) || Number(first.properties?.duration_seconds) || 1.0;
                        }
                        if (siblings.length > 1) {
                            sourceKind = 'mixed';
                            sourceLabel = `${siblings.length} Layers`;
                        }
                        return {
                            bars: Math.max(0.25, sourceBars),
                            label: sourceLabel,
                            kind: sourceKind
                        };
                    }
                }
            }
            return {
                bars: 1.0,
                label: "Source",
                kind: "loop"
            };
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'td-param-group';
        wrapper.innerHTML = `
            <div style="margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                <div style="font-weight: 700; font-size: 10px; text-transform: uppercase; color: #64748b;">
                    Arrangement Timeline & Sections (${totalBars} Bars)
                </div>
            </div>
            <div class="arrangement-visualizer" style="height: 120px; background: #0f172a; border-radius: 6px; position: relative; overflow: hidden;"></div>
            
            <div id="arrangement-section-editor" style="margin-top: 10px; border-top: 1px dashed #cbd5e1; padding-top: 8px;"></div>
        `;

        container.appendChild(wrapper);

        const visContainer = wrapper.querySelector('.arrangement-visualizer') as HTMLElement;
        const sectionEditor = wrapper.querySelector('#arrangement-section-editor') as HTMLElement;
        if (!visContainer) return;

        let selectedSecIdx = 0;
        let visualizer: ArrangementVisualizer;

        const updateSectionControls = () => {
            if (!sectionEditor) return;
            const points = node.properties.section_points || [];
            const numSections = points.length + 1;
            if (selectedSecIdx >= numSections) selectedSecIdx = 0;

            const probs = node.properties.section_probability || [1.0];
            const probVal = probs[selectedSecIdx] !== undefined ? probs[selectedSecIdx] : 1.0;
            const sampleStarts = node.properties.section_sample_start || [0.0];
            const sampleStartVal = sampleStarts[selectedSecIdx] !== undefined ? sampleStarts[selectedSecIdx] : 0.0;
            const sampleStartField = arrangementNode.getFields().find(field => field.key === 'section_sample_start');
            const sampleStartMin = sampleStartField?.min ?? 0;
            const sampleStartMax = sampleStartField?.max ?? 1;
            const sampleStartStep = sampleStartField?.step ?? 0.01;
            const sectionQuants = node.properties.section_quant || ['global'];
            const sectionQuantVal = String(sectionQuants[selectedSecIdx] ?? 'global');
            const sectionQuantField = arrangementNode.getFields().find(field => field.key === 'section_quant');
            const sectionAnchors = node.properties.section_quant_anchor || ['global'];
            const sectionAnchorVal = String(sectionAnchors[selectedSecIdx] ?? 'global');
            const sectionAnchorField = arrangementNode.getFields().find(field => field.key === 'section_quant_anchor');

            sectionEditor.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <div style="font-size: 10px; font-weight: 700; color: #475569;">Section ${selectedSecIdx + 1} Parameters</div>
                    ${points.length > 0 && selectedSecIdx < points.length ? `<button type="button" class="close-btn" id="btn-delete-cut" style="color: #ef4444; font-size: 10px;">Remove Cut</button>` : ''}
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Probability</div>
                    <div class="td-param-control" style="display: flex; gap: 6px; align-items: center;">
                        <input type="range" class="td-param-input" id="sec-prob-range" min="0" max="1" step="0.05" value="${probVal}" style="flex: 1;" />
                        <span style="font-size: 10px; font-weight: 600; width: 36px; text-align: right;" id="sec-prob-val">${Math.round(probVal * 100)}%</span>
                    </div>
                </div>
                <div class="td-param-row">
                    <div class="td-param-label">${sampleStartField?.label ?? 'Sample Start'}</div>
                    <div class="td-param-control" style="display: flex; gap: 6px; align-items: center;">
                        <input type="range" class="td-param-input" id="sec-sample-start-range" min="${sampleStartMin}" max="${sampleStartMax}" step="${sampleStartStep}" value="${sampleStartVal}" style="flex: 1;" />
                        <span style="font-size: 10px; font-weight: 600; width: 36px; text-align: right;" id="sec-sample-start-val">${sampleStartVal.toFixed(2)}</span>
                    </div>
                </div>
                <div class="td-param-row">
                    <div class="td-param-label">${sectionQuantField?.label ?? 'Local Quant'}</div>
                    <div class="td-param-control">
                        <select class="td-param-input" id="prop-sec-quant"></select>
                    </div>
                </div>
                <div class="td-param-row">
                    <div class="td-param-label">${sectionAnchorField?.label ?? 'Local Anchor'}</div>
                    <div class="td-param-control arrangement-section-anchor-control">
                        <select class="td-param-input" id="prop-sec-quant-anchor"></select>
                    </div>
                </div>
            `;

            const populateSelect = (
                select: HTMLSelectElement | null,
                options: FieldSchema['options'],
                currentValue: string
            ) => {
                if (!select) return;
                const normalizedOptions = (options || []).map(option => typeof option === 'string'
                    ? { value: option, label: option }
                    : option);
                if (!normalizedOptions.some(option => String(option.value) === currentValue)) {
                    normalizedOptions.push({ value: currentValue, label: currentValue });
                }
                for (const option of normalizedOptions) {
                    select.add(new Option(option.label, String(option.value), false, String(option.value) === currentValue));
                }
            };

            const quantSelect = sectionEditor.querySelector('#prop-sec-quant') as HTMLSelectElement | null;
            const anchorSelect = sectionEditor.querySelector('#prop-sec-quant-anchor') as HTMLSelectElement | null;
            populateSelect(quantSelect, sectionQuantField?.options, sectionQuantVal);
            populateSelect(anchorSelect, sectionAnchorField?.options, sectionAnchorVal);

            sectionEditor.querySelector('#sec-prob-range')?.addEventListener('input', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!Array.isArray(node.properties.section_probability)) {
                    node.properties.section_probability = [];
                }
                node.properties.section_probability[selectedSecIdx] = val;
                node.updateProperty('section_probability', node.properties.section_probability);
                const valDisplay = sectionEditor.querySelector('#sec-prob-val');
                if (valDisplay) valDisplay.textContent = `${Math.round(val * 100)}%`;
                windowContext.refreshAudioPreview();
            });

            sectionEditor.querySelector('#sec-sample-start-range')?.addEventListener('input', (e) => {
                const val = Math.max(0, Math.min(1, parseFloat((e.target as HTMLInputElement).value)));
                arrangementNode.updateSectionSampleStart(selectedSecIdx, val);
                const valDisplay = sectionEditor.querySelector('#sec-sample-start-val');
                if (valDisplay) valDisplay.textContent = val.toFixed(2);
                windowContext.refreshAudioPreview();
            });

            quantSelect?.addEventListener('change', () => {
                arrangementNode.updateSectionQuant(selectedSecIdx, quantSelect.value);
                visualizer.setSectionQuant(selectedSecIdx, quantSelect.value);
                windowContext.refreshAudioPreview();
            });

            anchorSelect?.addEventListener('change', () => {
                const value = anchorSelect.value === 'start' || anchorSelect.value === 'end'
                    ? anchorSelect.value
                    : 'global';
                arrangementNode.updateSectionQuantAnchor(selectedSecIdx, value);
                visualizer.setSectionQuantAnchor(selectedSecIdx, value);
                windowContext.refreshAudioPreview();
            });

            sectionEditor.querySelector('#btn-delete-cut')?.addEventListener('click', () => {
                if (selectedSecIdx < points.length) {
                    arrangementNode.removeSectionCut(selectedSecIdx);
                    windowContext.refreshAudioPreview();
                    windowContext.currentArrangementVisualizer?.destroy();
                    container.replaceChildren();
                    void ArrangementTimelineSection.render(container, node, windowContext);
                }
            });
        };

        visualizer = new ArrangementVisualizer({
            container: visContainer,
            totalBars,
            sectionPoints: initialStructure.points,
            sectionEnabled: initialStructure.enabled,
            sectionProbability: initialStructure.probability,
            sectionSampleStart: initialStructure.sampleStart,
            sectionQuant: initialStructure.quant,
            sectionQuantAnchor: initialStructure.quantAnchor,
            selectedSection: selectedSecIdx,
            quant: node.properties.quant,
            anchor: node.properties.quant_anchor,
            source: resolveSourceVisual(),
            onSectionSelect: (idx: number) => {
                selectedSecIdx = idx;
                updateSectionControls();
            },
            onSectionStructureChange: (points, enabled, probability, sampleStart, quant, quantAnchor) => {
                const structure: ArrangementSectionStructure = {
                    points,
                    enabled,
                    probability: probability || [],
                    sampleStart: sampleStart || [],
                    quant: quant || [],
                    quantAnchor: quantAnchor || []
                };
                arrangementNode.updateSectionStructure(structure);
                windowContext.refreshAudioPreview();
                updateSectionControls();
            }
        });

        windowContext.currentArrangementVisualizer = visualizer;
        updateSectionControls();
    }
}
