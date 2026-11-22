export type TransportControlKind = 'play' | 'stop' | 'loop' | 'cue';

export interface TransportBarConfig {
  tag?: 'footer' | 'div';
  id?: string;
  className?: string;
  ariaLabel?: string;
  targetElement?: HTMLElement;
  controls?: TransportControlKind[];
  showTime?: boolean;
  rightElements?: HTMLElement[];
}

export interface TransportBarRefs {
  root: HTMLElement;
  targetSlot: HTMLDivElement | null;
  controlsSlot: HTMLDivElement | null;
  timelineSlot: HTMLDivElement | null;
  timeEl: HTMLSpanElement | null;
  rightSlot: HTMLDivElement | null;
  buttons: Partial<Record<TransportControlKind, HTMLButtonElement>>;
}

export function createTransportBar(config?: TransportBarConfig): TransportBarRefs;
