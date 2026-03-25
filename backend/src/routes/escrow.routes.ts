import { Router, Response } from "express";
import { PrismaClient, EscrowStatus, NotificationType } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/error";
import { ContractService } from "../services/contract.service";
import { NotificationService } from "../services/notification.service";
import { config } from "../config";

const router = Router();
const prisma = new PrismaClient();

/**
 * Request XDR to create a job on-chain.
 */
router.post("/init-create", authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { jobId } = req.body;
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { client: true, freelancer: true, milestones: { orderBy: { order: "asc" } } }
  });

  if (!job || !job.freelancer) {
    return res.status(404).json({ error: "Job with assigned freelancer not found." });
  }

  if (job.clientId !== req.userId) {
    return res.status(403).json({ error: "Only the client can initialize the escrow." });
  }

  const xdr = await ContractService.buildCreateJobTx(
    job.client.walletAddress,
    job.freelancer.walletAddress,
    config.stellar.nativeTokenId,
    job.milestones.map(m => ({
      description: m.title,
      amount: m.amount,
      deadline: Math.floor((m.contractDeadline?.getTime() || (Date.now() + 86400000 * 7)) / 1000)
    })),
    Math.floor((job as any).deadline.getTime() / 1000)
  );

  res.json({ xdr });
}));

/**
 * Request XDR to fund a job on-chain.
 */
router.post("/init-fund", authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { jobId } = req.body;
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { client: true }
  });

  if (!job || !job.contractJobId) {
    return res.status(404).json({ error: "On-chain job not found. Create it first." });
  }

  const xdr = await ContractService.buildFundJobTx(job.client.walletAddress, job.contractJobId);
  res.json({ xdr });
}));

/**
 * Request XDR to approve a milestone on-chain.
 */
router.post("/init-approve", authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { milestoneId } = req.body;
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    include: { job: { include: { client: true } } }
  });

  if (!milestone || !milestone.job.contractJobId || milestone.onChainIndex === null) {
    return res.status(404).json({ error: "On-chain milestone not found." });
  }

  const xdr = await ContractService.buildApproveMilestoneTx(
    milestone.job.client.walletAddress,
    milestone.job.contractJobId,
    milestone.onChainIndex
  );

  res.json({ xdr });
}));

/**
 * Request XDR to extend a milestone deadline on-chain.
 */
router.post("/init-extend-deadline", authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { milestoneId, newDeadline } = req.body;

  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    include: { job: { include: { client: true } } },
  });

  if (!milestone || !milestone.job.contractJobId || milestone.onChainIndex === null) {
    return res.status(404).json({ error: "On-chain milestone not found." });
  }

  if (milestone.job.clientId !== req.userId) {
    return res.status(403).json({ error: "Only the client can extend deadlines." });
  }

  const newDeadlineUnix = Math.floor(new Date(newDeadline).getTime() / 1000);

  const xdr = await ContractService.buildExtendDeadlineTx(
    milestone.job.client.walletAddress,
    milestone.job.contractJobId,
    milestone.onChainIndex,
    newDeadlineUnix,
  );

  res.json({ xdr });
}));

/**
 * Confirm transaction and update local database.
 * In a real app, this should ideally be handled by an event listener/indexer,
 * but for this integration task, we verify the hash provided by the frontend.
 */
router.post("/confirm-tx", authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { hash, type, jobId, milestoneId, onChainJobId } = req.body;

  const verification = await ContractService.verifyTransaction(hash);
  if (!verification.success) {
    return res.status(400).json({ error: `Transaction failed or not found: ${verification.error}` });
  }

  // Update DB based on transaction type
  if (type === "CREATE_JOB" && jobId && onChainJobId) {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        contractJobId: onChainJobId.toString(),
        escrowStatus: EscrowStatus.UNFUNDED
      }
    });

    // Update milestones with their on-chain indices (0, 1, 2...)
    const milestones = await prisma.milestone.findMany({
      where: { jobId },
      orderBy: { order: "asc" }
    });
    for (let i = 0; i < milestones.length; i++) {
      await prisma.milestone.update({
        where: { id: milestones[i].id },
        data: { onChainIndex: i }
      });
    }
  } else if (type === "FUND_JOB" && jobId) {
    await prisma.job.update({
      where: { id: jobId },
      data: { escrowStatus: EscrowStatus.FUNDED }
    });
  } else if (type === "EXTEND_DEADLINE" && milestoneId) {
    const { newDeadline } = req.body;
    await prisma.milestone.update({
      where: { id: milestoneId },
      data: { contractDeadline: new Date(newDeadline) },
    });
  } else if (type === "APPROVE_MILESTONE" && milestoneId) {
    await prisma.milestone.update({
      where: { id: milestoneId },
      data: { status: "APPROVED" }
    });

    // Check if all milestones are approved to update job status
    const milestone = await prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: { job: true },
    });
    const allMilestones = await prisma.milestone.findMany({ where: { jobId: milestone?.jobId } });
    if (allMilestones.every(m => m.status === "APPROVED")) {
      await prisma.job.update({
        where: { id: milestone?.jobId },
        data: {
          status: "COMPLETED",
          escrowStatus: EscrowStatus.COMPLETED
        }
      });
    }

    // Notify the freelancer
    if (milestone && milestone.job.freelancerId) {
      await NotificationService.sendNotification({
        userId: milestone.job.freelancerId,
        type: NotificationType.MILESTONE_APPROVED,
        title: "Milestone Approved",
        message: `Your milestone "${milestone.title}" has been approved and funds released!`,
        metadata: { jobId: milestone.jobId, milestoneId: milestone.id },
      });
    }
  }

  res.json({ message: "Transaction confirmed and database updated." });
}));

export default router;
