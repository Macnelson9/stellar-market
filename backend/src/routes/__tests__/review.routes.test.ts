import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { config } from "../../config";
import { errorHandler } from "../../middleware/error";

var prismaMock = {
  job: { findUnique: jest.fn() },
  review: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  user: { update: jest.fn() },
  $transaction: jest.fn(),
};

jest.mock("../../lib/cache", () => ({
  generateUserCacheKey: jest.fn((userId: string) => `user:profile:${userId}`),
  invalidateCacheKey: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => prismaMock),
  Prisma: {},
  UserRole: {
    CLIENT: "CLIENT",
    FREELANCER: "FREELANCER",
    ADMIN: "ADMIN",
  },
}));

import { generateUserCacheKey, invalidateCacheKey } from "../../lib/cache";

const reviewRouter = require("../review.routes").default;

const app = express();
app.use(express.json());
app.use("/api/reviews", reviewRouter);
app.use(errorHandler);

const REVIEWER_ID = "00000000-0000-4000-8000-000000000001";
const REVIEWEE_ID = "00000000-0000-4000-8000-000000000002";
const JOB_ID = "00000000-0000-4000-8000-000000000003";
const REVIEW_ID = "00000000-0000-4000-8000-000000000004";

function authHeader(userId = REVIEWER_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
});

describe("review aggregate synchronization", () => {
  it("updates the reviewee aggregate after creating a review", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({
      id: JOB_ID,
      status: "COMPLETED",
      clientId: REVIEWER_ID,
      freelancerId: REVIEWEE_ID,
    });
    prismaMock.review.create.mockResolvedValueOnce({
      id: REVIEW_ID,
      jobId: JOB_ID,
      reviewerId: REVIEWER_ID,
      revieweeId: REVIEWEE_ID,
      rating: 5,
      comment: "Great work overall.",
      reviewer: { id: REVIEWER_ID, username: "client", avatarUrl: null },
      reviewee: { id: REVIEWEE_ID, username: "freelancer", avatarUrl: null },
    });
    prismaMock.review.aggregate.mockResolvedValueOnce({
      _avg: { rating: 4.6666667 },
      _count: { id: 3 },
    });
    prismaMock.user.update.mockResolvedValueOnce({
      id: REVIEWEE_ID,
      averageRating: 4.67,
      reviewCount: 3,
    });

    const res = await request(app)
      .post("/api/reviews")
      .set(authHeader())
      .send({
        jobId: JOB_ID,
        revieweeId: REVIEWEE_ID,
        rating: 5,
        comment: "Great work overall.",
      });

    expect(res.status).toBe(201);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: REVIEWEE_ID },
      data: {
        averageRating: 4.67,
        reviewCount: 3,
      },
    });
    expect(generateUserCacheKey).toHaveBeenCalledWith(REVIEWEE_ID);
    expect(invalidateCacheKey).toHaveBeenCalledWith(`user:profile:${REVIEWEE_ID}`);
  });

  it("recalculates the aggregate after updating a review rating", async () => {
    prismaMock.review.findUnique.mockResolvedValueOnce({
      id: REVIEW_ID,
      reviewerId: REVIEWER_ID,
      revieweeId: REVIEWEE_ID,
    });
    prismaMock.review.update.mockResolvedValueOnce({
      id: REVIEW_ID,
      rating: 4,
      comment: "Updated review text.",
      reviewer: { id: REVIEWER_ID, username: "client", avatarUrl: null },
      reviewee: { id: REVIEWEE_ID, username: "freelancer", avatarUrl: null },
      job: { id: JOB_ID, title: "Build app" },
    });
    prismaMock.review.aggregate.mockResolvedValueOnce({
      _avg: { rating: 3.5 },
      _count: { id: 2 },
    });
    prismaMock.user.update.mockResolvedValueOnce({
      id: REVIEWEE_ID,
      averageRating: 3.5,
      reviewCount: 2,
    });

    const res = await request(app)
      .put(`/api/reviews/${REVIEW_ID}`)
      .set(authHeader())
      .send({
        rating: 4,
        comment: "Updated review text.",
      });

    expect(res.status).toBe(200);
    expect(prismaMock.review.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: REVIEW_ID },
        data: {
          rating: 4,
          comment: "Updated review text.",
        },
      }),
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: REVIEWEE_ID },
      data: {
        averageRating: 3.5,
        reviewCount: 2,
      },
    });
    expect(invalidateCacheKey).toHaveBeenCalledWith(`user:profile:${REVIEWEE_ID}`);
  });

  it("resets the aggregate after deleting the last review", async () => {
    prismaMock.review.findUnique.mockResolvedValueOnce({
      id: REVIEW_ID,
      reviewerId: REVIEWER_ID,
      revieweeId: REVIEWEE_ID,
    });
    prismaMock.review.delete.mockResolvedValueOnce({ id: REVIEW_ID });
    prismaMock.review.aggregate.mockResolvedValueOnce({
      _avg: { rating: null },
      _count: { id: 0 },
    });
    prismaMock.user.update.mockResolvedValueOnce({
      id: REVIEWEE_ID,
      averageRating: 0,
      reviewCount: 0,
    });

    const res = await request(app)
      .delete(`/api/reviews/${REVIEW_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(prismaMock.review.delete).toHaveBeenCalledWith({ where: { id: REVIEW_ID } });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: REVIEWEE_ID },
      data: {
        averageRating: 0,
        reviewCount: 0,
      },
    });
    expect(invalidateCacheKey).toHaveBeenCalledWith(`user:profile:${REVIEWEE_ID}`);
  });
});