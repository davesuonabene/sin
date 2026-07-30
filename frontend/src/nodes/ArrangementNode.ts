import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';

export class ArrangementNode extends BaseNode {
    constructor() {
        super();
        this.title = "Arrangement";
        this.size = [200, 44];
        
        // Distinct amber/orange style for arrangement nodes
        this.color = "#f59e0b";
        this.bgcolor = "#f59e0b";
        this.boxcolor = "#d97706";
        
        this.properties = {
            node_name: "Arrangement",
            node_type: "arrangement",
            total_bars: 4.0,
            probability: 1.0,
            seed: Math.random(),
            start_beat: 0
        };
        
        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }
}

(ArrangementNode as any).title = "Arrangement";
LiteGraph.registerNodeType("Audio/Arrangement", ArrangementNode);
