/**
 * Post images (UI review #36 point 6). Owned by M3 (U09 split, #188): the picker/preview UX and the image grid.
 * M1's timeline (U09) only imports these two components with the props below — keep the props stable.
 */
import type { PostImage } from '@tkb/contracts';

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

/** Placeholder until M3 lands the real picker (file input, type/size/count checks, thumbnails, remove). */
export function ImagePicker(_props: ImagePickerProps) {
  return null;
}

/** Twitter-like image grid for a post. Placeholder: plain list until M3 lands the grid. */
export function PostImages({ images }: { images: readonly PostImage[] | undefined }) {
  if (!images || images.length === 0) return null;
  return (
    <div className="sns-images">
      {images.map(i => <img key={i.imageId} src={i.url} alt="投稿の画像" loading="lazy" />)}
    </div>
  );
}
