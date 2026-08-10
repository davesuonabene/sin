export class MasterWaveform {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private audioContext: AudioContext | null = null;
    private audioBuffer: AudioBuffer | null = null;
    private progress = 0;
    private currentTime = 0;
    private knownDuration = 0;
    private hoverProgress: number | null = null;
    private isSeeking = false;
    private message = 'Ready to render';
    private loadToken = 0;
    private readonly onSeek: (progress: number) => void;

    constructor(container: HTMLElement, onSeek: (progress: number) => void) {
        this.onSeek = onSeek;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'master-waveform-canvas';
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('role', 'slider');
        this.canvas.setAttribute('aria-label', 'Audio timeline');
        this.canvas.setAttribute('aria-valuemin', '0');
        container.appendChild(this.canvas);

        const context = this.canvas.getContext('2d');
        if (!context) throw new Error('Could not create master waveform canvas');
        this.ctx = context;

        new ResizeObserver(() => this.draw()).observe(container);
        this.canvas.addEventListener('pointerdown', (event) => {
            if (this.duration <= 0) return;
            event.preventDefault();
            this.isSeeking = true;
            this.canvas.focus();
            this.canvas.setPointerCapture(event.pointerId);
            this.seekFromPointer(event);
        });
        this.canvas.addEventListener('pointermove', (event) => {
            this.hoverProgress = this.progressFromPointer(event);
            if (this.isSeeking) this.seekFromPointer(event);
            else this.draw();
        });
        this.canvas.addEventListener('pointerup', (event) => {
            if (!this.isSeeking) return;
            this.seekFromPointer(event);
            this.isSeeking = false;
            this.canvas.releasePointerCapture(event.pointerId);
        });
        this.canvas.addEventListener('pointercancel', () => {
            this.isSeeking = false;
        });
        this.canvas.addEventListener('pointerleave', () => {
            if (this.isSeeking) return;
            this.hoverProgress = null;
            this.draw();
        });
        this.canvas.addEventListener('keydown', (event) => {
            if (this.duration <= 0) return;
            let nextTime = this.currentTime;
            if (event.key === 'ArrowLeft') nextTime -= 5;
            else if (event.key === 'ArrowRight') nextTime += 5;
            else if (event.key === 'Home') nextTime = 0;
            else if (event.key === 'End') nextTime = this.duration;
            else return;
            event.preventDefault();
            this.onSeek(Math.max(0, Math.min(1, nextTime / this.duration)));
        });
        this.canvas.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
        this.updateAccessibility();
        this.draw();
    }

    async load(source: string) {
        const token = ++this.loadToken;
        this.audioBuffer = null;
        this.progress = 0;
        this.currentTime = 0;
        this.knownDuration = 0;
        this.message = 'Loading waveform...';
        this.draw();
        try {
            if (!this.audioContext) {
                const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
                this.audioContext = new AudioContextCtor();
            }
            const response = await fetch(source);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.arrayBuffer();
            const decoded = await this.audioContext.decodeAudioData(data);
            if (token !== this.loadToken) return;
            this.audioBuffer = decoded;
            this.knownDuration = decoded.duration;
            this.message = '';
            this.updateAccessibility();
            this.draw();
        } catch (error) {
            if (token !== this.loadToken) return;
            console.error('Could not load master waveform', error);
            this.message = 'Waveform unavailable';
            this.draw();
        }
    }

    get duration() {
        return this.knownDuration || this.audioBuffer?.duration || 0;
    }

    setPlayback(currentTime: number, duration: number) {
        if (Number.isFinite(duration) && duration > 0) this.knownDuration = duration;
        this.currentTime = Math.max(0, Math.min(this.duration, Number.isFinite(currentTime) ? currentTime : 0));
        this.progress = this.duration > 0 ? this.currentTime / this.duration : 0;
        this.updateAccessibility();
        this.draw();
    }

    clear(message = 'Ready to render') {
        this.loadToken++;
        this.audioBuffer = null;
        this.progress = 0;
        this.currentTime = 0;
        this.knownDuration = 0;
        this.hoverProgress = null;
        this.message = message;
        this.updateAccessibility();
        this.draw();
    }

    private progressFromPointer(event: PointerEvent) {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    }

    private seekFromPointer(event: PointerEvent) {
        const progress = this.progressFromPointer(event);
        this.hoverProgress = progress;
        this.progress = progress;
        this.currentTime = progress * this.duration;
        this.updateAccessibility();
        this.draw();
        this.onSeek(progress);
    }

    private updateAccessibility() {
        this.canvas.setAttribute('aria-valuemax', String(Math.round(this.duration)));
        this.canvas.setAttribute('aria-valuenow', String(Math.round(this.currentTime)));
        this.canvas.setAttribute('aria-valuetext', `${this.formatTime(this.currentTime)} of ${this.formatTime(this.duration)}`);
    }

    private formatTime(seconds: number) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        const total = Math.floor(seconds);
        const minutes = Math.floor(total / 60);
        return `${minutes}:${(total % 60).toString().padStart(2, '0')}`;
    }

    private draw() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.floor(rect.width * dpr));
        const height = Math.max(1, Math.floor(rect.height * dpr));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        const cssWidth = width / dpr;
        const cssHeight = height / dpr;
        this.ctx.save();
        this.ctx.scale(dpr, dpr);
        const background = this.ctx.createLinearGradient(0, 0, 0, cssHeight);
        background.addColorStop(0, '#172033');
        background.addColorStop(1, '#0b1120');
        this.ctx.fillStyle = background;
        this.ctx.fillRect(0, 0, cssWidth, cssHeight);

        if (this.audioBuffer) {
            const samples = this.audioBuffer.getChannelData(0);
            const columns = Math.max(1, Math.floor(cssWidth));
            const samplesPerColumn = Math.max(1, Math.floor(samples.length / columns));
            const middle = cssHeight / 2;
            const peaks: number[] = [];
            for (let x = 0; x < columns; x++) {
                const start = x * samplesPerColumn;
                const end = Math.min(samples.length, start + samplesPerColumn);
                let peak = 0;
                for (let i = start; i < end; i += 4) peak = Math.max(peak, Math.abs(samples[i] || 0));
                peaks.push(Math.max(1, peak * (cssHeight * 0.38)));
            }
            const drawPeaks = (color: string, startX: number, endX: number) => {
                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(startX, 0, Math.max(0, endX - startX), cssHeight);
                this.ctx.clip();
                this.ctx.strokeStyle = color;
                this.ctx.lineWidth = 1;
                for (let x = 0; x < columns; x++) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(x + 0.5, middle - peaks[x]);
                    this.ctx.lineTo(x + 0.5, middle + peaks[x]);
                    this.ctx.stroke();
                }
                this.ctx.restore();
            };
            const playheadX = this.progress * cssWidth;
            drawPeaks('#536278', playheadX, cssWidth);
            drawPeaks('#3ee6b0', 0, playheadX);
            this.ctx.fillStyle = 'rgba(62, 230, 176, 0.08)';
            this.ctx.fillRect(0, 0, playheadX, cssHeight);
            this.ctx.strokeStyle = '#ffffff';
            this.ctx.lineWidth = 1.5;
            this.ctx.beginPath();
            this.ctx.moveTo(playheadX, 0);
            this.ctx.lineTo(playheadX, cssHeight);
            this.ctx.stroke();

            const timeLabel = `${this.formatTime(this.currentTime)} / ${this.formatTime(this.duration)}`;
            this.ctx.font = '600 10px Inter, sans-serif';
            this.ctx.textAlign = 'left';
            this.ctx.textBaseline = 'middle';
            const labelWidth = this.ctx.measureText(timeLabel).width + 12;
            this.ctx.fillStyle = 'rgba(5, 10, 20, 0.78)';
            this.ctx.fillRect(5, cssHeight - 17, labelWidth, 14);
            this.ctx.fillStyle = '#e2e8f0';
            this.ctx.fillText(timeLabel, 11, cssHeight - 10);

            if (this.hoverProgress !== null && !this.isSeeking) {
                const hoverX = this.hoverProgress * cssWidth;
                const hoverTime = this.formatTime(this.hoverProgress * this.duration);
                this.ctx.setLineDash([2, 3]);
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                this.ctx.beginPath();
                this.ctx.moveTo(hoverX, 0);
                this.ctx.lineTo(hoverX, cssHeight);
                this.ctx.stroke();
                this.ctx.setLineDash([]);
                this.ctx.font = '600 10px Inter, sans-serif';
                const hoverWidth = this.ctx.measureText(hoverTime).width + 10;
                const tooltipX = Math.max(2, Math.min(cssWidth - hoverWidth - 2, hoverX - hoverWidth / 2));
                this.ctx.fillStyle = '#f8fafc';
                this.ctx.fillRect(tooltipX, 3, hoverWidth, 14);
                this.ctx.fillStyle = '#0f172a';
                this.ctx.textAlign = 'center';
                this.ctx.fillText(hoverTime, tooltipX + hoverWidth / 2, 10);
            }
        } else {
            this.ctx.fillStyle = '#94a3b8';
            this.ctx.font = '11px Inter, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(this.message, cssWidth / 2, cssHeight / 2);
        }
        this.ctx.restore();
    }
}
