/**
 * Clean 2D canvas drawing helpers for IRIDE visualizations.
 */

export function drawRoundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number | number[] = 4
): void {
    ctx.beginPath();
    const rawR = typeof radius === 'number' ? radius : (radius[0] || 0);
    const maxR = Math.max(0, Math.min(width / 2, height / 2));
    const r = Math.max(0, Math.min(rawR, maxR));
    if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(x, y, width, height, r);
    } else {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x + r, y);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}

export function drawPlayhead(
    ctx: CanvasRenderingContext2D,
    x: number,
    topY: number,
    bottomY: number,
    color = '#38bdf8'
): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, bottomY);
    ctx.stroke();

    // Top indicator beacon
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, topY + 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}
