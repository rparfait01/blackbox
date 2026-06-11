import { createBrowserRouter } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { Settings } from '@/routes/settings/Settings';

// Stillpoint is the entire visible app for the USER. Covert design: every URL
// the user might reach renders Stillpoint — no 404, no error page, no other
// visible page.
//
// The contact's live dashboard is NOT here: as of W7 it is served as a
// self-contained HTML page by the Worker at <worker-origin>/c/:id (so it can
// render the location pin without JS and return a real 401 on a bad token).
// That surface is on the contact's own device — loud and clear, not covert.
//
// - The "*" catch-all renders Stillpoint for any unknown path.
// - errorElement renders Stillpoint if any route throws at runtime, so a
//   rendering failure falls back silently instead of leaking a dev error UI.
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/', element: <MeditationHome />, errorElement: <MeditationHome /> },
  { path: '/settings', element: <Settings />, errorElement: <MeditationHome /> },
  { path: '*', element: <MeditationHome />, errorElement: <MeditationHome /> },
]);
