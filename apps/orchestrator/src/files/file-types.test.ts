import { describe, expect, it } from 'vitest';
import { IMAGE_EXTS, VIDEO_EXTS, extOf, imageMime, isImage, isInline, isText, isTextLike, isVideo, kindFor, mimeFor, servePolicy } from './file-types';

describe('file types', () => {
  it('finds the extension of a name, a path or a bare extension, in any case', () => {
    expect(extOf('Photo.PNG')).toBe('png');
    expect(extOf('/a/b.c/кухня 2.JPG')).toBe('jpg');
    expect(extOf('MP4')).toBe('mp4');
    expect(extOf('noext')).toBe('noext');
    expect(extOf('')).toBe('');
  });

  it('mime and kind by extension, unknown → binary', () => {
    expect(mimeFor('png')).toBe('image/png');
    expect(mimeFor('a.PDF')).toBe('application/pdf');
    expect(mimeFor('x.md')).toBe('text/markdown');
    expect(mimeFor('x.mkv')).toBe('video/x-matroska');
    expect(mimeFor('xyz')).toBe('application/octet-stream');
    expect(mimeFor('page.html')).toBe('application/octet-stream'); // never rendered
    expect(kindFor('MD')).toBe('text');
    expect(kindFor('jpg')).toBe('image');
    expect(kindFor('pdf')).toBe('pdf');
    expect(kindFor('docx')).toBe('file');
    expect(kindFor('mkv')).toBe('video');
    expect(kindFor('html')).toBe('file');
  });

  it('kind predicates', () => {
    expect(isImage('a.WEBP')).toBe(true);
    expect(isVideo('a.3gp')).toBe(true);
    expect(isVideo('a.gif')).toBe(false);
    expect(isText('a.csv')).toBe(true);
    expect(isText('a.html')).toBe(false);
    expect(isTextLike('a.html')).toBe(true);
    expect(isTextLike('a.pdf')).toBe(false);
    expect(IMAGE_EXTS).toEqual(['png', 'jpg', 'jpeg', 'webp', 'gif']);
    expect(VIDEO_EXTS).toEqual(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp']);
    expect(imageMime('x.png')).toBe('image/png');
    expect(imageMime('x.bin')).toBe('image/jpeg');
  });

  it('inline only for pictures, PDF and playable video; text as text/plain; everything else downloads', () => {
    for (const n of ['a.png', 'a.jpg', 'a.pdf', 'a.mp4', 'a.webm', 'a.mov']) expect(isInline(n), n).toBe(true);
    for (const n of ['a.mkv', 'a.html', 'a.svg', 'a.js', 'a.docx', 'a.txt']) expect(isInline(n), n).toBe(false);
    expect(servePolicy('a.PNG')).toEqual({ mime: 'image/png', inline: true, text: false });
    expect(servePolicy('n.md')).toEqual({ mime: 'text/plain; charset=utf-8', inline: true, text: true });
    expect(servePolicy('p.html')).toEqual({ mime: 'application/octet-stream', inline: false, text: false });
    expect(servePolicy('p.svg')).toEqual({ mime: 'application/octet-stream', inline: false, text: false });
    expect(servePolicy('r.docx')).toMatchObject({ inline: false, mime: /wordprocessingml/ });
    expect(servePolicy('v.mkv')).toEqual({ mime: 'video/x-matroska', inline: false, text: false });
  });
});
