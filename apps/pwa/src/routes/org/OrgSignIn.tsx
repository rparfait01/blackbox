import { useNavigate } from 'react-router-dom';

/**
 * Org sign-in — STUB (Accounts §4).
 *
 * A DISTINCT surface from the survivor's sign-in, on purpose: an organisation
 * coordinator and a survivor are different people with different threat models,
 * and conflating their entry points is how a survivor ends up looking at a portal
 * (or an aggressor at a login form) they should never see.
 *
 * This brief builds the ROUTE ONLY. The org data model, seats, coordinator-led
 * survivor enrolment, and the portal itself belong to the Tenancy brief — this
 * exists so Tenancy plugs in without a refactor of the router or of individual
 * sign-in.
 *
 * Deliberately inert: no form, no fields, nothing to submit, no org endpoint. It
 * cannot authenticate anyone, and it must not pretend it can — a login box that
 * silently does nothing is worse than an honest placeholder.
 *
 * NOT part of the Hidden facade (§0a): reachable only by typing /org. Nothing
 * links here from the survivor's app, so no account UI ever appears in the covert
 * skin.
 */
export function OrgSignIn(): JSX.Element {
  const navigate = useNavigate();
  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none flex min-h-full w-full flex-col items-center justify-center overflow-y-auto p-8 text-med-text">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 font-serif text-3xl font-light tracking-[0.04em]">Organisation sign-in</h1>
        <p className="mb-8 text-med-text/60">For partner organisations and coordinators.</p>
        <div className="mb-8 rounded-lg border border-med-text/20 bg-black/20 p-5 text-sm leading-relaxed text-med-text/70">
          Organisation accounts aren’t available yet. If your organisation is part of the pilot, your
          coordinator will send you what you need.
        </div>
        <button
          onClick={() => navigate('/signin', { replace: true })}
          className="block w-full text-center text-sm text-med-text/50 underline"
        >
          Are you here for your own account? Sign in
        </button>
      </div>
    </main>
  );
}
