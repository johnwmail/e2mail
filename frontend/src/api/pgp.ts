import { createPgpService } from '@e2mail/shared/pgp';
import { getBrowserClient } from './client';

export {
  createPgpService,
  extractTextFromMime,
  isAsciiText,
  fileToPublicKeyArmor,
  fileToPrivateKeyArmor,
} from '@e2mail/shared/pgp';
export type {
  PgpKeyPair,
  PgpContactKey,
  ParsedKeyInfo,
  CloudKeyringPayload,
} from '@e2mail/shared/pgp';

export const pgpService = createPgpService(getBrowserClient());
