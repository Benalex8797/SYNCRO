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
    client.finalize(&channel_id, &1);

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
    client.finalize(&channel_id, &1);

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closed);
}

#[test]
fn finalize_rejects_stale_sequence() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);

    let closing = client.get_channel(&channel_id).unwrap();
    env.ledger().set_timestamp(closing.dispute_deadline + 1);
    
    let result = client.try_finalize(&channel_id, &0);
    assert_eq!(result, Err(Ok(Error::StaleState)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closing);
}

#[test]
fn finalize_rejects_wrong_sequence() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);

    let closing = client.get_channel(&channel_id).unwrap();
    env.ledger().set_timestamp(closing.dispute_deadline + 1);
    
    let result = client.try_finalize(&channel_id, &999);
    assert_eq!(result, Err(Ok(Error::StaleState)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closing);
}

#[test]
fn finalize_blocked_before_dispute_window() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);

    let closing = client.get_channel(&channel_id).unwrap();
    env.ledger().set_timestamp(closing.dispute_deadline - 1);
    
    let result = client.try_finalize(&channel_id, &1);
    assert_eq!(result, Err(Ok(Error::DisputeWindowActive)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closing);
}

#[test]
fn initiate_close_rejects_stale_sequence() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.submit_state(&channel_id, &60, &40, &5, &depositor, &counterparty);

    let result = client.try_initiate_close(&channel_id, &70, &30, &3, &depositor);
    assert_eq!(result, Err(Ok(Error::StaleState)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Open);
    assert_eq!(channel.sequence, 5);
}

#[test]
fn dispute_rejects_stale_sequence() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.initiate_close(&channel_id, &70, &30, &5, &depositor);

    let result = client.try_dispute(&channel_id, &80, &20, &3, &depositor, &counterparty);
    assert_eq!(result, Err(Ok(Error::StaleState)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closing);
    assert_eq!(channel.sequence, 5);
}

#[test]
fn top_up_blocked_during_closing() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);

    let result = client.try_top_up(&channel_id, &50, &depositor);
    assert_eq!(result, Err(Ok(Error::InvalidState)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.balance_a, 70);
    assert_eq!(channel.state, ChannelState::Closing);
}

#[test]
fn top_up_blocked_during_dispute() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);
    client.dispute(&channel_id, &80, &20, &2, &depositor, &counterparty);

    let result = client.try_top_up(&channel_id, &50, &depositor);
    assert_eq!(result, Err(Ok(Error::InvalidState)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.balance_a, 80);
    assert_eq!(channel.state, ChannelState::Dispute);
}

#[test]
fn dispute_rejected_after_window_expires() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin);
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &10);
    client.initiate_close(&channel_id, &70, &30, &1, &depositor);

    env.ledger().set_timestamp(20);
    
    let result = client.try_dispute(&channel_id, &80, &20, &2, &depositor, &counterparty);
    assert_eq!(result, Err(Ok(Error::DisputeWindowExpired)));
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closing);
}
