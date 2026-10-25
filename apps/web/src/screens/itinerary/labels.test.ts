import { describe, expect, it } from 'vitest';
import { placeLabels } from './MapPanel.tsx';

describe('placeLabels', () => {
  it('gives close points non-overlapping boxes (or hides the text)', () => {
    const out = placeLabels([
      { id: 'a', text: '兼六園', x: 100, y: 100, r: 11 },
      { id: 'b', text: '金沢21世紀美術館', x: 112, y: 104, r: 11 },
      { id: 'c', text: '香林坊バス停', x: 106, y: 112, r: 11 },
    ]);
    expect(out[0]).not.toBeNull();
    const boxes = out.filter((o): o is NonNullable<typeof o> => o !== null).map(o => o.box);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
  });

  it('is deterministic and hides a label that fits nowhere', () => {
    const items = [{ id: 'a', text: 'あ'.repeat(40), x: 160, y: 110, r: 11 }];
    expect(placeLabels(items)).toEqual([null]);
    expect(placeLabels(items)).toEqual(placeLabels(items));
  });
});
