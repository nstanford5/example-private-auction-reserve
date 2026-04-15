 Compact Code Review Report — silent-auction.compact

  Summary

  ┌─────────────┬───────┐
  │  Severity   │ Count │
  ├─────────────┼───────┤
  │ Critical    │ 5     │
  ├─────────────┼───────┤
  │ High        │ 10    │
  ├─────────────┼───────┤
  │ Medium      │ 15    │
  ├─────────────┼───────┤
  │ Low         │ 15    │
  ├─────────────┼───────┤
  │ Suggestions │ 10    │
  └─────────────┴───────┘

  Files reviewed:
  - contract/silent-auction.compact (165 lines)
  - contract/witnesses.ts (19 lines)
  - src/test/auction.test.ts (407 lines)

  Mechanical verification: Contract compiled successfully — exit 0. All 5 ZK circuits generated (bid.zkir,
  claimWin.zkir, closeAuction.zkir, receiveTokens.zkir, revealWin.zkir). TypeScript witness type-check passes (tsc exit
  0). Witness localSk name, return tuple [AuctionPrivateState, Uint8Array], and WitnessContext<Ledger,
  AuctionPrivateState> signature all match the generated Witnesses<PS> interface exactly.

  ---
  1. Privacy & Disclosure

  ▎ Privacy findings are always reported first.

  Critical

  commitWithSk uses persistentHash — the hidden reserve price is brute-forceable (silent-auction.compact:155-158)

  The hidden price commitment is:
  circuit commitWithSk(_minPrice: Bytes<32>, _sk: Bytes<32>): Bytes<32> {
      const hash = persistentHash<Vector<2, Bytes<32>>>([_minPrice, _sk]);
      return disclose(hash);
  }
  persistentHash is a hash function, not a cryptographic commitment. It provides no blinding factor (random salt/nonce).
   Since _minPrice is Uint<16> — an input space of only 65,536 possible values — any observer can brute-force all
  values. The auctionOrganizer public key is stored on-chain, partially constraining the SK search space further. The
  core privacy promise of the auction — that the organizer's reserve price remains secret until bidding closes — is
  cryptographically broken.

  Fix: Replace persistentHash with persistentCommit, which clears witness taint and provides true hiding:
  witness localSalt(): Bytes<32>;  // fresh randomness stored off-chain

  circuit commitPrice(_minPrice: Bytes<32>, _sk: Bytes<32>, _salt: Bytes<32>): Bytes<32> {
      return persistentCommit<Vector<2, Bytes<32>>>([_minPrice, _sk], _salt);
      // No disclose() needed — persistentCommit clears witness taint
  }
  The salt must be stored in AuctionPrivateState and provided again at revealWin.

  ---
  High

  organizerAddress (a real UserAddress) written permanently to a public ledger field (silent-auction.compact:117)

  revealWin() writes organizerAddress = disclose(address) — the organizer's actual unshielded wallet address — to a
  publicly readable ledger field. This permanently links the organizer's real-world identity to the auction, the
  auctionOrganizer pseudonym, and all future transactions from that address. This breaks the pseudonymity the
  getDappPubKey scheme was designed to provide.

  Fix: Use the address only as a transient send target within the circuit; do not store it in the ledger. If claimWin
  needs it, pass it as an argument at that time.

  disclose() placed inside the internal commitWithSk circuit — wrong boundary (silent-auction.compact:157)

  return disclose(hash) inside a non-exported helper conflates the disclosure boundary with the computation. The
  disclose() should appear at the ledger write site in the calling circuit, not buried inside a helper. This pattern
  makes future private reuse of the helper impossible and obscures where data becomes public.

  disclose() called immediately after getDappPubKey in bid() — early disclosure (silent-auction.compact:73-74)

  const key = getDappPubKey(_sk);
  const pubKey = disclose(key);  // ← disclose at derivation, not at ledger boundary
  Disclosure should happen at the Map insert call site. Early disclosure taints all downstream uses of pubKey.

  ---
  Medium

  All bid amounts and bidder pseudonyms fully enumerable on-chain (silent-auction.compact:21)

  bidders: Map<Bytes<32>, Uint<16>> stores every bidder's DApp-scoped public key and exact bid amount publicly. Combined
   with the highestBid field broadcasting the live winning amount in real time, this enables bid sniping (submitting
  highestBid + 1 immediately before maxBids is reached). The contract comment acknowledges this, but it is fundamentally
   at odds with the "silent auction" name.

  bidCount inflates on re-bids — a single bidder can exhaust all bid slots (silent-auction.compact:82)

  bidCount.increment(1) fires on every bid() call, including re-bids by the same user. With maxBids = 5, one bidder
  making 5 incremental re-bids fills the auction slot and blocks all other participants — a griefing attack.

  Fix: Only increment for genuinely new bidders:
  if (bidders.member(pubKey)) {
      assert(bidders.lookup(pubKey) < publicBid, "New bid lower than your previous bid");
  } else {
      bidCount.increment(1);
  }
  bidders.insert(pubKey, publicBid);

  ---
  Low

  - pragma language_version 0.22 — missing >= operator; should be pragma language_version >= 0.22; for
  forward-compatible compilation.
  - Test seeds 000...001, 000...002, 000...003 are trivially predictable — acceptable for devnet but must never be used
  in production.

  ---
  Positive Highlights (Privacy)

  - getDappPubKey correctly uses persistentHash<Vector<2, Bytes<32>>>([pad(32, "silent-auction:pk:"), sk]) with a domain
   prefix — solid domain separation preventing cross-dapp identity linkage.
  - The sealed hiddenPrice + commitWithSk pattern is architecturally correct (commit-then-reveal). Only the
  cryptographic primitive is wrong; the structure is right.
  - Organizer exclusion from bidding correctly prevents front-running by the auction creator.

  ---
  2. Security & Cryptographic Correctness

  Critical

  Double-claim vulnerability: any bidder whose bid equals highestBid can claim the win (silent-auction.compact:132)

  assert(bidders.lookup(disclose(pubKey)) == highestBid, "You are not the high bidder");
  If two bidders place the same bid amount and that amount is highestBid, both pass this assertion. Both can call
  claimWin() and attempt to drain the contract of the NFT and the organizer's deposit. Two concurrent submissions built
  against auctionState == CLOSED can both pass before either sets PAID.

  Fix: Track the winner's identity explicitly in revealWin(), then assert identity (not just bid amount) in claimWin():
  export sealed ledger winnerKey: Bytes<32>;
  // set in revealWin(): winnerKey = disclose(bidderPubKeyWithHighestBid);
  // in claimWin(): assert(disclose(getDappPubKey(_sk)) == winnerKey, "Not the designated winner");

  revealWin() doesn't advance state — state machine is broken (silent-auction.compact:113)

  assert(auctionState == AuctionState.CLOSED, "The auction is still open");
  // ...
  auctionState = AuctionState.CLOSED;  // ← writing CLOSED when already CLOSED
  This is a no-op. revealWin() makes no state transition. As a result:
  1. claimWin() (which also only requires CLOSED) can run before revealWin(), sending (highestBid + depositAmount) NIGHT
   to organizerAddress which is still the zero default — funds permanently burned.
  2. In the reserve-not-met path, revealWin() refunds the deposit but leaves state as CLOSED, so claimWin() can still
  run afterward on an empty contract balance.
  3. revealWin() is callable multiple times (no state progression to prevent re-entry).

  Fix: Introduce a REVEALED state and use it as the gate for claimWin():
  export enum AuctionState { RECEIVE, OPEN, CLOSED, REVEALED, PAID }

  // revealWin(): auctionState = AuctionState.REVEALED;
  // claimWin(): assert(auctionState == AuctionState.REVEALED, "Organizer must reveal first");
  // No-winner path in revealWin(): auctionState = AuctionState.PAID; // terminal

  ---
  High

  Organizer can prematurely close and reveal a price above all bids — no meaningful penalty
  (silent-auction.compact:95-102, 104-127)

  The organizer can call closeAuction() at any time while OPEN, then reveal a publicPrice above highestBid. The deposit
  is refunded, bidders get nothing, and the organizer retains the NFT. With bids being fully public, the organizer can
  observe bid activity and strategically exit if bids are too low.

  claimWin() calls bidders.lookup() without a prior bidders.member() check (silent-auction.compact:132)

  If a non-bidder calls claimWin(), lookup on a missing key causes an uncontrolled runtime panic rather than a clean
  assertion failure. Fix:
  assert(bidders.member(disclose(pubKey)), "You have not placed a bid");
  assert(bidders.lookup(disclose(pubKey)) == highestBid, "You are not the high bidder");

  claimWin() accepts an arbitrary address — no ownership verification (silent-auction.compact:129)

  The winner can redirect the NFT to any address, including one they don't control. No proof that address belongs to the
   caller. This opens a social engineering vector.

  _minPrice as Bytes<32> cast — direct Uint<16> to Bytes<32> without Field intermediate (silent-auction.compact:35, 110)

  The cast appears in both the constructor and revealWin. If the compiler's handling of this direct cast ever changes
  across language versions, the stored hiddenPrice and the recomputed hash in revealWin will diverge permanently —
  making the auction unresolvable and locking all funds.

  Fix:
  const priceBytes = (_minPrice as Field) as Bytes<32>;
  Use explicit two-step cast at both call sites with a comment documenting the intended layout.

  ---
  Medium

  - commitWithSk lacks a domain separator: persistentHash([_minPrice, _sk]) shares hash space with any other
  persistentHash([x, _sk]) computation. Fix: add pad(32, "silent-auction:price:") as a prefix element.
  - Deposit locked if organizer abandons revealWin: No timeout or emergency withdrawal circuit — organizer's 50 NIGHT
  deposit is permanently locked if revealWin is never called after closeAuction.
  - bid() allows zero-amount bids: assert(bidAmount > 0, ...) is missing. Zero bids waste bid slots and clutter the
  bidders Map.

  ---
  Positive Highlights (Security)

  - Organizer exclusion from bidding (auctionOrganizer != pubKey) correctly prevents self-dealing.
  - Re-bid protection (bidders.lookup(pubKey) < publicBid) correctly prevents bid lowering.
  - auctionState guards in every circuit form a coherent access-control skeleton.
  - The binding property of hiddenPrice is correctly enforced via assert(hashedPrice == hiddenPrice, ...).

  ---
  3. Token & Economic Security

  High

  claimWin() callable before revealWin() — organizer payment sent to zero address (silent-auction.compact:129-153)

  Because both circuits require only auctionState == CLOSED, a winner can call claimWin() before the organizer calls
  revealWin(). At that point organizerAddress = default<UserAddress> (all-zero bytes). The sendUnshielded call transfers
   highestBid + depositAmount NIGHT to the zero address — permanently destroyed. After claimWin sets PAID, revealWin can
   never run. Total loss: winner's bid + organizer's deposit.

  NFT permanently locked when reserve price is not met (silent-auction.compact:120-126)

  When highestBid < publicPrice, revealWin() refunds the NIGHT deposit but the NFT minted in receiveTokens() remains in
  the contract with no recovery circuit. The organizer loses their auctioned asset entirely.

  Fix: Add a recoverNFT circuit callable in the REVEALED state when reserve was not met:
  export circuit recoverNFT(address: UserAddress): [] {
      assert(auctionState == AuctionState.REVEALED, "Not in revealed state");
      assert(highestBid < publicPrice, "Reserve was met — use claimWin");
      const _sk = localSk();
      assert(auctionOrganizer == disclose(getDappPubKey(_sk)), "Not organizer");
      sendUnshielded(nftType, 1, right<ContractAddress, UserAddress>(disclose(address)));
      auctionState = AuctionState.PAID;
  }

  ---
  Medium

  - revealWin() callable multiple times: No state transition means organizerAddress can be overwritten before claimWin()
   executes. If the first revealWin() already refunded the deposit in the no-winner path, a second call will fail at
  runtime on an empty balance.
  - Single bidder can exhaust all bid slots via re-bids: Same as Privacy finding — bidCount counting semantics.

  ---
  Low

  - depositAmount hardcoded to 50: For high-value NFT auctions, 50 NIGHT provides negligible economic security. Should
  be a constructor parameter.
  - Unused color variable: const color = mintUnshieldedToken(...) at line 58 is never used; nftType is then redundantly
  computed via tokenType(...). Use the return value directly:
  nftType = mintUnshieldedToken(disclose(domain), 1, left<ContractAddress, UserAddress>(kernel.self()));
  - total = highestBid + depositAmount: Implicit type widening from Uint<16> + Uint<64>. Safe given current values, but
  should be made explicit: (highestBid as Uint<128>) + (depositAmount as Uint<128>).

  ---
  Positive Highlights (Token)

  - NFT token type uniqueness guaranteed via tokenType(domain, kernel.self()) — each deployment has a distinct
  non-forgeable color.
  - All sendUnshielded/receiveUnshielded call sites correctly cast amounts to Uint<128>.
  - mintUnshieldedToken correctly mints to kernel.self() so the contract holds the asset.

  ---
  4. Concurrency & Contention

  Critical

  bid() reads and writes highestBid — every concurrent bid fails (silent-auction.compact:85-87)

  The read-then-write on highestBid means every bid() transaction built against the same ledger snapshot conflicts with
  any other bid() that lands first. Under any meaningful bidding load, only one bid per block slot succeeds. All others
  are rejected and require retry — with no retry guidance in the contract or tests.

  bid() TOCTOU: bidCount < maxBids check then auctionState = CLOSED transition race (silent-auction.compact:69, 89-91)

  Two concurrent bids when bidCount == maxBids - 1 can both pass the assert(bidCount < maxBids) guard (built against the
   same pre-increment state). After both increment, one or both evaluate bidCount == maxBids with inconsistent local
  state vs. on-chain state. The CLOSED transition may fire twice, or not at all.

  Fix: Remove the automatic CLOSED transition from bid(). Make closeAuction() (organizer-controlled) the sole mechanism
  for state advancement. Document the serialization requirement for bidders.

  ---
  High

  - bid() and closeAuction() both write auctionState: Race condition between organizer closing and in-flight bids —
  causes most in-flight bids to fail unexpectedly when a concurrent close lands.
  - Concurrent claimWin() calls: Two concurrent claims built against CLOSED state (before either sets PAID) can both
  attempt token transfers. The second will fail at the send (insufficient balance), but this is non-obvious behavior.
  - bid() Map read-modify-write for re-bids: A bidder submitting two updates concurrently will have the second fail —
  confusing UX with no guidance.

  ---
  Medium

  - revealWin() redundant CLOSED write creates artificial contention: The no-op write to auctionState still invalidates
  all concurrent transaction proofs that touched the field, causing unnecessary failures.
  - All bid() transactions contend on bidders Map: Even writes to different keys conflict in Compact's ZK model — a
  fundamental architectural reality requiring UX-level retry guidance.

  ---
  Low

  - No retry guidance or concurrency documentation anywhere in the contract comments.
  - No concurrent bid scenario tested in the test suite.

  ---
  Positive Highlights (Concurrency)

  - bidCount is correctly typed as Counter with increment(1) — the only conflict-free commutative write in the bid()
  circuit.
  - Single-writer access control on most state transitions reduces multi-writer risk.

  ---
  5. Architecture, State Design & Composability

  Critical

  Missing REVEALED state breaks protocol ordering (see Security §2 for full detail)

  The state machine declares 4 states: CLOSED, OPEN, RECEIVE, PAID. There is no state between CLOSED (auction ended) and
   PAID (winner paid). revealWin() and claimWin() both operate on CLOSED, with no enforced ordering between them.

  organizerAddress is unset when claimWin() executes first (silent-auction.compact:27, 117, 149)

  organizerAddress is only written in revealWin(). If claimWin() runs first (which the state machine permits),
  organizerAddress is default<UserAddress> (zero bytes) and the NIGHT payout is burned. Both bugs share the same root
  fix: add REVEALED state.

  ---
  High

  - No NFT recovery path when reserve not met (see Token §3 for full detail).
  - Winner identified by bid amount, not identity: Tie-bids allow multiple "winners" — no tiebreaking mechanism.
  - No auction timeout: If the organizer goes unresponsive after OPEN, the NFT and deposit are locked forever with no
  force-close mechanism.

  ---
  Medium

  - AuctionState enum starts with CLOSED (ordinal 0) as the zero/default value: The default Compact enum value is the
  first variant. CLOSED as the default is semantically dangerous — a freshly uninitialized auctionState appears closed.
  Reorder to: RECEIVE, OPEN, CLOSED, REVEALED, PAID.
  - depositAmount hardcoded to 50 — inflexible for different auction sizes.
  - bidCount semantics: Ledger comment says "unique bidders, overwriting bids allowed" but bidCount counts total bid
  operations including re-bids. Contradiction.
  - nftType not guarded against double-initialization: No assertion in receiveTokens() that nftType ==
  default<Bytes<32>>, so calling it twice would overwrite it.

  ---
  Low

  - receiveTokens() does not call receiveUnshielded(color, 1) for the minted NFT. Per the token operations model, a
  contract must call receiveUnshielded to register a minted token in its internal accounting. This should be validated
  against runtime behavior.
  - Counter comparisons (bidCount < maxBids, bidCount == maxBids) use operators rather than the idiomatic .lessThan()
  method — compiled successfully but deviates from documented API.

  ---
  Positive Highlights (Architecture)

  - State machine skeleton with assert(auctionState == ...) guards in every circuit is architecturally sound.
  - sealed ledger correctly applied to all deployment-time constants: auctionOrganizer, hiddenPrice, maxBids,
  depositAmount.
  - Clean circuit/witness boundary: localSk is the sole private input; all on-chain derivations are circuit-side.

  ---
  6. Compilation & Type Safety

  High

  Uint<16> as Bytes<32> direct cast without Field intermediate (silent-auction.compact:35, 110)

  The cast _minPrice as Bytes<32> appears in both the constructor (for storing hiddenPrice) and revealWin (for verifying
   it). If the compiler's handling of this direct cast changes across language versions, the two invocations could
  produce different byte encodings, permanently breaking the reveal assertion and locking all funds.

  Fix: Use explicit two-step cast:
  const priceBytes = (_minPrice as Field) as Bytes<32>;

  ---
  Medium

  - pragma language_version 0.22 (no >=): An exact-version match may cause compilation failure on any compiler reporting
   a different version. Use pragma language_version >= 0.22;.
  - disclose() inside non-exported commitWithSk circuit: Unusual and confusing pattern — internal helper that returns a
  pre-disclosed value. Move disclosure to the call site.
  - highestBid + depositAmount implicit type widening: Uint<16> + Uint<64> produces a wide intermediate. Make widening
  explicit before the addition.

  ---
  Low

  - localSk uses camelCase — Compact convention is snake_case (local_sk).
  - getDappPubKey and commitWithSk are not marked pure circuit despite touching no ledger state or witnesses.

  ---
  Positive Highlights (Compilation)

  - Contract compiles cleanly: exit 0, no errors or warnings. All 5 circuits produced.
  - No hallucinated API methods: Map.member(), Map.lookup(), Map.insert(), Counter.increment(), persistentHash<T>() all
  used correctly.
  - TypeScript witness passes strict type-check (tsc exit 0).
  - All explicit casts (depositAmount as Uint<128>, highestBid as Uint<128>) are safe widenings.
  - pad(32, "silent-auction:pk:") is 18 chars — fits within 32-byte limit.

  ---
  7. Performance & Circuit Efficiency

  Medium

  getDappPubKey recomputed in every circuit including closeAuction (silent-auction.compact:95-102)

  closeAuction (64 ZKIR lines) computes a persistentHash just to verify organizer identity. The organizer pubkey is
  already stored on-chain as auctionOrganizer. This hash is a disproportionate share of the circuit cost for a circuit
  that does almost nothing else.

  getDappPubKey and commitWithSk not marked pure circuit (silent-auction.compact:155, 161)

  Neither helper touches ledger state or witnesses. Marking them pure circuit enables the compiler to optimize proving
  key generation, and exports them to pureCircuits for off-chain reuse in witness code.

  pure circuit getDappPubKey(_sk: Bytes<32>): Bytes<32> { ... }
  pure circuit commitWithSk(_minPrice: Bytes<32>, _sk: Bytes<32>): Bytes<32> { ... }

  revealWin reads organizerAddress immediately after writing it (silent-auction.compact:117, 125)

  organizerAddress is set on line 117, then read on line 125 for the sendUnshielded recipient. The local parameter
  address is already in scope — use it directly to eliminate the round-trip ledger read.

  bid() Map member + lookup double-read on the same key (silent-auction.compact:78-81)

  Required by the Compact Map API (lookup panics on missing key), but worth noting as a 2× Map read per update-bid path.

  ---
  Low

  - Redundant tokenType() call in receiveTokens: The return value of mintUnshieldedToken is already the token color —
  calling tokenType(domain, kernel.self()) separately duplicates a persistentHash.
  - Redundant auctionState = CLOSED write in revealWin: The no-op write still generates unnecessary ZKIR instructions.
  - Uint<16> for bid amounts and price: Caps all bids at 65,535 NIGHT and requires widening casts (as Uint<128>) at
  every token operation. Consider Uint<64> throughout.

  ZKIR line counts (compiled --skip-zk):

  ┌───────────────┬───────┐
  │    Circuit    │ Lines │
  ├───────────────┼───────┤
  │ closeAuction  │ 71    │
  ├───────────────┼───────┤
  │ bid           │ 262   │
  ├───────────────┼───────┤
  │ revealWin     │ 381   │
  ├───────────────┼───────┤
  │ receiveTokens │ 418   │
  ├───────────────┼───────┤
  │ claimWin      │ 447   │
  └───────────────┴───────┘

  ---
  Positive Highlights (Performance)

  - No loops or unbounded iteration in any circuit — all circuits are loop-free.
  - persistentHash (not transientHash) used correctly for values stored in long-lived ledger fields.
  - Counter.increment(1) is the only conflict-free commutative write in bid().

  ---
  8. Code Quality & Best Practices

  Medium

  - AuctionState.CLOSED as ordinal 0 (the zero/default value): Semantically backwards — a fresh uninitialized contract
  silently appears as closed.
  - revealWin() no-op state assignment: auctionState = AuctionState.CLOSED on line 113 is dead code that signals either
  a missing state or a copy-paste error.
  - Unused color variable in receiveTokens: Dead variable after mintUnshieldedToken return is discarded.
  - disclose() inside internal circuit commitWithSk: Disclosure boundary is at the wrong level of abstraction.
  - State check order in bid(): bidCount < maxBids checked before auctionState == OPEN — primary access control should
  come first.
  - Magic number depositAmount = 50: Should be a named constant or constructor parameter.

  ---
  Low

  - Misleading contract name/comment: The comment says "Silent Auction" but bids are fully public — this is an open
  ascending-bid auction.
  - "all votes are in" comment in revealWin: Should read "all bids are in" — copy-paste from a voting contract.
  - Inconsistent assertion style: bid() uses auctionOrganizer != pubKey (pre-disclosed variable); all other circuits use
   assert(auctionOrganizer == disclose(pubKey), ...). Standardize to one pattern.
  - Intermediate key variable in bid(): const key = getDappPubKey(_sk); const pubKey = disclose(key); — collapse into
  const pubKey = disclose(getDappPubKey(_sk));.
  - _sk prefix inconsistency: Used as both a local variable name and a parameter name prefix across circuits.

  ---
  Suggestions (Code Quality)

  - Extract organizer-authentication into a shared circuit requireOrganizer(): [] — the same 3-line pattern appears in
  receiveTokens, closeAuction, and revealWin.
  - Add assert(nftType == default<Bytes<32>>, "NFT already received") in receiveTokens to prevent double-initialization.

  ---
  Positive Highlights (Code Quality)

  - Correct modern Compact syntax throughout: [] returns, individual export ledger declarations, dot-notation enums,
  declaration-only witness syntax.
  - pad(32, "silent-auction:pk:") domain separator is correctly constructed.
  - All exported circuits have explicit state guards.

  ---
  9. Testing Adequacy

  High

  - No test for claimWin called before revealWin: The most critical ordering vulnerability is never exercised. A test
  submitting claimWin immediately after closeAuction (without calling revealWin) would expose the zero-address payment
  bug.
  - No test for the reserve-not-met path (highestBid < publicPrice): The deposit-refund branch in revealWin and the
  NFT-locking consequence are completely untested. This is the path most likely to involve fund loss.
  - No test for double-claim: After a successful claimWin, a second call by the same winner is never verified to be
  rejected.

  ---
  Medium

  - No test for receiveTokens called twice or from a non-organizer.
  - No test for revealWin with incorrect minPrice: The commitment tamper-detection (assert(hashedPrice == hiddenPrice,
  ...)) is never exercised.
  - No test for bids in wrong state (RECEIVE or CLOSED state).
  - No test for revealWin called twice (re-entrancy on the reveal step).
  - No test for tie-bid scenario.
  - No simulator-based unit tests: Every test requires a live devnet — slow (10 min timeout per test),
  network-dependent, and expensive. Pure logic (commitment verification, state guards) should be testable offline.
  - @TODO -- try SEED 000 (line 59): Known gap acknowledged but not addressed.

  ---
  Low

  - Pervasive (submitCallTx as any) and (deployContract as any) casts: TypeScript type safety disabled for every
  contract interaction in the test suite.
  - revealWin test makes no ledger state assertions (line 336-351): Only verifies the call did not throw. Missing: check
   publicPrice, organizerAddress, auctionState.
  - Predictable sequential test seeds: Acceptable for isolated devnet; must never be copied to production.
  - Constructor test verifies only 4 of 7 initialized ledger fields: auctionOrganizer, depositAmount, and bidCount are
  unchecked.
  - getUnshieldedBalances imported but never used (line 7).

  ---
  Positive Highlights (Testing)

  - All 5 circuits exercised in the happy path with a realistic 3-actor scenario (organizer + 2 bidders).
  - Token transfer assertions in claimWin inspect raw transaction effects directly (unshielded.spent/unshielded.created)
   — significantly more rigorous than ledger-only checks.
  - Negative tests for authorization (closeAuction, bid) use .rejects.toThrow() correctly.
  - afterAll properly stops all wallets — no resource leaks.

  ---
  10. Documentation

  Low

  - Misleading header comment: "Silent Auction where... Bidders are aware of each others bids" is internally
  contradictory. Rename to "Open Ascending Auction" or implement sealed bids.
  - Missing state machine documentation: No diagram or comment sequence showing RECEIVE → OPEN → CLOSED → [REVEALED] →
  PAID and which circuit triggers each transition.
  - Missing ordering requirement documentation: No comment explaining that revealWin must be called before claimWin (and
   currently, that this is NOT enforced).
  - Missing commitment scheme documentation: No explanation that hiddenPrice is a hash of (price, sk) and what security
  properties it provides (and what it lacks).
  - Missing reserve-not-met documentation: No explanation of what happens to the NFT when the reserve is not met.
  - "all votes are in" comment (line 115): Should be "all bids are in".
  - "dis-incentivize Alice" comment (line 37): Should say "dis-incentivize the auction organizer" — hardcoding a test
  actor name.
  - witnesses.ts has no documentation of AuctionPrivateState, its security requirements, or key derivation implications.

  ---
  Mechanical Verification

  Contract: contract/silent-auction.compact
  Witness: contract/witnesses.ts
  Compilation: Exit 0. All 5 ZK circuits generated. --skip-zk flag used (proof keys not generated).
  TypeScript: tsc --noEmit exits 0. No type errors.
  Witness interface: localSk name, WitnessContext<Ledger, AuctionPrivateState> parameter, [AuctionPrivateState,
  Uint8Array] return tuple — all match the generated Witnesses<PS> interface exactly.
  Verdict: Syntactically and type-correctly structured. All security findings are logic-level issues not caught by the
  compiler.

  ---
  Positive Highlights (Aggregated)

  Across all 10 categories, the following were consistently identified as well-executed:

  - Compilation is clean: Exit 0, no warnings, all 5 circuits produced. No hallucinated API methods anywhere.
  - DApp-scoped public key derivation (getDappPubKey) correctly implements domain-separated pseudonymity with
  persistentHash<Vector<2, Bytes<32>>>([pad(32, "silent-auction:pk:"), sk]).
  - Witness implementation is minimal and correct: Name, signature, return tuple, and WitnessContext usage all match
  generated types exactly.
  - sealed ledger used correctly for all deployment-time constants: auctionOrganizer, hiddenPrice, maxBids,
  depositAmount.
  - State machine skeleton: AuctionState enum + explicit assert(auctionState == ...) in every circuit is the right
  architectural pattern — only the CLOSED→REVEALED gap undermines it.
  - Organizer exclusion from bidding (auctionOrganizer != pubKey) correctly prevents self-dealing.
  - Re-bid protection (bidders.lookup(pubKey) < publicBid) correctly prevents bid lowering.
  - NFT token type uniqueness guaranteed via tokenType(domain, kernel.self()) — each deployed auction has a distinct,
  non-forgeable NFT color.
  - Test suite covers the full happy-path with 3 actors across all 5 circuits, and includes token transfer assertions by
   inspecting raw unshielded.spent/created effects.
  - No loops, no unbounded iteration — all circuits are circuit-size-bounded and efficient.
  - Counter.increment(1) as the sole conflict-free write in bid() demonstrates awareness of Compact's concurrency model.

✻ Worked for 14m 25s

※ recap: We ran a full 10-category security review of silent-auction.compact and produced a consolidated report with 5
  critical findings. Next step is to fix the most severe issue: the broken state machine where revealWin makes no state
  transition, letting claimWin run first and burn funds. (disable recaps in /config)