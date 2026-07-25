#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    token, Address, Env, String,
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
    AlreadyInitialized  = 1,
    NotInitialized      = 2,
    EscrowNotFound      = 3,
    Unauthorized        = 4,
    InvalidAmount       = 5,
    InsufficientDeposit = 6,
    AlreadyFunded       = 7,
    NotFunded           = 8,
    AlreadyApproved     = 9,
    NotApproved         = 10,
    AlreadyReleased     = 11,
    AlreadyRefunded     = 12,
    Expired             = 13,
    NotExpired          = 14,
    InDispute           = 15,
    NotInDispute        = 16,
    SelfAsCounterparty  = 17,
    SameArbiterAsParty  = 18,
    InvalidResolution   = 19,
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

    pub fn init(env: Env, admin: Address) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<(), EscrowError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    // ── Helpers ───────────────────────────────────────────────────

    /// Load an escrow by ID, returning a typed error if not found.
    fn load_escrow(env: &Env, escrow_id: u64) -> Result<EscrowAgreement, EscrowError> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(EscrowError::EscrowNotFound)
    }

    // ── Escrow lifecycle ──────────────────────────────────────────

    /// Create a new escrow agreement.
    ///
    /// # Arguments
    /// * `payer`       — The party depositing funds
    /// * `payee`       — The party receiving funds on successful completion
    /// * `arbiter`     — The trusted third party who must approve release
    /// * `token`       — The token contract address for the escrow currency
    /// * `amount`      — The exact amount to lock in escrow (must be > 0)
    /// * `expires_at`  — Unix timestamp after which payer may claim refund
    /// * `description` — Human-readable description of the agreement
    ///
    /// # Errors
    /// * `InvalidAmount`      — `amount` is zero or negative
    /// * `SelfAsCounterparty` — `payer == payee`
    /// * `SameArbiterAsParty` — `arbiter == payer` or `arbiter == payee`
    /// * `Expired`            — `expires_at` is not in the future
    pub fn create_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        expires_at: u64,
        description: String,
    ) -> Result<u64, EscrowError> {
        payer.require_auth();

        // Input validation
        if amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }
        if payer == payee {
            return Err(EscrowError::SelfAsCounterparty);
        }
        if arbiter == payer || arbiter == payee {
            return Err(EscrowError::SameArbiterAsParty);
        }

        let now = env.ledger().timestamp();
        if expires_at <= now {
            return Err(EscrowError::Expired);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);
        let escrow_id = count + 1;

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

        Ok(escrow_id)
    }

    /// Deposit funds into an escrow.
    /// Only the designated payer may fund the escrow.
    /// The full `amount` must be deposited in a single call.
    ///
    /// # Errors
    /// * `EscrowNotFound`  — no escrow with this ID
    /// * `AlreadyFunded`   — escrow is not in `Created` state
    /// * `InvalidAmount`   — escrow amount is zero (belt-and-suspenders guard)
    pub fn deposit(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let mut escrow = Self::load_escrow(&env, escrow_id)?;

        if escrow.state != EscrowState::Created {
            return Err(EscrowError::AlreadyFunded);
        }

        // Belt-and-suspenders: amount should always be positive, but guard here too
        if escrow.amount <= 0 {
            return Err(EscrowError::InvalidAmount);
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

        Ok(())
    }

    /// Approve release of escrowed funds.
    ///
    /// This is the **second signature** required before funds can be withdrawn.
    /// Only the designated `arbiter` may call this.
    ///
    /// # Errors
    /// * `EscrowNotFound`  — no escrow with this ID
    /// * `NotFunded`       — escrow is not in `Funded` or `Disputed` state
    /// * `AlreadyApproved` — arbiter has already approved
    pub fn approve_release(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let mut escrow = Self::load_escrow(&env, escrow_id)?;

        if escrow.state != EscrowState::Funded && escrow.state != EscrowState::Disputed {
            return Err(EscrowError::NotFunded);
        }
        if escrow.arbiter_approved {
            return Err(EscrowError::AlreadyApproved);
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

        Ok(())
    }

    /// Release escrowed funds to the payee.
    ///
    /// # Errors
    /// * `EscrowNotFound`  — no escrow with this ID
    /// * `AlreadyReleased` — funds already released
    /// * `NotApproved`     — arbiter has not yet approved
    pub fn release(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let mut escrow = Self::load_escrow(&env, escrow_id)?;

        if escrow.state == EscrowState::Released {
            return Err(EscrowError::AlreadyReleased);
        }
        if escrow.state != EscrowState::Approved {
            return Err(EscrowError::NotApproved);
        }

        // Payee must authorize receipt
        escrow.payee.require_auth();

        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            &escrow.payee,
            &escrow.deposited,
        );

        escrow.state = EscrowState::Released;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowReleased {
            escrow_id,
            payee: escrow.payee,
            amount: escrow.deposited,
        }
        .publish(&env);

        Ok(())
    }

    /// Refund escrowed funds to the payer.
    ///
    /// # Conditions
    /// * BEFORE expiry: Only if arbiter has NOT approved yet
    /// * AFTER expiry: Payer may claim refund unilaterally
    ///
    /// # Errors
    /// * `EscrowNotFound`  — no escrow with this ID
    /// * `AlreadyRefunded` — funds already refunded
    /// * `AlreadyReleased` — funds already released
    /// * `NotFunded`       — escrow was never funded
    /// * `AlreadyApproved` — arbiter approved and expiry has not passed
    pub fn refund(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let mut escrow = Self::load_escrow(&env, escrow_id)?;

        if escrow.state == EscrowState::Refunded {
            return Err(EscrowError::AlreadyRefunded);
        }
        if escrow.state == EscrowState::Released {
            return Err(EscrowError::AlreadyReleased);
        }
        if escrow.state != EscrowState::Funded && escrow.state != EscrowState::Approved {
            return Err(EscrowError::NotFunded);
        }

        let now = env.ledger().timestamp();
        let expired = now >= escrow.expires_at;

        if expired {
            // After expiry — payer can unilaterally claim refund
            escrow.payer.require_auth();
        } else {
            // Before expiry — refund only if arbiter hasn't approved
            if escrow.arbiter_approved {
                return Err(EscrowError::AlreadyApproved);
            }
            escrow.payer.require_auth();
        }

        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            &escrow.payer,
            &escrow.deposited,
        );

        escrow.state = EscrowState::Refunded;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowRefunded {
            escrow_id,
            payer: escrow.payer,
            amount: escrow.deposited,
        }
        .publish(&env);

        Ok(())
    }

    /// Raise a dispute for an escrow.
    /// Either payer or payee may raise a dispute.
    ///
    /// # Errors
    /// * `EscrowNotFound` — no escrow with this ID
    /// * `NotFunded`      — escrow is not in a disputable state
    /// * `Unauthorized`   — caller is not payer or payee
    pub fn raise_dispute(env: Env, escrow_id: u64, caller: Address) -> Result<(), EscrowError> {
        let mut escrow = Self::load_escrow(&env, escrow_id)?;

        if escrow.state != EscrowState::Funded && escrow.state != EscrowState::Approved {
            return Err(EscrowError::NotFunded);
        }

        if caller != escrow.payer && caller != escrow.payee {
            return Err(EscrowError::Unauthorized);
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

        Ok(())
    }

    /// Resolve a disputed escrow.
    ///
    /// # Arguments
    /// * `resolution` — `1` to release to payee, `2` to refund to payer
    ///
    /// Only the designated arbiter may resolve disputes.
    ///
    /// # Errors
    /// * `EscrowNotFound`    — no escrow with this ID
    /// * `NotInDispute`      — escrow is not in `Disputed` state
    /// * `InvalidResolution` — `resolution` is not `1` or `2`
    pub fn resolve_dispute(env: Env, escrow_id: u64, resolution: u32) -> Result<(), EscrowError> {
        let mut escrow = Self::load_escrow(&env, escrow_id)?;

        if escrow.state != EscrowState::Disputed {
            return Err(EscrowError::NotInDispute);
        }

        escrow.arbiter.require_auth();

        let token_client = token::Client::new(&env, &escrow.token);

        match resolution {
            1 => {
                // Release to payee
                token_client.transfer(
                    &env.current_contract_address(),
                    &escrow.payee,
                    &escrow.deposited,
                );
                escrow.state = EscrowState::Released;
            }
            2 => {
                // Refund to payer
                token_client.transfer(
                    &env.current_contract_address(),
                    &escrow.payer,
                    &escrow.deposited,
                );
                escrow.state = EscrowState::Refunded;
            }
            _ => return Err(EscrowError::InvalidResolution),
        }

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        EscrowResolved {
            escrow_id,
            resolution,
        }
        .publish(&env);

        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────

    /// Return the escrow agreement, or `EscrowNotFound` if it does not exist.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowAgreement, EscrowError> {
        Self::load_escrow(&env, escrow_id)
    }

    pub fn get_escrow_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0)
    }

    /// Check if an escrow can be refunded (either not approved yet, or expired).
    ///
    /// # Errors
    /// * `EscrowNotFound` — no escrow with this ID
    pub fn is_refundable(env: Env, escrow_id: u64) -> Result<bool, EscrowError> {
        let escrow = Self::load_escrow(&env, escrow_id)?;

        let now = env.ledger().timestamp();
        let expired = now >= escrow.expires_at;

        Ok(
            (escrow.state == EscrowState::Funded || escrow.state == EscrowState::Approved)
                && (expired || !escrow.arbiter_approved)
                && escrow.state != EscrowState::Released
                && escrow.state != EscrowState::Refunded,
        )
    }

    /// Check if an escrow can be released (arbiter approved and payee hasn't claimed).
    ///
    /// # Errors
    /// * `EscrowNotFound` — no escrow with this ID
    pub fn is_releasable(env: Env, escrow_id: u64) -> Result<bool, EscrowError> {
        let escrow = Self::load_escrow(&env, escrow_id)?;
        Ok(escrow.state == EscrowState::Approved)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient},
    };

    // ── Shared test setup ─────────────────────────────────────────

    /// Returns (env, payer, payee, arbiter, token_address, token_client).
    fn setup() -> (Env, Address, Address, Address, Address, TokenClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let payee = Address::generate(&env);
        let arbiter = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token = TokenClient::new(&env, &sac.0);
        let asset_client = StellarAssetClient::new(&env, &sac.0);

        // Mint 10 XLM-equivalent tokens to payer
        asset_client.mint(&payer, &10_000_000_000i128);

        (env, payer, payee, arbiter, sac.0, token)
    }

    fn register_escrow(env: &Env) -> EscrowContractClient<'static> {
        let contract_id = env.register_contract(None, EscrowContract);
        EscrowContractClient::new(env, &contract_id)
    }

    // ── Happy-path tests ──────────────────────────────────────────

    #[test]
    fn test_full_happy_path() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Enterprise SaaS subscription");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc)
            .unwrap();
        assert_eq!(id, 1);

        let agreement = escrow.get_escrow(&id).unwrap();
        assert_eq!(agreement.state, EscrowState::Created);
        assert_eq!(agreement.amount, 1_000_000_000i128);

        escrow.deposit(&id).unwrap();
        let funded = escrow.get_escrow(&id).unwrap();
        assert_eq!(funded.state, EscrowState::Funded);
        assert_eq!(funded.deposited, 1_000_000_000i128);

        escrow.approve_release(&id).unwrap();
        let approved = escrow.get_escrow(&id).unwrap();
        assert_eq!(approved.state, EscrowState::Approved);
        assert!(approved.arbiter_approved);

        escrow.release(&id).unwrap();
        let released = escrow.get_escrow(&id).unwrap();
        assert_eq!(released.state, EscrowState::Released);
    }

    #[test]
    fn test_refund_before_approval() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();

        escrow.refund(&id).unwrap();
        let after = escrow.get_escrow(&id).unwrap();
        assert_eq!(after.state, EscrowState::Refunded);
    }

    #[test]
    fn test_refund_after_expiry_unilateral() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let now = env.ledger().timestamp();
        let expiry = now + 100;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();
        escrow.approve_release(&id).unwrap();

        // Advance ledger past expiry — payer can now refund unilaterally
        env.ledger().set_timestamp(expiry + 1);

        escrow.refund(&id).unwrap();
        let refunded = escrow.get_escrow(&id).unwrap();
        assert_eq!(refunded.state, EscrowState::Refunded);
    }

    #[test]
    fn test_dispute_and_resolve_to_payee() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();
        escrow.raise_dispute(&id, &payer).unwrap();

        let disputed = escrow.get_escrow(&id).unwrap();
        assert_eq!(disputed.state, EscrowState::Disputed);

        escrow.resolve_dispute(&id, &1u32).unwrap();
        let resolved = escrow.get_escrow(&id).unwrap();
        assert_eq!(resolved.state, EscrowState::Released);
    }

    #[test]
    fn test_dispute_and_resolve_to_payer() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();
        escrow.raise_dispute(&id, &payee).unwrap();

        escrow.resolve_dispute(&id, &2u32).unwrap();
        let resolved = escrow.get_escrow(&id).unwrap();
        assert_eq!(resolved.state, EscrowState::Refunded);
    }

    #[test]
    fn test_funds_locked_without_second_signature() {
        let (env, payer, payee, arbiter, token, token_client) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc)
            .unwrap();

        let payer_balance_before = token_client.balance(&payer);
        escrow.deposit(&id).unwrap();

        // Funds moved from payer to contract
        let payer_balance_after = token_client.balance(&payer);
        assert_eq!(payer_balance_after, payer_balance_before - 1_000_000_000i128);

        // State is Funded — not Approved — so release will fail
        let agreement = escrow.get_escrow(&id).unwrap();
        assert_eq!(agreement.state, EscrowState::Funded);
        assert!(!agreement.arbiter_approved);
    }

    // ── Input-validation error tests ──────────────────────────────

    #[test]
    fn test_zero_amount_rejected() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let result = escrow.try_create_escrow(
            &payer, &payee, &arbiter, &token, &0i128, &expiry, &desc,
        );
        assert_eq!(result, Err(Ok(EscrowError::InvalidAmount)));
    }

    #[test]
    fn test_negative_amount_rejected() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let result = escrow.try_create_escrow(
            &payer, &payee, &arbiter, &token, &-1i128, &expiry, &desc,
        );
        assert_eq!(result, Err(Ok(EscrowError::InvalidAmount)));
    }

    #[test]
    fn test_payer_cannot_be_payee() {
        let (env, payer, _payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let result = escrow.try_create_escrow(
            &payer, &payer, &arbiter, &token, &1_000_000_000i128, &expiry, &desc,
        );
        assert_eq!(result, Err(Ok(EscrowError::SelfAsCounterparty)));
    }

    #[test]
    fn test_arbiter_cannot_be_payer() {
        let (env, payer, payee, _arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        // Arbiter same as payer
        let result = escrow.try_create_escrow(
            &payer, &payee, &payer, &token, &1_000_000_000i128, &expiry, &desc,
        );
        assert_eq!(result, Err(Ok(EscrowError::SameArbiterAsParty)));
    }

    #[test]
    fn test_arbiter_cannot_be_payee() {
        let (env, payer, payee, _arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        // Arbiter same as payee
        let result = escrow.try_create_escrow(
            &payer, &payee, &payee, &token, &1_000_000_000i128, &expiry, &desc,
        );
        assert_eq!(result, Err(Ok(EscrowError::SameArbiterAsParty)));
    }

    // ── Not-found error tests ─────────────────────────────────────

    #[test]
    fn test_get_escrow_not_found() {
        let (env, _payer, _payee, _arbiter, _token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let result = escrow.try_get_escrow(&999u64);
        assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
    }

    #[test]
    fn test_deposit_not_found() {
        let (env, _payer, _payee, _arbiter, _token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let result = escrow.try_deposit(&999u64);
        assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
    }

    #[test]
    fn test_approve_release_not_found() {
        let (env, _payer, _payee, _arbiter, _token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let result = escrow.try_approve_release(&999u64);
        assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
    }

    #[test]
    fn test_release_not_found() {
        let (env, _payer, _payee, _arbiter, _token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let result = escrow.try_release(&999u64);
        assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
    }

    #[test]
    fn test_refund_not_found() {
        let (env, _payer, _payee, _arbiter, _token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let result = escrow.try_refund(&999u64);
        assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
    }

    #[test]
    fn test_is_refundable_not_found() {
        let (env, _payer, _payee, _arbiter, _token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let result = escrow.try_is_refundable(&999u64);
        assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
    }

    // ── State-machine error tests ─────────────────────────────────

    #[test]
    fn test_release_without_arbiter_approval_fails() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();

        // Funded but not Approved → NotApproved
        let result = escrow.try_release(&id);
        assert_eq!(result, Err(Ok(EscrowError::NotApproved)));
    }

    #[test]
    fn test_refund_after_approval_fails_before_expiry() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &500_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();
        escrow.approve_release(&id).unwrap();

        // Approved but not expired → AlreadyApproved
        let result = escrow.try_refund(&id);
        assert_eq!(result, Err(Ok(EscrowError::AlreadyApproved)));
    }

    #[test]
    fn test_double_init_rejected() {
        let (env, _payer, _payee, _arbiter, _token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let result = escrow.try_init(&admin);
        assert_eq!(result, Err(Ok(EscrowError::AlreadyInitialized)));
    }

    #[test]
    fn test_invalid_resolution_rejected() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();
        escrow.raise_dispute(&id, &payer).unwrap();

        // Resolution value 0 is invalid
        let result = escrow.try_resolve_dispute(&id, &0u32);
        assert_eq!(result, Err(Ok(EscrowError::InvalidResolution)));

        // Resolution value 3 is also invalid
        let result = escrow.try_resolve_dispute(&id, &3u32);
        assert_eq!(result, Err(Ok(EscrowError::InvalidResolution)));
    }

    #[test]
    fn test_deposit_already_funded_rejected() {
        let (env, payer, payee, arbiter, token, _tc) = setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin).unwrap();

        let expiry = env.ledger().timestamp() + 86400;
        let desc = String::from_str(&env, "Test");

        let id = escrow
            .create_escrow(&payer, &payee, &arbiter, &token, &1_000_000_000i128, &expiry, &desc)
            .unwrap();
        escrow.deposit(&id).unwrap();

        // Second deposit attempt → AlreadyFunded
        let result = escrow.try_deposit(&id);
        assert_eq!(result, Err(Ok(EscrowError::AlreadyFunded)));
    }
}
