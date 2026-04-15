import { type Ledger } from '../contract/managed/silent-auction/contract/index.js';
import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';

export type AuctionPrivateState = {
    sk: Uint8Array,
    salt: Uint8Array,
};

export const createAuctionPrivateState = (sk: Uint8Array, salt: Uint8Array) => ({
    sk,
    salt
});

export const witnesses = {
    localSk: ({
        privateState
    }: WitnessContext<Ledger, AuctionPrivateState>): [
        AuctionPrivateState,
        Uint8Array
    ] => [privateState, privateState.sk],
    localSalt: ({
        privateState
    }: WitnessContext<Ledger, AuctionPrivateState>): [
        AuctionPrivateState,
        Uint8Array
    ] => [privateState, privateState.salt]
};