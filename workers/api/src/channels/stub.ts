/**
 * Placeholder channels (W-spine). push / telegram / sms / email are part of the
 * model but not implemented in v0. Each method returns false — "not delivered" —
 * so the NotificationRouter treats the endpoint as a failed delivery and moves
 * on to the next endpoint by priority. Building a real channel means replacing
 * the stub with an implementation and registering it in the router's factory;
 * no schema change, no call-site change.
 *
 * push is the highest-priority channel to build next — it removes the
 * third-party-messaging-app dependency entirely.
 */

import type { ChannelName, NotificationChannel } from './types';

export class StubChannel implements NotificationChannel {
  constructor(readonly channel: ChannelName) {}

  private unimplemented(messageType: string): Promise<boolean> {
    console.log(
      JSON.stringify({ channel: this.channel, messageType, status: 'not_implemented' }),
    );
    return Promise.resolve(false);
  }

  pushActivationAlert(): Promise<boolean> {
    return this.unimplemented('activation');
  }
  pushClassificationUpdate(): Promise<boolean> {
    return this.unimplemented('classification');
  }
  pushClosureRequest(): Promise<boolean> {
    return this.unimplemented('closure');
  }
  pushDuressAlert(): Promise<boolean> {
    return this.unimplemented('duress');
  }
  pushClosureConfirmation(): Promise<boolean> {
    return this.unimplemented('closure_confirm');
  }
  pushStandDownConfirmation(): Promise<boolean> {
    return this.unimplemented('stand_down_confirm');
  }
}
