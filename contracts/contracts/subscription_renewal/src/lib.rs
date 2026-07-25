#![no_std]
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env};

/// Storage keys for contract-level state (admin, pause flag).
#[contracttype]
#[derive(Clone)]
enum ContractKey {
    Admin,
    Paused,
}

/// Storage key for approvals: (sub_id, approval_id)
#[contracttype]
#[derive(Clone)]
struct ApprovalKey {
    sub_id: u64,
    approval_id: u64,
}

/// Storage key for executor: sub_id
#[contracttype]
#[derive(Clone)]
struct ExecutorKey {
    sub_id: u64,
}

/// Renewal approval bound to subscription, amount, and expiration
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenewalApproval {
    pub sub_id: u64,
    pub max_spend: i128,
    pub expires_at: u32,
    pub used: bool,
}

/// Represents the current state of a subscription
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubscriptionState {
    Active,
    Retrying,
    Failed,
}

/// Core subscription data stored on-chain
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionData {
    pub owner: Address,
    pub state: SubscriptionState,
    pub failure_count: u32,
    pub last_attempt_ledger: u32,
}

/// Events for subscription renewal tracking
#[contractevent]
pub struct RenewalSuccess {
    pub sub_id: u64,
    pub owner: Address,
}

#[contractevent]
pub struct RenewalFailed {
    pub sub_id: u64,
    pub failure_count: u32,
    pub ledger: u32,
}

#[contractevent]
pub struct StateTransition {
    pub sub_id: u64,
    pub new_state: SubscriptionState,
}

#[contractevent]
pub struct PauseToggled {
    pub paused: bool,
}

#[contractevent]
pub struct ApprovalCreated {
    pub sub_id: u64,
    pub approval_id: u64,
    pub max_spend: i128,
    pub expires_at: u32,
}

#[contractevent]
pub struct ApprovalRejected {
    pub sub_id: u64,
    pub approval_id: u64,
    pub reason: u32, // 1=expired, 2=used, 3=amount_exceeded, 4=not_found
}

#[contractevent]
pub struct ExecutorAssigned {
    pub sub_id: u64,
    pub executor: Address,
}

#[contractevent]
pub struct ExecutorRemoved {
    pub sub_id: u64,
}

#[contract]
pub struct SubscriptionRenewalContract;

#[contractimpl]
impl SubscriptionRenewalContract {
    // ── Admin / Pause management ──────────────────────────────────

