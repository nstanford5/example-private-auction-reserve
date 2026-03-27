import {
    type CircuitContext,
    sampleContractAddress,
    createConstructorContext,
    CostModel,
    QueryContext,
    sampleUserAddress,
    createCircuitContext,
    ContractState,
    ChargedState,
    fromHex
} from "@midnight-ntwrk/compact-runtime";
import { 
    Contract,
    type Ledger,
    ledger,
    AuctionState
 } from "../managed/silent-auction/contract/index.js";
import { 
    type AuctionPrivateState, 
    createAuctionPrivateState,
    witnesses,
} from "../witnesses.js";
import { randomBytes } from './utils.js';

export class AuctionSimulator {
    readonly contract: Contract<AuctionPrivateState>;
    contractAddress: string;
    aliceAddress: string;
    alicePrivateState: AuctionPrivateState;
    aliceSk: Uint8Array;
    minPrice: bigint;
    contractState: ContractState;
    circuitContext: CircuitContext<AuctionPrivateState>;

    constructor(maxBids: bigint) {
        this.contract = new Contract<AuctionPrivateState>(witnesses);
        this.contractAddress = sampleContractAddress();
        this.aliceAddress = sampleUserAddress();
        this.aliceSk = randomBytes(32);
        this.alicePrivateState = createAuctionPrivateState(this.aliceSk, randomBytes(32));
        this.minPrice = BigInt(100);
        const {
            currentPrivateState,
            currentContractState,
            currentZswapLocalState
        } = this.contract.initialState(
            createConstructorContext(this.alicePrivateState, this.aliceAddress),
            this.minPrice,
            maxBids
        );
        this.contractState = currentContractState;
        this.circuitContext = {
            currentPrivateState,
            currentZswapLocalState,
            costModel: CostModel.initialCostModel(),
            currentQueryContext: new QueryContext(
                currentContractState.data,
                this.contractAddress
            ),
        };
    }// end of constructor

    public getLedger(): Ledger {
        return ledger(this.circuitContext.currentQueryContext.state);
    }

    public switchCaller(callerContext: CircuitContext): void {
        this.circuitContext = callerContext;
    }

    public getContractState(): ChargedState {
        return this.circuitContext.currentQueryContext.state;
    }

    public updateAliceContext(contractState: ChargedState): void {
        this.circuitContext = createCircuitContext(
            this.contractAddress,
            this.aliceAddress,
            contractState,
            this.alicePrivateState
        );
    }

    // start circuit wrappers
    // bid, closeAuction, revealWin, publicKey
    public bid(bidAmount: bigint): void {
        this.circuitContext = this.contract.impureCircuits.bid(
            this.circuitContext,
            bidAmount
        ).context;
    }

    public closeAuction(minPrice: bigint): bigint {
        const {context, result} = this.contract.impureCircuits.closeAuction(
            this.circuitContext,
            minPrice
        );
        this.circuitContext = context;
        return result;
    }

    public revealWin(minPrice: bigint): bigint {
        const {context, result} = this.contract.impureCircuits.revealWin(
            this.circuitContext,
            minPrice
        );
        this.circuitContext = context;
        return result;
    }

    public publicKey(sk: Uint8Array): Uint8Array {
        return this.contract.circuits.publicKey(
            this.circuitContext,
            sk
        ).result;
    }
}

export class WalletBuilder {
    address: string;
    sk: Uint8Array;
    callerContext: CircuitContext<AuctionPrivateState>;
    privateState: AuctionPrivateState;
    contractAddress: string;

    constructor(contractAddress: string, contractState: ChargedState) {
        this.address = sampleUserAddress();
        this.sk = randomBytes(32);
        this.privateState = createAuctionPrivateState(this.sk, randomBytes(32));
        this.contractAddress = contractAddress;
        this.callerContext = createCircuitContext(
            this.contractAddress,
            this.address,
            contractState,
            this.privateState
        );
    }
    public updateCallerContext(contractState: ChargedState): void {
        this.callerContext = createCircuitContext(
            this.contractAddress,
            this.address,
            contractState,
            this.privateState
        )
    }
}