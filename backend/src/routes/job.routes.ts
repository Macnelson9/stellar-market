import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import {
  createJobSchema,
  updateJobSchema,
  getJobsQuerySchema,
  getJobByIdParamSchema,
  updateJobStatusSchema
} from "../schemas";
import { cache, invalidateCache, invalidateCacheKey, generateJobsCacheKey, generateJobCacheKey, generateJobOnChainStatusCacheKey } from "../lib/cache";
import { ContractService } from "../services/contract.service";

const router = Router();
/**
 * @swagger
 * tags:
 *   name: Jobs
 *   description: Job management endpoints
 */
const prisma = new PrismaClient();

// Get all jobs with optional filters and pagination
router.get("/",
  /**
   * @swagger
   * /jobs:
   *   get:
   *     summary: Get all jobs
   *     tags: [Jobs]
   *     parameters:
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *         description: Page number
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *         description: Items per page
   *     responses:
   *       200:
   *         description: List of jobs
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/JobsResponse'
   */
  /**
   * @swagger
   * /jobs/{id}:
   *   get:
   *     summary: Get job by ID
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Job ID
   *     responses:
   *       200:
   *         description: Job details
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/JobResponse'
   *       404:
   *         description: Job not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  validate({ query: getJobsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page, limit, search, skill, skills, status, minBudget, maxBudget, clientId, sort, postedAfter } = req.query as any;
    
    // Generate cache key based on query parameters
    const cacheKey = generateJobsCacheKey({
      page,
      limit,
      search,
      skill,
      skills,
      status,
      minBudget,
      maxBudget,
      clientId,
      sort,
      postedAfter
    });

    // Cache for 60 seconds
    const { data, hit } = await cache(cacheKey, 60, async () => {
      const skip = (page - 1) * limit;

      const where: any = {};

      if (search) {
        where.OR = [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ];
      }

      if (skills) {
        const skillList = (skills as string).split(",").map((s: string) => s.trim());
        where.skills = { hasSome: skillList };
      } else if (skill) {
        where.skills = { has: skill };
      }

      if (status) {
        const statusList = (status as string).split(",").map((s: string) => s.trim());
        if (statusList.length === 1) {
          where.status = statusList[0];
        } else {
          where.status = { in: statusList };
        }
      }

      if (minBudget || maxBudget) {
        where.budget = {};
        if (minBudget) where.budget.gte = minBudget;
        if (maxBudget) where.budget.lte = maxBudget;
      }

      if (clientId) {
        where.clientId = clientId;
      }

      if (postedAfter) {
        where.createdAt = { gte: new Date(postedAfter) };
      }

      let orderBy: any = { createdAt: "desc" };
      if (sort === "oldest") orderBy = { createdAt: "asc" };
      else if (sort === "budget_high") orderBy = { budget: "desc" };
      else if (sort === "budget_low") orderBy = { budget: "asc" };

      const [jobs, total] = await Promise.all([
        prisma.job.findMany({
          where,
          include: {
            client: { select: { id: true, username: true, avatarUrl: true } },
            freelancer: { select: { id: true, username: true, avatarUrl: true } },
            milestones: true,
            _count: { select: { applications: true } },
          },
          orderBy,
          skip,
          take: limit,
        }),
        prisma.job.count({ where }),
      ]);

      return {
        data: jobs,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      };
    });

    // Add cache hit status to response headers for debugging
    res.set('X-Cache-Hit', hit.toString());
    res.json(data);
  })
);

// Get jobs for the authenticated user (client or freelancer)
router.get("/mine",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page = 1, limit = 10, status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {
      OR: [
        { clientId: req.userId },
        { freelancerId: req.userId },
      ],
    };
    if (status) where.status = status;

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: "desc" },
        include: {
          client: { select: { id: true, username: true, avatarUrl: true } },
          freelancer: { select: { id: true, username: true, avatarUrl: true } },
          milestones: true,
          _count: { select: { applications: true } },
        },
      }),
      prisma.job.count({ where }),
    ]);

    res.json({
      data: jobs,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit))
    });
  })
);

// Get a single job by ID
router.get("/:id",
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, username: true, avatarUrl: true, bio: true } },
        freelancer: { select: { id: true, username: true, avatarUrl: true, bio: true } },
        milestones: { orderBy: { order: "asc" } },
        applications: {
          include: {
            freelancer: { select: { id: true, username: true, avatarUrl: true } },
          },
        },
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // Fetch on-chain escrow status if contractJobId is present
    let escrowStatus = job.escrowStatus as string;
    
    if (job.contractJobId) {
      try {
        const cacheKey = generateJobOnChainStatusCacheKey(id);
        const { data: onChainStatus } = await cache(cacheKey, 30, async () => {
          return await ContractService.getOnChainJobStatus(job.contractJobId!);
        });
        escrowStatus = onChainStatus;
      } catch (error) {
        console.warn(`Could not fetch on-chain status for job ${id}, falling back to DB:`, error);
      }
    }

    res.json({
      ...job,
      escrow_status: escrowStatus, // Alias for frontend compatibility
      escrowStatus: escrowStatus,    // Keep original for consistency
    });
  })
);

// Create a new job
router.post("/",
  /**
   * @swagger
   * /jobs:
   *   post:
   *     summary: Create a new job
   *     tags: [Jobs]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateJobRequest'
   *           examples:
   *             example:
   *               value:
   *                 title: Sample Job
   *                 description: Job description...
   *                 budget: 1000
   *                 skills: ["React", "Node.js"]
   *                 deadline: "2026-03-01T00:00:00Z"
   *                 category: Development
   *     responses:
   *       201:
   *         description: Job created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/JobResponse'
   *       400:
   *         description: Invalid input
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  /**
   * @swagger
   * /jobs/{id}:
   *   put:
   *     summary: Update a job
   *     tags: [Jobs]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Job ID
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/UpdateJobRequest'
   *     responses:
   *       200:
   *         description: Job updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/JobResponse'
   *       403:
   *         description: Not authorized
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Job not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  /**
   * @swagger
   * /jobs/{id}:
   *   delete:
   *     summary: Delete a job
   *     tags: [Jobs]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Job ID
   *     responses:
   *       200:
   *         description: Job deleted
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SuccessResponse'
   *       403:
   *         description: Not authorized
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Job not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponsenponse'
   */
  authenticate,
  validate({ body: createJobSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || user.role !== "CLIENT") {
      return res.status(403).json({ error: "Only clients can post jobs." });
    }

    const { title, description, budget, skills, deadline } = req.body;

    const job = await prisma.job.create({
      data: {
        title,
        description,
        budget,
        category: req.body.category || "General",
        skills,
        deadline: new Date(deadline),
        clientId: req.userId!,
      },
      include: { milestones: true },
    });

    // Invalidate job listings cache when a new job is created
    await invalidateCache("jobs:list:*");
    
    res.status(201).json(job);
  })
);

