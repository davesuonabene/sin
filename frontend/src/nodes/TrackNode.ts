import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';

export class TrackNode extends BaseNode {
    constructor() {
        super();
        this.title = "Track";
        this.size = [64, 64];
        
        // Indigo theme for container track
        this.color = "#4f46e5";
        this.bgcolor = "#4f46e5";
        this.boxcolor = "#4338ca";
        
        this.properties = {
            node_name: "Master Track",
            mix_mode: "sum",
            bpm: 120,
            color: "#4f46e5",
            icon: "🎛️"
        };
        
        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }
}

(TrackNode as any).title = "Track";
LiteGraph.registerNodeType("Audio/Track", TrackNode);
