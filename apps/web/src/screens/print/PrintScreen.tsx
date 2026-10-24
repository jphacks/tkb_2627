import { useEffect, useMemo, useRef, useState } from 'react';
import type { Trip } from '@tkb/contracts';
import { MockBanner } from '../../components/MockBanner.tsx';
import { formatDay } from '../../lib/format.ts';
import { createMockApi } from '../../mocks/index.ts';
import { fetchTrip, fetchTripFromMock, type TripLoad } from '../itinerary/api.ts';
import { MAP_NOTE, PHOTO_PLACEHOLDER, buildPrintModel, costText } from './model.ts';
import { PDF_MESSAGES, createMockPdf, createPdf, type PdfOutcome } from './pdf.ts';
import { CAL_MESSAGES, fetchIcs, fetchMapsLinks, mockIcs, mockMapsLinks, type MapsOutcome } from './calendar-maps.ts';
import type { PrintRoute } from './route.ts';
import './print.css';

/** Pure printable sheet. No <img> of maps; photos only when the model allows them. */
export function PrintSheet({ trip }: { trip: Trip }) {
  const m = useMemo(() => buildPrintModel(trip), [trip]);
  return (
    <article className="pr-sheet" lang="ja">
      <header className="pr-head">
        <h1>{m.title}</h1>
        <p>{m.period}</p>
      </header>
      {m.warnings.length > 0 && <ul className="pr-warn">{m.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
      <p className="pr-note">{MAP_NOTE}</p>
      {m.days.map((day, i) => (
        <section className="pr-day" key={day.date} aria-label={`${i + 1}日目`}>
          <h2>{i + 1}日目　{formatDay(day.date)}（{day.mode}）</h2>
          <ol className="pr-items">
            {day.items.map(it => (
              <li className="pr-item" key={it.key}>
                <div className="pr-time">{it.time}</div>
                <div className="pr-body">
                  <p className="pr-title"><span className="pr-kind">{it.kind}</span> {it.title}</p>
                  {it.place && <p>地点: {it.place}</p>}
                  {it.details.map(d => <p key={d}>{d}</p>)}
                  <p>{it.cost}</p>
                  {it.photo && (
                    <figure className="pr-photo">
                      <img src={it.photo.url} alt={`${it.title}の写真`} />
                      <figcaption>写真: {it.photo.credit}</figcaption>
                    </figure>
                  )}
                  {it.photoPlaceholder && <p className="pr-photo-missing">{PHOTO_PLACEHOLDER}</p>}
                  {it.source && <p className="pr-source">出典: {it.source}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      <section className="pr-summary" aria-label="費用">
        <h2>費用の合計（通貨別）</h2>
        <p>{costText(m.cost)}</p>
      </section>
      {m.places.length > 0 && (
        <section className="pr-places" aria-label="訪問地の一覧">
          <h2>訪問地の一覧（地図の代わり）</h2>
          <ul>{m.places.map(p => <li key={p}>{p}</li>)}</ul>
        </section>
      )}
      <section className="pr-sources" aria-label="出典一覧">
        <h2>出典・写真クレジット</h2>
        {m.sources.length === 0 ? <p>掲載できる出典はありません。</p> : <ul>{m.sources.map(s => <li key={s}>{s}</li>)}</ul>}
      </section>
    </article>
  );
}

function PdfPanel({ trip, mode }: { trip: Trip; mode: PrintRoute['mode'] }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PdfOutcome | null>(null);
  const [href, setHref] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => () => { if (href) URL.revokeObjectURL(href); }, [href]);

  async function run() {
    setBusy(true); setOutcome(null); setHref(null);
    ctrl.current = new AbortController();
    try {
      const r = mode === 'mock' ? await createMockPdf() : await createPdf(trip.tripId, trip.revision, { signal: ctrl.current.signal });
      if (r.state === 'ready') setHref(URL.createObjectURL(r.blob));
      setOutcome(r);
    } catch { /* aborted on unmount */ } finally { setBusy(false); }
  }

  const withheld = outcome && 'withheld' in outcome ? outcome.withheld : [];
  let message: string | null = null;
  if (outcome) {
    if (outcome.state === 'conflict' || outcome.state === 'restricted' || outcome.state === 'expired' || outcome.state === 'timeout') message = PDF_MESSAGES[outcome.state];
    else if (outcome.state === 'failed' || outcome.state === 'error') message = outcome.message;
  }
  return (
    <div className="pr-pdf">
      <button type="button" className="btn" onClick={() => void run()} disabled={busy}>{busy ? 'PDFを作成中…' : 'PDFを作成'}</button>
      {message && <p role="alert">{message}</p>}
      {href && <p role="status"><a href={href} download={`trip-${trip.tripId}.pdf`}>PDFをダウンロード</a></p>}
      {withheld.length > 0 && (
        <div role="status">
          <p>転載できないため、次の項目はPDFに含まれません。</p>
          <ul>{withheld.map(w => <li key={`${w.kind}:${w.id}`}>{w.kind === 'place' ? '地点' : w.kind === 'leg' ? '区間' : '写真'}: {w.id}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL = { place: '地点', leg: '区間', photo: '写真' } as const;

/** E03: ICS download and per-day Google Maps links (R19/R20: nothing is registered in any account). */
function CalendarMapsPanel({ trip, mode }: { trip: Trip; mode: PrintRoute['mode'] }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [maps, setMaps] = useState<MapsOutcome | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  async function downloadIcs() {
    setBusy(true); setMessage(null);
    ctrl.current = new AbortController();
    try {
      const r = mode === 'mock' ? await mockIcs() : await fetchIcs(trip.tripId, { signal: ctrl.current.signal });
      if (r.state === 'ready') {
        const url = URL.createObjectURL(r.blob);
        const a = document.createElement('a');
        a.href = url; a.download = `trip-${trip.tripId}.ics`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } else setMessage(r.state === 'error' ? r.message : CAL_MESSAGES[r.state]);
    } catch { /* aborted on unmount */ } finally { setBusy(false); }
  }
  async function loadMaps() {
    setBusy(true); setMessage(null);
    ctrl.current = new AbortController();
    try {
      const r = mode === 'mock' ? await mockMapsLinks() : await fetchMapsLinks(trip.tripId, { signal: ctrl.current.signal });
      setMaps(r);
      if (r.state === 'error') setMessage(r.message);
      else if (r.state !== 'ready') setMessage(CAL_MESSAGES[r.state]);
    } catch { /* aborted on unmount */ } finally { setBusy(false); }
  }

  const withheld = maps && 'withheld' in maps ? maps.withheld : [];
  return (
    <div className="pr-cal">
      <button type="button" className="btn" onClick={() => void downloadIcs()} disabled={busy}>カレンダー（ICS）をダウンロード</button>
      <button type="button" className="btn" onClick={() => void loadMaps()} disabled={busy}>Googleマップで開く</button>
      {message && <p role="alert">{message}</p>}
      {maps?.state === 'ready' && (
        <ul aria-label="日ごとのGoogleマップ">
          {maps.byDay.map(d => (
            <li key={d.dayIndex}>
              {d.dayIndex + 1}日目:{' '}
              {d.urls.map((u, i) => <a key={u} href={u} target="_blank" rel="noopener noreferrer">{d.urls.length > 1 ? `リンク${i + 1}` : 'Googleマップで開く'} </a>)}
            </li>
          ))}
        </ul>
      )}
      {withheld.length > 0 && (
        <div role="status">
          <p>転載できないため、次の項目は含まれません。</p>
          <ul>{withheld.map(w => <li key={`${w.kind}:${w.id}`}>{KIND_LABEL[w.kind]}: {w.id}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

export function PrintBody({ load, mode }: { load: TripLoad | null; mode: PrintRoute['mode'] }) {
  if (load === null) return <p role="status">旅程を読み込み中…</p>;
  if (load.state === 'notFound') return <p role="alert">旅程が見つかりません（404）。</p>;
  if (load.state === 'unauthenticated') return <p role="alert">ログインが必要です（401）。</p>;
  if (load.state === 'error') return <p role="alert">旅程を読み込めませんでした: {load.message}</p>;
  return (
    <>
      <div className="pr-toolbar no-print">
        <a href={`#/${mode === 'mock' ? 'mock/' : ''}trips/${encodeURIComponent(load.trip.tripId)}/map`}>← 地図と旅程へ</a>
        <button type="button" className="btn" onClick={() => window.print()}>ブラウザで印刷</button>
        <PdfPanel trip={load.trip} mode={mode} />
        <CalendarMapsPanel trip={load.trip} mode={mode} />
      </div>
      <PrintSheet trip={load.trip} />
    </>
  );
}

export function PrintScreen({ route }: { route: PrintRoute }) {
  const [load, setLoad] = useState<TripLoad | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const p = route.mode === 'mock' ? fetchTripFromMock(createMockApi(), route.tripId) : fetchTrip(route.tripId, { signal: ctrl.signal });
    p.then(setLoad, () => { /* aborted */ });
    return () => ctrl.abort();
  }, [route.mode, route.tripId]);
  return (
    <div className="pr-root">
      {route.mode === 'mock' && <div className="no-print"><MockBanner /></div>}
      <main className="pr-main" aria-label="しおりの印刷">
        <PrintBody load={load} mode={route.mode} />
      </main>
    </div>
  );
}
