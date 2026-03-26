import { Router, Request, Response } from "express";
import { DisputeStatus, UserRole } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/error";
import { DisputeService } from "../services/dispute.service";
import {
  createDisputeSchema,
  castVoteSchema,
  queryDisputesSchema,
  resolveDisputeSchema,
  webhookPayloadSchema,
} from "../schemas/dispute";

const router = Router();

/**
 * GET /api/disputes
 * Get all disputes with optional filtering and pagination
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = queryDisputesSchema.parse(req.query);

    const result = await DisputeService.getDisputes(
      { status: DisputeStatus.OPEN },
      { page: query.page, limit: query.limit },
    );

    const disputes = (result.disputes as any[]).map((dispute: any) => {
      const { walletAddress: _clientWalletAddress, ...client } = dispute.client;
      const { walletAddress: _freelancerWalletAddress, ...freelancer } =
        dispute.freelancer;
      const { walletAddress: _initiatorWalletAddress, ...initiator } =
        dispute.initiator;

      return {
        ...dispute,
        client,
        freelancer,
        initiator,
      };
    });

    // Community listing returns array for frontend compatibility
    res.json(disputes);
  }),
);

/**
 * GET /api/disputes/:id
 * Get specific dispute details
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const dispute = (await DisputeService.getDisputeById(
      req.params.id as string,
    )) as any;

    const userId = req.userId!;
    const isParticipant =
      dispute.clientId === userId ||
      dispute.freelancerId === userId ||
      dispute.initiatorId === userId;

    const isRegisteredVoter = Array.isArray(dispute.votes)
      ? dispute.votes.some((vote: any) => vote.voterId === userId)
      : false;
    const isAdmin = req.userRole === UserRole.ADMIN;

    if (!isParticipant && !isRegisteredVoter && !isAdmin) {
      res.status(403).json({
        error:
          "Access denied. Only dispute participants or registered voters can view this dispute.",
      });
      return;
    }

    res.json(dispute);
  }),
);

/**
 * POST /api/disputes
 * Create a new dispute
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createDisputeSchema.parse(req.body);

    const dispute = await DisputeService.createDispute(
      data.jobId,
      req.userId!,
      data.reason,
    );

    res.status(201).json(dispute);
  }),
);

/**
 * POST /api/disputes/:id/votes
 * Cast a vote on a dispute
 */
router.post(
  "/:id/votes",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const dispute = await DisputeService.getDisputeById(req.params.id as string);
    if (!dispute) {
      return res.status(404).json({ error: "Dispute not found." });
    }

    // Conflict-of-interest check: Job participants cannot vote
    if (dispute.job.clientId === req.userId || dispute.job.freelancerId === req.userId) {
      return res.status(403).json({ 
        error: "Job participants (client or freelancer) cannot vote on their own dispute." 
      });
    }
    const data = castVoteSchema.parse(req.body);

    const vote = await DisputeService.castVote(
      req.params.id as string,
      req.userId!,
      data.choice,
      data.reason,
    );

    res.status(201).json(vote);
  }),
);

/**
 * PUT /api/disputes/:id/resolve
 * Resolve a dispute (admin only or automated)
 */
router.put(
  "/:id/resolve",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = resolveDisputeSchema.parse(req.body);

    const dispute = await DisputeService.resolveDispute(
      req.params.id as string,
      data.outcome,
    );

    res.json(dispute);
  }),
);

/**
 * GET /api/disputes/:id/stats
 * Get vote statistics for a dispute
 */
router.get(
  "/:id/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const stats = await DisputeService.getVoteStats(req.params.id as string);
    res.json(stats);
  }),
);

/**
 * POST /api/disputes/webhook
 * Process blockchain webhook events
 */
router.post(
  "/webhook",
  asyncHandler(async (req: Request, res: Response) => {
    const payload = webhookPayloadSchema.parse(req.body);

    const result = await DisputeService.processWebhook(payload);

    res.json(result);
  }),
);

export default router;
