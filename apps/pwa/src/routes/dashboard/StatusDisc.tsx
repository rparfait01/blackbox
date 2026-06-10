/**
 * The signature status disc. In v0 the dashboard is visually identical whether
 * dormant or active, so this always renders the dormant amber state: a slow
 * pulsing amber ring with a small amber core. (Red/active rendering is a later
 * phase and intentionally absent here.)
 */
export function StatusDisc(): JSX.Element {
  return (
    <div
      className="relative flex h-[120px] w-[120px] items-center justify-center"
      aria-hidden="true"
    >
      <div className="animate-bb-pulse motion-reduce:animate-none absolute inset-0 rounded-full border-[1.5px] border-status-armed" />
      <div className="h-[5px] w-[5px] rounded-full bg-status-armed shadow-[0_0_12px_#E89A00]" />
    </div>
  );
}
