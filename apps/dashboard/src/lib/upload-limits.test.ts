import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, uploadSizeError } from './upload-limits';

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
});
