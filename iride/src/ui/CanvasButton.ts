import { LGraphNode } from 'litegraph.js';

export class CanvasButton {
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    color: string;
    hoverColor: string;
    isHovered: boolean = false;
    onClick: (e?: MouseEvent) => void;

    constructor(
        x: number,
        y: number,
        width: number,
        height: number,
        label: string,
        color: string,
        hoverColor: string,
        onClick: (e?: MouseEvent) => void
    ) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.label = label;
        this.color = color;
        this.hoverColor = hoverColor;
        this.onClick = onClick;
    }

    draw(ctx: CanvasRenderingContext2D, node: LGraphNode) {
        ctx.fillStyle = this.isHovered ? this.hoverColor : this.color;
        
        // Handle negative x/y as right/bottom offsets
        const finalX = this.x < 0 ? node.size[0] + this.x : this.x;
        const finalY = this.y < 0 ? node.size[1] + this.y : this.y;

        const radius = 3;
        ctx.beginPath();
        if ((ctx as any).roundRect) {
            (ctx as any).roundRect(finalX, finalY, this.width, this.height, radius);
        } else {
            ctx.rect(finalX, finalY, this.width, this.height);
        }
        ctx.fill();
        
        ctx.fillStyle = "white";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 11px sans-serif";
        
        ctx.fillText(this.label, finalX + this.width / 2, finalY + this.height / 2 + 1);
    }

    checkHit(local_x: number, local_y: number, node: LGraphNode): boolean {
        const finalX = this.x < 0 ? node.size[0] + this.x : this.x;
        const finalY = this.y < 0 ? node.size[1] + this.y : this.y;

        return (
            local_x >= finalX &&
            local_x <= finalX + this.width &&
            local_y >= finalY &&
            local_y <= finalY + this.height
        );
    }
}
