import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { domesticTrip } from '@tkb/fixtures';
import { mockSnapshot } from './mockSocialApi.ts';
import { PostItinerary } from './PostItinerary.tsx';
import { CopiedTripView, SnapshotView } from './views.tsx';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');

describe('PostItinerary (U10, #36 review item 2)', () => {
  it('shows a shared snapshot with the U04 itinerary table, read-only, one table per day', () => {
    const { snapshot } = mockSnapshot(domesticTrip);
    const html = render(<PostItinerary days={snapshot.days} places={snapshot.places} />);
    expect(html).toContain('aria-label="行程表"');
    expect((html.match(/class="it-table"/g) ?? []).length).toBe(snapshot.days.filter(d => d.items.length > 0).length);
    expect(html).toContain('1日目');
    // Read-only: no reorder column or drag handle.
    expect(html).not.toContain('並べ替え');
  });

  it('replaces the sentence-style list in the post detail and the copied-trip check', () => {
    const { snapshot } = mockSnapshot(domesticTrip);
    for (const html of [render(<SnapshotView snapshot={snapshot} />), render(<CopiedTripView trip={domesticTrip} />)]) {
      expect(html).toContain('class="it-table"');
      expect(html).not.toContain('class="s8-items"');
    }
  });

  it('does not reveal a hidden place: its name is not in the snapshot places, so it never appears', () => {
    const { snapshot } = mockSnapshot(domesticTrip);
    // A place whose name is not part of any (user-written) title, so only a place lookup could show it.
    const titles = JSON.stringify(snapshot.days.flatMap(d => d.items.map(i => (i.type === 'activity' ? `${i.title} ${i.areaName ?? ''}` : ''))));
    const hidden = snapshot.places.find(p => !titles.includes(p.name) && snapshot.days.some(d => d.items.some(i => i.type === 'activity' && i.placeId === p.placeId)))!;
    expect(hidden).toBeDefined();
    const redacted = {
      ...snapshot,
      places: snapshot.places.filter(p => p.placeId !== hidden.placeId),
      days: snapshot.days.map(d => ({
        ...d,
        items: d.items.map(i => (i.type === 'activity' && i.placeId === hidden.placeId ? { ...i, placeId: 'hidden_1' } : i)),
      })),
    };
    expect(render(<PostItinerary days={redacted.days} places={redacted.places} />)).not.toContain(hidden.name);
  });

  it('says when there are no days or no items', () => {
    expect(render(<PostItinerary days={[]} places={[]} />)).toContain('日程の内容はありません。');
    expect(render(<PostItinerary days={[{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items: [] }]} places={[]} />)).toContain('予定はありません。');
  });
});
