/**
 * Dispute Management Service
 * Handles dispute creation, voting, resolution, and webhook processing
 */
import { PrismaClient, DisputeStatus, JobStatus, EscrowStatus } from "@prisma/client";
import { createError } from "../middleware/error";

const prisma = new PrismaClient();

export class DisputeService {
  /**
   * Create a new dispute for a job
   */
  static async createDispute(
    jobId: string,
    initiatorId: string,
    reason: string,
  ) {
    // Validate job exists and has both client and freelancer
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { client: true, freelancer: true },
    });

    if (!job) {
      throw createError("Job not found", 404);
    }

    if (!job.freelancer) {
      throw createError(
        "Job must have an assigned freelancer to raise a dispute",
        400,
      );
    }

    // Verify initiator is a participant
    if (job.clientId !== initiatorId && job.freelancerId !== initiatorId) {
      throw createError("Not a participant of this job", 403);
    }

    // Verify the job is in a disputable state (ACTIVE/IN_PROGRESS or FUNDED)
    const isDisputableStatus = job.status === JobStatus.IN_PROGRESS;
    const isDisputableEscrow = job.escrowStatus === EscrowStatus.FUNDED;

    if (!isDisputableStatus && !isDisputableEscrow) {
      throw createError("Job is not in a disputable state", 400);
    }

    // Check for existing dispute
    const existingDispute = await prisma.dispute.findUnique({
      where: { jobId },
    });

    if (existingDispute) {
      throw createError("A dispute already exists for this job", 400);
    }

    // Create dispute
    const dispute = await prisma.dispute.create({
      data: {
        jobId,
        clientId: job.clientId,
        freelancerId: job.freelancerId!,
        initiatorId,
        reason,
        status: DisputeStatus.OPEN,
      },
      include: {
        job: { select: { title: true, budget: true } },
        client: {
          select: {
            id: true,
            username: true,
            walletAddress: true,
            avatarUrl: true,
          },
        },
        freelancer: {
          select: {
            id: true,
            username: true,
            walletAddress: true,
            avatarUrl: true,
          },
        },
        initiator: {
          select: {
            id: true,
            username: true,
            walletAddress: true,
            avatarUrl: true,
          },
        },
      },
    });

    // Update job status
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.DISPUTED,
        escrowStatus: "DISPUTED",
      },
    });

    return dispute;
  }

  /**
   * Get dispute by ID with full details
   */
  static async getDisputeById(id: string) {
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        job: {
          include: {
            client: {
              select: {
                id: true,
                username: true,
                walletAddress: true,
                avatarUrl: true,
              },
            },
            freelancer: {
              select: {
                id: true,
                username: true,
                walletAddress: true,
                avatarUrl: true,
              },
            },
          },
        },
        client: {
          select: {
            id: true,
            username: true,
            walletAddress: true,
            avatarUrl: true,
          },
        },
        freelancer: {
          select: {
            id: true,
            username: true,
            walletAddress: true,
            avatarUrl: true,
          },
        },
        initiator: {
          select: {
            id: true,
            username: true,
            walletAddress: true,
            avatarUrl: true,
          },
        },
        votes: {
          include: {
            voter: {
              select: {
                id: true,
                username: true,
                walletAddress: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        attachments: true,
      },
    });

    if (!dispute) {
      throw new Error("Dispute not found");
    }

    return dispute;
  }

  /**
   * Get disputes with filtering and pagination
   */
  static async getDisputes(
    filters: { status?: DisputeStatus },
    pagination: { page: number; limit: number },
  ) {
    const { status } = filters;
    const { page, limit } = pagination;
    const skip = (page - 1) * limit;

    const where = status ? { status } : {};

    const [disputes, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        include: {
          job: { select: { title: true, budget: true } },
          client: {
            select: {
              id: true,
              username: true,
              walletAddress: true,
              avatarUrl: true,
            },
          },
          freelancer: {
            select: {
              id: true,
              username: true,
              walletAddress: true,
              avatarUrl: true,
            },
          },
          initiator: {
            select: {
              id: true,
              username: true,
              walletAddress: true,
              avatarUrl: true,
            },
          },
          _count: { select: { votes: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.dispute.count({ where }),
    ]);

    return {
      disputes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Cast a vote on a dispute
   * Validates voter eligibility and prevents duplicate votes
   */
  static async castVote(
    disputeId: string,
    voterId: string,
    choice: "CLIENT" | "FREELANCER",
    reason: string,
  ) {
    // Verify dispute exists and is open for voting
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { job: true },
    });

    if (!dispute) {
      throw new Error("Dispute not found");
    }

    if (dispute.status === DisputeStatus.RESOLVED) {
      throw new Error("Cannot vote on a resolved dispute");
    }

    // Prevent participants from voting
    if (voterId === dispute.clientId || voterId === dispute.freelancerId) {
      throw new Error("Dispute participants cannot vote");
    }

    // Check for duplicate vote
    const existingVote = await prisma.disputeVote.findUnique({
      where: {
        disputeId_voterId: {
          disputeId,
          voterId,
        },
      },
    });

    if (existingVote) {
      throw new Error("You have already voted on this dispute");
    }

    // Create vote
    const vote = await prisma.disputeVote.create({
      data: {
        disputeId,
        voterId,
        choice,
        reason,
      },
      include: {
        voter: {
          select: {
            id: true,
            username: true,
            walletAddress: true,
            avatarUrl: true,
          },
        },
      },
    });

    // Update dispute status to IN_PROGRESS if it was OPEN
    if (dispute.status === DisputeStatus.OPEN) {
      await prisma.dispute.update({
        where: { id: disputeId },
        data: { status: DisputeStatus.IN_PROGRESS },
      });
    }

    return vote;
  }

  /**
   * Resolve a dispute (admin or automated process)
   */
  static async resolveDispute(disputeId: string, outcome: string) {
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { votes: true, job: true },
    });

    if (!dispute) {
      throw new Error("Dispute not found");
    }

    if (dispute.status === DisputeStatus.RESOLVED) {
      throw new Error("Dispute is already resolved");
    }

    // Update dispute
    const updatedDispute = await prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: DisputeStatus.RESOLVED,
        outcome,
        resolvedAt: new Date(),
      },
      include: {
        job: true,
        client: { select: { id: true, username: true, walletAddress: true } },
        freelancer: {
          select: { id: true, username: true, walletAddress: true },
        },
        votes: { include: { voter: { select: { username: true } } } },
      },
    });

    // Update job status
    await prisma.job.update({
      where: { id: dispute.jobId },
      data: {
        status: JobStatus.COMPLETED,
        escrowStatus: "COMPLETED",
      },
    });

    return updatedDispute;
  }

  /**
   * Process webhook from blockchain
   */
  static async processWebhook(payload: {
    type: string;
    disputeId: string;
    onChainDisputeId?: string;
    jobId?: string;
    voterId?: string;
    choice?: "CLIENT" | "FREELANCER";
    outcome?: string;
    metadata?: Record<string, any>;
  }) {
    const {
      type,
      disputeId,
      onChainDisputeId,
      jobId,
      voterId,
      choice,
      outcome,
    } = payload;

    switch (type) {
      case "DISPUTE_RAISED":
        if (!onChainDisputeId || !disputeId) {
          throw new Error("Missing required fields for DISPUTE_RAISED");
        }
        // Update dispute with on-chain ID
        await prisma.dispute.update({
          where: { id: disputeId },
          data: { onChainDisputeId },
        });
        break;

      case "VOTE_CAST":
        if (!disputeId || !voterId || !choice) {
          throw new Error("Missing required fields for VOTE_CAST");
        }
        // Vote should already be recorded via API, this is confirmation
        break;

      case "DISPUTE_RESOLVED":
        if (!disputeId || !outcome) {
          throw new Error("Missing required fields for DISPUTE_RESOLVED");
        }
        await this.resolveDispute(disputeId, outcome);
        break;

      default:
        throw new Error(`Unknown webhook type: ${type}`);
    }

    return { success: true, message: `Webhook ${type} processed successfully` };
  }

  /**
   * Get vote statistics for a dispute
   */
  static async getVoteStats(disputeId: string) {
    const votes = await prisma.disputeVote.findMany({
      where: { disputeId },
      select: { choice: true },
    });

    const votesForClient = votes.filter((v) => v.choice === "CLIENT").length;
    const votesForFreelancer = votes.filter(
      (v) => v.choice === "FREELANCER",
    ).length;

    return {
      total: votes.length,
      votesForClient,
      votesForFreelancer,
    };
  }
}
