import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import applicationRouter from "../application.routes";

// ─── Prisma & NotificationService mocks ───────────────────────────────────────
jest.mock("@prisma/client", () => {
  const mockPrisma = {
    job: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    application: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma) as any,
    NotificationType: {
      JOB_APPLIED: "JOB_APPLIED",
      APPLICATION_ACCEPTED: "APPLICATION_ACCEPTED",
    } as any,
  };
});

jest.mock("../../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn().mockResolvedValue({ id: "mock-notif-id" }),
  },
}));

import { PrismaClient } from "@prisma/client";
const prismaMock = new PrismaClient() as any;
const jobMock = prismaMock.job;
const applicationMock = prismaMock.application;

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api", applicationRouter);

// ─── Stable test UUIDs (RFC 4122 v4 format) ──────────────────────────────────
const JOB_ID = "00000000-0000-4000-8000-000000000100";
const CLIENT_A_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_B_ID = "00000000-0000-4000-8000-000000000002";

function authHeader(userId = CLIENT_A_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

afterEach(() => jest.clearAllMocks());

describe("GET /api/jobs/:jobId/applications", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).get(`/api/jobs/${JOB_ID}/applications`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when job does not exist", async () => {
    jobMock.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_ID}/applications`)
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Job not found." });
    expect(jobMock.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_ID },
        select: { clientId: true },
      }),
    );
    expect(applicationMock.findMany).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated user is not job owner", async () => {
    jobMock.findUnique.mockResolvedValueOnce({ clientId: CLIENT_B_ID });

    const res = await request(app)
      .get(`/api/jobs/${JOB_ID}/applications`)
      .set(authHeader(CLIENT_A_ID));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Not authorized to view applicants for this job.",
    });
    expect(applicationMock.findMany).not.toHaveBeenCalled();
  });

  it("returns applicants list when authenticated user is job owner", async () => {
    jobMock.findUnique.mockResolvedValueOnce({ clientId: CLIENT_A_ID });
    applicationMock.findMany.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000200",
        jobId: JOB_ID,
        freelancerId: "00000000-0000-4000-8000-000000000300",
        proposal: "x".repeat(60),
        estimatedDuration: 7,
        bidAmount: 100,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        freelancer: {
          id: "00000000-0000-4000-8000-000000000300",
          username: "freelancer",
          avatarUrl: null,
          bio: "bio",
        },
      },
    ]);
    applicationMock.count.mockResolvedValueOnce(1);

    const res = await request(app)
      .get(`/api/jobs/${JOB_ID}/applications`)
      .set(authHeader(CLIENT_A_ID));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      page: 1,
      totalPages: 1,
    });
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(applicationMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: JOB_ID },
        orderBy: { createdAt: "desc" },
        skip: 0,
        take: 10,
      }),
    );
  });
});

