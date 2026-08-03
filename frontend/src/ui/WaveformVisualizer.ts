export interface WaveformVisualizerOptions {
    container?: HTMLElement;
    cropStart?: number;
    cropEnd?: number;
    onCropChange?: (start: number, end: number) => void;
    waveformColor?: string;
    backgroundColor?: string;
    overlayColor?: string;
    handleColor?: string;
}

export class WaveformVisualizer {
    private container: HTMLElement | null = null;
    private wrapperEl: HTMLElement;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private audioBuffer: AudioBuffer | null = null;
    private audioContext: AudioContext | null = null;
    private previewSource: AudioBufferSourceNode | null = null;
    private previewStartTime: number = 0;
    private previewDuration: number = 0;
    private isPlayingPreview: boolean = false;
    private animFrameId: number | null = null;

    private cropStart: number = 0.0;
    private cropEnd: number = 1.0;
    private onCropChange?: (start: number, end: number) => void;

    // Viewport Zoom & Pan state
    private viewStart: number = 0.0;
    private viewEnd: number = 1.0;
    private static readonly MIN_VIEW_WIDTH = 0.0005;

    // Visual configuration
    private waveformColor: string = "#10b981";
    private backgroundColor: string = "#0f172a";
    private overlayColor: string = "rgba(15, 23, 42, 0.65)";
    private handleColor: string = "#38bdf8";

    // Drag state
    private activeDrag: 'start' | 'end' | 'scroll' | 'box-zoom' | null = null;
    private dragStartX: number = 0;
    private dragStartViewS: number = 0;
    private dragStartViewE: number = 0;
    private boxZoomStartX: number = 0;
    private boxZoomCurrentX: number = 0;
    private hoverState: 'start' | 'end' | 'scroll' | null = null;

    private resizeObserver: ResizeObserver | null = null;

    constructor(options: WaveformVisualizerOptions = {}) {
        this.cropStart = options.cropStart !== undefined ? Math.max(0, Math.min(1, options.cropStart)) : 0.0;
        this.cropEnd = options.cropEnd !== undefined ? Math.max(0, Math.min(1, options.cropEnd)) : 1.0;
        this.onCropChange = options.onCropChange;

        if (options.waveformColor) this.waveformColor = options.waveformColor;
        if (options.backgroundColor) this.backgroundColor = options.backgroundColor;
        if (options.overlayColor) this.overlayColor = options.overlayColor;
        if (options.handleColor) this.handleColor = options.handleColor;

        // Build minimal DOM structure
        this.wrapperEl = document.createElement('div');
        this.wrapperEl.className = 'waveform-visualizer-wrapper';

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'waveform-visualizer-canvas';
        this.wrapperEl.appendChild(this.canvas);

        const context = this.canvas.getContext('2d');
        if (!context) {
            throw new Error("Could not get 2D rendering context for WaveformVisualizer canvas");
        }
        this.ctx = context;

        this.bindEvents();

        if (options.container) {
            this.mount(options.container);
        }
    }

    public mount(container: HTMLElement) {
        this.container = container;
        this.container.appendChild(this.wrapperEl);

        this.resizeObserver = new ResizeObserver(() => {
            this.resizeCanvas();
            this.draw();
        });
        this.resizeObserver.observe(this.wrapperEl);

        this.resizeCanvas();
        this.draw();
    }

