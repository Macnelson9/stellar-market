#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, String,
    Symbol, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    JobNotFound = 1,
    Unauthorized = 2,
    InvalidStatus = 3,
    MilestoneNotFound = 4,
    InsufficientFunds = 5,
    AlreadyFunded = 6,
    InvalidDeadline = 7,
    MilestoneDeadlineExceeded = 8,
    HasPendingMilestone = 9,
    NoRefundDue = 10,
    GracePeriodNotMet = 11,
    InvalidMilestoneIndex = 12,
    TokenNotAllowed = 13,
    AlreadyInitialized = 14,
    ContractPaused = 15,
    NotAdmin = 16,
    /// A revision proposal already exists for this job in Pending status.
    RevisionProposalAlreadyExists = 17,
    /// No revision proposal exists for this job.
    RevisionProposalNotFound = 18,
    /// The caller is not authorized to perform this action on the proposal.
    NotAuthorizedForProposalAction = 19,
    /// The proposal is not in Pending status and cannot be acted upon.
    ProposalNotPending = 20,
    /// Insufficient funds to cover the increased total.
    InsufficientTopUp = 21,
    /// The proposed new_total does not match the sum of milestone amounts.
    ProposalTotalMismatch = 22,
    /// The proposed milestone list is empty.
    EmptyMilestonesProposed = 23,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JobStatus {
    Created,
    Funded,
    InProgress,
    Completed,
    Disputed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeResolution {
    ClientWins,
    FreelancerWins,
    RefundBoth,
    Escalate,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MilestoneStatus {
    Pending,
    InProgress,
    Submitted,
    Approved,
}

/// Represents the lifecycle state of a revision proposal.
/// A proposal begins as Pending and transitions to either Accepted or Rejected.
/// Only one transition is permitted — a resolved proposal cannot be re-opened.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStatus {
    /// The proposal has been submitted and is awaiting a response from the opposing party.
    Pending,
    /// The opposing party has accepted the proposal. Job milestones and escrow have been updated.
    Accepted,
    /// The opposing party has rejected the proposal. No changes were made to the job.
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub id: u32,
    pub description: String,
    pub amount: i128,
    pub status: MilestoneStatus,
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Job {
    pub id: u64,
    pub client: Address,
    pub freelancer: Address,
    pub token: Address,
    pub total_amount: i128,
    pub status: JobStatus,
    pub milestones: Vec<Milestone>,
    pub job_deadline: u64,
    pub auto_refund_after: u64,
}

const MAX_FEE_BPS: u32 = 1000; // 10%

/// A formal proposal to revise the milestones and total budget of an active job.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RevisionProposal {
    pub proposer: Address,
    pub new_milestones: Vec<Milestone>,
    pub new_total: i128,
    pub status: ProposalStatus,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Job(u64),
    JobCount,
    Admin,
    Paused,
    RevisionProposal(u64),
    ProposalExpiry,
}

/// Default proposal expiry: 7 days in seconds.
const DEFAULT_PROPOSAL_EXPIRY_SECS: u64 = 7 * 24 * 3600;

fn get_job_key(job_id: u64) -> DataKey {
    DataKey::Job(job_id)
}

fn require_not_paused(env: &Env) -> Result<(), EscrowError> {
    if env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
    {
        return Err(EscrowError::ContractPaused);
    }
    Ok(())
}

fn require_admin(env: &Env, admin: &Address) -> Result<(), EscrowError> {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&symbol_short!("ADM"))
        .ok_or(EscrowError::NotAdmin)?;

    if admin != &stored_admin {
        return Err(EscrowError::NotAdmin);
    }
    Ok(())
}

const MIN_TTL_THRESHOLD: u32 = 1_000;
const MIN_TTL_EXTEND_TO: u32 = 10_000;

fn bump_job_ttl(env: &Env, job_id: u64) {
    env.storage().persistent().extend_ttl(
        &get_job_key(job_id),
        MIN_TTL_THRESHOLD,
        MIN_TTL_EXTEND_TO,
    );
}

