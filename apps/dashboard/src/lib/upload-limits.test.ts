import { describe, expect, it } from 'vitest';
import { MAX_OTHER_BYTES, MAX_UPLOAD_BYTES, uploadSizeError } from './upload-limits';

describe('uploadSizeError', () => {
  it('accepts a file at the limit', () => {
    expect(uploadSizeError({ name: 'a.mp4', size: MAX_UPLOAD_BYTES })).toBeNull();
  });
  it('refuses a larger file with its name and size', () => {
    const m = uploadSizeError({ name: 'big.mp4', size: 120 * 1024 * 1024 });
    expect(m).toContain('big.mp4');
    expect(m).toContain('120 MB');
    expect(m).toContain('95 MB');
  });
  it('a video may be as big as the proxy allows, anything else only as big as the server accepts', () => {
    expect(uploadSizeError({ name: 'clip.mov', size: 50 * 1024 * 1024 })).toBeNull();
    expect(uploadSizeError({ name: 'x', size: 50 * 1024 * 1024, type: 'video/mp4' })).toBeNull();
    expect(uploadSizeError({ name: 'a.pdf', size: MAX_OTHER_BYTES })).toBeNull();
    const m = uploadSizeError({ name: 'scan.pdf', size: 30 * 1024 * 1024 });
    expect(m).toContain('scan.pdf');
    expect(m).toContain('30 MB');
    expect(m).toContain('10 MB');
  });
});
