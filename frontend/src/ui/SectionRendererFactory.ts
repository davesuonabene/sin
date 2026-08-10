import { type PanelSectionConfig } from '../fields/NodePanelSchema';
import { type FieldSchema } from '../fields/FieldSchema';
import { type BaseNode } from '../nodes/BaseNode';
import { WidgetFactory } from './WidgetFactory';
import { WaveformCropSection } from './components/WaveformCropSection';
import { SequenceGridSection } from './components/SequenceGridSection';
import { ArrangementTimelineSection } from './components/ArrangementTimelineSection';
import { FxChainSection } from './components/FxChainSection';
import { AssetPoolSection } from './components/AssetPoolSection';
import { NEON_ICONS, NODE_SHAPES, drawNeonIcon, traceNodeShape, type NodeShape } from '../nodes/NodeVisuals';

export class SectionRendererFactory {
    static async renderSection(
        section: PanelSectionConfig,
        node: BaseNode,
        windowContext: any
    ): Promise<HTMLElement> {
        const wrapper = document.createElement('div');
        wrapper.className = `td-section-container td-section-${section.type}`;

        if (section.title) {
            const heading = document.createElement('h4');
            heading.className = 'td-section-title';
            heading.textContent = section.title;
            wrapper.appendChild(heading);
        }

        switch (section.type) {
            case 'fields':
                this.renderFieldsSection(wrapper, section, node, windowContext);
                break;
            case 'info_table':
                this.renderInfoTableSection(wrapper, node, windowContext);
                break;
            case 'fx_chain':
                await FxChainSection.render(wrapper, node, windowContext);
                break;
            case 'pool_editor':
                await AssetPoolSection.render(wrapper, node, windowContext);
                break;
            case 'waveform_crop':
                await WaveformCropSection.render(wrapper, node, windowContext);
                break;
            case 'sequence_grid':
                await SequenceGridSection.render(wrapper, node, windowContext);
                break;
            case 'arrangement_timeline':
                await ArrangementTimelineSection.render(wrapper, node, windowContext);
                break;
            default:
                this.renderFieldsSection(wrapper, section, node, windowContext);
                break;
        }

        return wrapper;
    }

    private static renderFieldsSection(
        container: HTMLElement,
        section: PanelSectionConfig,
        node: BaseNode,
        windowContext: any
    ) {
        const group = document.createElement('div');
        group.className = 'td-param-group';

        const nodeFieldsMap = new Map<string, FieldSchema>();
        for (const f of node.getFields()) {
            nodeFieldsMap.set(f.key, f);
        }

        const fieldsToRender: FieldSchema[] = [];
        if (section.fields && section.fields.length > 0) {
            for (const item of section.fields) {
                if (typeof item === 'string') {
                    const schema = nodeFieldsMap.get(item);
                    if (schema) fieldsToRender.push(schema);
                } else {
                    fieldsToRender.push(item);
                }
            }
        } else {
            fieldsToRender.push(...node.getFields());
        }

        const titleDisplay = windowContext.container.querySelector('#td-title-display') as HTMLSpanElement;

        for (const field of fieldsToRender) {
            const row = WidgetFactory.createRow(field, node, async (key, val, previousValue) => {
                try {
                    await node.onPropertyEdited(key, val, previousValue);
                    if (key === 'node_name' && titleDisplay) {
                        titleDisplay.innerText = String(val);
                    }
                    windowContext.refreshAudioPreview();
                } catch (error) {
                    node.updateProperty(key, previousValue);
                    console.error(`Could not save ${field.label}`, error);
                    window.alert(error instanceof Error ? error.message : `Could not save ${field.label}`);
                    await windowContext.renderTabContent();
                }
            });
            group.appendChild(row);
        }

        container.appendChild(group);
    }

