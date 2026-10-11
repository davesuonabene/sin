import { type SignalTelemetry } from '../types.ts';

export type TelemetryListener = (telemetry: SignalTelemetry) => void;

/**
 * Global transport telemetry clock.
 * Translates audio playback time and graph tempo into musical beats, bars, and steps.
 */
export class TransportClock {
    private time = 0;
    private duration = 0;
    private isPlaying = false;
    private bpm = 120;
    private activeNodeIds = new Set<number | string>();
    private realtimeScopeData: Float32Array | null = null;
    private readonly listeners = new Set<TelemetryListener>();

    setBpm(bpm: number): void {
        if (Number.isFinite(bpm) && bpm > 0) {
            this.bpm = bpm;
        }
    }

    getBpm(): number {
        return this.bpm;
    }

    setRealtimeScopeData(data: Float32Array | null): void {
        this.realtimeScopeData = data;
    }

    update(time: number, duration: number, isPlaying: boolean, activeNodeIds?: Set<number | string>): void {
        this.time = Math.max(0, time);
        this.duration = Math.max(0, duration);
        this.isPlaying = isPlaying;
        if (activeNodeIds) {
            this.activeNodeIds = activeNodeIds;
        }

        const telemetry = this.getTelemetry();
        for (const listener of this.listeners) {
            try {
                listener(telemetry);
            } catch (err) {
                console.error('IRIDE TelemetryListener error:', err);
            }
        }
    }

    getTelemetry(): SignalTelemetry {
        // 1 beat = 60 / BPM seconds
        const beatDuration = 60 / (this.bpm || 120);
        const beat = this.time / beatDuration;
        const bar = beat / 4;
        // 16th note step = 4 steps per beat
        const step = Math.floor(beat * 4) % 16;

        return {
            time: this.time,
            duration: this.duration,
            beat,
            bar,
            step: Math.max(0, step),
            isPlaying: this.isPlaying,
            activeNodeIds: this.activeNodeIds,
            realtimeScope: this.realtimeScopeData
        };
    }

    subscribe(listener: TelemetryListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}

export const defaultTransportClock = new TransportClock();