    /// Initialize the contract admin. Can only be called once.
    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&ContractKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&ContractKey::Admin, &admin);
        env.storage().instance().set(&ContractKey::Paused, &false);
    }

    /// Internal helper – loads admin and calls `require_auth`.
    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ContractKey::Admin)
            .expect("Contract not initialized");
        admin.require_auth();
    }

    /// Pause or unpause all renewal execution. Admin only.
    pub fn set_paused(env: Env, paused: bool) {
        Self::require_admin(&env);
        env.storage().instance().set(&ContractKey::Paused, &paused);
        PauseToggled { paused }.publish(&env);
    }

    /// Query the current pause state.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&ContractKey::Paused)
            .unwrap_or(false)
    }

    // ── Subscription logic ────────────────────────────────────────

    /// Initialize a subscription
    pub fn init_sub(env: Env, info: Address, sub_id: u64) {
        let key = sub_id;
        let data = SubscriptionData {
            owner: info,
            state: SubscriptionState::Active,
            failure_count: 0,
            last_attempt_ledger: 0,
        };
        env.storage().persistent().set(&key, &data);
    }

    // ── Executor management ───────────────────────────────────────

    /// Assign executor for subscription (owner only)
    pub fn set_executor(env: Env, sub_id: u64, executor: Address) {
        let data: SubscriptionData = env
            .storage()
            .persistent()
            .get(&sub_id)
            .expect("Subscription not found");

        data.owner.require_auth();

        let key = ExecutorKey { sub_id };
        env.storage().persistent().set(&key, &executor);

        ExecutorAssigned { sub_id, executor }.publish(&env);
    }

    /// Remove executor (owner only)
    pub fn remove_executor(env: Env, sub_id: u64) {
        let data: SubscriptionData = env
            .storage()
            .persistent()
            .get(&sub_id)
            .expect("Subscription not found");

        data.owner.require_auth();

        let key = ExecutorKey { sub_id };
        env.storage().persistent().remove(&key);

        ExecutorRemoved { sub_id }.publish(&env);
    }

    /// Get executor for subscription
    pub fn get_executor(env: Env, sub_id: u64) -> Option<Address> {
        let key = ExecutorKey { sub_id };
        env.storage().persistent().get(&key)
    }

    // ── Approval management ───────────────────────────────────────

    /// Create a renewal approval for a subscription
    pub fn approve_renewal(
        env: Env,
        sub_id: u64,
        approval_id: u64,
        max_spend: i128,
        expires_at: u32,
    ) {
        // Guard: max_spend must be a positive monetary value.
        if max_spend <= 0 {
            panic!("max_spend must be positive");
        }
        let sub_key = sub_id;
        let data: SubscriptionData = env
            .storage()
            .persistent()
            .get(&sub_key)
            .expect("Subscription not found");

        data.owner.require_auth();

        let approval = RenewalApproval {
            sub_id,
            max_spend,
            expires_at,
            used: false,
        };

        let key = ApprovalKey {
            sub_id,
            approval_id,
        };
        env.storage().persistent().set(&key, &approval);

        ApprovalCreated {
            sub_id,
            approval_id,
            max_spend,
            expires_at,
        }
        .publish(&env);
    }

    /// Validate and consume an approval
    fn consume_approval(env: &Env, sub_id: u64, approval_id: u64, amount: i128) -> bool {
        let key = ApprovalKey {
            sub_id,
            approval_id,
        };

        let approval_opt: Option<RenewalApproval> = env.storage().persistent().get(&key);

        if approval_opt.is_none() {
            ApprovalRejected {
                sub_id,
                approval_id,
                reason: 4,
            }
            .publish(env);
            return false;
        }

        let mut approval = approval_opt.unwrap();

        if approval.used {
            ApprovalRejected {
                sub_id,
                approval_id,
                reason: 2,
            }
            .publish(env);
            return false;
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger > approval.expires_at {
            ApprovalRejected {
                sub_id,
                approval_id,
                reason: 1,
            }
            .publish(env);
            return false;
        }

        if amount > approval.max_spend {
            ApprovalRejected {
                sub_id,
                approval_id,
                reason: 3,
            }
            .publish(env);
            return false;
        }

        approval.used = true;
        env.storage().persistent().set(&key, &approval);
        true
    }

    // ── Renewal logic ─────────────────────────────────────────────

    /// Attempt to renew the subscription.
    /// Callable by owner or assigned executor.
    /// Returns true if renewal is successful (simulated), false if it failed and retry logic was triggered.
    /// limits: max retries allowed.
    /// cooldown: min ledgers between retries.
    pub fn renew(
        env: Env,
        caller: Address,
        sub_id: u64,
        approval_id: u64,
        amount: i128,
        max_retries: u32,
        cooldown_ledgers: u32,
        succeed: bool,
    ) -> bool {
        // Guard: amount must be a positive monetary value.
        if amount <= 0 {
            panic!("amount must be positive");
        }
        // Check global pause
        if Self::is_paused(env.clone()) {
            panic!("Protocol is paused");
        }

        let key = sub_id;
        let mut data: SubscriptionData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Subscription not found");

        // Verify caller is owner or executor
        caller.require_auth();
        let executor_key = ExecutorKey { sub_id };
        let executor: Option<Address> = env.storage().persistent().get(&executor_key);
        
        if caller != data.owner && Some(caller.clone()) != executor {
            panic!("Unauthorized: caller must be owner or executor");
        }

        // Validate and consume approval
        if !Self::consume_approval(&env, sub_id, approval_id, amount) {
            panic!("Invalid or expired approval");
        }

        // If already failed, we can't renew
        if data.state == SubscriptionState::Failed {
            panic!("Subscription is in FAILED state");
        }

        let current_ledger = env.ledger().sequence();

        // Check cooldown
        if data.failure_count > 0 && current_ledger < data.last_attempt_ledger + cooldown_ledgers {
            panic!("Cooldown period active");
        }

        if succeed {
            // Simulated success - renewal successful
            data.state = SubscriptionState::Active;
            data.failure_count = 0;
            data.last_attempt_ledger = current_ledger;
            env.storage().persistent().set(&key, &data);

            // Emit renewal success event
            RenewalSuccess {
                sub_id,
                owner: data.owner.clone(),
            }
            .publish(&env);

            true
        } else {
            // Simulated failure - renewal failed, apply retry logic
            data.failure_count = data.failure_count
                .checked_add(1)
                .expect("failure_count overflow");
            data.last_attempt_ledger = current_ledger;

            // Emit renewal failure event
            RenewalFailed {
                sub_id,
                failure_count: data.failure_count,
                ledger: current_ledger,
            }
            .publish(&env);

            // Determine new state based on retry count
            if data.failure_count > max_retries {
                data.state = SubscriptionState::Failed;
                StateTransition {
                    sub_id,
                    new_state: SubscriptionState::Failed,
                }
                .publish(&env);
            } else {
                data.state = SubscriptionState::Retrying;
                StateTransition {
                    sub_id,
                    new_state: SubscriptionState::Retrying,
                }
                .publish(&env);
            }

            env.storage().persistent().set(&key, &data);
            false
        }
    }

    pub fn get_sub(env: Env, sub_id: u64) -> SubscriptionData {
        env.storage()
            .persistent()
            .get(&sub_id)
            .expect("Subscription not found")
    }
}

#[cfg(test)]
mod test;
