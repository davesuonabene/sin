import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';

export class TrackNode extends BaseNode {
    constructor() {
        super();
        this.title = "Track";
        this.size = [200, 44];
        
        // Indigo theme for container track
        this.color = "#4f46e5";
        this.bgcolor = "#4f46e5";
        this.boxcolor = "#4338ca";
        
        this.properties = {
            node_name: "Master Track",
            mix_mode: "sum",
            bpm: 120
        };
        
        this.addInput("Input", "audio", { multiple: true } as any);
        this.addOutput("Audio", "audio");
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
