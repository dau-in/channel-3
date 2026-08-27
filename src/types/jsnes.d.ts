declare module "jsnes" {
  export interface NESOptions {
    onFrame?: (frameBuffer: number[]) => void;
    onAudioSample?: (left: number, right: number) => void;
    onStatusUpdate?: (status: string) => void;
    sampleRate?: number;
  }

  export class NES {
    constructor(options?: NESOptions);
    loadROM(romData: string): void;
    reloadROM(): void;
    frame(): void;
    reset(): void;
    buttonDown(controller: number, button: number): void;
    buttonUp(controller: number, button: number): void;
    toJSON(): unknown;
    fromJSON(state: unknown): void;
  }

  export const Controller: {
    BUTTON_A: number;
    BUTTON_B: number;
    BUTTON_SELECT: number;
    BUTTON_START: number;
    BUTTON_UP: number;
    BUTTON_DOWN: number;
    BUTTON_LEFT: number;
    BUTTON_RIGHT: number;
  };
}
