/**
 * Post images (UI review #36 point 6). Owned by M3 (U09 split, #188): the picker/preview UX and the image grid.
 * M1's timeline (U09) only imports these two components with the props below — keep the props stable.
 * Styles live here (inline) so this file stays the only one M3 touches.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { POST_IMAGE_MAX_BYTES, POST_IMAGE_TYPES, type PostImage } from '@tkb/contracts';

/** A picked file after upload: what the compose form keeps and sends as `imageIds` (K12, max 4). */
export interface UploadedImage { imageId: string; url: string; name: string }

export interface ImagePickerProps {
  /** Images already uploaded for this draft. */
  value: UploadedImage[];
  onChange: (next: UploadedImage[]) => void;
  /** Uploads one file (POST /api/v1/post-images with CSRF); returns the stored image or an error message. */
  upload: (file: File) => Promise<{ ok: true; image: PostImage } | { ok: false; error: string }>;
  disabled?: boolean;
}

/** K12 allows at most 4 images per post. */
export const MAX_POST_IMAGES = 4;
const TYPE_LABEL = 'JPEG、PNG、WebP';
const MAX_MB = POST_IMAGE_MAX_BYTES / (1024 * 1024);

/**
 * Checks picked files before anything is sent: type, size and the 4-image limit (counting the images already
 * attached). Returns the files to upload, in order, and one Japanese message per rejected file.
 */
export function checkImageFiles(files: readonly File[], alreadyAttached: number): { accepted: File[]; errors: string[] } {
  const accepted: File[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (!(POST_IMAGE_TYPES as readonly string[]).includes(f.type)) {
      errors.push(`「${f.name}」は使えない形式です。${TYPE_LABEL} の画像を選んでください。`);
    } else if (f.size > POST_IMAGE_MAX_BYTES) {
      errors.push(`「${f.name}」は ${MAX_MB}MB を超えています。1枚 ${MAX_MB}MB までです。`);
    } else if (alreadyAttached + accepted.length >= MAX_POST_IMAGES) {
      errors.push(`「${f.name}」は追加できません。画像は ${MAX_POST_IMAGES} 枚までです。`);
    } else {
      accepted.push(f);
    }
  }
  return { accepted, errors };
}

/**
 * Checks, then uploads the accepted files one by one (so the order is kept). A failed upload is reported and the
 * others still go through. Returns the new list for `onChange` and every message to show.
 */
export async function addImages(
  value: readonly UploadedImage[],
  files: readonly File[],
  upload: ImagePickerProps['upload'],
): Promise<{ next: UploadedImage[]; errors: string[] }> {
  const { accepted, errors } = checkImageFiles(files, value.length);
  const next = [...value];
  for (const f of accepted) {
    try {
      const r = await upload(f);
      if (r.ok) next.push({ imageId: r.image.imageId, url: r.image.url, name: f.name });
      else errors.push(`「${f.name}」をアップロードできませんでした：${r.error}`);
    } catch {
      errors.push(`「${f.name}」をアップロードできませんでした。通信を確かめて、もう一度選んでください。`);
    }
  }
  return { next, errors };
}

const thumbStyle: CSSProperties = { position: 'relative', width: 96, height: 96, borderRadius: 8, overflow: 'hidden', background: '#eee' };
const imgFill: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };

