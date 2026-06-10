import { createBrowserRouter } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { Dashboard } from '@/routes/dashboard/Dashboard';
import { Settings } from '@/routes/settings/Settings';
import { Onboarding } from '@/routes/onboarding/Onboarding';
import { History } from '@/routes/history/History';

// The router is the only place the facade and the dashboard meet. The view
// components themselves never import one another — they share design tokens
// and nothing else.
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/', element: <MeditationHome /> },
  { path: '/dashboard', element: <Dashboard /> },
  { path: '/settings', element: <Settings /> },
  { path: '/onboarding', element: <Onboarding /> },
  { path: '/history', element: <History /> },
]);
