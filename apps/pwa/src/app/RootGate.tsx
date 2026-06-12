import { Navigate } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { ClosurePinGate } from '@/components/ClosurePinGate';
import { getDisplayMode, isSetupComplete } from '@/lib/auth';

/**
 * Root gate (W8A). Decides what `/` renders, synchronously from localStorage so
 * there is no flicker and no fallback drift:
 *   - not set up   → /onboarding
 *   - direct mode  → /blackbox (BLACK BOX is visible)
 *   - covert mode  → Stillpoint (the meditation disguise) right here
 */
export function RootGate(): JSX.Element {
  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
  }
  if (getDisplayMode() === 'direct') {
    return <Navigate to="/blackbox" replace />;
  }
  return (
    <ClosurePinGate>
      <MeditationHome />
    </ClosurePinGate>
  );
}
