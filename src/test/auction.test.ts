import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
    deployContract,
    submitCallTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import pino from 'pino';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { buildProviders, type AuctionProviders } from '../providers.js';
import {
    CompiledAuctionContract,
    ledger,
    zkConfigPath,
} from '../../contract/index.js';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { 
    AuctionState, 
} from '../../contract/managed/silent-auction/contract/index.js';
import { createAuctionPrivateState } from '../../contract/witnesses.js';

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const ALICE_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const BOB_SEED = '0000000000000000000000000000000000000000000000000000000000000002';
const CLAIRE_SEED = '0000000000000000000000000000000000000000000000000000000000000003';
const ALICE_PRIVATE_ID = 'alicePrivateState';
const BOB_PRIVATE_ID = 'bobPrivateState';
const CLAIRE_PRIVATE_ID = 'clairePrivateState';

const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: { target: 'pino-pretty' },
});

describe('Silent Auction Smart Contract via midnight-js', () => {
    let aliceWallet: MidnightWalletProvider;
    let bobWallet: MidnightWalletProvider;
    let claireWallet: MidnightWalletProvider;
    let aliceProviders: AuctionProviders;
    let bobProviders: AuctionProviders;
    let claireProviders: AuctionProviders;
    let contractAddress: ContractAddress;
    // @TODO -- try SEED 000

    const config = getConfig();

    async function queryLedger(providers: AuctionProviders) {
        const state = await providers.publicDataProvider.queryContractState(contractAddress);
        expect(state).not.toBeNull();
        return ledger(state!.data);
    };

    beforeAll(async () => {
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

        aliceWallet = await MidnightWalletProvider.build(logger, envConfig, ALICE_SEED);
        await aliceWallet.start();
        await syncWallet(logger, aliceWallet.wallet, 600_000);

        bobWallet = await MidnightWalletProvider.build(logger, envConfig, BOB_SEED);
        await bobWallet.start();
        await syncWallet(logger, bobWallet.wallet, 600_000);

        claireWallet = await MidnightWalletProvider.build(logger,envConfig, CLAIRE_SEED);
        await claireWallet.start();
        await syncWallet(logger, claireWallet.wallet, 600_000);

        aliceProviders = buildProviders(aliceWallet, zkConfigPath, config);
        bobProviders = buildProviders(bobWallet, zkConfigPath, config);
        claireProviders = buildProviders(claireWallet, zkConfigPath, config)

        logger.info('Providers initialized, ready to test.');
    });

    afterAll(async () => {
        if(aliceWallet) {
            logger.info('Stopping aliceWallet...');
            await aliceWallet.stop();
        }
        if(bobWallet) {
            logger.info('Stopping bobWallet...');
            await bobWallet.stop();
        }
        if(claireWallet) {
            logger.info('Stopping claireWallet...');
            await claireWallet.stop();
        }
    });// end of afterAll

    it('deploys the contract', async () => {

        const _MIN_PRICE = BigInt(100);
        const MAX_BIDS = BigInt(5);
        const aliceSk = randomBytes(32);
        const alicePrivateState = createAuctionPrivateState(
            aliceSk
        );

        const deployed: any = await (deployContract as any)(aliceProviders, {
            compiledContract: CompiledAuctionContract,
            privateStateId: ALICE_PRIVATE_ID,
            initialPrivateState: alicePrivateState,
            args: [_MIN_PRICE, MAX_BIDS]// constructor args (_minPrice, maxBidCount)
        });

        contractAddress = deployed.deployTxData.public.contractAddress;
        logger.info(`Contract deployed at: ${contractAddress}`);
        expect(contractAddress).toBeDefined();
        expect(contractAddress.length).toBeGreaterThan(0);

        aliceProviders.privateStateProvider.setContractAddress(contractAddress);
        await aliceProviders.privateStateProvider.set(ALICE_PRIVATE_ID, alicePrivateState);

        const state = await queryLedger(aliceProviders);
        expect(state.maxBids).toEqual(MAX_BIDS);
        expect(state.hiddenPrice).not.toBeUndefined();
        expect(state.highestBid).toEqual(0n);
        expect(state.auctionState).toEqual(AuctionState.RECEIVE);
    });// end of deploys the contract
});