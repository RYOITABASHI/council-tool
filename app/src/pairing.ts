import { claimPairing, FacadeError } from './api';
import { loadSettings, saveConnectionIfUnset } from './storage';

/** The facade may still be starting when the app opens: a few short retries. */
const claimAttempts = 5;
const retryDelayMs = 1_500;

let attempt: Promise<boolean> | undefined;

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/**
 * The claim cannot be repeated, so a failed write is retried a few times before giving up. Each
 * write is conditional: a connection saved by hand in the meantime wins over the claimed one.
 */
async function saveClaim(facadeUrl: string, token: string): Promise<boolean> {
  for (let index = 0; index < 3; index += 1) {
    try {
      return await saveConnectionIfUnset({ facadeUrl, token });
    } catch {
      await delay(300);
    }
  }
  return false;
}

async function pairOnce(): Promise<boolean> {
  for (let index = 0; index < claimAttempts; index += 1) {
    // Settings may have been entered by hand meanwhile: never claim over saved settings.
    const current = await loadSettings();
    if (current.facadeUrl.trim() || current.token.trim()) return false;
    try {
      const { baseUrl, token } = await claimPairing();
      // The claim is one-shot on the facade side; persist before anything else uses it.
      // Only the facade's answer is stored; nothing about it is logged or shown.
      return await saveClaim(baseUrl, token);
    } catch (error) {
      // Up but not armed (or already claimed by someone): retrying cannot succeed.
      if (error instanceof FacadeError && error.kind !== 'unreachable') return false;
    }
    if (index < claimAttempts - 1) await delay(retryDelayMs);
  }
  return false;
}

/**
 * First-run automatic pairing (pairing-design.md). When no connection is saved, claims the
 * connection from the facade on this device and saves it into the normal settings. Runs at most
 * once per app launch (later calls share the first one's result); once settings are saved it
 * never claims again. Resolves to whether a connection was claimed and saved; failures leave the
 * settings untouched (samples and manual setup stay available).
 */
export function pairIfUnconfigured(): Promise<boolean> {
  attempt ??= pairOnce().catch(() => false);
  return attempt;
}
