import { describe, expect, it } from 'vitest';
import { viewportSize, viewportOriginCorrection, viewportOriginHorizontalCorrection, type ViewportMetrics } from '../web/mobile-viewport';

const metrics: ViewportMetrics = { innerWidth: 390, innerHeight: 844, clientWidth: 390, clientHeight: 844, scrollX: 0, scrollY: 0, cssHeight: 844, probeTop: 0, visual: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 }, editing: false, focusTag: 'BODY', visible: true };
describe('measured mobile viewport', () => {
  it('repairs a stranded fixed origin and releases the correction after native recovery', () => {
    const target = viewportSize(metrics);
    expect(viewportOriginCorrection(metrics, target, -96, 0)).toBe(96);
    expect(viewportOriginCorrection(metrics, target, 0, 96)).toBe(96);
    expect(viewportOriginCorrection(metrics, target, 96, 96)).toBe(0);
  });
  it('repairs a horizontal fixed origin only on a phone-sized viewport', () => {
    expect(viewportOriginHorizontalCorrection(metrics, -96, 0)).toBe(96);
    expect(viewportOriginHorizontalCorrection(metrics, 0, 96)).toBe(96);
    expect(viewportOriginHorizontalCorrection(metrics, 96, 96)).toBe(0);
    expect(viewportOriginHorizontalCorrection({ ...metrics, innerWidth: 1280 }, -96, 0)).toBe(0);
  });
  it('does not compensate keyboard panning or pinch zoom and rejects invalid geometry', () => {
    const target = viewportSize(metrics);
    expect(viewportOriginCorrection(metrics, { ...target, keyboard: true }, -96, 96)).toBe(0);
    expect(viewportOriginCorrection({ ...metrics, visual: { ...metrics.visual!, scale: 2 } }, target, -96, 96)).toBe(0);
    expect(viewportOriginCorrection(metrics, target, NaN, 0)).toBe(0);
    expect(viewportOriginCorrection(metrics, target, -900, 0)).toBe(0);
  });
  it('uses agreeing window measurements when CSS dvh is stuck at the old height', () => { expect(viewportSize({ ...metrics, cssHeight: 548 })).toEqual({ height: 844, top: 0, keyboard: false, source: 'visual' }); });
  it('uses visual and CSS agreement when innerHeight is still stale', () => { expect(viewportSize({ ...metrics, innerHeight: 548 }).height).toBe(844); });
  it('does not retain a shrunken layout when the visible viewport recovers first', () => {
    expect(viewportSize({ ...metrics, innerHeight: 548, cssHeight: 548, clientHeight: 548 })).toEqual({ height: 844, top: 0, keyboard: false, source: 'visual' });
  });
  it('ignores an isolated stale visual viewport without an editable focus', () => { expect(viewportSize({ ...metrics, visual: { ...metrics.visual!, height: 548, offsetTop: 96 } })).toEqual({ height: 844, top: 0, keyboard: false, source: 'window' }); });
  it('aligns with the actual visual offset without requiring keyboard focus', () => { expect(viewportSize({ ...metrics, innerHeight: 748, visual: { ...metrics.visual!, height: 748, offsetTop: 96 } })).toEqual({ height: 748, top: 96, keyboard: false, source: 'visual' }); });
  it('retains the keyboard viewport and does not resize the layout for pinch zoom', () => {
    expect(viewportSize({ ...metrics, editing: true, visual: { ...metrics.visual!, height: 500, offsetTop: 24 } })).toMatchObject({ height: 500, top: 24, keyboard: true });
    expect(viewportSize({ ...metrics, editing: true, visual: { ...metrics.visual!, height: 422, offsetTop: 60, scale: 2 } })).toMatchObject({ height: 844, top: 0, keyboard: false });
  });
  it('does not apply zero or invalid visual measurements during restoration', () => {
    expect(viewportSize({ ...metrics, visual: { ...metrics.visual!, height: 0 } }).height).toBe(844);
    expect(viewportSize({ ...metrics, visual: null }).height).toBe(844);
    expect(viewportSize({ ...metrics, innerHeight: 0, visual: null }).height).toBe(844);
  });
});
