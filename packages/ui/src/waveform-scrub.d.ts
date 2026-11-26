export interface WaveformScrubOptions {
  onSeek?: (progress: number, meta: { scrubbing: boolean }) => void;
  onSeekStart?: (progress: number) => void;
  onSeekEnd?: (progress: number) => void;
  onViewportChange?: (startSec: number, endSec: number, columns: number) => void;
  enableZoom?: boolean;
  emptyMessage?: string;
  canvasClassName?: string;
  ariaLabel?: string;
}

export interface InterleavedPeaksOptions {
  tiers?: number[] | Uint8Array | null;
  viewStartSec?: number;
  viewEndSec?: number;
  preserveTiers?: boolean;
}

export interface TileDeltaOptions {
  startSec: number;
  endSec: number;
  durationSec?: number;
  tier?: number;
  stale?: boolean;
  peaks?: number[] | null;
  clearAll?: boolean;
}

export function downsamplePeakPairs(pairs: Array<[number, number]>, columns: number): Float32Array;
export function downsampleInterleavedPeaks(flat: ArrayLike<number>, columns: number): Float32Array;
export function formatTransportTime(seconds: number): string;

export class WaveformScrubCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly currentTime: number;
  tierStates: Uint8Array | null;
  coverageSlots: Uint8Array;
  hasCoverage: boolean;
  interleavedPeaks: Float32Array | null;
  constructor(container: HTMLElement, options?: WaveformScrubOptions);
  get duration(): number;
  setMessage(message: string): void;
  setAudioBuffer(buffer: AudioBuffer | null, totalExpectedDuration?: number): void;
  setInterleavedPeaks(interleavedMinMax: number[], durationSeconds: number, options?: InterleavedPeaksOptions): void;
  applyTileDelta(delta?: TileDeltaOptions): void;
  clearTileTiers(): void;
  markAllTiersStale(): void;
  getViewport(): { startSec: number; endSec: number; zoom: number; columns: number };
  resetZoom(): void;
  setPeakPairs(pairs: Array<[number, number]>, durationSeconds: number): void;
  setProgressOnly(durationSeconds?: number, message?: string): void;
  setPlayback(currentTime: number, duration: number): void;
  setCue(cueSec: number, active: boolean): void;
  clear(message?: string): void;
  draw(): void;
  destroy(): void;
}
