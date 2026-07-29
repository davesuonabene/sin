import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';

export class SampleNode extends BaseNode {
    constructor() {
        super();
        this.title = "Sample";
        this.size = [200, 44];
        
        // Leaf node visual style (Emerald)
        this.color = "#10b981";
        this.bgcolor = "#10b981";
        this.boxcolor = "#059669";
        
        this.properties = {
            node_name: "New Sample",
            filepath: "",
            start_beat: 0,
            original_bpm: 120
        };
        
        this.addOutput("Audio", "audio");
    }
}

(SampleNode as any).title = "Sample";
LiteGraph.registerNodeType("Audio/Sample", SampleNode);
