/** Renderer-side pixel evidence for one ASCII search occurrence on the engine surface. */
export function terminalSearchHighlightReader(matchCells: number): string {
  return `(engine) => {
    const source = engine.querySelector('canvas');
    const highlight = engine.querySelector('canvas[data-ghostty-retained-range-highlight]');
    if (!(source instanceof HTMLCanvasElement) ||
        !(highlight instanceof HTMLCanvasElement) ||
        getComputedStyle(highlight).visibility === 'hidden') return undefined;
    const context = highlight.getContext('2d');
    if (!context || !highlight.width || !highlight.height) return undefined;
    const pixels = context.getImageData(0, 0, highlight.width, highlight.height).data;
    let left = highlight.width, top = highlight.height, right = -1, bottom = -1;
    for (let y = 0; y < highlight.height; y++) {
      for (let x = 0; x < highlight.width; x++) {
        if (pixels[(y * highlight.width + x) * 4 + 3] === 0) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (right < left) return undefined;
    const metrics = engine.__hvirTerminalPerformance;
    const expectedWidth = source.width / metrics.cols * ${matchCells};
    const expectedHeight = source.height / metrics.rows;
    if (Math.abs(right - left + 1 - expectedWidth) > 1 ||
        Math.abs(bottom - top + 1 - expectedHeight) > 1) {
      throw new Error('engine search highlight pixel bounds do not match the cell grid');
    }
    const sourceBounds = source.getBoundingClientRect();
    const highlightBounds = highlight.getBoundingClientRect();
    if (Math.abs(sourceBounds.left - highlightBounds.left) > 1 ||
        Math.abs(sourceBounds.top - highlightBounds.top) > 1 ||
        highlight.width !== source.width || highlight.height !== source.height) {
      throw new Error('engine search highlight surface does not align with its canvas');
    }
    return { canvas: highlight, top, left, right, bottom };
  }`
}
