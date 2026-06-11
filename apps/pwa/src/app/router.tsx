import { createBrowserRouter } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { BlackBoxHome } from '@/routes/blackbox/BlackBoxHome';
import { Settings } from '@/routes/settings/Settings';
import { Onboarding } from '@/routes/onboarding/Onboarding';
import { GuardianAccept } from '@/routes/guardian/GuardianAccept';
import { RootGate } from './RootGate';

// The contact dashboard is NOT a PWA route — it is served by the Worker at
// <worker-origin>/c/:id. Every other unknown path falls through the gate.
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/', element: <RootGate />, errorElement: <RootGate /> },
  { path: '/onboarding', element: <Onboarding />, errorElement: <MeditationHome /> },
  { path: '/blackbox', element: <BlackBoxHome />, errorElement: <MeditationHome /> },
  { path: '/settings', element: <Settings />, errorElement: <MeditationHome /> },
  { path: '/guardian-accept/:inviteId', element: <GuardianAccept />, errorElement: <MeditationHome /> },
  { path: '*', element: <RootGate />, errorElement: <RootGate /> },
]);