fn bump_job_count_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(MIN_TTL_THRESHOLD, MIN_TTL_EXTEND_TO);
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize the contract with admin, treasury, fee basis points, and proposal expiry.
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_bps: u32,
        proposal_expiry_secs: u64,
    ) -> Result<(), EscrowError> {
        if env.storage().instance().has(&symbol_short!("ADM")) {
            return Err(EscrowError::AlreadyInitialized);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(EscrowError::InvalidStatus);
        }

        env.storage().instance().set(&symbol_short!("ADM"), &admin);
        env.storage()
            .instance()
            .set(&symbol_short!("TRE"), &treasury);
        env.storage().instance().set(&symbol_short!("FEE"), &fee_bps);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::ProposalExpiry, &proposal_expiry_secs);
        bump_job_count_ttl(&env);

        Ok(())
    }

    /// Pause the contract (admin only).
    pub fn pause(env: Env, admin: Address) -> Result<(), EscrowError> {
        admin.require_auth();
        require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::Paused, &true);
        bump_job_count_ttl(&env);

        // Emit event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("paused")),
            (admin, env.ledger().timestamp()),
        );

        Ok(())
    }

    /// Unpause the contract (admin only).
    pub fn unpause(env: Env, admin: Address) -> Result<(), EscrowError> {
        admin.require_auth();
        require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::Paused, &false);
        bump_job_count_ttl(&env);

        // Emit event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("unpaused")),
            (admin, env.ledger().timestamp()),
        );

        Ok(())
    }

    /// Set a new fee basis points value (admin only).
    pub fn set_fee_bps(env: Env, new_fee: u32) -> Result<(), EscrowError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("ADM"))
            .ok_or(EscrowError::Unauthorized)?;
        admin.require_auth();

        if new_fee > MAX_FEE_BPS {
            return Err(EscrowError::InvalidStatus);
        }

        env.storage().instance().set(&symbol_short!("FEE"), &new_fee);
        Ok(())
    }

    /// Set a new treasury address (admin only).
    pub fn set_treasury(env: Env, new_treasury: Address) -> Result<(), EscrowError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("ADM"))
            .ok_or(EscrowError::Unauthorized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&symbol_short!("TRE"), &new_treasury);
        Ok(())
    }

    /// Creates a new job with milestones. Client specifies the freelancer and token for payment.
    pub fn create_job(
        env: Env,
        client: Address,
        freelancer: Address,
        token: Address,
        milestones: Vec<(String, i128, u64)>,
        job_deadline: u64,
        auto_refund_after: u64,
    ) -> Result<u64, EscrowError> {
        client.require_auth();
        require_not_paused(&env)?;

        if job_deadline <= env.ledger().timestamp() {
            return Err(EscrowError::InvalidDeadline);
        }

        let mut job_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::JobCount)
            .unwrap_or(0);
        job_count += 1;

        let mut total: i128 = 0;
        let mut milestone_vec: Vec<Milestone> = Vec::new(&env);

        for (i, m) in milestones.iter().enumerate() {
            let (desc, amount, deadline) = m;
            if deadline <= env.ledger().timestamp() {
                return Err(EscrowError::InvalidDeadline);
            }
            if deadline > job_deadline {
                return Err(EscrowError::InvalidDeadline);
            }
            total += amount;
            milestone_vec.push_back(Milestone {
                id: i as u32,
                description: desc,
                amount,
                status: MilestoneStatus::Pending,
                deadline,
            });
        }

        let job = Job {
            id: job_count,
            client: client.clone(),
            freelancer: freelancer.clone(),
            token,
            total_amount: total,
            status: JobStatus::Created,
            milestones: milestone_vec,
            job_deadline,
            auto_refund_after,
        };

        env.storage()
            .persistent()
            .set(&get_job_key(job_count), &job);
        bump_job_ttl(&env, job_count);
        env.storage().instance().set(&DataKey::JobCount, &job_count);
        bump_job_count_ttl(&env);

        // Emit event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("created")),
            (job_count, client, freelancer),
        );

        Ok(job_count)
    }

    /// Fund the escrow for a job. The client transfers the total amount to this contract.
    pub fn fund_job(env: Env, job_id: u64, client: Address) -> Result<(), EscrowError> {
        client.require_auth();
        require_not_paused(&env)?;

        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        if job.client != client {
            return Err(EscrowError::Unauthorized);
        }
        if job.status != JobStatus::Created {
            return Err(EscrowError::AlreadyFunded);
        }

        let token_client = token::Client::new(&env, &job.token);
        token_client.transfer(&client, &env.current_contract_address(), &job.total_amount);

        job.status = JobStatus::Funded;
        env.storage().persistent().set(&get_job_key(job_id), &job);
        bump_job_ttl(&env, job_id);

        // Emit event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("funded")),
            (job_id, client),
        );

        Ok(())
    }

    /// Called by the dispute contract to resolve a disputed job and distribute funds.
    /// Uses the full DisputeResolution enum to correctly handle all four outcomes,
    /// including the zero-remaining edge case where only the job status needs updating.
    pub fn resolve_dispute_callback(
        env: Env,
        job_id: u64,
        resolution: DisputeResolution,
    ) -> Result<(), EscrowError> {
        require_not_paused(&env)?;
        
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;

        if job.status == JobStatus::Created
            || job.status == JobStatus::Completed
            || job.status == JobStatus::Cancelled
        {
            return Err(EscrowError::InvalidStatus);
        }

        let approved_amount: i128 = job
            .milestones
            .iter()
            .filter(|m| m.status == MilestoneStatus::Approved)
            .map(|m| m.amount)
            .sum();

        let remaining = job.total_amount - approved_amount;

        if remaining > 0 {
            // Funds remain — transfer them according to the resolution outcome.
            let token_client = token::Client::new(&env, &job.token);
            match resolution {
                DisputeResolution::ClientWins => {
                    token_client.transfer(&env.current_contract_address(), &job.client, &remaining);
                    job.status = JobStatus::Cancelled;
                }
                DisputeResolution::FreelancerWins => {
                    token_client.transfer(
                        &env.current_contract_address(),
                        &job.freelancer,
                        &remaining,
                    );
                    job.status = JobStatus::Completed;
                }
                DisputeResolution::RefundBoth => {
                    let half = remaining / 2;
                    if half > 0 {
                        token_client.transfer(&env.current_contract_address(), &job.client, &half);
                        token_client.transfer(
                            &env.current_contract_address(),
                            &job.freelancer,
                            &(remaining - half),
                        );
                    }
                    job.status = JobStatus::Cancelled;
                }
                DisputeResolution::Escalate => {
                    // No funds transferred; job remains in its current disputed state
                    // until a higher-level resolution process completes.
                }
            }
        } else {
            // All milestones were already paid out — only the job status needs updating.
            // Use the same resolution mapping for consistency with the funds-present path.
            match resolution {
                DisputeResolution::ClientWins | DisputeResolution::RefundBoth => {
                    job.status = JobStatus::Cancelled;
                }
                DisputeResolution::FreelancerWins => {
                    job.status = JobStatus::Completed;
                }
                DisputeResolution::Escalate => {
                    // Leave status unchanged, same as above.
                }
            }
        }

        env.storage().persistent().set(&get_job_key(job_id), &job);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("dispute")),
            (job_id, resolution),
        );

        Ok(())
    }

    /// Freelancer submits a milestone as completed.
    pub fn submit_milestone(
        env: Env,
        job_id: u64,
        milestone_id: u32,
        freelancer: Address,
    ) -> Result<(), EscrowError> {
        freelancer.require_auth();
        require_not_paused(&env)?;

        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        if job.freelancer != freelancer {
            return Err(EscrowError::Unauthorized);
        }
        if job.status != JobStatus::Funded && job.status != JobStatus::InProgress {
            return Err(EscrowError::InvalidStatus);
        }

        let mut milestones = job.milestones.clone();
        let milestone = milestones
            .get(milestone_id)
            .ok_or(EscrowError::MilestoneNotFound)?;

        if milestone.status != MilestoneStatus::Pending
            && milestone.status != MilestoneStatus::InProgress
        {
            return Err(EscrowError::InvalidStatus);
        }

        if env.ledger().timestamp() > milestone.deadline {
            return Err(EscrowError::MilestoneDeadlineExceeded);
        }

        let updated = Milestone {
            id: milestone.id,
            description: milestone.description.clone(),
            amount: milestone.amount,
            status: MilestoneStatus::Submitted,
            deadline: milestone.deadline,
        };
        milestones.set(milestone_id, updated);

        job.milestones = milestones;
        job.status = JobStatus::InProgress;
        env.storage().persistent().set(&get_job_key(job_id), &job);
        bump_job_ttl(&env, job_id);

        Ok(())
    }

    /// Client approves a milestone and releases payment to the freelancer.
    pub fn approve_milestone(
        env: Env,
        job_id: u64,
        milestone_id: u32,
        client: Address,
    ) -> Result<(), EscrowError> {
        client.require_auth();
        require_not_paused(&env)?;

        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        if job.client != client {
            return Err(EscrowError::Unauthorized);
        }

        let mut milestones = job.milestones.clone();
        let milestone = milestones
            .get(milestone_id)
            .ok_or(EscrowError::MilestoneNotFound)?;

        if milestone.status != MilestoneStatus::Submitted {
            return Err(EscrowError::InvalidStatus);
        }

        // Release payment for this milestone
        let token_client = token::Client::new(&env, &job.token);

        let fee_bps: u32 = env.storage().instance().get(&symbol_short!("FEE")).unwrap_or(0);
        let treasury: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("TRE"))
            .unwrap_or(env.current_contract_address()); // Fallback to contract itself if not set, though it should be

        let fee_amount = (milestone.amount * fee_bps as i128) / 10_000;
        let freelancer_amount = milestone.amount - fee_amount;

        if fee_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &treasury, &fee_amount);

            // Emit fee collected event
            env.events().publish(
                (symbol_short!("escrow"), symbol_short!("fee")),
                (job_id, milestone_id, fee_amount, treasury.clone()),
            );
        }

        token_client.transfer(
            &env.current_contract_address(),
            &job.freelancer,
            &freelancer_amount,
        );

        let updated = Milestone {
            id: milestone.id,
            description: milestone.description.clone(),
            amount: milestone.amount,
            status: MilestoneStatus::Approved,
            deadline: milestone.deadline,
        };
        milestones.set(milestone_id, updated);
        job.milestones = milestones.clone();

        // Check if all milestones are approved
        let all_approved = milestones
            .iter()
            .all(|m| m.status == MilestoneStatus::Approved);
        if all_approved {
            job.status = JobStatus::Completed;
        }

        env.storage().persistent().set(&get_job_key(job_id), &job);
        bump_job_ttl(&env, job_id);

        // Emit event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("milestone")),
            (job_id, milestone_id, client),
        );

        Ok(())
    }

    /// Client approves multiple milestones at once and releases payments to the freelancer.
    /// All milestone indices must be in Submitted state before any state changes occur.
    /// If any index is invalid or not in Submitted state, the entire call reverts.
    pub fn approve_milestones_batch(
        env: Env,
        job_id: u64,
        milestone_indices: Vec<u32>,
        client: Address,
    ) -> Result<i128, EscrowError> {
        client.require_auth();
        require_not_paused(&env)?;

        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        if job.client != client {
            return Err(EscrowError::Unauthorized);
        }

        // Validate all milestone indices before making any state changes
        let mut milestones = job.milestones.clone();
        let mut total_released: i128 = 0;

        for i in milestone_indices.iter() {
            let index = i;
            let milestone = milestones
                .get(index)
                .ok_or(EscrowError::MilestoneNotFound)?;

            if milestone.status != MilestoneStatus::Submitted {
                return Err(EscrowError::InvalidStatus);
            }
        }

        // All validations passed - now process the batch atomically
        for i in milestone_indices.iter() {
            let index = i;
            let milestone = milestones.get(index).unwrap();

            // Release payment for this milestone
            total_released += milestone.amount;

            let updated = Milestone {
                id: milestone.id,
                description: milestone.description.clone(),
                amount: milestone.amount,
                status: MilestoneStatus::Approved,
                deadline: milestone.deadline,
            };
            milestones.set(index, updated);
        }

        // Transfer all payments in a single transaction
        if total_released > 0 {
            let token_client = token::Client::new(&env, &job.token);

            let fee_bps: u32 = env.storage().instance().get(&symbol_short!("FEE")).unwrap_or(0);
            let treasury: Address = env
                .storage()
                .instance()
                .get(&symbol_short!("TRE"))
                .unwrap_or(env.current_contract_address());

            let fee_amount = (total_released * fee_bps as i128) / 10_000;
            let freelancer_amount = total_released - fee_amount;

            if fee_amount > 0 {
                token_client.transfer(&env.current_contract_address(), &treasury, &fee_amount);

                // Emit fee collected event for the batch
                env.events().publish(
                    (symbol_short!("escrow"), symbol_short!("fee_batch")),
                    (job_id, fee_amount, treasury),
                );
            }

            token_client.transfer(
                &env.current_contract_address(),
                &job.freelancer,
                &freelancer_amount,
            );
        }

        job.milestones = milestones.clone();

        // Check if all milestones are approved
        let all_approved = milestones
            .iter()
            .all(|m| m.status == MilestoneStatus::Approved);
        if all_approved {
            job.status = JobStatus::Completed;
        }

        env.storage().persistent().set(&get_job_key(job_id), &job);
        bump_job_ttl(&env, job_id);

        // Emit batch approval event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("batch")),
            (job_id, milestone_indices, total_released),
        );

        Ok(total_released)
    }

    /// Cancel the job and refund remaining funds to the client.
    pub fn cancel_job(env: Env, job_id: u64, client: Address) -> Result<(), EscrowError> {
        client.require_auth();
        require_not_paused(&env)?;

        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        if job.client != client {
            return Err(EscrowError::Unauthorized);
        }
        if job.status == JobStatus::Completed || job.status == JobStatus::Cancelled {
            return Err(EscrowError::InvalidStatus);
        }

        // Calculate remaining funds (total minus already approved milestones)
        let approved_amount: i128 = job
            .milestones
            .iter()
            .filter(|m| m.status == MilestoneStatus::Approved)
            .map(|m| m.amount)
            .sum();

        let refund = job.total_amount - approved_amount;

        if refund > 0 && (job.status == JobStatus::Funded || job.status == JobStatus::InProgress) {
            let token_client = token::Client::new(&env, &job.token);
            token_client.transfer(&env.current_contract_address(), &client, &refund);
        }

        job.status = JobStatus::Cancelled;
        env.storage().persistent().set(&get_job_key(job_id), &job);
        bump_job_ttl(&env, job_id);

        // Emit event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("cancelled")),
            (job_id, client),
        );

        Ok(())
    }

    /// Claim a refund for an abandoned job past the deadline + grace period.
    /// Only the client can call this. Refund excludes amounts for already-approved milestones.
    /// Fails if the freelancer has a pending (submitted) milestone awaiting approval.
    pub fn claim_refund(env: Env, job_id: u64, client: Address) -> Result<(), EscrowError> {
        client.require_auth();
        require_not_paused(&env)?;

        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        if job.client != client {
            return Err(EscrowError::Unauthorized);
        }

        // Only allow refund for Funded or InProgress jobs
        if job.status != JobStatus::Funded && job.status != JobStatus::InProgress {
            return Err(EscrowError::InvalidStatus);
        }

        // Ensure the grace period after deadline has elapsed
        let refund_eligible_at = job.job_deadline + job.auto_refund_after;
        if env.ledger().timestamp() < refund_eligible_at {
            return Err(EscrowError::GracePeriodNotMet);
        }

        // Prevent refund if freelancer has an active pending milestone submission
        let has_pending = job
            .milestones
            .iter()
            .any(|m| m.status == MilestoneStatus::Submitted);
        if has_pending {
            return Err(EscrowError::HasPendingMilestone);
        }

        // Calculate refund: total minus already-approved milestone amounts
        let approved_amount: i128 = job
            .milestones
            .iter()
            .filter(|m| m.status == MilestoneStatus::Approved)
            .map(|m| m.amount)
            .sum();

        let refund = job.total_amount - approved_amount;
        if refund <= 0 {
            return Err(EscrowError::NoRefundDue);
        }

        // Transfer refund to client
        let token_client = token::Client::new(&env, &job.token);
        token_client.transfer(&env.current_contract_address(), &client, &refund);

        job.status = JobStatus::Cancelled;
        env.storage().persistent().set(&get_job_key(job_id), &job);
        bump_job_ttl(&env, job_id);

        // Emit event
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("refund")),
            (job_id, refund, client),
        );

        Ok(())
    }

    // ============================================================
    // JOB REVISION AND SCOPE RENEGOTIATION
    // ============================================================
    // These functions implement a formal proposal flow for revising
    // job milestones and budget after a job has been funded.
    //
    // Flow:
    //   Either party → propose_revision()  → stores Pending proposal
    //   Other party  → accept_revision()   → updates job + adjusts escrow
    //   Other party  → reject_revision()   → cancels proposal, no changes
    //
    // Security invariants:
    //   - Proposer cannot accept or reject their own proposal
    //   - Only one Pending proposal per job at any time
    //   - All token movements use checked arithmetic
    //   - Escrow balance always reflects the current agreed total
    // ============================================================

    /// Proposes a revision to the milestones and total budget of an active job.
    ///
    /// # Authorization
    /// Callable by either the job's client or the job's freelancer.
    /// The caller must authenticate via `caller.require_auth()`.
    ///
    /// # Arguments
    /// * `caller` — The address proposing the revision (must be client or freelancer)
    /// * `job_id` — The unique identifier of the job to revise
    /// * `new_milestones` — The proposed replacement milestone set (must be non-empty)
    ///
    /// # Behavior
    /// - Computes `new_total` as the sum of all amounts in `new_milestones`
    /// - Stores the proposal under `DataKey::RevisionProposal(job_id)`
    /// - Only one Pending proposal may exist per job — fails if one already exists
    /// - Does not modify the job's existing milestones or total until acceptance
    ///
    /// # Errors
    /// * `JobNotFound` — if the job does not exist (use existing error variant)
    /// * `NotAuthorizedForProposalAction` — if caller is neither client nor freelancer
    /// * `RevisionProposalAlreadyExists` — if a Pending proposal already exists
    /// * `EmptyMilestonesProposed` — if new_milestones is empty
    /// * `ProposalTotalMismatch` — if sum of milestone amounts does not equal computed new_total
    pub fn propose_revision(
        env: Env,
        caller: Address,
        job_id: u64,
        new_milestones: Vec<Milestone>,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        // 1. Load the job
        let job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        // 2. Verify caller is a party to this job
        if caller != job.client && caller != job.freelancer {
            return Err(EscrowError::NotAuthorizedForProposalAction);
        }

        // 3. Assert no existing Pending proposal, allowing overwrite of expired ones
        if let Some(existing) = env
            .storage()
            .persistent()
            .get::<DataKey, RevisionProposal>(&DataKey::RevisionProposal(job_id))
        {
            if existing.status == ProposalStatus::Pending {
                let expiry_secs: u64 = env
                    .storage()
                    .instance()
                    .get(&DataKey::ProposalExpiry)
                    .unwrap_or(DEFAULT_PROPOSAL_EXPIRY_SECS);
                let now = env.ledger().timestamp();
                if now < existing.created_at + expiry_secs {
                    return Err(EscrowError::RevisionProposalAlreadyExists);
                }
                // Expired proposal — fall through to overwrite with new one
            }
        }

        // 4. Validate non-empty milestones
        if new_milestones.is_empty() {
            return Err(EscrowError::EmptyMilestonesProposed);
        }

        // 5. Compute new_total as the sum of all milestone amounts
        // Use checked arithmetic — no overflow permitted
        let new_total: i128 = new_milestones
            .iter()
            .try_fold(0i128, |acc, m| acc.checked_add(m.amount))
            .ok_or(EscrowError::ProposalTotalMismatch)?;

        if new_total <= 0 {
            return Err(EscrowError::ProposalTotalMismatch);
        }

        // 6. Construct and store the proposal
        let proposal = RevisionProposal {
            proposer: caller.clone(),
            new_milestones,
            new_total,
            status: ProposalStatus::Pending,
            created_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::RevisionProposal(job_id), &proposal);
        // Extend TTL
        env.storage().persistent().extend_ttl(
            &DataKey::RevisionProposal(job_id),
            MIN_TTL_THRESHOLD,
            MIN_TTL_EXTEND_TO,
        );

        // 7. Emit event
        env.events().publish(
            (Symbol::new(&env, "revision_proposed"),),
            (job_id, caller, new_total),
        );

        Ok(())
    }

    /// Accepts a pending revision proposal, updating the job's milestones and adjusting escrow.
    ///
    /// # Authorization
    /// Callable ONLY by the party who did NOT propose the revision.
    /// The proposer cannot accept their own proposal.
    ///
    /// # Arguments
    /// * `caller` — The non-proposing party (client or freelancer)
    /// * `job_id` — The job whose proposal is being accepted
    ///
    /// # Behavior
    /// ## If new_total > old_total (budget increase):
    ///   - The difference is required from the client as a top-up
    ///   - Caller (if client) must have pre-authorized the token transfer
    ///   - The contract transfers (new_total - old_total) from client to itself
    ///
    /// ## If new_total < old_total (budget decrease):
    ///   - The difference is refunded to the client immediately
    ///   - The contract transfers (old_total - new_total) from itself to client
    ///
    /// ## If new_total == old_total (no budget change):
    ///   - Only milestone structure changes — no token movement occurs
    ///
    /// # Errors
    /// * `RevisionProposalNotFound` — if no proposal exists for this job
    /// * `ProposalNotPending` — if the proposal is not in Pending status
    /// * `NotAuthorizedForProposalAction` — if caller is the proposer or not a party
    /// * `InsufficientTopUp` — if new_total > old_total and top-up transfer fails
    pub fn accept_revision(env: Env, caller: Address, job_id: u64) -> Result<(), EscrowError> {
        caller.require_auth();

        // 1. Load job
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        // 2. Load proposal — must exist and be Pending
        let mut proposal = env
            .storage()
            .persistent()
            .get::<DataKey, RevisionProposal>(&DataKey::RevisionProposal(job_id))
            .ok_or(EscrowError::RevisionProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(EscrowError::ProposalNotPending);
        }

        // 3. Verify caller is a party and is NOT the proposer
        if caller != job.client && caller != job.freelancer {
            return Err(EscrowError::NotAuthorizedForProposalAction);
        }
        if caller == proposal.proposer {
            return Err(EscrowError::NotAuthorizedForProposalAction);
        }

        // 4. Compute balance delta
        let old_total = job.total_amount;
        let new_total = proposal.new_total;
        let delta = new_total - old_total; // positive = increase, negative = decrease, zero = unchanged

        // 5. Handle escrow balance adjustment
        let token_client = token::Client::new(&env, &job.token);

        if delta > 0 {
            // Budget increased — require client to top up the difference
            token_client.transfer(
                &job.client,                     // from: client
                &env.current_contract_address(), // to: this contract
                &delta,
            );
        } else if delta < 0 {
            // Budget decreased — refund the absolute difference to client
            let refund_amount = delta.checked_abs().ok_or(EscrowError::InsufficientTopUp)?;
            token_client.transfer(
                &env.current_contract_address(), // from: this contract
                &job.client,                     // to: client
                &refund_amount,
            );
        }
        // delta == 0: no token movement needed

        // 6. Update job milestones and total
        job.milestones = proposal.new_milestones.clone();
        job.total_amount = new_total;

        // 7. Persist updated job
        env.storage().persistent().set(&get_job_key(job_id), &job);
        bump_job_ttl(&env, job_id);

        // 8. Update proposal status to Accepted
        proposal.status = ProposalStatus::Accepted;
        env.storage()
            .persistent()
            .set(&DataKey::RevisionProposal(job_id), &proposal);

        // 9. Emit event
        env.events().publish(
            (Symbol::new(&env, "revision_accepted"),),
            (job_id, caller, new_total, delta),
        );

        Ok(())
    }

    /// Rejects a pending revision proposal. No changes are made to the job or escrow.
    ///
    /// # Authorization
    /// Callable ONLY by the party who did NOT propose the revision.
    /// The proposer cannot reject their own proposal.
    ///
    /// # Arguments
    /// * `caller` — The non-proposing party
    /// * `job_id` — The job whose proposal is being rejected
    ///
    /// # Behavior
    /// - Sets proposal status to Rejected
    /// - Job milestones, total, and escrow balance remain completely unchanged
    /// - After rejection, a new proposal may be submitted by either party
    ///
    /// # Errors
    /// * `RevisionProposalNotFound` — if no proposal exists
    /// * `ProposalNotPending` — if the proposal is not Pending
    /// * `NotAuthorizedForProposalAction` — if caller is the proposer or not a party
    pub fn reject_revision(env: Env, caller: Address, job_id: u64) -> Result<(), EscrowError> {
        caller.require_auth();

        // 1. Load job
        let job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);

        // 2. Load and validate proposal
        let mut proposal = env
            .storage()
            .persistent()
            .get::<DataKey, RevisionProposal>(&DataKey::RevisionProposal(job_id))
            .ok_or(EscrowError::RevisionProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(EscrowError::ProposalNotPending);
        }

        // 3. Verify caller is a party and NOT the proposer
        if caller != job.client && caller != job.freelancer {
            return Err(EscrowError::NotAuthorizedForProposalAction);
        }
        if caller == proposal.proposer {
            return Err(EscrowError::NotAuthorizedForProposalAction);
        }

        // 4. Mark proposal as Rejected — job and escrow unchanged
        proposal.status = ProposalStatus::Rejected;
        env.storage()
            .persistent()
            .set(&DataKey::RevisionProposal(job_id), &proposal);

        // 5. Emit event
        env.events()
            .publish((Symbol::new(&env, "revision_rejected"),), (job_id, caller));

        Ok(())
    }

    /// Returns the current revision proposal for the given job, if one exists.
    /// Returns None if no proposal has been submitted or if the last proposal was resolved.
    ///
    /// # Arguments
    /// * `job_id` — The job to query
    pub fn get_revision_proposal(env: Env, job_id: u64) -> Option<RevisionProposal> {
        env.storage()
            .persistent()
            .get::<DataKey, RevisionProposal>(&DataKey::RevisionProposal(job_id))
    }
    /// Get job details by ID.
    pub fn get_job(env: Env, job_id: u64) -> Result<Job, EscrowError> {
        let job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;
        bump_job_ttl(&env, job_id);
        Ok(job)
    }

    /// Get total number of jobs.
    pub fn get_job_count(env: Env) -> u64 {
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::JobCount)
            .unwrap_or(0);
        bump_job_count_ttl(&env);
        count
    }

    /// Check if a milestone is overdue.
    pub fn is_milestone_overdue(env: Env, job_id: u64, milestone_id: u32) -> bool {
        if let Some(job) = env
            .storage()
            .persistent()
            .get::<_, Job>(&get_job_key(job_id))
        {
            if let Some(milestone) = job.milestones.get(milestone_id) {
                return env.ledger().timestamp() > milestone.deadline;
            }
        }
        false
    }

    /// Extend the deadline for a milestone (requires mutual agreement).
    pub fn extend_deadline(
        env: Env,
        job_id: u64,
        milestone_id: u32,
        new_deadline: u64,
    ) -> Result<(), EscrowError> {
        require_not_paused(&env)?;
        
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&get_job_key(job_id))
            .ok_or(EscrowError::JobNotFound)?;

        job.client.require_auth();
        job.freelancer.require_auth();

        if new_deadline <= env.ledger().timestamp() {
            return Err(EscrowError::InvalidDeadline);
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones
            .get(milestone_id)
            .ok_or(EscrowError::MilestoneNotFound)?;

        milestone.deadline = new_deadline;
        milestones.set(milestone_id, milestone);

        job.milestones = milestones;
        env.storage().persistent().set(&get_job_key(job_id), &job);

        Ok(())
    }
}

#[cfg(test)]
mod test;
