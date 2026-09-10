import { getRememberedPassphrase } from './passphrase';

export interface PassphrasePromptOptions {
  title?: string;
  subtitle?: string;
  /** Offer the "remember on this device" (biometric-gated) option. */
  allowPersist?: boolean;
}

export interface PendingPassphrasePrompt {
  options: PassphrasePromptOptions;
  resolve: (value: string | null) => void;
}

let pending: PendingPassphrasePrompt | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribePassphrasePrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPendingPassphrasePrompt(): PendingPassphrasePrompt | null {
  return pending;
}

/**
 * Resolve a passphrase for PGP decrypt/sign. Returns the in-memory passphrase
 * immediately when already unlocked, otherwise opens the `PassphrasePrompt`
 * modal and resolves with the value (or null when cancelled).
 */
export function requestPassphrase(
  options: PassphrasePromptOptions = {}
): Promise<string | null> {
  const cached = getRememberedPassphrase();
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    pending = { options, resolve };
    emit();
  });
}

export function resolvePassphrase(value: string | null): void {
  const current = pending;
  pending = null;
  emit();
  current?.resolve(value);
}
