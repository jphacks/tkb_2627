import './hub.css';

/** Small fixed 「ホーム」 link. Other screens may include it; it only changes the hash. */
export function HomeLink() {
  return (
    <a href="#home" className="hub-homelink" aria-label="ホームへ戻る">
      ⌂ ホーム
    </a>
  );
}
