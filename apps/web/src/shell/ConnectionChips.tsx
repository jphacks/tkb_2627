import { useCallback, useEffect, useState } from 'react';
import type { Capabilities } from '@tkb/contracts';
import { probeConnections, type ConnectionState, type Probe } from '../lib/api.ts';

function aiText(c: Capabilities): string {
  const ai = c.aiGeneration;
  return ai.available ? `AI生成: 利用可（${ai.runner}）` : `AI生成: 利用不可${ai.reason ? `（${ai.reason}）` : ''}`;
}

function Chip({ label, probe, detail }: { label: string; probe: Probe<unknown> | null; detail?: string }) {
  const state = probe === null ? 'pending' : probe.ok ? 'ok' : 'down';
  const text = probe === null ? '確認中' : probe.ok ? '接続OK' : '未起動';
  return (
    <li className={`chip chip-${state}`}>
      <span className="chip-label">{label}</span>
      <strong>{text}</strong>
      {detail && <span className="chip-detail">{detail}</span>}
    </li>
  );
}

export function ConnectionChips() {
  const [st, setSt] = useState<ConnectionState | null>(null);
  const check = useCallback(() => {
    setSt(null);
    void probeConnections().then(setSt);
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    void probeConnections(ctl.signal).then(setSt);
    return () => ctl.abort();
  }, []);

  return (
    <section aria-label="接続状態" className="conn">
      <ul className="chips">
        <Chip label="共有サーバー" probe={st?.health ?? null} />
        <Chip label="共有の機能" probe={st?.shared ?? null} detail={st?.shared.ok ? aiText(st.shared.data) : undefined} />
        <Chip label="本人用（localhost）" probe={st?.personal ?? null} detail={st?.personal.ok ? aiText(st.personal.data) : undefined} />
      </ul>
      <button type="button" className="btn" onClick={check}>再確認</button>
    </section>
  );
}
