export type { PayoutDestinationForProvider } from './payout-destination.provider-boundary';

// Keep the provider-module import stable while the database read remains in the service layer.
export { getPayoutDestinationForProvider } from './payout-destination.service';
