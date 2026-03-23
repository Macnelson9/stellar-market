import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthRequest, authenticate } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import {
  getUserByIdParamSchema,
  updateUserProfileSchema,
  getUsersQuerySchema,
  getUserJobsQuerySchema,
} from "../schemas";
import { avatarUpload } from "../config/upload";
import { cache, invalidateCacheKey, generateUserCacheKey } from "../lib/cache";

const router = Router();
const prisma = new PrismaClient();

// Zod schema for profile update payload
const updateProfileSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, hyphens, and underscores")
    .optional(),
  email: z
    .string()
    .email("Invalid email address")
    .optional()
    .nullable(),
  bio: z
    .string()
    .max(500, "Bio must be at most 500 characters")
    .optional()
    .nullable(),
  role: z.enum(["CLIENT", "FREELANCER"]).optional(),
  skills: z.array(z.string()).max(20).optional(),
  availability: z.boolean().optional(),
});

// GET /api/users/me — return current authenticated user's full profile
router.get("/me", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        username: true,
        walletAddress: true,
        email: true,
        bio: true,
        avatarUrl: true,
        role: true,
        skills: true,
        availability: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    res.json(user);
  } catch (error) {
    console.error("Get current user error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

// PUT /api/users/me — update current authenticated user's profile
router.put("/me", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);

    if (!parsed.success) {
      const errors = (parsed.error as any).issues.map((e: any) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      res.status(400).json({ error: "Validation failed.", details: errors });
      return;
    }

    const data = parsed.data;

    // Check username uniqueness if being updated
    if (data.username) {
      const existingUser = await prisma.user.findFirst({
        where: {
          username: data.username,
          NOT: { id: req.userId },
        },
      });
      if (existingUser) {
        res.status(409).json({ error: "Username is already taken." });
        return;
      }
    }

    // Check email uniqueness if being updated
    if (data.email) {
      const existingUser = await prisma.user.findFirst({
        where: {
          email: data.email,
          NOT: { id: req.userId },
        },
      });
      if (existingUser) {
        res.status(409).json({ error: "Email is already taken." });
        return;
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.userId },
      data,
      select: {
        id: true,
        username: true,
        walletAddress: true,
        email: true,
        bio: true,
        avatarUrl: true,
        role: true,
        skills: true,
        availability: true,
        createdAt: true,
      },
    });

    // Invalidate user profile cache
    if (req.userId) {
      await invalidateCacheKey(generateUserCacheKey(req.userId));
    }

    res.json(updatedUser);
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

router.post(
  "/me/avatar",
  authenticate,
  avatarUpload.single("avatar"),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded. Use field name 'avatar'." });
        return;
      }
      const avatarUrl = `/api/uploads/avatars/${req.file.filename}`;
      const updated = await prisma.user.update({
        where: { id: req.userId },
        data: { avatarUrl },
        select: {
          id: true,
          username: true,
          avatarUrl: true,
        },
      });
      res.json(updated);
    } catch (error) {
      console.error("Avatar upload error:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  },
);

router.get(
  "/:id/jobs",
  validate({
    params: getUserByIdParamSchema,
    query: getUserJobsQuerySchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const query = req.query as { page?: number; limit?: number };
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where: {
          OR: [{ clientId: id }, { freelancerId: id }],
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          client: { select: { id: true, username: true, avatarUrl: true } },
          freelancer: { select: { id: true, username: true, avatarUrl: true } },
          _count: { select: { applications: true } },
        },
      }),
      prisma.job.count({
        where: {
          OR: [{ clientId: id }, { freelancerId: id }],
        },
      }),
    ]);

    res.json({
      data: jobs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }),
);

// Get user profile by ID
router.get(
  "/:id",
  validate({ params: getUserByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const cacheKey = generateUserCacheKey(id);

    try {
      const { data, hit } = await cache(cacheKey, 300, async () => {
        const user = await prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            username: true,
            bio: true,
            avatarUrl: true,
            role: true,
            skills: true,
            createdAt: true,
            reviewsReceived: {
              orderBy: { createdAt: "desc" as const },
              select: {
                rating: true,
                reviewer: {
                  select: {
                    id: true,
                    username: true,
                    avatarUrl: true,
                  },
                },
              },
            },
            clientJobs: {
              where: { status: "COMPLETED" },
              orderBy: { updatedAt: "desc" as const },
              select: {
                id: true,
                title: true,
                status: true,
                updatedAt: true,
              },
            },
            freelancerJobs: {
              where: { status: "COMPLETED" },
              orderBy: { updatedAt: "desc" as const },
              select: {
                id: true,
                title: true,
                status: true,
                updatedAt: true,
              },
            },
          },
        });

        if (!user) {
          throw new Error("User not found");
        }

        return user;
      });

      res.set("X-Cache-Hit", hit.toString());
      res.json(data);
    } catch (error) {
      if (error instanceof Error && error.message === "User not found") {
        return res.status(404).json({ error: "User not found." });
      }
      throw error;
    }
  }),
);

// Get all users with pagination and filtering
router.get(
  "/",
  validate({ query: getUsersQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page, limit, search, skill } = req.query as any;

    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.OR = [
        { username: { contains: search, mode: "insensitive" } },
        { bio: { contains: search, mode: "insensitive" } },
      ];
    }

    if (skill) {
      where.skills = {
        has: skill,
      };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          username: true,
          walletAddress: true,
          bio: true,
          avatarUrl: true,
          role: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  }),
);

// Update user profile
router.put(
  "/:id",
  authenticate,
  validate({
    params: getUserByIdParamSchema,
    body: updateUserProfileSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const updateData = req.body;

    if (req.userId !== id) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this profile." });
    }

    const body = updateData as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (body.email !== undefined) data.email = body.email;
    if (body.bio !== undefined) data.bio = body.bio;
    if (body.skills !== undefined) data.skills = body.skills;
    if (body.availability !== undefined) data.availability = body.availability;
    if (body.name !== undefined) data.username = body.name;
    if (body.stellarAddress !== undefined) data.walletAddress = body.stellarAddress;

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        username: true,
        walletAddress: true,
        email: true,
        bio: true,
        avatarUrl: true,
        role: true,
        skills: true,
        availability: true,
        createdAt: true,
      },
    });

    // Invalidate user profile cache
    await invalidateCacheKey(generateUserCacheKey(id));

    res.json(user);
  }),
);

export default router;
