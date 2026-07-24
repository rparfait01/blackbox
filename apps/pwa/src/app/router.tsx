import { createBrowserRouter } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { BlackBoxHome } from '@/routes/blackbox/BlackBoxHome';
import { Activation } from '@/routes/blackbox/Activation';
import { Settings } from '@/routes/settings/Settings';
import { Onboarding } from '@/routes/onboarding/Onboarding';
import { SignIn } from '@/routes/signin/SignIn';
import { MagicLink } from '@/routes/signin/MagicLink';
import { OrgSignIn } from '@/routes/org/OrgSignIn';
import { OrgRegister } from '@/routes/org/OrgRegister';
import { GuardianAccept } from '@/routes/guardian/GuardianAccept';
import { ClosurePinGate } from '@/components/ClosurePinGate';
import { RootGate } from './RootGate';

// The contact dashboard is NOT a PWA route — it is served by the Worker at
// <worker-origin>/c/:id. Every other unknown path falls through the gate.
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  { path: '/', element: <RootGate />, errorElement: <RootGate /> },
  { path: '/onboarding', element: <Onboarding />, errorElement: <MeditationHome /> },
  { path: '/signin', element: <SignIn />, errorElement: <MeditationHome /> },
  // Emailed sign-in link lands here (Accounts §1b). /forgot + /reset are GONE —
  // §2 forbids password-reset-by-email, and there is no password to reset.
  { path: '/magic', element: <MagicLink />, errorElement: <MeditationHome /> },
  // §4: org login is a DISTINCT surface from the survivor's. Stub only — Tenancy
  // owns the portal, seats, and enrollment. Registered explicitly because the
  // catch-all below would otherwise swallow it into RootGate.
  { path: '/org', element: <OrgSignIn />, errorElement: <MeditationHome /> },
  // Brief 24: org admin registration, reached only by the operator's approval link.
  // The code is entered manually on the page (never in the URL) and consumed only on
  // explicit submit. Registered before the catch-all, like /org.
  { path: '/org/register', element: <OrgRegister />, errorElement: <MeditationHome /> },
  {
    path: '/blackbox',
    element: (
      <ClosurePinGate>
        <BlackBoxHome />
      </ClosurePinGate>
    ),
    errorElement: <MeditationHome />,
  },
  // Brief 28 §2 — activation (the ARM gate). Reached from the Visible home + Settings,
  // never from the Hidden facade. Gates arming, never the trigger.
  { path: '/activate', element: <Activation />, errorElement: <MeditationHome /> },
  { path: '/settings', element: <Settings />, errorElement: <MeditationHome /> },
  { path: '/guardian-accept/:inviteId', element: <GuardianAccept />, errorElement: <MeditationHome /> },
  { path: '*', element: <RootGate />, errorElement: <RootGate /> },
]);
