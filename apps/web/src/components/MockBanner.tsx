import { MOCK_NOTICE } from '../mocks/index.ts';
import './u01.css';

/** Sticky banner so mock data can never be mistaken for production data. */
export function MockBanner() {
  return (
    <div role="status" className="u1-banner">
      <span className="u1-banner-tag">MOCK</span>
      <span>{MOCK_NOTICE}</span>
    </div>
  );
}
