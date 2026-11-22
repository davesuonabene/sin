export interface SliderFillGeometry {
  ratio: number;
  zeroRatio: number;
  leftPct: number;
  widthPct: number;
  headPct: number;
  isBipolar: boolean;
}

export interface SliderOptions {
  bipolar?: boolean;
  defaultValue?: number;
  compact?: boolean;
  className?: string;
  label?: string;
  showValue?: boolean;
  formatValue?: (val: number) => string;
  onDoubleClickReset?: (val: number) => void;
  onValueClick?: () => void;
}

export interface SliderController {
  element: HTMLDivElement;
  input: HTMLInputElement;
  sync(): void;
  setLabel(text: string): void;
  setModulationBand(startPct: number | null, endPct: number | null, color?: string): void;
  destroy(): void;
}

export interface CreateAbletonSliderOptions extends SliderOptions {
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  ariaLabel?: string;
  title?: string;
  onInput?: (val: number) => void;
  onChange?: (val: number) => void;
}

export function clampSliderValue(value: number, min: number, max: number): number;
export function normalizeSliderRatio(value: number, min: number, max: number): number;
export function snapSliderValue(value: number, min: number, max: number, step: number): number;
export function computeSliderFillGeometry(
  value: number,
  min: number,
  max: number,
  bipolar?: boolean
): SliderFillGeometry;
export function enhanceRangeSlider(inputEl: HTMLInputElement, options?: SliderOptions): SliderController | null;
export function createAbletonSlider(options?: CreateAbletonSliderOptions): SliderController;
