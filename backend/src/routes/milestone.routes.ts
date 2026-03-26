import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import { NotificationService } from "../services/notification.service";
import { NotificationType } from "@prisma/client";
import {
  createMilestoneSchema,
  updateMilestoneSchema,
  updateMilestoneStatusSchema,
  getMilestonesQuerySchema,
  getMilestoneByIdParamSchema,
  getJobByIdParamSchema,
} from "../schemas";

const router = Router();
const prisma = new PrismaClient();

// Valid status transitions per role
const freelancerTransitions: Record<string, string[]> = {
  PENDING: ["IN_PROGRESS", "COMPLETED"],
  IN_PROGRESS: ["COMPLETED"],
};

const clientTransitions: Record<string, string[]> = {
  COMPLETED: ["CANCELLED"],
};

// List milestones for a job
router.get(
  "/jobs/:jobId/milestones",
  authenticate,
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const jobId = req.params.jobId as string;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const milestones = await prisma.milestone.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" },
    });

    res.json(milestones);
  }),
);

// Get all milestones with filtering
router.get(
  "/",
  authenticate,
  validate({ query: getMilestonesQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page, limit, jobId, status } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (jobId) where.jobId = jobId;
    if (status) where.status = status;

    const [milestones, total] = await Promise.all([
      prisma.milestone.findMany({
        where,
        include: {
          job: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.milestone.count({ where }),
    ]);

    res.json({
      data: milestones,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  }),
);

// Create a new milestone
router.post(
  "/",
  authenticate,
  validate({ body: createMilestoneSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { jobId, title, description, amount, dueDate } = req.body;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    if (job.clientId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to create milestones for this job." });
    }

    const milestonesCount = await prisma.milestone.count({ where: { jobId } });
    const milestone = await prisma.milestone.create({
      data: {
        jobId,
        title,
        description,
        amount,
        dueDate: new Date(dueDate),
        order: milestonesCount + 1,
      },
      include: {
        job: { select: { id: true, title: true } },
      },
    });

    res.status(201).json(milestone);
  }),
);

// Get a single milestone by ID
router.get(
  "/:id",
  authenticate,
  validate({ params: getMilestoneByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            clientId: true,
            freelancerId: true,
          },
        },
      },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }

    // Check if user is authorized to view this milestone
    const isClient = (milestone as any).job.clientId === req.userId;
    const isFreelancer = (milestone as any).job.freelancerId === req.userId;

    if (!isClient && !isFreelancer) {
      return res
        .status(403)
        .json({ error: "Not authorized to view this milestone." });
    }

    res.json(milestone);
  }),
);

// Update a milestone
router.put(
  "/:id",
  authenticate,
  validate({
    params: getMilestoneByIdParamSchema,
    body: updateMilestoneSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const updateData = req.body;

    if (updateData.dueDate) {
      updateData.dueDate = new Date(updateData.dueDate);
    }

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }
    if ((milestone as any).job.clientId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this milestone." });
    }

    const updated = await prisma.milestone.update({
      where: { id },
      data: updateData,
      include: {
        job: { select: { id: true, title: true } },
      },
    });

    res.json(updated);
  }),
);

// Delete a milestone
router.delete(
  "/:id",
  authenticate,
  validate({ params: getMilestoneByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }
    if ((milestone as any).job.clientId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this milestone." });
    }

    await prisma.milestone.delete({ where: { id } });
    res.json({ message: "Milestone deleted successfully." });
  }),
);

// Update milestone status
router.patch(
  "/:id/status",
  authenticate,
  validate({
    params: getMilestoneByIdParamSchema,
    body: updateMilestoneStatusSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const { status } = req.body;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }

    const job = (milestone as any).job;
    const isClient = job.clientId === req.userId;
    const isFreelancer = job.freelancerId === req.userId;

    if (!isClient && !isFreelancer) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this milestone." });
    }

    // Determine allowed transitions based on role
    const currentStatus = milestone.status;
    const allowedStatuses = isFreelancer
      ? (freelancerTransitions[currentStatus] || [])
      : (clientTransitions[currentStatus] || []);

    if (!allowedStatuses.includes(status)) {
      return res.status(403).json({
        error: `Invalid status transition from ${currentStatus} to ${status} for ${isFreelancer ? 'Freelancer' : 'Client'}.`
      });
    }

    const updated = await prisma.milestone.update({
      where: { id },
      data: { status },
    });

    // Notify the client when freelancer submits milestone
    if (isFreelancer && status === "COMPLETED") {
      await NotificationService.sendNotification({
        userId: job.clientId,
        type: NotificationType.MILESTONE_SUBMITTED,
        title: "Milestone Submitted",
        message: `Freelancer submitted milestone: ${milestone.title}`,
        metadata: { jobId: job.id, milestoneId: id },
      });
    }

    // Auto-complete job when all milestones are completed
    if (status === "COMPLETED") {
      const allMilestones = await prisma.milestone.findMany({
        where: { jobId: job.id },
      });

      const allCompleted = allMilestones.every(
        (m: any) => m.status === "COMPLETED",
      );
      if (allCompleted) {
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "COMPLETED" },
        });
      }
    }

    res.json(updated);
  }),
);

export default router;
