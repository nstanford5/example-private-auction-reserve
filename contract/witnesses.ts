import { type Ledger } from '../contract/managed/silent-auction/contract/index.js';
import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';

export type AuctionPrivateState = {
    sk: Uint8Array,
};

export const createAuctionPrivateState = (sk: Uint8Array) => ({
    sk,
});

export const witnesses = {
    localSk: ({
        privateState
    }: WitnessContext<Ledger, AuctionPrivateState>): [
        AuctionPrivateState,
        Uint8Array
    ] => [privateState, privateState.sk],
};