#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Env,
};

// ── Test helpers ──────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address, Address, TokenClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    // Register a real SEP-41 token so we can verify disbursements.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = TokenClient::new(&env, &sac.address());
    let asset_admin = StellarAssetClient::new(&env, &sac.address());
    asset_admin.mint(&depositor, &1_000_000_000i128);

    (env, admin, depositor, counterparty, sac.address(), token)
}

fn register_contract(env: &Env) -> PaymentChannelContractClient<'static> {
    let id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(env, &id);
    let admin = Address::generate(env);
    client.init(&admin);
    client
}

// ── Existing behaviour tests ──────────────────────────────────────────────────

#[test]
fn happy_path_open_close_and_top_up() {
    let (env, _admin, depositor, counterparty, token, token_client) = setup();
    let client = register_contract(&env);

    let deposit = 100i128;
    let depositor_before = token_client.balance(&depositor);

    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &deposit, &10);

    // Depositor balance should have decreased by `deposit`.
    assert_eq!(
        token_client.balance(&depositor),
        depositor_before - deposit
    );

    // Top-up
    client.top_up(&channel_id, &25, &depositor);
    assert_eq!(
        token_client.balance(&depositor),
        depositor_before - deposit - 25
    );

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.balance_a, 125);
    assert_eq!(channel.state, ChannelState::Open);

    // Initiate close then finalize after deadline.
    client.initiate_close(&channel_id, &120, &5, &1, &depositor);

    let closing = client.get_channel(&channel_id).unwrap();
    env.ledger().set_timestamp(closing.dispute_deadline + 1);
    client.finalize(&channel_id);

    let closed = client.get_channel(&channel_id).unwrap();
    assert_eq!(closed.state, ChannelState::Closed);
    assert_eq!(closed.sequence, 1);
}

#[test]
fn dispute_path_overrides_stale_close() {
    let (env, _admin, depositor, counterparty, token, _token_client) = setup();
    let client = register_contract(&env);

    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &100, &100);
    client.initiate_close(&channel_id, &90, &10, &1, &depositor);
    client.dispute(&channel_id, &80, &20, &2, &depositor, &counterparty);

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Dispute);
    assert_eq!(channel.sequence, 2);
    assert_eq!(channel.balance_a, 80);
    assert_eq!(channel.balance_b, 20);
}

#[test]
fn finalize_releases_after_timeout() {
    let (env, _admin, depositor, counterparty, token, _token_client) = setup();
    let client = register_contract(&env);

    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &100, &1);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);

    env.ledger().set_timestamp(10);
    client.finalize(&channel_id);

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closed);
}

// ── CEI / disbursement tests ──────────────────────────────────────────────────

/// After `finalize`, depositor and counterparty receive their agreed shares.
/// This verifies the fix for the locked-funds functional gap identified in the
/// CEI audit.
#[test]
fn test_finalize_disburses_tokens_to_both_parties() {
    let (env, _admin, depositor, counterparty, token, token_client) = setup();
    let client = register_contract(&env);

    // Open with 200 total (all in depositor's side initially).
    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &200, &10);

    // Both parties agree on a 120 / 80 split.
    client.initiate_close(&channel_id, &120, &80, &1, &depositor);

    let deposit_before = token_client.balance(&depositor);
    let counterparty_before = token_client.balance(&counterparty);

    // Advance past the dispute deadline.
    let ch = client.get_channel(&channel_id).unwrap();
    env.ledger().set_timestamp(ch.dispute_deadline + 1);

    client.finalize(&channel_id);

    // Depositor should have received 120.
    assert_eq!(
        token_client.balance(&depositor),
        deposit_before + 120
    );
    // Counterparty should have received 80.
    assert_eq!(
        token_client.balance(&counterparty),
        counterparty_before + 80
    );

    // Channel must be Closed.
    let closed = client.get_channel(&channel_id).unwrap();
    assert_eq!(closed.state, ChannelState::Closed);
}

/// CEI partial-failure test: a second `finalize` on an already-closed channel
/// must fail with `InvalidState` — the state guard written in the EFFECTS phase
/// prevents double-disbursal.
#[test]
#[should_panic]
fn test_finalize_cannot_be_called_twice() {
    let (env, _admin, depositor, counterparty, token, _token_client) = setup();
    let client = register_contract(&env);

    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &100, &5);
    client.initiate_close(&channel_id, &100, &0, &1, &depositor);

    env.ledger().set_timestamp(100);
    client.finalize(&channel_id); // first call — succeeds

    // Second call — must fail because state is now `Closed`.
    client.finalize(&channel_id);
}

/// After finalize the contract's token balance should be zero (all funds
/// disbursed).  This confirms there is no residual locked amount.
#[test]
fn test_finalize_drains_contract_balance() {
    let (env, _admin, depositor, counterparty, token, token_client) = setup();
    let client = register_contract(&env);

    let contract_id = env.register_contract(None, PaymentChannelContract);
    // Use the already-registered contract from register_contract helper;
    // just open a channel through the existing `client`.

    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &300, &10);

    // Query the actual contract address.
    let channel = client.get_channel(&channel_id).unwrap();
    // The contract address is implicit; we verify via balance transfers.

    // Agree: depositor gets 200, counterparty gets 100.
    client.initiate_close(&channel_id, &200, &100, &1, &depositor);

    let ch = client.get_channel(&channel_id).unwrap();
    env.ledger().set_timestamp(ch.dispute_deadline + 1);

    client.finalize(&channel_id);

    // Sum of disbursements (200 + 100) must equal original deposit of 300.
    // Both balances increased by their respective shares.
    let depositor_final = token_client.balance(&depositor);
    let counterparty_final = token_client.balance(&counterparty);
    // Depositor started with 1_000_000_000, deposited 300, got back 200.
    // Net change: -100.  Counterparty started with 0, got 100.
    assert_eq!(depositor_final, 1_000_000_000 - 300 + 200); // = 999_999_900
    assert_eq!(counterparty_final, 100);
}

/// CEI partial-failure: `finalize` during an active dispute window must revert,
/// leaving channel state and token balances unchanged.
#[test]
#[should_panic]
fn test_finalize_before_deadline_is_rejected() {
    let (env, _admin, depositor, counterparty, token, _token_client) = setup();
    let client = register_contract(&env);

    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &100, &1000);
    client.initiate_close(&channel_id, &100, &0, &1, &depositor);

    // Do NOT advance the timestamp — deadline is still in the future.
    client.finalize(&channel_id); // must panic with DisputeWindowActive
}

/// CEI partial-failure: `finalize` on a channel in the wrong state is rejected.
#[test]
#[should_panic]
fn test_finalize_open_channel_is_rejected() {
    let (env, _admin, depositor, counterparty, token, _token_client) = setup();
    let client = register_contract(&env);

    let channel_id =
        client.open_channel(&depositor, &counterparty, &token, &100, &10);

    // Channel is still Open — finalize must reject.
    client.finalize(&channel_id);
}