// Update a job
router.put("/:id",
  authenticate,
  validate({
    params: getJobByIdParamSchema,
    body: updateJobSchema
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const job = await prisma.job.findUnique({ where: { id } });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    if (job.clientId !== req.userId) {
      return res.status(403).json({ error: "Not authorized to update this job." });
    }

    const updateData = req.body;
    if (updateData.deadline) {
      updateData.deadline = new Date(updateData.deadline);
    }

    const updated = await prisma.job.update({
      where: { id },
      data: updateData,
      include: { milestones: true },
    });

    // Invalidate job listings cache and single job cache
    await invalidateCache("jobs:list:*");
    await invalidateCacheKey(generateJobCacheKey(id));

    res.json(updated);
  })
);

// Delete a job
router.delete("/:id",
  authenticate,
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const job = await prisma.job.findUnique({ where: { id } });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    if (job.clientId !== req.userId) {
      return res.status(403).json({ error: "Not authorized to delete this job." });
    }

    await prisma.job.delete({ where: { id } });
    
    // Invalidate job listings cache and single job cache
    await invalidateCache("jobs:list:*");
    await invalidateCacheKey(generateJobCacheKey(id));
    
    res.json({ message: "Job deleted successfully." });
  })
);

// Update job status
router.patch("/:id/status",
  authenticate,
  validate({
    params: getJobByIdParamSchema,
    body: updateJobStatusSchema
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const { status } = req.body;
    
    const job = await prisma.job.findUnique({ where: { id } });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    if (job.clientId !== req.userId) {
      return res.status(403).json({ error: "Not authorized to update this job." });
    }

    const updated = await prisma.job.update({
      where: { id },
      data: { status },
      include: { milestones: true },
    });

    // Invalidate job listings cache and single job cache
    await invalidateCache("jobs:list:*");
    await invalidateCacheKey(generateJobCacheKey(id));

    res.json(updated);
  })
);

export default router;
