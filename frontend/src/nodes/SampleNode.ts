import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';

export class SampleNode extends BaseNode {
    constructor() {
        super();
        this.title = "Sample";
        this.size = [64, 64];
        
        // Leaf node visual style (Emerald)
        this.color = "#10b981";
        this.bgcolor = "#10b981";
        this.boxcolor = "#059669";
        
        this.properties = {
            node_name: "New Sample",
            filepath: "",
            sample_type: "loop",
            start_beat: 0,
            original_bpm: 120,
            target_bpm: 120,
            bpm: 120,
            key: "",
            crop_start: 0.0,
            crop_end: 1.0,
            color: "#10b981",
            icon: "🎵"
        };
        
        this.addOutput("Audio", "audio");
    }
}

(SampleNode as any).title = "Sample";
LiteGraph.registerNodeType("Audio/Sample", SampleNode);
