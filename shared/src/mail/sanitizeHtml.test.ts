import { describe, expect, it } from 'vitest';
import {
  isPgpArmored,
  replaceCidImages,
  rewriteRemoteImages,
  sanitizeMailHtml,
} from './sanitizeHtml';

describe('sanitizeMailHtml', () => {
  it('strips scripts and event handlers', () => {
    const dirty = `<p onclick="alert(1)">Hi</p><script>alert(2)</script><a href="javascript:alert(3)">x</a>`;
    const clean = sanitizeMailHtml(dirty);
    expect(clean).not.toMatch(/script/i);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toMatch(/javascript:/i);
  });
});

describe('rewriteRemoteImages', () => {
  it('blanks https image sources when remote is blocked', () => {
    const html = `<img src="https://evil.example/track.gif" width="1">`;
    expect(rewriteRemoteImages(html, false)).not.toContain('https://evil.example');
    expect(rewriteRemoteImages(html, true)).toContain('https://evil.example');
  });
});

describe('replaceCidImages', () => {
  it('substitutes cid URLs', () => {
    const html = `<img src="cid:logo@mail">`;
    expect(replaceCidImages(html, { 'logo@mail': 'data:image/png;base64,abc' })).toContain(
      'data:image/png;base64,abc'
    );
  });
});

describe('isPgpArmored', () => {
  it('detects PGP messages', () => {
    expect(isPgpArmored('-----BEGIN PGP MESSAGE-----\n…')).toBe(true);
    expect(isPgpArmored('hello')).toBe(false);
  });
});