    public destroy() {
        this.stopPreview();
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.wrapperEl.parentElement) {
            this.wrapperEl.parentElement.removeChild(this.wrapperEl);
        }
        this.container = null;
    }

    // Viewport control methods
    public setViewRange(start: number, end: number) {
        let s = Math.max(0, Math.min(1, start));
        let e = Math.max(0, Math.min(1, end));

        if (e - s < WaveformVisualizer.MIN_VIEW_WIDTH) {
            const mid = (s + e) / 2;
            s = Math.max(0, mid - WaveformVisualizer.MIN_VIEW_WIDTH / 2);
            e = Math.min(1, s + WaveformVisualizer.MIN_VIEW_WIDTH);
        }

        this.viewStart = s;
        this.viewEnd = e;
        this.draw();
    }

    public getViewRange(): { start: number; end: number } {
        return { start: this.viewStart, end: this.viewEnd };
    }

    public resetView() {
        this.setViewRange(0.0, 1.0);
    }

    public zoomIn(factor: number = 0.75, centerNorm?: number) {
        const currentWidth = this.viewEnd - this.viewStart;
        const center = centerNorm !== undefined ? centerNorm : (this.viewStart + this.viewEnd) / 2;
        const newWidth = Math.max(WaveformVisualizer.MIN_VIEW_WIDTH, currentWidth * factor);

        let newStart = center - (center - this.viewStart) * factor;
        let newEnd = newStart + newWidth;

        if (newStart < 0) {
            newStart = 0;
            newEnd = newWidth;
        }
        if (newEnd > 1) {
            newEnd = 1;
            newStart = 1 - newWidth;
        }
        this.setViewRange(newStart, newEnd);
    }

    public zoomOut(factor: number = 1.33, centerNorm?: number) {
        this.zoomIn(factor, centerNorm);
    }

    private canvasToNorm(x: number): number {
        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.width / dpr;
        if (width <= 0) return 0;
        const viewWidth = this.viewEnd - this.viewStart;
        return Math.max(0, Math.min(1, this.viewStart + (x / width) * viewWidth));
    }

    private normToCanvas(norm: number): number {
        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.width / dpr;
        const viewWidth = this.viewEnd - this.viewStart;
        if (viewWidth <= 0) return 0;
        return ((norm - this.viewStart) / viewWidth) * width;
    }

    public async loadAudio(source: string | AudioBuffer | ArrayBuffer): Promise<void> {
        this.stopPreview();
        this.showLoadingState();

        try {
            if (source instanceof AudioBuffer) {
                this.audioBuffer = source;
            } else {
                if (!this.audioContext) {
                    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
                    this.audioContext = new AudioCtx();
                }

                let arrayBuffer: ArrayBuffer;
                if (typeof source === 'string') {
                    let fetchUrl = source;
                    if (!source.startsWith('http') && !source.startsWith('/api') && !source.startsWith('/assets')) {
                        fetchUrl = `/api/audio/file?filepath=${encodeURIComponent(source)}`;
                    }
                    const resp = await fetch(fetchUrl);
                    if (!resp.ok) {
                        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
                    }
                    arrayBuffer = await resp.arrayBuffer();
                } else {
                    arrayBuffer = source;
                }

                this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            }
            this.draw();
        } catch (err) {
            console.error("WaveformVisualizer: Failed to load audio", err);
            this.showErrorState("Failed to load audio waveform");
        }
    }

    public setCrop(start: number, end: number, silent: boolean = false) {
        let s = Math.max(0, Math.min(1, start));
        let e = Math.max(0, Math.min(1, end));
        if (s >= e) {
            if (s >= 0.99) {
                s = e - 0.01;
            } else {
                e = s + 0.01;
            }
        }
        this.cropStart = Math.max(0, s);
        this.cropEnd = Math.min(1, e);

        this.draw();

        if (!silent && this.onCropChange) {
            this.onCropChange(this.cropStart, this.cropEnd);
        }
    }

    public getCrop(): { start: number; end: number } {
        return { start: this.cropStart, end: this.cropEnd };
    }

    public getDuration(): number {
        return this.audioBuffer ? this.audioBuffer.duration : 0;
    }

    public playPreview() {
        if (!this.audioBuffer) return;
        this.stopPreview();

        if (!this.audioContext) {
            const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
            this.audioContext = new AudioCtx();
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        const duration = this.audioBuffer.duration;
        const startTimeSec = this.cropStart * duration;
        const endTimeSec = this.cropEnd * duration;
        const playDuration = Math.max(0.05, endTimeSec - startTimeSec);

        this.previewSource = this.audioContext.createBufferSource();
        this.previewSource.buffer = this.audioBuffer;
        this.previewSource.connect(this.audioContext.destination);

        this.previewSource.start(0, startTimeSec, playDuration);
        this.previewStartTime = this.audioContext.currentTime;
        this.previewDuration = playDuration;
        this.isPlayingPreview = true;

        this.previewSource.onended = () => {
            this.isPlayingPreview = false;
            this.draw();
        };

        this.animatePlayhead();
    }

    public stopPreview() {
        if (this.previewSource) {
            try {
                this.previewSource.stop();
                this.previewSource.disconnect();
            } catch (_) {}
            this.previewSource = null;
        }
        this.isPlayingPreview = false;
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        this.draw();
    }

    private animatePlayhead() {
        if (!this.isPlayingPreview || !this.audioContext) return;
        this.draw();
        this.animFrameId = requestAnimationFrame(() => this.animatePlayhead());
    }

    private resizeCanvas() {
        const rect = this.wrapperEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.floor(rect.width * dpr);
        this.canvas.height = Math.floor(rect.height * dpr);
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
    }

    private showLoadingState() {
        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.width / dpr;
        const height = this.canvas.height / dpr;

        this.ctx.save();
        this.ctx.scale(dpr, dpr);
        this.ctx.fillStyle = this.backgroundColor;
        this.ctx.fillRect(0, 0, width, height);

        this.ctx.fillStyle = "#94a3b8";
        this.ctx.font = "11px Inter, sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText("Loading Audio Waveform...", width / 2, height / 2);
        this.ctx.restore();
    }

    private showErrorState(message: string) {
        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.width / dpr;
        const height = this.canvas.height / dpr;

        this.ctx.save();
        this.ctx.scale(dpr, dpr);
        this.ctx.fillStyle = this.backgroundColor;
        this.ctx.fillRect(0, 0, width, height);

        this.ctx.fillStyle = "#ef4444";
        this.ctx.font = "11px Inter, sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(message, width / 2, height / 2);
        this.ctx.restore();
    }

    public draw() {
        if (!this.canvas || !this.ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.width / dpr;
        const height = this.canvas.height / dpr;

        if (width <= 0 || height <= 0) return;

        this.ctx.save();
        this.ctx.scale(dpr, dpr);

        // 1. Draw Background
        this.ctx.fillStyle = this.backgroundColor;
        this.ctx.fillRect(0, 0, width, height);

        const topMargin = 18;
        const bottomMargin = 6;
        const mainH = Math.max(10, height - topMargin - bottomMargin);
        const centerY = topMargin + mainH / 2;

        // 2. Grid lines & Center horizontal line
        const gridCols = 8;
        this.ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        this.ctx.lineWidth = 1;

        for (let i = 1; i < gridCols; i++) {
            const gx = Math.floor((width / gridCols) * i);
            this.ctx.beginPath();
            this.ctx.moveTo(gx, topMargin);
            this.ctx.lineTo(gx, height - bottomMargin);
            this.ctx.stroke();
        }

        this.ctx.beginPath();
        this.ctx.moveTo(0, centerY);
        this.ctx.lineTo(width, centerY);
        this.ctx.stroke();

        // 3. Waveform Peaks for visible slice
        if (this.audioBuffer) {
            const rawData = this.audioBuffer.getChannelData(0);
            const totalSamples = rawData.length;

            const startSample = Math.floor(this.viewStart * totalSamples);
            const endSample = Math.min(totalSamples, Math.ceil(this.viewEnd * totalSamples));
            const visibleSamples = Math.max(1, endSample - startSample);

            const barWidth = 2;
            const barGap = 1;
            const step = barWidth + barGap;
            const numBars = Math.floor(width / step);
            const samplesPerBar = Math.max(1, Math.floor(visibleSamples / numBars));
            const maxAmplitudeHeight = (mainH / 2) * 0.85;

            const grad = this.ctx.createLinearGradient(0, topMargin, 0, height - bottomMargin);
            grad.addColorStop(0, '#34d399');
            grad.addColorStop(0.5, this.waveformColor);
            grad.addColorStop(1, '#059669');

            this.ctx.fillStyle = grad;

            for (let i = 0; i < numBars; i++) {
                const sIdx = startSample + Math.floor(i * (visibleSamples / numBars));
                let min = 1.0;
                let max = -1.0;
                const sampleStep = Math.max(1, Math.floor(samplesPerBar / 4));

                for (let j = 0; j < samplesPerBar; j += sampleStep) {
                    const val = rawData[sIdx + j] || 0;
                    if (val < min) min = val;
                    if (val > max) max = val;
                }

                const amp = Math.max(Math.abs(min), Math.abs(max));
                const barHeight = Math.max(2, amp * maxAmplitudeHeight * 2);
                const x = i * step;

                this.ctx.fillRect(x, centerY - barHeight / 2, barWidth, barHeight);
            }
        } else {
            this.ctx.fillStyle = "rgba(16, 185, 129, 0.4)";
            this.ctx.font = "10px Inter, sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.fillText("No Audio Loaded", width / 2, centerY + 3);
        }

        // 4. Crop Overlay Shading
        const cropX1 = Math.floor(this.normToCanvas(this.cropStart));
        const cropX2 = Math.floor(this.normToCanvas(this.cropEnd));

        this.ctx.fillStyle = this.overlayColor;
        if (cropX1 > 0) {
            this.ctx.fillRect(0, topMargin, Math.min(width, cropX1), height - topMargin - bottomMargin);
        }
        if (cropX2 < width) {
            const rx = Math.max(0, cropX2);
            this.ctx.fillRect(rx, topMargin, Math.max(0, width - rx), height - topMargin - bottomMargin);
        }

        // Active crop region border glow
        this.ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
        this.ctx.lineWidth = 1;
        const bx1 = Math.max(0, cropX1);
        const bx2 = Math.min(width, cropX2);
        if (bx2 > bx1) {
            this.ctx.strokeRect(bx1, topMargin, bx2 - bx1, height - topMargin - bottomMargin);
        }

        // 5. Crop Handles
        if (cropX1 >= -20 && cropX1 <= width + 20) {
            this.drawHandle(cropX1, height, 'Start', this.hoverState === 'start' || this.activeDrag === 'start');
        }
        if (cropX2 >= -20 && cropX2 <= width + 20) {
            this.drawHandle(cropX2, height, 'End', this.hoverState === 'end' || this.activeDrag === 'end');
        }

        // 6. Playhead
        if (this.isPlayingPreview && this.audioContext && this.audioBuffer) {
            const elapsed = this.audioContext.currentTime - this.previewStartTime;
            const progressRatio = Math.min(1, Math.max(0, elapsed / this.previewDuration));
            const playheadNorm = this.cropStart + progressRatio * (this.cropEnd - this.cropStart);
            const playheadX = this.normToCanvas(playheadNorm);

            if (playheadX >= 0 && playheadX <= width) {
                this.ctx.strokeStyle = "#f43f5e";
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();
                this.ctx.moveTo(playheadX, topMargin);
                this.ctx.lineTo(playheadX, height - bottomMargin);
                this.ctx.stroke();

                this.ctx.fillStyle = "#f43f5e";
                this.ctx.beginPath();
                this.ctx.arc(playheadX, topMargin / 2, 4, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }

        // 7. Box Zoom Selection Box
        if (this.activeDrag === 'box-zoom') {
            const zx1 = Math.min(this.boxZoomStartX, this.boxZoomCurrentX);
            const zx2 = Math.max(this.boxZoomStartX, this.boxZoomCurrentX);

            this.ctx.fillStyle = "rgba(56, 189, 248, 0.25)";
            this.ctx.fillRect(zx1, topMargin, zx2 - zx1, height - topMargin - bottomMargin);

            this.ctx.strokeStyle = "#38bdf8";
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([4, 4]);
            this.ctx.strokeRect(zx1, topMargin, zx2 - zx1, height - topMargin - bottomMargin);
            this.ctx.setLineDash([]);
        }

        this.ctx.restore();
    }

    private drawHandle(x: number, canvasHeight: number, label: string, isHighlighted: boolean) {
        const color = isHighlighted ? "#60a5fa" : this.handleColor;

        // Vertical line
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, canvasHeight);
        this.ctx.stroke();

        // Handle cap flag at top
        const capWidth = 14;
        const capHeight = 16;
        let capX = label === 'Start' ? x : x - capWidth;
        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.width / dpr;
        capX = Math.max(0, Math.min(width - capWidth, capX));

        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        if (typeof this.ctx.roundRect === 'function') {
            this.ctx.roundRect(capX, 0, capWidth, capHeight, 3);
        } else {
            this.ctx.rect(capX, 0, capWidth, capHeight);
        }
        this.ctx.fill();

        // Handle label text
        this.ctx.fillStyle = "#0f172a";
        this.ctx.font = "bold 9px Inter, monospace";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(label === 'Start' ? 'S' : 'E', capX + capWidth / 2, capHeight / 2);
    }

    private bindEvents() {
        const getCanvasPos = (e: MouseEvent | PointerEvent) => {
            const rect = this.canvas.getBoundingClientRect();
            return {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                width: rect.width,
                height: rect.height
            };
        };

        const detectTarget = (x: number): 'start' | 'end' | 'scroll' => {
            const cropX1 = this.normToCanvas(this.cropStart);
            const cropX2 = this.normToCanvas(this.cropEnd);
            const threshold = 10;

            if (Math.abs(x - cropX1) <= threshold) return 'start';
            if (Math.abs(x - cropX2) <= threshold) return 'end';
            return 'scroll';
        };

        // Mouse Wheel: Horizontal Zoom centered at cursor
        this.canvas.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const pos = getCanvasPos(e);
            const cursorNorm = this.canvasToNorm(pos.x);

            const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
            this.zoomIn(zoomFactor, cursorNorm);
        }, { passive: false });

        // Double Click: Reset Zoom
        this.canvas.addEventListener('dblclick', () => {
            this.resetView();
        });

        this.canvas.addEventListener('pointermove', (e: PointerEvent) => {
            const pos = getCanvasPos(e);

            if (!this.activeDrag) {
                const target = detectTarget(pos.x);
                if (target !== this.hoverState) {
                    this.hoverState = target;
                    this.draw();
                }

                if (target === 'start' || target === 'end') {
                    this.canvas.style.cursor = 'col-resize';
                } else {
                    this.canvas.style.cursor = e.shiftKey ? 'crosshair' : 'grab';
                }
            } else {
                if (this.activeDrag === 'scroll') {
                    const dxCanvas = e.clientX - this.dragStartX;
                    const viewW = this.dragStartViewE - this.dragStartViewS;
                    const dxNorm = (dxCanvas / pos.width) * viewW;
                    let newS = this.dragStartViewS - dxNorm;
                    let newE = newS + viewW;

                    if (newS < 0) { newS = 0; newE = viewW; }
                    if (newE > 1) { newE = 1; newS = 1 - viewW; }
                    this.setViewRange(newS, newE);
                } else if (this.activeDrag === 'box-zoom') {
                    this.boxZoomCurrentX = pos.x;
                    this.draw();
                } else if (this.activeDrag === 'start') {
                    const normX = this.canvasToNorm(pos.x);
                    const newStart = Math.min(normX, this.cropEnd - 0.001);
                    this.setCrop(newStart, this.cropEnd);
                } else if (this.activeDrag === 'end') {
                    const normX = this.canvasToNorm(pos.x);
                    const newEnd = Math.max(normX, this.cropStart + 0.001);
                    this.setCrop(this.cropStart, newEnd);
                }
            }
        });

        this.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0 && e.button !== 2) return;
            const pos = getCanvasPos(e);
            const target = detectTarget(pos.x);

            this.dragStartX = e.clientX;
            this.dragStartViewS = this.viewStart;
            this.dragStartViewE = this.viewEnd;

            if (e.shiftKey || e.button === 2) {
                this.activeDrag = 'box-zoom';
                this.boxZoomStartX = pos.x;
                this.boxZoomCurrentX = pos.x;
            } else if (target === 'start' || target === 'end') {
                this.activeDrag = target;
            } else {
                this.activeDrag = 'scroll';
                this.canvas.style.cursor = 'grabbing';
            }

            try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
            this.draw();
            e.preventDefault();
        });

        const stopDrag = (e: PointerEvent) => {
            if (this.activeDrag) {
                if (this.activeDrag === 'box-zoom') {
                    const x1 = Math.min(this.boxZoomStartX, this.boxZoomCurrentX);
                    const x2 = Math.max(this.boxZoomStartX, this.boxZoomCurrentX);
                    if (x2 - x1 > 8) {
                        const norm1 = this.canvasToNorm(x1);
                        const norm2 = this.canvasToNorm(x2);
                        this.setViewRange(norm1, norm2);
                    }
                }

                this.activeDrag = null;
                try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
                this.draw();
            }
        };

        this.canvas.addEventListener('pointerup', stopDrag);
        this.canvas.addEventListener('pointercancel', stopDrag);
        this.canvas.addEventListener('mouseleave', () => {
            if (!this.activeDrag) {
                this.hoverState = null;
                this.draw();
            }
        });

        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
}


