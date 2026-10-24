import { useState } from 'react';
import type { Activity, ItineraryItem, TravelLeg, Trip } from '@tkb/contracts';
import { summarizeCosts } from '../lib/costs.ts';
import { UNKNOWN, formatDay, formatDuration, formatMoney, formatZoned } from '../lib/format.ts';
import { highlightFor, itemKey, numberPlaces, type Selection } from '../lib/places.ts';

const KIND_LABEL: Record<Activity['kind'], string> = { visit: '訪問', meal: '食事', free_walk: '自由散策', lodging: '宿泊', custom: 'その他' };
const MODE_LABEL: Record<TravelLeg['mode'], string> = { transit: '公共交通', car: '車', walk: '徒歩' };

function ItemBody({ item, placeName }: { item: ItineraryItem; placeName: (id: string | null) => string }) {
  if (item.type === 'leg') {
    return (
      <>
        <span className="badge badge-leg">移動 / {MODE_LABEL[item.mode]}</span>
        <span className="item-title">{placeName(item.fromPlaceId)} → {placeName(item.toPlaceId)}</span>
        <span className="meta">出発 {formatZoned(item.departure)}</span>
        <span className="meta">到着 {formatZoned(item.arrival)}</span>
        <span className="meta">所要 {formatDuration(item.durationSeconds)} / 路線 {item.lineName ?? UNKNOWN} / 運賃 {formatMoney(item.fare)}</span>
      </>
    );
  }
  const cls = item.kind === 'free_walk' ? 'badge-free' : 'badge-act';
  return (
    <>
      <span>
        <span className={`badge ${cls}`}>{KIND_LABEL[item.kind]}</span>
        {item.fixed && <span className="badge badge-fixed">固定予定</span>}
      </span>
      <span className="item-title">{item.title}</span>
      {item.kind === 'free_walk' && <span className="meta">エリア: {item.areaName ?? UNKNOWN}（店・施設は未指定）</span>}
      <span className="meta">開始 {formatZoned(item.start)}</span>
      <span className="meta">終了 {formatZoned(item.end)}</span>
      <span className="meta">費用 {formatMoney(item.cost)}</span>
    </>
  );
}

export function TripViewer({ trips }: { trips: Trip[] }) {
  const [tripIdx, setTripIdx] = useState(0);
  const [dayIdx, setDayIdx] = useState(0);
  const [sel, setSel] = useState<Selection>(null);

  const trip = trips[tripIdx];
  if (!trip) return <p>旅程がありません。</p>;
  const day = trip.days[dayIdx] ?? trip.days[0];
  if (!day) return <p>この旅程には日程がありません。</p>;

  const placeById = new Map(trip.places.map(p => [p.placeId, p]));
  const placeName = (id: string | null) => (id ? (placeById.get(id)?.name ?? UNKNOWN) : UNKNOWN);
  const numbered = numberPlaces(day, trip.places);
  const numOf = new Map(numbered.map(n => [n.place.placeId, n.number]));
  const hl = highlightFor(sel, day);
  const costs = summarizeCosts(trip.days);

  const toggle = (next: Exclude<Selection, null>) =>
    setSel(sel && JSON.stringify(sel) === JSON.stringify(next) ? null : next);

  return (
    <div className="viewer">
      <div role="group" aria-label="旅程の切替" className="tabs">
        {trips.map((t, i) => (
          <button key={t.tripId} type="button" className="tab" aria-pressed={i === tripIdx}
            onClick={() => { setTripIdx(i); setDayIdx(0); setSel(null); }}>
            {t.constraints.timeZone === 'Asia/Tokyo' ? '国内' : '海外'}：{t.constraints.area}
          </button>
        ))}
      </div>
      <h2 className="trip-title">{trip.title}</h2>

      <section aria-label="費用の合計" className="cost">
        <h3>既知費用の合計（通貨別）</h3>
        {costs.totals.length === 0 ? <p>{UNKNOWN}</p> : (
          <ul>{costs.totals.map(m => <li key={m.currency}>{formatMoney(m)}</li>)}</ul>
        )}
        <p className="meta">費用が{UNKNOWN}の項目: {costs.unknownCount}件（0円として扱わず、通貨をまたいだ合算もしていません）</p>
      </section>

      <div role="group" aria-label="日付" className="tabs">
        {trip.days.map((d, i) => (
          <button key={d.date} type="button" className="tab" aria-pressed={d === day}
            onClick={() => { setDayIdx(i); setSel(null); }}>
            {i + 1}日目 {formatDay(d.date)}
          </button>
        ))}
      </div>

      <div className="panes">
        <section aria-label="行程" className="pane">
          <h3>行程（{day.timeZone}）</h3>
          <ol className="list">
            {day.items.map(item => {
              const key = itemKey(item);
              const on = hl.itemKeys.has(key);
              return (
                <li key={key}>
                  <button type="button" aria-pressed={on} className={`row row-${item.type}${on ? ' on' : ''}`}
                    onClick={() => toggle({ kind: 'item', key })}>
                    <ItemBody item={item} placeName={placeName} />
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-label="地点リスト" className="pane">
          <h3>地点リスト</h3>
          <p className="note">地図SDKは未接続です。番号付きの地点リストで代替しています。</p>
          <ol className="list">
            {numbered.map(({ place }) => {
              const on = hl.placeIds.has(place.placeId);
              return (
                <li key={place.placeId}>
                  <button type="button" aria-pressed={on} className={`row place${on ? ' on' : ''}`}
                    onClick={() => toggle({ kind: 'place', placeId: place.placeId })}>
                    <span className="num" aria-hidden="true">{numOf.get(place.placeId)}</span>
                    <span>
                      <span className="item-title">{place.name}</span>
                      <span className="meta">
                        {place.location ? `${place.location.lat.toFixed(4)}, ${place.location.lng.toFixed(4)}（仮）` : `位置 ${UNKNOWN}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}
