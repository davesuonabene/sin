import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';

export class SequenceNode extends BaseNode {
    constructor() {
        super();
        this.title = "Sequence";
        this.size = [200, 44];
        
        // Vibrant Pink / Magenta theme for Sequence loop generator
        this.color = "#ec4899";
        this.bgcolor = "#ec4899";
        this.boxcolor = "#db2777";
        
        this.properties = {
            node_name: "Sequence",
            node_type: "sequence",
            sequence: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_length: 0.25
        };
        
        this.addInput("Sample", "audio");
        this.addOutput("Audio", "audio");
    }
}

(SequenceNode as any).title = "Sequence";
LiteGraph.registerNodeType("Audio/Sequence", SequenceNode);
