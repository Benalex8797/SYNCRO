#![cfg(test)]
extern crate std;

use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};
use std::panic::{catch_unwind, AssertUnwindSafe};

use super::{EscrowContract, EscrowContractClient, EscrowState};

fn fuzz_env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
        ..EnvTestConfig::default()
    })
}

fn fuzz_setup() -> (Env, Address, Address, Address, Address, TokenClient<'static>) {
    let env = fuzz_env();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let arbiter = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token = TokenClient::new(&env, &token_addr);
    let asset_client = StellarAssetClient::new(&env, &token_addr);
    asset_client.mint(&payer, &100_000_000_000i128);

    (env, payer, payee, arbiter, token_addr, token)
}

fn register_escrow(env: &Env) -> EscrowContractClient<'static> {
    let contract_id = env.register_contract(None, EscrowContract);
    EscrowContractClient::new(env, &contract_id)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(8))]

    // ── Monetary invariants ──────────────────────────────────────────────────

    /// Depositing any positive amount must land in the contract and move the
    /// escrow to Funded. The payer's token balance must decrease by exactly
    /// `amount`.
    #[test]
    fn fuzz_deposit_with_random_amounts(amount in 1i128..=50_000_000_000i128) {
        let (env, payer, payee, arbiter, token, token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz");

        let payer_balance_before = token_client.balance(&payer);
        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );

        escrow.deposit(&id);
        let agreement = escrow.get_escrow(&id);
        prop_assert_eq!(agreement.deposited, amount);
        prop_assert_eq!(agreement.state, EscrowState::Funded);
        prop_assert_eq!(token_client.balance(&payer), payer_balance_before - amount);
    }

    /// Double-deposit on the same escrow must be rejected — the `deposited`
    /// field and `Funded` state must remain unchanged.
    #[test]
    fn fuzz_concurrent_deposit_rejected(amount in 1i128..=10_000_000_000i128) {
        let (env, payer, payee, arbiter, token, _token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);

        let result = catch_unwind(AssertUnwindSafe(|| {
            escrow.deposit(&id);
        }));
        prop_assert!(result.is_err(), "double deposit must panic with AlreadyFunded");

        let agreement = escrow.get_escrow(&id);
        prop_assert_eq!(agreement.deposited, amount);
        prop_assert_eq!(agreement.state, EscrowState::Funded);
    }

    /// Depositing then refunding (before arbiter approval) must restore the
    /// payer's balance to exactly where it was before the deposit.
    #[test]
    fn fuzz_deposit_refund_conservation(amount in 1i128..=10_000_000_000i128) {
        let (env, payer, payee, arbiter, token, token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz");
        let balance_before = token_client.balance(&payer);

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.refund(&id);

        prop_assert_eq!(token_client.balance(&payer), balance_before);
        prop_assert_eq!(escrow.get_escrow(&id).state, EscrowState::Refunded);
    }

    /// The full happy path (deposit → approve → release) must transfer exactly
    /// `amount` tokens to the payee. Conservation: payer_out + payee_in == 0.
    #[test]
    fn fuzz_full_happy_path_conservation(amount in 1i128..=10_000_000_000i128) {
        let (env, payer, payee, arbiter, token, token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz_happy");
        let payer_before = token_client.balance(&payer);
        let payee_before = token_client.balance(&payee);

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);
        escrow.release(&id);

        let payer_after = token_client.balance(&payer);
        let payee_after = token_client.balance(&payee);

        prop_assert_eq!(payer_after, payer_before - amount, "payer lost exactly amount");
        prop_assert_eq!(payee_after, payee_before + amount, "payee gained exactly amount");
        prop_assert_eq!(escrow.get_escrow(&id).state, EscrowState::Released);
    }

    // ── Input validation ─────────────────────────────────────────────────────

    /// Non-positive amounts must be rejected at create time.
    #[test]
    fn fuzz_invalid_amounts_rejected(amount in -1_000_000i128..=0i128) {
        let (env, payer, payee, arbiter, token, _token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz");

        let result = catch_unwind(AssertUnwindSafe(|| {
            escrow.create_escrow(
                &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
            );
        }));
        prop_assert!(result.is_err(), "non-positive amount must panic");
    }

    // ── Authorization invariants ──────────────────────────────────────────────

    /// Only payer or payee may raise a dispute — a stranger must be rejected
    /// and the escrow must remain in `Funded` state.
    #[test]
    fn fuzz_unauthorized_dispute_rejected(amount in 1i128..=1_000_000_000i128) {
        let (env, payer, payee, arbiter, token, _token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);

        let stranger = Address::generate(&env);
        let result = catch_unwind(AssertUnwindSafe(|| {
            escrow.raise_dispute(&id, &stranger);
        }));
        prop_assert!(result.is_err(), "unauthorized dispute must panic");

        prop_assert_eq!(escrow.get_escrow(&id).state, EscrowState::Funded);
    }

    /// Releasing funds without arbiter approval must always panic — the escrow
    /// must not leave `Funded` state.
    #[test]
    fn fuzz_release_without_approval_rejected(amount in 1i128..=1_000_000_000i128) {
        let (env, payer, payee, arbiter, token, _token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);

        let result = catch_unwind(AssertUnwindSafe(|| {
            escrow.release(&id);
        }));
        prop_assert!(result.is_err(), "release without approval must panic");
        prop_assert_eq!(escrow.get_escrow(&id).state, EscrowState::Funded);
    }

    // ── State transition invariants ──────────────────────────────────────────

    /// After raising a dispute, resolve_dispute(1) must transfer funds to the
    /// payee and put the escrow in `Released` state.  Balance conservation
    /// must hold.
    #[test]
    fn fuzz_dispute_resolve_to_payee_conservation(amount in 1i128..=10_000_000_000i128) {
        let (env, payer, payee, arbiter, token, token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz_dispute_payee");
        let payee_before = token_client.balance(&payee);

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.raise_dispute(&id, &payer);
        prop_assert_eq!(escrow.get_escrow(&id).state, EscrowState::Disputed);

        escrow.resolve_dispute(&id, &1u32);

        let after = escrow.get_escrow(&id);
        prop_assert_eq!(after.state, EscrowState::Released);
        prop_assert_eq!(token_client.balance(&payee), payee_before + amount);
    }

    /// After raising a dispute, resolve_dispute(2) must refund the payer and
    /// put the escrow in `Refunded` state.  Balance conservation must hold.
    #[test]
    fn fuzz_dispute_resolve_to_payer_conservation(amount in 1i128..=10_000_000_000i128) {
        let (env, payer, payee, arbiter, token, token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz_dispute_payer");
        let payer_before = token_client.balance(&payer);

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);

        // payer locked amount, so payer_before - amount is current balance
        escrow.raise_dispute(&id, &payee);
        escrow.resolve_dispute(&id, &2u32);

        let after = escrow.get_escrow(&id);
        prop_assert_eq!(after.state, EscrowState::Refunded);
        prop_assert_eq!(token_client.balance(&payer), payer_before);
    }

    /// Resolving a dispute with an invalid resolution code must panic.
    #[test]
    fn fuzz_invalid_resolution_code_rejected(
        amount in 1i128..=1_000_000_000i128,
        bad_code in 3u32..=u32::MAX,
    ) {
        let (env, payer, payee, arbiter, token, _token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz_bad_code");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.raise_dispute(&id, &payer);

        let result = catch_unwind(AssertUnwindSafe(|| {
            escrow.resolve_dispute(&id, &bad_code);
        }));
        prop_assert!(result.is_err(), "invalid resolution code must panic");
    }

    /// Arbiter approval must be single-use — calling approve_release twice on
    /// the same escrow must panic on the second call.
    #[test]
    fn fuzz_double_approval_rejected(amount in 1i128..=1_000_000_000i128) {
        let (env, payer, payee, arbiter, token, _token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;
        let desc = String::from_str(&env, "fuzz_double_approve");

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);

        let result = catch_unwind(AssertUnwindSafe(|| {
            escrow.approve_release(&id);
        }));
        prop_assert!(result.is_err(), "second arbiter approval must panic");
    }

    /// After expiry the payer can unilaterally claim a refund even when the
    /// arbiter has already approved. Token balance conservation must hold.
    #[test]
    fn fuzz_expiry_unilateral_refund(
        amount in 1i128..=10_000_000_000i128,
        ttl in 1u64..=1_000u64,
    ) {
        let (env, payer, payee, arbiter, token, token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let now = env.ledger().timestamp();
        let expiry = now + ttl;
        let desc = String::from_str(&env, "fuzz_expiry");
        let payer_before = token_client.balance(&payer);

        let id = escrow.create_escrow(
            &payer, &payee, &arbiter, &token, &amount, &expiry, &desc,
        );
        escrow.deposit(&id);
        escrow.approve_release(&id);

        // Advance ledger past expiry — payer can now refund unilaterally
        env.ledger().set_timestamp(expiry + 1);
        escrow.refund(&id);

        prop_assert_eq!(escrow.get_escrow(&id).state, EscrowState::Refunded);
        prop_assert_eq!(token_client.balance(&payer), payer_before);
    }

    /// Escrow count must be monotonically increasing and never skip IDs.
    #[test]
    fn fuzz_escrow_count_monotonic(n in 1u64..=10u64) {
        let (env, payer, payee, arbiter, token, _token_client) = fuzz_setup();
        let escrow = register_escrow(&env);
        let admin = Address::generate(&env);
        escrow.init(&admin);

        let expiry = env.ledger().timestamp() + 86_400u64;

        for i in 1..=n {
            let desc = String::from_str(&env, "fuzz_count");
            let id = escrow.create_escrow(
                &payer, &payee, &arbiter, &token, &1_000i128, &expiry, &desc,
            );
            prop_assert_eq!(id, i, "escrow IDs must be sequential starting from 1");
        }

        prop_assert_eq!(escrow.get_escrow_count(), n);
    }
}
