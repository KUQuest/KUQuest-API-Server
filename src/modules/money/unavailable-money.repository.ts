import { MoneyError } from './money.errors';
import type {
  ActivityPage,
  ConvertEarningsCommand,
  EarningsConversion,
  ListActivitiesQuery,
  MoneyPolicy,
  MoneyRepository,
  ProviderWebhook,
  WalletSummary,
} from './money.types';

export class UnavailableMoneyRepository implements MoneyRepository {
  private unavailable(): never {
    throw new MoneyError(
      503,
      'PROVIDER_UNAVAILABLE',
      'The money database is not configured.',
    );
  }

  getWallet(_userId: string): Promise<WalletSummary> {
    return this.unavailable();
  }

  getPolicy(): Promise<MoneyPolicy> {
    return this.unavailable();
  }

  listActivities(
    _userId: string,
    _query: ListActivitiesQuery,
  ): Promise<ActivityPage> {
    return this.unavailable();
  }

  convertEarnings(
    _command: ConvertEarningsCommand,
  ): Promise<EarningsConversion> {
    return this.unavailable();
  }

  storeWebhook(_webhook: ProviderWebhook): Promise<{ duplicate: boolean }> {
    return this.unavailable();
  }
}
