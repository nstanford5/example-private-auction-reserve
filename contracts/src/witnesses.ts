import { Ledger } from './managed/silent-auction/contract/index.js';
import { WitnessContext, fromHex} from '@midnight-ntwrk/compact-runtime';

export type AuctionPrivateState = {
    sk: Uint8Array,
    rand: Uint8Array,
};

export const createAuctionPrivateState = (sk: Uint8Array, rand: Uint8Array) => ({
    sk,
    rand
});

export const witnesses = {
    localSk: ({
        privateState
    }: WitnessContext<Ledger, AuctionPrivateState>): [
        AuctionPrivateState,
        Uint8Array
    ] => [privateState, privateState.sk],
    getRandom: ({
        privateState
    }: WitnessContext<Ledger, AuctionPrivateState>): [
        AuctionPrivateState,
        Uint8Array
    ] => {
        return [privateState, privateState.rand];
    },
};