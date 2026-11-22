export interface DropdownOptions {
  size?: 'sm' | 'md';
  preferUp?: boolean;
  ghost?: boolean;
}

export interface DropdownController {
  element: HTMLDivElement;
  trigger: HTMLButtonElement;
  select: HTMLSelectElement;
  open(): void;
  close(): void;
  sync(): void;
  destroy(): void;
}

export function closeActiveDropdown(): void;
export function enhanceSelect(selectEl: HTMLSelectElement, options?: DropdownOptions): DropdownController | null;
export function enhanceAllSelects(root?: Document | Element, options?: DropdownOptions): DropdownController[];
