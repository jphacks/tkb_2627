/**
 * U09 Twitter-like post card (feed, detail, own posts): avatar + name + 「あなた」 badge for own posts, text, image grid,
 * action row (heart with count) and a … menu (修正 / 削除) that exists only on the viewer's own posts.
 * Presentational: every action is a callback; nothing here talks to the API.
 */
import { useEffect, useRef, useState } from 'react';
import type { ApiError, PostAuthor, PostImage, PostSummary } from '@tkb/contracts';
import { formatDay } from '../../lib/format.ts';
import { imageSrc } from './api.ts';
import { postTimeLabel } from './postActions.ts';
import { ResultError, VisibilityChip } from './views.tsx';

export const IMAGE_ALT = '投稿の画像';

export function Avatar({ author, fallbackName }: { author: PostAuthor | undefined; fallbackName: string }) {
  const initial = author?.avatarInitial ?? ([...fallbackName][0] ?? '?');
  return (
    <span className="s9-avatar" style={{ background: author?.avatarColor ?? '#718096' }} aria-hidden="true">
      {initial}
    </span>
  );
}

export function PostImages({ images }: { images: readonly PostImage[] | undefined }) {
  if (!images || images.length === 0) return null;
  return (
    <div className={`s9-imgs s9-imgs-${images.length}`}>
      {images.map(img => (
        <img key={img.imageId} src={imageSrc(img.url)} alt={IMAGE_ALT} loading="lazy" decoding="async" />
      ))}
    </div>
  );
}

export interface PostCardProps {
  post: PostSummary;
  /** Detail screen: the title is a heading, not a button. */
  detail?: boolean;
  /** The viewer is logged in (like / follow need a session). */
  loggedIn?: boolean;
  /** Is the author followed by the viewer? undefined = not known yet. */
  followed?: boolean | undefined;
  onOpen?: (postId: string) => void;
  onLike?: (post: PostSummary) => void;
  onFollow?: (userId: string, follow: boolean) => void;
  /** Resolves to null on success, or the API error. */
  onSaveStory?: (post: PostSummary, story: string) => Promise<ApiError | null>;
  onDelete?: (post: PostSummary) => Promise<ApiError | null>;
}

export function PostCard({ post, detail = false, loggedIn = false, followed, onOpen, onLike, onFollow, onSaveStory, onDelete }: PostCardProps) {
  const mine = post.isMine === true;
  const name = post.author?.displayName ?? post.authorDisplayName;
  const likeCount = post.likeCount ?? 0;
  const liked = post.likedByMe === true;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.story);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; error: ApiError } | null>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const hasMenu = mine && (onSaveStory !== undefined || onDelete !== undefined);

  useEffect(() => {
    if (menuOpen) firstItem.current?.focus();
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuBtn.current?.focus();
  };

  async function save() {
    if (!onSaveStory) return;
    setBusy(true);
    setError(null);
    const e = await onSaveStory(post, draft);
    setBusy(false);
    if (e) setError({ title: '修正を保存できませんでした', error: e });
    else setEditing(false);
  }
  async function remove() {
    if (!onDelete) return;
    setBusy(true);
    setError(null);
    const e = await onDelete(post);
    setBusy(false);
    if (e) setError({ title: '削除できませんでした', error: e });
  }

  return (
    <article className={`s9-post${mine ? ' s9-mine' : ''}${detail ? ' s9-detail' : ''}`} aria-label={`${name}の投稿`}>
      <Avatar author={post.author} fallbackName={name} />
      <div className="s9-main">
        <header className="s9-head">
          <span className="s9-name">{name}</span>
          {mine && <span className="s9-me-badge">あなた</span>}
          <span className="s9-time">
            · {postTimeLabel(post.createdAt)}
            {post.updatedAt ? '（編集済み）' : ''}
          </span>
          <span className="s9-head-end">
            {!mine && loggedIn && onFollow && post.author && (
              <button
                type="button"
                className={`s9-follow${followed ? ' s9-following' : ''}`}
                aria-pressed={followed === true}
                disabled={followed === undefined}
                onClick={() => onFollow(post.author!.userId, !followed)}
              >
                {followed ? 'フォロー中' : 'フォロー'}
                <span className="s9-sr"> {name}</span>
              </button>
            )}
            {hasMenu && (
              <span className="s9-menu-wrap">
                <button
                  ref={menuBtn}
                  type="button"
                  className="s9-icon"
                  aria-label="投稿のメニュー"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(o => !o)}
                >
                  …
                </button>
                {menuOpen && (
                  <div
                    className="s9-menu"
                    role="menu"
                    aria-label="投稿のメニュー"
                    onKeyDown={e => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        closeMenu();
                      }
                    }}
                  >
                    {onSaveStory && (
                      <button
                        ref={firstItem}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setDraft(post.story);
                          setEditing(true);
                          setConfirmDelete(false);
                        }}
                      >
                        修正
                      </button>
                    )}
                    {onDelete && (
                      <button
                        {...(onSaveStory ? {} : { ref: firstItem })}
                        type="button"
                        role="menuitem"
                        className="s9-danger"
                        onClick={() => {
                          setMenuOpen(false);
                          setEditing(false);
                          setConfirmDelete(true);
                        }}
                      >
                        削除
                      </button>
                    )}
                  </div>
                )}
              </span>
            )}
          </span>
        </header>

        {detail || !onOpen ? (
          <h2 className="s9-title">{post.title}</h2>
        ) : (
          <button type="button" className="s9-open" onClick={() => onOpen(post.postId)}>
            <span className="s9-title">{post.title}</span>
          </button>
        )}
        <p className="meta s9-meta">
          {post.area} / {formatDay(post.startDate)}〜 / <VisibilityChip visibility={post.visibility} />
          {detail && <> / 版 {post.postRevision}</>}
        </p>

        {editing ? (
          <div className="s9-edit">
            <label htmlFor={`s9-edit-${post.postId}`} className="s9-sr">旅行記録を修正</label>
            <textarea id={`s9-edit-${post.postId}`} rows={4} maxLength={5000} value={draft} onChange={e => setDraft(e.target.value)} />
            <div className="u1-actions">
              <button type="button" className="btn u1-primary" disabled={busy || draft === post.story} onClick={() => void save()}>
                {busy ? '保存中…' : '保存'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>キャンセル</button>
            </div>
          </div>
        ) : (
          post.story !== '' && <p className="s8-story s9-story">{post.story}</p>
        )}

        <PostImages images={post.images} />

        {confirmDelete && (
          <div className="u1-error" role="alert">
            <strong>この投稿を削除します。元に戻せません。</strong>
            <div className="u1-actions">
              <button type="button" className="btn u1-danger" disabled={busy} onClick={() => void remove()}>削除する</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>やめる</button>
            </div>
          </div>
        )}
        {error && <ResultError title={error.title} error={error.error} />}

        <footer className="s9-actions">
          <button
            type="button"
            className={`s9-like${liked ? ' s9-liked' : ''}`}
            aria-pressed={liked}
            aria-label={`いいね ${likeCount}件`}
            disabled={!loggedIn || !onLike}
            title={loggedIn ? undefined : 'ログインするといいねできます'}
            onClick={() => onLike?.(post)}
          >
            <span aria-hidden="true" className="s9-heart">{liked ? '♥' : '♡'}</span>
            <span className="s9-count">{likeCount}</span>
          </button>
        </footer>
      </div>
    </article>
  );
}
