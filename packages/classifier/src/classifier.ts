import type { Classification, ClassificationContext } from './types';

/**
 * The single intelligence-layer interface. W4 adds `LocalClassifier` (the
 * keyword + tone safety floor) implementing this; future phases may add others.
 */
export interface Classifier {
  classify(transcript: string, context: ClassificationContext): Promise<Classification | null>;
}

/**
 * Placeholder classifier — always returns null. Lets the rest of the system be
 * wired and tested before the real classifier exists (W4).
 */
export class NoOpClassifier implements Classifier {
  classify(
    _transcript: string,
    _context: ClassificationContext,
  ): Promise<Classification | null> {
    return Promise.resolve(null);
  }
}
