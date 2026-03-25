import { AuthRequest, authenticate } from "../middleware/auth";
import { Prisma, PrismaClient } from "@prisma/client";
import { Response, Router } from "express";
import {
  createReviewSchema,
  getReviewByIdParamSchema,
  getReviewsByUserParamSchema,
  getReviewsQuerySchema,
  updateReviewSchema
} from "../schemas";
import { generateUserCacheKey, invalidateCacheKey } from "../lib/cache";

import { asyncHandler } from "../middleware/error";
import { validate } from "../middleware/validation";

const router = Router();
/**
 * @swagger
 * tags:
 *   name: Reviews
 *   description: Review endpoints
 */
const prisma = new PrismaClient();

async function syncUserReviewAggregate (
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const aggregate = await tx.review.aggregate({
    where: { revieweeId: userId },
    _avg: { rating: true },
    _count: { id: true },
  });

  const averageRating = aggregate._avg.rating ?? 0;
  const reviewCount = aggregate._count.id;

  await tx.user.update({
    where: { id: userId },
    data: {
      averageRating: Math.round(averageRating * 100) / 100,
      reviewCount,
    },
  });
}

// Create a review
router.post("/",
  /**
   * @swagger
   * /reviews:
   *   post:
   *     summary: Create a review
   *     tags: [Reviews]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateReviewRequest'
   *           examples:
   *             example:
   *               value:
   *                 jobId: "uuid"
   *                 revieweeId: "uuid"
   *                 rating: 5
   *                 comment: "Great work!"
   *     responses:
   *       201:
   *         description: Review created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ReviewResponse'
   *       400:
   *         description: Can only review completed jobs
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  /**
   * @swagger
   * /reviews/user/{userId}:
   *   get:
   *     summary: Get reviews for a user
   *     tags: [Reviews]
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         schema:
   *           type: string
   *         description: User ID
   *     responses:
   *       200:
   *         description: List of reviews
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ReviewsResponse'
   */
  authenticate,
  validate({ body: createReviewSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { jobId, revieweeId, rating, comment } = req.body;
    const parsedRating = typeof rating === "string" ? parseInt(rating, 10) : rating;

    // Verify the job exists and is completed
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    if (job.status !== "COMPLETED") {
      return res.status(400).json({ error: "Can only review completed jobs." });
    }

    // Verify reviewer is part of the job
    if (job.clientId !== req.userId && job.freelancerId !== req.userId) {
      return res.status(403).json({ error: "Not authorized to review this job." });
    }

    // Prevent duplicate reviews for the same job
    const existing = await prisma.review.findUnique({
      where: { jobId_reviewerId: { jobId, reviewerId: req.userId! } },
    });
    if (existing) {
      return res.status(409).json({ error: "You have already reviewed this job." });
    }

    const review = await prisma.$transaction(async (tx) => {
      const createdReview = await tx.review.create({
        data: {
          jobId,
          reviewerId: req.userId!,
          revieweeId,
          rating: parsedRating,
          comment,
        },
        include: {
          reviewer: { select: { id: true, username: true, avatarUrl: true } },
          reviewee: { select: { id: true, username: true, avatarUrl: true } },
        },
      });

      await syncUserReviewAggregate(tx, revieweeId);

      return createdReview;
    });

    await invalidateCacheKey(generateUserCacheKey(revieweeId));

    res.status(201).json(review);
  })
);

// Get reviews for a user
router.get("/user/:userId",
  validate({ params: getReviewsByUserParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.params.userId as string;
    const reviews = await prisma.review.findMany({
      where: { revieweeId: userId },
      include: {
        reviewer: { select: { id: true, username: true, avatarUrl: true } },
        job: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const avgRating =
      reviews.length > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
        : 0;

    res.json({ reviews, averageRating: Math.round(avgRating * 100) / 100, totalReviews: reviews.length });
  })
);

// Get all reviews with filtering
router.get("/",
  validate({ query: getReviewsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page, limit, jobId, reviewerId, revieweeId, rating } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (jobId) where.jobId = jobId;
    if (reviewerId) where.reviewerId = reviewerId;
    if (revieweeId) where.revieweeId = revieweeId;
    if (rating) where.rating = rating;

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          reviewer: { select: { id: true, username: true, avatarUrl: true } },
          reviewee: { select: { id: true, username: true, avatarUrl: true } },
          job: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.review.count({ where }),
    ]);

    res.json({
      data: reviews,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  })
);

// Get a single review by ID
router.get("/:id",
  authenticate,
  validate({ params: getReviewByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const review = await prisma.review.findUnique({
      where: { id },
      include: {
        reviewer: { select: { id: true, username: true, avatarUrl: true } },
        reviewee: { select: { id: true, username: true, avatarUrl: true } },
        job: { select: { id: true, title: true } },
      },
    });

    if (!review) {
      return res.status(404).json({ error: "Review not found." });
    }

    res.json(review);
  })
);

// Update a review
router.put("/:id",
  authenticate,
  validate({
    params: getReviewByIdParamSchema,
    body: updateReviewSchema
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const updateData = {
      ...req.body,
      ...(req.body.rating !== undefined
        ? {
          rating:
            typeof req.body.rating === "string"
              ? parseInt(req.body.rating, 10)
              : req.body.rating,
        }
        : {}),
    };

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      return res.status(404).json({ error: "Review not found." });
    }
    if (review.reviewerId !== req.userId) {
      return res.status(403).json({ error: "Not authorized to update this review." });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedReview = await tx.review.update({
        where: { id },
        data: updateData,
        include: {
          reviewer: { select: { id: true, username: true, avatarUrl: true } },
          reviewee: { select: { id: true, username: true, avatarUrl: true } },
          job: { select: { id: true, title: true } },
        },
      });

      await syncUserReviewAggregate(tx, review.revieweeId);

      return updatedReview;
    });

    await invalidateCacheKey(generateUserCacheKey(review.revieweeId));

    res.json(updated);
  })
);

// Delete a review
router.delete("/:id",
  authenticate,
  validate({ params: getReviewByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      return res.status(404).json({ error: "Review not found." });
    }
    if (review.reviewerId !== req.userId) {
      return res.status(403).json({ error: "Not authorized to delete this review." });
    }

    await prisma.$transaction(async (tx) => {
      await tx.review.delete({ where: { id } });
      await syncUserReviewAggregate(tx, review.revieweeId);
    });

    await invalidateCacheKey(generateUserCacheKey(review.revieweeId));

    res.json({ message: "Review deleted successfully." });
  })
);

export default router;
