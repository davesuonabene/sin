import { LGraphNode } from 'litegraph.js';

export function renderProperties(node: LGraphNode, container: HTMLElement, onCloseCallback: () => void) {
    const trackNodes = (window as any).trackNodes;
    const isConnected = trackNodes?.get(node.id)?.parentId != null;
    const targetBpm = node.properties.target_bpm || node.properties.bpm || 120;

    container.innerHTML = `
        <div style="padding: 15px; font-family: Inter, system-ui, sans-serif; color: #1e293b; background: #ffffff; height: 100%; box-sizing: border-box; position: relative; border: 1px solid #e2e8f0;">
            <button id="close-btn" style="position: absolute; top: 12px; left: 12px; width: 24px; height: 24px; border-radius: 4px; background: #f1f5f9; color: #64748b; border: 1px solid #cbd5e1; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; z-index: 10;">✕</button>
            <h3 style="margin-top: 0; display: flex; justify-content: center; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px; padding-top: 4px; color: #0f172a;">
                <span id="title-display" style="font-size: 14px; font-weight: 600;">${node.properties.node_name || 'Properties'}</span>
            </h3>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 11px; color: #475569; margin-bottom: 4px;">Name</label>
                <input type="text" id="prop-name" value="${node.properties.node_name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #0f172a;" />
            </div>

            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 11px; color: #475569; margin-bottom: 4px;">Key</label>
                <input type="text" id="prop-key" value="${node.properties.key || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #0f172a;" />
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 11px; color: #475569; margin-bottom: 4px;">Original BPM</label>
                <input type="number" id="prop-orig-bpm" value="${node.properties.original_bpm || 120}" title="Original BPM of the audio sample" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #0f172a;" />
            </div>

            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 11px; color: #475569; margin-bottom: 4px;">Target BPM ${isConnected ? '<span style="color: #0284c7; font-weight: bold;">(Inherited)</span>' : ''}</label>
                <input type="number" id="prop-target-bpm" value="${targetBpm}" ${isConnected ? 'disabled' : ''} style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #0f172a;" />
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 11px; color: #475569; margin-bottom: 4px;">Start Beat</label>
                <input type="number" id="prop-start" value="${node.properties.start_beat || 0}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #0f172a;" />
            </div>
            
            <div style="margin-top: 25px;">
                <label style="display: block; font-size: 11px; color: #475569; margin-bottom: 8px;">Preview</label>
                <audio controls src="/assets/${node.properties.filepath || ''}" style="width: 100%;"></audio>
            </div>
        </div>
    `;

    // Hook up events
    const closeBtn = container.querySelector('#close-btn') as HTMLButtonElement;
    closeBtn.addEventListener('click', onCloseCallback);

    const titleDisplay = container.querySelector('#title-display') as HTMLSpanElement;

    const updateTrackNode = (prop: string, val: any) => {
        const trackNodes = (window as any).trackNodes;
        if (!trackNodes) return;
        const data = trackNodes.get(node.id);
        if (data) {
            data[prop] = val;
        }
    };

    const nameInput = container.querySelector('#prop-name') as HTMLInputElement;
    nameInput.addEventListener('change', (e) => {
        const val = (e.target as HTMLInputElement).value;
        node.properties.node_name = val;
        node.title = val;
        if (typeof (node as any).computeSize === 'function') {
            node.size = (node as any).computeSize();
        }
        titleDisplay.innerText = val;
        node.setDirtyCanvas(true, true);
        
        updateTrackNode('name', val);
    });

    const keyInput = container.querySelector('#prop-key') as HTMLInputElement;
    if (keyInput) {
        keyInput.addEventListener('change', async (e) => {
            const val = (e.target as HTMLInputElement).value;
            const previousValue = node.properties.key;
            const editableNode = node as any;
            if (editableNode.preparePropertyEdit?.('key', val, previousValue) === false) {
                keyInput.value = previousValue || '';
                return;
            }
            editableNode.updateProperty?.('key', val);
            if (!editableNode.updateProperty) node.properties.key = val;
            await editableNode.onPropertyEdited?.('key', val, previousValue);
            updateTrackNode('key', val);
        });
    }

    const origBpmInput = container.querySelector('#prop-orig-bpm') as HTMLInputElement;
    if (origBpmInput) {
        origBpmInput.addEventListener('change', async (e) => {
            const oldBpm = node.properties.original_bpm || 120;
            const newBpm = parseFloat((e.target as HTMLInputElement).value);
            if (isNaN(newBpm) || newBpm <= 0 || newBpm === oldBpm) {
                origBpmInput.value = oldBpm.toString();
                return;
            }

            const editableNode = node as any;
            if (editableNode.preparePropertyEdit?.('original_bpm', newBpm, oldBpm) !== false) {
                editableNode.updateProperty?.('original_bpm', newBpm);
                if (!editableNode.updateProperty) node.properties.original_bpm = newBpm;
                updateTrackNode('original_bpm', newBpm);
                await editableNode.onPropertyEdited?.('original_bpm', newBpm, oldBpm);
            } else {
                origBpmInput.value = oldBpm.toString();
            }
        });
    }

    const targetBpmInput = container.querySelector('#prop-target-bpm') as HTMLInputElement;
    if (targetBpmInput) {
        targetBpmInput.addEventListener('change', (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            (node as any).updateProperty?.('target_bpm', val);
            (node as any).updateProperty?.('bpm', val);
            if (!(node as any).updateProperty) {
                node.properties.target_bpm = val;
                node.properties.bpm = val;
                updateTrackNode('target_bpm', val);
                updateTrackNode('bpm', val);
            }
        });
    }

    const startInput = container.querySelector('#prop-start') as HTMLInputElement;
    startInput.addEventListener('change', (e) => {
        const val = parseFloat((e.target as HTMLInputElement).value);
        node.properties.start_beat = val;
        updateTrackNode('start_beat', val);
    });
}
