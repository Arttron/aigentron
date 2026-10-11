/** Files the composer accepts: images, PDF and video. */
export const ATTACH_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv';

const MAX_SIDE = 2048;

export const isVideo = (name: string, mime?: string): boolean =>
  (mime ?? '').startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(name);

/**
 * Photos from a phone are 4000+ px with EXIF (GPS!). Re-encode a big photo as a ≤2048 px JPEG through a canvas —
 * that also drops the metadata. Anything else (small images, GIF, PDF, video) passes through untouched.
 */
export async function prepareFile(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const camera = file.type === 'image/jpeg';
    if (scale === 1 && !camera) {
      bmp.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** Live camera needs a secure context (HTTPS / localhost); otherwise fall back to the phone's own camera app. */
export const hasLiveCamera = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
