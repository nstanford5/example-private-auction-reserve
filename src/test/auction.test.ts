import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
    deployContract,
    submitCallTx,
    getUnshieldedBalances
} from '@midnight-ntwrk/midnight-js-contracts';
import { type ContractAddress, decodeRawTokenType } from '@midnight-ntwrk/compact-runtime';
import pino from 'pino';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { buildProviders, type AuctionProviders } from '../providers.js';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
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
    const _MIN_PRICE = BigInt(100);
    const MAX_BIDS = BigInt(5);

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


        const aliceSk = randomBytes(32);
        const alicePrivateState = createAuctionPrivateState(
            aliceSk
        );

        const deployed: any = await (deployContract as any)(aliceProviders, {
            compiledContract: CompiledAuctionContract,
            privateStateId: ALICE_PRIVATE_ID,
            initialPrivateState: alicePrivateState,
            args: [_MIN_PRICE, MAX_BIDS]// constructor args (_minPrice, maxBidCount, deposit)
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
    it('deposits tokens to the contract', async () => {

        // Deposit for organizer disincentive
        logger.info('Alice is depositing Night tokens to the contract...');
        const txData: any = await (submitCallTx as any)(aliceProviders, {
            compiledContract: CompiledAuctionContract,
            contractAddress,
            privateStateId: ALICE_PRIVATE_ID,
            circuitId: 'receiveTokens',
            args: [],
        });

        logger.info(`Deposit transaction finalized: ${txData.public.txId}`);

        const state = await queryLedger(aliceProviders);
        expect(state.auctionState).toEqual(AuctionState.OPEN);
        expect(state.auctionOrganizer).toBeDefined();

        // Verify native NIGHT tokens were deposited into the contract.
        // receiveUnshielded(nativeToken, amount) moves NIGHT from Alice's UTXOs into
        // the contract's Compact internal balance. The net NIGHT flow (spent - created)
        // from Alice's unshielded UTXOs proves exactly DEPOSIT NIGHT reached the contract.
        // @TODO -- there has to be an easier way to do this
        const nightType = '0000000000000000000000000000000000000000000000000000000000000000';
        const unshieldedEffects = txData.public.unshielded;
        const totalNightSpent: bigint = (unshieldedEffects.spent as any[])
            .filter(s => s.tokenType === nightType)
            .reduce((sum, s) => sum + BigInt(s.value), 0n);
        const totalNightCreated: bigint = (unshieldedEffects.created as any[])
            .filter(c => c.tokenType === nightType)
            .reduce((sum, c) => sum + BigInt(c.value), 0n);
        const nightDepositedToContract = totalNightSpent - totalNightCreated;
        logger.info(`NIGHT deposited to contract: ${nightDepositedToContract} (expected ${state.depositAmount})`);
        expect(nightDepositedToContract).toEqual(state.depositAmount);
    });
    it('Allows Bob to Bid', async () => {

        // setting up bobs private state
        const bobSk = randomBytes(32);
        const bobPrivateState = createAuctionPrivateState(
            bobSk
        );
        bobProviders.privateStateProvider.setContractAddress(contractAddress);
        await bobProviders.privateStateProvider.set(BOB_PRIVATE_ID, bobPrivateState);

        logger.info(`Bob is sending in a bid...`);
        const bobsBid = BigInt(50);
        const txData: any = await (submitCallTx as any)(bobProviders, {
            compiledContract: CompiledAuctionContract,
            contractAddress,
            privateStateId: BOB_PRIVATE_ID,
            circuitId: 'bid',
            args: [bobsBid]
        });
        logger.info(`Bobs bid is complete!`);

        const state = await queryLedger(bobProviders);
        expect(state.auctionState).toEqual(AuctionState.OPEN);
        expect(state.highestBid).toEqual(bobsBid);
        expect(state.bidCount).toEqual(1n);
        expect(state.bidders.size()).toEqual(1n);
    });
    it('Allows Claire to bid', async () => {
        
        // setting up claire private state
        const claireSk = randomBytes(32);
        const clairePrivateState = createAuctionPrivateState(
            claireSk,
        );
        claireProviders.privateStateProvider.setContractAddress(contractAddress);
        await claireProviders.privateStateProvider.set(CLAIRE_PRIVATE_ID, clairePrivateState);

        logger.info(`Claire is sending a bid...`);
        const clairesBid = BigInt(150);
        const txData: any = await (submitCallTx as any)(claireProviders, {
            compiledContract: CompiledAuctionContract,
            contractAddress,
            privateStateId: CLAIRE_PRIVATE_ID,
            circuitId: 'bid',
            args: [clairesBid]
        });
        logger.info(`Claire has successfully submitted a bid!`);

        const state = await queryLedger(claireProviders);
        expect(state.bidCount).toEqual(2n);
        expect(state.highestBid).toEqual(clairesBid);
        expect(state.bidders.size()).toEqual(2n);
    });
    it('rejects a lower bid by Claire', async () => {

        const claireLowerBid = BigInt(100);

        logger.info(`Claire realizes she bid too much and tries to bid lower...`);
        await expect(async () => {
            await (submitCallTx as any)(claireProviders, {
                compiledContract: CompiledAuctionContract,
                contractAddress,
                privateStateId: CLAIRE_PRIVATE_ID,
                circuitId: 'bid',
                args: [claireLowerBid]
            });
        }).rejects.toThrow();

        const state = await queryLedger(claireProviders);
        expect(state.highestBid).toEqual(150n);
        expect(state.bidCount).toEqual(2n)
        expect(state.bidders.size()).toEqual(2n);
        expect(state.auctionState).toEqual(AuctionState.OPEN);
    });
    it('Allows bob to bid higher', async () => {

        const bobHigherBid = BigInt(160);

        logger.info(`Bob realizes his bid is too low and submits a new bid...`);
        const txData: any = await (submitCallTx as any)(bobProviders, {
            compiledContract: CompiledAuctionContract,
            contractAddress,
            privateStateId: BOB_PRIVATE_ID,
            circuitId: 'bid',
            args: [bobHigherBid]
        });
        logger.info(`Bobs bid was successful!`);

        const state = await queryLedger(bobProviders);
        expect(state.bidCount).toEqual(3n);
        expect(state.bidders.size()).toEqual(2n);// still only 2 unique bidders, bobs old bid is supplanted
        expect(state.highestBid).toEqual(bobHigherBid);
        expect(state.auctionState).toEqual(AuctionState.OPEN);
    });
    it('blocks the organizer from bidding', async () => {

        logger.info(`Alice tries to bid (should fail)...`);
        await expect(async () => {
            await (submitCallTx as any)(aliceProviders, {
                compiledContract: CompiledAuctionContract,
                contractAddress,
                privateStateId: ALICE_PRIVATE_ID,
                circuitId: 'bid',
                args: [BigInt(200)]
            });
        }).rejects.toThrow();
        logger.info(`Alices bid was rejected!`);
    });
    it('Allows Alice (and only Alice) to close the auction', async () => {

        const bobsAddress = await bobWallet.wallet.unshielded.getAddress();

        logger.info(`Bob tries to close the auction (should fail)...`);
        await expect(async () => {
            await (submitCallTx as any)(bobProviders, {
                compiledContract: CompiledAuctionContract,
                contractAddress,
                privateStateId: BOB_PRIVATE_ID,
                circuitId: 'closeAuction',
                args: []// minPrice, address
            });
        }).rejects.toThrow();
        logger.info(`Bob was rejected from closing the auction!`);

        const claireAddress = await claireWallet.wallet.unshielded.getAddress();

        logger.info(`Claire is trying to close the auction (should fail)...`);
        await expect(async () => {
            await (submitCallTx as any)(claireProviders, {
                compiledContract: CompiledAuctionContract,
                contractAddress,
                privateStateId: CLAIRE_PRIVATE_ID,
                circuitId: 'closeAuction',
                args: []
            });
        }).rejects.toThrow();
        logger.info(`Claire was rejected from closing the auction!`);

        logger.info(`Alice is closing the auction...`);
        const txData: any = await (submitCallTx as any)(aliceProviders, {
                compiledContract: CompiledAuctionContract,
                contractAddress,
                privateStateId: ALICE_PRIVATE_ID,
                circuitId: 'closeAuction',
                args: []
        });
        logger.info(`Alice successfully closed the auction!`);

        const state = await queryLedger(aliceProviders);
        expect(state.auctionState).toEqual(AuctionState.CLOSED);
        expect(state.highestBid).toEqual(160n);// Bob wins
        expect(state.bidCount).toEqual(3n);
        expect(state.bidders.size()).toEqual(2n);// still only 2 unique bidders
    });
    it('reveals the winner', async () => {

        const aliceAddress = await aliceWallet.wallet.unshielded.getAddress();
        const addrBytes = { bytes: new Uint8Array(aliceAddress.data)};

        logger.info(`Alice is attempting to revealWin...`);
        const txData: any = await (submitCallTx as any)(aliceProviders, {
            compiledContract: CompiledAuctionContract,
            contractAddress,
            privateStateId: ALICE_PRIVATE_ID,
            circuitId: 'revealWin',
            args: [_MIN_PRICE, addrBytes]
        });
        logger.info(`Alice successfully revealed the winner!`);

    });
    it('Allows Bob(and only Bob) to claim the win', async () => {

        logger.info(`Claire tries to claim the win (should fail)...`);
        const claireUnshielded = await claireWallet.wallet.unshielded.getAddress();
        const claireAddress = { bytes: new Uint8Array(claireUnshielded.data) };
        await expect(async () => {
            await (submitCallTx as any)(claireProviders, {
                compiledContract: CompiledAuctionContract,
                contractAddress,
                privateStateId: CLAIRE_PRIVATE_ID,
                circuitId: 'claimWin',
                args: [claireAddress]
            })
        }).rejects.toThrow();
        logger.info(`Claire was rejected from claiming the win!`);

        const bobUnshielded = await bobWallet.wallet.unshielded.getAddress();
        const bobAddress = { bytes: new Uint8Array(bobUnshielded.data) };

        logger.info(`Bob is attempting to claim his new NFT...`);
        const txData: any = await (submitCallTx as any)(bobProviders, {
            compiledContract: CompiledAuctionContract,
            contractAddress,
            privateStateId: BOB_PRIVATE_ID,
            circuitId: 'claimWin',
            args: [bobAddress]
        });
        logger.info(`Bob has successfully executed claimWin!`);

        const state = await queryLedger(bobProviders);
        expect(state.auctionState).toEqual(AuctionState.PAID);

        const nftType = decodeRawTokenType(state.nftType);
        const unshieldedEffects = txData.public.unshielded;

        const nftCreatedToBob: bigint = (unshieldedEffects.created as any[])
            .filter(c => c.tokenType === nftType)
            .reduce((sum, c) => sum + BigInt(c.value), 0n);
        logger.info(`NFT received by Bob: ${nftCreatedToBob} (expected 1)`);
        expect(nftCreatedToBob).toEqual(1n);

        // The contract sends (highestBid + depositAmount) NIGHT to Alice in claimWin.
        const nightType = '0000000000000000000000000000000000000000000000000000000000000000';
        const aliceUnshielded = await aliceWallet.wallet.unshielded.getAddress();
        const aliceBech32 = MidnightBech32m.encode(config.networkId, aliceUnshielded).asString();
        console.log(`NIGHT created UTXOs:`, JSON.stringify(
            (unshieldedEffects.created as any[]).filter(c => c.tokenType === nightType)
        ));
        const expectedNightToAlice = state.highestBid + state.depositAmount;  
        const nightCreatedToAlice: bigint = (unshieldedEffects.created as any[])
            .filter(c => c.tokenType === nightType && c.owner === aliceBech32)
            .reduce((sum, c) => sum + BigInt(c.value), 0n)
        logger.info(`NIGHT received by Alice: ${nightCreatedToAlice} (expected ${expectedNightToAlice})`);
        expect(nightCreatedToAlice).toEqual(expectedNightToAlice);
    });
});