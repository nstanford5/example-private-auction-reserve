import { AuctionSimulator, WalletBuilder } from './auction-simulator.js';
import { NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { describe, it, expect } from 'vitest';
import { randomBytes } from './utils.js';
import { AuctionState } from '../managed/silent-auction/contract/index.js';

setNetworkId('undeployed' as NetworkId);

describe("Silent Auction Smart Contract", () => {
    it("executes the constructor correctly", () => {
        const maxBids = BigInt(5);
        const sim = new AuctionSimulator(maxBids);

        const ledgerState = sim.getLedger();
        expect(ledgerState.maxBids).toEqual(maxBids);
        expect(ledgerState.highestBid).toEqual(0n);
        expect(ledgerState.auctionState).toEqual(AuctionState.OPEN);
    });
    it("allows bids higher than reserve", () => {
        const maxBids = BigInt(5);
        const sim = new AuctionSimulator(maxBids);

        const bob = new WalletBuilder(sim.contractAddress, sim.getContractState());
        sim.switchCaller(bob.callerContext);
        const bobsBid = BigInt(150);// higher than reserve amount
        sim.bid(bobsBid);
        const bobsDAppKey = sim.publicKey(bob.sk);

        const bobLedgerState = sim.getLedger();
        expect(bobLedgerState.bidders.lookup(bobsDAppKey)).toEqual(bobsBid);
        expect(bobLedgerState.highestBid).toEqual(bobsBid);
        expect(bobLedgerState.bidCount).toEqual(1n);
    });
    it('allows bids lower than reserve', () => {
        const maxBids = BigInt(5);
        const sim = new AuctionSimulator(maxBids);

        const bob = new WalletBuilder(sim.contractAddress, sim.getContractState());
        sim.switchCaller(bob.callerContext);
        const bobsBid = BigInt(1);// lower than reserve
        sim.bid(bobsBid);
        const bobsDappKey = sim.publicKey(bob.sk);

        const bobLedgerState = sim.getLedger();
        expect(bobLedgerState.bidders.lookup(bobsDappKey)).toEqual(bobsBid);
    });
    it('allows maxBids', () => {
        const maxBids = BigInt(5);
        const sim = new AuctionSimulator(maxBids);

        const bob = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const bobsBid = BigInt(101);
        sim.switchCaller(bob.callerContext);
        sim.bid(bobsBid);

        const claire = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const clairesBid = BigInt(25);
        sim.switchCaller(claire.callerContext);
        sim.bid(clairesBid);

        const don = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const donsBid = BigInt(200);
        const highestTestBid = donsBid;
        sim.switchCaller(don.callerContext);
        sim.bid(donsBid);

        const ezra = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const ezrasBid = BigInt(50);
        sim.switchCaller(ezra.callerContext);
        sim.bid(ezrasBid);

        const frank = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const franksBid = BigInt(95);
        sim.switchCaller(frank.callerContext);
        sim.bid(franksBid);

        const ledgerState = sim.getLedger();
        expect(ledgerState.bidders.size()).toEqual(5n);
        expect(ledgerState.bidCount).toEqual(5n);
        expect(ledgerState.highestBid).toEqual(highestTestBid);
        expect(ledgerState.auctionState).toEqual(AuctionState.CLOSED);

        sim.updateAliceContext(sim.getContractState());

        // Alice tries to up the minimum
        expect(() => {
            sim.revealWin(BigInt(500));
        }).toThrow("Attempt to change min price detected, shame on you.");

        // Alice realizes she can't cheat and submits the right number
        const winningBid = sim.revealWin(sim.minPrice);
        
        const finalLedgerState = sim.getLedger();
        expect(finalLedgerState.publicPrice).toEqual(sim.minPrice);
        expect(finalLedgerState.highestBid).toEqual(highestTestBid);
        expect(finalLedgerState.highestBid).toEqual(winningBid);
        expect(finalLedgerState.highestBid > finalLedgerState.publicPrice).toBeTruthy();
        expect(finalLedgerState.auctionState).toEqual(AuctionState.CLOSED);

        expect(finalLedgerState.bidders.member(don.sk)).toBeFalsy();
        const donsDappKey = sim.publicKey(don.sk);
        expect(finalLedgerState.bidders.lookup(donsDappKey)).toEqual(donsBid);
    });
    it('it closes the auction manually', () => {
        const maxBids = BigInt(10);
        const sim = new AuctionSimulator(maxBids);

        const bob = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const bobsBid = BigInt(1);
        sim.switchCaller(bob.callerContext);
        sim.bid(bobsBid);

        const claire = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const clairesBid = BigInt(1000);
        sim.switchCaller(claire.callerContext);
        sim.bid(clairesBid);

        const don = new WalletBuilder(sim.contractAddress, sim.getContractState());
        // don hits that prices right bid
        const donsBid = BigInt(1001);
        const highestTestBid = donsBid;
        sim.switchCaller(don.callerContext);
        sim.bid(donsBid);

        sim.updateAliceContext(sim.getContractState());
        sim.closeAuction(sim.minPrice);

        const ledgerState = sim.getLedger();
        expect(ledgerState.auctionState).toEqual(AuctionState.CLOSED);
        expect(ledgerState.bidCount).toEqual(3n);
        expect(ledgerState.bidders.size()).toEqual(3n);
        expect(ledgerState.highestBid).toEqual(highestTestBid);
        expect(ledgerState.highestBid > ledgerState.publicPrice).toBeTruthy();

        const donsDappKey = sim.publicKey(don.sk);
        expect(ledgerState.bidders.lookup(donsDappKey)).toEqual(donsBid);
    });
    it('does not meet the minimum bid requirement(reserve)', () => {
        const maxBids = BigInt(3);
        const sim = new AuctionSimulator(maxBids);

        const bob = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const bobsBid = BigInt(3);
        const highestTestBid = bobsBid;
        sim.switchCaller(bob.callerContext);
        sim.bid(bobsBid);

        const claire = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const clairesBid = BigInt(2);
        sim.switchCaller(claire.callerContext);
        sim.bid(clairesBid);

        const don = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const donsBid = BigInt(1);
        sim.switchCaller(don.callerContext);
        sim.bid(donsBid);

        const ledgerState = sim.getLedger();
        expect(ledgerState.bidCount).toEqual(ledgerState.maxBids);
        expect(ledgerState.auctionState).toEqual(AuctionState.CLOSED);
        
        sim.updateAliceContext(sim.getContractState());
        const winningBid = sim.revealWin(sim.minPrice);
        // minPrice not met, nobody wins. booo
        expect(winningBid == 0n).toBeTruthy();

        const finalLedgerState = sim.getLedger();
        expect(ledgerState.highestBid).toEqual(highestTestBid);
    });
    it('starts a bidding war', () => {
        // this test demonstrates that bidders can bid more than once and that 
        // their highest bid is the one that counts
        const maxBids = BigInt(5);
        const sim = new AuctionSimulator(maxBids);
        
        const bob = new WalletBuilder(sim.contractAddress, sim.getContractState());
        const claire = new WalletBuilder(sim.contractAddress, sim.getContractState());

        sim.switchCaller(bob.callerContext);
        const bobBid1 = BigInt(25);
        sim.bid(bobBid1);

        claire.updateCallerContext(sim.getContractState());
        sim.switchCaller(claire.callerContext);
        const claireBid1 = BigInt(30);
        sim.bid(claireBid1);

        // bob bids again, because he sees the highestBid go up
        bob.updateCallerContext(sim.getContractState());
        sim.switchCaller(bob.callerContext);
        const bobBid2 = BigInt(40);
        sim.bid(bobBid2);

        // claire sees the highestBid go up and isn't having it.
        claire.updateCallerContext(sim.getContractState());
        sim.switchCaller(claire.callerContext);
        const claireBid2 = BigInt(50);
        sim.bid(claireBid2);

        // bob gets frustrated and throws money at his problems
        bob.updateCallerContext(sim.getContractState());
        sim.switchCaller(bob.callerContext);
        const bobBid3 = BigInt(1000);
        sim.bid(bobBid3);

        sim.updateAliceContext(sim.getContractState());
        const winningBid = sim.revealWin(sim.minPrice);
        // bob sees he lost and cries..

        const ledgerState = sim.getLedger();
        expect(ledgerState.auctionState).toEqual(AuctionState.CLOSED);
        expect(ledgerState.highestBid).toEqual(bobBid3);
        expect(ledgerState.publicPrice).toEqual(sim.minPrice);
        expect(winningBid).toEqual(bobBid3);
    });
});
