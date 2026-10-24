import { Fragment, useState } from 'react';
import { UNKNOWN, formatMoney } from '../../lib/format.ts';
import { KIND_LABEL } from './model.ts';
import {
  insertBeforeKey, keyboardTarget, childDetails, legDetails, stayDetails,
  type ChildRow, type DetailLine, type LegRow, type StayRow, type TableRow,
} from './table.ts';
import './itinerary.css';

type Drag = { key: string; before: string | null | undefined; mode: 'pointer' | 'keyboard'; order: string[] };

/**
 * The n x 2 itinerary table shared by U04 (map + itinerary), U06 edit and travel screens: time column + content,
 * travel legs as departure/arrival rows, nested activities inside their parent, row click for details and
 * (when `onReorder` is given) pointer + keyboard drag and drop. Dragging a stay moves its children with it.
 */
export function ItineraryTable({ rows, dayDate, expanded, selectedKeys, onToggleRow, onReorder, saving = false, setRowRef, stayExtra, stayBadge }: {
  rows: TableRow[];
  dayDate: string;
  expanded: ReadonlySet<string>;
  selectedKeys?: ReadonlySet<string>;
  onToggleRow: (key: string) => void;
  /** Without it the table is read-only (no drag handles). Called with the dragged stay and the stay it is dropped before (null: the end). */
  onReorder?: (key: string, before: string | null) => void;
  saving?: boolean;
  setRowRef?: (key: string, el: HTMLTableRowElement | null) => void;
  /** Extra controls under a stay row (e.g. remove, completed). */
  stayExtra?: (row: StayRow) => React.ReactNode;
  /** Extra text before the stay title (e.g. 未保存, 完了). */
  stayBadge?: (row: StayRow) => React.ReactNode;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const editable = onReorder !== undefined;
  const stayKeys = rows.flatMap(r => (r.kind === 'stay' ? [r.key] : []));
  const commitMove = (key: string, before: string | null) => onReorder?.(key, before);

  // R1: pointer based drag (mouse and touch) from the handle.
  const dropFromPoint = (e: React.PointerEvent, d: Drag): Drag => {
    const el = document.elementFromPoint?.(e.clientX, e.clientY)?.closest?.('[data-stay-key]') as HTMLElement | null;
    const overKey = el?.dataset.stayKey;
    if (!el || !overKey) return d;
    const rect = el.getBoundingClientRect();
    const after = el.dataset.detail === '1' || e.clientY > rect.top + rect.height / 2;
    return { ...d, before: insertBeforeKey(stayKeys, d.key, overKey, after) };
  };
  const onHandlePointerDown = (e: React.PointerEvent, key: string) => {
    if (saving || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ key, before: undefined, mode: 'pointer', order: stayKeys });
  };
  const onHandlePointerMove = (e: React.PointerEvent) => {
    if (drag?.mode === 'pointer') setDrag(dropFromPoint(e, drag));
  };
  const onHandlePointerUp = (e: React.PointerEvent) => {
    if (drag?.mode !== 'pointer') return;
    const final = dropFromPoint(e, drag);
    setDrag(null);
    if (final.before !== undefined) void commitMove(final.key, final.before);
  };
  // Keyboard alternative: Enter/Space picks the row up, arrow keys move it, Enter/Space drops, Escape cancels.
  const onHandleKeyDown = (e: React.KeyboardEvent, key: string) => {
    if (saving) return;
    if (!drag || drag.mode !== 'keyboard' || drag.key !== key) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrag({ key, before: undefined, mode: 'keyboard', order: stayKeys }); }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const before = keyboardTarget(drag.order, key, dir);
      if (before === undefined) return;
      const order = drag.order.filter(k => k !== key);
      order.splice(before === null ? order.length : order.indexOf(before), 0, key);
      setDrag({ ...drag, before, order });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const final = drag;
      setDrag(null);
      if (final.before !== undefined) void commitMove(final.key, final.before);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDrag(null);
    }
  };

  const dragTitle = drag ? rows.find(r => r.key === drag.key && r.kind === 'stay')?.key : null;
  const dragName = dragTitle ? (rows.find(r => r.key === dragTitle) as StayRow).item.title : '';


  return (
    <>
      <p className="u1-sr" role="status" aria-live="polite">
        {drag ? `「${dragName}」を移動中。${drag.before === undefined ? '移動先を選んでください。' : drag.before === null ? '最後に置きます。' : `「${(rows.find(r => r.key === drag.before) as StayRow | undefined)?.item.title ?? ''}」の前に置きます。`}` : ''}
      </p>
      <table className="it-table" aria-label="行程表">
        <thead><tr><th scope="col" className="it-col-time">時刻</th><th scope="col">内容</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={2} className="u1-empty">この日の予定はありません。</td></tr>}
          {rows.map(r => (
            <Fragment key={r.key}>
              {r.kind === 'stay' ? (
                <StayTableRows row={r} open={expanded.has(r.key)} selected={selectedKeys?.has(r.key) ?? false} editable={editable}
                  dragging={drag?.key === r.key} dropBefore={drag !== null && drag.before === r.key}
                  setRef={el => setRowRef?.(r.key, el)} extra={stayExtra?.(r)} badge={stayBadge?.(r)}
                  onToggle={() => onToggleRow(r.key)}
                  onHandlePointerDown={e => onHandlePointerDown(e, r.key)} onHandlePointerMove={onHandlePointerMove}
                  onHandlePointerUp={onHandlePointerUp} onHandleCancel={() => setDrag(null)} onHandleKeyDown={e => onHandleKeyDown(e, r.key)} />
              ) : (
                <LegTableRows row={r} open={expanded.has(r.key)} selected={selectedKeys?.has(r.key) ?? false} dayDate={dayDate} onToggle={() => onToggleRow(r.key)} />
              )}
            </Fragment>
          ))}
          {drag !== null && drag.before === null && <tr className="it-drop-end" aria-hidden="true"><td colSpan={2}>ここに置く</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function Unknown({ text }: { text: string }) {
  return text === UNKNOWN ? <span className="u1-unknown">{text}</span> : <>{text}</>;
}

/** Time text such as 「9:00〜10:00」 with any 未取得 part marked. */
function TimeText({ text }: { text: string }) {
  return text.includes(UNKNOWN) ? <>{text.split(UNKNOWN).flatMap((part, i, a) => (i < a.length - 1 ? [part, <span key={i} className="u1-unknown">{UNKNOWN}</span>] : [part]))}</> : <>{text}</>;
}

function DetailList({ lines, label }: { lines: DetailLine[]; label: string }) {
  return (
    <dl className="it-dl" aria-label={label}>
      {lines.map(l => (
        <Fragment key={l.label}>
          <dt>{l.label}</dt>
          <dd>{l.unknown ? <span className="u1-unknown">{l.value}</span> : l.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function StayTableRows({ row, open, selected, editable, dragging, dropBefore, extra, badge, setRef, onToggle, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp, onHandleCancel, onHandleKeyDown }: {
  row: StayRow;
  open: boolean;
  selected: boolean;
  editable: boolean;
  dragging: boolean;
  dropBefore: boolean;
  extra?: React.ReactNode;
  badge?: React.ReactNode;
  setRef: (el: HTMLTableRowElement | null) => void;
  onToggle: () => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  onHandlePointerMove: (e: React.PointerEvent) => void;
  onHandlePointerUp: (e: React.PointerEvent) => void;
  onHandleCancel: () => void;
  onHandleKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const a = row.item;
  const detailId = `it-d-${row.key}`;
  return (
    <>
      <tr ref={setRef} data-stay-key={row.key} className={`it-stay${selected ? ' it-on' : ''}${dragging ? ' it-dragging' : ''}${dropBefore ? ' it-drop-before' : ''}`}>
        <th scope="row" className="it-time"><TimeText text={row.range} /></th>
        <td>
          <div className="it-cell">
            {editable && (
              <button type="button" className="it-handle" aria-label={`「${a.title}」を並べ替える`} aria-pressed={dragging}
                onPointerDown={onHandlePointerDown} onPointerMove={onHandlePointerMove} onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandleCancel} onKeyDown={onHandleKeyDown}>⠿</button>
            )}
            <button type="button" className="it-rowbtn" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
              {row.number !== null
                ? <span className="it-num" aria-label={`地図の地点${row.number}`}>{row.number}</span>
                : <span className="it-num it-num-none" aria-label="地図に表示なし">–</span>}
              <span className="it-rowtext">
                <span className="it-title">{badge}{a.title}</span>
                <span className="meta">
                  {KIND_LABEL[a.kind]}{a.fixed ? '・固定予定' : ''}
                  ・費用 <Unknown text={a.cost === null ? UNKNOWN : formatMoney(a.cost)} />
                  {row.children.length > 0 ? `・中の予定 ${row.children.length}件` : ''}
                </span>
              </span>
              <span className="it-chev" aria-hidden="true">{open ? '▲' : '▼'}</span>
            </button>
          </div>
          {extra && <div className="it-extra">{extra}</div>}
        </td>
      </tr>
      {open && (
        <tr id={detailId} className="it-detail" data-stay-key={row.key} data-detail="1">
          <td colSpan={2}>
            <DetailList lines={stayDetails(row)} label={`${a.title}の詳細`} />
            {row.children.length > 0 && (
              <table className="it-subtable" aria-label={`${a.title}の中の予定（時間順）`}>
                <thead><tr><th scope="col" className="it-col-time">時刻</th><th scope="col">内容</th></tr></thead>
                <tbody>{row.children.map(c => <ChildTableRow key={c.key} child={c} />)}</tbody>
              </table>
            )}
            {row.children.length === 0 && <p className="meta">この予定の中の細かい予定はありません（取得できていない場合も、作らずにそのままにしています）。</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function ChildTableRow({ child }: { child: ChildRow }) {
  return (
    <tr className="it-child">
      <th scope="row" className="it-time"><TimeText text={child.range} /></th>
      <td>
        <span className="it-title">{child.item.title}</span>
        <DetailList lines={childDetails(child).filter(l => l.label !== '時間')} label={`${child.item.title}の詳細`} />
      </td>
    </tr>
  );
}

/** A travel leg is two thin rows: the start row (departure time) and the end row (arrival time). */
function LegTableRows({ row, open, selected, dayDate, onToggle }: { row: LegRow; open: boolean; selected: boolean; dayDate: string; onToggle: () => void }) {
  const detailId = `it-d-${row.key}`;
  const cls = `it-conn${selected ? ' it-on' : ''}${row.stale ? ' it-stale' : ''}`;
  return (
    <>
      <tr className={`${cls} it-conn-start`} data-leg-key={row.key}>
        <th scope="row" className="it-time"><span className="it-tm">出発 </span><TimeText text={row.departure} /></th>
        <td>
          <button type="button" className="it-connbtn" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
            <span aria-hidden="true">↓</span> {row.fromName}から <span className="it-legmode">{row.summary}</span>
            {row.stale && <span className="it-stale-tag">要再計算</span>}
          </button>
        </td>
      </tr>
      <tr className={`${cls} it-conn-end`} data-leg-key={row.key}>
        <th scope="row" className="it-time"><span className="it-tm">到着 </span><TimeText text={row.arrival} /></th>
        <td className="meta">{row.toName}へ</td>
      </tr>
      {open && (
        <tr id={detailId} className="it-detail" data-detail-leg="1">
          <td colSpan={2}><DetailList lines={legDetails(row, dayDate)} label={`${row.fromName}から${row.toName}への移動の詳細`} /></td>
        </tr>
      )}
    </>
  );
}

