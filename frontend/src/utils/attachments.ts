import { AttachmentInfo } from '../types/api';

// Inline MIME parts (cid: images and layout spacers) stay on the message so
// EmailFrame can resolve cid: references, but they should not clutter the
// attachment download bar. Only real file attachments are listed.
export const downloadableAttachments = (
  attachments?: AttachmentInfo[] | null,
): AttachmentInfo[] => (attachments ?? []).filter((att) => !att.isInline);