    private static renderInfoTableSection(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ) {
        const pos = node.pos ? `X: ${Math.round(node.pos[0])}, Y: ${Math.round(node.pos[1])}` : 'N/A';
        const inputsCount = node.inputs ? node.inputs.length : 0;
        const outputsCount = node.outputs ? node.outputs.length : 0;

        const table = document.createElement('table');
        table.className = 'td-info-table';
        table.innerHTML = `
            <tr><td>ID</td><td>#${node.id}</td></tr>
            <tr><td>Type</td><td>${node.type}</td></tr>
            <tr><td>Position</td><td>${pos}</td></tr>
            <tr><td>Inputs</td><td>${inputsCount} slot(s)</td></tr>
            <tr><td>Outputs</td><td>${outputsCount} slot(s)</td></tr>
        `;
        container.appendChild(table);

        const currentColor = node.nodeColor;
        const currentIcon = node.nodeIcon;
        const currentShape = node.nodeShape;
        const colorSwatches = ["#10b981", "#4f46e5", "#ec4899", "#8b5cf6", "#f59e0b", "#9333ea", "#ef4444", "#06b6d4", "#3b82f6", "#64748b"];

        const styleControls = document.createElement('div');
        styleControls.className = 'td-param-group';
        styleControls.style.cssText = 'margin-top: 15px; border-top: 1px dashed #cbd5e1; padding-top: 12px;';
        styleControls.innerHTML = `
            <div style="font-weight: 700; font-size: 10px; text-transform: uppercase; color: #64748b; margin-bottom: 8px;">Node Appearance</div>
            
            <div class="td-param-row">
                <div class="td-param-label">Node Color</div>
                <div class="td-param-control" style="display: flex; gap: 6px; align-items: center;">
                    <input type="color" class="td-param-color" id="prop-color-picker" value="${currentColor}" style="width: 32px; height: 24px; padding: 0; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; background: transparent;" />
                    <input type="text" class="td-param-input" id="prop-color-hex" value="${currentColor}" style="flex: 1;" />
                </div>
            </div>

            <div class="td-param-row" style="margin-top: 6px;">
                <div class="td-param-label">Color Presets</div>
                <div class="td-param-control" style="display: flex; gap: 4px; flex-wrap: wrap;">
                    ${colorSwatches.map(c => `
                        <button type="button" class="swatch-btn" data-color="${c}" style="width: 18px; height: 18px; border-radius: 3px; border: 1px solid #cbd5e1; background-color: ${c}; cursor: pointer; padding: 0;"></button>
                    `).join('')}
                </div>
            </div>

            <div class="td-param-row" style="margin-top: 10px;">
                <div class="td-param-label">Node Icon</div>
                <div class="td-param-control" style="display: flex; gap: 4px; flex-wrap: wrap;">
                    ${NEON_ICONS.map(icon => `
                            <button type="button" class="icon-preset-btn" data-icon="${icon.id}" title="${icon.label}" aria-label="${icon.label}" style="width: 28px; height: 28px; border-radius: 4px; border: 1px solid ${currentIcon === icon.id ? currentColor : '#334155'}; background: #07111f; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;">
                                <canvas width="24" height="24" data-neon-icon="${icon.id}" style="width: 20px; height: 20px; background: transparent !important;"></canvas>
                            </button>
                        `).join('')}
                </div>
            </div>

            <div class="td-param-row" style="margin-top: 10px;">
                <div class="td-param-label">Node Shape</div>
                <div class="td-param-control" style="display: flex; gap: 5px; flex-wrap: wrap;">
                    ${NODE_SHAPES.map(shape => `
                        <button type="button" class="shape-preset-btn" data-shape="${shape}" title="${shape}" aria-label="${shape}" style="width: 30px; height: 30px; border-radius: 4px; border: 1px solid ${currentShape === shape ? currentColor : '#cbd5e1'}; background: #07111f; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;">
                            <canvas width="24" height="24" data-node-shape="${shape}" style="width: 22px; height: 22px; background: transparent !important;"></canvas>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        styleControls.querySelectorAll<HTMLCanvasElement>('[data-neon-icon]').forEach(canvas => {
            const ctx = canvas.getContext('2d');
            if (ctx) drawNeonIcon(ctx, canvas.dataset.neonIcon, 12, 12, 17, '#f8fafc');
        });
        styleControls.querySelectorAll<HTMLCanvasElement>('[data-node-shape]').forEach(canvas => {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            traceNodeShape(ctx, canvas.dataset.nodeShape as NodeShape, 3, 3, 18);
            ctx.strokeStyle = currentColor;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });

        const applyColor = (hex: string) => {
            node.updateProperty('color', hex);
            node.color = hex;
            node.bgcolor = hex;
            node.setDirtyCanvas(true, true);
        };

        const applyIcon = (ic: string) => {
            node.updateProperty('icon', ic);
            node.setDirtyCanvas(true, true);
        };

        const applyShape = (shape: string) => {
            node.updateProperty('shape', shape);
            node.setDirtyCanvas(true, true);
        };

        styleControls.querySelector('#prop-color-picker')?.addEventListener('input', (e) => applyColor((e.target as HTMLInputElement).value));
        styleControls.querySelector('#prop-color-hex')?.addEventListener('change', (e) => applyColor((e.target as HTMLInputElement).value));
        styleControls.querySelectorAll('.swatch-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const color = (e.currentTarget as HTMLElement).getAttribute('data-color');
                if (color) applyColor(color);
            });
        });
        styleControls.querySelectorAll('.icon-preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const icon = (e.currentTarget as HTMLElement).getAttribute('data-icon');
                if (icon) applyIcon(icon);
            });
        });
        styleControls.querySelectorAll('.shape-preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const shape = (e.currentTarget as HTMLElement).getAttribute('data-shape');
                if (shape) applyShape(shape);
            });
        });

        container.appendChild(styleControls);
    }
}
