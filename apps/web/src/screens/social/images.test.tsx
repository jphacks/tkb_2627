import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { POST_IMAGE_MAX_BYTES, type PostImage } from '@tkb/contracts';
import { addImages, checkImageFiles, gridCells, ImagePicker, MAX_POST_IMAGES, PostImages, type UploadedImage } from './images.tsx';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const file = (name: string, type: string, size = 1000) => new File([new Uint8Array(size)], name, { type });
const image = (id: string): PostImage => ({ imageId: id, url: `/api/v1/post-images/${id}`, width: null, height: null });
const uploaded = (id: string): UploadedImage => ({ imageId: id, url: `/api/v1/post-images/${id}`, name: `${id}.jpg` });

describe('checkImageFiles (U09 images, #36 point 6)', () => {
  it('accepts JPEG, PNG and WebP and rejects other types with a Japanese message', () => {
    const r = checkImageFiles([file('a.jpg', 'image/jpeg'), file('b.png', 'image/png'), file('c.webp', 'image/webp'), file('d.gif', 'image/gif'), file('e.heic', '')], 0);
    expect(r.accepted.map(f => f.name)).toEqual(['a.jpg', 'b.png', 'c.webp']);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain('「d.gif」は使えない形式です');
  });

  it('rejects a file over 5MB and keeps one exactly at the limit', () => {
    const r = checkImageFiles([file('ok.jpg', 'image/jpeg', POST_IMAGE_MAX_BYTES), file('big.jpg', 'image/jpeg', POST_IMAGE_MAX_BYTES + 1)], 0);
    expect(r.accepted.map(f => f.name)).toEqual(['ok.jpg']);
    expect(r.errors[0]).toContain('5MB を超えています');
  });

  it('counts the images already attached toward the limit of 4', () => {
    expect(MAX_POST_IMAGES).toBe(4);
    const r = checkImageFiles([file('1.jpg', 'image/jpeg'), file('2.jpg', 'image/jpeg'), file('3.jpg', 'image/jpeg')], 2);
    expect(r.accepted.map(f => f.name)).toEqual(['1.jpg', '2.jpg']);
    expect(r.errors).toEqual(['「3.jpg」は追加できません。画像は 4 枚までです。']);
  });
});

describe('addImages', () => {
  it('uploads only the accepted files, in order, and appends the results', async () => {
    const upload = vi.fn(async (f: File) => ({ ok: true as const, image: image(`id_${f.name}`) }));
    const r = await addImages([uploaded('old')], [file('a.jpg', 'image/jpeg'), file('x.gif', 'image/gif'), file('b.png', 'image/png')], upload);
    expect(upload.mock.calls.map(c => c[0].name)).toEqual(['a.jpg', 'b.png']);
    expect(r.next).toEqual([uploaded('old'), { imageId: 'id_a.jpg', url: '/api/v1/post-images/id_a.jpg', name: 'a.jpg' }, { imageId: 'id_b.png', url: '/api/v1/post-images/id_b.png', name: 'b.png' }]);
    expect(r.errors).toHaveLength(1);
  });

  it('reports a failed or thrown upload and keeps the other files', async () => {
    const upload = vi.fn(async (f: File) => {
      if (f.name === 'bad.jpg') return { ok: false as const, error: '保存できませんでした' };
      if (f.name === 'net.jpg') throw new Error('offline');
      return { ok: true as const, image: image('good') };
    });
    const r = await addImages([], [file('bad.jpg', 'image/jpeg'), file('net.jpg', 'image/jpeg'), file('good.jpg', 'image/jpeg')], upload);
    expect(r.next.map(i => i.imageId)).toEqual(['good']);
    expect(r.errors).toEqual([
      '「bad.jpg」をアップロードできませんでした：保存できませんでした',
      '「net.jpg」をアップロードできませんでした。通信を確かめて、もう一度選んでください。',
    ]);
  });

  it('does not call upload at all when nothing passes the checks', async () => {
    const upload = vi.fn();
    await addImages([1, 2, 3, 4].map(i => uploaded(`u${i}`)), [file('a.jpg', 'image/jpeg')], upload);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('ImagePicker', () => {
  it('offers a file input limited to the allowed types, with thumbnails and a remove button per image', () => {
    const html = render(<ImagePicker value={[uploaded('a'), uploaded('b')]} onChange={() => {}} upload={async () => ({ ok: false, error: '' })} />);
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('2 / 4 枚');
    expect((html.match(/>削除</g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="「a.jpg」を削除"');
  });

  it('disables the input once 4 images are attached', () => {
    const html = render(<ImagePicker value={[1, 2, 3, 4].map(i => uploaded(`u${i}`))} onChange={() => {}} upload={async () => ({ ok: false, error: '' })} />);
    expect(html).toMatch(/type="file"[^>]*disabled=""/);
    expect(html).toContain('これ以上は追加できません');
  });
});

describe('PostImages grid', () => {
  it('renders nothing without images', () => {
    expect(render(<PostImages images={undefined} />)).toBe('');
    expect(render(<PostImages images={[]} />)).toBe('');
  });

  it('shows one cell per image (at most 4), each a button that opens it large', () => {
    for (const n of [1, 2, 3, 4]) {
      const html = render(<PostImages images={Array.from({ length: n }, (_, i) => image(`i${i}`))} />);
      expect((html.match(/class="sns-image-cell"/g) ?? []).length).toBe(n);
      expect(html).toContain(`投稿の画像（${n} 枚）`);
      expect(html).toContain(`画像 1 / ${n} を拡大`);
    }
  });

  it('lays out 1–4 images like Twitter: wide, side by side, tall + two stacked, 2×2', () => {
    expect(gridCells(1)).toEqual([{ gridColumn: '1 / 3', gridRow: '1 / 3' }]);
    expect(gridCells(2).map(c => c.gridColumn)).toEqual(['1', '2']);
    expect(gridCells(3)).toEqual([{ gridColumn: '1', gridRow: '1 / 3' }, { gridColumn: '2', gridRow: '1' }, { gridColumn: '2', gridRow: '2' }]);
    const four = gridCells(4).map(c => `${String(c.gridColumn)}/${String(c.gridRow)}`);
    expect(new Set(four).size).toBe(4);
  });
});
