import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmailFrame, computeFitScale } from './EmailFrame';
import type { AttachmentInfo } from '../../types/api';

vi.mock('../../api/pgp', () => ({
  pgpService: {
    isPgpEncrypted: (s: string) => typeof s === 'string' && s.includes('BEGIN PGP'),
    ensureKey: vi.fn(),
    isPrivateKeyEncrypted: vi.fn(),
    decrypt: vi.fn(),
  },
}));

vi.mock('../../api/mail', () => ({
  mailApi: {
    getAttachmentUrl: (uid: number, id: string, folder: string) =>
      `/api/mail/attachment?uid=${uid}&id=${id}&folder=${folder}`,
  },
}));

const noAttachments: AttachmentInfo[] = [];

const renderFrame = (props: Partial<React.ComponentProps<typeof EmailFrame>> = {}) =>
  render(
    <EmailFrame
      uid={1}
      folder="INBOX"
      htmlBody=""
      textBody=""
      attachments={noAttachments}
      {...props}
    />,
  );

const getFrame = () =>
  document.querySelector('iframe[title="Email Body View"]') as HTMLIFrameElement;

describe('computeFitScale', () => {
  it('shrinks wide email to pane width', () => {
    expect(computeFitScale(390, 602)).toBeCloseTo(390 / 602, 5);
  });
  it('never upscales content that already fits', () => {
    expect(computeFitScale(800, 602)).toBe(1);
    expect(computeFitScale(390, 390)).toBe(1);
  });
  it('clamps absurdly wide emails at the readable floor', () => {
    expect(computeFitScale(320, 2000)).toBe(0.45);
  });
  it('is neutral before measurement', () => {
    expect(computeFitScale(0, 602)).toBe(1);
    expect(computeFitScale(390, 0)).toBe(1);
  });
});

describe('EmailFrame', () => {
  it('sandboxes the mail iframe with same-origin measurement but never scripts', () => {
    renderFrame({ htmlBody: '<p>hi</p>' });
    const sandbox = getFrame().getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).toContain('allow-popups');
  });

  it('injects viewport meta + reflow-assist CSS into the srcdoc', () => {
    renderFrame({ htmlBody: '<table><tr><td>hello</td></tr></table>' });
    const doc = getFrame().srcdoc;
    expect(doc).toContain('name="viewport"');
    expect(doc).toContain('max-width: 100% !important');
    expect(doc).toContain('hello');
  });

  it('strips scripts from malicious html', () => {
    renderFrame({
      htmlBody: '<p>safe</p><script>window.x=1</script><img src="x" onerror="alert(1)">',
    });
    const doc = getFrame().srcdoc;
    expect(doc).not.toContain('<script');
    expect(doc).not.toContain('onerror');
    expect(doc).toContain('safe');
  });

  it('blocks remote images by default and restores them on demand', () => {
    renderFrame({
      htmlBody: '<img src="https://track.example/pixel.gif" width="600" height="80"><p>body</p>',
    });
    const blocked = getFrame().srcdoc;
    expect(blocked).toContain('data-blocked-src="https://track.example/pixel.gif"');
    expect(blocked).toContain('src=""');
    // 原屬性（width/height）保留在 tag 內，唔再漏出 tag 外變成雜訊文字
    expect(blocked).toContain('width="600"');
    expect(blocked).not.toContain('&gt; width');

    fireEvent.click(screen.getByRole('button', { name: /顯示圖片/ }));
    const allowed = getFrame().srcdoc;
    expect(allowed).toContain('src="https://track.example/pixel.gif"');
    expect(allowed).not.toMatch(/<img[^>]*data-blocked-src/);
  });

  it('auto-allows remote images for trusted senders', () => {
    renderFrame({
      htmlBody: '<img src="https://cdn.example/logo.png">',
      trustedSender: true,
    });
    expect(screen.queryByRole('button', { name: /顯示圖片/ })).not.toBeInTheDocument();
    expect(getFrame().srcdoc).toContain('src="https://cdn.example/logo.png"');
  });

  it('forces all http links to open in a new tab, neutralising _top hijacks', () => {
    renderFrame({
      htmlBody:
        '<a href="https://example.com/x">plain</a>' +
        '<a href="https://example.com/y" target="_top">hijack</a>' +
        '<a href="https://example.com/z" target="_parent" rel="external">both</a>',
    });
    const doc = getFrame().srcdoc;
    expect(doc.match(/target="_blank"/g)?.length).toBe(3);
    expect(doc).not.toContain('target="_top"');
    expect(doc).not.toContain('target="_parent"');
    expect(doc).toContain('rel="noopener noreferrer"');
    expect(doc).toContain('hijack');
    expect(doc).toContain('both');
  });

  it('leaves mailto:/tel: links to the OS (no _blank wrapper)', () => {
    renderFrame({
      htmlBody:
        '<a href="mailto:a@b.test">mail</a><a href="tel:+85212345678">tel</a>',
    });
    const doc = getFrame().srcdoc;
    expect(doc).not.toContain('target="_blank"');
    expect(doc).toContain('mail');
    expect(doc).toContain('tel');
  });

  it('keeps email <style> classes while neutralising @import and remote css urls', () => {
    renderFrame({
      htmlBody:
        '<style>.c4{border:1px solid #000000}.c27{min-width:682px}' +
        '@import url("https://track.example/x.css");' +
        '.bg{background:url(https://track.example/bg.png)}</style>' +
        '<table><tr><td class="c4">boxed</td></tr></table>',
    });
    const doc = getFrame().srcdoc;
    expect(doc).toContain('.c27{min-width:682px}');
    expect(doc).toContain('border:1px solid #000000');
    expect(doc).not.toContain('@import');
    expect(doc).not.toContain('track.example/bg.png');
    expect(doc).toContain('.bg{background:none}');
  });

  it('renders text/plain with preserved line breaks and pre-wrap', () => {
    renderFrame({ htmlBody: '', textBody: '第一行\n第二行' });
    const doc = getFrame().srcdoc;
    expect(doc).toContain('第一行<br/>第二行');
  });

  it('replaces relative-path broken images (Word placeholder gifs)', () => {
    renderFrame({
      htmlBody: '<img src="file:///C:/tmp/x.png"><img src="relative/spacer.png"><p>keep</p>',
    });
    const doc = getFrame().srcdoc;
    expect(doc).not.toContain('file:///');
    expect(doc).not.toContain('relative/spacer');
    expect(doc).toContain('keep');
  });
});