/** Compose-form image picker: file input (JPEG/PNG/WebP, 5MB, up to 4), thumbnails with 削除, upload status. */
export function ImagePicker({ value, onChange, upload, disabled = false }: ImagePickerProps) {
  const [busy, setBusy] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  // The latest `value`: the parent may change it (e.g. clear the form) while an upload is running.
  const latest = useRef(value);
  latest.current = value;
  const full = value.length >= MAX_POST_IMAGES;

  const onPick = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (input.current) input.current.value = '';
    if (files.length === 0) return;
    setBusy(files.length);
    const r = await addImages(value, files, upload);
    setBusy(0);
    setErrors(r.errors);
    const added = r.next.slice(value.length);
    if (added.length > 0) onChange([...latest.current, ...added].slice(0, MAX_POST_IMAGES));
  };

  return (
    <div className="sns-image-picker">
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>画像を追加（{TYPE_LABEL}、1枚 {MAX_MB}MB まで、{MAX_POST_IMAGES} 枚まで）</span>
        <input
          ref={input}
          type="file"
          accept={POST_IMAGE_TYPES.join(',')}
          multiple
          disabled={disabled || full || busy > 0}
          onChange={e => void onPick(e.currentTarget.files)}
        />
      </label>
      <p className="meta">
        {value.length} / {MAX_POST_IMAGES} 枚{full ? '（これ以上は追加できません）' : ''}
      </p>
      {busy > 0 && <p role="status">アップロード中…（{busy} 枚）</p>}
      {errors.length > 0 && (
        <ul role="alert" style={{ color: '#b00020', margin: '4px 0', paddingLeft: 20 }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {value.length > 0 && (
        <ul aria-label="添付した画像" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, listStyle: 'none', padding: 0, margin: '4px 0' }}>
          {value.map(img => (
            <li key={img.imageId} style={thumbStyle}>
              <img src={img.url} alt={img.name} style={imgFill} />
              <button
                type="button"
                disabled={disabled || busy > 0}
                aria-label={`「${img.name}」を削除`}
                onClick={() => onChange(value.filter(v => v.imageId !== img.imageId))}
                style={{ position: 'absolute', top: 4, right: 4, padding: '2px 6px', fontSize: 12 }}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Grid cell placement by count, as on Twitter: 1 = one wide image; 2 = side by side; 3 = one tall on the left and two
 * stacked on the right; 4 = 2×2.
 */
export function gridCells(count: number): CSSProperties[] {
  if (count <= 1) return [{ gridColumn: '1 / 3', gridRow: '1 / 3' }];
  if (count === 2) return [{ gridColumn: '1', gridRow: '1 / 3' }, { gridColumn: '2', gridRow: '1 / 3' }];
  if (count === 3) return [{ gridColumn: '1', gridRow: '1 / 3' }, { gridColumn: '2', gridRow: '1' }, { gridColumn: '2', gridRow: '2' }];
  return [{ gridColumn: '1', gridRow: '1' }, { gridColumn: '2', gridRow: '1' }, { gridColumn: '1', gridRow: '2' }, { gridColumn: '2', gridRow: '2' }];
}

/** Twitter-like image grid for a post (1–4 images). Pressing an image opens it large; Esc or 閉じる closes it. */
export function PostImages({ images }: { images: readonly PostImage[] | undefined }) {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!images || images.length === 0) return null;
  const shown = images.slice(0, MAX_POST_IMAGES);
  const cells = gridCells(shown.length);
  const current = open === null ? undefined : shown[open];
  return (
    <div className="sns-images">
      <div
        role="group"
        aria-label={`投稿の画像（${shown.length} 枚）`}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 2, aspectRatio: '16 / 9', borderRadius: 12, overflow: 'hidden', maxWidth: 560 }}
      >
        {shown.map((img, i) => (
          <button
            key={img.imageId}
            type="button"
            className="sns-image-cell"
            aria-label={`画像 ${i + 1} / ${shown.length} を拡大`}
            onClick={() => setOpen(i)}
            style={{ ...cells[i], padding: 0, border: 0, background: '#eee', cursor: 'zoom-in', minHeight: 0, minWidth: 0 }}
          >
            <img src={img.url} alt="投稿の画像" loading="lazy" style={imgFill} />
          </button>
        ))}
      </div>
      {current && open !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`画像 ${open + 1} / ${shown.length}`}
          onClick={() => setOpen(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <img
            src={current.url}
            alt="投稿の画像"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
          <button type="button" autoFocus onClick={() => setOpen(null)} style={{ position: 'absolute', top: 12, right: 12 }}>
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}
