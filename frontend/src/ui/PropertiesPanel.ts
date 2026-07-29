import { LGraphNode } from 'litegraph.js';

export function renderProperties(node: LGraphNode, container: HTMLElement, onCloseCallback: () => void) {
    container.innerHTML = `
        <div style="padding: 15px; font-family: sans-serif; color: #333; background: #e0f2fe; height: 100%; box-sizing: border-box; position: relative;">
            <button id="close-btn" style="position: absolute; top: 12px; left: 12px; width: 28px; height: 28px; border-radius: 50%; background: #1f0d01; color: #e0f2fe; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; z-index: 10;">X</button>
            <h3 style="margin-top: 0; display: flex; justify-content: center; align-items: center; border-bottom: 1px solid #bae6fd; padding-bottom: 10px; padding-top: 4px;">
                <span id="title-display" style="font-size: 16px;">${node.properties.node_name || 'Properties'}</span>
            </h3>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Name</label>
                <input type="text" id="prop-name" value="${node.properties.node_name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Original BPM</label>
                <input type="number" id="prop-bpm" value="${node.properties.original_bpm || 120}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Start Beat</label>
                <input type="number" id="prop-start" value="${node.properties.start_beat || 0}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
            </div>
            
            <div style="margin-top: 25px;">
                <label style="display: block; font-size: 12px; color: #666; margin-bottom: 8px;">Preview</label>
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

    const bpmInput = container.querySelector('#prop-bpm') as HTMLInputElement;
    bpmInput.addEventListener('change', (e) => {
        const val = parseFloat((e.target as HTMLInputElement).value);
        node.properties.original_bpm = val;
        updateTrackNode('original_bpm', val);
    });

    const startInput = container.querySelector('#prop-start') as HTMLInputElement;
    startInput.addEventListener('change', (e) => {
        const val = parseFloat((e.target as HTMLInputElement).value);
        node.properties.start_beat = val;
        updateTrackNode('start_beat', val);
    });
}
