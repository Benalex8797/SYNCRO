#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env};

#[test]
fn happy_path_open_close_and_top_up() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentChannelContract);
    let client = PaymentChannelContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let counterparty = Address::generate(&env);

    client.init(&admin).unwrap();
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &10).unwrap();
    client.top_up(&channel_id, &25, &depositor).unwrap();

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.balance_a, 125);
    assert_eq!(channel.state, ChannelState::Open);

    client.initiate_close(&channel_id, &120, &5, &1, &depositor).unwrap();
    client.submit_state(&channel_id, &120, &5, &2, &depositor, &counterparty).unwrap();

    let closed = client.get_channel(&channel_id).unwrap();
    assert_eq!(closed.state, ChannelState::Closed);
    assert_eq!(closed.sequence, 2);
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

    client.init(&admin).unwrap();
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &100).unwrap();
    client.initiate_close(&channel_id, &90, &10, &1, &depositor).unwrap();
    client.dispute(&channel_id, &80, &20, &2, &depositor, &counterparty).unwrap();

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

    client.init(&admin).unwrap();
    let channel_id = client.open_channel(&depositor, &counterparty, &100, &1).unwrap();
    client.initiate_close(&channel_id, &70, &30, &1, &depositor).unwrap();

    env.ledger().set_timestamp(10);
    client.finalize(&channel_id).unwrap();

    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.state, ChannelState::Closed);
}
