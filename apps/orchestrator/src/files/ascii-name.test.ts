import { describe, expect, it } from 'vitest';
import { asciiFileName } from './ascii-name';

describe('asciiFileName', () => {
  it.each([
    ['кухня 2.jpg', 'kukhnya-2.jpg'],
    ['Проект_дома (финал).PDF', 'Proekt_doma-final.PDF'],
    ['Щука и ёж.docx', 'Shchuka-i-ezh.docx'],
    ['Київ їжак.png', 'Kiyiv-yizhak.png'],
    ['Ελληνικά.txt', 'Ellinika.txt'],
    ['café Łódź ß.md', 'cafe-Lodz-ss.md'],
    ['plain-name_1.txt', 'plain-name_1.txt'],
    ['写真.jpg', 'file.jpg'],
    ['שלום עולם.pdf', 'file.pdf'],
    ['.hidden', 'hidden'],
    ['no extension', 'no-extension'],
    ['a..b.txt', 'a.b.txt'],
  ])('%s → %s', (input, expected) => {
    expect(asciiFileName(input)).toBe(expected);
  });

  it('is stable (applying it twice changes nothing) and always ASCII', () => {
    for (const n of ['кухня 2.jpg', 'Ελληνικά.txt', 'résumé final (v2).docx', '日本語.png', 'a/b\\c:d*.txt']) {
      const once = asciiFileName(n);
      expect(asciiFileName(once)).toBe(once);
      expect(once).toMatch(/^[\x20-\x7e]+$/);
      expect(once).not.toMatch(/[\\/:*?"<>|]/);
    }
  });
});
