/// <reference types="jest" />
import request from "supertest";
// Import jest globals for editors/TS language server that don't pick up triple-slash references
// Jest types are provided via tsconfig so globals are available
// (no explicit imports required)
import express from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import notificationRouter from "../notification.routes";

// ─── Prisma mocks for notifications ──────────────────────────────────────────
jest.mock("@prisma/client", () => {
  const mockPrisma = {
    notification: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma) as any,
    UserRole: {
      CLIENT: "CLIENT",
      FREELANCER: "FREELANCER",
      ADMIN: "ADMIN",
    } as any,
    NotificationType: {
      NEW_MESSAGE: "NEW_MESSAGE",
      JOB_APPLIED: "JOB_APPLIED",
      APPLICATION_ACCEPTED: "APPLICATION_ACCEPTED",
      MILESTONE_SUBMITTED: "MILESTONE_SUBMITTED",
      MILESTONE_APPROVED: "MILESTONE_APPROVED",
      DISPUTE_RAISED: "DISPUTE_RAISED",
      DISPUTE_RESOLVED: "DISPUTE_RESOLVED",
    } as any,
  };
});

// @ts-ignore
import { PrismaClient } from "@prisma/client";
const prismaMock = new PrismaClient() as any;

// ─── App setup ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api/notifications", notificationRouter);

// ─── Stable test UUIDs ───────────────────────────────────────────────────────
const USER_TEST_ID = "00000000-0000-4000-8000-000000000001";
const USER_OTHER_ID = "00000000-0000-4000-8000-000000000002";
// Use a valid CUID (Prisma default id format) for param validation
const NOTIF_ID = "c000000000000000000000001";

function authHeader(userId = USER_TEST_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

afterEach(() => jest.clearAllMocks());

beforeEach(() => {
  // ensure auth middleware finds a user record by default
  prismaMock.user.findUnique.mockResolvedValue({
    id: USER_TEST_ID,
    role: "FREELANCER",
  });
});

describe("DELETE /api/notifications/:id", () => {
  it("deletes a notification and returns 204 (happy path)", async () => {
    const mockNotification = {
      id: NOTIF_ID,
      userId: USER_TEST_ID,
      title: "Hi",
      message: "msg",
      read: false,
      createdAt: new Date().toISOString(),
    };

    prismaMock.notification.findUnique.mockResolvedValueOnce(mockNotification);
    prismaMock.notification.delete.mockResolvedValueOnce(mockNotification);

    const res = await request(app)
      .delete(`/api/notifications/${NOTIF_ID}`)
      .set(authHeader(USER_TEST_ID));

    expect(res.status).toBe(204);
    expect(prismaMock.notification.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NOTIF_ID } }),
    );
    expect(prismaMock.notification.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NOTIF_ID } }),
    );
  });

  it("returns 403 when trying to delete another user's notification", async () => {
    const mockNotification = {
      id: NOTIF_ID,
      userId: USER_OTHER_ID,
      title: "Hi",
      message: "msg",
      read: false,
      createdAt: new Date().toISOString(),
    };

    prismaMock.notification.findUnique.mockResolvedValueOnce(mockNotification);

    const res = await request(app)
      .delete(`/api/notifications/${NOTIF_ID}`)
      .set(authHeader(USER_TEST_ID));

    expect(res.status).toBe(403);
    expect(prismaMock.notification.delete).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/notifications (bulk clear)", () => {
  it("removes all read notifications for the current user and returns 204", async () => {
    prismaMock.notification.deleteMany.mockResolvedValueOnce({ count: 2 });

    const res = await request(app)
      .delete(`/api/notifications`)
      .set(authHeader(USER_TEST_ID));

    expect(res.status).toBe(204);
    expect(prismaMock.notification.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_TEST_ID, read: true } }),
    );
  });
});

describe("GET /api/notifications (pagination)", () => {
  it("returns paginated notifications with meta object", async () => {
    const mockNotifications = [
      { id: "1", title: "Test 1" },
      { id: "2", title: "Test 2" },
    ];
    prismaMock.notification.findMany.mockResolvedValueOnce(mockNotifications);
    prismaMock.notification.count.mockResolvedValueOnce(25);

    const res = await request(app)
      .get("/api/notifications?page=1&limit=2")
      .set(authHeader(USER_TEST_ID));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toEqual({
      total: 25,
      page: 1,
      limit: 2,
      totalPages: 13,
    });
    
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 2,
        where: { userId: USER_TEST_ID }
      })
    );
  });

  it("uses default values when no params provided", async () => {
    prismaMock.notification.findMany.mockResolvedValueOnce([]);
    prismaMock.notification.count.mockResolvedValueOnce(0);

    const res = await request(app)
      .get("/api/notifications")
      .set(authHeader(USER_TEST_ID));

    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(20);
  });
});
