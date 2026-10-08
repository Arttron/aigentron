import { describe, expect, it } from 'vitest';
import { clampPos, edgeTabFor } from './float-position';

describe('clampPos', () => {
  const size = { w: 100, h: 100 };
  const view = { w: 400, h: 800 };
  it('keeps the element inside the viewport', () => {
    expect(clampPos({ right: -50, bottom: -50 }, size, view)).toEqual({ right: 4, bottom: 4 });
    expect(clampPos({ right: 999, bottom: 999 }, size, view)).toEqual({ right: 296, bottom: 696 });
    expect(clampPos({ right: 50, bottom: 60 }, size, view)).toEqual({ right: 50, bottom: 60 });
  });
  it('survives a viewport smaller than the element', () => {
    const p = clampPos({ right: 10, bottom: 10 }, size, { w: 80, h: 80 });
    expect(p.right).toBeGreaterThanOrEqual(0);
  });
});

describe('edgeTabFor', () => {
  const view = { w: 400, h: 800 };
  it('picks the nearest side', () => {
    expect(edgeTabFor({ left: 10, right: 110, top: 100, bottom: 200 }, view).side).toBe('left');
    expect(edgeTabFor({ left: 280, right: 380, top: 100, bottom: 200 }, view).side).toBe('right');
  });
  it('centres the tab on the bubble height and keeps it on screen', () => {
    // bubble centre 650px from the top = 150px from the bottom; tab 52px high -> bottom offset 124
    expect(edgeTabFor({ left: 0, right: 100, top: 600, bottom: 700 }, view).bottom).toBe(124);
    expect(edgeTabFor({ left: 0, right: 100, top: 790, bottom: 800 }, view).bottom).toBeGreaterThanOrEqual(8);
    expect(edgeTabFor({ left: 0, right: 100, top: 0, bottom: 10 }, view).bottom).toBeLessThanOrEqual(800 - 52 - 8);
  });
});
