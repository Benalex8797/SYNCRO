use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, contracterror, vec, xdr::ToXdr,
    Address, BytesN, Env, String, Vec,
};

/// Typed error for monetary overflow / invalid-input conditions.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RegistryError {
    /// Arithmetic overflow on a monetary i128 field.
    AmountOverflow = 1,
    /// expected_amount must be positive.
    InvalidAmount = 2,
    /// billing_interval must be > 0.
    InvalidInterval = 3,
    /// next_renewal must be > 0.
    InvalidRenewal = 4,
    /// Subscription not found.
    NotFound = 5,
    /// Subscription is already cancelled.
    AlreadyCancelled = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionMetadata {
    pub service_id: String,
    pub billing_interval: u64,
    pub expected_amount: i128,
    pub next_renewal: u64,
    pub is_active: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    UserSubscriptions(Address),
    Subscription(BytesN<32>),
    SubscriptionCounter,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionCreatedEvent {
    pub subscription_id: BytesN<32>,
    pub user: Address,
    pub service_id: String,
    pub billing_interval: u64,
    pub expected_amount: i128,
    pub next_renewal: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionUpdatedEvent {
    pub subscription_id: BytesN<32>,
    pub user: Address,
    pub service_id: String,
    pub billing_interval: u64,
    pub expected_amount: i128,
    pub next_renewal: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionCancelledEvent {
    pub subscription_id: BytesN<32>,
    pub user: Address,
    pub service_id: String,
}

#[contract]
pub struct SubscriptionRegistry;

#[contractimpl]
impl SubscriptionRegistry {
    /// Create a new subscription for a user
    pub fn create_subscription(
        env: Env,
        user: Address,
        service_id: String,
        billing_interval: u64,
        expected_amount: i128,
        next_renewal: u64,
    ) -> Result<BytesN<32>, RegistryError> {
        if billing_interval == 0 {
            return Err(RegistryError::InvalidInterval);
        }
        if expected_amount <= 0 {
            return Err(RegistryError::InvalidAmount);
        }
        if next_renewal == 0 {
            return Err(RegistryError::InvalidRenewal);
        }

        // Generate unique subscription ID – use checked_add to guard the counter.
        let counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SubscriptionCounter)
            .unwrap_or(0u64);
        let new_counter = counter.checked_add(1).ok_or(RegistryError::AmountOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::SubscriptionCounter, &new_counter);

        // Create deterministic subscription ID from counter and user hash
        let mut id_bytes = [0u8; 32];
        let counter_bytes = counter.to_be_bytes();
        let user_bytes = user.clone().to_xdr(&env);
        id_bytes[..8].copy_from_slice(&counter_bytes);
        let user_hash = env.crypto().sha256(&user_bytes);
        id_bytes[8..32].copy_from_slice(&user_hash.to_array()[..24]);
        let subscription_id = BytesN::from_array(&env, &id_bytes);

        let metadata = SubscriptionMetadata {
            service_id: service_id.clone(),
            billing_interval,
            expected_amount,
            next_renewal,
            is_active: true,
        };
        env.storage()
            .instance()
            .set(&DataKey::Subscription(subscription_id.clone()), &metadata);

        let mut user_subs: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::UserSubscriptions(user.clone()))
            .unwrap_or_else(|| vec![&env]);
        user_subs.push_back(subscription_id.clone());
        env.storage()
            .instance()
            .set(&DataKey::UserSubscriptions(user.clone()), &user_subs);

        SubscriptionCreatedEvent {
            subscription_id: subscription_id.clone(),
            user: user.clone(),
            service_id: service_id.clone(),
            billing_interval,
            expected_amount,
            next_renewal,
        }
        .publish(&env);

        Ok(subscription_id)
    }

    /// Update an existing subscription's metadata
    pub fn update_subscription(
        env: Env,
        subscription_id: BytesN<32>,
        user: Address,
        service_id: Option<String>,
        billing_interval: Option<u64>,
        expected_amount: Option<i128>,
        next_renewal: Option<u64>,
    ) -> Result<(), RegistryError> {
        let mut metadata: SubscriptionMetadata = env
            .storage()
            .instance()
            .get(&DataKey::Subscription(subscription_id.clone()))
            .ok_or(RegistryError::NotFound)?;

        if !metadata.is_active {
            return Err(RegistryError::AlreadyCancelled);
        }

        if let Some(sid) = service_id {
            metadata.service_id = sid;
        }
        if let Some(bi) = billing_interval {
            if bi == 0 { return Err(RegistryError::InvalidInterval); }
            metadata.billing_interval = bi;
        }
        if let Some(ea) = expected_amount {
            if ea <= 0 { return Err(RegistryError::InvalidAmount); }
            // checked: new amount validated positive, no arithmetic overflow possible on assignment
            metadata.expected_amount = ea;
        }
        if let Some(nr) = next_renewal {
            if nr == 0 { return Err(RegistryError::InvalidRenewal); }
            metadata.next_renewal = nr;
        }

        env.storage()
            .instance()
            .set(&DataKey::Subscription(subscription_id.clone()), &metadata);

        SubscriptionUpdatedEvent {
            subscription_id: subscription_id.clone(),
            user: user.clone(),
            service_id: metadata.service_id.clone(),
            billing_interval: metadata.billing_interval,
            expected_amount: metadata.expected_amount,
            next_renewal: metadata.next_renewal,
        }
        .publish(&env);

        Ok(())
    }

    /// Cancel a subscription by marking it as inactive
    pub fn cancel_subscription(
        env: Env,
        subscription_id: BytesN<32>,
        user: Address,
    ) -> Result<(), RegistryError> {
        let mut metadata: SubscriptionMetadata = env
            .storage()
            .instance()
            .get(&DataKey::Subscription(subscription_id.clone()))
            .ok_or(RegistryError::NotFound)?;

        if !metadata.is_active {
            return Err(RegistryError::AlreadyCancelled);
        }

        metadata.is_active = false;
        env.storage()
            .instance()
            .set(&DataKey::Subscription(subscription_id.clone()), &metadata);

        SubscriptionCancelledEvent {
            subscription_id: subscription_id.clone(),
            user: user.clone(),
            service_id: metadata.service_id.clone(),
        }
        .publish(&env);

        Ok(())
    }

    /// Get subscription metadata by ID
    pub fn get_subscription(env: Env, subscription_id: BytesN<32>) -> Option<SubscriptionMetadata> {
        env.storage()
            .instance()
            .get(&DataKey::Subscription(subscription_id))
    }

    /// Get all subscription IDs for a user
    pub fn get_user_subscriptions(env: Env, user: Address) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&DataKey::UserSubscriptions(user))
            .unwrap_or_else(|| vec![&env])
    }
}
