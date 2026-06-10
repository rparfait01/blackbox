import { createBrowserRouter } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { Settings } from '@/routes/settings/Settings';

// Stillpoint is the entire visible app. Covert design: every URL renders
// Stillpoint. There is no 404, no error page, no other visible page.
//
// - The "*" catch-all renders Stillpoint for any unknown path.
// - errorElement renders Stillpoint if any route throws at runtime, so a
//   rendering failure falls back silently instead of leaking a dev error UI.
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/', element: <MeditationHome />, errorElement: <MeditationHome /> },
  { path: '/settings', element: <Settings />, errorElement: <MeditationHome /> },
  { path: '*', element: <MeditationHome />, errorElement: <MeditationHome /> },
]);
