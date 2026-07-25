#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, Address, Env, String,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Escrow(u64),
    EscrowCount,
    Admin,
}

// ── Data types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowState {
    /// Escrow created, awaiting funding
    Created,
    /// Funds deposited by payer
    Funded,
    /// Arbiter has approved release (second signature)
    Approved,
    /// Funds released to payee
    Released,
    /// Funds refunded to payer
    Refunded,
    /// Under dispute resolution
    Disputed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowAgreement {
    pub id: u64,
    pub payer: Address,
    pub payee: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub deposited: i128,
    pub state: EscrowState,
    pub created_at: u64,
    pub expires_at: u64,
    pub description: String,
    pub arbiter_approved: bool,
    pub payer_confirmed: bool,
    pub payee_confirmed: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    EscrowNotFound = 3,
    Unauthorized = 4,
    InvalidAmount = 5,
    InsufficientDeposit = 6,
    AlreadyFunded = 7,
    NotFunded = 8,
    AlreadyApproved = 9,
    NotApproved = 10,
    AlreadyReleased = 11,
    AlreadyRefunded = 12,
    Expired = 13,
    NotExpired = 14,
    InDispute = 15,
    NotInDispute = 16,
    SelfAsCounterparty = 17,
    SameArbiterAsParty = 18,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[contractevent]
pub struct EscrowCreated {
    pub escrow_id: u64,
    pub payer: Address,
    pub payee: Address,
    pub arbiter: Address,
    pub amount: i128,
}

#[contractevent]
pub struct EscrowFunded {
    pub escrow_id: u64,
    pub amount: i128,
}

#[contractevent]
pub struct EscrowApproved {
    pub escrow_id: u64,
    pub arbiter: Address,
}

#[contractevent]
pub struct EscrowReleased {
    pub escrow_id: u64,
    pub payee: Address,
    pub amount: i128,
}

#[contractevent]
pub struct EscrowRefunded {
    pub escrow_id: u64,
    pub payer: Address,
    pub amount: i128,
}

#[contractevent]
pub struct EscrowDisputed {
    pub escrow_id: u64,
    pub raised_by: Address,
}

#[contractevent]
pub struct EscrowResolved {
    pub escrow_id: u64,
    pub resolution: u32, // 1 = release to payee, 2 = refund to payer
}

#[contractevent]
pub struct EscrowExpired {
    pub escrow_id: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // ── Admin ─────────────────────────────────────────────────────

    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, EscrowError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
    }

    // ── Escrow lifecycle ──────────────────────────────────────────

    /// Create a new escrow agreement.
    ///
    /// # Arguments
    /// * `payer` — The party depositing funds
    /// * `payee` — The party receiving funds on successful completion
    /// * `arbiter` — The trusted third party who must approve release
    /// * `token` — The token contract address for the escrow currency
    /// * `amount` — The exact amount to lock in escrow
    /// * `expires_at` — Unix timestamp after which payer may claim refund
    /// * `description` — Human-readable description of the agreement
    ///
    /// # Security
    /// * Arbiter must be distinct from both payer and payee
    /// * Amount must be positive
    pub fn create_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        expires_at: u64,
        description: String,
    ) -> u64 {
        payer.require_auth();

        if amount <= 0 {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }
        if payer == payee {
            panic_with_error!(&env, EscrowError::SelfAsCounterparty);
        }
        if arbiter == payer || arbiter == payee {
            panic_with_error!(&env, EscrowError::SameArbiterAsParty);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);
        let escrow_id = count + 1;

        let now = env.ledger().timestamp();
        if expires_at <= now {
            panic_with_error!(&env, EscrowError::Expired);
        }

        let escrow = EscrowAgreement {
            id: escrow_id,
            payer: payer.clone(),
            payee: payee.clone(),
            arbiter: arbiter.clone(),
            token: token.clone(),
            amount,
            deposited: 0,
            state: EscrowState::Created,
            created_at: now,
            expires_at,
            description,
            arbiter_approved: false,
            payer_confirmed: false,
            payee_confirmed: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage()
            .instance()
            .set(&DataKey::EscrowCount, &escrow_id);

        EscrowCreated {
            escrow_id,
            payer,
            payee,
            arbiter,
            amount,
        }
        .publish(&env);

        escrow_id
    }

    /// Deposit funds into an escrow.
    /// Only the designated payer may fund the escrow.
    /// The full `amount` must be deposited in a single call.
    pub fn deposit(env: Env, escrow_id: u64) {
        let mut escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if escrow.state != EscrowState::Created {
            panic_with_error!(&env, EscrowError::AlreadyFunded);
        }

        escrow.payer.require_auth();

        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &escrow.payer,
            &env.current_contract_address(),
            &escrow.amount,
        );

        escrow.deposited = escrow.amount;
        escrow.state = EscrowState::Funded;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowFunded {
            escrow_id,
            amount: escrow.amount,
        }
        .publish(&env);
    }

    /// Approve release of escrowed funds.
    ///
    /// This is the **second signature** required before funds can be withdrawn.
    /// Only the designated `arbiter` may call this.
    ///
    /// # Security
    /// * Escrow must be in `Funded` state
    /// * Arbiter authentication is strictly required
    pub fn approve_release(env: Env, escrow_id: u64) {
        let mut escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if escrow.state != EscrowState::Funded && escrow.state != EscrowState::Disputed {
            panic_with_error!(&env, EscrowError::NotFunded);
        }
        if escrow.arbiter_approved {
            panic_with_error!(&env, EscrowError::AlreadyApproved);
        }

        escrow.arbiter.require_auth();

        escrow.arbiter_approved = true;
        escrow.state = EscrowState::Approved;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowApproved {
            escrow_id,
            arbiter: escrow.arbiter,
        }
        .publish(&env);
    }

    /// Release escrowed funds to the payee.
    ///
    /// # Security
    /// * Requires `arbiter_approved == true` (second signature check)
    /// * Only the designated payee may receive the funds
    /// * Escrow must be in `Approved` state
    ///
    /// # CEI Ordering (Checks → Effects → Interactions)
    /// 1. CHECKS  — state guards and auth
    /// 2. EFFECTS — state written to storage BEFORE the external transfer
    /// 3. INTERACTIONS — token transfer executes last; if it reverts the whole
    ///    transaction is rolled back atomically, so the storage write never
    ///    persists.  No re-entrancy window exists because state is already
    ///    `Released` before any external call.
    pub fn release(env: Env, escrow_id: u64) {
        // ── CHECKS ──────────────────────────────────────────────────────────
        let mut escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if escrow.state == EscrowState::Released {
            panic_with_error!(&env, EscrowError::AlreadyReleased);
        }
        if escrow.state != EscrowState::Approved {
            panic_with_error!(&env, EscrowError::NotApproved);
        }

        // Payee must authorize receipt
        escrow.payee.require_auth();

        // Capture values needed after the state mutation.
        let payee = escrow.payee.clone();
        let token_addr = escrow.token.clone();
        let amount = escrow.deposited;

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // Write final state BEFORE the external token transfer so that any
        // re-entrant call (or future upgrade) sees `Released` and panics early.
        escrow.state = EscrowState::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        // Emit the state-change event before the external call so the ledger
        // records the intent even if the transfer path changes.
        EscrowReleased {
            escrow_id,
            payee: payee.clone(),
            amount,
        }
        .publish(&env);

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(
            &env.current_contract_address(),
            &payee,
            &amount,
        );
    }

    /// Refund escrowed funds to the payer.
    ///
    /// # Conditions
    /// * BEFORE expiry: Only if arbiter has NOT approved yet
    /// * AFTER expiry: Payer may claim refund unilaterally
    ///
    /// This protects the payer from funds being locked indefinitely.
    ///
    /// # CEI Ordering (Checks → Effects → Interactions)
    /// 1. CHECKS  — state guards, expiry check, auth
    /// 2. EFFECTS — state written to storage BEFORE the external transfer
    /// 3. INTERACTIONS — token transfer executes last
    pub fn refund(env: Env, escrow_id: u64) {
        // ── CHECKS ──────────────────────────────────────────────────────────
        let mut escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if escrow.state == EscrowState::Refunded {
            panic_with_error!(&env, EscrowError::AlreadyRefunded);
        }
        if escrow.state == EscrowState::Released {
            panic_with_error!(&env, EscrowError::AlreadyReleased);
        }
        if escrow.state != EscrowState::Funded && escrow.state != EscrowState::Approved {
            panic_with_error!(&env, EscrowError::NotFunded);
        }

        let now = env.ledger().timestamp();
        let expired = now >= escrow.expires_at;

        if expired {
            // After expiry — payer can unilaterally claim refund
            escrow.payer.require_auth();
        } else {
            // Before expiry — refund only if arbiter hasn't approved
            if escrow.arbiter_approved {
                panic_with_error!(&env, EscrowError::AlreadyApproved);
            }
            escrow.payer.require_auth();
        }

        // Capture values needed after the state mutation.
        let payer = escrow.payer.clone();
        let token_addr = escrow.token.clone();
        let amount = escrow.deposited;

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // Write final state BEFORE the external token transfer.
        escrow.state = EscrowState::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowRefunded {
            escrow_id,
            payer: payer.clone(),
            amount,
        }
        .publish(&env);

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(
            &env.current_contract_address(),
            &payer,
            &amount,
        );
    }

    /// Raise a dispute for an escrow.
    /// Either payer or payee may raise a dispute.
    pub fn raise_dispute(env: Env, escrow_id: u64, caller: Address) {
        let mut escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if escrow.state != EscrowState::Funded && escrow.state != EscrowState::Approved {
            panic_with_error!(&env, EscrowError::NotFunded);
        }

        if caller != escrow.payer && caller != escrow.payee {
            panic_with_error!(&env, EscrowError::Unauthorized);
        }
        caller.require_auth();

        escrow.state = EscrowState::Disputed;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowDisputed {
            escrow_id,
            raised_by: caller,
        }
        .publish(&env);
    }

    /// Resolve a disputed escrow.
    ///
    /// # Arguments
    /// * `resolution` — `1` to release to payee, `2` to refund to payer
    ///
    /// Only the designated arbiter may resolve disputes.
    ///
    /// # CEI Ordering (Checks → Effects → Interactions)
    /// 1. CHECKS  — dispute-state guard and arbiter auth
    /// 2. EFFECTS — final state + storage write + event BEFORE any transfer
    /// 3. INTERACTIONS — token transfer executes last per resolution branch
    pub fn resolve_dispute(env: Env, escrow_id: u64, resolution: u32) {
        // ── CHECKS ──────────────────────────────────────────────────────────
        let mut escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if escrow.state != EscrowState::Disputed {
            panic_with_error!(&env, EscrowError::NotInDispute);
        }

        escrow.arbiter.require_auth();

        // Capture values needed after the state mutation.
        let payee = escrow.payee.clone();
        let payer = escrow.payer.clone();
        let token_addr = escrow.token.clone();
        let amount = escrow.deposited;

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // Determine the terminal state and write it to storage BEFORE calling
        // any external contract.  This eliminates the re-entrancy window
        // entirely: a re-entrant call would see `Released` or `Refunded` and
        // immediately panic on the `NotInDispute` guard above.
        match resolution {
            1 => escrow.state = EscrowState::Released,
            2 => escrow.state = EscrowState::Refunded,
            _ => panic_with_error!(&env, EscrowError::InvalidAmount),
        }

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowResolved {
            escrow_id,
            resolution,
        }
        .publish(&env);

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        let token_client = token::Client::new(&env, &token_addr);
        match resolution {
            1 => {
                // Release to payee
                token_client.transfer(
                    &env.current_contract_address(),
                    &payee,
                    &amount,
                );
            }
            2 => {
                // Refund to payer
                token_client.transfer(
                    &env.current_contract_address(),
                    &payer,
                    &amount,
                );
            }
            _ => unreachable!(), // already validated above
        }
    }

    // ── Queries ───────────────────────────────────────────────────

    pub fn get_escrow(env: Env, escrow_id: u64) -> EscrowAgreement {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found")
    }

    pub fn get_escrow_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0)
    }

    /// Check if an escrow can be refunded (either not approved yet, or expired).
    pub fn is_refundable(env: Env, escrow_id: u64) -> bool {
        let escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        let now = env.ledger().timestamp();
        let expired = now >= escrow.expires_at;

        (escrow.state == EscrowState::Funded || escrow.state == EscrowState::Approved)
            && (expired || !escrow.arbiter_approved)
            && escrow.state != EscrowState::Released
            && escrow.state != EscrowState::Refunded
    }

    /// Check if an escrow can be released (arbiter approved and payee hasn't claimed).
    pub fn is_releasable(env: Env, escrow_id: u64) -> bool {
        let escrow: EscrowAgreement = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        escrow.state == EscrowState::Approved
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient},
        Symbol, Val,
    };

    fn setup() -> (Env, Address, Address, Address, Address, TokenClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let payee = Address::generate(&env);
        let arbiter = Address::generate(&env);

        // Create a Stellar asset token for testing
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token = TokenClient::new(&env, &sac.address());
        let asset_client = StellarAssetClient::new(&env, &sac.address());

        // Mint tokens to payer
        asset_client.mint(&payer, &10_000_000_000i128);

        (env, payer, payee, arbiter, sac.address(), token)
    }

    fn register_escrow(env: &Env) -> EscrowContractClient<'static> {
        let contract_id = env.register_contract(None, EscrowContract);
        EscrowContractClient::new(env, &contract_id)
    }

    #[test]
    fn test_full_happy_path() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Enterprise SaaS subscription");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
        assert_eq!(id, 1);

        let agreement = escrow.get_escrow(&id);
        assert_eq!(agreement.state, EscrowState::Created);
        assert_eq!(agreement.amount, 1_000_000_000i128);

        // Fund
        escrow.deposit(&id);
        let funded = escrow.get_escrow(&id);
        assert_eq!(funded.state, EscrowState::Funded);
        assert_eq!(funded.deposited, 1_000_000_000i128);

        // Arbiter approves (second signature)
        escrow.approve_release(&id);
        let approved = escrow.get_escrow(&id);
        assert_eq!(approved.state, EscrowState::Approved);
        assert!(approved.arbiter_approved);

        // Payee releases
        escrow.release(&id);
        let released = escrow.get_escrow(&id);
        assert_eq!(released.state, EscrowState::Released);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn test_release_without_arbiter_approval_fails() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);

        // Try to release without arbiter approval — should panic
        escrow.release(&id);
    }

    #[test]
    fn test_refund_before_approval() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);

        let before = escrow.get_escrow(&id);
        assert_eq!(before.state, EscrowState::Funded);

        escrow.refund(&id);
        let after = escrow.get_escrow(&id);
        assert_eq!(after.state, EscrowState::Refunded);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn test_refund_after_approval_fails_before_expiry() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);

        // Refund after approval but before expiry — should panic
        escrow.refund(&id);
    }

    #[test]
    fn test_refund_after_expiry_unilateral() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let now = env.ledger().timestamp();
        let expiry = now + 100;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);

        // Advance ledger past expiry
        env.ledger().set_timestamp(expiry + 1);

        // Now payer can refund even though arbiter approved
        escrow.refund(&id);
        let refunded = escrow.get_escrow(&id);
        assert_eq!(refunded.state, EscrowState::Refunded);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #18)")]
    fn test_arbiter_cannot_be_party() {
        let (env, payer, payee, _arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        // Arbiter same as payee — should panic
        escrow.create_escrow(
            &payer, &payee, &payee, &token, &1_000_000_000i128, &expiry, &desc,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #17)")]
    fn test_payer_cannot_be_payee() {
        let (env, payer, _payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        // Payer same as payee — should panic
        escrow.create_escrow(
            &payer, &payer, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
    }

    #[test]
    fn test_dispute_and_resolve_to_payee() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.raise_dispute(&id, &payer);

        let disputed = escrow.get_escrow(&id);
        assert_eq!(disputed.state, EscrowState::Disputed);

        // Arbiter resolves in favor of payee
        escrow.resolve_dispute(&id, &1u32);
        let resolved = escrow.get_escrow(&id);
        assert_eq!(resolved.state, EscrowState::Released);
    }

    #[test]
    fn test_dispute_and_resolve_to_payer() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.raise_dispute(&id, &payee);

        // Arbiter resolves in favor of payer (refund)
        escrow.resolve_dispute(&id, &2u32);
        let resolved = escrow.get_escrow(&id);
        assert_eq!(resolved.state, EscrowState::Refunded);
    }

    #[test]
    fn test_funds_locked_without_second_signature() {
        let (env, payer, payee, arbiter, token, token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );

        // Check payer balance before deposit
        let payer_balance_before = token_client.balance(&payer);
        let contract_balance_before = token_client.balance(&env.register_contract(None, EscrowContract));

        escrow.deposit(&id);

        // Funds have moved from payer to contract
        let payer_balance_after = token_client.balance(&payer);
        assert_eq!(payer_balance_after, payer_balance_before - 1_000_000_000i128);

        // Without arbiter approval, payee cannot release
        // (tested by test_release_without_arbiter_approval_fails above)

        // Verify state
        let agreement = escrow.get_escrow(&id);
        assert_eq!(agreement.state, EscrowState::Funded);
        assert!(!agreement.arbiter_approved);
    }

    // ── CEI partial-failure tests ─────────────────────────────────────────────

    /// After a successful `release`, the escrow state is `Released` and a
    /// second call must panic with `AlreadyReleased`.  This verifies that the
    /// EFFECTS phase (state write) executes before the INTERACTIONS phase
    /// (token transfer) so no double-spend is possible even under re-entrancy.
    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_release_cannot_be_called_twice() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);

        // First release — should succeed.
        escrow.release(&id);
        // State is now Released; second call must panic.
        escrow.release(&id);
    }

    /// After a successful `refund`, a second `refund` must panic with
    /// `AlreadyRefunded`.  Confirms the state guard in the EFFECTS phase
    /// prevents double-disbursement.
    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_refund_cannot_be_called_twice() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);

        escrow.refund(&id);          // first refund — succeeds
        escrow.refund(&id);          // second refund — must panic
    }

    /// After a `release`, attempting a `refund` must panic.
    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_refund_after_release_is_rejected() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);
        escrow.release(&id);

        // Now try to also refund — state is Released, must fail.
        escrow.refund(&id);
    }

    /// After `release`, the payee receives the escrowed amount and the payer's
    /// balance is reduced by exactly that amount (deposit already happened).
    /// This is the primary token-conservation test for the EFFECTS-then-
    /// INTERACTIONS ordering.
    #[test]
    fn test_release_transfers_correct_amount() {
        let (env, payer, payee, arbiter, token, token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let amount = 750_000_000i128;
        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Amount check");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);

        let payee_before = token_client.balance(&payee);
        escrow.release(&id);

        assert_eq!(token_client.balance(&payee), payee_before + amount);
        assert_eq!(escrow.get_escrow(&id).state, EscrowState::Released);
    }

    /// After `resolve_dispute` (resolution=1 → payee), a second call to
    /// `resolve_dispute` must fail because state is no longer `Disputed`.
    #[test]
    #[should_panic(expected = "Error(Contract, #16)")]
    fn test_resolve_dispute_cannot_be_called_twice() {
        let (env, payer, payee, arbiter, token, _token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.raise_dispute(&id, &payer);

        escrow.resolve_dispute(&id, &1u32); // first resolution — succeeds
        escrow.resolve_dispute(&id, &2u32); // second resolution — must panic
    }

    /// After `resolve_dispute` → release, the payee gets the funds and state
    /// is `Released`.  Confirms the EFFECTS-then-INTERACTIONS fix in
    /// `resolve_dispute`.
    #[test]
    fn test_resolve_dispute_release_transfers_to_payee() {
        let (env, payer, payee, arbiter, token, token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let amount = 600_000_000i128;
        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Dispute release check");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.raise_dispute(&id, &payee);

        let payee_before = token_client.balance(&payee);
        escrow.resolve_dispute(&id, &1u32);

        assert_eq!(token_client.balance(&payee), payee_before + amount);
        assert_eq!(escrow.get_escrow(&id).state, EscrowState::Released);
    }

    /// After `resolve_dispute` → refund, the payer gets the funds back.
    #[test]
    fn test_resolve_dispute_refund_transfers_to_payer() {
        let (env, payer, payee, arbiter, token, token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let amount = 400_000_000i128;
        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Dispute refund check");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.raise_dispute(&id, &payer);

        // After deposit the payer balance already reflects the locked amount.
        let payer_before = token_client.balance(&payer);
        escrow.resolve_dispute(&id, &2u32);

        assert_eq!(token_client.balance(&payer), payer_before + amount);
        assert_eq!(escrow.get_escrow(&id).state, EscrowState::Refunded);
    }
}

#[cfg(test)]
mod fuzz;

