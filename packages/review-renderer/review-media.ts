export interface ReviewMediaItem {
  key: string;
  kind: 'image' | 'video';
  id: string;
  title: string;
  caption: string;
  primary: boolean;
}

/** Collect only media used in the visible article, preserving editorial order. */
export function reviewMedia(payload: any): ReviewMediaItem[] {
  const article = payload?.article;
  if (!article) return [];
  const items: ReviewMediaItem[] = [];
  const seen = new Set<string>();
  const add = (item: ReviewMediaItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  const video = (id: string, title: string, primary = false) => {
    if (!/^[\w-]{11}$/.test(id || '')) return;
    add({ key: 'video:' + id, kind: 'video', id, title, caption: '', primary });
  };
  const image = (ref: any) => {
    if (!ref?.media_id || !payload.media?.[ref.media_id]) return;
    add({ key: 'image:' + ref.media_id, kind: 'image', id: ref.media_id,
      title: ref.alt || payload.media[ref.media_id].alt || 'Imagen de la review',
      caption: ref.caption || '', primary: false });
  };
  video(article.youtube, 'Vídeo principal', true);
  image(article.cover);
  for (const block of article.blocks || []) {
    if (block.type === 'image' || block.type === 'gallery') (block.media || []).forEach(image);
    if (block.type === 'video') video(block.video, block.title || 'Vídeo de la review');
  }
  return items;
}
