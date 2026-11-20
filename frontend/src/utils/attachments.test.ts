import { describe, it, expect } from 'vitest';
import { downloadableAttachments } from './attachments';
import { AttachmentInfo } from '../types/api';

const att = (id: string, isInline: boolean): AttachmentInfo => ({
  id,
  filename: `${id}.bin`,
  contentType: 'application/octet-stream',
  size: 1,
  isInline,
});

describe('downloadableAttachments', () => {
  it('hides inline MIME parts from the attachment bar', () => {
    const result = downloadableAttachments([att('file', false), att('inline', true), att('file2', false)]);
    expect(result.map((a) => a.id)).toEqual(['file', 'file2']);
  });

  it('handles missing attachments', () => {
    expect(downloadableAttachments(undefined)).toEqual([]);
    expect(downloadableAttachments(null)).toEqual([]);
  });
});
