#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, Env};

#[test]
fn happy_path_open_close_and_top_up() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &10);
    client.top_up(&channel_id, &25, &depositor);

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.balance_a, 125);
    assert_eq!(channel.state, ChannelState::Open);

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
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
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
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &1);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);

    env.ledger().set_timestamp(10);
    client.finalize(&channel_id);

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closed);
}

#[test]
fn test_channel_id_uniqueness() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);

    let id1 = client.open_channel(&depositor, &counterparty, &100, &10);
    let id2 = client.open_channel(&depositor, &counterparty, &200, &10);
    let id3 = client.open_channel(&depositor, &counterparty, &300, &10);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);
    assert_ne!(id1, id2);
    assert_ne!(id2, id3);
}

#[test]
fn test_channel_counter_overflow_guard() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);

    // Manually set ChannelCount to u64::MAX in instance storage
    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::ChannelCount, &u64::MAX);
    });

    let result = client.try_open_channel(&depositor, &counterparty, &100, &10);
    assert_eq!(result, Err(Ok(Error::CounterOverflow)));
}

#[test]
fn test_unauthorized_initiate_close_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &10);

    let res = client.try_initiate_close(&channel_id, &50, &50, &1, &attacker);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_unauthorized_submit_state_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let attacker1 = Address::generate(&env);
    let attacker2 = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &10);

    let res = client.try_submit_state(&channel_id, &50, &50, &1, &attacker1, &attacker2);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_unauthorized_dispute_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let attacker1 = Address::generate(&env);
    let attacker2 = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.initiate_close(&channel_id, &90, &10, &1, &depositor);

    let res = client.try_dispute(&channel_id, &80, &20, &2, &attacker1, &attacker2);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}


