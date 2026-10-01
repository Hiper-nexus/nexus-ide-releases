export interface BrowserVisualRect { x: number; y: number; width: number; height: number }
export interface BrowserVisualMasks {
  width: number; height: number; scrollX: number; scrollY: number;
  rectangles: BrowserVisualRect[];
}
