export interface WaveformScrubOptions {
  onSeek?: (progress: number, meta: { scrubbing: boolean }) => void;
  onSeekStart?: (progress: number) => void;
  onSeekEnd?: (progress: number) => void;
  emptyMessage?: string;
  canvasClassName?: string;
  ariaLabel?: string;
}

export function downsamplePeakPairs(pairs: Array<[number, number]>, columns: number): Float32Array;
export function downsampleInterleavedPeaks(flat: ArrayLike<number>, columns: number): Float32Array;
export function formatTransportTime(seconds: number): string;

export class WaveformScrubCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly currentTime: number;
  constructor(container: HTMLElement, options?: WaveformScrubOptions);
  get duration(): number;
  setMessage(message: string): void;
  setAudioBuffer(buffer: AudioBuffer | null, totalExpectedDuration?: number): void;
  setInterleavedPeaks(interleavedMinMax: number[], durationSeconds: number): void;
  setPeakPairs(pairs: Array<[number, number]>, durationSeconds: number): void;
  setProgressOnly(durationSeconds?: number, message?: string): void;
  setPlayback(currentTime: number, duration: number): void;
  setCue(cueSec: number, active: boolean): void;
  clear(message?: string): void;
  draw(): void;
  destroy(): void;
}
