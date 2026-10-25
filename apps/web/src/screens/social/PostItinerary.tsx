/**
 * U10: a shared or copied trip shown with the same itinerary table as U04 (read-only): time | content, legs as two
 * rows, a stay opens its details one row below. No reorder, no saving. Values come from the snapshot or the copied
 * trip as the API returned them; hidden places stay hidden (tableRows shows only places that are in `places`).
 */
import { useState } from 'react';
import type { PlaceInfo, PublicTripDay, TripDay } from '@tkb/contracts';
import { formatDay } from '../../lib/format.ts';
import { ItineraryTable } from '../itinerary/ItineraryTable.tsx';
import { tableRows } from '../itinerary/table.ts';
import '../itinerary/itinerary.css';

export function PostItinerary({ days, places }: { days: readonly (TripDay | PublicTripDay)[]; places: readonly PlaceInfo[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (days.length === 0) return <p className="meta">日程の内容はありません。</p>;
  return (
    <div className="u10-itinerary">
      {days.map((day, i) => {
        // A public day has the same item shapes minus private notes; the table only reads shared fields.
        const rows = tableRows(day as TripDay, places);
        return (
          <section key={`${day.date}-${i}`} aria-label={`${i + 1}日目`}>
            <h4 className="u1-dayhead">{i + 1}日目 {formatDay(day.date)}</h4>
            {rows.length === 0 ? (
              <p className="meta">予定はありません。</p>
            ) : (
              <ItineraryTable
                rows={rows}
                dayDate={day.date}
                expanded={new Set([...expanded].filter(k => k.startsWith(`${i}:`)).map(k => k.slice(`${i}:`.length)))}
                onToggleRow={key => toggle(`${i}:${key}`)}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}
