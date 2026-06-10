import { createBrowserRouter } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { Settings } from '@/routes/settings/Settings';

// Stillpoint is the entire visible app. The only routes are the meditation
// home and an empty settings placeholder reserved for a later phase. There is
// no dashboard, history, or onboarding route in v0.
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/', element: <MeditationHome /> },
  { path: '/settings', element: <Settings /> },
]);
