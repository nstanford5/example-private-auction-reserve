// Block until Alice has >=1 spendable DUST coin. syncWallet's
// progress.isStrictlyComplete() means "synced to chain tip", not "wallet has
// funds" -- on a fresh devnet it returns at block 0/1 with zero coins, so the
// first transaction fails with Wallet.InsufficientFunds. Run this after
// `yarn env:up` and before the test suite.

import pino from 'pino';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { firstValueFrom, throwError } from 'rxjs';
import { filter, take, tap, timeout } from 'rxjs/operators';
import { getConfig } from '../src/config.js';
import { MidnightWalletProvider, syncWallet } from '../src/wallet.js';

// Must match src/test/auction.test.ts.
const ALICE_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }
  return n;
}

const minCoins = envInt('WAIT_FOR_DUST_MIN_COINS', 1);
const timeoutMs = envInt('WAIT_FOR_DUST_TIMEOUT_MS', 180_000);
const config = getConfig();
setNetworkId(config.networkId);
const envConfig: EnvironmentConfiguration = {
  walletNetworkId: config.networkId,
  networkId: config.networkId,
  indexer: config.indexer,
  indexerWS: config.indexerWS,
  node: config.node,
  nodeWS: config.nodeWS,
  faucet: config.faucet,
  proofServer: config.proofServer,
};

logger.info(`Waiting for Alice to have >=${minCoins} DUST coin(s) (timeout ${timeoutMs}ms)`);

const wallet = await MidnightWalletProvider.build(logger, envConfig, ALICE_SEED);
await wallet.start();
try {
  await syncWallet(logger, wallet.wallet, timeoutMs);
  await firstValueFrom(
    wallet.wallet.state().pipe(
      tap((s) =>
        logger.info(
          `dust: ${s.dust.availableCoins.length} coin(s), balance ${s.dust.balance(new Date())} STAR`,
        ),
      ),
      filter((s) => s.dust.availableCoins.length >= minCoins),
      take(1),
      timeout({
        each: timeoutMs,
        with: () => throwError(() => new Error(`No spendable DUST coin within ${timeoutMs}ms`)),
      }),
    ),
  );
  logger.info('DUST ready');
} catch (err) {
  logger.error(
    `wait-for-dust failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exitCode = 1;
} finally {
  await wallet.stop().catch((err: unknown) => logger.warn(`stop() failed: ${String(err)}`));
}
